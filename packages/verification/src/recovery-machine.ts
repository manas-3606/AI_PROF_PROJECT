import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import { MockEhrConnector, IdentifierMapper, ExternalAppointmentPayload } from '@health/integration';
import { logger, metricsCollector } from '@health/observability';
import { Verifier } from './verifier.js';

export interface RecoveryOutcome {
  recovered: boolean;
  status: AppointmentStatus;
  externalAppointmentId?: string;
  reconciliationRecordId?: string;
  notes: string;
}

export class RecoveryStateMachine {
  private connector: MockEhrConnector;
  private verifier: Verifier;

  constructor(connector?: MockEhrConnector, verifier?: Verifier) {
    this.connector = connector || new MockEhrConnector();
    this.verifier = verifier || new Verifier(this.connector);
  }

  /**
   * Handles timeout or ambiguous network failure after an external booking request.
   * Proactively queries the EHR rather than blindly repeating the mutating POST request.
   */
  async handleUnknownOutcome(
    internalAppointmentId: string,
    hospitalId: string,
    payload: ExternalAppointmentPayload,
    maxRetries: number = 2
  ): Promise<RecoveryOutcome> {
    logger.warn(
      { internalAppointmentId, hospitalId },
      'Classifying operation as UNKNOWN_OUTCOME. Beginning proactive state verification...'
    );

    // 1. Check if the external system actually persisted the record despite the timeout
    const initialCheck = await this.verifier.verifyAppointment(internalAppointmentId, hospitalId);

    if (initialCheck.isVerified) {
      logger.info(
        { internalAppointmentId },
        'Recovery successful: External appointment was already recorded. Synchronizing state without duplicate creation.'
      );

      // Fetch external appointment details
      const extAppt = await this.connector.verifyAppointment(internalAppointmentId);
      const externalId = `EXT-REC-${internalAppointmentId.slice(0, 8)}`;

      // Save ID mapping
      await IdentifierMapper.setMapping(hospitalId, 'APPOINTMENT', internalAppointmentId, externalId);

      // Synchronize internal state to CONFIRMED
      await prisma.appointment.update({
        where: { id: internalAppointmentId },
        data: {
          status: AppointmentStatus.CONFIRMED,
          externalAppointmentId: externalId,
        },
      });

      return {
        recovered: true,
        status: AppointmentStatus.CONFIRMED,
        externalAppointmentId: externalId,
        notes: 'Recovered via post-timeout verification query. Avoided duplicate booking creation.',
      };
    }

    // 2. If NOT found in external EHR, it is safe to attempt an idempotent retry
    logger.info(
      { internalAppointmentId },
      'External record was NOT found. Executing controlled idempotent retry...'
    );

    let retryAttempt = 0;
    while (retryAttempt < maxRetries) {
      retryAttempt++;
      try {
        const result = await this.connector.createAppointment(payload);
        if (result.verified) {
          await IdentifierMapper.setMapping(
            hospitalId,
            'APPOINTMENT',
            internalAppointmentId,
            result.externalAppointmentId
          );

          await prisma.appointment.update({
            where: { id: internalAppointmentId },
            data: {
              status: AppointmentStatus.CONFIRMED,
              externalAppointmentId: result.externalAppointmentId,
            },
          });

          return {
            recovered: true,
            status: AppointmentStatus.CONFIRMED,
            externalAppointmentId: result.externalAppointmentId,
            notes: `Successfully recovered on retry attempt ${retryAttempt}.`,
          };
        }
      } catch (retryErr) {
        logger.warn({ retryAttempt, retryErr }, `Retry attempt ${retryAttempt} encountered error.`);
      }
    }

    // 3. Retries exhausted: Unrecoverable failure -> Transition to Reconciliation Required (PRD Option C)
    logger.error(
      { internalAppointmentId },
      'Retries exhausted. Creating Reconciliation Record and escalating to operator dashboard.'
    );

    metricsCollector.recordReconciliation();
    metricsCollector.recordEscalation();

    const reconciliation = await prisma.reconciliationRecord.create({
      data: {
        appointmentId: internalAppointmentId,
        hospitalId,
        reason: 'EHR_TIMEOUT_RETRIES_EXHAUSTED',
        externalSystemId: 'MOCK_EHR',
        externalRecordFound: false,
        attemptCount: retryAttempt + 1,
        status: 'OPEN',
        escalatedTo: 'PlatformOperationsDesk',
      },
    });

    await prisma.appointment.update({
      where: { id: internalAppointmentId },
      data: {
        status: AppointmentStatus.RECONCILIATION_REQUIRED,
      },
    });

    return {
      recovered: false,
      status: AppointmentStatus.RECONCILIATION_REQUIRED,
      reconciliationRecordId: reconciliation.id,
      notes: 'Retries exhausted. Moved to RECONCILIATION_REQUIRED and escalated to human operator.',
    };
  }
}
