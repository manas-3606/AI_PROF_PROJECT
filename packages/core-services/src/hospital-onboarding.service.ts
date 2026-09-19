import { prisma } from '@health/db';
import { AuthUser, HospitalStatus, UserRole } from '@health/shared-types';
import { logger } from '@health/observability';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

export interface RegisterHospitalInput {
  name: string;
  slug: string;
  address: string;
  city: string;
  operatingHours: string;
  contactEmail: string;
  contactPhone: string;
  specialties: string[];
  adminUser?: {
    name: string;
    email: string;
    password: string;
  };
}

export class HospitalOnboardingService {
  /**
   * Hospital self-service registration capturing all fields from PRD Section 5.
   * New registrations start in DRAFT status.
   */
  static async registerHospital(input: RegisterHospitalInput, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();

    // Check slug uniqueness
    const existing = await prisma.hospital.findUnique({ where: { slug: input.slug } });
    if (existing) {
      throw new Error(`Hospital slug "${input.slug}" is already registered`);
    }

    // 1. Create Hospital in DRAFT status
    const hospital = await prisma.hospital.create({
      data: {
        name: input.name,
        slug: input.slug,
        status: HospitalStatus.DRAFT,
        address: input.address,
        city: input.city,
        operatingHours: input.operatingHours,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        specialtiesJson: JSON.stringify(input.specialties || []),
      },
    });

    let adminUserRecord = null;

    // 2. Optionally create founding Hospital Admin user
    if (input.adminUser) {
      const passwordHash = await bcrypt.hash(input.adminUser.password, 10);
      adminUserRecord = await prisma.user.create({
        data: {
          email: input.adminUser.email,
          passwordHash,
          name: input.adminUser.name,
          role: UserRole.HOSPITAL_ADMIN,
          hospitalId: hospital.id,
        },
      });
    }

    // 3. Emit Audit Event
    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId: hospital.id,
        tenantId: hospital.id,
        actorId: adminUserRecord?.id || 'SYSTEM_ONBOARDING',
        actorRole: adminUserRecord ? UserRole.HOSPITAL_ADMIN : 'ANONYMOUS',
        action: 'HOSPITAL_REGISTERED_DRAFT',
        entityType: 'HOSPITAL',
        entityId: hospital.id,
        detailsJson: JSON.stringify({
          hospitalName: hospital.name,
          slug: hospital.slug,
          city: hospital.city,
          adminEmail: input.adminUser?.email,
        }),
      },
    });

    logger.info({ hospitalId: hospital.id, traceId }, 'Hospital self-service registered in DRAFT status');

    return {
      hospital: {
        ...hospital,
        specialties: input.specialties,
      },
      adminUser: adminUserRecord
        ? {
            id: adminUserRecord.id,
            email: adminUserRecord.email,
            name: adminUserRecord.name,
            role: adminUserRecord.role,
          }
        : undefined,
    };
  }

  /**
   * Transitions hospital from DRAFT -> SUBMITTED.
   * Can be performed by Hospital Admin (for their hospital) or Platform Admin.
   */
  static async submitForReview(hospitalId: string, actor: AuthUser, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();
    const hospital = await this.getHospitalOrThrow(hospitalId);

    // Tenant authorization check
    if (actor.role === UserRole.HOSPITAL_ADMIN && actor.tenantId !== hospitalId) {
      await this.recordSecurityViolation(
        traceId,
        actor,
        hospitalId,
        'Cross-tenant violation: Hospital Admin attempted to submit another hospital'
      );
      throw new Error(`Forbidden: Hospital Admin cannot submit another hospital for review`);
    }

    if (hospital.status !== HospitalStatus.DRAFT) {
      throw new Error(`Cannot submit hospital in status "${hospital.status}". Only DRAFT hospitals can be submitted.`);
    }

    const updated = await prisma.hospital.update({
      where: { id: hospitalId },
      data: { status: HospitalStatus.SUBMITTED },
    });

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'HOSPITAL_SUBMITTED_FOR_REVIEW',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ from: HospitalStatus.DRAFT, to: HospitalStatus.SUBMITTED }),
      },
    });

    return updated;
  }

  /**
   * Transitions hospital from SUBMITTED -> UNDER_REVIEW.
   * Only PLATFORM_ADMIN can initiate review.
   */
  static async startReview(hospitalId: string, actor: AuthUser, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();
    await this.assertPlatformAdmin(actor, traceId, hospitalId, 'start review on hospital');

    const hospital = await this.getHospitalOrThrow(hospitalId);
    if (hospital.status !== HospitalStatus.SUBMITTED) {
      throw new Error(`Cannot start review on hospital in status "${hospital.status}". Expected SUBMITTED.`);
    }

    const updated = await prisma.hospital.update({
      where: { id: hospitalId },
      data: { status: HospitalStatus.UNDER_REVIEW },
    });

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'HOSPITAL_REVIEW_STARTED',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ from: HospitalStatus.SUBMITTED, to: HospitalStatus.UNDER_REVIEW }),
      },
    });

    return updated;
  }

  /**
   * Approves hospital: transitions SUBMITTED or UNDER_REVIEW -> APPROVED.
   * ONLY Platform Admin can approve.
   */
  static async approveHospital(hospitalId: string, actor: AuthUser, notes?: string, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();
    await this.assertPlatformAdmin(actor, traceId, hospitalId, 'approve hospital');

    const hospital = await this.getHospitalOrThrow(hospitalId);
    if (hospital.status !== HospitalStatus.SUBMITTED && hospital.status !== HospitalStatus.UNDER_REVIEW) {
      throw new Error(
        `Cannot approve hospital in status "${hospital.status}". Hospital must be SUBMITTED or UNDER_REVIEW.`
      );
    }

    const updated = await prisma.hospital.update({
      where: { id: hospitalId },
      data: { status: HospitalStatus.APPROVED },
    });

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'HOSPITAL_APPROVED',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ from: hospital.status, to: HospitalStatus.APPROVED, notes }),
      },
    });

    logger.info({ hospitalId, traceId }, 'Hospital successfully APPROVED by Platform Admin');
    return updated;
  }

  /**
   * Rejects hospital: transitions SUBMITTED or UNDER_REVIEW -> REJECTED.
   * ONLY Platform Admin can reject.
   */
  static async rejectHospital(hospitalId: string, actor: AuthUser, reason: string, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();
    await this.assertPlatformAdmin(actor, traceId, hospitalId, 'reject hospital');

    const hospital = await this.getHospitalOrThrow(hospitalId);
    if (hospital.status !== HospitalStatus.SUBMITTED && hospital.status !== HospitalStatus.UNDER_REVIEW) {
      throw new Error(
        `Cannot reject hospital in status "${hospital.status}". Hospital must be SUBMITTED or UNDER_REVIEW.`
      );
    }

    const updated = await prisma.hospital.update({
      where: { id: hospitalId },
      data: { status: HospitalStatus.REJECTED },
    });

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'HOSPITAL_REJECTED',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ from: hospital.status, to: HospitalStatus.REJECTED, reason }),
      },
    });

    return updated;
  }

  /**
   * Suspends an approved hospital: APPROVED -> SUSPENDED.
   * ONLY Platform Admin can suspend.
   */
  static async suspendHospital(hospitalId: string, actor: AuthUser, reason: string, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();
    await this.assertPlatformAdmin(actor, traceId, hospitalId, 'suspend hospital');

    const hospital = await this.getHospitalOrThrow(hospitalId);
    if (hospital.status !== HospitalStatus.APPROVED) {
      throw new Error(`Cannot suspend hospital in status "${hospital.status}". Only APPROVED hospitals can be suspended.`);
    }

    const updated = await prisma.hospital.update({
      where: { id: hospitalId },
      data: { status: HospitalStatus.SUSPENDED },
    });

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'HOSPITAL_SUSPENDED',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ reason }),
      },
    });

    return updated;
  }

  /**
   * Reactivates a suspended hospital: SUSPENDED -> APPROVED.
   * ONLY Platform Admin can reactivate.
   */
  static async reactivateHospital(hospitalId: string, actor: AuthUser, correlationId?: string) {
    const traceId = correlationId || crypto.randomUUID();
    await this.assertPlatformAdmin(actor, traceId, hospitalId, 'reactivate hospital');

    const hospital = await this.getHospitalOrThrow(hospitalId);
    if (hospital.status !== HospitalStatus.SUSPENDED) {
      throw new Error(`Cannot reactivate hospital in status "${hospital.status}". Only SUSPENDED hospitals can be reactivated.`);
    }

    const updated = await prisma.hospital.update({
      where: { id: hospitalId },
      data: { status: HospitalStatus.APPROVED },
    });

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'HOSPITAL_REACTIVATED',
        entityType: 'HOSPITAL',
        entityId: hospitalId,
        detailsJson: JSON.stringify({ from: HospitalStatus.SUSPENDED, to: HospitalStatus.APPROVED }),
      },
    });

    return updated;
  }

  /**
   * Operational Gatekeeper:
   * Enforces that ONLY APPROVED hospitals can:
   * 1. Create active doctors
   * 2. Publish availability / create slots
   * 3. Receive appointments
   * 4. Enable production integrations
   */
  static async assertHospitalApproved(hospitalId: string, operationDescription: string): Promise<void> {
    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { id: true, name: true, status: true },
    });

    if (!hospital) {
      throw new Error(`Hospital ${hospitalId} not found`);
    }

    if (hospital.status !== HospitalStatus.APPROVED) {
      throw new Error(
        `Hospital "${hospital.name}" (${hospital.id}) is in "${hospital.status}" status and cannot ${operationDescription}. Only APPROVED hospitals can create active doctors, publish availability, receive appointments, or enable production integrations.`
      );
    }
  }

  /**
   * Creates an active doctor, strictly gated by hospital approval status.
   */
  static async createDoctor(
    hospitalId: string,
    doctorInput: {
      name: string;
      email: string;
      specialty: string;
      department: string;
      qualifications: string;
      experienceYears?: number;
      appointmentDurationMinutes?: number;
    },
    correlationId?: string
  ) {
    await this.assertHospitalApproved(hospitalId, 'create active doctors');

    const traceId = correlationId || crypto.randomUUID();
    const passwordHash = await bcrypt.hash('DoctorSecurePassword123!', 10);

    const user = await prisma.user.create({
      data: {
        email: doctorInput.email,
        passwordHash,
        name: doctorInput.name,
        role: UserRole.DOCTOR,
        hospitalId,
      },
    });

    const doctor = await prisma.doctor.create({
      data: {
        userId: user.id,
        hospitalId,
        name: doctorInput.name,
        specialty: doctorInput.specialty,
        department: doctorInput.department,
        qualifications: doctorInput.qualifications,
        experienceYears: doctorInput.experienceYears || 5,
        appointmentDurationMinutes: doctorInput.appointmentDurationMinutes || 30,
        status: 'ACTIVE',
      },
    });

    // Initialize active calendar and default working hours so doctor has valid availability
    const calendar = await prisma.calendar.create({
      data: {
        doctorId: doctor.id,
        hospitalId,
        name: `${doctor.name} Primary Calendar`,
        isActive: true,
      },
    });

    for (let day = 1; day <= 5; day++) {
      await prisma.workingHour.create({
        data: {
          calendarId: calendar.id,
          hospitalId,
          dayOfWeek: day,
          startTime: '09:00',
          endTime: '17:00',
        },
      });
    }

    await prisma.auditEvent.create({
      data: {
        correlationId: traceId,
        hospitalId,
        tenantId: hospitalId,
        actorId: user.id,
        actorRole: UserRole.DOCTOR,
        action: 'DOCTOR_CREATED_ACTIVE',
        entityType: 'DOCTOR',
        entityId: doctor.id,
      },
    });

    return doctor;
  }

  /**
   * Publishes availability / creates slots, strictly gated by hospital approval status.
   */
  static async publishAvailability(
    hospitalId: string,
    doctorId: string,
    slotTimes: Array<{ startTime: Date; endTime: Date }>,
    correlationId?: string
  ) {
    await this.assertHospitalApproved(hospitalId, 'publish availability');

    const slots = [];
    for (const st of slotTimes) {
      const slot = await prisma.slot.create({
        data: {
          doctorId,
          hospitalId,
          startTime: st.startTime,
          endTime: st.endTime,
          isBooked: false,
          isBlocked: false,
        },
      });
      slots.push(slot);
    }
    return slots;
  }

  /**
   * Enables a production EHR connection, strictly gated by hospital approval status.
   */
  static async enableIntegration(
    hospitalId: string,
    connectionConfig: { systemType: string; baseUrl: string; config?: Record<string, any> },
    correlationId?: string
  ) {
    await this.assertHospitalApproved(hospitalId, 'enable production integrations');

    const connection = await prisma.healthcareSystemConnection.create({
      data: {
        hospitalId,
        systemType: connectionConfig.systemType || 'MOCK_EHR',
        baseUrl: connectionConfig.baseUrl,
        status: 'ACTIVE',
        configJson: JSON.stringify(connectionConfig.config || {}),
      },
    });

    return connection;
  }

  private static async getHospitalOrThrow(hospitalId: string) {
    const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });
    if (!hospital) {
      throw new Error(`Hospital with ID "${hospitalId}" not found`);
    }
    return hospital;
  }

  private static async assertPlatformAdmin(actor: AuthUser, correlationId: string, hospitalId: string, action: string) {
    if (actor.role !== UserRole.PLATFORM_ADMIN) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId,
          tenantId: hospitalId,
          actorId: actor.id,
          actorRole: actor.role,
          action: 'RBAC_SECURITY_VIOLATION',
          entityType: 'HOSPITAL',
          entityId: hospitalId,
          detailsJson: JSON.stringify({
            requiredRole: UserRole.PLATFORM_ADMIN,
            actualRole: actor.role,
            attemptedAction: action,
          }),
        },
      }).catch(() => {});

      throw new Error(`Forbidden: Only PLATFORM_ADMIN can ${action}. Current role: ${actor.role}`);
    }
  }

  private static async recordSecurityViolation(
    correlationId: string,
    actor: AuthUser,
    targetHospitalId: string,
    message: string
  ) {
    await prisma.auditEvent.create({
      data: {
        correlationId,
        hospitalId: targetHospitalId,
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        entityType: 'HOSPITAL',
        entityId: targetHospitalId,
        detailsJson: JSON.stringify({
          actorTenantId: actor.tenantId,
          targetHospitalId,
          message,
        }),
      },
    });
  }
}
