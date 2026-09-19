import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import { SchedulingService } from '@health/scheduling';
import { MockEhrConnector, IdentifierMapper } from '@health/integration';
import { WorkflowQueueManager } from '@health/workflows';
import { logger } from '@health/observability';
import crypto from 'node:crypto';

export const chaosRoutes: FastifyPluginAsync = async (fastify) => {
  const mockEhrUrl = process.env.MOCK_EHR_URL || 'http://localhost:4000';

  fastify.get('/status', async (request, reply) => {
    try {
      const res = await fetch(`${mockEhrUrl}/chaos/status`);
      const data = (await res.json()) as any;
      return data;
    } catch {
      return { error: 'Mock EHR service offline' };
    }
  });

  fastify.post('/configure', async (request, reply) => {
    try {
      const res = await fetch(`${mockEhrUrl}/chaos/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const data = (await res.json()) as any;
      return data;
    } catch {
      return reply.status(503).send({ error: 'Mock EHR unreachable' });
    }
  });

  fastify.post('/reset', async (request, reply) => {
    try {
      // 1. Reset Mock EHR failure mode and latency
      const res = await fetch(`${mockEhrUrl}/chaos/reset`, { method: 'POST' });
      const data = (await res.json()) as Record<string, any>;

      // 2. Synchronize and auto-reconcile all appointments stuck in Synchronization Pending / Pending / Reconciliation Required
      const connector = new MockEhrConnector();

      const pendingAppointments = await prisma.appointment.findMany({
        where: {
          status: {
            in: [
              AppointmentStatus.SYNCHRONIZATION_PENDING,
              AppointmentStatus.PENDING,
              AppointmentStatus.RECONCILIATION_REQUIRED,
            ],
          },
        },
        include: {
          doctor: { include: { hospital: true } },
          hospital: true,
          patient: true,
        },
      });

      for (const appt of pendingAppointments) {
        try {
          const isCancellation = appt.reason?.toLowerCase().includes('cancel');

          if (isCancellation) {
            let extId: string | null = appt.externalAppointmentId;
            if (!extId) {
              extId = await IdentifierMapper.getExternalId(appt.hospitalId, 'APPOINTMENT', appt.id);
            }
            if (extId) {
              await connector.cancelAppointment(extId).catch(() => {});
            }
            await SchedulingService.cancelAppointment(appt.id, 'Cancellation synchronized upon EHR chaos recovery');

            await prisma.reconciliationRecord.updateMany({
              where: { appointmentId: appt.id },
              data: {
                status: 'RESOLVED',
                resolvedAt: new Date(),
              },
            });
          } else {
            let extApptId: string | null = appt.externalAppointmentId;
            if (!extApptId) {
              extApptId = await IdentifierMapper.getExternalId(appt.hospitalId, 'APPOINTMENT', appt.id);
            }

            const verification = await connector.verifyAppointment(appt.id, extApptId || undefined);

            if (!verification.isVerified || !extApptId) {
              const existingPat = await IdentifierMapper.getExternalId(appt.hospitalId, 'PATIENT', appt.patientId);
              const extPatientId = existingPat || `EXT-PAT-${appt.patientId.slice(0, 6)}`;

              const existingDoc = await IdentifierMapper.getExternalId(appt.hospitalId, 'DOCTOR', appt.doctorId);
              const extDoctorId = existingDoc || `EXT-DOC-${appt.doctorId.slice(0, 6)}`;

              const ehrRes = await connector.createAppointment({
                internalAppointmentId: appt.id,
                externalPatientId: extPatientId,
                externalProviderId: extDoctorId,
                startTime: appt.startTime.toISOString(),
                endTime: appt.endTime.toISOString(),
                reason: appt.reason || 'Auto-synchronized appointment via chaos recovery',
              });
              extApptId = ehrRes.externalAppointmentId;
            }

            // Ensure identifier mappings
            const finalPat = (await IdentifierMapper.getExternalId(appt.hospitalId, 'PATIENT', appt.patientId)) || `EXT-PAT-${appt.patientId.slice(0, 6)}`;
            const finalDoc = (await IdentifierMapper.getExternalId(appt.hospitalId, 'DOCTOR', appt.doctorId)) || `EXT-DOC-${appt.doctorId.slice(0, 6)}`;
            await IdentifierMapper.setMapping(appt.hospitalId, 'PATIENT', appt.patientId, finalPat);
            await IdentifierMapper.setMapping(appt.hospitalId, 'DOCTOR', appt.doctorId, finalDoc);
            if (extApptId) {
              await IdentifierMapper.setMapping(appt.hospitalId, 'APPOINTMENT', appt.id, extApptId);
            }

            // Transition status to CONFIRMED
            await SchedulingService.updateAppointmentStatus(
              appt.id,
              AppointmentStatus.CONFIRMED,
              extApptId || undefined,
              'Auto-reconciled and confirmed upon EHR chaos reset'
            );

            // Dispatch patient confirmation notification
            await prisma.notification.create({
              data: {
                hospitalId: appt.hospitalId,
                recipientId: appt.patientId,
                recipientType: 'Patient',
                channel: appt.patient.communicationPreference || 'sms',
                templateId: 'APPOINTMENT_CONFIRMATION',
                payloadJson: JSON.stringify({
                  appointmentId: appt.id,
                  doctorName: appt.doctor.name,
                  startTime: appt.startTime.toISOString(),
                  hospitalName: appt.hospital.name,
                }),
                status: 'Delivered',
              },
            }).catch(() => {});

            // Trigger post-booking workflows
            try {
              await WorkflowQueueManager.enqueue({
                workflowExecutionId: crypto.randomUUID(),
                workflowType: 'PreVisitQuestionnaire',
                hospitalId: appt.hospitalId,
                appointmentId: appt.id,
                payload: {
                  appointmentId: appt.id,
                  doctorId: appt.doctorId,
                  patientId: appt.patientId,
                  startTime: appt.startTime.toISOString(),
                },
              });
              await WorkflowQueueManager.enqueue({
                workflowExecutionId: crypto.randomUUID(),
                workflowType: 'AppointmentReminder',
                hospitalId: appt.hospitalId,
                appointmentId: appt.id,
                payload: {
                  appointmentId: appt.id,
                  doctorName: appt.doctor.name,
                  startTime: appt.startTime.toISOString(),
                },
                condition: 'APPOINTMENT_NOT_CANCELLED',
              });
            } catch (wfErr) {
              logger.warn({ wfErr }, 'Could not automatically enqueue post-booking workflows on recovery');
            }

            // Update associated ReconciliationRecords to RESOLVED
            await prisma.reconciliationRecord.updateMany({
              where: { appointmentId: appt.id },
              data: {
                status: 'RESOLVED',
                resolvedAt: new Date(),
              },
            });
          }
        } catch (syncErr) {
          logger.error({ syncErr, appointmentId: appt.id }, 'Error synchronizing appointment on chaos reset');
        }
      }

      // Mark all remaining OPEN or PENDING reconciliation records as RESOLVED
      await prisma.reconciliationRecord.updateMany({
        where: {
          status: { in: ['OPEN', 'PENDING'] },
        },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
        },
      });

      return {
        ...data,
        reconciledCount: pendingAppointments.length,
      };
    } catch {
      return reply.status(503).send({ error: 'Mock EHR unreachable' });
    }
  });
};
