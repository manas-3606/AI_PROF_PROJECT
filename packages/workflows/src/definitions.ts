import { prisma } from '@health/db';
import { logger } from '@health/observability';
import { WorkflowJobData, inProcessWorkflowEngine, WorkflowQueueManager } from './queue.js';
import crypto from 'node:crypto';

export async function processWorkflowJob(jobData: WorkflowJobData) {
  logger.info({ jobData }, `Executing workflow job: ${jobData.workflowType} [${jobData.workflowExecutionId}]`);

  // Execution History: mark Running
  await prisma.workflowExecution.updateMany({
    where: { id: jobData.workflowExecutionId },
    data: {
      status: 'Running',
      attemptCount: (jobData.attemptCount || 0) + 1,
    },
  });

  try {
    // Condition Check: e.g. condition === 'APPOINTMENT_NOT_CANCELLED'
    if (jobData.appointmentId && (jobData.condition === 'APPOINTMENT_NOT_CANCELLED' || jobData.workflowType === 'AppointmentReminder')) {
      const apptCheck = await prisma.appointment.findUnique({
        where: { id: jobData.appointmentId },
      });
      if (!apptCheck || apptCheck.status === 'Cancelled') {
        logger.info({ appointmentId: jobData.appointmentId }, 'Workflow condition check failed: Appointment cancelled. Skipping execution.');
        await prisma.workflowExecution.updateMany({
          where: { id: jobData.workflowExecutionId },
          data: { status: 'Cancelled', executedAt: new Date() },
        });
        return;
      }
    }

    switch (jobData.workflowType) {
      // 1. Appointment Confirmed Core Loop: Assign questionnaire + schedule reminder
      case 'AppointmentConfirmed':
      case 'PreVisitQuestionnaire': {
        if (jobData.appointmentId) {
          const appt = await prisma.appointment.findUnique({
            where: { id: jobData.appointmentId },
            include: { doctor: true, patient: true, hospital: true },
          });

          if (appt) {
            // Find best matching questionnaire (doctor -> specialty -> hospital)
            const questionnaire =
              (await prisma.questionnaire.findFirst({
                where: { hospitalId: appt.hospitalId, doctorId: appt.doctorId },
              })) ||
              (await prisma.questionnaire.findFirst({
                where: { hospitalId: appt.hospitalId, specialty: appt.doctor.specialty },
              })) ||
              (await prisma.questionnaire.findFirst({
                where: { hospitalId: appt.hospitalId },
              }));

            if (questionnaire) {
              await prisma.notification.create({
                data: {
                  hospitalId: appt.hospitalId,
                  recipientId: appt.patientId,
                  recipientType: 'Patient',
                  channel: appt.patient.communicationPreference || 'sms',
                  templateId: 'PRE_VISIT_QUESTIONNAIRE_ASSIGNED',
                  payloadJson: JSON.stringify({
                    appointmentId: appt.id,
                    questionnaireId: questionnaire.id,
                    doctorName: appt.doctor.name,
                    startTime: appt.startTime,
                    correlationId: jobData.correlationId,
                  }),
                  status: 'Delivered',
                },
              });
              logger.info({ appointmentId: appt.id, questionnaireId: questionnaire.id }, 'Assigned questionnaire and dispatched notification to patient');
            }

            // Schedule Appointment Reminder (simulated 24h reminder workflow)
            await WorkflowQueueManager.enqueue(
              {
                workflowExecutionId: crypto.randomUUID(),
                workflowType: 'AppointmentReminder',
                hospitalId: appt.hospitalId,
                appointmentId: appt.id,
                payload: {
                  appointmentId: appt.id,
                  doctorName: appt.doctor.name,
                  startTime: appt.startTime.toISOString(),
                  correlationId: jobData.correlationId,
                },
                condition: 'APPOINTMENT_NOT_CANCELLED',
                correlationId: jobData.correlationId,
              },
              { delayMs: 86400000 } // 24 hours (can be fast-forward simulated in tests)
            );
          }
        }
        break;
      }

      // 2. Appointment Reminder
      case 'AppointmentReminder': {
        if (jobData.appointmentId) {
          const appt = await prisma.appointment.findUnique({
            where: { id: jobData.appointmentId },
            include: { doctor: true, patient: true },
          });

          if (appt && appt.status !== 'Cancelled') {
            await prisma.notification.create({
              data: {
                hospitalId: appt.hospitalId,
                recipientId: appt.patientId,
                recipientType: 'Patient',
                channel: appt.patient.communicationPreference || 'sms',
                templateId: 'APPOINTMENT_REMINDER_24H',
                payloadJson: JSON.stringify({
                  appointmentId: appt.id,
                  doctorName: appt.doctor.name,
                  startTime: appt.startTime,
                }),
                status: 'Delivered',
              },
            });
            logger.info({ appointmentId: appt.id }, 'Dispatched 24h appointment reminder notification');
          }
        }
        break;
      }

      // 3. Questionnaire Submitted: notify doctor and make visible
      case 'QuestionnaireSubmitted': {
        const payload = jobData.payload;
        if (payload.doctorId) {
          await prisma.notification.create({
            data: {
              hospitalId: jobData.hospitalId,
              recipientId: payload.doctorId,
              recipientType: 'Doctor',
              channel: 'in_app',
              templateId: 'QUESTIONNAIRE_SUBMITTED_FOR_REVIEW',
              payloadJson: JSON.stringify(payload),
              status: 'Delivered',
            },
          });
          logger.info({ doctorId: payload.doctorId, appointmentId: jobData.appointmentId }, 'Made intake response visible to doctor');
        }
        break;
      }

      // 4. EHR Operations & Reconciliation routing (PRD Section 17 & 28)
      case 'EhrOperation': {
        const payload = jobData.payload;
        logger.info({ event: payload.event, appointmentId: jobData.appointmentId }, 'Processing EHR workflow event');

        if (payload.event === 'SIMULATED_FAILURE') {
          throw new Error('SIMULATED_WORKFLOW_FAILURE');
        }

        if (payload.event === 'RECONCILIATION_REQUIRED') {
          // Record reconciliation record
          if (jobData.appointmentId) {
            const existing = await prisma.reconciliationRecord.findFirst({
              where: { appointmentId: jobData.appointmentId },
            });
            if (!existing) {
              await prisma.reconciliationRecord.create({
                data: {
                  appointmentId: jobData.appointmentId,
                  hospitalId: jobData.hospitalId,
                  externalSystemId: 'MOCK_EHR',
                  reason: payload.reason || 'EHR_INTEGRATION_FAILURE',
                  status: 'OPEN',
                  escalatedTo: 'PlatformOperationsDesk',
                },
              });
            }
          }

          // Escalate to Hospital Admin
          await prisma.notification.create({
            data: {
              hospitalId: jobData.hospitalId,
              recipientId: jobData.hospitalId,
              recipientType: 'HospitalAdmin',
              channel: 'in_app',
              templateId: 'RECONCILIATION_REQUIRED_ALERT',
              payloadJson: JSON.stringify(payload),
              status: 'Delivered',
            },
          });
        }
        break;
      }

      case 'ReconciliationSync': {
        logger.info({ hospitalId: jobData.hospitalId }, 'Executed periodic reconciliation synchronization sweep');
        break;
      }
    }

    // Execution History: mark Completed
    await prisma.workflowExecution.updateMany({
      where: { id: jobData.workflowExecutionId },
      data: {
        status: 'Completed',
        executedAt: new Date(),
      },
    });
  } catch (err: any) {
    const currentAttempt = (jobData.attemptCount || 0) + 1;
    const maxAttempts = jobData.maxAttempts || 3;

    if (currentAttempt < maxAttempts) {
      logger.warn({ err, attempt: currentAttempt, maxAttempts }, `Workflow execution attempt ${currentAttempt} failed; scheduling retry`);
      await prisma.workflowExecution.updateMany({
        where: { id: jobData.workflowExecutionId },
        data: {
          status: 'Retried',
          error: err.message,
          attemptCount: currentAttempt,
        },
      });

      // Exponential backoff retry
      if (process.env.NODE_ENV !== 'test') {
        const timer = setTimeout(() => {
          inProcessWorkflowEngine.dispatchJob({
            ...jobData,
            attemptCount: currentAttempt,
          });
        }, 1000 * Math.pow(2, currentAttempt));
        timer.unref();
      }
    } else {
      logger.error({ err, jobData }, `Workflow execution permanently failed after ${maxAttempts} attempts: ${jobData.workflowExecutionId}`);
      await prisma.workflowExecution.updateMany({
        where: { id: jobData.workflowExecutionId },
        data: {
          status: 'Failed',
          error: err.message,
          attemptCount: currentAttempt,
        },
      });
    }
  }
}

// In-process processor hook
inProcessWorkflowEngine.on('process', (data) => {
  processWorkflowJob(data).catch((e) => logger.error({ e }, 'In-process workflow event loop error'));
});
