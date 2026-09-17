import { z } from 'zod';
import { AppointmentStatus, WorkflowType, NotificationChannel } from './entities.js';

// 1. search_hospitals
export const SearchHospitalsInputSchema = z.object({
  query: z.string().optional(),
  specialty: z.string().optional(),
  city: z.string().optional(),
});
export type SearchHospitalsInput = z.infer<typeof SearchHospitalsInputSchema>;

export const SearchHospitalsOutputSchema = z.object({
  hospitals: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      address: z.string(),
      city: z.string(),
      specialties: z.array(z.string()),
    })
  ),
});
export type SearchHospitalsOutput = z.infer<typeof SearchHospitalsOutputSchema>;

// 2. search_doctors
export const SearchDoctorsInputSchema = z.object({
  hospitalId: z.string().optional(),
  specialty: z.string().optional(),
  name: z.string().optional(),
  language: z.string().optional(),
});
export type SearchDoctorsInput = z.infer<typeof SearchDoctorsInputSchema>;

export const SearchDoctorsOutputSchema = z.object({
  doctors: z.array(
    z.object({
      id: z.string(),
      hospitalId: z.string(),
      hospitalName: z.string().optional(),
      name: z.string(),
      specialty: z.string(),
      languages: z.array(z.string()),
      appointmentDurationMinutes: z.number(),
    })
  ),
});
export type SearchDoctorsOutput = z.infer<typeof SearchDoctorsOutputSchema>;

// 3. check_availability
export const CheckAvailabilityInputSchema = z.object({
  doctorId: z.string(),
  startDate: z.string(), // ISO date or string
  endDate: z.string(),   // ISO date or string
  appointmentTypeId: z.string().optional(),
});
export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilityInputSchema>;

export const CheckAvailabilityOutputSchema = z.object({
  slots: z.array(
    z.object({
      slotId: z.string(),
      doctorId: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      isAvailable: z.boolean(),
    })
  ),
});
export type CheckAvailabilityOutput = z.infer<typeof CheckAvailabilityOutputSchema>;

// 4. lookup_patient
export const LookupPatientInputSchema = z.object({
  identifier: z.object({
    phone: z.string().optional(),
    email: z.string().optional(),
    externalPatientId: z.string().optional(),
  }),
  tenantId: z.string(),
});
export type LookupPatientInput = z.infer<typeof LookupPatientInputSchema>;

export const LookupPatientOutputSchema = z.object({
  patient: z
    .object({
      id: z.string(),
      name: z.string(),
      phone: z.string(),
      email: z.string().optional(),
      dob: z.string().optional(),
    })
    .nullable(),
});
export type LookupPatientOutput = z.infer<typeof LookupPatientOutputSchema>;

// 5. get_appointment
export const GetAppointmentInputSchema = z.object({
  appointmentId: z.string(),
  patientId: z.string().optional(),
});
export type GetAppointmentInput = z.infer<typeof GetAppointmentInputSchema>;

export const GetAppointmentOutputSchema = z.object({
  appointment: z
    .object({
      id: z.string(),
      doctorId: z.string(),
      doctorName: z.string().optional(),
      hospitalId: z.string(),
      hospitalName: z.string().optional(),
      startTime: z.string(),
      endTime: z.string(),
      status: z.nativeEnum(AppointmentStatus),
      externalId: z.string().optional(),
    })
    .nullable(),
});
export type GetAppointmentOutput = z.infer<typeof GetAppointmentOutputSchema>;

// 6. create_appointment
export const CreateAppointmentInputSchema = z.object({
  patientId: z.string(),
  doctorId: z.string(),
  hospitalId: z.string(),
  slotId: z.string(),
  reason: z.string().optional(),
  idempotencyKey: z.string(),
});
export type CreateAppointmentInput = z.infer<typeof CreateAppointmentInputSchema>;

export const CreateAppointmentOutputSchema = z.object({
  appointmentId: z.string(),
  status: z.nativeEnum(AppointmentStatus),
  startTime: z.string(),
  doctorName: z.string(),
  hospitalName: z.string(),
  externalAppointmentId: z.string().optional(),
});
export type CreateAppointmentOutput = z.infer<typeof CreateAppointmentOutputSchema>;

