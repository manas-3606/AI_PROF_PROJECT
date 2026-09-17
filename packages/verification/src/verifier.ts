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
}
