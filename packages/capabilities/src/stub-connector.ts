import {
  HealthcareConnector,
  ExternalAppointmentPayload,
  ExternalAppointmentResult,
  ExternalReschedulePayload,
} from '@health/integration';

export class StubEhrConnector implements HealthcareConnector {
  private appointments = new Map<string, ExternalAppointmentResult>();
  public shouldSimulateFailure = false;
  public failureMessage = 'EHR connection refused';

  setSimulatedFailure(shouldFail: boolean, message?: string) {
    this.shouldSimulateFailure = shouldFail;
    if (message) this.failureMessage = message;
  }

  async rescheduleAppointment(payload: ExternalReschedulePayload): Promise<ExternalAppointmentResult> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    const result: ExternalAppointmentResult = {
      externalAppointmentId: payload.externalAppointmentId,
      status: 'CONFIRMED',
      verified: true,
      createdAt: new Date().toISOString(),
    };
    this.appointments.set(payload.internalAppointmentId, result);
    this.appointments.set(payload.externalAppointmentId, result);
    return result;
  }

  async createAppointment(payload: ExternalAppointmentPayload): Promise<ExternalAppointmentResult> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }

    const externalId = `EXT-APPT-${payload.internalAppointmentId.slice(0, 8)}`;
    const result: ExternalAppointmentResult = {
      externalAppointmentId: externalId,
      status: 'CONFIRMED',
      verified: true,
      createdAt: new Date().toISOString(),
    };

    this.appointments.set(payload.internalAppointmentId, result);
    this.appointments.set(externalId, result);
    return result;
  }

  async getAppointment(externalAppointmentId: string): Promise<ExternalAppointmentResult | null> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    return this.appointments.get(externalAppointmentId) || null;
  }

  async verifyAppointment(
    internalAppointmentId: string,
    externalAppointmentId?: string
  ): Promise<{
    isVerified: boolean;
    externalStatus: string;
    match: boolean;
  }> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }

    const appt =
      this.appointments.get(internalAppointmentId) ||
      (externalAppointmentId ? this.appointments.get(externalAppointmentId) : null);

    if (appt) {
      return {
        isVerified: true,
        externalStatus: appt.status,
        match: true,
      };
    }

    // Default verified stub response if internal appointment exists
    return {
      isVerified: true,
      externalStatus: 'CONFIRMED',
      match: true,
    };
  }

  async cancelAppointment(externalAppointmentId: string): Promise<boolean> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    const appt = this.appointments.get(externalAppointmentId);
    if (appt) {
      appt.status = 'CANCELLED';
      return true;
    }
    return true;
  }

  async lookupPatient(identifier: { phone?: string; externalPatientId?: string }): Promise<{
    externalPatientId: string;
    name: string;
    phone: string;
  } | null> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    if (identifier.externalPatientId) {
      return {
        externalPatientId: identifier.externalPatientId,
        name: 'Stub External Patient',
        phone: identifier.phone || '+15551234567',
      };
    }
    return null;
  }

  clear(): void {
    this.appointments.clear();
    this.shouldSimulateFailure = false;
  }
}
