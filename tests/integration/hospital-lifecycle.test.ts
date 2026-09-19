import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { HospitalOnboardingService, AuthService } from '@health/core-services';
import { SchedulingService } from '@health/scheduling';
import { HospitalStatus, UserRole, AuthUser } from '@health/shared-types';
import crypto from 'node:crypto';

describe('Integration Test: Hospital Onboarding & Approval Lifecycle (PRD Section 5)', () => {
  let platformAdmin: AuthUser;
  let hospitalAdminUser: any;
  let testHospitalId: string;
  let draftHospitalSlug: string;

  before(async () => {
    // 1. Fetch or create Platform Admin
    let admin = await prisma.user.findFirst({ where: { role: UserRole.PLATFORM_ADMIN } });
    if (!admin) {
      admin = await prisma.user.create({
        data: {
          email: 'platform.admin@platform.health',
          passwordHash: 'dummy',
          name: 'Platform Super Admin',
          role: UserRole.PLATFORM_ADMIN,
        },
      });
    }
    platformAdmin = {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: UserRole.PLATFORM_ADMIN,
    };
  });

  it('registers a hospital through self-service capturing PRD Section 5 fields in DRAFT status', async () => {
    draftHospitalSlug = `st-jude-memorial-${Date.now()}`;
    const registration = await HospitalOnboardingService.registerHospital({
      name: 'St. Jude Memorial Hospital',
      slug: draftHospitalSlug,
      address: '500 Medical Center Parkway',
      city: 'Riverdale',
      operatingHours: 'Mon-Sun: 24 Hours Emergency, Clinics Mon-Fri 08:00 - 17:00',
      contactEmail: 'admin@stjudehealth.org',
      contactPhone: '+1-555-0399',
      specialties: ['Cardiology', 'Pediatrics', 'Oncology'],
      adminUser: {
        name: 'Dr. Sarah Connor',
        email: `admin.${Date.now()}@stjudehealth.org`,
        password: 'AdminSecurePassword123!',
      },
    });

    assert.ok(registration.hospital.id, 'Hospital ID must be generated');
    assert.strictEqual(registration.hospital.status, HospitalStatus.DRAFT, 'New hospital must start in DRAFT status');
    assert.strictEqual(registration.hospital.city, 'Riverdale');
    assert.ok(registration.adminUser, 'Admin user must be created');
    assert.strictEqual(registration.adminUser.role, UserRole.HOSPITAL_ADMIN);

    testHospitalId = registration.hospital.id;
    hospitalAdminUser = registration.adminUser;
  });

  describe('Operational Readiness Gates for DRAFT-status Hospital', () => {
    it('enforces: DRAFT hospital CANNOT create active doctors', async () => {
      await assert.rejects(
        async () => {
          await HospitalOnboardingService.createDoctor(testHospitalId, {
            name: 'Dr. Alan Grant',
            email: `alan.grant.${Date.now()}@stjudehealth.org`,
            specialty: 'Pediatrics',
            department: 'Pediatric Care',
            qualifications: 'MD, Board Certified',
          });
        },
        /cannot create active doctors.*Only APPROVED hospitals/,
        'Must reject creating active doctor for DRAFT hospital'
      );
    });

    it('enforces: DRAFT hospital CANNOT publish availability / create slots', async () => {
      await assert.rejects(
        async () => {
          await HospitalOnboardingService.publishAvailability(testHospitalId, 'dummy-doc-id', [
            { startTime: new Date(), endTime: new Date(Date.now() + 1800000) },
          ]);
        },
        /cannot publish availability.*Only APPROVED hospitals/,
        'Must reject publishing availability for DRAFT hospital'
      );
    });

    it('enforces: DRAFT hospital CANNOT receive appointments', async () => {
      // Create a patient to test appointment booking
      const patient = await prisma.patient.findFirst();
      assert.ok(patient, 'Patient must exist in test database');

      await assert.rejects(
        async () => {
          await SchedulingService.bookAppointment({
            hospitalId: testHospitalId,
            doctorId: 'dummy-doc-id',
            patientId: patient.id,
            slotId: 'dummy-slot-id',
            idempotencyKey: crypto.randomUUID(),
          });
        },
        /cannot receive appointments.*Only APPROVED hospitals/,
        'Must reject appointment booking for DRAFT hospital'
      );
    });

    it('enforces: DRAFT hospital CANNOT enable production integrations', async () => {
      await assert.rejects(
        async () => {
          await HospitalOnboardingService.enableIntegration(testHospitalId, {
            systemType: 'EPIC_FHIR',
            baseUrl: 'https://epic.stjudehealth.org/fhir/r4',
          });
        },
        /cannot enable production integrations.*Only APPROVED hospitals/,
        'Must reject enabling integrations for DRAFT hospital'
      );
    });
  });

  describe('Lifecycle State Transitions: DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED -> SUSPENDED -> REACTIVATED', () => {
    it('Hospital Admin submits DRAFT hospital for review (DRAFT -> SUBMITTED)', async () => {
      const hospitalAdminActor: AuthUser = {
        id: hospitalAdminUser.id,
        email: hospitalAdminUser.email,
        name: hospitalAdminUser.name,
        role: UserRole.HOSPITAL_ADMIN,
        tenantId: testHospitalId,
      };

      const submitted = await HospitalOnboardingService.submitForReview(testHospitalId, hospitalAdminActor);
      assert.strictEqual(submitted.status, HospitalStatus.SUBMITTED);
    });

    it('rejects Non-Platform-Admin attempting to approve hospital (RBAC enforcement + Audit)', async () => {
      const hospitalAdminActor: AuthUser = {
        id: hospitalAdminUser.id,
        email: hospitalAdminUser.email,
        name: hospitalAdminUser.name,
        role: UserRole.HOSPITAL_ADMIN,
        tenantId: testHospitalId,
      };

      await assert.rejects(
        async () => {
          await HospitalOnboardingService.approveHospital(testHospitalId, hospitalAdminActor);
        },
        /Forbidden: Only PLATFORM_ADMIN can approve hospital/,
        'Non-Platform Admin cannot approve hospitals'
      );

      // Verify audit event was logged
      const audit = await prisma.auditEvent.findFirst({
        where: {
          action: 'RBAC_SECURITY_VIOLATION',
          hospitalId: testHospitalId,
        },
        orderBy: { timestamp: 'desc' },
      });
      assert.ok(audit, 'Security violation audit event must be recorded');
    });

    it('Platform Admin transitions hospital to UNDER_REVIEW', async () => {
      const underReview = await HospitalOnboardingService.startReview(testHospitalId, platformAdmin);
      assert.strictEqual(underReview.status, HospitalStatus.UNDER_REVIEW);
    });

    it('Platform Admin approves hospital (UNDER_REVIEW -> APPROVED)', async () => {
      const approved = await HospitalOnboardingService.approveHospital(
        testHospitalId,
        platformAdmin,
        'Credentials, clinical governance, and facility verified'
      );
      assert.strictEqual(approved.status, HospitalStatus.APPROVED);

      // Verify approval audit event
      const audit = await prisma.auditEvent.findFirst({
        where: { action: 'HOSPITAL_APPROVED', hospitalId: testHospitalId },
      });
      assert.ok(audit, 'Hospital approval audit event must be logged');
    });

    it('once APPROVED, hospital CAN successfully create active doctors, publish slots, and enable integrations', async () => {
      // 1. Create doctor
      const doctor = await HospitalOnboardingService.createDoctor(testHospitalId, {
        name: 'Dr. Ellie Sattler',
        email: `ellie.sattler.${Date.now()}@stjudehealth.org`,
        specialty: 'Cardiology',
        department: 'Cardiology Department',
        qualifications: 'MD, FACC',
        experienceYears: 10,
        appointmentDurationMinutes: 30,
      });
      assert.ok(doctor.id, 'Doctor must be created');
      assert.strictEqual(doctor.status, 'ACTIVE');

      // 2. Publish slots (within standard Monday-Friday working hours)
      const startTime = new Date();
      const day = startTime.getDay();
      const diff = (1 - day + 7) % 7 || 7;
      startTime.setDate(startTime.getDate() + diff);
      startTime.setHours(10, 0, 0, 0);
      const endTime = new Date(startTime.getTime() + 1800000);
      const slots = await HospitalOnboardingService.publishAvailability(testHospitalId, doctor.id, [
        { startTime, endTime },
      ]);
      assert.strictEqual(slots.length, 1);
      assert.strictEqual(slots[0].isBooked, false);

      // 3. Receive appointment
      const patient = await prisma.patient.findFirst();
      assert.ok(patient, 'Patient must exist');

      const appt = await SchedulingService.bookAppointment({
        hospitalId: testHospitalId,
        doctorId: doctor.id,
        patientId: patient.id,
        slotId: slots[0].id,
        reason: 'Cardiology post-approval test consult',
      });
      assert.ok(appt.id);
      assert.strictEqual(appt.status, 'Pending');

      // 4. Enable integration
      const conn = await HospitalOnboardingService.enableIntegration(testHospitalId, {
        systemType: 'MOCK_EHR',
        baseUrl: 'http://localhost:4000',
      });
      assert.ok(conn.id);
      assert.strictEqual(conn.status, 'ACTIVE');
    });

    it('Platform Admin can suspend an approved hospital, and then reactivate it', async () => {
      // Suspend
      const suspended = await HospitalOnboardingService.suspendHospital(
        testHospitalId,
        platformAdmin,
        'Annual audit pending'
      );
      assert.strictEqual(suspended.status, HospitalStatus.SUSPENDED);

      // Gating verification: while SUSPENDED, cannot receive appointments
      const patient = await prisma.patient.findFirst();
      await assert.rejects(
        async () => {
          await SchedulingService.bookAppointment({
            hospitalId: testHospitalId,
            doctorId: 'some-doc',
            patientId: patient!.id,
            slotId: 'some-slot',
          });
        },
        /cannot receive appointments.*Only APPROVED hospitals/,
        'Suspended hospital cannot receive appointments'
      );

      // Reactivate
      const reactivated = await HospitalOnboardingService.reactivateHospital(testHospitalId, platformAdmin);
      assert.strictEqual(reactivated.status, HospitalStatus.APPROVED);
    });

    after(async () => {
      if (testHospitalId) {
        await prisma.appointment.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.slot.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.workingHour.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.calendar.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.doctor.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.department.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.healthcareSystemConnection.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.auditEvent.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.user.deleteMany({ where: { hospitalId: testHospitalId } });
        await prisma.hospital.deleteMany({ where: { id: testHospitalId } });
      }
    });
  });
});
