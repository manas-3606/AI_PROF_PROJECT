export interface ExternalAppointmentPayload {
  internalAppointmentId: string;
  externalPatientId: string;
  externalProviderId: string;
  startTime: string;
  endTime: string;
  reason?: string;
}

export interface ExternalAppointmentResult {
  externalAppointmentId: string;
  status: string; // e.g. 'CONFIRMED', 'PENDING'
  verified: boolean;
  createdAt: string;
}

export interface ExternalReschedulePayload {
  internalAppointmentId: string;
  externalAppointmentId: string;
  newStartTime: string;
  newEndTime: string;
  reason?: string;
}

export interface HealthcareConnector {
  createAppointment(payload: ExternalAppointmentPayload): Promise<ExternalAppointmentResult>;
  rescheduleAppointment(payload: ExternalReschedulePayload): Promise<ExternalAppointmentResult>;
  updateAppointment?(externalAppointmentId: string, updates: Partial<ExternalAppointmentPayload>): Promise<ExternalAppointmentResult>;
  getAppointment(externalAppointmentId: string): Promise<ExternalAppointmentResult | null>;
  retrieveAppointment?(externalAppointmentId: string): Promise<ExternalAppointmentResult | null>;
  verifyAppointment(internalAppointmentId: string, externalAppointmentId?: string): Promise<{
    isVerified: boolean;
    externalStatus: string;
    match: boolean;
  }>;
  cancelAppointment(externalAppointmentId: string): Promise<boolean>;
  lookupPatient(identifier: { phone?: string; externalPatientId?: string }): Promise<{
    externalPatientId: string;
    name: string;
    phone: string;
    dob?: string;
  } | null>;
  lookupProvider(identifier: { externalProviderId?: string; name?: string }): Promise<{
    externalProviderId: string;
    name: string;
    specialty: string;
  } | null>;
  lookupFacility(identifier: { externalFacilityId?: string; name?: string }): Promise<{
    externalFacilityId: string;
    name: string;
    address?: string;
  } | null>;
  lookupAvailability(
    externalProviderId: string,
    startDate: string,
    endDate: string
  ): Promise<Array<{ startTime: string; endTime: string; available: boolean }>>;
}

