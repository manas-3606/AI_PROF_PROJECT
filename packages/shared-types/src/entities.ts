import { z } from 'zod';

// -----------------------------------------------------------------------------
// Core Enums
// -----------------------------------------------------------------------------
export enum UserRole {
  PLATFORM_ADMIN = 'PLATFORM_ADMIN',
  HOSPITAL_ADMIN = 'HOSPITAL_ADMIN',
  HOSPITAL_STAFF = 'HOSPITAL_STAFF',
  DOCTOR = 'DOCTOR',
  PATIENT = 'PATIENT',
}

export enum HospitalStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
}

export enum DoctorStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}

/**
 * Explicit Appointment State Enum matching PRD Section 14
 */
export enum AppointmentStatus {
  REQUESTED = 'Requested',
  PENDING = 'Pending',
  CONFIRMED = 'Confirmed',
  RESCHEDULED = 'Rescheduled',
  CANCELLED = 'Cancelled',
  COMPLETED = 'Completed',
  NO_SHOW = 'No-show',
  FAILED = 'Failed',
  SYNCHRONIZATION_PENDING = 'Synchronization Pending',
  RECONCILIATION_REQUIRED = 'Reconciliation Required',
}

export enum WorkflowType {
  PRE_VISIT_QUESTIONNAIRE = 'PreVisitQuestionnaire',
  APPOINTMENT_REMINDER = 'AppointmentReminder',
  RECONCILIATION_SYNC = 'ReconciliationSync',
}

export enum WorkflowStatus {
  ACTIVE = 'Active',
  SCHEDULED = 'Scheduled',
  RUNNING = 'Running',
  COMPLETED = 'Completed',
  FAILED = 'Failed',
  RETRIED = 'Retried',
}

export enum NotificationChannel {
  SMS = 'sms',
  EMAIL = 'email',
  IN_APP = 'in_app',
}

export enum NotificationRecipientType {
  PATIENT = 'Patient',
  DOCTOR = 'Doctor',
  HOSPITAL_ADMIN = 'HospitalAdmin',
}

export enum ExternalEntityType {
  PATIENT = 'PATIENT',
  DOCTOR = 'DOCTOR',
  APPOINTMENT = 'APPOINTMENT',
  FACILITY = 'FACILITY',
}

export enum IntegrationOperationType {
  PATIENT_LOOKUP = 'PATIENT_LOOKUP',
  PROVIDER_LOOKUP = 'PROVIDER_LOOKUP',
  AVAILABILITY_LOOKUP = 'AVAILABILITY_LOOKUP',
  APPOINTMENT_CREATE = 'APPOINTMENT_CREATE',
  APPOINTMENT_UPDATE = 'APPOINTMENT_UPDATE',
  APPOINTMENT_CANCEL = 'APPOINTMENT_CANCEL',
  APPOINTMENT_VERIFY = 'APPOINTMENT_VERIFY',
}

export enum IntegrationStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  TIMEOUT = 'TIMEOUT',
  FAILED = 'FAILED',
  UNKNOWN_OUTCOME = 'UNKNOWN_OUTCOME',
}

export enum CapabilityCategory {
  SCHEDULING = 'SCHEDULING',
  DISCOVERY = 'DISCOVERY',
  INTEGRATION = 'INTEGRATION',
  COMMUNICATION = 'COMMUNICATION',
  WORKFLOW = 'WORKFLOW',
}

