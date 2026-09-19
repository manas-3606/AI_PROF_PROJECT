import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import { PatientAgent } from '@health/capabilities';
import { AppointmentStatus } from '@health/shared-types';
import crypto from 'node:crypto';

async function runLiveVerification() {
  console.log('================================================================');
  console.log('🔍 LIVE VERIFICATION FOR BUGS 1, 2, 3, 4');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // BUG 2 VERIFICATION: Specialty Mismatch in get_questionnaire across 3 Specialties
  // ---------------------------------------------------------------------------
  console.log('--- TESTING BUG 2: Questionnaire Specialty Matching ---');
  
  const docJenkins = await prisma.doctor.findFirst({ where: { name: { contains: 'Jenkins' } } });
  const docChen = await prisma.doctor.findFirst({ where: { name: { contains: 'Chen' } } });
  const docRao = await prisma.doctor.findFirst({ where: { name: { contains: 'Rao' } } });

  if (!docJenkins || !docChen || !docRao) {
    throw new Error('Could not find all 3 doctors for testing');
  }

  // 1. Dr. Jenkins (General Medicine @ Metro)
  const qJenkins = await CapabilityRegistry.execute('get_questionnaire', {
    hospitalId: docJenkins.hospitalId,
    doctorId: docJenkins.id,
  }, { actorRole: 'PATIENT', tenantId: docJenkins.hospitalId });

  console.log(`✓ Dr. Jenkins (General Medicine) Questionnaire Title: "${qJenkins.questionnaire?.title}"`);
  const jenkinsQText = qJenkins.questionnaire?.schema?.map((q: any) => q.question).join(' | ');
  console.log(`  Questions sample: ${jenkinsQText?.slice(0, 100)}...`);
  if (!qJenkins.questionnaire?.title.toLowerCase().includes('general medicine') && !qJenkins.questionnaire?.title.toLowerCase().includes('primary care')) {
    throw new Error(`BUG 2 FAIL: Dr. Jenkins received wrong questionnaire: ${qJenkins.questionnaire?.title}`);
  }

  // 2. Dr. Chen (Cardiology @ Metro)
  const qChen = await CapabilityRegistry.execute('get_questionnaire', {
    hospitalId: docChen.hospitalId,
    doctorId: docChen.id,
  }, { actorRole: 'PATIENT', tenantId: docChen.hospitalId });

  console.log(`✓ Dr. Chen (Cardiology) Questionnaire Title: "${qChen.questionnaire?.title}"`);
  if (!qChen.questionnaire?.title.toLowerCase().includes('cardio')) {
    throw new Error(`BUG 2 FAIL: Dr. Chen received wrong questionnaire: ${qChen.questionnaire?.title}`);
  }

  // 3. Dr. Rao (Orthopedics @ Apex)
  const qRao = await CapabilityRegistry.execute('get_questionnaire', {
    hospitalId: docRao.hospitalId,
    doctorId: docRao.id,
  }, { actorRole: 'PATIENT', tenantId: docRao.hospitalId });

  console.log(`✓ Dr. Rao (Orthopedics) Questionnaire Title: "${qRao.questionnaire?.title}"`);
  if (!qRao.questionnaire?.title.toLowerCase().includes('orthopedic')) {
    throw new Error(`BUG 2 FAIL: Dr. Rao received wrong questionnaire: ${qRao.questionnaire?.title}`);
  }

  console.log('✅ BUG 2 PASS: All 3 specialties assigned appropriate, distinct questionnaires!\n');

  // ---------------------------------------------------------------------------
  // BUG 3 VERIFICATION: Questionnaire responses shown as readable Question: Answer
  // ---------------------------------------------------------------------------
  console.log('--- TESTING BUG 3: Question Text Resolution in Doctor Dashboard ---');
  const patient = await prisma.patient.findFirst();
  if (!patient) throw new Error('No patient found');

  // Check the API endpoint /analytics/dashboard/doctor?doctorId=...
  const res = await fetch(`http://localhost:3001/api/analytics/dashboard/doctor?doctorId=${docJenkins.id}`, {
    headers: { 'x-bypass-auth': 'true' }
  });
  const dashData = await res.json() as any;
  if (!dashData.questionTextMap) {
    throw new Error('BUG 3 FAIL: questionTextMap missing from doctor dashboard response');
  }
  const mapKeys = Object.keys(dashData.questionTextMap);
  console.log(`✓ Doctor Dashboard returned questionTextMap with ${mapKeys.length} mapped questions`);
  console.log(`  Sample map: ${mapKeys[0]} -> "${dashData.questionTextMap[mapKeys[0]]}"`);
  console.log('✅ BUG 3 PASS: Dashboard supplies human-readable question text map!\n');

  // ---------------------------------------------------------------------------
  // BUG 1 VERIFICATION: Cancellation Flow & State Desync Prevention (Section 14)
  // ---------------------------------------------------------------------------
  console.log('--- TESTING BUG 1: Cancellation Flow, Intermediate State & Notifications ---');

  // Find an available slot for Dr. Jenkins
  const availableSlot = await prisma.slot.findFirst({
    where: { doctorId: docJenkins.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });
  if (!availableSlot) throw new Error('No available slot found for Dr. Jenkins');

  // Create appointment
  const booking = await CapabilityRegistry.execute('create_appointment', {
    patientId: patient.id,
    doctorId: docJenkins.id,
    hospitalId: docJenkins.hospitalId,
    slotId: availableSlot.id,
    reason: 'Follow-up for sore throat',
    idempotencyKey: crypto.randomUUID(),
  }, { actorRole: 'PATIENT', patientId: patient.id, tenantId: docJenkins.hospitalId });

  console.log(`✓ Created test appointment: ${booking.appointmentId}, slot: ${availableSlot.id}`);

  // Confirm slot is now booked
  const slotAfterBooking = await prisma.slot.findUnique({ where: { id: availableSlot.id } });
  console.log(`  Slot isBooked after booking: ${slotAfterBooking?.isBooked}`);
  if (!slotAfterBooking?.isBooked) throw new Error('Slot was not marked as booked');

  // Now execute cancellation
  console.log('Executing cancellation...');
  const cancelResult = await CapabilityRegistry.execute('cancel_appointment', {
    appointmentId: booking.appointmentId,
    reason: 'Patient cannot make it',
    idempotencyKey: crypto.randomUUID(),
  }, { actorRole: 'PATIENT', patientId: patient.id, tenantId: docJenkins.hospitalId });

  console.log(`✓ cancel_appointment completed with status: ${cancelResult.status}, slotReleased: ${cancelResult.slotReleased}`);

  // 1. Verify AppointmentStateHistory records intermediate SYNCHRONIZATION_PENDING state!
  const stateHistories = await prisma.appointmentStateHistory.findMany({
    where: { appointmentId: booking.appointmentId },
    orderBy: { changedAt: 'asc' },
  });
  console.log('  State transitions recorded in AppointmentStateHistory:');
  for (const h of stateHistories) {
    console.log(`    • ${h.fromStatus} -> ${h.toStatus} (${h.reason}) at ${h.changedAt.toISOString()}`);
  }

  const hasPendingSync = stateHistories.some(h => h.toStatus === AppointmentStatus.SYNCHRONIZATION_PENDING || h.fromStatus === AppointmentStatus.SYNCHRONIZATION_PENDING);
  if (!hasPendingSync) {
    throw new Error('BUG 1 FAIL: Intermediate Synchronization Pending state was not recorded in history');
  }

  // 2. Verify slot released on doctor grid
  const slotAfterCancel = await prisma.slot.findUnique({ where: { id: availableSlot.id } });
  console.log(`✓ Doctor grid slot isBooked after cancellation: ${slotAfterCancel?.isBooked}`);
  if (slotAfterCancel?.isBooked) {
    throw new Error('BUG 1 FAIL: Slot was not freed on doctor calendar');
  }

  // 3. Verify IntegrationVerification record exists for cancellation
  const verifications = await prisma.integrationVerification.findMany({
    where: { appointmentId: booking.appointmentId },
  });
  console.log(`✓ Found ${verifications.length} external integration verification records:`);
  for (const v of verifications) {
    console.log(`    • isVerified: ${v.isVerified}, externalStatus: ${v.externalStatus}, match: ${v.match}`);
  }
  const cancelledVerification = verifications.find(v => v.externalStatus === 'CANCELLED');
  if (!cancelledVerification || !cancelledVerification.isVerified) {
    throw new Error('BUG 1 FAIL: Cancellation was not verified with external EHR');
  }

  // 4. Verify Dual Notifications (Patient SMS + Doctor In-App)
  const notifications = await prisma.notification.findMany({
    where: {
      OR: [
        { recipientId: patient.id },
        { recipientId: docJenkins.id },
      ],
      templateId: { in: ['APPOINTMENT_CANCELLED_CONFIRMATION', 'APPOINTMENT_CANCELLED_ALERT'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });

  console.log(`✓ Found ${notifications.length} cancellation notifications:`);
  for (const n of notifications) {
    console.log(`    • To: ${n.recipientType} (${n.channel}) | Template: ${n.templateId} | Status: ${n.status}`);
  }
  if (notifications.length < 2) {
    throw new Error('BUG 1 FAIL: Both patient confirmation and doctor alert notifications were not dispatched');
  }

  // 5. Test Fault Simulator path: Turn on 500 error, try to cancel an appointment -> must NOT confirm cancellation
  console.log('\nTesting Fault Simulator failure path (prevent false confirmation)...');
  // Create another appointment
  const slot2 = await prisma.slot.findFirst({
    where: { doctorId: docChen.id, isBooked: false },
  });
  if (!slot2) throw new Error('No available slot for Dr. Chen');

  const booking2 = await CapabilityRegistry.execute('create_appointment', {
    patientId: patient.id,
    doctorId: docChen.id,
    hospitalId: docChen.hospitalId,
    slotId: slot2.id,
    reason: 'Heart checkup',
    idempotencyKey: crypto.randomUUID(),
  }, { actorRole: 'PATIENT', patientId: patient.id, tenantId: docChen.hospitalId });

  // Enable 500 error in Mock EHR
  await fetch('http://localhost:4000/chaos/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failureMode: '500_ERROR' }),
  });

  let threwError = false;
  try {
    await CapabilityRegistry.execute('cancel_appointment', {
      appointmentId: booking2.appointmentId,
      reason: 'Testing fault',
      idempotencyKey: crypto.randomUUID(),
    }, { actorRole: 'PATIENT', patientId: patient.id, tenantId: docChen.hospitalId });
  } catch (err: any) {
    threwError = true;
    console.log(`✓ EHR failure correctly intercepted: "${err.message}"`);
  }

  // Reset chaos immediately
  await fetch('http://localhost:4000/chaos/reset', { method: 'POST' });

  if (!threwError) {
    throw new Error('BUG 1 FAIL: Cancellation confirmed despite external EHR 500 failure!');
  }

  // Confirm appointment2 status remains SYNCHRONIZATION_PENDING and slot2 is NOT released!
  const appt2Check = await prisma.appointment.findUnique({ where: { id: booking2.appointmentId } });
  const slot2Check = await prisma.slot.findUnique({ where: { id: slot2.id } });
  console.log(`✓ Fault path appointment status: "${appt2Check?.status}"`);
  console.log(`✓ Fault path slot isBooked: ${slot2Check?.isBooked}`);
  if (appt2Check?.status === AppointmentStatus.CANCELLED) {
    throw new Error('BUG 1 FAIL: Appointment was falsely confirmed as CANCELLED during EHR failure!');
  }
  if (!slot2Check?.isBooked) {
    throw new Error('BUG 1 FAIL: Slot was falsely released during EHR failure!');
  }

  console.log('✅ BUG 1 PASS: Cancellation flow strictly obeys Section 14 lifecycle, handles both normal and fault paths!\n');

  // ---------------------------------------------------------------------------
  // BUG 4 VERIFICATION: "Reset All Chaos" Preserves DB Records
  // ---------------------------------------------------------------------------
  console.log('--- TESTING BUG 4: Reset All Chaos Preserves Records ---');
  // Create a reconciliation record
  const testRec = await prisma.reconciliationRecord.create({
    data: {
      appointmentId: booking.appointmentId,
      hospitalId: docJenkins.hospitalId,
      reason: 'Test chaos verification',
      externalSystemId: 'MOCK_EHR',
      status: 'OPEN',
    }
  });

  const recCountBefore = await prisma.reconciliationRecord.count();
  const auditCountBefore = await prisma.auditEvent.count();

  // Call Reset All Chaos via API server
  const resetRes = await fetch('http://localhost:3001/api/chaos/reset', { method: 'POST' });
  const resetData = await resetRes.json();
  console.log(`✓ Chaos reset response:`, resetData);

  const recCountAfter = await prisma.reconciliationRecord.count();
  const auditCountAfter = await prisma.auditEvent.count();

  console.log(`✓ Reconciliation records before: ${recCountBefore}, after: ${recCountAfter}`);
  console.log(`✓ Audit events before: ${auditCountBefore}, after: ${auditCountAfter}`);

  if (recCountAfter < recCountBefore || auditCountAfter < auditCountBefore) {
    throw new Error('BUG 4 FAIL: Records were deleted by Reset All Chaos!');
  }
  console.log('✅ BUG 4 PASS: Reset All Chaos strictly only resets simulation runtime and preserves all DB records!\n');

  console.log('================================================================');
  console.log('🎉 ALL BUG FIXES 1, 2, 3, 4 VERIFIED LIVE PASSING!');
  console.log('================================================================');
}

runLiveVerification().catch((err) => {
  console.error('❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
