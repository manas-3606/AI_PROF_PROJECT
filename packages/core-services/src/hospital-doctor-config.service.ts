import { prisma } from '@health/db';
import { AuthUser, DoctorStatus, HospitalStatus, UserRole } from '@health/shared-types';
import { logger } from '@health/observability';
import { HospitalOnboardingService } from './hospital-onboarding.service.js';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

export class DoctorNotReadyForAppointmentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorNotReadyForAppointmentsError';
  }
}

export class DoctorConfigUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorConfigUnauthorizedError';
  }
}

export class DoctorLifecycleTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorLifecycleTransitionError';
  }
}

export interface InviteDoctorInput {
  name: string;
  email: string;
  password?: string;
  departmentId?: string;
  specialtyId?: string;
  department?: string;
  specialty?: string;
  qualifications?: string;
  experienceYears?: number;
  languages?: string[];
  consultationTypes?: string[];
  appointmentDurationMinutes?: number;
  photoUrl?: string;
  externalProviderId?: string;
  initialStatus?: DoctorStatus;
}

export interface UpdateDoctorProfileInput {
  departmentId?: string;
  specialtyId?: string;
  department?: string;
  specialty?: string;
  qualifications?: string;
  experienceYears?: number;
  languages?: string[];
  consultationTypes?: string[];
  appointmentDurationMinutes?: number;
  photoUrl?: string;
  externalProviderId?: string;
}

export interface WorkingHourInput {
  dayOfWeek: number; // 0 (Sun) to 6 (Sat)
  startTime: string; // "09:00"
  endTime: string;   // "17:00"
}

export interface BlockedPeriodInput {
  startTime: Date | string;
  endTime: Date | string;
  reason?: string;
}

export interface DepartmentInput {
  name: string;
  description?: string;
}

export class HospitalDoctorConfigService {
  // ---------------------------------------------------------------------------
  // 1. Authorization & Tenant Scoping Helpers (PRD Section 4)
  // ---------------------------------------------------------------------------

  /**
   * Asserts that an actor is authorized to manage hospital-level configuration.
   * Allowed: Platform Admin, or Hospital Admin of that specific hospital.
   */
  static assertCanConfigureHospital(actor: AuthUser, hospitalId: string, actionDesc: string) {
    if (actor.role === UserRole.PLATFORM_ADMIN) {
      return;
    }

    const actorTenant = (actor as any).tenantId || actor.hospitalId;
    if (actor.role === UserRole.HOSPITAL_ADMIN && actorTenant === hospitalId) {
      return;
    }

    throw new DoctorConfigUnauthorizedError(
      `User ${actor.id} (${actor.role}) is not authorized to ${actionDesc} for hospital ${hospitalId}`
    );
  }

