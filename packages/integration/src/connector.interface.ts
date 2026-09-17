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
  getAppointment(externalAppointmentId: string): Promise<ExternalAppointmentResult | null>;
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
  } | null>;
}
