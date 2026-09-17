export type UserRole = 'PATIENT' | 'DOCTOR' | 'HOSPITAL_ADMIN' | 'PLATFORM_ADMIN';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  tenantId?: string;
  doctorId?: string;
  patientId?: string;
}

export interface Hospital {
  id: string;
  name: string;
  slug: string;
  status: string;
  address: string;
  city: string;
  operatingHours: string;
  specialties: string[];
  contactEmail: string;
  contactPhone: string;
  _count?: { doctors: number; appointments: number };
}

export interface Doctor {
  id: string;
  hospitalId: string;
  name: string;
  specialty: string;
  department: string;
  qualifications: string;
  experienceYears: number;
  languages: string[];
  status: string;
  appointmentDurationMinutes: number;
  hospital?: Hospital;
}

export interface Slot {
  slotId?: string;
  id?: string;
  doctorId: string;
  startTime: string;
  endTime: string;
  isAvailable?: boolean;
  isBooked?: boolean;
}

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  hospitalId: string;
  slotId: string;
  startTime: string;
  endTime: string;
  status: string;
  reason?: string;
  externalAppointmentId?: string;
  doctor?: Doctor;
  hospital?: Hospital;
  patient?: { name: string; phone: string; email?: string };
  verifications?: Array<{ isVerified: boolean; externalStatus: string; verifiedAt: string }>;
  reconciliations?: Array<{ status: string; reason: string; createdAt: string }>;
  questionnaireResponses?: Array<{ answersJson: string }>;
}

export interface Questionnaire {
  id: string;
  hospitalId: string;
  title: string;
  description?: string;
  specialty?: string;
  questions: Array<{
    id: string;
    text: string;
    type: string;
    required: boolean;
    options?: string[];
  }>;
}

export interface AuditEvent {
  id: string;
  correlationId: string;
  tenantId?: string;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  timestamp: string;
}

export interface OperationalEvent {
  id: string;
  correlationId?: string;
  eventType: string;
  severity: string;
  message: string;
  timestamp: string;
}

export interface CapabilityExecution {
  id: string;
  capabilityName: string;
  status: string;
  durationMs: number;
  error?: string;
  createdAt: string;
}

export interface ReconciliationRecord {
  id: string;
  appointmentId: string;
  reason: string;
  status: string;
  attemptCount: number;
  createdAt: string;
  appointment?: Appointment;
}
