import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { RecoveryStateMachine } from '@health/verification';
import { AppointmentStatus } from '@health/shared-types';
import { MockEhrConnector, IdentifierMapper } from '@health/integration';

describe('Integration Test: PRD Section 28 Failure & Recovery Scenarios', () => {
  let patientId: string;
  let doctorId: string;
  let hospitalId: string;
  let slotId: string;

  before(async () => {
    const patient = await prisma.patient.findFirst();
    const doctor = await prisma.doctor.findFirst();
    assert.ok(patient && doctor);

    patientId = patient.id;
    doctorId = doctor.id;
    hospitalId = doctor.hospitalId;

    const slot = await getOrCreateSlot();
    assert.ok(slot);
    slotId = slot.id;
  });

  async function getOrCreateSlot(): Promise<any> {
    const existing = await prisma.slot.findFirst({
      where: { doctorId, isBooked: false, isBlocked: false },
    });
    if (existing) return existing;
    const sTime = new Date(Date.now() + Math.floor(Math.random() * 20 + 10) * 86400000);
    return await prisma.slot.create({
      data: {
        doctorId,
        hospitalId,
        startTime: sTime,
        endTime: new Date(sTime.getTime() + 30 * 60 * 1000),
        isBooked: false,
        isBlocked: false,
      },
    });
  }

  it('Option A: Recovers from initial timeout via idempotent retry -> verified -> synchronized -> confirmed', async () => {
    // 1. Create appointment in PENDING state
    const slotA = await getOrCreateSlot();
    assert.ok(slotA);

    const appointment = await prisma.appointment.create({
      data: {
        patientId,
        doctorId,
        hospitalId,
        slotId: slotA.id,
        startTime: new Date(),
        endTime: new Date(Date.now() + 30 * 60 * 1000),
        status: AppointmentStatus.PENDING,
      },
    });

    // 2. Simulate mock connector where initial verify is false, but retry succeeds
    const mockConnector = new MockEhrConnector();
    mockConnector.verifyAppointment = async () => ({
      isVerified: false,
      externalStatus: 'NOT_FOUND',
      match: false,
    });

    let createCalls = 0;
    mockConnector.createAppointment = async (payload) => {
      createCalls++;
      return {
        externalAppointmentId: `EXT-RETRY-${payload.internalAppointmentId.slice(0, 8)}`,
        status: 'CONFIRMED',
        verified: true,
        createdAt: new Date().toISOString(),
      };
    };

    const recoveryMachine = new RecoveryStateMachine(mockConnector);

    // 3. Execute recovery state machine with maxRetries = 2
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

    assert.strictEqual(outcome.recovered, true, 'Recovery must succeed on retry');
    assert.strictEqual(outcome.status, AppointmentStatus.CONFIRMED);
    assert.strictEqual(createCalls, 1, 'Retry create must be called once');

    // 4. Verify DB state is CONFIRMED
    const updated = await prisma.appointment.findUnique({ where: { id: appointment.id } });
    assert.strictEqual(updated?.status, AppointmentStatus.CONFIRMED);
    assert.ok(updated?.externalAppointmentId);
  });

  it('Option B: Recovers from Unknown Outcome timeout by discovering record and avoiding duplicate creation', async () => {
    // Count existing appointments before recovery
    const beforeCount = await prisma.appointment.count({ where: { patientId, doctorId } });

    // 1. Create appointment in PENDING state
    const appointment = await prisma.appointment.create({
      data: {
        patientId,
        doctorId,
        hospitalId,
        slotId,
        startTime: new Date(),
        endTime: new Date(Date.now() + 30 * 60 * 1000),
        status: AppointmentStatus.PENDING,
      },
    });

    // 2. Simulate a mock connector where verification reveals the appointment WAS recorded in EHR
    let externalCreateCount = 0;
    const mockConnector = new MockEhrConnector();
    mockConnector.createAppointment = async () => {
      externalCreateCount++;
      return {
        externalAppointmentId: 'EXT-DUPLICATE-SHOULD-NOT-HAPPEN',
        status: 'CONFIRMED',
        verified: true,
        createdAt: new Date().toISOString(),
      };
    };

    // Stub verifyAppointment to simulate that the EHR received the appointment before timeout
    mockConnector.verifyAppointment = async () => ({
      isVerified: true,
      externalStatus: 'CONFIRMED',
      match: true,
    });

    const recoveryMachine = new RecoveryStateMachine(mockConnector);

    // 3. Execute recovery state machine
    const outcome = await recoveryMachine.handleUnknownOutcome(appointment.id, hospitalId, {
      internalAppointmentId: appointment.id,
      externalPatientId: 'EXT-PAT-001',
      externalProviderId: 'EXT-DOC-001',
      startTime: appointment.startTime.toISOString(),
      endTime: appointment.endTime.toISOString(),
    });

    assert.strictEqual(outcome.recovered, true, 'Recovery must succeed');
    assert.strictEqual(outcome.status, AppointmentStatus.CONFIRMED);
    assert.ok(outcome.notes.includes('Avoided duplicate booking creation'));

    // EXPLICIT ASSERTION: No duplicate was created in external EHR or internal DB
    assert.strictEqual(externalCreateCount, 0, 'No mutating createAppointment call made because external record was found');
    const afterCount = await prisma.appointment.count({ where: { patientId, doctorId } });
    assert.strictEqual(afterCount, beforeCount + 1, 'Exactly one internal appointment exists (no duplicate DB rows)');

    // 4. Verify database state
    const updated = await prisma.appointment.findUnique({ where: { id: appointment.id } });
    assert.strictEqual(updated?.status, AppointmentStatus.CONFIRMED);
  });

  it('Option C: Transitions unrecoverable failure to Reconciliation Required and creates escalation record', async () => {
    // 1. Create appointment in PENDING state
    const slot2 = await getOrCreateSlot();
    assert.ok(slot2);

    const appointment = await prisma.appointment.create({
      data: {
        patientId,
        doctorId,
        hospitalId,
        slotId: slot2.id,
        startTime: new Date(),
        endTime: new Date(Date.now() + 30 * 60 * 1000),
        status: AppointmentStatus.PENDING,
      },
    });

    // 2. Simulate failing EHR
    const mockConnector = new MockEhrConnector();
    mockConnector.verifyAppointment = async () => ({
      isVerified: false,
      externalStatus: 'NOT_FOUND',
      match: false,
    });
    mockConnector.createAppointment = async () => {
      throw new Error('EHR_OUTAGE_500');
    };

    const recoveryMachine = new RecoveryStateMachine(mockConnector);

    // 3. Execute recovery state machine with maxRetries = 1
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

    // 4. Verify Reconciliation Record in DB
    const recRecord = await prisma.reconciliationRecord.findUnique({
      where: { id: outcome.reconciliationRecordId },
    });
    assert.ok(recRecord, 'Reconciliation record must exist');
    assert.strictEqual(recRecord.status, 'OPEN');
    assert.strictEqual(recRecord.escalatedTo, 'PlatformOperationsDesk');
  });

  it('Internal<->External identifier mappings (PATIENT, DOCTOR, FACILITY, APPOINTMENT) are persisted', async () => {
    // Set all 4 mappings
    await IdentifierMapper.setMapping(hospitalId, 'PATIENT', patientId, 'EXT-PAT-TEST-123');
    await IdentifierMapper.setMapping(hospitalId, 'DOCTOR', doctorId, 'EXT-DOC-TEST-123');
    await IdentifierMapper.setMapping(hospitalId, 'FACILITY', hospitalId, 'EXT-FAC-TEST-123');
    await IdentifierMapper.setMapping(hospitalId, 'APPOINTMENT', 'test-appt-id', 'EXT-APPT-TEST-123');

    // Retrieve and assert all 4
    const extPatient = await IdentifierMapper.getExternalId(hospitalId, 'PATIENT', patientId);
    const extDoctor = await IdentifierMapper.getExternalId(hospitalId, 'DOCTOR', doctorId);
    const extFacility = await IdentifierMapper.getExternalId(hospitalId, 'FACILITY', hospitalId);
    const extAppt = await IdentifierMapper.getExternalId(hospitalId, 'APPOINTMENT', 'test-appt-id');

    assert.strictEqual(extPatient, 'EXT-PAT-TEST-123');
    assert.strictEqual(extDoctor, 'EXT-DOC-TEST-123');
    assert.strictEqual(extFacility, 'EXT-FAC-TEST-123');
    assert.strictEqual(extAppt, 'EXT-APPT-TEST-123');

    // Reverse mapping check
    const intPatient = await IdentifierMapper.getInternalId(hospitalId, 'PATIENT', 'EXT-PAT-TEST-123');
    assert.strictEqual(intPatient, patientId);
  });
});
