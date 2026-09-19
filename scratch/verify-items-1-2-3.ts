import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';
import { AppointmentStatus } from '@health/shared-types';
import crypto from 'node:crypto';

async function runItems123() {
  console.log('================================================================');
  console.log('VERIFICATION FOR ITEMS 1, 2, AND 3');
  console.log('================================================================\n');

  // ===========================================================================
  // ITEM 1: CANCELLATION REASON TEXT EXTRACTION
  // ===========================================================================
  console.log('----------------------------------------------------------------');
  console.log('ITEM 1: DYNAMIC CANCELLATION REASON EXTRACTION VERIFICATION');
  console.log('----------------------------------------------------------------');
  
  const doctor = await prisma.doctor.findFirst({
    where: { name: { contains: 'Jenkins' } },
    include: { hospital: true },
  });
  const patient = await prisma.patient.findFirst({
    where: { name: { contains: 'Jane' } },
  });

  if (!doctor || !patient) throw new Error('Doctor or patient not found');

  // Find a free slot for Dr. Jenkins
  const slot1 = await prisma.slot.findFirst({
    where: { doctorId: doctor.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });
  if (!slot1) throw new Error('No free slot found for Item 1 test');

  // Create an active appointment
  const booking1 = await CapabilityRegistry.execute(
    'create_appointment',
    {
      patientId: patient.id,
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      slotId: slot1.id,
      reason: 'Persistent fever and cough',
      idempotencyKey: crypto.randomUUID(),
    },
    {
      actorRole: 'PATIENT',
      patientId: patient.id,
      tenantId: doctor.hospitalId,
    }
  );

  console.log(`[ITEM 1] Created test appointment: ${booking1.appointmentId}`);

  // Now conversationally cancel with a specific natural reason:
  const convId1 = `item1-conv-${Date.now()}`;
  const agent1 = new PatientAccessAgent({
    conversationId: convId1,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
  });

  const cancelUtterance = 'I need to cancel my appointment because of a sudden family emergency';
  console.log(`[ITEM 1 PATIENT]: "${cancelUtterance}"`);

  const turnResponse = await agent1.processTurn(cancelUtterance);
  console.log(`[ITEM 1 AGENT]: "${turnResponse.responseText}"`);

  // Query database to inspect actual recorded reason
  const appt1Record = await prisma.appointment.findUnique({
    where: { id: booking1.appointmentId },
  });
  const history1 = await prisma.appointmentStateHistory.findMany({
    where: { appointmentId: booking1.appointmentId },
    orderBy: { changedAt: 'asc' },
  });

  console.log('\n[ITEM 1 DB AUDIT TRAIL]:');
  console.log(`  Appointment Final Status: ${appt1Record?.status}`);
  console.log(`  Appointment Reason Field: "${appt1Record?.reason}"`);
  for (const h of history1) {
    console.log(`  State Transition: ${h.fromStatus} -> ${h.toStatus} | Reason: "${h.reason}"`);
  }

  const syncPendingTransition = history1.find(h => h.toStatus === AppointmentStatus.SYNCHRONIZATION_PENDING);
  console.log(`\n[ITEM 1 CHECK]: Recorded transition reason: "${syncPendingTransition?.reason}"`);
  if (!syncPendingTransition?.reason?.toLowerCase().includes('family emergency')) {
    throw new Error(`ITEM 1 FAIL: Expected reason to reflect "family emergency", but got: "${syncPendingTransition?.reason}"`);
  }
  console.log('✅ ITEM 1 PASS: Actual user cancellation reason is dynamically extracted and recorded in audit trail!\n');


  // ===========================================================================
  // ITEM 2: FAULT-SIMULATOR CANCELLATION SCENARIO (SIMULATED 500 ERROR)
  // ===========================================================================
  console.log('----------------------------------------------------------------');
  console.log('ITEM 2: FAULT SIMULATOR CANCELLATION SCENARIO (SIMULATED EHR 500)');
  console.log('----------------------------------------------------------------');

  // Step 1: Ensure clean EHR state, then book an appointment
  await fetch('http://localhost:4000/chaos/reset', { method: 'POST' });

  const slot2 = await prisma.slot.findFirst({
    where: { doctorId: doctor.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });
  if (!slot2) throw new Error('No free slot found for Item 2 test');

  const booking2 = await CapabilityRegistry.execute(
    'create_appointment',
    {
      patientId: patient.id,
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      slotId: slot2.id,
      reason: 'Cardiology evaluation follow-up',
      idempotencyKey: crypto.randomUUID(),
    },
    {
      actorRole: 'PATIENT',
      patientId: patient.id,
      tenantId: doctor.hospitalId,
    }
  );

  const appt2Id = booking2.appointmentId;
  console.log(`[ITEM 2] Successfully created confirmed test appointment: ${appt2Id}`);

  // Confirm slot is locked
  const slot2BeforeCancel = await prisma.slot.findUnique({ where: { id: slot2.id } });
  console.log(`[ITEM 2] Slot ${slot2.id} isBooked before cancellation: ${slot2BeforeCancel?.isBooked}`);
  if (!slot2BeforeCancel?.isBooked) throw new Error('Slot was not marked as booked');

  // Step 2: Trigger Simulated EHR Failure via Chaos API
  console.log('[ITEM 2] Configuring Fault Simulator: Injecting failureMode: "ERROR_500" into Mock EHR...');
  const chaosRes = await fetch('http://localhost:4000/chaos/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failureMode: 'ERROR_500' }),
  });
  const chaosStatus = await chaosRes.json();
  console.log('[ITEM 2] Mock EHR Fault Simulator status:', JSON.stringify(chaosStatus));

  // Step 3: Attempt to cancel the appointment while EHR is failing
  console.log('[ITEM 2] Executing cancel_appointment capability during simulated EHR failure...');
  let cancelError: any = null;
  try {
    await CapabilityRegistry.execute(
      'cancel_appointment',
      {
        appointmentId: appt2Id,
        reason: 'Patient requested cancellation during EHR outage',
        idempotencyKey: crypto.randomUUID(),
      },
      {
        actorRole: 'PATIENT',
        patientId: patient.id,
        tenantId: doctor.hospitalId,
      }
    );
  } catch (err: any) {
    cancelError = err;
    console.log(`[ITEM 2] Intercepted expected capability error: [${err.name}] ${err.message}`);
  }

  if (!cancelError) {
    throw new Error('ITEM 2 FAIL: Capability should have thrown an error when EHR failed with 500!');
  }

  // Step 4: Verify RAW DB STATE — Appointment MUST be stuck in SYNCHRONIZATION_PENDING and slot MUST remain locked!
  const appt2AfterFail = await prisma.appointment.findUnique({ where: { id: appt2Id } });
  const slot2AfterFail = await prisma.slot.findUnique({ where: { id: slot2.id } });
  const history2 = await prisma.appointmentStateHistory.findMany({
    where: { appointmentId: appt2Id },
    orderBy: { changedAt: 'asc' },
  });
  const notifications2 = await prisma.notification.findMany({
    where: {
      payloadJson: { contains: appt2Id },
      templateId: 'APPOINTMENT_CANCELLED_CONFIRMATION',
    },
  });

  console.log('\n[ITEM 2 RAW DATABASE STATE UNDER FAULT]:');
  console.log(`  * Appointment ID: ${appt2AfterFail?.id}`);
  console.log(`  * Appointment Status: ${appt2AfterFail?.status} (MUST be SYNCHRONIZATION_PENDING)`);
  console.log(`  * Doctor Slot ID: ${slot2AfterFail?.id}`);
  console.log(`  * Doctor Slot isBooked: ${slot2AfterFail?.isBooked} (MUST remain true — NOT released!)`);
  console.log(`  * False Confirmation Notifications Count: ${notifications2.length} (MUST be 0)`);
  
  console.log('\n[ITEM 2 STATE TRANSITIONS RECORDED IN DB]:');
  for (const h of history2) {
    console.log(`    • ${h.fromStatus} -> ${h.toStatus} (${h.reason}) at ${h.changedAt.toISOString()}`);
  }

  if (appt2AfterFail?.status !== AppointmentStatus.SYNCHRONIZATION_PENDING) {
    throw new Error(`ITEM 2 FAIL: Appointment status is ${appt2AfterFail?.status}, expected SYNCHRONIZATION_PENDING`);
  }

  if (slot2AfterFail?.isBooked !== true) {
    throw new Error(`ITEM 2 FAIL: Doctor slot was prematurely released (isBooked = ${slot2AfterFail?.isBooked})!`);
  }

  if (notifications2.length > 0) {
    throw new Error(`ITEM 2 FAIL: False confirmation notification was dispatched to patient!`);
  }

  // Reset chaos back to normal
  await fetch('http://localhost:4000/chaos/reset', { method: 'POST' });
  console.log('\n✅ ITEM 2 PASS: Appointment correctly remains in SYNCHRONIZATION_PENDING with doctor slot locked! Zero false confirmations!\n');


  // ===========================================================================
  // ITEM 3: BUG 4 — ACTUAL ROW COUNTS & RECORD IDS PRE/POST RESET ALL CHAOS
  // ===========================================================================
  console.log('----------------------------------------------------------------');
  console.log('ITEM 3: BUG 4 — ROW COUNTS & RECORD IDS PRE/POST RESET ALL CHAOS');
  console.log('----------------------------------------------------------------');

  // Seed / ensure at least 2 ReconciliationRecords and 2 AuditEvents exist
  const existingReconciliations = await prisma.reconciliationRecord.findMany({
    select: { id: true, appointmentId: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  let rec1Id = existingReconciliations[0]?.id;
  let rec2Id = existingReconciliations[1]?.id;

  if (!rec1Id || !rec2Id) {
    const r1 = await prisma.reconciliationRecord.create({
      data: {
        appointmentId: appt2Id,
        hospitalId: doctor.hospitalId,
        externalSystemId: 'MOCK_EHR',
        reason: 'CHAOS_TEST_EHR_TIMEOUT',
        status: 'PENDING',
      },
    });
    const r2 = await prisma.reconciliationRecord.create({
      data: {
        appointmentId: appt1Record!.id,
        hospitalId: doctor.hospitalId,
        externalSystemId: 'MOCK_EHR',
        reason: 'CHAOS_TEST_STATE_DESYNC',
        status: 'PENDING',
      },
    });
    rec1Id = r1.id;
    rec2Id = r2.id;
  }

  // 1. PRE-RESET AUDIT & RECONCILIATION DATA
  const preReconRecords = await prisma.reconciliationRecord.findMany({
    select: { id: true, reason: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
  const preReconCount = preReconRecords.length;

  const preAuditRecords = await prisma.auditEvent.findMany({
    select: { id: true, action: true, entityType: true, timestamp: true },
    orderBy: { timestamp: 'desc' },
    take: 10,
  });
  const preAuditCount = await prisma.auditEvent.count();

  console.log(`[PRE-RESET] ReconciliationRecord count: ${preReconCount}`);
  console.log(`[PRE-RESET] ReconciliationRecord IDs:`);
  preReconRecords.forEach(r => console.log(`  • ID: ${r.id} | Reason: ${r.reason} | Status: ${r.status}`));

  console.log(`\n[PRE-RESET] AuditEvent total count: ${preAuditCount}`);
  console.log(`[PRE-RESET] Sample AuditEvent IDs (Top 5 of ${preAuditCount}):`);
  preAuditRecords.slice(0, 5).forEach(a => console.log(`  • ID: ${a.id} | Action: ${a.action} | EntityType: ${a.entityType}`));

  // 2. INVOKE RESET ALL CHAOS VIA THE API ENDPOINT
  console.log('\n[ITEM 3] Triggering POST /api/chaos/reset...');
  const resetRes = await fetch('http://localhost:3001/api/chaos/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const resetBody = await resetRes.json();
  console.log(`[ITEM 3] Reset endpoint response:`, JSON.stringify(resetBody));

  // 3. POST-RESET AUDIT & RECONCILIATION DATA
  const postReconRecords = await prisma.reconciliationRecord.findMany({
    select: { id: true, reason: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
  const postReconCount = postReconRecords.length;

  const postAuditRecords = await prisma.auditEvent.findMany({
    select: { id: true, action: true, entityType: true, timestamp: true },
    orderBy: { timestamp: 'desc' },
    take: 10,
  });
  const postAuditCount = await prisma.auditEvent.count();

  console.log(`\n[POST-RESET] ReconciliationRecord count: ${postReconCount}`);
  console.log(`[POST-RESET] ReconciliationRecord IDs:`);
  postReconRecords.forEach(r => console.log(`  • ID: ${r.id} | Reason: ${r.reason} | Status: ${r.status}`));

  console.log(`\n[POST-RESET] AuditEvent total count: ${postAuditCount}`);
  console.log(`[POST-RESET] Sample AuditEvent IDs (Top 5 of ${postAuditCount}):`);
  postAuditRecords.slice(0, 5).forEach(a => console.log(`  • ID: ${a.id} | Action: ${a.action} | EntityType: ${a.entityType}`));

  console.log('\n----------------------------------------------------------------');
  console.log('SIDE-BY-SIDE INTEGRITY COMPARISON');
  console.log('----------------------------------------------------------------');
  console.log(`ReconciliationRecord Count Before: ${preReconCount} | After: ${postReconCount} | Diff: ${postReconCount - preReconCount}`);
  console.log(`AuditEvent Total Count Before:     ${preAuditCount} | After: ${postAuditCount} | Diff: ${postAuditCount - preAuditCount}`);

  // Compare exact IDs
  const preReconIds = preReconRecords.map(r => r.id).sort();
  const postReconIds = postReconRecords.map(r => r.id).sort();
  const reconIdsIdentical = JSON.stringify(preReconIds) === JSON.stringify(postReconIds);

  console.log(`All ReconciliationRecord IDs Identical: ${reconIdsIdentical ? 'YES' : 'NO'}`);

  if (preReconCount !== postReconCount || !reconIdsIdentical) {
    throw new Error('ITEM 3 FAIL: ReconciliationRecord data was altered or deleted by Reset All Chaos!');
  }

  if (postAuditCount < preAuditCount) {
    throw new Error('ITEM 3 FAIL: AuditEvent rows decreased after Reset All Chaos!');
  }

  console.log('✅ ITEM 3 PASS: Zero audit records or reconciliation records were modified or deleted by Reset All Chaos!\n');
  console.log('================================================================');
  console.log('ALL VERIFICATIONS FOR ITEMS 1, 2, AND 3 COMPLETED: 100% PASS');
  console.log('================================================================');
}

runItems123()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Execution failed:', err);
    process.exit(1);
  });
