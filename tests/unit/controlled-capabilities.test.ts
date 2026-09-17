import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '@health/db';
import {
  CapabilityRegistry,
  CapabilityValidationError,
  CapabilityNotFoundError,
  CapabilityConflictError,
  CapabilityUnauthorizedError,
  CapabilityExternalFailureError,
  StubEhrConnector,
} from '@health/capabilities';

describe('Unit Tests: Controlled Capabilities Layer (PRD Section 10)', () => {
  let testHospital: any;
  let otherHospital: any;
  let testDoctor: any;
  let testPatient: any;
  let otherPatient: any;
  let testConversation: any;
  let testQuestionnaire: any;
  let testSlot1: any;
  let testSlot2: any;
  let testSlot3: any;
  let testSlot4: any;
  let testSlot5: any;
  let createdAppointmentId: string;
  let baseDate: Date;

  before(async () => {
    // 1. Fetch seed hospital
    testHospital = await prisma.hospital.findFirst({
      where: { name: 'Apex Regional Medical Center' },
    });
    assert.ok(testHospital, 'Seed hospital Apex Regional Medical Center must exist');

    // 2. Create or fetch a second hospital for cross-tenant boundary testing
    otherHospital = await prisma.hospital.upsert({
      where: { slug: 'st-jude-testing' },
      update: {},
      create: {
        name: 'St Jude Testing Hospital',
        slug: 'st-jude-testing',
        status: 'Approved',
        address: '456 Healthcare Blvd',
        city: 'Metropolis',
        operatingHours: '08:00 - 18:00',
        contactEmail: 'admin@stjude-test.org',
        contactPhone: '+1-555-0199',
        specialtiesJson: JSON.stringify(['Pediatrics', 'General']),
      },
    });

    // 3. Fetch seed doctor
    testDoctor = await prisma.doctor.findFirst({
      where: { name: 'Dr. Arvind Rao' },
      include: { calendar: true },
    });
    assert.ok(testDoctor, 'Dr. Arvind Rao must exist');

    // 4. Fetch seed patient
    testPatient = await prisma.patient.findFirst({
      where: { name: 'John Doe' },
    });
    assert.ok(testPatient, 'Seed patient John Doe must exist');

    // 5. Create or fetch second patient for privacy scoping tests
    let otherUser = await prisma.user.findUnique({
      where: { email: 'jane.smith.test@example.com' },
    });
    if (!otherUser) {
      otherUser = await prisma.user.create({
        data: {
          email: 'jane.smith.test@example.com',
          passwordHash: 'dummy-hash',
          name: 'Jane Smith',
          role: 'PATIENT',
        },
      });
    }

    otherPatient = await prisma.patient.upsert({
      where: { phone: '+1-555-9988' },
      update: {},
      create: {
        userId: otherUser.id,
        name: 'Jane Smith',
        phone: '+1-555-9988',
        email: 'jane.smith.test@example.com',
        dateOfBirth: '1992-05-14',
      },
    });

    // 6. Create or fetch test questionnaire
    testQuestionnaire = await prisma.questionnaire.findFirst({
      where: { hospitalId: testHospital.id },
    });
    if (!testQuestionnaire) {
      testQuestionnaire = await prisma.questionnaire.create({
        data: {
          hospitalId: testHospital.id,
          title: 'General Intake Questionnaire',
          specialty: 'Orthopedics',
          questions: {
            create: [
              {
                text: 'Please describe current symptoms and pain levels',
                type: 'long_text',
                required: true,
                orderIndex: 0,
              },
            ],
          },
        },
      });
    }

    // 7. Create test slots for bookings and rescheduling (future weekday slots)
    baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + 30);
    // Ensure weekday (Mon-Fri)
    if (baseDate.getDay() === 0) baseDate.setDate(baseDate.getDate() + 1);
    if (baseDate.getDay() === 6) baseDate.setDate(baseDate.getDate() + 2);
    baseDate.setHours(9, 0, 0, 0);

    const makeSlot = async (hoursOffset: number) => {
      const sTime = new Date(baseDate.getTime() + hoursOffset * 3600000);
      const eTime = new Date(sTime.getTime() + 30 * 60000);
      return await prisma.slot.upsert({
        where: {
          doctorId_startTime: {
            doctorId: testDoctor.id,
            startTime: sTime,
          },
        },
        update: { isBooked: false, isBlocked: false },
        create: {
          doctorId: testDoctor.id,
          hospitalId: testHospital.id,
          startTime: sTime,
          endTime: eTime,
          isBooked: false,
          isBlocked: false,
        },
      });
    };

    testSlot1 = await makeSlot(1);
    testSlot2 = await makeSlot(2);
    testSlot3 = await makeSlot(3);
    testSlot4 = await makeSlot(4);
    testSlot5 = await makeSlot(5);

    // 8. Create test conversation for context and transfer capabilities
    testConversation = await prisma.aiConversation.create({
      data: {
        patientId: testPatient.id,
        hospitalId: testHospital.id,
        channel: 'web_voice',
        context: {
          create: {
            currentIntent: 'BOOK_APPOINTMENT',
            selectedHospitalId: testHospital.id,
            selectedDoctorId: testDoctor.id,
            selectedSlotId: testSlot1.id,
            contextJson: JSON.stringify({ preferredLanguage: 'en' }),
          },
        },
      },
      include: { context: true },
    });

    // Configure default stub EHR connector
    CapabilityRegistry.setHealthcareConnector(new StubEhrConnector());
  });

  after(async () => {
    // Clean up created test hospital, conversation, and other patient
    if (testConversation?.id) {
      await prisma.aiContext.deleteMany({ where: { conversationId: testConversation.id } }).catch(() => {});
      await prisma.aiConversation.delete({ where: { id: testConversation.id } }).catch(() => {});
    }
    if (otherHospital?.id) {
      await prisma.hospital.delete({ where: { id: otherHospital.id } }).catch(() => {});
    }
  });

  // =========================================================================
  // SECTION 1: All 17 Capabilities Valid Execution & Output Schema Validation
  // =========================================================================
  describe('1. Valid Execution of all 17 Capabilities', () => {
    it('1. search_hospitals: returns approved hospitals matching filters', async () => {
      const result = await CapabilityRegistry.execute(
        'search_hospitals',
        { query: 'Apex', specialty: 'Orthopedics' },
        { userRole: 'PATIENT' }
      );
      assert.ok(Array.isArray(result.hospitals));
      assert.ok(result.hospitals.length > 0);
      assert.strictEqual(result.hospitals[0].name, 'Apex Regional Medical Center');
    });

    it('2. search_doctors: returns active doctors with specialties and hospitals', async () => {
      const result = await CapabilityRegistry.execute(
        'search_doctors',
        { hospitalId: testHospital.id, specialty: 'Orthopedics' },
        { userRole: 'PATIENT', hospitalId: testHospital.id }
      );
      assert.ok(Array.isArray(result.doctors));
      assert.ok(result.doctors.length > 0);
      assert.strictEqual(result.doctors[0].name, 'Dr. Arvind Rao');
      assert.strictEqual(result.doctors[0].specialty, 'Orthopedics');
    });

    it('3. check_availability: returns calculated non-invented available slots', async () => {
      const sDate = testSlot1.startTime.toISOString();
      const eDate = new Date(testSlot5.endTime.getTime() + 3600000).toISOString();

      const result = await CapabilityRegistry.execute(
        'check_availability',
        {
          doctorId: testDoctor.id,
          startDate: sDate,
          endDate: eDate,
        },
        { userRole: 'PATIENT', hospitalId: testHospital.id }
      );
      assert.ok(Array.isArray(result.slots));
      assert.ok(result.slots.length > 0);
      assert.strictEqual(result.slots[0].doctorId, testDoctor.id);
    });

    it('4. lookup_patient: finds patient by phone and tenant', async () => {
      const result = await CapabilityRegistry.execute(
        'lookup_patient',
        {
          identifier: { phone: testPatient.phone },
          tenantId: testHospital.id,
        },
        { userRole: 'DOCTOR', hospitalId: testHospital.id }
      );
      assert.ok(result.patient);
      assert.strictEqual(result.patient.id, testPatient.id);
      assert.strictEqual(result.patient.name, testPatient.name);
    });

    it('5. create_appointment: executes full pipeline (create -> EHR call -> verify -> sync -> return)', async () => {
      const idempotencyKey = `idem-create-${crypto.randomUUID()}`;

      const result = await CapabilityRegistry.execute(
        'create_appointment',
        {
          hospitalId: testHospital.id,
          doctorId: testDoctor.id,
          patientId: testPatient.id,
          slotId: testSlot1.id,
          reason: 'Routine orthopedic checkup and joint assessment',
          idempotencyKey,
        },
        {
          userRole: 'PATIENT',
          patientId: testPatient.id,
          hospitalId: testHospital.id,
        }
      );

      assert.ok(result.appointmentId);
      createdAppointmentId = result.appointmentId;
      assert.strictEqual(result.status, 'Confirmed');
      assert.strictEqual(result.doctorName, testDoctor.name);
      assert.strictEqual(result.hospitalName, testHospital.name);
      assert.ok(result.externalAppointmentId, 'Must have received EHR externalAppointmentId');

      // Verify slot is marked booked in DB
      const dbSlot = await prisma.slot.findUnique({ where: { id: testSlot1.id } });
      assert.strictEqual(dbSlot?.isBooked, true);
    });

    it('6. get_appointment: retrieves confirmed appointment details', async () => {
      assert.ok(createdAppointmentId, 'createdAppointmentId must be present');
      const result = await CapabilityRegistry.execute(
        'get_appointment',
        { appointmentId: createdAppointmentId },
        { userRole: 'PATIENT', patientId: testPatient.id, hospitalId: testHospital.id }
      );
      assert.ok(result.appointment);
      assert.strictEqual(result.appointment.id, createdAppointmentId);
      assert.strictEqual(result.appointment.hospitalId, testHospital.id);
      assert.strictEqual(result.appointment.doctorId, testDoctor.id);
      assert.strictEqual(result.appointment.status, 'Confirmed');
    });

    it('7. reschedule_appointment: updates slot with idempotency support and releases old slot', async () => {
      assert.ok(createdAppointmentId);
      const idempotencyKey = `idem-resched-${crypto.randomUUID()}`;

      const result = await CapabilityRegistry.execute(
        'reschedule_appointment',
        {
          appointmentId: createdAppointmentId,
          newSlotId: testSlot2.id,
          reason: 'Patient requested later time slot due to travel delay',
          idempotencyKey,
        },
        { userRole: 'PATIENT', patientId: testPatient.id, hospitalId: testHospital.id }
      );

      assert.strictEqual(result.appointmentId, createdAppointmentId);
      assert.strictEqual(result.oldSlotReleased, true);
      assert.strictEqual(result.status, 'Confirmed');

      // Verify old slot is released and new slot is booked in DB
      const oldSlot = await prisma.slot.findUnique({ where: { id: testSlot1.id } });
      const newSlot = await prisma.slot.findUnique({ where: { id: testSlot2.id } });
      assert.strictEqual(oldSlot?.isBooked, false, 'Old slot must be released');
      assert.strictEqual(newSlot?.isBooked, true, 'New slot must be booked');
    });

    it('8. get_questionnaire: retrieves pre-visit intake questions', async () => {
      const result = await CapabilityRegistry.execute(
        'get_questionnaire',
        {
          hospitalId: testHospital.id,
          specialty: 'Orthopedics',
        },
        { userRole: 'PATIENT', patientId: testPatient.id, hospitalId: testHospital.id }
      );

      assert.ok(result.questionnaire);
      assert.strictEqual(result.questionnaire.id, testQuestionnaire.id);
      assert.ok(Array.isArray(result.questionnaire.schema));
      assert.ok(result.questionnaire.schema.length > 0);
    });

    it('9. submit_questionnaire: persists patient health responses', async () => {
      const result = await CapabilityRegistry.execute(
        'submit_questionnaire',
        {
          questionnaireId: testQuestionnaire.id,
          appointmentId: createdAppointmentId,
          patientId: testPatient.id,
          responses: {
            q1: 'Mild knee stiffness in mornings after running',
          },
        },
        { userRole: 'PATIENT', patientId: testPatient.id, hospitalId: testHospital.id }
      );

      assert.ok(result.submissionId);
      assert.strictEqual(result.status, 'Submitted');
      assert.ok(result.completedAt);
    });

    it('10. send_notification: dispatches notification via sms/email/in_app', async () => {
      const result = await CapabilityRegistry.execute(
        'send_notification',
        {
          recipientId: testPatient.id,
          recipientType: 'Patient',
          channel: 'sms',
          templateId: 'APPOINTMENT_REMINDER',
          payload: { message: 'Reminder: Your appointment is tomorrow at 11:00 AM' },
          idempotencyKey: `idem-notif-${crypto.randomUUID()}`,
        },
        { userRole: 'HOSPITAL_ADMIN', hospitalId: testHospital.id }
      );

      assert.ok(result.notificationId);
      assert.strictEqual(result.status, 'Delivered');
    });

    it('11. start_workflow: initiates backend workflow execution', async () => {
      const result = await CapabilityRegistry.execute(
        'start_workflow',
        {
          workflowType: 'PreVisitQuestionnaire',
          triggerEvent: 'APPOINTMENT_CONFIRMED',
          payload: { appointmentId: createdAppointmentId, hospitalId: testHospital.id },
          idempotencyKey: `idem-wf-${crypto.randomUUID()}`,
        },
        { userRole: 'SYSTEM' }
      );

      assert.ok(result.workflowExecutionId);
      assert.strictEqual(result.status, 'Active');
    });

    it('12. get_context: returns active conversation and appointment context', async () => {
      const result = await CapabilityRegistry.execute(
        'get_context',
        {
          conversationId: testConversation.id,
        },
        { userRole: 'PATIENT', patientId: testPatient.id, hospitalId: testHospital.id }
      );

      assert.ok(result.context);
      assert.strictEqual(result.context.selectedHospitalId, testHospital.id);
      assert.strictEqual(result.context.selectedDoctorId, testDoctor.id);
      assert.strictEqual(result.context.currentIntent, 'BOOK_APPOINTMENT');
    });

    it('13. update_preferences: updates patient channel and language preferences', async () => {
      const result = await CapabilityRegistry.execute(
        'update_preferences',
        {
          patientId: testPatient.id,
          preferences: {
            communicationChannel: 'sms',
            preferredTimeOfDay: 'morning',
          },
        },
        { userRole: 'PATIENT', patientId: testPatient.id }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.patientId, testPatient.id);
      assert.strictEqual(result.updatedPreferences.communicationChannel, 'sms');
      assert.strictEqual(result.updatedPreferences.preferredTimeOfDay, 'morning');
    });

    it('14. verify_external_appointment: queries external EHR status', async () => {
      const appt = await prisma.appointment.findUnique({
        where: { id: createdAppointmentId },
      });

      const result = await CapabilityRegistry.execute(
        'verify_external_appointment',
        {
          internalAppointmentId: createdAppointmentId,
          externalAppointmentId: appt?.externalAppointmentId || undefined,
          hospitalId: testHospital.id,
        },
        { userRole: 'DOCTOR', hospitalId: testHospital.id }
      );

      assert.strictEqual(result.isVerified, true);
      assert.strictEqual(result.externalStatus.toUpperCase(), 'CONFIRMED');
      assert.strictEqual(result.match, true);
      assert.ok(result.synchronizedAt);
    });

    it('15. synchronize_state: synchronizes local and external EHR records', async () => {
      const result = await CapabilityRegistry.execute(
        'synchronize_state',
        {
          appointmentId: createdAppointmentId,
          correlationId: `corr-sync-${Date.now()}`,
        },
        { userRole: 'HOSPITAL_ADMIN', hospitalId: testHospital.id }
      );

      assert.ok(
        result.internalStatus === 'Confirmed' || result.internalStatus === 'Rescheduled',
        `Expected Confirmed or Rescheduled, got ${result.internalStatus}`
      );
      assert.strictEqual(typeof result.inSync, 'boolean');
      assert.strictEqual(typeof result.reconciliationRequired, 'boolean');
    });

    it('16. cancel_appointment: cancels appointment with idempotency support and releases slot', async () => {
      const idempotencyKey = `idem-cancel-${crypto.randomUUID()}`;
      const result = await CapabilityRegistry.execute(
        'cancel_appointment',
        {
          appointmentId: createdAppointmentId,
          reason: 'Patient recovered and no longer requires consultation',
          idempotencyKey,
        },
        { userRole: 'PATIENT', patientId: testPatient.id, hospitalId: testHospital.id }
      );

      assert.strictEqual(result.appointmentId, createdAppointmentId);
      assert.strictEqual(result.status, 'Cancelled');
      assert.strictEqual(result.slotReleased, true);

      // Verify DB status and slot release
      const dbAppt = await prisma.appointment.findUnique({
        where: { id: createdAppointmentId },
      });
      assert.strictEqual(dbAppt?.status, 'Cancelled');

      const releasedSlot = await prisma.slot.findUnique({ where: { id: testSlot2.id } });
      assert.strictEqual(releasedSlot?.isBooked, false, 'Slot must be freed upon cancellation');
    });

    it('17. transfer_to_human: safely initiates escalation to human staff', async () => {
      const result = await CapabilityRegistry.execute(
        'transfer_to_human',
        {
          conversationId: testConversation.id,
          reason: 'clinical_inquiry',
          notes: 'Patient asked for clinical diagnostic evaluation of persistent chest pain.',
        },
        { userRole: 'PATIENT', patientId: testPatient.id }
      );

      assert.strictEqual(result.transferred, true);
      assert.ok(result.escalationId);
      assert.strictEqual(result.targetQueue, 'ClinicalStaff');
    });
  });

  // =========================================================================
  // SECTION 2: Structured Error Handling & Input Validation
  // =========================================================================
  describe('2. Input Validation (CapabilityValidationError)', () => {
    it('rejects check_availability with missing doctorId', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'check_availability',
            {
              // doctorId missing
              startDate: '2026-09-20T09:00:00Z',
              endDate: '2026-09-20T17:00:00Z',
            } as any,
            { userRole: 'PATIENT' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityValidationError);
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });

    it('rejects lookup_patient when tenantId is missing', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'lookup_patient',
            {
              identifier: { phone: '+1-555-0100' },
            } as any,
            { userRole: 'DOCTOR' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityValidationError);
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });

    it('rejects create_appointment when slotId is missing', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'create_appointment',
            {
              hospitalId: testHospital.id,
              doctorId: testDoctor.id,
              patientId: testPatient.id,
              idempotencyKey: 'some-key',
            } as any,
            { userRole: 'PATIENT' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityValidationError);
          return true;
        }
      );
    });

    it('rejects update_preferences with unsupported channel enum', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'update_preferences',
            {
              patientId: testPatient.id,
              preferences: {
                communicationChannel: 'telegram' as any, // Not in enum
              },
            },
            { userRole: 'PATIENT', patientId: testPatient.id }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityValidationError);
          return true;
        }
      );
    });

    it('rejects transfer_to_human with invalid reason enum', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'transfer_to_human',
            {
              conversationId: testConversation.id,
              reason: 'bored_patient' as any, // Invalid enum
            },
            { userRole: 'PATIENT' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityValidationError);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // SECTION 3: Authorization Boundary Enforcement (Role & Tenant Scoping)
  // =========================================================================
  describe('3. Authorization Boundary Enforcement (CapabilityUnauthorizedError)', () => {
    it('rejects send_notification when called by PATIENT role (role restriction)', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'send_notification',
            {
              recipientId: testPatient.id,
              recipientType: 'Patient',
              channel: 'sms',
              templateId: 'CONFIRMATION',
              payload: {},
            },
            { userRole: 'PATIENT', patientId: testPatient.id } // Patients cannot broadcast notifications
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityUnauthorizedError);
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('not permitted'));
          return true;
        }
      );
    });

    it('rejects start_workflow when called by PATIENT role (role restriction)', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'start_workflow',
            {
              workflowType: 'PreVisitQuestionnaire',
              triggerEvent: 'MANUAL',
              payload: {},
              idempotencyKey: 'test-wf-pat',
            },
            { userRole: 'PATIENT' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityUnauthorizedError);
          return true;
        }
      );
    });

    it('rejects cross-tenant execution: Hospital Admin of Hospital A cannot access Hospital B', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'search_doctors',
            { hospitalId: otherHospital.id },
            { userRole: 'HOSPITAL_ADMIN', hospitalId: testHospital.id } // Scoped to testHospital
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityUnauthorizedError);
          assert.ok(err.message.includes('Cross-tenant'));
          return true;
        }
      );
    });

    it('rejects patient privacy violation: Patient A cannot read Patient B appointment', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'get_appointment',
            { appointmentId: createdAppointmentId }, // Appointment belongs to testPatient
            { userRole: 'PATIENT', patientId: otherPatient.id } // otherPatient trying to read
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityUnauthorizedError);
          assert.ok(err.message.includes('another patient') || err.message.includes('Access denied'));
          return true;
        }
      );
    });

    it('rejects patient privacy violation: Patient A cannot lookup Patient B profile', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'lookup_patient',
            {
              identifier: { phone: otherPatient.phone },
              tenantId: testHospital.id,
            },
            { userRole: 'PATIENT', patientId: testPatient.id } // testPatient trying to read otherPatient
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityUnauthorizedError);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // SECTION 4: Idempotency Key Guarantees (4 Idempotent Capabilities)
  // =========================================================================
  describe('4. Idempotency Key Guarantees', () => {
    it('create_appointment: identical idempotency key returns cached result without duplicate booking', async () => {
      const fixedIdempotencyKey = `idem-test-dedup-${Date.now()}`;

      const input = {
        hospitalId: testHospital.id,
        doctorId: testDoctor.id,
        patientId: testPatient.id,
        slotId: testSlot3.id,
        reason: 'Follow-up consultation',
        idempotencyKey: fixedIdempotencyKey,
      };

      const caller = {
        userRole: 'PATIENT' as const,
        patientId: testPatient.id,
        hospitalId: testHospital.id,
      };

      // Call 1
      const res1 = await CapabilityRegistry.execute('create_appointment', input, caller);
      assert.ok(res1.appointmentId);

      // Call 2 with identical key
      const res2 = await CapabilityRegistry.execute('create_appointment', input, caller);
      assert.strictEqual(res2.appointmentId, res1.appointmentId, 'Must return same appointment ID');
      assert.strictEqual(res2.status, res1.status);

      // Verify in DB only 1 appointment with this key exists
      const count = await prisma.appointment.count({
        where: { idempotencyKey: fixedIdempotencyKey },
      });
      assert.strictEqual(count, 1, 'Only exactly 1 appointment row must be created in DB');
    });

    it('reschedule_appointment: identical idempotency key returns cached result', async () => {
      const fixedKey = `idem-resched-dedup-${Date.now()}`;

      // First create an appointment to reschedule
      const appt = await prisma.appointment.create({
        data: {
          hospitalId: testHospital.id,
          doctorId: testDoctor.id,
          patientId: testPatient.id,
          slotId: testSlot4.id,
          startTime: testSlot4.startTime,
          endTime: testSlot4.endTime,
          status: 'Confirmed',
          idempotencyKey: `idem-setup-${Date.now()}`,
        },
      });

      const input = {
        appointmentId: appt.id,
        newSlotId: testSlot5.id,
        idempotencyKey: fixedKey,
      };

      const caller = { userRole: 'DOCTOR' as const, hospitalId: testHospital.id };
      const res1 = await CapabilityRegistry.execute('reschedule_appointment', input, caller);
      const res2 = await CapabilityRegistry.execute('reschedule_appointment', input, caller);

      assert.strictEqual(res1.appointmentId, res2.appointmentId);
      assert.strictEqual(res1.newStartTime, res2.newStartTime);
    });

    it('cancel_appointment: identical idempotency key returns cached result', async () => {
      const fixedKey = `idem-cancel-dedup-${Date.now()}`;

      const appt = await prisma.appointment.create({
        data: {
          hospitalId: testHospital.id,
          doctorId: testDoctor.id,
          patientId: testPatient.id,
          slotId: testSlot5.id,
          startTime: testSlot5.startTime,
          endTime: testSlot5.endTime,
          status: 'Confirmed',
          idempotencyKey: `idem-setup-c-${Date.now()}`,
        },
      });

      const input = {
        appointmentId: appt.id,
        reason: 'Duplicate cancellation test',
        idempotencyKey: fixedKey,
      };

      const caller = { userRole: 'PATIENT' as const, patientId: testPatient.id };
      const res1 = await CapabilityRegistry.execute('cancel_appointment', input, caller);
      const res2 = await CapabilityRegistry.execute('cancel_appointment', input, caller);

      assert.strictEqual(res1.status, 'Cancelled');
      assert.strictEqual(res2.status, 'Cancelled');
      assert.strictEqual(res1.appointmentId, res2.appointmentId);
    });

    it('send_notification: identical idempotency key returns cached delivery confirmation', async () => {
      const fixedKey = `idem-notif-dedup-${Date.now()}`;
      const input = {
        recipientId: testPatient.id,
        recipientType: 'Patient' as const,
        channel: 'sms' as const,
        templateId: 'GREETING',
        payload: { text: 'Hello' },
        idempotencyKey: fixedKey,
      };

      const caller = { userRole: 'SYSTEM' as const };
      const res1 = await CapabilityRegistry.execute('send_notification', input, caller);
      const res2 = await CapabilityRegistry.execute('send_notification', input, caller);

      assert.strictEqual(res1.notificationId, res2.notificationId);
      assert.strictEqual(res1.status, 'Delivered');
      assert.strictEqual(res2.status, 'Delivered');
    });
  });

  // =========================================================================
  // SECTION 5: Structured Errors (NotFound, Conflict, ExternalFailure)
  // =========================================================================
  describe('5. Distinct Structured Error Types', () => {
    it('CapabilityNotFoundError: throws when appointment does not exist', async () => {
      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'get_appointment',
            { appointmentId: 'non-existent-uuid-12345' },
            { userRole: 'SYSTEM' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityNotFoundError);
          assert.strictEqual(err.statusCode, 404);
          return true;
        }
      );
    });

    it('CapabilityConflictError: throws when rescheduling an already cancelled appointment', async () => {
      const cancelledAppt = await prisma.appointment.create({
        data: {
          hospitalId: testHospital.id,
          doctorId: testDoctor.id,
          patientId: testPatient.id,
          slotId: testSlot5.id,
          startTime: testSlot5.startTime,
          endTime: testSlot5.endTime,
          status: 'Cancelled',
          idempotencyKey: `idem-conflict-${Date.now()}`,
        },
      });

      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'reschedule_appointment',
            {
              appointmentId: cancelledAppt.id,
              newSlotId: testSlot1.id,
            },
            { userRole: 'SYSTEM' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityConflictError);
          assert.strictEqual(err.statusCode, 409);
          return true;
        }
      );
    });

    it('CapabilityExternalFailureError: throws when external EHR fails', async () => {
      const failingConnector = new StubEhrConnector();
      failingConnector.setSimulatedFailure(true);
      CapabilityRegistry.setHealthcareConnector(failingConnector);

      // Create a dedicated slot for failure test within doctor working hours
      const failSlotTime = new Date(baseDate.getTime() + 6 * 3600000); // 15:00 on weekday
      const failSlotEndTime = new Date(failSlotTime.getTime() + 30 * 60000);
      const failSlot = await prisma.slot.upsert({
        where: {
          doctorId_startTime: {
            doctorId: testDoctor.id,
            startTime: failSlotTime,
          },
        },
        update: { isBooked: false, isBlocked: false },
        create: {
          doctorId: testDoctor.id,
          hospitalId: testHospital.id,
          startTime: failSlotTime,
          endTime: failSlotEndTime,
          isBooked: false,
          isBlocked: false,
        },
      });

      await assert.rejects(
        async () => {
          await CapabilityRegistry.execute(
            'create_appointment',
            {
              hospitalId: testHospital.id,
              doctorId: testDoctor.id,
              patientId: testPatient.id,
              slotId: failSlot.id,
              idempotencyKey: `idem-fail-${Date.now()}`,
            },
            { userRole: 'SYSTEM' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof CapabilityExternalFailureError);
          assert.strictEqual(err.statusCode, 502);
          assert.strictEqual(err.externalSystem, 'STUB_EHR');
          return true;
        }
      );

      // Restore healthy connector
      CapabilityRegistry.setHealthcareConnector(new StubEhrConnector());
    });
  });

  // =========================================================================
  // SECTION 6: Privacy-Preserving Audit Log Verification (PRD Section 21)
  // =========================================================================
  describe('6. Privacy-Preserving Audit Events (PRD Section 21)', () => {
    it('records audit events on execution with sanitized/masked PII and health data', async () => {
      const correlationId = `corr-audit-${Date.now()}`;

      // Call lookup_patient with a phone number and correlationId
      await CapabilityRegistry.execute(
        'lookup_patient',
        {
          identifier: { phone: '+1-555-0100' },
          tenantId: testHospital.id,
        },
        {
          userRole: 'DOCTOR',
          hospitalId: testHospital.id,
          correlationId,
        }
      );

      // Verify audit event exists in database
      const auditLog = await prisma.auditEvent.findFirst({
        where: {
          action: 'CAPABILITY_LOOKUP_PATIENT',
          correlationId,
        },
        orderBy: { timestamp: 'desc' },
      });

      assert.ok(auditLog, 'Audit event CAPABILITY_LOOKUP_PATIENT must be recorded');
      assert.strictEqual(auditLog.hospitalId, testHospital.id);

      // Verify PII is NOT stored in raw form in audit payload
      const details = JSON.parse(auditLog.detailsJson || '{}');
      assert.ok(details.inputSummary, 'Input summary must exist in audit log');
      assert.strictEqual(details.status, 'SUCCESS');

      // The phone should be masked (e.g. +1-***-***-0100)
      const inputStr = JSON.stringify(details.inputSummary);
      assert.ok(!inputStr.includes('+1-555-0100'), 'Raw phone number must not appear in audit log');
      assert.ok(inputStr.includes('***'), 'Masked phone number must appear in audit log');
    });

    it('masks health notes and clinical reasons in audit events', async () => {
      const correlationId = `corr-audit-notes-${Date.now()}`;
      const privateMedicalReason = 'Patient has persistent chest pain with shortness of breath';

      await CapabilityRegistry.execute(
        'transfer_to_human',
        {
          conversationId: testConversation.id,
          reason: 'clinical_inquiry',
          notes: privateMedicalReason,
        },
        {
          userRole: 'PATIENT',
          patientId: testPatient.id,
          correlationId,
        }
      );

      const auditLog = await prisma.auditEvent.findFirst({
        where: {
          action: 'CAPABILITY_TRANSFER_TO_HUMAN',
          correlationId,
        },
        orderBy: { timestamp: 'desc' },
      });

      assert.ok(auditLog, 'Audit event CAPABILITY_TRANSFER_TO_HUMAN must be recorded');
      const details = JSON.parse(auditLog.detailsJson || '{}');
      const inputStr = JSON.stringify(details.inputSummary);

      // Raw medical narrative must be redacted
      assert.ok(
        !inputStr.includes(privateMedicalReason),
        'Raw medical narrative must be redacted in audit log'
      );
      assert.ok(
        inputStr.includes('[REDACTED_TEXT'),
        'Redacted marker must be present in audit log for sensitive notes'
      );
    });
  });
});