export enum RiskLevel {
  READ_ONLY = 'READ_ONLY',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum EventSeverity {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

// -----------------------------------------------------------------------------
// 1. Platform & Tenant Entities (PRD Section 22)
// -----------------------------------------------------------------------------
export interface PlatformRecord {
  id: string;
  name: string;
  version: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  hospitalId?: string; // Tenant isolation key
  tenantId?: string;   // Backwards-compatible alias
  patientId?: string;
  doctorId?: string;
}

export interface HospitalProfile {
  id: string;
  name: string;
  slug: string;
  status: HospitalStatus;
  address: string;
  city: string;
  operatingHours: string;
  contactEmail: string;
  contactPhone: string;
  specialties: string[];
}

export interface DepartmentRecord {
  id: string;
  hospitalId: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpecialtyRecord {
  id: string;
  name: string;
  description?: string;
}

export interface DoctorProfile {
  id: string;
  hospitalId: string;
  name: string;
  specialty: string;
  department: string;
  qualifications: string;
  experienceYears: number;
  languages: string[];
  consultationTypes: string[];
  appointmentDurationMinutes: number;
  status: DoctorStatus;
  photoUrl?: string;
  externalProviderId?: string;
}

// -----------------------------------------------------------------------------
// 2. Scheduling & Availability Entities (PRD Section 22)
// -----------------------------------------------------------------------------
export interface CalendarRecord {
  id: string;
  doctorId: string;
  hospitalId: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkingHourRecord {
  id: string;
  calendarId: string;
  hospitalId?: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface BlockedSlotRecord {
  id: string;
  calendarId: string;
  hospitalId?: string;
  startTime: string;
  endTime: string;
  reason?: string;
}

export interface CalendarSlot {
  id: string;
  doctorId: string;
  hospitalId: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  isBooked: boolean;
  isBlocked: boolean;
}

// -----------------------------------------------------------------------------
// 3. Patient & User Context / Preferences State (PRD Section 22 & 23)
// -----------------------------------------------------------------------------
export interface PatientProfile {
  id: string;
  userId: string;
  name: string;
  email?: string;
  phone: string;
  dateOfBirth?: string;
  communicationPreference: NotificationChannel;
  externalPatientId?: string;
}

export interface UserPreferenceRecord {
  id: string;
  patientId: string;
  hospitalId?: string;
  communicationChannel: NotificationChannel;
  preferredDays: string[];
  preferredTimeOfDay: 'morning' | 'afternoon' | 'evening';
  languagePreference?: string;
  specialRequirements?: string;
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// 4. Appointment & Transactional State History (PRD Section 14, 22, 23)
// -----------------------------------------------------------------------------
export interface AppointmentRecord {
  id: string;
  patientId: string;
  doctorId: string;
  hospitalId: string;
  slotId: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  reason?: string;
  externalAppointmentId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppointmentStateHistoryRecord {
  id: string;
  appointmentId: string;
  hospitalId: string;
  fromStatus: AppointmentStatus | string;
  toStatus: AppointmentStatus | string;
  reason?: string;
  actorId?: string;
  actorRole?: string;
  correlationId?: string;
  changedAt: string;
}

// -----------------------------------------------------------------------------
// 5. Questionnaires (PRD Section 22)
// -----------------------------------------------------------------------------
export interface QuestionnaireDefinition {
  id: string;
  hospitalId: string;
  title: string;
  description?: string;
  specialty?: string;
  questions: Array<{
    id: string;
    text: string;
    type: 'yes_no' | 'choice' | 'multiple_choice' | 'numeric' | 'short_text' | 'long_text';
    required: boolean;
    options?: string[];
  }>;
}

export interface QuestionnaireResponseRecord {
  id: string;
  questionnaireId: string;
  appointmentId: string;
  patientId: string;
  hospitalId?: string;
  answers: Record<string, any>;
  submittedAt: string;
}

// -----------------------------------------------------------------------------
// 6. Conversational AI & Capability Catalog (PRD Section 10, 22, 23)
// -----------------------------------------------------------------------------
export interface AiConversationRecord {
  id: string;
  patientId?: string;
  hospitalId?: string;
  channel: string;
  startTime: string;
  lastActivity: string;
}

export interface AiContextRecord {
  id: string;
  conversationId: string;
  currentIntent?: string;
  selectedHospitalId?: string;
  selectedDoctorId?: string;
  selectedSlotId?: string;
  activeAppointmentId?: string;
  context: Record<string, any>;
  updatedAt: string;
}

export interface CapabilityDefinition {
  id: string;
  name: string;
  description: string;
  category: CapabilityCategory;
  riskLevel: RiskLevel;
  isAiCallable: boolean;
  schemaVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityExecutionRecord {
  id: string;
  conversationId?: string;
  hospitalId?: string;
  capabilityName: string;
  inputJson: string;
  outputJson?: string;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  durationMs: number;
  correlationId?: string;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// 7. Integration & External System State (PRD Section 17, 18, 22, 23)
// -----------------------------------------------------------------------------
export interface HealthcareSystemConnectionRecord {
  id: string;
  hospitalId: string;
  systemType: 'MOCK_EHR' | 'EPIC_FHIR' | 'CERNER';
  baseUrl: string;
  status: 'ACTIVE' | 'INACTIVE';
  config: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/**
 * External Identifier Mapping supporting:
 * Patient <-> ExternalPatient
 * Doctor <-> ExternalProvider
 * Appointment <-> ExternalAppointment
 * Facility <-> ExternalFacility
 */
export interface ExternalIdentifierMappingRecord {
  id: string;
  hospitalId: string;
  tenantId?: string;
  entityType: ExternalEntityType | string;
  internalId: string;
  externalId: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationOperationRecord {
  id: string;
  connectionId: string;
  hospitalId: string;
  operationType: IntegrationOperationType;
  status: IntegrationStatus;
  requestJson?: string;
  responseJson?: string;
  error?: string;
  correlationId?: string;
  createdAt: string;
}

export interface IntegrationVerificationRecord {
  id: string;
  appointmentId: string;
  hospitalId: string;
  isVerified: boolean;
  externalStatus: string;
  match: boolean;
  verifiedAt: string;
}

export interface ReconciliationRecord {
  id: string;
  appointmentId: string;
  hospitalId: string;
  reason: string;
  externalSystemId: string;
  externalRecordFound: boolean;
  attemptCount: number;
  status: 'OPEN' | 'RESOLVED' | 'ESCALATED';
  escalatedTo?: string;
  createdAt: string;
  resolvedAt?: string;
}

// -----------------------------------------------------------------------------
// 8. Workflow State & Notifications (PRD Section 22 & 23)
// -----------------------------------------------------------------------------
export interface WorkflowDefinitionRecord {
  id: string;
  hospitalId: string;
  type: WorkflowType | string;
  triggerEvent: string;
  config: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExecutionRecord {
  id: string;
  workflowId: string;
  appointmentId?: string;
  hospitalId?: string;
  status: WorkflowStatus | string;
  payload: Record<string, any>;
  error?: string;
  attemptCount: number;
  scheduledAt: string;
  executedAt?: string;
}

export interface NotificationRecord {
  id: string;
  hospitalId?: string;
  recipientId: string;
  recipientType: NotificationRecipientType | string;
  channel: NotificationChannel | string;
  templateId: string;
  payload: Record<string, any>;
  status: 'Queued' | 'Delivered' | 'Failed';
  createdAt: string;
}

// -----------------------------------------------------------------------------
// 9. Operational & Observability State (PRD Section 22 & 23)
// -----------------------------------------------------------------------------
export interface AiEvaluationRecord {
  id: string;
  conversationId: string;
  hospitalId?: string;
  metric: string;
  score: number;
  feedback?: string;
  createdAt: string;
}

export interface AuditEventRecord {
  id: string;
  correlationId: string;
  hospitalId?: string;
  tenantId?: string;
  actorId?: string;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  details?: Record<string, any>;
  timestamp: string;
}

export interface OperationalEventRecord {
  id: string;
  correlationId?: string;
  hospitalId?: string;
  tenantId?: string;
  eventType: string;
  severity: EventSeverity;
  message: string;
  details?: Record<string, any>;
  timestamp: string;
}
