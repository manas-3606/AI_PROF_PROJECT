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

  async lookupProvider(identifier: { externalProviderId?: string; name?: string }): Promise<{
    externalProviderId: string;
    name: string;
    specialty: string;
  } | null> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    return {
      externalProviderId: identifier.externalProviderId || 'EXT-PROV-001',
      name: identifier.name || 'Dr. Arvind Rao',
      specialty: 'Orthopedics',
    };
  }

  async lookupFacility(identifier: { externalFacilityId?: string; name?: string }): Promise<{
    externalFacilityId: string;
    name: string;
    address?: string;
  } | null> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    return {
      externalFacilityId: identifier.externalFacilityId || 'EXT-FAC-001',
      name: identifier.name || 'Apex Regional Medical Center',
      address: '100 Medical Center Way',
    };
  }

  async lookupAvailability(
    externalProviderId: string,
    startDate: string,
    endDate: string
  ): Promise<Array<{ startTime: string; endTime: string; available: boolean }>> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    return [
      {
        startTime: new Date(Date.now() + 86400000).toISOString(),
        endTime: new Date(Date.now() + 86400000 + 1800000).toISOString(),
        available: true,
      },
    ];
  }

  async updateAppointment(externalAppointmentId: string, updates: Partial<ExternalAppointmentPayload>): Promise<ExternalAppointmentResult> {
    if (this.shouldSimulateFailure) {
      throw new Error(this.failureMessage);
    }
    const appt = this.appointments.get(externalAppointmentId);
    const updated: ExternalAppointmentResult = {
      externalAppointmentId,
      status: 'CONFIRMED',
      verified: true,
      createdAt: appt?.createdAt || new Date().toISOString(),
    };
    this.appointments.set(externalAppointmentId, updated);
    return updated;
  }

  async retrieveAppointment(externalAppointmentId: string): Promise<ExternalAppointmentResult | null> {
    return this.getAppointment(externalAppointmentId);
  }

  clear(): void {
    this.appointments.clear();
    this.shouldSimulateFailure = false;
  }
}

