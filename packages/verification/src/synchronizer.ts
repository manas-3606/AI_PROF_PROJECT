import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import { MockEhrConnector } from '@health/integration';
import { logger } from '@health/observability';

export class Synchronizer {
  private connector: MockEhrConnector;

  constructor(connector?: MockEhrConnector) {
    this.connector = connector || new MockEhrConnector();
  }

  /**
   * Evaluates synchronization state between internal database and external EHR.
   */
  async synchronizeState(appointmentId: string, correlationId: string) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { hospital: true },
    });

    if (!appointment) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }

    const verification = await this.connector.verifyAppointment(
      appointment.id,
      appointment.externalAppointmentId || undefined
    );

    const inSync = verification.isVerified && appointment.status === AppointmentStatus.CONFIRMED;

    if (!inSync && verification.isVerified && (appointment.status === AppointmentStatus.SYNCHRONIZATION_PENDING || appointment.status === AppointmentStatus.PENDING)) {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: AppointmentStatus.CONFIRMED },
      });
      appointment.status = AppointmentStatus.CONFIRMED;
      logger.info({ appointmentId }, 'Synchronized appointment status to CONFIRMED');
    }

    return {
      internalStatus: appointment.status,
      externalStatus: verification.externalStatus,
      inSync,
      reconciliationRequired: !verification.isVerified && appointment.status === AppointmentStatus.CONFIRMED,
    };
  }
}