  /**
   * Asserts that an actor is authorized to configure a doctor's availability or blocked time.
   * Allowed:
   * - Platform Admin
   * - Hospital Admin for that doctor's hospital
   * - The Doctor themselves (actor.id === doctor.userId)
   */
  static async assertCanManageDoctorAvailability(
    actor: AuthUser,
    doctor: { id: string; userId: string; hospitalId: string; name: string },
    actionDesc: string,
    correlationId?: string
  ) {
    if (actor.role === UserRole.PLATFORM_ADMIN) {
      return;
    }

    const actorTenant = (actor as any).tenantId || actor.hospitalId;
    if (actor.role === UserRole.HOSPITAL_ADMIN && actorTenant === doctor.hospitalId) {
      return;
    }

    // Doctor managing their own availability per PRD Section 4
    if (actor.role === UserRole.DOCTOR && actor.id === doctor.userId) {
      return;
    }

    // Record audit event for unauthorized attempt
    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: actorTenant || doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'UNAUTHORIZED_AVAILABILITY_CONFIG_ATTEMPT',
        entityType: 'DOCTOR',
        entityId: doctor.id,
        detailsJson: JSON.stringify({
          actionDesc,
          targetDoctorId: doctor.id,
          targetDoctorUserId: doctor.userId,
          actorId: actor.id,
          actorRole: actor.role,
        }),
      },
    });

    throw new DoctorConfigUnauthorizedError(
      `User ${actor.id} (${actor.role}) is not authorized to ${actionDesc} for doctor ${doctor.name} (${doctor.id}). Doctors may only manage their own availability.`
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Department & Specialty Management (PRD Section 6)
  // ---------------------------------------------------------------------------

  static async createDepartment(hospitalId: string, input: DepartmentInput, actor: AuthUser, correlationId?: string) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'create departments');
    this.assertCanConfigureHospital(actor, hospitalId, 'create departments');

    const dept = await prisma.department.create({
      data: {
        hospitalId,
        name: input.name,
        description: input.description,
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DEPARTMENT_CREATED',
        entityType: 'DEPARTMENT',
        entityId: dept.id,
        detailsJson: JSON.stringify({ name: dept.name }),
      },
    });

    return dept;
  }

  static async listDepartments(hospitalId: string, actor?: AuthUser) {
    if (actor) {
      this.assertCanConfigureHospital(actor, hospitalId, 'view departments');
    }
    return prisma.department.findMany({
      where: { hospitalId },
      include: { doctors: { select: { id: true, name: true, status: true, specialty: true } } },
    });
  }

  static async updateDepartment(hospitalId: string, departmentId: string, input: Partial<DepartmentInput>, actor: AuthUser) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'update departments');
    this.assertCanConfigureHospital(actor, hospitalId, 'update departments');

    const existing = await prisma.department.findFirst({
      where: { id: departmentId, hospitalId },
    });
    if (!existing) {
      throw new Error(`Department ${departmentId} not found in hospital ${hospitalId}`);
    }

    return prisma.department.update({
      where: { id: departmentId },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
  }

  static async deleteDepartment(hospitalId: string, departmentId: string, actor: AuthUser) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'delete departments');
    this.assertCanConfigureHospital(actor, hospitalId, 'delete departments');

    return prisma.department.delete({
      where: { id: departmentId },
    });
  }

  static async listSpecialties() {
    return prisma.specialty.findMany();
  }

  static async createSpecialty(name: string, description?: string) {
    return prisma.specialty.upsert({
      where: { name },
      create: { name, description },
      update: { description },
    });
  }

  static async listHospitalSpecialties(hospitalId: string, actor?: AuthUser) {
    if (actor) {
      this.assertCanConfigureHospital(actor, hospitalId, 'view specialties');
    }
    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { specialtiesJson: true },
    });
    if (!hospital) {
      throw new Error(`Hospital ${hospitalId} not found`);
    }
    const hospitalSpecialties: string[] = JSON.parse(hospital.specialtiesJson || '[]');
    const allSpecialties = await prisma.specialty.findMany();
    return {
      hospitalSpecialties,
      availableSpecialties: allSpecialties.map((s) => s.name),
    };
  }

  static async addHospitalSpecialty(
    hospitalId: string,
    specialtyName: string,
    actor: AuthUser,
    correlationId?: string
  ) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'add specialty');
    this.assertCanConfigureHospital(actor, hospitalId, 'add specialty');

    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
    });
    if (!hospital) {
      throw new Error(`Hospital ${hospitalId} not found`);
    }

    const current: string[] = JSON.parse(hospital.specialtiesJson || '[]');
    if (!current.includes(specialtyName)) {
      current.push(specialtyName);
      await prisma.hospital.update({
        where: { id: hospitalId },
        data: { specialtiesJson: JSON.stringify(current) },
      });

      await prisma.specialty.upsert({
        where: { name: specialtyName },
        create: { name: specialtyName },
        update: {},
      });
    }

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'SPECIALTY_ADDED_TO_HOSPITAL',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ specialtyName }),
      },
    });

    return { success: true, specialties: current };
  }

  static async removeHospitalSpecialty(
    hospitalId: string,
    specialtyName: string,
    actor: AuthUser,
    correlationId?: string
  ) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'remove specialty');
    this.assertCanConfigureHospital(actor, hospitalId, 'remove specialty');

    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
    });
    if (!hospital) {
      throw new Error(`Hospital ${hospitalId} not found`);
    }

    const current: string[] = JSON.parse(hospital.specialtiesJson || '[]');
    const updated = current.filter((s) => s !== specialtyName);

    await prisma.hospital.update({
      where: { id: hospitalId },
      data: { specialtiesJson: JSON.stringify(updated) },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'SPECIALTY_REMOVED_FROM_HOSPITAL',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ specialtyName }),
      },
    });

    return { success: true, specialties: updated };
  }

  // ---------------------------------------------------------------------------
  // 3. Doctor Roster & Lifecycle State Machine (PRD Section 6)
  // ---------------------------------------------------------------------------

  /**
   * Invites or provisions a doctor under an Approved hospital.
   * Doctor starts in INVITED status by default (or requested status).
   * Automatically initializes a primary Calendar for availability management.
   */
  static async inviteDoctor(hospitalId: string, input: InviteDoctorInput, actor: AuthUser, correlationId?: string) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'invite doctors');
    this.assertCanConfigureHospital(actor, hospitalId, 'invite doctors');

    const traceId = correlationId || crypto.randomUUID();

    // Check email uniqueness
    const existingUser = await prisma.user.findUnique({ where: { email: input.email } });
    if (existingUser) {
      throw new Error(`User with email "${input.email}" already exists`);
    }

    const passwordHash = await bcrypt.hash(input.password || 'TemporaryDoctorPassword123!', 10);
    const initialStatus = input.initialStatus || DoctorStatus.INVITED;

    // 1. Create User account for Doctor
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role: UserRole.DOCTOR,
        hospitalId,
      },
    });

    // 2. Create Doctor profile
    const doctor = await prisma.doctor.create({
      data: {
        userId: user.id,
        hospitalId,
        departmentId: input.departmentId,
        specialtyId: input.specialtyId,
        name: input.name,
        specialty: input.specialty || 'General Practice',
        department: input.department || 'Outpatient Clinic',
        qualifications: input.qualifications || 'MBBS, MD',
        experienceYears: input.experienceYears ?? 5,
        languagesJson: JSON.stringify(input.languages || ['English']),
        consultationTypesJson: JSON.stringify(input.consultationTypes || ['In-Person', 'Telehealth']),
        appointmentDurationMinutes: input.appointmentDurationMinutes ?? 30,
        status: initialStatus,
        photoUrl: input.photoUrl,
        externalProviderId: input.externalProviderId,
      },
    });

    // 3. Initialize default active Calendar
    const calendar = await prisma.calendar.create({
      data: {
        doctorId: doctor.id,
        hospitalId,
        name: `${doctor.name} Primary Calendar`,
        isActive: true,
      },
    });

    // If provisioned directly with ACTIVE status, initialize default working hours to ensure validity
    if (initialStatus === DoctorStatus.ACTIVE) {
      await prisma.workingHour.create({
        data: {
          calendarId: calendar.id,
          hospitalId,
          dayOfWeek: 1, // Monday
          startTime: '09:00',
          endTime: '17:00',
        },
      });
    }

    // 4. Audit event
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DOCTOR_INVITED',
        entityType: 'DOCTOR',
        entityId: doctor.id,
        detailsJson: JSON.stringify({
          doctorName: doctor.name,
          email: input.email,
          status: initialStatus,
          calendarId: calendar.id,
        }),
      },
    });

    logger.info({ doctorId: doctor.id, hospitalId, status: initialStatus }, 'Doctor invited successfully');

    return {
      doctor: {
        ...doctor,
        languages: input.languages || ['English'],
        consultationTypes: input.consultationTypes || ['In-Person', 'Telehealth'],
      },
      calendar,
    };
  }

  /**
   * Updates doctor configuration: qualifications, experience, languages,
   * consultation types (appointment types), duration, department, etc.
   */
  static async updateDoctorProfile(
    hospitalId: string,
    doctorId: string,
    input: UpdateDoctorProfileInput,
    actor: AuthUser,
    correlationId?: string
  ) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'update doctor configuration');
    this.assertCanConfigureHospital(actor, hospitalId, 'update doctor configuration');

    const doctor = await prisma.doctor.findFirst({
      where: { id: doctorId, hospitalId },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found in hospital ${hospitalId}`);
    }

    const updated = await prisma.doctor.update({
      where: { id: doctorId },
      data: {
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.specialtyId !== undefined ? { specialtyId: input.specialtyId } : {}),
        ...(input.department ? { department: input.department } : {}),
        ...(input.specialty ? { specialty: input.specialty } : {}),
        ...(input.qualifications ? { qualifications: input.qualifications } : {}),
        ...(input.experienceYears !== undefined ? { experienceYears: input.experienceYears } : {}),
        ...(input.languages ? { languagesJson: JSON.stringify(input.languages) } : {}),
        ...(input.consultationTypes ? { consultationTypesJson: JSON.stringify(input.consultationTypes) } : {}),
        ...(input.appointmentDurationMinutes !== undefined ? { appointmentDurationMinutes: input.appointmentDurationMinutes } : {}),
        ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
        ...(input.externalProviderId !== undefined ? { externalProviderId: input.externalProviderId } : {}),
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DOCTOR_PROFILE_UPDATED',
        entityType: 'DOCTOR',
        entityId: doctorId,
        detailsJson: JSON.stringify(input),
      },
    });

    return {
      ...updated,
      languages: JSON.parse(updated.languagesJson || '[]'),
      consultationTypes: JSON.parse(updated.consultationTypesJson || '[]'),
    };
  }

  /**
   * Deletes a doctor from a hospital roster.
   */
  static async deleteDoctor(
    hospitalId: string,
    doctorId: string,
    actor: AuthUser,
    correlationId?: string
  ) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'delete doctor');
    this.assertCanConfigureHospital(actor, hospitalId, 'delete doctor');

    const doctor = await prisma.doctor.findFirst({
      where: { id: doctorId, hospitalId },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found in hospital ${hospitalId}`);
    }

    await prisma.user.delete({ where: { id: doctor.userId } });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DOCTOR_DELETED',
        entityType: 'DOCTOR',
        entityId: doctorId,
        detailsJson: JSON.stringify({ doctorName: doctor.name }),
      },
    });

    return { success: true, deletedId: doctorId };
  }

  /**
   * Doctor lifecycle state transitions:
   * INVITED -> ACTIVE -> INACTIVE / SUSPENDED -> ACTIVE
   * Only Hospital Admin or Platform Admin can transition doctor status.
   *
   * PRD Section 6 Validation Rule:
   * A doctor CANNOT be activated without a valid active calendar AND at least one configured working hour entry.
   */
  static async transitionDoctorStatus(
    hospitalId: string,
    doctorId: string,
    toStatus: DoctorStatus,
    actor: AuthUser,
    reason?: string,
    correlationId?: string
  ) {
    await HospitalOnboardingService.assertHospitalApproved(hospitalId, 'transition doctor status');
    this.assertCanConfigureHospital(actor, hospitalId, 'transition doctor status');

    const doctor = await prisma.doctor.findFirst({
      where: { id: doctorId, hospitalId },
      include: { user: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found in hospital ${hospitalId}`);
    }

    const currentStatus = doctor.status as DoctorStatus;
    if (currentStatus === toStatus) {
      return doctor;
    }

    // Validate lifecycle transition rules:
    // INVITED -> ACTIVE, INACTIVE
    // ACTIVE -> INACTIVE, SUSPENDED
    // INACTIVE -> ACTIVE
    // SUSPENDED -> ACTIVE
    const validTransitions: Record<DoctorStatus, DoctorStatus[]> = {
      [DoctorStatus.INVITED]: [DoctorStatus.ACTIVE, DoctorStatus.INACTIVE],
      [DoctorStatus.ACTIVE]: [DoctorStatus.INACTIVE, DoctorStatus.SUSPENDED],
      [DoctorStatus.INACTIVE]: [DoctorStatus.ACTIVE],
      [DoctorStatus.SUSPENDED]: [DoctorStatus.ACTIVE],
    };

    const allowed = validTransitions[currentStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw new DoctorLifecycleTransitionError(
        `Invalid doctor lifecycle transition from "${currentStatus}" to "${toStatus}". Allowed: [${allowed.join(', ')}]`
      );
    }

    // PRD Section 6 Mandatory Rule:
    // When activating a doctor (transitioning to ACTIVE), assert valid calendar and configured working hours
    if (toStatus === DoctorStatus.ACTIVE) {
      const calendar = await prisma.calendar.findUnique({
        where: { doctorId },
        include: { workingHours: true },
      });

      if (!calendar || !calendar.isActive) {
        throw new DoctorLifecycleTransitionError(
          `Cannot activate doctor "${doctor.name}": Doctor must have an active calendar before activation.`
        );
      }

      if (!calendar.workingHours || calendar.workingHours.length === 0) {
        throw new DoctorLifecycleTransitionError(
          `Cannot activate doctor "${doctor.name}": Doctor must have at least one configured working hour entry before activation.`
        );
      }
    }

    const updated = await prisma.doctor.update({
      where: { id: doctorId },
      data: { status: toStatus },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DOCTOR_STATUS_TRANSITIONED',
        entityType: 'DOCTOR',
        entityId: doctorId,
        detailsJson: JSON.stringify({
          fromStatus: currentStatus,
          toStatus,
          reason: reason || 'Administrative transition',
        }),
      },
    });

    logger.info(
      { doctorId, hospitalId, from: currentStatus, to: toStatus, actorId: actor.id },
      'Doctor status successfully transitioned'
    );

    return updated;
  }

  // ---------------------------------------------------------------------------
  // 4. Appointment Types Management (PRD Section 6)
  // ---------------------------------------------------------------------------

  static async listHospitalAppointmentTypes(hospitalId: string, actor?: AuthUser) {
    if (actor) {
      this.assertCanConfigureHospital(actor, hospitalId, 'view appointment types');
    }
    const doctors = await prisma.doctor.findMany({
      where: { hospitalId },
      select: { consultationTypesJson: true },
    });

    const typeSet = new Set<string>(['In-Person', 'Telehealth']);
    for (const doc of doctors) {
      const types: string[] = JSON.parse(doc.consultationTypesJson || '[]');
      types.forEach((t) => typeSet.add(t));
    }

    return Array.from(typeSet);
  }

  static async getDoctorAppointmentTypes(doctorId: string, actor?: AuthUser) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true, consultationTypesJson: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    if (actor) {
      await this.assertCanManageDoctorAvailability(actor, doctor, 'view doctor appointment types');
    }

    return JSON.parse(doctor.consultationTypesJson || '[]');
  }

  static async updateDoctorAppointmentTypes(
    doctorId: string,
    appointmentTypes: string[],
    actor: AuthUser,
    correlationId?: string
  ) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'update appointment types');
    this.assertCanConfigureHospital(actor, doctor.hospitalId, 'update doctor appointment types');

    const updated = await prisma.doctor.update({
      where: { id: doctorId },
      data: {
        consultationTypesJson: JSON.stringify(appointmentTypes),
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'DOCTOR_APPOINTMENT_TYPES_UPDATED',
        entityType: 'DOCTOR',
        entityId: doctorId,
        detailsJson: JSON.stringify({ appointmentTypes }),
      },
    });

    return JSON.parse(updated.consultationTypesJson || '[]');
  }

  // ---------------------------------------------------------------------------
  // 5. Calendars, Working Hours & Blocked Periods CRUD (PRD Section 4 & 6)
  // ---------------------------------------------------------------------------

  static async getDoctorCalendar(doctorId: string, actor: AuthUser) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await this.assertCanManageDoctorAvailability(actor, doctor, 'view calendar');

    let calendar = await prisma.calendar.findUnique({
      where: { doctorId },
      include: {
        workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
        blockedSlots: { orderBy: { startTime: 'asc' } },
      },
    });

    if (!calendar) {
      calendar = await prisma.calendar.create({
        data: {
          doctorId,
          hospitalId: doctor.hospitalId,
          name: `${doctor.name} Primary Calendar`,
          isActive: true,
        },
        include: {
          workingHours: true,
          blockedSlots: true,
        },
      });
    }

    return calendar;
  }

  static async updateDoctorCalendar(
    doctorId: string,
    input: { isActive?: boolean; name?: string },
    actor: AuthUser,
    correlationId?: string
  ) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'configure calendar');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'update calendar', correlationId);

    const calendar = await this.getDoctorCalendar(doctorId, actor);

    const updated = await prisma.calendar.update({
      where: { id: calendar.id },
      data: {
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.name ? { name: input.name } : {}),
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CALENDAR_UPDATED',
        entityType: 'CALENDAR',
        entityId: calendar.id,
        detailsJson: JSON.stringify({ doctorId, ...input }),
      },
    });

    return updated;
  }

  /**
   * Adds working hours to a doctor's calendar.
   * Can be configured by Hospital Admin OR the Doctor themselves.
   */
  static async addWorkingHour(doctorId: string, input: WorkingHourInput, actor: AuthUser, correlationId?: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'configure doctor working hours');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'add working hours', correlationId);

    if (input.dayOfWeek < 0 || input.dayOfWeek > 6) {
      throw new Error(`Invalid dayOfWeek ${input.dayOfWeek}. Must be between 0 (Sunday) and 6 (Saturday).`);
    }

    if (input.startTime >= input.endTime) {
      throw new Error(`startTime "${input.startTime}" must be strictly earlier than endTime "${input.endTime}"`);
    }

    const calendar = await this.getDoctorCalendar(doctorId, actor);

    const workingHour = await prisma.workingHour.create({
      data: {
        calendarId: calendar.id,
        hospitalId: doctor.hospitalId,
        dayOfWeek: input.dayOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'WORKING_HOURS_ADDED',
        entityType: 'WORKING_HOUR',
        entityId: workingHour.id,
        detailsJson: JSON.stringify({ doctorId, ...input }),
      },
    });

    return workingHour;
  }

  static async listWorkingHours(doctorId: string, actor: AuthUser) {
    const calendar = await this.getDoctorCalendar(doctorId, actor);
    return prisma.workingHour.findMany({
      where: { calendarId: calendar.id },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  static async updateWorkingHour(
    doctorId: string,
    workingHourId: string,
    input: Partial<WorkingHourInput>,
    actor: AuthUser,
    correlationId?: string
  ) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'modify doctor working hours');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'update working hours', correlationId);

    const wh = await prisma.workingHour.findUnique({ where: { id: workingHourId } });
    if (!wh) {
      throw new Error(`Working hour ${workingHourId} not found`);
    }

    if (input.startTime && input.endTime && input.startTime >= input.endTime) {
      throw new Error(`startTime "${input.startTime}" must be strictly earlier than endTime "${input.endTime}"`);
    }

    const updated = await prisma.workingHour.update({
      where: { id: workingHourId },
      data: {
        ...(input.dayOfWeek !== undefined ? { dayOfWeek: input.dayOfWeek } : {}),
        ...(input.startTime ? { startTime: input.startTime } : {}),
        ...(input.endTime ? { endTime: input.endTime } : {}),
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'WORKING_HOURS_UPDATED',
        entityType: 'WORKING_HOUR',
        entityId: workingHourId,
        detailsJson: JSON.stringify({ doctorId, ...input }),
      },
    });

    return updated;
  }

  static async deleteWorkingHour(doctorId: string, workingHourId: string, actor: AuthUser, correlationId?: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'modify doctor working hours');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'delete working hours', correlationId);

    const wh = await prisma.workingHour.findUnique({ where: { id: workingHourId } });
    if (!wh) {
      throw new Error(`Working hour ${workingHourId} not found`);
    }

    await prisma.workingHour.delete({ where: { id: workingHourId } });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'WORKING_HOURS_DELETED',
        entityType: 'WORKING_HOUR',
        entityId: workingHourId,
        detailsJson: JSON.stringify({ doctorId }),
      },
    });

    return { success: true, deletedId: workingHourId };
  }

  /**
   * Adds a blocked period (leave, vacation, surgery) for a doctor.
   * Can be configured by Hospital Admin OR the Doctor themselves.
   */
  static async addBlockedPeriod(doctorId: string, input: BlockedPeriodInput, actor: AuthUser, correlationId?: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'configure blocked periods');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'add blocked period', correlationId);

    const start = new Date(input.startTime);
    const end = new Date(input.endTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date format for blocked period');
    }

    if (start >= end) {
      throw new Error(`Blocked start time "${input.startTime}" must be strictly earlier than end time "${input.endTime}"`);
    }

    const calendar = await this.getDoctorCalendar(doctorId, actor);

    const blockedSlot = await prisma.blockedSlot.create({
      data: {
        calendarId: calendar.id,
        hospitalId: doctor.hospitalId,
        startTime: start,
        endTime: end,
        reason: input.reason || 'Unavailable',
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'BLOCKED_PERIOD_ADDED',
        entityType: 'BLOCKED_SLOT',
        entityId: blockedSlot.id,
        detailsJson: JSON.stringify({
          doctorId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          reason: input.reason,
        }),
      },
    });

    return blockedSlot;
  }

  static async listBlockedPeriods(doctorId: string, actor: AuthUser) {
    const calendar = await this.getDoctorCalendar(doctorId, actor);
    return prisma.blockedSlot.findMany({
      where: { calendarId: calendar.id },
      orderBy: { startTime: 'asc' },
    });
  }

  static async updateBlockedPeriod(
    doctorId: string,
    blockedSlotId: string,
    input: Partial<BlockedPeriodInput>,
    actor: AuthUser,
    correlationId?: string
  ) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'modify blocked periods');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'update blocked period', correlationId);

    const bs = await prisma.blockedSlot.findUnique({ where: { id: blockedSlotId } });
    if (!bs) {
      throw new Error(`Blocked slot ${blockedSlotId} not found`);
    }

    const start = input.startTime ? new Date(input.startTime) : bs.startTime;
    const end = input.endTime ? new Date(input.endTime) : bs.endTime;

    if (start >= end) {
      throw new Error('Blocked start time must be strictly earlier than end time');
    }

    const updated = await prisma.blockedSlot.update({
      where: { id: blockedSlotId },
      data: {
        startTime: start,
        endTime: end,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'BLOCKED_PERIOD_UPDATED',
        entityType: 'BLOCKED_SLOT',
        entityId: blockedSlotId,
        detailsJson: JSON.stringify({ doctorId, ...input }),
      },
    });

    return updated;
  }

  static async deleteBlockedPeriod(doctorId: string, blockedSlotId: string, actor: AuthUser, correlationId?: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, userId: true, hospitalId: true, name: true },
    });
    if (!doctor) {
      throw new Error(`Doctor ${doctorId} not found`);
    }

    await HospitalOnboardingService.assertHospitalApproved(doctor.hospitalId, 'modify blocked periods');
    await this.assertCanManageDoctorAvailability(actor, doctor, 'delete blocked period', correlationId);

    const bs = await prisma.blockedSlot.findUnique({ where: { id: blockedSlotId } });
    if (!bs) {
      throw new Error(`Blocked slot ${blockedSlotId} not found`);
    }

    await prisma.blockedSlot.delete({ where: { id: blockedSlotId } });

    const traceId = correlationId || crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: doctor.hospitalId,
        tenantId: doctor.hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'BLOCKED_PERIOD_DELETED',
        entityType: 'BLOCKED_SLOT',
        entityId: blockedSlotId,
        detailsJson: JSON.stringify({ doctorId }),
      },
    });

    return { success: true, deletedId: blockedSlotId };
  }

  // ---------------------------------------------------------------------------
  // 6. Config-Time Operational Rule Validation (PRD Section 6)
  // ---------------------------------------------------------------------------

  /**
   * Enforces: ONLY ACTIVE doctors with valid availability can receive appointments.
   * Asserts config-time validity:
   * 1. Hospital is APPROVED.
   * 2. Doctor exists and is ACTIVE (not INVITED, INACTIVE, or SUSPENDED).
   * 3. Doctor has an active Calendar.
   * 4. Doctor has at least one WorkingHour entry configured.
   *
   * Throws DoctorNotReadyForAppointmentsError if any check fails.
   */
  static async assertDoctorReadyForAppointments(doctorId: string, expectedHospitalId?: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: {
        hospital: { select: { id: true, name: true, status: true } },
        calendar: {
          include: {
            workingHours: true,
            blockedSlots: true,
          },
        },
      },
    });

    if (!doctor) {
      throw new DoctorNotReadyForAppointmentsError(`Doctor "${doctorId}" does not exist`);
    }

    // 1. Hospital Tenant match
    if (expectedHospitalId && doctor.hospitalId !== expectedHospitalId) {
      throw new DoctorNotReadyForAppointmentsError(
        `Doctor "${doctor.name}" belongs to hospital ${doctor.hospitalId}, not expected hospital ${expectedHospitalId}`
      );
    }

    // 2. Hospital Approval
    if (doctor.hospital.status !== HospitalStatus.APPROVED) {
      throw new DoctorNotReadyForAppointmentsError(
        `Cannot receive appointments: Hospital "${doctor.hospital.name}" is in status "${doctor.hospital.status}". Only APPROVED hospitals can offer appointments.`
      );
    }

    // 3. Doctor Active Status
    if (doctor.status !== DoctorStatus.ACTIVE) {
      throw new DoctorNotReadyForAppointmentsError(
        `Cannot receive appointments: Doctor "${doctor.name}" is in status "${doctor.status}". Only ACTIVE doctors can receive appointments.`
      );
    }

    // 4. Calendar Existence & Activation
    if (!doctor.calendar || !doctor.calendar.isActive) {
      throw new DoctorNotReadyForAppointmentsError(
        `Cannot receive appointments: Doctor "${doctor.name}" does not have an active calendar configured.`
      );
    }

    // 5. Valid Availability (Working Hours) Configured
    if (!doctor.calendar.workingHours || doctor.calendar.workingHours.length === 0) {
      throw new DoctorNotReadyForAppointmentsError(
        `Cannot receive appointments: Doctor "${doctor.name}" has no working hours configured. Doctors must have at least one working schedule to receive appointments.`
      );
    }

    return doctor;
  }
}
