import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import {
  CapabilityRegistry,
  PatientAccessAgent,
  ConversationContextManager,
} from '@health/capabilities';
import { MockEhrConnector, IdentifierMapper } from '@health/integration';
import { RecoveryStateMachine } from '@health/verification';
import { SchedulingService, SlotCalculator } from '@health/scheduling';
import {
  WorkflowQueueManager,
  processWorkflowJob,
} from '@health/workflows';

describe('Consolidated PRD Full Integration Test Suite', () => {
  let patientId: string;
  let doctorId: string;
  let hospitalId: string;
  let specialty: string;
  let ehrServer: FastifyInstance | null = null;
  const ehrAppointments = new Map<string, any>();

  before(async () => {
    // 1. Ensure Mock EHR is listening on port 4000
    try {
      const ping = await fetch('http://localhost:4000/health');
      if (!ping.ok) throw new Error('Not running');
    } catch {
      ehrServer = Fastify({ logger: false });
      await ehrServer.register(cors);

      ehrServer.get('/health', async () => ({ status: 'UP', service: 'mock-ehr' }));

      ehrServer.get('/api/providers', async () => [
        { id: 'EXT-DOC-001', name: 'Dr. Arvind Rao', specialty: 'Orthopedics' },
      ]);

      ehrServer.get('/api/patients', async () => ({
        id: 'EXT-PAT-001',
        name: 'John Doe',
      }));

      ehrServer.post('/api/appointments', async (req: any, reply: any) => {
        const extId = `EXT-EHR-APPT-${crypto.randomUUID().slice(0, 8)}`;
        const appt = {
          id: extId,
          ...req.body,
          status: 'CONFIRMED',
          verified: true,
          createdAt: new Date().toISOString(),
        };
        ehrAppointments.set(extId, appt);
        ehrAppointments.set(req.body.internalAppointmentId, appt);
        return reply.status(201).send(appt);
      });

      ehrServer.get('/api/appointments/:id', async (req: any, reply: any) => {
        const appt = ehrAppointments.get(req.params.id);
        if (!appt) return reply.status(404).send({ error: 'not found' });
        return appt;
      });

      ehrServer.get('/api/appointments/query', async (req: any, reply: any) => {
        const appt = ehrAppointments.get(req.query.internalId);
        if (!appt) return reply.status(404).send({ error: 'not found' });
        return appt;
      });

      ehrServer.put('/api/appointments/:id', async (req: any) => {
        const existing = ehrAppointments.get(req.params.id) || {};
        const updated = { ...existing, ...req.body, status: 'CONFIRMED' };
        ehrAppointments.set(req.params.id, updated);
        return updated;
      });

      ehrServer.delete('/api/appointments/:id', async (req: any) => {
        ehrAppointments.delete(req.params.id);
        return { success: true };
      });

      await ehrServer.listen({ port: 4000, host: '0.0.0.0' });
    }

    // 2. Fetch or seed test entities
    const patient = await prisma.patient.findFirst();
    const doctor = await prisma.doctor.findFirst();
    assert.ok(patient && doctor, 'Test prerequisites: patient and doctor must exist in DB');

    patientId = patient.id;
    doctorId = doctor.id;
    hospitalId = doctor.hospitalId;
    specialty = doctor.specialty || 'Orthopedics';

    // 3. Inject MockEhrConnector into CapabilityRegistry
    CapabilityRegistry.setConnector(new MockEhrConnector('http://localhost:4000'));
  });

  after(async () => {
    if (ehrServer) {
      await ehrServer.close();
    }
  });

  // Helper to ensure an available slot exists and strictly aligns with doctor working hours
  async function getOrCreateAvailableSlot() {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { calendar: { include: { workingHours: true } } },
    });
    assert.ok(doctor && doctor.calendar);
    const workingHours = doctor.calendar.workingHours || [];

    // Check existing unbooked slots that also satisfy working hours
    const candidates = await prisma.slot.findMany({
      where: { doctorId, isBooked: false, isBlocked: false },
      orderBy: { startTime: 'asc' },
    });

    for (const cand of candidates) {
      if (SlotCalculator.isWithinWorkingHours(cand.startTime, cand.endTime, workingHours)) {
        return cand;
      }
    }

    // Create a new slot explicitly aligned with configured working hours
    const wh = workingHours[0];
    assert.ok(wh, 'Doctor working hours must exist');
    const [startH, startM] = wh.startTime.split(':').map(Number);

    const d = new Date();
    d.setDate(d.getDate() + ((wh.dayOfWeek - d.getDay() + 7) % 7 || 7));
    d.setHours(startH, startM, 0, 0);

    let testStartTime = new Date(d);
    while (
      (await prisma.slot.findFirst({ where: { doctorId, startTime: testStartTime } })) ||
      !SlotCalculator.isWithinWorkingHours(
        testStartTime,
        new Date(testStartTime.getTime() + 30 * 60 * 1000),
        workingHours
      )
    ) {
      testStartTime = new Date(testStartTime.getTime() + 30 * 60 * 1000);
      if (testStartTime.getHours() >= 17) {
        testStartTime.setDate(testStartTime.getDate() + 1);
        testStartTime.setHours(startH, startM, 0, 0);
      }
    }
    const testEndTime = new Date(testStartTime.getTime() + 30 * 60 * 1000);

    return await prisma.slot.create({
      data: {
        doctorId,
        hospitalId,
        startTime: testStartTime,
        endTime: testEndTime,
        isBooked: false,
        isBlocked: false,
      },
    });
  }

  // ===========================================================================
  // AREA 1: EHR & RECOVERY (PRD Sections 12-13, 28)
  // ===========================================================================
  describe('Area 1: EHR Integration & Recovery Wiring', () => {
    it('1.1 create_appointment routes through EHR -> verified -> synchronized -> Confirmed + populates all 4 mappings', async () => {
      const slot = await getOrCreateAvailableSlot();
      const correlationId = crypto.randomUUID();
      const idempotencyKey = crypto.randomUUID();

      const result = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          reason: 'Routine checkup via PRD integration test',
          idempotencyKey,
        },
        {
          actorRole: 'PATIENT',
          patientId,
          tenantId: hospitalId,
          correlationId,
        }
      );

      // Verify returned status is Confirmed
      assert.strictEqual(result.status, AppointmentStatus.CONFIRMED);
      assert.ok(result.appointmentId);
      assert.ok(result.externalAppointmentId);

      // Verify in DB that status is Confirmed and slot is booked
      const apptDb = await prisma.appointment.findUnique({ where: { id: result.appointmentId } });
      assert.strictEqual(apptDb?.status, AppointmentStatus.CONFIRMED);

      const slotDb = await prisma.slot.findUnique({ where: { id: slot.id } });
      assert.strictEqual(slotDb?.isBooked, true);

      // Verify all 4 external identifier mappings exist in DB
      const extPat = await IdentifierMapper.getExternalId(hospitalId, 'PATIENT', patientId);
      const extDoc = await IdentifierMapper.getExternalId(hospitalId, 'DOCTOR', doctorId);
      const extFac = await IdentifierMapper.getExternalId(hospitalId, 'FACILITY', hospitalId);
      const extAppt = await IdentifierMapper.getExternalId(hospitalId, 'APPOINTMENT', result.appointmentId);

      assert.ok(extPat, 'PATIENT external mapping must be populated');
      assert.ok(extDoc, 'DOCTOR external mapping must be populated');
      assert.ok(extFac, 'FACILITY external mapping must be populated');
      assert.ok(extAppt, 'APPOINTMENT external mapping must be populated');
      assert.strictEqual(extAppt, result.externalAppointmentId);
    });

    it('1.2 reschedule_appointment routes through EHR -> verified -> synchronized -> new slot confirmed & old slot released', async () => {
      const initialSlot = await getOrCreateAvailableSlot();
      // Ensure second slot
      await prisma.slot.update({ where: { id: initialSlot.id }, data: { isBooked: true } });
      const newSlot = await getOrCreateAvailableSlot();
      await prisma.slot.update({ where: { id: initialSlot.id }, data: { isBooked: false } });

      // Create initial appointment
      const initialAppt = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId,
          hospitalId,
          slotId: initialSlot.id,
          reason: 'Initial appointment before reschedule',
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      assert.strictEqual(initialAppt.status, AppointmentStatus.CONFIRMED);

      // Reschedule to new slot
      const rescheduleResult = await CapabilityRegistry.execute(
        'reschedule_appointment',
        {
          appointmentId: initialAppt.appointmentId,
          newSlotId: newSlot.id,
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      assert.strictEqual(rescheduleResult.status, AppointmentStatus.CONFIRMED);
      assert.strictEqual(rescheduleResult.oldSlotReleased, true);

      // Verify DB: old slot is released, new slot is booked
      const oldSlotDb = await prisma.slot.findUnique({ where: { id: initialSlot.id } });
      const newSlotDb = await prisma.slot.findUnique({ where: { id: newSlot.id } });
      assert.strictEqual(oldSlotDb?.isBooked, false, 'Old slot must be released');
      assert.strictEqual(newSlotDb?.isBooked, true, 'New slot must be booked');

      // Verify appointment record points to new slot
      const updatedAppt = await prisma.appointment.findUnique({ where: { id: initialAppt.appointmentId } });
      assert.strictEqual(updatedAppt?.slotId, newSlot.id);
      assert.strictEqual(updatedAppt?.status, AppointmentStatus.CONFIRMED);
    });

    it('1.3 cancel_appointment routes through EHR -> releases slot -> synchronized to CANCELLED', async () => {
      const slot = await getOrCreateAvailableSlot();

      const appt = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          reason: 'Appointment to cancel',
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      // Cancel appointment
      const cancelResult = await CapabilityRegistry.execute(
        'cancel_appointment',
        {
          appointmentId: appt.appointmentId,
          reason: 'Patient cancellation request',
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      assert.strictEqual(cancelResult.status, AppointmentStatus.CANCELLED);
      assert.strictEqual(cancelResult.slotReleased, true);

      // Verify DB state
      const slotDb = await prisma.slot.findUnique({ where: { id: slot.id } });
      assert.strictEqual(slotDb?.isBooked, false, 'Slot must be released');

      const apptDb = await prisma.appointment.findUnique({ where: { id: appt.appointmentId } });
      assert.strictEqual(apptDb?.status, AppointmentStatus.CANCELLED);
    });

    it('1.4 Section 28 Scenario A: Timeout -> retry -> verified -> synchronized -> confirmed', async () => {
      const slot = await getOrCreateAvailableSlot();

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          startTime: new Date(),
          endTime: new Date(Date.now() + 30 * 60 * 1000),
          status: AppointmentStatus.PENDING,
        },
      });

      const mockConnector = new MockEhrConnector('http://localhost:4000');
      mockConnector.verifyAppointment = async () => ({
        isVerified: false,
        externalStatus: 'NOT_FOUND',
        match: false,
      });

      let createCalls = 0;
      mockConnector.createAppointment = async (payload) => {
        createCalls++;
        return {
          externalAppointmentId: `EXT-SCENARIO-A-${payload.internalAppointmentId.slice(0, 8)}`,
          status: 'CONFIRMED',
          verified: true,
          createdAt: new Date().toISOString(),
        };
      };

      const recoveryMachine = new RecoveryStateMachine(mockConnector);
      const outcome = await recoveryMachine.handleUnknownOutcome(
        appointment.id,
        hospitalId,
        {
          internalAppointmentId: appointment.id,
          externalPatientId: 'EXT-PAT-001',
          externalProviderId: 'EXT-DOC-001',
          startTime: appointment.startTime.toISOString(),
          endTime: appointment.endTime.toISOString(),
        },
        2
      );

      assert.strictEqual(outcome.recovered, true);
      assert.strictEqual(outcome.status, AppointmentStatus.CONFIRMED);
      assert.strictEqual(createCalls, 1, 'Retry call made exactly once');

      const updated = await prisma.appointment.findUnique({ where: { id: appointment.id } });
      assert.strictEqual(updated?.status, AppointmentStatus.CONFIRMED);
    });

    it('1.5 Section 28 Scenario B: Network timeout -> unknown outcome -> query EHR -> found -> synchronize with NO duplicate created', async () => {
      const beforeCount = await prisma.appointment.count({ where: { patientId, doctorId } });
      const slot = await getOrCreateAvailableSlot();

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          startTime: new Date(),
          endTime: new Date(Date.now() + 30 * 60 * 1000),
          status: AppointmentStatus.PENDING,
        },
      });

      let externalCreateCount = 0;
      const mockConnector = new MockEhrConnector('http://localhost:4000');
      mockConnector.createAppointment = async () => {
        externalCreateCount++;
        return {
          externalAppointmentId: 'EXT-DUPLICATE-NEVER',
          status: 'CONFIRMED',
          verified: true,
          createdAt: new Date().toISOString(),
        };
      };

      // Mock verify finds the existing appointment in EHR
      mockConnector.verifyAppointment = async () => ({
        isVerified: true,
        externalStatus: 'CONFIRMED',
        match: true,
      });

      const recoveryMachine = new RecoveryStateMachine(mockConnector);
      const outcome = await recoveryMachine.handleUnknownOutcome(
        appointment.id,
        hospitalId,
        {
          internalAppointmentId: appointment.id,
          externalPatientId: 'EXT-PAT-001',
          externalProviderId: 'EXT-DOC-001',
          startTime: appointment.startTime.toISOString(),
          endTime: appointment.endTime.toISOString(),
        }
      );

      assert.strictEqual(outcome.recovered, true);
      assert.strictEqual(outcome.status, AppointmentStatus.CONFIRMED);
      assert.ok(outcome.notes.includes('Avoided duplicate booking creation'));

      // Assert NO duplicate calls made
      assert.strictEqual(externalCreateCount, 0, 'No mutating createAppointment call made because external record was found');

      // Assert NO duplicate DB appointments created
      const afterCount = await prisma.appointment.count({ where: { patientId, doctorId } });
      assert.strictEqual(afterCount, beforeCount + 1, 'Exactly one internal appointment exists');
    });

    it('1.6 Section 28 Scenario C: Retries exhausted -> Reconciliation Record created -> human escalation', async () => {
      const slot = await getOrCreateAvailableSlot();

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          startTime: new Date(),
          endTime: new Date(Date.now() + 30 * 60 * 1000),
          status: AppointmentStatus.PENDING,
        },
      });

      const mockConnector = new MockEhrConnector('http://localhost:4000');
      mockConnector.verifyAppointment = async () => ({
        isVerified: false,
        externalStatus: 'NOT_FOUND',
        match: false,
      });
      mockConnector.createAppointment = async () => {
        throw new Error('EHR_SERVER_ERROR_503');
      };

      const recoveryMachine = new RecoveryStateMachine(mockConnector);
      const outcome = await recoveryMachine.handleUnknownOutcome(
        appointment.id,
        hospitalId,
        {
          internalAppointmentId: appointment.id,
          externalPatientId: 'EXT-PAT-001',
          externalProviderId: 'EXT-DOC-001',
          startTime: appointment.startTime.toISOString(),
          endTime: appointment.endTime.toISOString(),
        },
        1
      );

      assert.strictEqual(outcome.recovered, false);
      assert.strictEqual(outcome.status, AppointmentStatus.RECONCILIATION_REQUIRED);
      assert.ok(outcome.reconciliationRecordId);

      const recRecord = await prisma.reconciliationRecord.findUnique({
        where: { id: outcome.reconciliationRecordId },
      });
      assert.ok(recRecord);
      assert.strictEqual(recRecord.status, 'OPEN');
      assert.strictEqual(recRecord.escalatedTo, 'PlatformOperationsDesk');
    });
  });

  // ===========================================================================
  // AREA 2: PRE-VISIT QUESTIONNAIRES (PRD Section 15 & 20)
  // ===========================================================================
  describe('Area 2: Pre-Visit Questionnaires & AI Conversational Intake', () => {
    let multiTypeQuestionnaireId: string;
    let doctorSpecificQuestionnaireId: string;

    before(async () => {
      // Clean up existing test questionnaires for clean assertions
      await prisma.questionnaireQuestion.deleteMany({
        where: { questionnaire: { hospitalId } },
      });
      await prisma.questionnaire.deleteMany({
        where: { hospitalId },
      });

      // 1. Create a questionnaire supporting all Section 15 question types:
      // yes/no, choice, multiple choice, numeric, date, short text, long text, structured fields
      const q = await prisma.questionnaire.create({
        data: {
          hospitalId,
          specialty,
          title: 'Comprehensive Intake Assessment',
          description: 'Standard multi-type clinical intake',
          questions: {
            create: [
              {
                text: 'Have you had this medical condition before?',
                type: 'yes_no',
                required: true,
                orderIndex: 0,
              },
              {
                text: 'Please rate your current discomfort on a scale of 1 to 10.',
                type: 'numeric',
                required: true,
                orderIndex: 1,
              },
              {
                text: 'What is the primary location of discomfort?',
                type: 'choice',
                required: true,
                optionsJson: JSON.stringify(['Left Knee', 'Right Knee', 'Left Shoulder', 'Right Shoulder']),
                orderIndex: 2,
              },
              {
                text: 'Select any associated symptoms you are currently experiencing.',
                type: 'multiple_choice',
                required: false,
                optionsJson: JSON.stringify(['Swelling', 'Stiffness', 'Numbness', 'None']),
                orderIndex: 3,
              },
              {
                text: 'Approximate date when you first noticed symptoms:',
                type: 'date',
                required: false,
                orderIndex: 4,
              },
              {
                text: 'Briefly state your primary goal for today:',
                type: 'short_text',
                required: true,
                orderIndex: 5,
              },
              {
                text: 'Describe any additional medical context or history:',
                type: 'long_text',
                required: false,
                orderIndex: 6,
              },
              {
                text: 'Emergency Contact information (name, phone, relation):',
                type: 'structured',
                required: false,
                orderIndex: 7,
              },
            ],
          },
        },
        include: { questions: true },
      });
      multiTypeQuestionnaireId = q.id;

      // 2. Create a doctor-specific questionnaire to test hierarchical resolution
      const docQ = await prisma.questionnaire.create({
        data: {
          hospitalId,
          doctorId,
          title: `Dr. Rao Specialized Orthopedic Intake`,
          questions: {
            create: [
              {
                text: 'Has this issue affected your ability to walk or bear weight?',
                type: 'yes_no',
                required: true,
                orderIndex: 0,
              },
              {
                text: 'Please describe the pain characteristics in your own words:',
                type: 'long_text',
                required: true,
                orderIndex: 1,
              },
            ],
          },
        },
      });
      doctorSpecificQuestionnaireId = docQ.id;
    });

    it('2.1 Multi-type question configuration & retrieval supports all PRD Section 15 formats', async () => {
      const qResult = await CapabilityRegistry.execute(
        'get_questionnaire',
        { hospitalId, specialty },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      assert.ok(qResult.questionnaire);
      const schema = qResult.questionnaire.schema;
      assert.strictEqual(schema.length, 8, 'All 8 question types must be present');

      const types = schema.map((s: any) => s.type);
      assert.ok(types.includes('yes_no'), 'yes_no supported');
      assert.ok(types.includes('numeric'), 'numeric supported');
      assert.ok(types.includes('choice'), 'choice supported');
      assert.ok(types.includes('multiple_choice'), 'multiple_choice supported');
      assert.ok(types.includes('date'), 'date supported');
      assert.ok(types.includes('short_text'), 'short_text supported');
      assert.ok(types.includes('long_text'), 'long_text supported');
      assert.ok(types.includes('structured'), 'structured supported');

      // Check choice options
      const choiceQ = schema.find((s: any) => s.type === 'choice');
      assert.deepStrictEqual(choiceQ.options, ['Left Knee', 'Right Knee', 'Left Shoulder', 'Right Shoulder']);
    });

    it('2.2 Hierarchical resolution: doctor-specific > appointmentType > specialty > hospital default', async () => {
      // When doctorId is specified, the doctor-specific questionnaire takes precedence
      const docSpecific = await CapabilityRegistry.execute(
        'get_questionnaire',
        { hospitalId, doctorId },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );
      assert.strictEqual(docSpecific.questionnaire.id, doctorSpecificQuestionnaireId);

      // When only specialty is specified, the specialty questionnaire is resolved
      const specialtyQ = await CapabilityRegistry.execute(
        'get_questionnaire',
        { hospitalId, specialty },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );
      assert.strictEqual(specialtyQ.questionnaire.id, multiTypeQuestionnaireId);
    });

    it('2.3 Conversational AI intake: Agent guides patient through configured questions and saves structured responses', async () => {
      const slot = await getOrCreateAvailableSlot();

      const appt = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          reason: 'Intake test appointment',
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      // 2. Initialize PatientAccessAgent with conversational context
      const conversationId = `conv-intake-${Date.now()}`;
      const agent = new PatientAccessAgent({
        conversationId,
        patientId,
        hospitalId,
      });

      // Seed context as having just booked and awaiting questionnaire
      await ConversationContextManager.updateContext(conversationId, {
        currentIntent: 'COMPLETING_QUESTIONNAIRE',
        activeAppointmentId: appt.appointmentId,
        selectedDoctorId: doctorId,
        selectedHospitalId: hospitalId,
      });

      // Turn 1: Patient agrees to answer questions
      const turn1 = await agent.processTurn('Yes, I am ready to answer the questions');
      assert.ok(turn1.spokenText.includes('Question 1'));
      assert.ok(turn1.spokenText.includes('ability to walk or bear weight'));

      // Turn 2: Patient answers Question 1
      const turn2 = await agent.processTurn('No, I can still walk with mild discomfort');
      assert.ok(turn2.spokenText.includes('Question 2'));
      assert.ok(turn2.spokenText.includes('pain characteristics'));

      // Turn 3: Patient answers Question 2 (final question for Dr. Rao's questionnaire)
      const turn3 = await agent.processTurn('It is a dull ache that worsens in the evening');
      assert.ok(turn3.spokenText.includes('Thank you! Your responses have been saved'));
      assert.strictEqual(turn3.capabilityCalled, 'submit_questionnaire');

      // Verify DB contains QuestionnaireResponse linked to appointment
      const qResponse = await prisma.questionnaireResponse.findFirst({
        where: { appointmentId: appt.appointmentId },
      });
      assert.ok(qResponse, 'QuestionnaireResponse must be saved in database');
      const parsedAnswers = JSON.parse((qResponse as any).answersJson);
      assert.ok(Object.values(parsedAnswers).some((v: any) => String(v).includes('mild discomfort')));
      assert.ok(Object.values(parsedAnswers).some((v: any) => String(v).includes('dull ache')));
      assert.strictEqual(qResponse.flaggedUrgent, false);
    });

    it('2.4 Guardrails: Agent strictly refuses clinical diagnostic questions and medication advice', async () => {
      const conversationId = `conv-guardrail-${Date.now()}`;
      const agent = new PatientAccessAgent({
        conversationId,
        patientId,
        hospitalId,
      });

      // Test clinical inquiry 1: Drug/medication recommendation
      const turn1 = await agent.processTurn('What medication or antibiotics should I take for this pain?');
      assert.strictEqual(turn1.intentDetected, 'CLINICAL_INQUIRY');
      assert.strictEqual(turn1.transferredToHuman, true);
      assert.ok(turn1.spokenText.includes('not permitted to provide medical diagnoses, suggest treatments, prescribe medication'));

      // Test clinical inquiry 2: Clinical diagnosis request
      const turn2 = await agent.processTurn('Do I have a heart attack or a bone fracture?');
      assert.strictEqual(turn2.intentDetected, 'CLINICAL_INQUIRY');
      assert.strictEqual(turn2.transferredToHuman, true);
      assert.ok(turn2.spokenText.includes('immediately connecting you with a licensed clinical staff member'));
    });

    it('2.5 Naive keyword-triggered escalation of flagged/urgent free-text answers', async () => {
      const slot = await getOrCreateAvailableSlot();

      const appt = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          reason: 'Urgent symptom test appointment',
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      // Submit questionnaire with urgent administrative trigger keyword ("chest pain")
      const submitResult = await CapabilityRegistry.execute(
        'submit_questionnaire',
        {
          questionnaireId: doctorSpecificQuestionnaireId,
          appointmentId: appt.appointmentId,
          patientId,
          responses: {
            walking_status: 'No, having difficulty',
            symptom_details: 'I also started having sudden sharp chest pain radiating to my shoulder',
          },
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      assert.strictEqual(submitResult.flaggedUrgent, true);
      assert.ok(submitResult.flaggedReason?.includes('chest pain'));

      // Verify DB: QuestionnaireResponse is flaggedUrgent
      const responseInDb = await prisma.questionnaireResponse.findFirst({
        where: { appointmentId: appt.appointmentId },
      });
      assert.ok(responseInDb);
      assert.strictEqual(responseInDb.flaggedUrgent, true);
      assert.ok(responseInDb.flaggedReason?.includes('chest pain'));

      // Verify urgent notification emitted for administrative review
      const urgentNotif = await prisma.notification.findFirst({
        where: {
          hospitalId,
          templateId: 'URGENT_QUESTIONNAIRE_ALERT',
        },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(urgentNotif, 'Urgent administrative notification must be created');
      assert.ok(urgentNotif.payloadJson.includes('chest pain'));
    });
  });

  // ===========================================================================
  // AREA 3: WORKFLOWS & NOTIFICATIONS (PRD Sections 16-17)
  // ===========================================================================
  describe('Area 3: Workflows & Multi-Channel Notifications', () => {
    it('3.1 Async workflow primitives: records execution history (Active -> Running -> Completed), idempotency & retries', async () => {
      const executionId = crypto.randomUUID();
      const jobData = {
        workflowExecutionId: executionId,
        workflowType: 'PreVisitQuestionnaire' as const,
        hospitalId,
        payload: { test: true },
        maxAttempts: 3,
        attemptCount: 0,
      };

      // Enqueue job
      await WorkflowQueueManager.enqueue(jobData);

      const createdExecution = await prisma.workflowExecution.findUnique({
        where: { id: executionId },
      });
      assert.ok(createdExecution, 'Execution history record must be created in DB');
      assert.strictEqual(createdExecution.status, 'Active');

      // Process job synchronously via simulated execution
      await processWorkflowJob(jobData);

      const completedExecution = await prisma.workflowExecution.findUnique({
        where: { id: executionId },
      });
      assert.strictEqual(completedExecution?.status, 'Completed');
      assert.ok(completedExecution?.executedAt);

      // Test Retry logic with a failing job
      const failExecutionId = crypto.randomUUID();
      const failJobData = {
        workflowExecutionId: failExecutionId,
        workflowType: 'EhrOperation' as const,
        hospitalId,
        payload: {
          event: 'SIMULATED_FAILURE',
        },
        maxAttempts: 2,
        attemptCount: 0,
      };

      await WorkflowQueueManager.enqueue(failJobData);
      await processWorkflowJob(failJobData);

      const retriedExecution = await prisma.workflowExecution.findUnique({
        where: { id: failExecutionId },
      });
      assert.strictEqual(retriedExecution?.status, 'Retried');
      assert.strictEqual(retriedExecution?.attemptCount, 1);
      assert.ok(retriedExecution?.error?.includes('SIMULATED_WORKFLOW_FAILURE'));
    });

    it('3.2 Condition check: AppointmentReminder evaluates APPOINTMENT_NOT_CANCELLED and skips if cancelled', async () => {
      const slot = await getOrCreateAvailableSlot();

      // 1. Create and then cancel an appointment
      const appt = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          startTime: new Date(),
          endTime: new Date(Date.now() + 30 * 60 * 1000),
          status: AppointmentStatus.CANCELLED,
        },
      });

      const reminderExecutionId = crypto.randomUUID();
      const reminderJob = {
        workflowExecutionId: reminderExecutionId,
        workflowType: 'AppointmentReminder' as const,
        hospitalId,
        appointmentId: appt.id,
        condition: 'APPOINTMENT_NOT_CANCELLED',
        payload: { appointmentId: appt.id },
      };

      await WorkflowQueueManager.enqueue(reminderJob, { delayMs: 86400000 });

      // Fast-forward simulated execution of reminder
      await processWorkflowJob(reminderJob);

      // Verify execution was cancelled due to condition failure
      const exec = await prisma.workflowExecution.findUnique({ where: { id: reminderExecutionId } });
      assert.strictEqual(exec?.status, 'Cancelled');

      // Verify NO reminder notification was sent
      const notif = await prisma.notification.findFirst({
        where: {
          recipientId: patientId,
          templateId: 'APPOINTMENT_REMINDER_24H',
          payloadJson: { contains: appt.id },
        },
      });
      assert.strictEqual(notif, null, 'No reminder notification sent for cancelled appointment');
    });

    it('3.3 Core loop: Confirmed -> questionnaire assigned -> reminder scheduled -> simulated wait -> patient notified -> response -> doctor visible', async () => {
      const slot = await getOrCreateAvailableSlot();

      // 1. Book appointment (fires AppointmentConfirmed / PreVisitQuestionnaire post-booking)
      const booking = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          reason: 'End-to-end workflow core loop test',
          idempotencyKey: crypto.randomUUID(),
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      assert.strictEqual(booking.status, AppointmentStatus.CONFIRMED);

      // 2. Simulate execution of AppointmentConfirmed workflow
      const confirmedExecutionId = crypto.randomUUID();
      await processWorkflowJob({
        workflowExecutionId: confirmedExecutionId,
        workflowType: 'AppointmentConfirmed',
        hospitalId,
        appointmentId: booking.appointmentId,
        payload: {
          appointmentId: booking.appointmentId,
          doctorId,
          patientId,
          startTime: booking.startTime,
        },
      });

      // Assert Patient received PRE_VISIT_QUESTIONNAIRE_ASSIGNED notification
      const questionnaireNotif = await prisma.notification.findFirst({
        where: {
          recipientId: patientId,
          templateId: 'PRE_VISIT_QUESTIONNAIRE_ASSIGNED',
        },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(questionnaireNotif, 'Patient must receive questionnaire assignment notification');
      assert.ok(questionnaireNotif.payloadJson.includes(booking.appointmentId));

      // 3. Fast-forward simulated execution of 24h reminder workflow
      const reminderExecutionId = crypto.randomUUID();
      await processWorkflowJob({
        workflowExecutionId: reminderExecutionId,
        workflowType: 'AppointmentReminder',
        hospitalId,
        appointmentId: booking.appointmentId,
        condition: 'APPOINTMENT_NOT_CANCELLED',
        payload: {
          appointmentId: booking.appointmentId,
        },
      });

      // Assert Patient received APPOINTMENT_REMINDER_24H notification
      const reminderNotif = await prisma.notification.findFirst({
        where: {
          recipientId: patientId,
          templateId: 'APPOINTMENT_REMINDER_24H',
        },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(reminderNotif, 'Patient must receive 24h appointment reminder notification');

      // 4. Patient submits questionnaire
      const q = await prisma.questionnaire.findFirst({ where: { hospitalId, doctorId } });
      assert.ok(q);

      await CapabilityRegistry.execute(
        'submit_questionnaire',
        {
          questionnaireId: q.id,
          appointmentId: booking.appointmentId,
          patientId,
          responses: {
            symptom_description: 'Mild knee stiffness in morning',
          },
        },
        { actorRole: 'PATIENT', patientId, tenantId: hospitalId, correlationId: crypto.randomUUID() }
      );

      // 5. Verify doctor received notification and intake responses are doctor-visible
      const doctorNotif = await prisma.notification.findFirst({
        where: {
          recipientId: doctorId,
          recipientType: 'Doctor',
          templateId: 'QUESTIONNAIRE_SUBMITTED_FOR_REVIEW',
        },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(doctorNotif, 'Doctor must receive QUESTIONNAIRE_SUBMITTED_FOR_REVIEW notification');
      assert.ok(doctorNotif.payloadJson.includes(booking.appointmentId));
    });

    it('3.4 EHR event routing: EhrOperation RECONCILIATION_REQUIRED creates ReconciliationRecord & alerts hospital admin', async () => {
      const slot = await getOrCreateAvailableSlot();

      const appt = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          hospitalId,
          slotId: slot.id,
          startTime: new Date(),
          endTime: new Date(Date.now() + 30 * 60 * 1000),
          status: AppointmentStatus.RECONCILIATION_REQUIRED,
        },
      });

      const ehrExecutionId = crypto.randomUUID();
      await processWorkflowJob({
        workflowExecutionId: ehrExecutionId,
        workflowType: 'EhrOperation',
        hospitalId,
        appointmentId: appt.id,
        payload: {
          event: 'RECONCILIATION_REQUIRED',
          reason: 'EHR_OUTAGE_TIMEOUT_EXHAUSTED',
          appointmentId: appt.id,
        },
      });

      // Verify ReconciliationRecord created in DB
      const recRecord = await prisma.reconciliationRecord.findFirst({
        where: { appointmentId: appt.id },
      });
      assert.ok(recRecord, 'ReconciliationRecord must be created');
      assert.strictEqual(recRecord.status, 'OPEN');
      assert.strictEqual(recRecord.reason, 'EHR_OUTAGE_TIMEOUT_EXHAUSTED');

      // Verify Hospital Admin notification
      const adminNotif = await prisma.notification.findFirst({
        where: {
          hospitalId,
          recipientType: 'HospitalAdmin',
          templateId: 'RECONCILIATION_REQUIRED_ALERT',
        },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(adminNotif, 'Hospital Admin must receive RECONCILIATION_REQUIRED_ALERT');
      assert.ok(adminNotif.payloadJson.includes('EHR_OUTAGE_TIMEOUT_EXHAUSTED'));
    });
  });
});