// 7. reschedule_appointment
export const RescheduleAppointmentInputSchema = z.object({
  appointmentId: z.string(),
  newSlotId: z.string(),
  reason: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type RescheduleAppointmentInput = z.infer<typeof RescheduleAppointmentInputSchema>;

export const RescheduleAppointmentOutputSchema = z.object({
  appointmentId: z.string(),
  oldSlotReleased: z.boolean(),
  newStartTime: z.string(),
  status: z.nativeEnum(AppointmentStatus),
});
export type RescheduleAppointmentOutput = z.infer<typeof RescheduleAppointmentOutputSchema>;

// 8. cancel_appointment
export const CancelAppointmentInputSchema = z.object({
  appointmentId: z.string(),
  reason: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type CancelAppointmentInput = z.infer<typeof CancelAppointmentInputSchema>;

export const CancelAppointmentOutputSchema = z.object({
  appointmentId: z.string(),
  status: z.nativeEnum(AppointmentStatus),
  slotReleased: z.boolean(),
});
export type CancelAppointmentOutput = z.infer<typeof CancelAppointmentOutputSchema>;

// 9. get_questionnaire
export const GetQuestionnaireInputSchema = z.object({
  hospitalId: z.string(),
  appointmentTypeId: z.string().optional(),
  appointmentType: z.string().optional(),
  specialty: z.string().optional(),
  doctorId: z.string().optional(),
});
export type GetQuestionnaireInput = z.infer<typeof GetQuestionnaireInputSchema>;

export const GetQuestionnaireOutputSchema = z.object({
  questionnaire: z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      schema: z.array(
        z.object({
          fieldId: z.string(),
          question: z.string(),
          type: z.string(),
          required: z.boolean(),
          options: z.array(z.string()).optional(),
        })
      ),
    })
    .nullable(),
});
export type GetQuestionnaireOutput = z.infer<typeof GetQuestionnaireOutputSchema>;

// 10. submit_questionnaire
export const SubmitQuestionnaireInputSchema = z.object({
  questionnaireId: z.string(),
  appointmentId: z.string(),
  patientId: z.string(),
  responses: z.record(z.any()),
});
export type SubmitQuestionnaireInput = z.infer<typeof SubmitQuestionnaireInputSchema>;

export const SubmitQuestionnaireOutputSchema = z.object({
  submissionId: z.string(),
  status: z.literal('Submitted'),
  completedAt: z.string(),
  flaggedUrgent: z.boolean().optional(),
  flaggedReason: z.string().optional(),
});
export type SubmitQuestionnaireOutput = z.infer<typeof SubmitQuestionnaireOutputSchema>;

// 11. send_notification
export const SendNotificationInputSchema = z.object({
  recipientId: z.string(),
  recipientType: z.enum(['Patient', 'Doctor', 'HospitalAdmin']),
  channel: z.enum(['sms', 'email', 'in_app']),
  templateId: z.string(),
  payload: z.record(z.any()),
  idempotencyKey: z.string().optional(),
});
export type SendNotificationInput = z.infer<typeof SendNotificationInputSchema>;

export const SendNotificationOutputSchema = z.object({
  notificationId: z.string(),
  status: z.string(), // Queued, Delivered, etc.
});
export type SendNotificationOutput = z.infer<typeof SendNotificationOutputSchema>;

// 12. start_workflow
export const StartWorkflowInputSchema = z.object({
  workflowType: z.enum(['PreVisitQuestionnaire', 'AppointmentReminder', 'ReconciliationSync']),
  triggerEvent: z.string(),
  payload: z.record(z.any()),
  idempotencyKey: z.string(),
});
export type StartWorkflowInput = z.infer<typeof StartWorkflowInputSchema>;

export const StartWorkflowOutputSchema = z.object({
  workflowExecutionId: z.string(),
  status: z.string(), // Active, Scheduled, etc.
});
export type StartWorkflowOutput = z.infer<typeof StartWorkflowOutputSchema>;

// 13. get_context
export const GetContextInputSchema = z.object({
  conversationId: z.string(),
});
export type GetContextInput = z.infer<typeof GetContextInputSchema>;

export const GetContextOutputSchema = z.object({
  context: z.object({
    currentIntent: z.string().optional(),
    selectedHospitalId: z.string().optional(),
    selectedDoctorId: z.string().optional(),
    selectedSlotId: z.string().optional(),
    activeAppointmentId: z.string().optional(),
    preferences: z.record(z.any()).optional(),
  }),
});
export type GetContextOutput = z.infer<typeof GetContextOutputSchema>;

// 14. update_preferences
export const UpdatePreferencesInputSchema = z.object({
  patientId: z.string(),
  preferences: z.object({
    communicationChannel: z.enum(['sms', 'email', 'phone']).optional(),
    preferredDays: z.array(z.string()).optional(),
    preferredTimeOfDay: z.enum(['morning', 'afternoon', 'evening']).optional(),
  }),
});
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesInputSchema>;

export const UpdatePreferencesOutputSchema = z.object({
  patientId: z.string(),
  updatedPreferences: z.record(z.any()),
  success: z.boolean(),
});
export type UpdatePreferencesOutput = z.infer<typeof UpdatePreferencesOutputSchema>;

// 15. verify_external_appointment
export const VerifyExternalAppointmentInputSchema = z.object({
  internalAppointmentId: z.string(),
  externalAppointmentId: z.string().optional(),
  hospitalId: z.string(),
});
export type VerifyExternalAppointmentInput = z.infer<typeof VerifyExternalAppointmentInputSchema>;

export const VerifyExternalAppointmentOutputSchema = z.object({
  isVerified: z.boolean(),
  externalStatus: z.string(),
  synchronizedAt: z.string(),
  match: z.boolean(),
});
export type VerifyExternalAppointmentOutput = z.infer<typeof VerifyExternalAppointmentOutputSchema>;

// 16. synchronize_state
export const SynchronizeStateInputSchema = z.object({
  appointmentId: z.string(),
  forceRecheck: z.boolean().optional(),
  correlationId: z.string(),
});
export type SynchronizeStateInput = z.infer<typeof SynchronizeStateInputSchema>;

export const SynchronizeStateOutputSchema = z.object({
  internalStatus: z.string(),
  externalStatus: z.string(),
  inSync: z.boolean(),
  reconciliationRequired: z.boolean(),
});
export type SynchronizeStateOutput = z.infer<typeof SynchronizeStateOutputSchema>;

// 17. transfer_to_human
export const TransferToHumanInputSchema = z.object({
  conversationId: z.string(),
  reason: z.enum(['clinical_inquiry', 'unrecoverable_failure', 'patient_request', 'urgent_symptom']),
  notes: z.string().optional(),
});
export type TransferToHumanInput = z.infer<typeof TransferToHumanInputSchema>;

export const TransferToHumanOutputSchema = z.object({
  transferred: z.boolean(),
  escalationId: z.string(),
  targetQueue: z.enum(['ClinicalStaff', 'AdministrativeStaff']),
});
export type TransferToHumanOutput = z.infer<typeof TransferToHumanOutputSchema>;
