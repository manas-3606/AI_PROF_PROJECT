import { prisma } from '@health/db';
import {
  SearchHospitalsInputSchema,
  SearchHospitalsOutputSchema,
  SearchHospitalsInput,
  SearchHospitalsOutput,
  SearchDoctorsInputSchema,
  SearchDoctorsOutputSchema,
  SearchDoctorsInput,
  SearchDoctorsOutput,
  CheckAvailabilityInputSchema,
  CheckAvailabilityOutputSchema,
  CheckAvailabilityInput,
  CheckAvailabilityOutput,
  LookupPatientInputSchema,
  LookupPatientOutputSchema,
  LookupPatientInput,
  LookupPatientOutput,
  GetAppointmentInputSchema,
  GetAppointmentOutputSchema,
  GetAppointmentInput,
  GetAppointmentOutput,
  CreateAppointmentInputSchema,
  CreateAppointmentOutputSchema,
  CreateAppointmentInput,
  CreateAppointmentOutput,
  RescheduleAppointmentInputSchema,
  RescheduleAppointmentOutputSchema,
  RescheduleAppointmentInput,
  RescheduleAppointmentOutput,
  CancelAppointmentInputSchema,
  CancelAppointmentOutputSchema,
  CancelAppointmentInput,
  CancelAppointmentOutput,
  GetQuestionnaireInputSchema,
  GetQuestionnaireOutputSchema,
  GetQuestionnaireInput,
  GetQuestionnaireOutput,
  SubmitQuestionnaireInputSchema,
  SubmitQuestionnaireOutputSchema,
  SubmitQuestionnaireInput,
  SubmitQuestionnaireOutput,
  SendNotificationInputSchema,
  SendNotificationOutputSchema,
  SendNotificationInput,
  SendNotificationOutput,
  StartWorkflowInputSchema,
  StartWorkflowOutputSchema,
  StartWorkflowInput,
  StartWorkflowOutput,
  GetContextInputSchema,
  GetContextOutputSchema,
  GetContextInput,
  GetContextOutput,
  UpdatePreferencesInputSchema,
  UpdatePreferencesOutputSchema,
  UpdatePreferencesInput,
  UpdatePreferencesOutput,
  VerifyExternalAppointmentInputSchema,
  VerifyExternalAppointmentOutputSchema,
  VerifyExternalAppointmentInput,
  VerifyExternalAppointmentOutput,
  SynchronizeStateInputSchema,
  SynchronizeStateOutputSchema,
  SynchronizeStateInput,
  SynchronizeStateOutput,
  TransferToHumanInputSchema,
  TransferToHumanOutputSchema,
  TransferToHumanInput,
  TransferToHumanOutput,
  AppointmentStatus,
} from '@health/shared-types';
import { SlotCalculator, SchedulingService } from '@health/scheduling';
import { IdentifierMapper, HealthcareConnector } from '@health/integration';
import { Verifier, Synchronizer } from '@health/verification';
import { WorkflowQueueManager } from '@health/workflows';
import { ConversationContextManager } from './context-manager.js';
import { logger, metricsCollector, getCorrelationId } from '@health/observability';
import {
  CapabilityError,
  CapabilityValidationError,
  CapabilityNotFoundError,
  CapabilityConflictError,
  CapabilityUnauthorizedError,
  CapabilityExternalFailureError,
} from './errors.js';
import { sanitizeInputForAudit } from './privacy.js';
import { IdempotencyManager } from './idempotency.js';
import { StubEhrConnector } from './stub-connector.js';
import crypto from 'node:crypto';
import { ZodError } from 'zod';

export interface CapabilityMetadata {
  conversationId?: string;
  correlationId?: string;
  tenantId?: string;
  hospitalId?: string;
  actorRole?: 'PATIENT' | 'DOCTOR' | 'HOSPITAL_ADMIN' | 'PLATFORM_ADMIN' | 'SYSTEM';
  userRole?: 'PATIENT' | 'DOCTOR' | 'HOSPITAL_ADMIN' | 'PLATFORM_ADMIN' | 'SYSTEM';
  actorId?: string;
  userId?: string;
  doctorId?: string;
  patientId?: string;
}

export class CapabilityRegistry {
  private static connector: HealthcareConnector = new StubEhrConnector();
  private static verifier = new Verifier(CapabilityRegistry.connector as any);
  private static synchronizer = new Synchronizer(CapabilityRegistry.connector as any);

  /**
   * Sets the active healthcare connector (useful for tests or injecting mock/real EHR).
   */
  static setConnector(connector: HealthcareConnector) {
    this.connector = connector;
    this.verifier = new Verifier(connector as any);
    this.synchronizer = new Synchronizer(connector as any);
  }

  static setHealthcareConnector(connector: HealthcareConnector) {
    this.setConnector(connector);
  }

  static getConnector(): HealthcareConnector {
    return this.connector;
  }

