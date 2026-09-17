import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import {
  HospitalDoctorConfigService,
  HospitalOnboardingService,
  DoctorNotReadyForAppointmentsError,
  DoctorConfigUnauthorizedError,
  DoctorLifecycleTransitionError,
} from '@health/core-services';
import { SchedulingService } from '@health/scheduling';
import { AuthUser, DoctorStatus, HospitalStatus, UserRole } from '@health/shared-types';
import crypto from 'node:crypto';

describe('Unit Test: Hospital & Doctor Configuration (PRD Section 6) & Role Model', () => {
  let approvedHospitalId: string;
  let draftHospitalId: string;
  let otherHospitalId: string;

  let platformAdmin: AuthUser;
  let hospitalAdminA: AuthUser;
  let hospitalAdminB: AuthUser;
  let doctorUserA: AuthUser;
  let doctorUserB: AuthUser;

  let doctorAId: string;
  let doctorBId: string;

  before(async () => {
    // 1. Create an Approved Hospital A
    const hospA = await prisma.hospital.create({
      data: {
        name: 'St. Jude Test Medical Center',
        slug: `st-jude-${crypto.randomUUID().slice(0, 8)}`,
        status: HospitalStatus.APPROVED,
        address: '100 Medical Blvd',
        city: 'Metropolis',
        operatingHours: 'Mon-Sun 24/7',
        contactEmail: 'admin@stjude-test.org',
        contactPhone: '+1-555-100-2000',
        specialtiesJson: JSON.stringify(['Cardiology', 'Neurology']),
      },
    });
    approvedHospitalId = hospA.id;

    // 2. Create a DRAFT Hospital for scoping validation
    const hospDraft = await prisma.hospital.create({
      data: {
        name: 'Draft Clinic Healthcare',
        slug: `draft-clinic-${crypto.randomUUID().slice(0, 8)}`,
        status: HospitalStatus.DRAFT,
        address: '500 Draft Way',
        city: 'Draftville',
        operatingHours: 'Mon-Fri 09:00-17:00',
        contactEmail: 'admin@draftclinic.org',
        contactPhone: '+1-555-999-0000',
      },
    });
    draftHospitalId = hospDraft.id;

    // 3. Create a second Approved Hospital B for tenant isolation
    const hospB = await prisma.hospital.create({
      data: {
        name: 'Metro City General Hospital',
        slug: `metro-city-${crypto.randomUUID().slice(0, 8)}`,
        status: HospitalStatus.APPROVED,
        address: '200 Downtown Way',
        city: 'Metro City',
        operatingHours: 'Mon-Sun 24/7',
        contactEmail: 'admin@metrocity-test.org',
        contactPhone: '+1-555-300-4000',
      },
    });
    otherHospitalId = hospB.id;

    // 4. Setup Actors with real User DB records for Foreign Key compliance
    const platUser = await prisma.user.create({
      data: {
        email: `platform-${Date.now()}@system.local`,
        passwordHash: 'dummy',
        name: 'Platform Admin',
        role: UserRole.PLATFORM_ADMIN,
      },
    });
    platformAdmin = {
      id: platUser.id,
      role: UserRole.PLATFORM_ADMIN,
      email: platUser.email,
    };

    const adminAUser = await prisma.user.create({
      data: {
        email: `adminA-${Date.now()}@stjude.org`,
        passwordHash: 'dummy',
        name: 'St Jude Admin',
        role: UserRole.HOSPITAL_ADMIN,
        hospitalId: approvedHospitalId,
      },
    });
    hospitalAdminA = {
      id: adminAUser.id,
      role: UserRole.HOSPITAL_ADMIN,
      hospitalId: approvedHospitalId,
      tenantId: approvedHospitalId,
      email: adminAUser.email,
    } as any;

    const adminBUser = await prisma.user.create({
      data: {
        email: `adminB-${Date.now()}@metrocity.org`,
        passwordHash: 'dummy',
        name: 'Metro City Admin',
        role: UserRole.HOSPITAL_ADMIN,
        hospitalId: otherHospitalId,
      },
    });
    hospitalAdminB = {
      id: adminBUser.id,
      role: UserRole.HOSPITAL_ADMIN,
      hospitalId: otherHospitalId,
      tenantId: otherHospitalId,
      email: adminBUser.email,
    } as any;
  });

  after(async () => {
    // Cleanup created test records
    await prisma.workingHour.deleteMany({
      where: { hospitalId: { in: [approvedHospitalId, draftHospitalId, otherHospitalId] } },
    });
    await prisma.blockedSlot.deleteMany({
      where: { hospitalId: { in: [approvedHospitalId, draftHospitalId, otherHospitalId] } },
    });
    await prisma.calendar.deleteMany({
      where: { hospitalId: { in: [approvedHospitalId, draftHospitalId, otherHospitalId] } },
    });
    await prisma.doctor.deleteMany({
      where: { hospitalId: { in: [approvedHospitalId, draftHospitalId, otherHospitalId] } },
    });
    await prisma.department.deleteMany({
      where: { hospitalId: { in: [approvedHospitalId, draftHospitalId, otherHospitalId] } },
    });
    await prisma.hospital.deleteMany({
      where: { id: { in: [approvedHospitalId, draftHospitalId, otherHospitalId] } },
    });
  });

  describe('1. Hospital Scoping & Department/Specialty Management', () => {
    it('rejects creating departments or inviting doctors on a DRAFT hospital', async () => {
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.createDepartment(
            draftHospitalId,
            { name: 'Cardiology' },
            hospitalAdminA
          );
        },
        (err: Error) => {
          assert.match(err.message, /Only APPROVED hospitals can/);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.inviteDoctor(
            draftHospitalId,
            {
              name: 'Dr. Test Draft',
              email: `draft-doc-${Date.now()}@test.org`,
            },
            hospitalAdminA
          );
        },
        (err: Error) => {
          assert.match(err.message, /Only APPROVED hospitals can/);
          return true;
        }
      );
    });

    it('creates, lists, updates, and deletes departments in an APPROVED hospital', async () => {
      const dept = await HospitalDoctorConfigService.createDepartment(
        approvedHospitalId,
        { name: 'Cardiology Department', description: 'Cardiovascular Care' },
        hospitalAdminA
      );
      assert.ok(dept.id);
      assert.strictEqual(dept.name, 'Cardiology Department');

      const depts = await HospitalDoctorConfigService.listDepartments(approvedHospitalId, hospitalAdminA);
      assert.ok(depts.some((d) => d.name === 'Cardiology Department'));

      // Update department
      const updatedDept = await HospitalDoctorConfigService.updateDepartment(
        approvedHospitalId,
        dept.id,
        { description: 'Comprehensive Cardiovascular Care & Surgery' },
        hospitalAdminA
      );
      assert.strictEqual(updatedDept.description, 'Comprehensive Cardiovascular Care & Surgery');

      // Create a temp department and delete it
      const tempDept = await HospitalDoctorConfigService.createDepartment(
        approvedHospitalId,
        { name: 'Temporary Department' },
        hospitalAdminA
      );
      const delResult = await HospitalDoctorConfigService.deleteDepartment(
        approvedHospitalId,
        tempDept.id,
        hospitalAdminA
      );
      assert.strictEqual(delResult.id, tempDept.id);
    });

    it('manages hospital-wide specialties (PRD Section 6)', async () => {
      // Add specialty
      const updatedSpecs = await HospitalDoctorConfigService.addHospitalSpecialty(
        approvedHospitalId,
        'Pediatrics',
        hospitalAdminA
      );
      assert.ok(updatedSpecs.specialties.includes('Pediatrics'));

      // List specialties
      const specs = await HospitalDoctorConfigService.listHospitalSpecialties(approvedHospitalId, hospitalAdminA);
      assert.ok(specs.hospitalSpecialties.includes('Pediatrics'));
      assert.ok(specs.hospitalSpecialties.includes('Cardiology'));

      // Remove specialty
      const afterRemoval = await HospitalDoctorConfigService.removeHospitalSpecialty(
        approvedHospitalId,
        'Pediatrics',
        hospitalAdminA
      );
      assert.strictEqual(afterRemoval.specialties.includes('Pediatrics'), false);
    });
  });

  describe('2. Doctor Invitation & Lifecycle State Machine (PRD Section 6)', () => {
    it('invites a doctor into INVITED status and automatically initializes primary calendar', async () => {
      const uniqueEmail = `dr.smith.${Date.now()}@stjude.org`;
      const result = await HospitalDoctorConfigService.inviteDoctor(
        approvedHospitalId,
        {
          name: 'Dr. Allison Smith',
          email: uniqueEmail,
          specialty: 'Cardiology',
          department: 'Cardiology Department',
          qualifications: 'MD, FACC',
          experienceYears: 12,
          languages: ['English', 'Spanish'],
          consultationTypes: ['In-Person', 'Telehealth'],
          appointmentDurationMinutes: 45,
        },
        hospitalAdminA
      );

      assert.ok(result.doctor.id);
      assert.strictEqual(result.doctor.name, 'Dr. Allison Smith');
      assert.strictEqual(result.doctor.status, DoctorStatus.INVITED);
      assert.strictEqual(result.doctor.appointmentDurationMinutes, 45);
      assert.deepStrictEqual(result.doctor.consultationTypes, ['In-Person', 'Telehealth']);
      assert.ok(result.calendar.id);
      assert.strictEqual(result.calendar.isActive, true);

      doctorAId = result.doctor.id;
      doctorUserA = {
        id: result.doctor.userId,
        role: UserRole.DOCTOR,
        hospitalId: approvedHospitalId,
        email: uniqueEmail,
      };
    });

    it('rejects activating a doctor without working hours configured (PRD Section 6 Validation Rule)', async () => {
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.transitionDoctorStatus(
            approvedHospitalId,
            doctorAId,
            DoctorStatus.ACTIVE,
            hospitalAdminA,
            'Premature activation attempt'
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorLifecycleTransitionError);
          assert.match(err.message, /Doctor must have at least one configured working hour entry before activation/);
          return true;
        }
      );
    });

    it('rejects activating a doctor if their calendar is inactive (PRD Section 6 Validation Rule)', async () => {
      // Add a working hour first
      const wh = await HospitalDoctorConfigService.addWorkingHour(
        doctorAId,
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
        hospitalAdminA
      );
      assert.ok(wh.id);

      // Deactivate calendar
      await HospitalDoctorConfigService.updateDoctorCalendar(
        doctorAId,
        { isActive: false },
        hospitalAdminA
      );

      // Activation must fail because calendar is inactive
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.transitionDoctorStatus(
            approvedHospitalId,
            doctorAId,
            DoctorStatus.ACTIVE,
            hospitalAdminA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorLifecycleTransitionError);
          assert.match(err.message, /Doctor must have an active calendar before activation/);
          return true;
        }
      );

      // Restore calendar to active
      await HospitalDoctorConfigService.updateDoctorCalendar(
        doctorAId,
        { isActive: true },
        hospitalAdminA
      );
    });

    it('transitions doctor through valid lifecycle states once calendar & working hours exist: INVITED -> ACTIVE -> INACTIVE -> ACTIVE -> SUSPENDED -> ACTIVE', async () => {
      // 1. INVITED -> ACTIVE (succeeds now that calendar is active and working hours exist)
      let doc = await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        doctorAId,
        DoctorStatus.ACTIVE,
        hospitalAdminA,
        'Credentials verified'
      );
      assert.strictEqual(doc.status, DoctorStatus.ACTIVE);

      // 2. ACTIVE -> INACTIVE (e.g. sabbatical)
      doc = await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        doctorAId,
        DoctorStatus.INACTIVE,
        hospitalAdminA,
        'Temporary sabbatical'
      );
      assert.strictEqual(doc.status, DoctorStatus.INACTIVE);

      // 3. INACTIVE -> ACTIVE
      doc = await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        doctorAId,
        DoctorStatus.ACTIVE,
        hospitalAdminA,
        'Returned from sabbatical'
      );
      assert.strictEqual(doc.status, DoctorStatus.ACTIVE);

      // 4. ACTIVE -> SUSPENDED (e.g. disciplinary or license audit)
      doc = await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        doctorAId,
        DoctorStatus.SUSPENDED,
        hospitalAdminA,
        'Pending license audit'
      );
      assert.strictEqual(doc.status, DoctorStatus.SUSPENDED);

      // 5. SUSPENDED -> ACTIVE
      doc = await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        doctorAId,
        DoctorStatus.ACTIVE,
        hospitalAdminA,
        'License verified'
      );
      assert.strictEqual(doc.status, DoctorStatus.ACTIVE);
    });

    it('rejects invalid lifecycle state transitions', async () => {
      // Create a new invited doctor
      const invited = await HospitalDoctorConfigService.inviteDoctor(
        approvedHospitalId,
        {
          name: 'Dr. Jane Doe',
          email: `dr.jane.${Date.now()}@stjude.org`,
        },
        hospitalAdminA
      );

      // Cannot jump from INVITED directly to SUSPENDED
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.transitionDoctorStatus(
            approvedHospitalId,
            invited.doctor.id,
            DoctorStatus.SUSPENDED,
            hospitalAdminA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorLifecycleTransitionError);
          assert.match(err.message, /Invalid doctor lifecycle transition/);
          return true;
        }
      );
    });

    it('prevents doctors from changing their own lifecycle status', async () => {
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.transitionDoctorStatus(
            approvedHospitalId,
            doctorAId,
            DoctorStatus.INACTIVE,
            doctorUserA,
            'Doctor self-deactivating'
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );
    });
  });

  describe('3. Calendars, Working Hours & Blocked Periods CRUD', () => {
    let workingHourId: string;
    let blockedPeriodId: string;

    it('validates working hour bounds (startTime strictly earlier than endTime, valid dayOfWeek)', async () => {
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.addWorkingHour(
            doctorAId,
            { dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }, // Invalid inverted time
            hospitalAdminA
          );
        },
        (err: Error) => {
          assert.match(err.message, /must be strictly earlier than/);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.addWorkingHour(
            doctorAId,
            { dayOfWeek: 7, startTime: '09:00', endTime: '17:00' }, // Invalid day of week
            hospitalAdminA
          );
        },
        (err: Error) => {
          assert.match(err.message, /Invalid dayOfWeek/);
          return true;
        }
      );
    });

    it('allows Hospital Admin to add, list, and update working hours and blocked periods', async () => {
      // Add Tuesday working hours: 09:00 to 13:00
      const wh = await HospitalDoctorConfigService.addWorkingHour(
        doctorAId,
        { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' },
        hospitalAdminA
      );
      assert.ok(wh.id);
      workingHourId = wh.id;

      // Update working hours
      const updatedWh = await HospitalDoctorConfigService.updateWorkingHour(
        doctorAId,
        workingHourId,
        { endTime: '14:00' },
        hospitalAdminA
      );
      assert.strictEqual(updatedWh.endTime, '14:00');

      // Add a blocked period (Leave / Surgery)
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const tomorrowStart = new Date(tomorrow.setHours(13, 0, 0, 0));
      const tomorrowEnd = new Date(tomorrow.setHours(15, 0, 0, 0));

      const bp = await HospitalDoctorConfigService.addBlockedPeriod(
        doctorAId,
        {
          startTime: tomorrowStart,
          endTime: tomorrowEnd,
          reason: 'Emergency Surgery Ward Round',
        },
        hospitalAdminA
      );
      assert.ok(bp.id);
      assert.strictEqual(bp.reason, 'Emergency Surgery Ward Round');
      blockedPeriodId = bp.id;

      // Update blocked period
      const updatedBp = await HospitalDoctorConfigService.updateBlockedPeriod(
        doctorAId,
        blockedPeriodId,
        { reason: 'Extended Emergency Surgery Round' },
        hospitalAdminA
      );
      assert.strictEqual(updatedBp.reason, 'Extended Emergency Surgery Round');

      // List working hours and blocked periods
      const hours = await HospitalDoctorConfigService.listWorkingHours(doctorAId, hospitalAdminA);
      assert.ok(hours.length >= 2);

      const blocked = await HospitalDoctorConfigService.listBlockedPeriods(doctorAId, hospitalAdminA);
      assert.strictEqual(blocked.length, 1);
    });

    it('allows Doctor to manage their own working hours and blocked periods (PRD Section 4)', async () => {
      // Doctor adds Wednesday working hours
      const whWed = await HospitalDoctorConfigService.addWorkingHour(
        doctorAId,
        { dayOfWeek: 3, startTime: '10:00', endTime: '18:00' },
        doctorUserA
      );
      assert.ok(whWed.id);
      assert.strictEqual(whWed.dayOfWeek, 3);

      // Doctor updates Wednesday working hours
      const updatedWh = await HospitalDoctorConfigService.updateWorkingHour(
        doctorAId,
        whWed.id,
        { startTime: '11:00' },
        doctorUserA
      );
      assert.strictEqual(updatedWh.startTime, '11:00');

      // Doctor adds a vacation blocked period
      const nextWeek = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const bp = await HospitalDoctorConfigService.addBlockedPeriod(
        doctorAId,
        {
          startTime: nextWeek,
          endTime: new Date(nextWeek.getTime() + 4 * 3600 * 1000),
          reason: 'Personal Leave',
        },
        doctorUserA
      );
      assert.ok(bp.id);

      // Doctor updates their own blocked period
      const updatedBp = await HospitalDoctorConfigService.updateBlockedPeriod(
        doctorAId,
        bp.id,
        { reason: 'Updated Personal Leave' },
        doctorUserA
      );
      assert.strictEqual(updatedBp.reason, 'Updated Personal Leave');

      // Doctor deletes their own blocked period
      const delResult = await HospitalDoctorConfigService.deleteBlockedPeriod(doctorAId, bp.id, doctorUserA);
      assert.strictEqual(delResult.success, true);
    });

    it('allows managing doctor appointment types (PRD Section 6)', async () => {
      const initialTypes = await HospitalDoctorConfigService.getDoctorAppointmentTypes(doctorAId, doctorUserA);
      assert.deepStrictEqual(initialTypes, ['In-Person', 'Telehealth']);

      // Doctor updates their appointment types
      const updatedTypes = await HospitalDoctorConfigService.updateDoctorAppointmentTypes(
        doctorAId,
        ['In-Person', 'Telehealth', 'Home-Visit'],
        hospitalAdminA
      );
      assert.deepStrictEqual(updatedTypes, ['In-Person', 'Telehealth', 'Home-Visit']);

      // List hospital-wide appointment types
      const hospitalTypes = await HospitalDoctorConfigService.listHospitalAppointmentTypes(
        approvedHospitalId,
        hospitalAdminA
      );
      assert.ok(hospitalTypes.includes('In-Person'));
      assert.ok(hospitalTypes.includes('Home-Visit'));
    });

    it('deletes working hours successfully', async () => {
      const delResult = await HospitalDoctorConfigService.deleteWorkingHour(doctorAId, workingHourId, hospitalAdminA);
      assert.strictEqual(delResult.success, true);
    });
  });

  describe('4. Role Permissions & Multi-Tenant Scoping (PRD Section 4)', () => {
    let doctorBWhId: string;
    let doctorBBpId: string;

    before(async () => {
      // Provision Doctor B under Hospital B
      const resultB = await HospitalDoctorConfigService.inviteDoctor(
        otherHospitalId,
        {
          name: 'Dr. Robert Chen',
          email: `dr.chen.${Date.now()}@metrocity.org`,
        },
        hospitalAdminB
      );
      doctorBId = resultB.doctor.id;
      doctorUserB = {
        id: resultB.doctor.userId,
        role: UserRole.DOCTOR,
        hospitalId: otherHospitalId,
        email: resultB.doctor.name,
      };

      // Add working hours and blocked period to Doctor B so we can test edit boundaries
      const wh = await HospitalDoctorConfigService.addWorkingHour(
        doctorBId,
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
        hospitalAdminB
      );
      doctorBWhId = wh.id;

      const bp = await HospitalDoctorConfigService.addBlockedPeriod(
        doctorBId,
        {
          startTime: new Date(Date.now() + 48 * 3600 * 1000),
          endTime: new Date(Date.now() + 50 * 3600 * 1000),
          reason: 'Doctor B Conference',
        },
        hospitalAdminB
      );
      doctorBBpId = bp.id;
    });

    it('strictly enforces Doctor boundary: Doctor A cannot view, add, update, or delete Doctor B calendar/availability/blocked time', async () => {
      // 1. Doctor A cannot view Doctor B calendar
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.getDoctorCalendar(doctorBId, doctorUserA);
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          assert.match(err.message, /Doctors may only manage their own availability/);
          return true;
        }
      );

      // 2. Doctor A cannot update Doctor B calendar
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.updateDoctorCalendar(
            doctorBId,
            { isActive: false },
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // 3. Doctor A cannot add working hours to Doctor B
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.addWorkingHour(
            doctorBId,
            { dayOfWeek: 4, startTime: '09:00', endTime: '17:00' },
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // 4. Doctor A cannot update working hours of Doctor B
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.updateWorkingHour(
            doctorBId,
            doctorBWhId,
            { endTime: '16:00' },
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // 5. Doctor A cannot delete working hours of Doctor B
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.deleteWorkingHour(
            doctorBId,
            doctorBWhId,
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // 6. Doctor A cannot add blocked period to Doctor B
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.addBlockedPeriod(
            doctorBId,
            {
              startTime: new Date(),
              endTime: new Date(Date.now() + 3600 * 1000),
              reason: 'Unauthorized blocked period',
            },
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // 7. Doctor A cannot update blocked period of Doctor B
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.updateBlockedPeriod(
            doctorBId,
            doctorBBpId,
            { reason: 'Tampered reason' },
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // 8. Doctor A cannot delete blocked period of Doctor B
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.deleteBlockedPeriod(
            doctorBId,
            doctorBBpId,
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );
    });

    it('rejects Hospital Admin B attempting to modify Doctor A under Hospital A (Cross-Tenant)', async () => {
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.addWorkingHour(
            doctorAId,
            { dayOfWeek: 5, startTime: '09:00', endTime: '17:00' },
            hospitalAdminB // Admin B trying to edit Doctor in Hospital A
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );
    });

    it('allows Hospital Admin to delete a doctor and prevents doctors from deleting doctors', async () => {
      // Create a temporary doctor to delete
      const tempDoc = await HospitalDoctorConfigService.inviteDoctor(
        approvedHospitalId,
        {
          name: 'Dr. Temporary ToDelete',
          email: `dr.temp.${Date.now()}@stjude.org`,
        },
        hospitalAdminA
      );

      // Doctor cannot delete a doctor
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.deleteDoctor(
            approvedHospitalId,
            tempDoc.doctor.id,
            doctorUserA
          );
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorConfigUnauthorizedError);
          return true;
        }
      );

      // Hospital Admin can delete doctor
      const delResult = await HospitalDoctorConfigService.deleteDoctor(
        approvedHospitalId,
        tempDoc.doctor.id,
        hospitalAdminA
      );
      assert.strictEqual(delResult.success, true);
    });
  });

  describe('5. Config-Time Operational Rule: Only Active Doctors with Valid Availability Can Receive Appointments', () => {
    let unreadyDoctorId: string;

    before(async () => {
      // Create a doctor without working hours in INVITED status
      const invitedDoc = await HospitalDoctorConfigService.inviteDoctor(
        approvedHospitalId,
        {
          name: 'Dr. Not Ready',
          email: `dr.notready.${Date.now()}@stjude.org`,
        },
        hospitalAdminA
      );
      unreadyDoctorId = invitedDoc.doctor.id;
    });

    it('assertDoctorReadyForAppointments rejects doctor in INVITED status', async () => {
      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.assertDoctorReadyForAppointments(unreadyDoctorId, approvedHospitalId);
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorNotReadyForAppointmentsError);
          assert.match(err.message, /Only ACTIVE doctors can receive appointments/);
          return true;
        }
      );
    });

    it('assertDoctorReadyForAppointments rejects doctor in SUSPENDED or INACTIVE status', async () => {
      // Add working hours to unreadyDoctorId so activation succeeds
      await HospitalDoctorConfigService.addWorkingHour(
        unreadyDoctorId,
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
        hospitalAdminA
      );

      // Transition to ACTIVE then SUSPENDED
      await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        unreadyDoctorId,
        DoctorStatus.ACTIVE,
        hospitalAdminA
      );
      await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        unreadyDoctorId,
        DoctorStatus.SUSPENDED,
        hospitalAdminA
      );

      await assert.rejects(
        async () => {
          await HospitalDoctorConfigService.assertDoctorReadyForAppointments(unreadyDoctorId, approvedHospitalId);
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorNotReadyForAppointmentsError);
          assert.match(err.message, /Only ACTIVE doctors can receive appointments/);
          return true;
        }
      );
    });

    it('assertDoctorReadyForAppointments passes when doctor is ACTIVE with valid working hours', async () => {
      // Reactivate doctor
      await HospitalDoctorConfigService.transitionDoctorStatus(
        approvedHospitalId,
        unreadyDoctorId,
        DoctorStatus.ACTIVE,
        hospitalAdminA
      );

      // Should now pass readiness validation
      const doctor = await HospitalDoctorConfigService.assertDoctorReadyForAppointments(
        unreadyDoctorId,
        approvedHospitalId
      );
      assert.ok(doctor);
      assert.strictEqual(doctor.status, DoctorStatus.ACTIVE);
      assert.ok(doctor.calendar?.workingHours.length! > 0);
    });

    it('scheduling engine enforces doctor readiness rule and rejects booking for unready doctor', async () => {
      // Create another doctor in INVITED status
      const inactiveDoc = await HospitalDoctorConfigService.inviteDoctor(
        approvedHospitalId,
        {
          name: 'Dr. Sabbatical',
          email: `dr.sabbatical.${Date.now()}@stjude.org`,
        },
        hospitalAdminA
      );

      // Try to book appointment via SchedulingService
      await assert.rejects(
        async () => {
          await SchedulingService.bookAppointment({
            patientId: 'any-patient-id',
            doctorId: inactiveDoc.doctor.id,
            hospitalId: approvedHospitalId,
            slotId: 'any-slot-id',
          });
        },
        (err: Error) => {
          assert.ok(err instanceof DoctorNotReadyForAppointmentsError);
          assert.match(err.message, /Only ACTIVE doctors can receive appointments/);
          return true;
        }
      );
    });
  });
});
