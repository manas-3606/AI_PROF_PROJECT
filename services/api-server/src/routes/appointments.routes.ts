import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import { AppointmentStatus, UserRole } from '@health/shared-types';
import crypto from 'node:crypto';

export const appointmentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const query = request.query as {
      patientId?: string;
      doctorId?: string;
      hospitalId?: string;
      status?: string;
    };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Tenant isolation: Hospital Admin cannot query another hospital's appointments
    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && query.hospitalId && query.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: query.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'APPOINTMENT',
          detailsJson: JSON.stringify({
            endpoint: 'GET /api/appointments',
            actorTenantId: user.tenantId,
            targetHospitalId: query.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot view another hospital appointments' });
    }

    const appointments = await prisma.appointment.findMany({
      where: {
        ...(query.patientId ? { patientId: query.patientId } : {}),
        ...(query.doctorId ? { doctorId: query.doctorId } : {}),
        ...(query.hospitalId ? { hospitalId: query.hospitalId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        doctor: true,
        patient: true,
        hospital: true,
        verifications: true,
        reconciliations: true,
        questionnaireResponses: true,
      },
      orderBy: { startTime: 'desc' },
    });

    return appointments;
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        doctor: true,
        patient: true,
        hospital: true,
        verifications: true,
        reconciliations: true,
        questionnaireResponses: true,
      },
    });

    if (!appointment) {
      return reply.status(404).send({ error: 'Appointment not found' });
    }

    const user = (request as any).user;
    if (user) {
      if (user.role === 'HOSPITAL_ADMIN' && user.tenantId && appointment.hospitalId !== user.tenantId) {
        await prisma.auditEvent.create({
          data: {
            correlationId,
            hospitalId: appointment.hospitalId,
            tenantId: user.tenantId,
            actorId: user.id,
            actorRole: user.role,
            action: 'CROSS_TENANT_ACCESS_VIOLATION',
            entityType: 'APPOINTMENT',
            entityId: appointment.id,
            detailsJson: JSON.stringify({
              endpoint: 'GET /api/appointments/:id',
              actorTenantId: user.tenantId,
              targetHospitalId: appointment.hospitalId,
            }),
          },
        });
        return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot view another hospital appointment' });
      }

      if (user.role === 'DOCTOR' && user.doctorId && appointment.doctorId !== user.doctorId) {
        await prisma.operationalEvent.create({
          data: {
            correlationId,
            eventType: 'SECURITY_VIOLATION',
            severity: 'CRITICAL',
            message: `RBAC violation: Doctor ${user.doctorId} attempted to access appointment of doctor ${appointment.doctorId}`,
            detailsJson: JSON.stringify({ userId: user.id, doctorId: user.doctorId, targetDoctorId: appointment.doctorId }),
          },
        });
        return reply.status(403).send({ error: "Access denied: Doctor cannot access another doctor's data" });
      }

      if (user.role === 'PATIENT' && user.patientId && appointment.patientId !== user.patientId) {
        await prisma.operationalEvent.create({
          data: {
            correlationId,
            eventType: 'SECURITY_VIOLATION',
            severity: 'CRITICAL',
            message: `RBAC violation: Patient ${user.patientId} attempted to access appointment of patient ${appointment.patientId}`,
            detailsJson: JSON.stringify({ userId: user.id, patientId: user.patientId, targetPatientId: appointment.patientId }),
          },
        });
        return reply.status(403).send({ error: "Access denied: Patient cannot access another patient's data" });
      }
    }

    return appointment;
  });

  fastify.post('/', async (request, reply) => {
    const body = request.body as {
      patientId: string;
      doctorId: string;
      hospitalId: string;
      slotId: string;
      reason?: string;
      idempotencyKey?: string;
    };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Tenant check: Hospital Admin cannot create appointment in another hospital
    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && user.tenantId !== body.hospitalId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: body.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'APPOINTMENT',
          detailsJson: JSON.stringify({
            endpoint: 'POST /api/appointments',
            actorTenantId: user.tenantId,
            targetHospitalId: body.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot create appointments for another hospital' });
    }

    const idempotencyKey = body.idempotencyKey || crypto.randomUUID();

    try {
      const result = await CapabilityRegistry.execute(
        'create_appointment',
        {
          ...body,
          idempotencyKey,
        },
        { correlationId, tenantId: body.hospitalId, actorRole: user?.role, actorId: user?.id }
      );

      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/:id/reschedule', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { newSlotId } = request.body as { newSlotId: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    const appt = await prisma.appointment.findUnique({ where: { id } });
    if (!appt) return reply.status(404).send({ error: 'Appointment not found' });

    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && appt.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: appt.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'APPOINTMENT',
          entityId: appt.id,
          detailsJson: JSON.stringify({
            endpoint: 'POST /api/appointments/:id/reschedule',
            actorTenantId: user.tenantId,
            targetHospitalId: appt.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden' });
    }

    try {
      const result = await CapabilityRegistry.execute(
        'reschedule_appointment',
        {
          appointmentId: id,
          newSlotId,
          idempotencyKey: crypto.randomUUID(),
        },
        { correlationId, tenantId: appt.hospitalId, actorRole: user?.role, actorId: user?.id }
      );
      return result;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) || {};
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    const appt = await prisma.appointment.findUnique({ where: { id } });
    if (!appt) return reply.status(404).send({ error: 'Appointment not found' });

    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && appt.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: appt.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'APPOINTMENT',
          entityId: appt.id,
          detailsJson: JSON.stringify({
            endpoint: 'POST /api/appointments/:id/cancel',
            actorTenantId: user.tenantId,
            targetHospitalId: appt.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden' });
    }

    try {
      const result = await CapabilityRegistry.execute(
        'cancel_appointment',
        {
          appointmentId: id,
          reason,
        },
        { correlationId, tenantId: appt.hospitalId, actorRole: user?.role, actorId: user?.id }
      );
      return result;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });
};
