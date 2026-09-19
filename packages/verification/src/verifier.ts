import { prisma } from '@health/db';
import { MockEhrConnector } from '@health/integration';
import { logger } from '@health/observability';

export class Verifier {
  private connector: MockEhrConnector;

  constructor(connector?: MockEhrConnector) {
    this.connector = connector || new MockEhrConnector();
  }

  /**
   * Verifies that an appointment exists in the external EHR.
   * Emits an IntegrationVerification record to the database for observability.
   */
  async verifyAppointment(
    internalAppointmentId: string,
    hospitalId: string,
    externalAppointmentId?: string
  ): Promise<{
    isVerified: boolean;
    externalStatus: string;
    match: boolean;
  }> {
    logger.info({ internalAppointmentId, externalAppointmentId }, 'Executing post-operation external verification');

    const result = await this.connector.verifyAppointment(internalAppointmentId, externalAppointmentId);

    // Record verification event in DB
    await prisma.integrationVerification.create({
      data: {
        appointmentId: internalAppointmentId,
        hospitalId,
        isVerified: result.isVerified,
        externalStatus: result.externalStatus,
        match: result.match,
      },
    });

    return result;
  }

  /**
   * Verifies that an appointment has been cancelled in the external EHR.
   * Checks for status === 'CANCELLED' or NOT_FOUND (record removed).
   * Emits an IntegrationVerification record for observability.
   */
  async verifyAppointmentCancellation(
    internalAppointmentId: string,
    hospitalId: string,
    externalAppointmentId?: string
  ): Promise<{
    isVerified: boolean;
    externalStatus: string;
    match: boolean;
  }> {
    logger.info({ internalAppointmentId, externalAppointmentId }, 'Executing post-cancellation external verification');

    // If no external appointment ID was ever assigned or mapped, cancellation is verified internally
    if (!externalAppointmentId) {
      return {
        isVerified: true,
        externalStatus: 'CANCELLED',
        match: true,
      };
    }

    const result = await this.connector.verifyAppointment(internalAppointmentId, externalAppointmentId);

    // If external status is CANCELLED or NOT_FOUND (record removed/absent in EHR), it is verified cancelled!
    const isCancelledInEhr =
      result.externalStatus === 'CANCELLED' || result.externalStatus === 'NOT_FOUND';

    // Record verification event in DB
    await prisma.integrationVerification.create({
      data: {
        appointmentId: internalAppointmentId,
        hospitalId,
        isVerified: isCancelledInEhr,
        externalStatus: result.externalStatus,
        match: isCancelledInEhr,
      },
    });

    return {
      isVerified: isCancelledInEhr,
      externalStatus: result.externalStatus,
      match: isCancelledInEhr,
    };
  }
}