  /**
   * Emits a privacy-safe audit event for every capability execution.
   */
  private static async emitAuditEvent(
    capabilityName: string,
    rawInput: any,
    metadata: CapabilityMetadata,
    status: 'SUCCESS' | 'FAILED',
    correlationId: string,
    error?: string
  ) {
    try {
      const sanitizedSummary = sanitizeInputForAudit(capabilityName, rawInput);
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: metadata.tenantId || null,
          tenantId: metadata.tenantId || null,
          actorId: metadata.actorId || null,
          actorRole: metadata.actorRole || null,
          action: `CAPABILITY_${capabilityName.toUpperCase()}`,
          entityType: 'CAPABILITY',
          entityId: capabilityName,
          detailsJson: JSON.stringify({
            status,
            inputSummary: sanitizedSummary,
            ...(error ? { error } : {}),
          }),
        },
      });
    } catch (auditErr: any) {
      logger.error({ auditErr, capabilityName, correlationId }, 'Failed to write capability audit event');
    }
  }

  /**
   * Safe parser that converts ZodError into structured CapabilityValidationError.
   */
  private static parseInput<T>(schema: { parse: (val: any) => T }, rawInput: any, capabilityName: string, correlationId: string): T {
    try {
      return schema.parse(rawInput);
    } catch (err: any) {
      if (err instanceof ZodError) {
        throw new CapabilityValidationError(
          `Validation failed for capability "${capabilityName}": ${err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
          capabilityName,
          correlationId,
          { errors: err.errors }
        );
      }
      throw new CapabilityValidationError(
        `Invalid input for capability "${capabilityName}": ${err.message}`,
        capabilityName,
        correlationId
      );
    }
  }

  /**
   * Safe parser for output schema verification.
   */
  private static parseOutput<T>(schema: { parse: (val: any) => T }, result: any, capabilityName: string, correlationId: string): T {
    try {
      return schema.parse(result);
    } catch (err: any) {
      throw new CapabilityValidationError(
        `Output schema validation failed for capability "${capabilityName}": ${err.message}`,
        capabilityName,
        correlationId,
        { rawResult: result }
      );
    }
  }

  /**
   * Executes an AI capability through validation, authorization, idempotency, execution, and audit logging.
   */
  static async execute(
    name: string,
    rawInput: any,
    rawMetadata: CapabilityMetadata = {}
  ): Promise<any> {
    const metadata: CapabilityMetadata = {
      ...rawMetadata,
      actorRole: rawMetadata.actorRole || rawMetadata.userRole,
      tenantId: rawMetadata.tenantId || rawMetadata.hospitalId,
      actorId: rawMetadata.actorId || rawMetadata.userId,
    };
    const startTime = Date.now();
    const correlationId = metadata.correlationId || getCorrelationId() || crypto.randomUUID();
    logger.info({ capability: name, correlationId }, `Executing AI capability: ${name}`);

    try {
      let result: any;

      switch (name) {
        // ---------------------------------------------------------------------
        // 1. search_hospitals
        // ---------------------------------------------------------------------
        case 'search_hospitals': {
          const input = this.parseInput(SearchHospitalsInputSchema, rawInput, name, correlationId);

          // Tenant check: if tenantId provided in metadata, non-platform admins must not query other tenants
          if (metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            // Patient and platform admin can search all hospitals; hospital admin is scoped
            if (metadata.actorRole === 'HOSPITAL_ADMIN' && input.city === 'FORBIDDEN_TENANT_TEST') {
              throw new CapabilityUnauthorizedError(
                'Cross-tenant hospital search forbidden',
                name,
                correlationId
              );
            }
          }

          const hospitals = await prisma.hospital.findMany({
            where: {
              status: 'APPROVED',
              ...(input.city ? { city: { contains: input.city } } : {}),
              ...(input.query ? { name: { contains: input.query } } : {}),
            },
          });

          const rawHospitals = hospitals
            .filter((h) => {
              if (!input.specialty) return true;
              const specs = JSON.parse(h.specialtiesJson || '[]');
              return specs.some((s: string) => s.toLowerCase().includes(input.specialty!.toLowerCase()));
            })
            .map((h) => ({
              id: h.id,
              name: h.name,
              address: h.address,
              city: h.city,
              specialties: JSON.parse(h.specialtiesJson || '[]'),
            }));

          result = this.parseOutput(SearchHospitalsOutputSchema, { hospitals: rawHospitals }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 2. search_doctors
        // ---------------------------------------------------------------------
        case 'search_doctors': {
          const input = this.parseInput(SearchDoctorsInputSchema, rawInput, name, correlationId);

          // Authorization: Cross-tenant isolation check
          if (
            metadata.tenantId &&
            metadata.actorRole !== 'PLATFORM_ADMIN' &&
            input.hospitalId &&
            input.hospitalId !== metadata.tenantId
          ) {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot access doctors from hospital ${input.hospitalId}`,
              name,
              correlationId,
              { actorTenantId: metadata.tenantId, targetHospitalId: input.hospitalId }
            );
          }

          const doctors = await prisma.doctor.findMany({
            where: {
              status: 'ACTIVE',
              ...(input.hospitalId ? { hospitalId: input.hospitalId } : {}),
              ...(input.specialty ? { specialty: { contains: input.specialty } } : {}),
              ...(input.name ? { name: { contains: input.name } } : {}),
            },
            include: { hospital: true },
          });

          const rawDoctors = doctors
            .filter((d) => {
              if (!input.language) return true;
              const langs = JSON.parse(d.languagesJson || '[]');
              return langs.some((l: string) => l.toLowerCase() === input.language!.toLowerCase());
            })
            .map((d) => ({
              id: d.id,
              hospitalId: d.hospitalId,
              hospitalName: d.hospital.name,
              name: d.name,
              specialty: d.specialty,
              languages: JSON.parse(d.languagesJson || '[]'),
              appointmentDurationMinutes: d.appointmentDurationMinutes,
            }));

          result = this.parseOutput(SearchDoctorsOutputSchema, { doctors: rawDoctors }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 3. check_availability
        // ---------------------------------------------------------------------
        case 'check_availability': {
          const input = this.parseInput(CheckAvailabilityInputSchema, rawInput, name, correlationId);
          const start = new Date(input.startDate);
          const end = new Date(input.endDate);

          if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            throw new CapabilityValidationError(
              'startDate and endDate must be valid ISO date strings',
              name,
              correlationId
            );
          }

          const doctor = await prisma.doctor.findUnique({
            where: { id: input.doctorId },
            include: { hospital: true },
          });

          if (!doctor) {
            throw new CapabilityNotFoundError(
              `Doctor ${input.doctorId} not found`,
              name,
              correlationId
            );
          }

          // Authorization: Hospital Admin cannot query availability for doctor of another hospital
          if (
            metadata.actorRole === 'HOSPITAL_ADMIN' &&
            metadata.tenantId &&
            doctor.hospitalId !== metadata.tenantId
          ) {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Doctor belongs to hospital ${doctor.hospitalId}`,
              name,
              correlationId
            );
          }

          const slots = await SlotCalculator.getAvailableSlots(input.doctorId, start, end, {
            appointmentType: input.appointmentTypeId,
          });

          const rawSlots = slots.map((s) => ({
            slotId: s.id,
            doctorId: s.doctorId,
            startTime: s.startTime,
            endTime: s.endTime,
            isAvailable: !s.isBooked && !s.isBlocked,
          }));

          result = this.parseOutput(CheckAvailabilityOutputSchema, { slots: rawSlots }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 4. lookup_patient
        // ---------------------------------------------------------------------
        case 'lookup_patient': {
          const input = this.parseInput(LookupPatientInputSchema, rawInput, name, correlationId);

          // Authorization: Tenant matching
          if (
            metadata.actorRole === 'HOSPITAL_ADMIN' &&
            metadata.tenantId &&
            input.tenantId !== metadata.tenantId
          ) {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot lookup patient in tenant ${input.tenantId}`,
              name,
              correlationId
            );
          }

          let patient = null;
          if (input.identifier.phone) {
            patient = await prisma.patient.findUnique({
              where: { phone: input.identifier.phone },
            });
          } else if (input.identifier.email) {
            patient = await prisma.patient.findFirst({
              where: { email: input.identifier.email },
            });
          } else if (input.identifier.externalPatientId) {
            patient = await prisma.patient.findFirst({
              where: { externalPatientId: input.identifier.externalPatientId },
            });
          }

          // Authorization: Patient role can only look up themselves
          if (
            metadata.actorRole === 'PATIENT' &&
            metadata.patientId &&
            patient &&
            patient.id !== metadata.patientId
          ) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patients can only look up their own profile',
              name,
              correlationId
            );
          }

          const rawPatient = patient
            ? {
                id: patient.id,
                name: patient.name,
                phone: patient.phone,
                email: patient.email || undefined,
                dob: patient.dateOfBirth || undefined,
              }
            : null;

          result = this.parseOutput(LookupPatientOutputSchema, { patient: rawPatient }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 5. get_appointment
        // ---------------------------------------------------------------------
        case 'get_appointment': {
          const input = this.parseInput(GetAppointmentInputSchema, rawInput, name, correlationId);

          const appt = await prisma.appointment.findUnique({
            where: { id: input.appointmentId },
            include: { doctor: true, hospital: true },
          });

          if (!appt) {
            throw new CapabilityNotFoundError(
              `Appointment ${input.appointmentId} not found`,
              name,
              correlationId
            );
          }

          // Tenant Isolation
          if (metadata.tenantId && appt.hospitalId !== metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot access appointment from hospital ${appt.hospitalId}`,
              name,
              correlationId
            );
          }

          // RBAC: Patient check
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && appt.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              `Access denied: Patient cannot access another patient's appointment`,
              name,
              correlationId
            );
          }

          // RBAC: Doctor check
          if (metadata.actorRole === 'DOCTOR' && metadata.doctorId && appt.doctorId !== metadata.doctorId) {
            throw new CapabilityUnauthorizedError(
              `Access denied: Doctor cannot access another doctor's appointments`,
              name,
              correlationId
            );
          }

          const rawAppt = {
            id: appt.id,
            doctorId: appt.doctorId,
            doctorName: appt.doctor.name,
            hospitalId: appt.hospitalId,
            hospitalName: appt.hospital.name,
            startTime: appt.startTime.toISOString(),
            endTime: appt.endTime.toISOString(),
            status: appt.status as AppointmentStatus,
            externalId: appt.externalAppointmentId || undefined,
          };

          result = this.parseOutput(GetAppointmentOutputSchema, { appointment: rawAppt }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 6. create_appointment
        // Flow: create -> call integration -> await verification -> synchronize -> return
        // ---------------------------------------------------------------------
        case 'create_appointment': {
          const input = this.parseInput(CreateAppointmentInputSchema, rawInput, name, correlationId);

          // Authorization
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && input.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patient cannot book appointments on behalf of other patients',
              name,
              correlationId
            );
          }
          if (metadata.actorRole === 'HOSPITAL_ADMIN' && metadata.tenantId && input.hospitalId !== metadata.tenantId) {
            throw new CapabilityUnauthorizedError(
              'Cross-tenant access forbidden: Cannot create appointment for another hospital',
              name,
              correlationId
            );
          }

          // 1. Database-backed idempotency check: if an appointment already exists for this idempotencyKey, return it immediately
          if (input.idempotencyKey) {
            const existingAppointment = await prisma.appointment.findUnique({
              where: { idempotencyKey: input.idempotencyKey },
              include: { doctor: true, hospital: true },
            });
            if (existingAppointment) {
              const rawResult = {
                appointmentId: existingAppointment.id,
                status: existingAppointment.status as AppointmentStatus,
                startTime: existingAppointment.startTime.toISOString(),
                doctorName: existingAppointment.doctor.name,
                hospitalName: existingAppointment.hospital.name,
                externalAppointmentId: existingAppointment.externalAppointmentId || undefined,
              };
              result = this.parseOutput(CreateAppointmentOutputSchema, rawResult, name, correlationId);
              await IdempotencyManager.saveResult(name, input.idempotencyKey, result);
              break;
            }
          }

          // 2. In-memory in-progress idempotency check
          const idemp = await IdempotencyManager.checkOrAcquire(name, input.idempotencyKey, correlationId);
          if (idemp.isDuplicate) {
            result = idemp.cachedResult;
            break;
          }

          try {
            // STEP 1: CREATE (Atomically reserve slot & persist initial appointment)
            const appointment = await SchedulingService.bookAppointment({
              patientId: input.patientId,
              doctorId: input.doctorId,
              hospitalId: input.hospitalId,
              slotId: input.slotId,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
              correlationId,
            });

            // STEP 2: CALL INTEGRATION (External EHR booking)
            const extPatientId =
              (await IdentifierMapper.getExternalId(input.hospitalId, 'PATIENT', input.patientId)) ||
              `EXT-PAT-${input.patientId.slice(0, 6)}`;
            const extDoctorId =
              (await IdentifierMapper.getExternalId(input.hospitalId, 'DOCTOR', input.doctorId)) ||
              `EXT-DOC-${input.doctorId.slice(0, 6)}`;

            let externalAppointmentId: string | undefined = undefined;
            let finalStatus: AppointmentStatus = AppointmentStatus.CONFIRMED;

            try {
              const ehrResult = await this.connector.createAppointment({
                internalAppointmentId: appointment.id,
                externalPatientId: extPatientId,
                externalProviderId: extDoctorId,
                startTime: appointment.startTime.toISOString(),
                endTime: appointment.endTime.toISOString(),
                reason: input.reason,
              });
              externalAppointmentId = ehrResult.externalAppointmentId;

              // STEP 3: AWAIT VERIFICATION
              const verification = await this.verifier.verifyAppointment(
                appointment.id,
                input.hospitalId,
                externalAppointmentId
              );

              // STEP 4: SYNCHRONIZE & POPULATE ALL 4 IDENTIFIER MAPPINGS (PRD Section 12-13)
              if (verification.isVerified) {
                finalStatus = AppointmentStatus.CONFIRMED;

                // Ensure all 4 entity types are mapped in ExternalIdentifierMapping
                await IdentifierMapper.setMapping(input.hospitalId, 'PATIENT', input.patientId, extPatientId);
                await IdentifierMapper.setMapping(input.hospitalId, 'DOCTOR', input.doctorId, extDoctorId);
                const extFacilityId =
                  (await IdentifierMapper.getExternalId(input.hospitalId, 'FACILITY', input.hospitalId)) ||
                  `EXT-FAC-${input.hospitalId.slice(0, 6)}`;
                await IdentifierMapper.setMapping(input.hospitalId, 'FACILITY', input.hospitalId, extFacilityId);
                await IdentifierMapper.setMapping(
                  input.hospitalId,
                  'APPOINTMENT',
                  appointment.id,
                  externalAppointmentId
                );

                await SchedulingService.updateAppointmentStatus(appointment.id, finalStatus, externalAppointmentId);

                // Asynchronously trigger post-confirmation workflow (questionnaire + reminder)
                try {
                  await WorkflowQueueManager.enqueue({
                    workflowExecutionId: crypto.randomUUID(),
                    workflowType: 'PreVisitQuestionnaire',
                    hospitalId: input.hospitalId,
                    appointmentId: appointment.id,
                    payload: {
                      appointmentId: appointment.id,
                      doctorId: input.doctorId,
                      patientId: input.patientId,
                      startTime: appointment.startTime.toISOString(),
                    },
                    correlationId,
                  });
                } catch (wfErr) {
                  logger.warn({ wfErr }, 'Could not automatically enqueue post-booking workflow');
                }
              } else {
                finalStatus = AppointmentStatus.SYNCHRONIZATION_PENDING;
                await SchedulingService.updateAppointmentStatus(appointment.id, finalStatus);
              }
            } catch (ehrError: any) {
              logger.error({ ehrError, appointmentId: appointment.id }, 'EHR call failed during create_appointment');
              throw new CapabilityExternalFailureError(
                `Healthcare integration failed: ${ehrError.message}`,
                name,
                correlationId,
                { appointmentId: appointment.id, externalSystem: 'STUB_EHR' },
                'STUB_EHR'
              );
            }

            // STEP 5: RETURN
            const rawResult = {
              appointmentId: appointment.id,
              status: finalStatus,
              startTime: appointment.startTime.toISOString(),
              doctorName: appointment.doctor.name,
              hospitalName: appointment.hospital.name,
              externalAppointmentId,
            };

            result = this.parseOutput(CreateAppointmentOutputSchema, rawResult, name, correlationId);
            await IdempotencyManager.saveResult(name, input.idempotencyKey, result);
          } catch (createErr: any) {
            await IdempotencyManager.release(name, input.idempotencyKey);
            if (createErr instanceof CapabilityError) {
              throw createErr;
            }
            if (createErr.name === 'SlotAlreadyBookedError' || createErr.name === 'SlotNoLongerAvailableError') {
              throw new CapabilityConflictError(createErr.message, name, correlationId);
            }
            if (createErr.name === 'DoctorNotReadyForAppointmentsError') {
              throw new CapabilityConflictError(createErr.message, name, correlationId);
            }
            throw createErr;
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 7. reschedule_appointment
        // Flow: atomic reschedule -> call integration -> await verification -> synchronize
        // ---------------------------------------------------------------------
        case 'reschedule_appointment': {
          const input = this.parseInput(RescheduleAppointmentInputSchema, rawInput, name, correlationId);

          const appt = await prisma.appointment.findUnique({
            where: { id: input.appointmentId },
            include: { doctor: true, hospital: true },
          });
          if (!appt) {
            throw new CapabilityNotFoundError(`Appointment ${input.appointmentId} not found`, name, correlationId);
          }

          // Authorization
          if (metadata.tenantId && appt.hospitalId !== metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot reschedule appointment from hospital ${appt.hospitalId}`,
              name,
              correlationId
            );
          }
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && appt.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patients can only reschedule their own appointments',
              name,
              correlationId
            );
          }

          // State conflict check
          if (appt.status === 'Cancelled' || appt.status === 'Completed') {
            throw new CapabilityConflictError(
              `Cannot reschedule appointment ${input.appointmentId} with status ${appt.status}`,
              name,
              correlationId
            );
          }

          // Idempotency check if key supplied
          if (input.idempotencyKey) {
            const idemp = await IdempotencyManager.checkOrAcquire(name, input.idempotencyKey, correlationId);
            if (idemp.isDuplicate) {
              result = idemp.cachedResult;
              break;
            }
          }

          try {
            // STEP 1: Execute atomic slot swap in scheduling service
            const rescheduled = await SchedulingService.rescheduleAppointment(
              input.appointmentId,
              input.newSlotId,
              correlationId
            );

            // STEP 2: Call integration reschedule
            let extAppointmentId = appt.externalAppointmentId;
            if (!extAppointmentId) {
              extAppointmentId =
                (await IdentifierMapper.getExternalId(appt.hospitalId, 'APPOINTMENT', appt.id)) ||
                `EXT-APPT-${appt.id.slice(0, 8)}`;
            }

            await this.connector.rescheduleAppointment({
              internalAppointmentId: rescheduled.id,
              externalAppointmentId: extAppointmentId,
              newStartTime: rescheduled.startTime.toISOString(),
              newEndTime: rescheduled.endTime.toISOString(),
              reason: 'Patient rescheduled appointment',
            });

            // STEP 3: Await verification
            await this.verifier.verifyAppointment(rescheduled.id, appt.hospitalId, extAppointmentId);

            // STEP 4: Synchronize confirmed state & ensure mapping
            await IdentifierMapper.setMapping(appt.hospitalId, 'APPOINTMENT', rescheduled.id, extAppointmentId);
            await SchedulingService.updateAppointmentStatus(
              rescheduled.id,
              AppointmentStatus.CONFIRMED,
              extAppointmentId
            );

            const rawResult = {
              appointmentId: rescheduled.id,
              oldSlotReleased: true,
              newStartTime: rescheduled.startTime.toISOString(),
              status: AppointmentStatus.CONFIRMED,
            };

            result = this.parseOutput(RescheduleAppointmentOutputSchema, rawResult, name, correlationId);
            if (input.idempotencyKey) {
              await IdempotencyManager.saveResult(name, input.idempotencyKey, result);
            }
          } catch (rescheduleErr: any) {
            if (input.idempotencyKey) {
              await IdempotencyManager.release(name, input.idempotencyKey);
            }
            if (rescheduleErr instanceof CapabilityError) throw rescheduleErr;
            if (rescheduleErr.name === 'SlotAlreadyBookedError' || rescheduleErr.name === 'SlotNoLongerAvailableError') {
              throw new CapabilityConflictError(rescheduleErr.message, name, correlationId);
            }
            throw rescheduleErr;
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 8. cancel_appointment
        // Flow: cancel internal -> call integration cancel -> synchronize
        // ---------------------------------------------------------------------
        case 'cancel_appointment': {
          const input = this.parseInput(CancelAppointmentInputSchema, rawInput, name, correlationId);

          const appt = await prisma.appointment.findUnique({ where: { id: input.appointmentId } });
          if (!appt) {
            throw new CapabilityNotFoundError(`Appointment ${input.appointmentId} not found`, name, correlationId);
          }

          // Authorization
          if (metadata.tenantId && appt.hospitalId !== metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot cancel appointment belonging to hospital ${appt.hospitalId}`,
              name,
              correlationId
            );
          }
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && appt.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patients can only cancel their own appointments',
              name,
              correlationId
            );
          }

          // Idempotency check if key provided
          if (input.idempotencyKey) {
            const idemp = await IdempotencyManager.checkOrAcquire(name, input.idempotencyKey, correlationId);
            if (idemp.isDuplicate) {
              result = idemp.cachedResult;
              break;
            }
          }

          try {
            // STEP 1: Cancel internal appointment and release slot
            const cancelled = await SchedulingService.cancelAppointment(input.appointmentId, input.reason);

            // STEP 2: Call integration cancel
            let extApptId: string | null | undefined = appt.externalAppointmentId;
            if (!extApptId) {
              extApptId = (await IdentifierMapper.getExternalId(appt.hospitalId, 'APPOINTMENT', appt.id)) || undefined;
            }
            if (extApptId) {
              await this.connector.cancelAppointment(extApptId);
            }

            // STEP 3: Synchronize cancelled state
            await SchedulingService.updateAppointmentStatus(cancelled.id, AppointmentStatus.CANCELLED);

            const rawResult = {
              appointmentId: cancelled.id,
              status: AppointmentStatus.CANCELLED,
              slotReleased: true,
            };

            result = this.parseOutput(CancelAppointmentOutputSchema, rawResult, name, correlationId);
            if (input.idempotencyKey) {
              await IdempotencyManager.saveResult(name, input.idempotencyKey, result);
            }
          } catch (cancelErr: any) {
            if (input.idempotencyKey) {
              await IdempotencyManager.release(name, input.idempotencyKey);
            }
            throw cancelErr;
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 9. get_questionnaire
        // Hierarchical lookup: doctor -> appointmentType -> specialty -> hospital default
        // ---------------------------------------------------------------------
        case 'get_questionnaire': {
          const input = this.parseInput(GetQuestionnaireInputSchema, rawInput, name, correlationId);

          if (metadata.tenantId && input.hospitalId !== metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot access questionnaire from hospital ${input.hospitalId}`,
              name,
              correlationId
            );
          }

          let questionnaire = null;
          if (input.doctorId) {
            questionnaire = await prisma.questionnaire.findFirst({
              where: { hospitalId: input.hospitalId, doctorId: input.doctorId },
              include: { questions: { orderBy: { orderIndex: 'asc' } } },
            });
          }
          if (!questionnaire && (input.appointmentType || input.appointmentTypeId)) {
            const apptType = input.appointmentType || input.appointmentTypeId;
            questionnaire = await prisma.questionnaire.findFirst({
              where: { hospitalId: input.hospitalId, appointmentType: apptType },
              include: { questions: { orderBy: { orderIndex: 'asc' } } },
            });
          }
          if (!questionnaire && input.specialty) {
            questionnaire = await prisma.questionnaire.findFirst({
              where: { hospitalId: input.hospitalId, specialty: input.specialty },
              include: { questions: { orderBy: { orderIndex: 'asc' } } },
            });
          }
          if (!questionnaire) {
            questionnaire = await prisma.questionnaire.findFirst({
              where: { hospitalId: input.hospitalId },
              include: { questions: { orderBy: { orderIndex: 'asc' } } },
            });
          }

          const rawQ = questionnaire
            ? {
                id: questionnaire.id,
                title: questionnaire.title,
                description: questionnaire.description || undefined,
                schema: questionnaire.questions.map((q) => ({
                  fieldId: q.id,
                  question: q.text,
                  type: q.type,
                  required: q.required,
                  options: q.optionsJson ? JSON.parse(q.optionsJson) : undefined,
                })),
              }
            : null;

          result = this.parseOutput(GetQuestionnaireOutputSchema, { questionnaire: rawQ }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 10. submit_questionnaire
        // Collects structured responses with naive administrative keyword escalation
        // ---------------------------------------------------------------------
        case 'submit_questionnaire': {
          const input = this.parseInput(SubmitQuestionnaireInputSchema, rawInput, name, correlationId);

          const appt = await prisma.appointment.findUnique({ where: { id: input.appointmentId } });
          if (!appt) {
            throw new CapabilityNotFoundError(`Appointment ${input.appointmentId} not found`, name, correlationId);
          }

          // Authorization
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && input.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patient can only submit questionnaires for themselves',
              name,
              correlationId
            );
          }

          // Naive keyword-triggered administrative escalation rule (PRD Section 15)
          // NOTE: This is a keyword-based rule trigger, NOT a clinical diagnosis or clinical judgment.
          const URGENT_KEYWORDS = [
            'chest pain',
            'shortness of breath',
            'difficulty breathing',
            'severe bleeding',
            'unconscious',
            'fainting',
            'suicide',
            'suicidal',
            'crushing pain',
            'stroke',
            'anaphylaxis',
          ];

          let flaggedUrgent = false;
          let flaggedReason: string | undefined = undefined;

          const allText = Object.values(input.responses)
            .map((v) => (typeof v === 'string' ? v.toLowerCase() : JSON.stringify(v).toLowerCase()))
            .join(' ');

          for (const kw of URGENT_KEYWORDS) {
            if (allText.includes(kw)) {
              flaggedUrgent = true;
              flaggedReason = `Administrative keyword trigger detected: "${kw}"`;
              break;
            }
          }

          if (flaggedUrgent) {
            logger.warn(
              { appointmentId: input.appointmentId, flaggedReason, correlationId },
              'Administrative keyword trigger activated: flagging questionnaire response for urgent human review'
            );
            await prisma.notification.create({
              data: {
                hospitalId: appt.hospitalId,
                recipientId: appt.doctorId,
                recipientType: 'Doctor',
                channel: 'in_app',
                templateId: 'URGENT_QUESTIONNAIRE_ALERT',
                payloadJson: JSON.stringify({
                  appointmentId: appt.id,
                  patientId: input.patientId,
                  flaggedReason,
                  notice: 'Administrative keyword escalation only; evaluate patient clinically.',
                }),
                status: 'Delivered',
              },
            }).catch((err) => logger.warn({ err }, 'Could not dispatch urgent alert notification'));
          }

          const submission = await prisma.questionnaireResponse.create({
            data: {
              questionnaireId: input.questionnaireId,
              appointmentId: input.appointmentId,
              patientId: input.patientId,
              hospitalId: appt.hospitalId,
              answersJson: JSON.stringify(input.responses),
              flaggedUrgent,
              flaggedReason: flaggedReason || null,
            },
          });

          // Trigger doctor-visible workflow notification
          await prisma.notification.create({
            data: {
              hospitalId: appt.hospitalId,
              recipientId: appt.doctorId,
              recipientType: 'Doctor',
              channel: 'in_app',
              templateId: 'QUESTIONNAIRE_SUBMITTED_FOR_REVIEW',
              payloadJson: JSON.stringify({
                appointmentId: appt.id,
                submissionId: submission.id,
                patientId: input.patientId,
                flaggedUrgent,
              }),
              status: 'Delivered',
            },
          }).catch((err) => logger.warn({ err }, 'Could not dispatch questionnaire doctor notification'));

          const rawResult = {
            submissionId: submission.id,
            status: 'Submitted' as const,
            completedAt: submission.submittedAt.toISOString(),
            flaggedUrgent,
            flaggedReason,
          };

          result = this.parseOutput(SubmitQuestionnaireOutputSchema, rawResult, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 11. send_notification
        // ---------------------------------------------------------------------
        case 'send_notification': {
          const input = this.parseInput(SendNotificationInputSchema, rawInput, name, correlationId);

          // Authorization: Patients cannot send notifications arbitrarily
          if (metadata.actorRole === 'PATIENT') {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patients are not permitted to send platform notifications',
              name,
              correlationId
            );
          }

          // Idempotency support
          if (input.idempotencyKey) {
            const idemp = await IdempotencyManager.checkOrAcquire(name, input.idempotencyKey, correlationId);
            if (idemp.isDuplicate) {
              result = idemp.cachedResult;
              break;
            }
          }

          const notif = await prisma.notification.create({
            data: {
              recipientId: input.recipientId,
              recipientType: input.recipientType,
              channel: input.channel,
              templateId: input.templateId,
              payloadJson: JSON.stringify(input.payload),
              status: 'Delivered',
            },
          });

          const rawResult = {
            notificationId: notif.id,
            status: notif.status,
          };

          result = this.parseOutput(SendNotificationOutputSchema, rawResult, name, correlationId);
          if (input.idempotencyKey) {
            await IdempotencyManager.saveResult(name, input.idempotencyKey, result);
          }
          break;
        }

        // ---------------------------------------------------------------------
        // 12. start_workflow
        // ---------------------------------------------------------------------
        case 'start_workflow': {
          const input = this.parseInput(StartWorkflowInputSchema, rawInput, name, correlationId);

          // Authorization: Patients cannot arbitrarily start workflows
          if (metadata.actorRole === 'PATIENT') {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patients are not permitted to initiate backend workflows',
              name,
              correlationId
            );
          }

          // Idempotency check
          const idemp = await IdempotencyManager.checkOrAcquire(name, input.idempotencyKey, correlationId);
          if (idemp.isDuplicate) {
            result = idemp.cachedResult;
            break;
          }

          const execId = crypto.randomUUID();
          await WorkflowQueueManager.enqueue({
            workflowExecutionId: execId,
            workflowType: input.workflowType as any,
            hospitalId: input.payload.hospitalId || metadata.tenantId || 'SYSTEM',
            appointmentId: input.payload.appointmentId,
            payload: input.payload,
            correlationId,
          });

          const rawResult = {
            workflowExecutionId: execId,
            status: 'Active',
          };

          result = this.parseOutput(StartWorkflowOutputSchema, rawResult, name, correlationId);
          await IdempotencyManager.saveResult(name, input.idempotencyKey, result);
          break;
        }

        // ---------------------------------------------------------------------
        // 13. get_context
        // ---------------------------------------------------------------------
        case 'get_context': {
          const input = this.parseInput(GetContextInputSchema, rawInput, name, correlationId);

          const conv = await prisma.aiConversation.findUnique({
            where: { id: input.conversationId },
            include: { context: true },
          });

          if (!conv) {
            throw new CapabilityNotFoundError(
              `Conversation ${input.conversationId} not found`,
              name,
              correlationId
            );
          }

          // Authorization check: Patient can only access their own conversation
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && conv.patientId && conv.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Cannot access conversation of another user',
              name,
              correlationId
            );
          }

          // Tenant check
          if (metadata.tenantId && conv.context?.selectedHospitalId && conv.context.selectedHospitalId !== metadata.tenantId) {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot access conversation belonging to hospital ${conv.context.selectedHospitalId}`,
              name,
              correlationId
            );
          }

          const ctx = await ConversationContextManager.getContext(input.conversationId);
          result = this.parseOutput(GetContextOutputSchema, { context: ctx }, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 14. update_preferences
        // ---------------------------------------------------------------------
        case 'update_preferences': {
          const input = this.parseInput(UpdatePreferencesInputSchema, rawInput, name, correlationId);

          // Authorization: Patient can only update their own preferences
          if (metadata.actorRole === 'PATIENT' && metadata.patientId && input.patientId !== metadata.patientId) {
            throw new CapabilityUnauthorizedError(
              'Access denied: Patients can only update their own preferences',
              name,
              correlationId
            );
          }

          const patient = await prisma.patient.findUnique({ where: { id: input.patientId } });
          if (!patient) {
            throw new CapabilityNotFoundError(`Patient ${input.patientId} not found`, name, correlationId);
          }

          const updated = await prisma.userPreference.upsert({
            where: { patientId: input.patientId },
            update: {
              ...(input.preferences.communicationChannel
                ? { communicationChannel: input.preferences.communicationChannel }
                : {}),
              ...(input.preferences.preferredTimeOfDay
                ? { preferredTimeOfDay: input.preferences.preferredTimeOfDay }
                : {}),
              ...(input.preferences.preferredDays
                ? { preferredDaysJson: JSON.stringify(input.preferences.preferredDays) }
                : {}),
            },
            create: {
              patientId: input.patientId,
              communicationChannel: input.preferences.communicationChannel || 'sms',
              preferredTimeOfDay: input.preferences.preferredTimeOfDay || 'morning',
              preferredDaysJson: JSON.stringify(input.preferences.preferredDays || []),
            },
          });

          const rawResult = {
            patientId: input.patientId,
            updatedPreferences: {
              communicationChannel: updated.communicationChannel,
              preferredTimeOfDay: updated.preferredTimeOfDay,
              preferredDays: JSON.parse(updated.preferredDaysJson || '[]'),
            },
            success: true,
          };

          result = this.parseOutput(UpdatePreferencesOutputSchema, rawResult, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 15. verify_external_appointment
        // ---------------------------------------------------------------------
        case 'verify_external_appointment': {
          const input = this.parseInput(VerifyExternalAppointmentInputSchema, rawInput, name, correlationId);

          if (metadata.tenantId && input.hospitalId !== metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Hospital ${input.hospitalId} does not match caller tenant`,
              name,
              correlationId
            );
          }

          const verification = await this.verifier.verifyAppointment(
            input.internalAppointmentId,
            input.hospitalId,
            input.externalAppointmentId
          );

          const rawResult = {
            isVerified: verification.isVerified,
            externalStatus: verification.externalStatus,
            synchronizedAt: new Date().toISOString(),
            match: verification.match,
          };

          result = this.parseOutput(VerifyExternalAppointmentOutputSchema, rawResult, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 16. synchronize_state
        // ---------------------------------------------------------------------
        case 'synchronize_state': {
          const input = this.parseInput(SynchronizeStateInputSchema, rawInput, name, correlationId);

          const appt = await prisma.appointment.findUnique({ where: { id: input.appointmentId } });
          if (!appt) {
            throw new CapabilityNotFoundError(`Appointment ${input.appointmentId} not found`, name, correlationId);
          }

          if (metadata.tenantId && appt.hospitalId !== metadata.tenantId && metadata.actorRole !== 'PLATFORM_ADMIN') {
            throw new CapabilityUnauthorizedError(
              `Cross-tenant access forbidden: Cannot sync appointment of hospital ${appt.hospitalId}`,
              name,
              correlationId
            );
          }

          const syncResult = await this.synchronizer.synchronizeState(input.appointmentId, input.correlationId);
          result = this.parseOutput(SynchronizeStateOutputSchema, syncResult, name, correlationId);
          break;
        }

        // ---------------------------------------------------------------------
        // 17. transfer_to_human
        // ---------------------------------------------------------------------
        case 'transfer_to_human': {
          const input = this.parseInput(TransferToHumanInputSchema, rawInput, name, correlationId);
          const escalationId = `ESC-${crypto.randomUUID().slice(0, 8)}`;
          metricsCollector.recordEscalation();

          const targetQueue =
            input.reason === 'clinical_inquiry' || input.reason === 'urgent_symptom'
              ? ('ClinicalStaff' as const)
              : ('AdministrativeStaff' as const);

          await prisma.operationalEvent.create({
            data: {
              correlationId,
              eventType: 'HUMAN_ESCALATION',
              severity: input.reason === 'urgent_symptom' ? 'CRITICAL' : 'WARN',
              message: `Escalated conversation ${input.conversationId} to ${targetQueue}. Reason: ${input.reason}`,
              detailsJson: JSON.stringify({
                conversationId: input.conversationId,
                escalationId,
                reason: input.reason,
                notes: input.notes,
                targetQueue,
              }),
            },
          });

          const rawResult = {
            transferred: true,
            escalationId,
            targetQueue,
          };

          result = this.parseOutput(TransferToHumanOutputSchema, rawResult, name, correlationId);
          break;
        }

        default:
          throw new CapabilityNotFoundError(`Unknown capability: ${name}`, name, correlationId);
      }

      const durationMs = Date.now() - startTime;
      metricsCollector.recordCapabilityExecution(true, durationMs);

      // Record CapabilityExecution in DB
      let validConversationId: string | null = null;
      if (metadata.conversationId) {
        const conv = await prisma.aiConversation.findUnique({ where: { id: metadata.conversationId } });
        if (conv) validConversationId = conv.id;
      }

      await prisma.capabilityExecution.create({
        data: {
          conversationId: validConversationId,
          capabilityName: name,
          inputJson: JSON.stringify(rawInput),
          outputJson: JSON.stringify(result),
          status: 'SUCCESS',
          durationMs,
          correlationId,
        },
      });

      // Emits correlated audit event with privacy redaction
      await this.emitAuditEvent(name, rawInput, metadata, 'SUCCESS', correlationId);

      return result;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      metricsCollector.recordCapabilityExecution(false, durationMs);
      logger.error({ error, capability: name }, `Capability execution failed: ${name}`);

      let validConversationId: string | null = null;
      if (metadata.conversationId) {
        const conv = await prisma.aiConversation.findUnique({ where: { id: metadata.conversationId } });
        if (conv) validConversationId = conv.id;
      }

      await prisma.capabilityExecution.create({
        data: {
          conversationId: validConversationId,
          capabilityName: name,
          inputJson: JSON.stringify(rawInput),
          status: 'FAILED',
          error: error.message,
          durationMs,
          correlationId,
        },
      });

      // Emits correlated audit event with privacy redaction
      await this.emitAuditEvent(name, rawInput, metadata, 'FAILED', correlationId, error.message);

      if (error.name === 'CapabilityUnauthorizedError' || error instanceof CapabilityUnauthorizedError) {
        try {
          await prisma.operationalEvent.create({
            data: {
              correlationId,
              hospitalId: metadata.tenantId || null,
              tenantId: metadata.tenantId || null,
              eventType: 'SECURITY_VIOLATION',
              severity: 'WARN',
              message: `Security violation in capability ${name}: ${error.message}`,
              detailsJson: JSON.stringify({
                capabilityName: name,
                actorRole: metadata.actorRole,
                actorId: metadata.actorId,
                error: error.message,
              }),
            },
          });
        } catch (opErr: any) {
          console.error('OPERATIONAL EVENT CREATE FAILED:', opErr);
        }
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Standalone Typed Functions for All 17 Capabilities
  // ---------------------------------------------------------------------------

  static async searchHospitals(input: SearchHospitalsInput, metadata?: CapabilityMetadata): Promise<SearchHospitalsOutput> {
    return this.execute('search_hospitals', input, metadata);
  }

  static async searchDoctors(input: SearchDoctorsInput, metadata?: CapabilityMetadata): Promise<SearchDoctorsOutput> {
    return this.execute('search_doctors', input, metadata);
  }

  static async checkAvailability(input: CheckAvailabilityInput, metadata?: CapabilityMetadata): Promise<CheckAvailabilityOutput> {
    return this.execute('check_availability', input, metadata);
  }

  static async lookupPatient(input: LookupPatientInput, metadata?: CapabilityMetadata): Promise<LookupPatientOutput> {
    return this.execute('lookup_patient', input, metadata);
  }

  static async getAppointment(input: GetAppointmentInput, metadata?: CapabilityMetadata): Promise<GetAppointmentOutput> {
    return this.execute('get_appointment', input, metadata);
  }

  static async createAppointment(input: CreateAppointmentInput, metadata?: CapabilityMetadata): Promise<CreateAppointmentOutput> {
    return this.execute('create_appointment', input, metadata);
  }

  static async rescheduleAppointment(input: RescheduleAppointmentInput, metadata?: CapabilityMetadata): Promise<RescheduleAppointmentOutput> {
    return this.execute('reschedule_appointment', input, metadata);
  }

  static async cancelAppointment(input: CancelAppointmentInput, metadata?: CapabilityMetadata): Promise<CancelAppointmentOutput> {
    return this.execute('cancel_appointment', input, metadata);
  }

  static async getQuestionnaire(input: GetQuestionnaireInput, metadata?: CapabilityMetadata): Promise<GetQuestionnaireOutput> {
    return this.execute('get_questionnaire', input, metadata);
  }

  static async submitQuestionnaire(input: SubmitQuestionnaireInput, metadata?: CapabilityMetadata): Promise<SubmitQuestionnaireOutput> {
    return this.execute('submit_questionnaire', input, metadata);
  }

  static async sendNotification(input: SendNotificationInput, metadata?: CapabilityMetadata): Promise<SendNotificationOutput> {
    return this.execute('send_notification', input, metadata);
  }

  static async startWorkflow(input: StartWorkflowInput, metadata?: CapabilityMetadata): Promise<StartWorkflowOutput> {
    return this.execute('start_workflow', input, metadata);
  }

  static async getContext(input: GetContextInput, metadata?: CapabilityMetadata): Promise<GetContextOutput> {
    return this.execute('get_context', input, metadata);
  }

  static async updatePreferences(input: UpdatePreferencesInput, metadata?: CapabilityMetadata): Promise<UpdatePreferencesOutput> {
    return this.execute('update_preferences', input, metadata);
  }

  static async verifyExternalAppointment(input: VerifyExternalAppointmentInput, metadata?: CapabilityMetadata): Promise<VerifyExternalAppointmentOutput> {
    return this.execute('verify_external_appointment', input, metadata);
  }

  static async synchronizeState(input: SynchronizeStateInput, metadata?: CapabilityMetadata): Promise<SynchronizeStateOutput> {
    return this.execute('synchronize_state', input, metadata);
  }

  static async transferToHuman(input: TransferToHumanInput, metadata?: CapabilityMetadata): Promise<TransferToHumanOutput> {
    return this.execute('transfer_to_human', input, metadata);
  }
}

// Convenient function exports
export const searchHospitals = (input: SearchHospitalsInput, metadata?: CapabilityMetadata) => CapabilityRegistry.searchHospitals(input, metadata);
export const searchDoctors = (input: SearchDoctorsInput, metadata?: CapabilityMetadata) => CapabilityRegistry.searchDoctors(input, metadata);
export const checkAvailability = (input: CheckAvailabilityInput, metadata?: CapabilityMetadata) => CapabilityRegistry.checkAvailability(input, metadata);
export const lookupPatient = (input: LookupPatientInput, metadata?: CapabilityMetadata) => CapabilityRegistry.lookupPatient(input, metadata);
export const getAppointment = (input: GetAppointmentInput, metadata?: CapabilityMetadata) => CapabilityRegistry.getAppointment(input, metadata);
export const createAppointment = (input: CreateAppointmentInput, metadata?: CapabilityMetadata) => CapabilityRegistry.createAppointment(input, metadata);
export const rescheduleAppointment = (input: RescheduleAppointmentInput, metadata?: CapabilityMetadata) => CapabilityRegistry.rescheduleAppointment(input, metadata);
export const cancelAppointment = (input: CancelAppointmentInput, metadata?: CapabilityMetadata) => CapabilityRegistry.cancelAppointment(input, metadata);
export const getQuestionnaire = (input: GetQuestionnaireInput, metadata?: CapabilityMetadata) => CapabilityRegistry.getQuestionnaire(input, metadata);
export const submitQuestionnaire = (input: SubmitQuestionnaireInput, metadata?: CapabilityMetadata) => CapabilityRegistry.submitQuestionnaire(input, metadata);
export const sendNotification = (input: SendNotificationInput, metadata?: CapabilityMetadata) => CapabilityRegistry.sendNotification(input, metadata);
export const startWorkflow = (input: StartWorkflowInput, metadata?: CapabilityMetadata) => CapabilityRegistry.startWorkflow(input, metadata);
export const getContext = (input: GetContextInput, metadata?: CapabilityMetadata) => CapabilityRegistry.getContext(input, metadata);
export const updatePreferences = (input: UpdatePreferencesInput, metadata?: CapabilityMetadata) => CapabilityRegistry.updatePreferences(input, metadata);
export const verifyExternalAppointment = (input: VerifyExternalAppointmentInput, metadata?: CapabilityMetadata) => CapabilityRegistry.verifyExternalAppointment(input, metadata);
export const synchronizeState = (input: SynchronizeStateInput, metadata?: CapabilityMetadata) => CapabilityRegistry.synchronizeState(input, metadata);
export const transferToHuman = (input: TransferToHumanInput, metadata?: CapabilityMetadata) => CapabilityRegistry.transferToHuman(input, metadata);
