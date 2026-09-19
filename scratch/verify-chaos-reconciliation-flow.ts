import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import { CapabilityRegistry } from '@health/capabilities';
import crypto from 'node:crypto';

async function verifyChaosReconciliationFlow() {
  console.log('================================================================');
  console.log('TESTING FAULT SIMULATOR & RECONCILIATION FLOW END-TO-END');
  console.log('================================================================');

  // Step 0: Ensure EHR is reset initially
  await fetch('http://localhost:3001/api/chaos/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  // Find Jane Doe
  const patient = await prisma.patient.findFirst({
    where: { email: { contains: 'jane' } },
  });
  if (!patient) throw new Error('Patient not found');

  const doctor = await prisma.doctor.findFirst({
    where: { name: { contains: 'Jenkins' } },
    include: { hospital: true },
  });
  if (!doctor) throw new Error('Doctor Jenkins not found');

  // Find an existing unbooked slot or create a future one
  let slot = await prisma.slot.findFirst({
    where: { doctorId: doctor.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });

  if (!slot) {
    const slotDate = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    slotDate.setHours(11, 0, 0, 0);
    slot = await prisma.slot.create({
      data: {
        doctorId: doctor.id,
        hospitalId: doctor.hospitalId,
        startTime: slotDate,
        endTime: new Date(slotDate.getTime() + 30 * 60 * 1000),
        isBooked: false,
      },
    });
  }

  console.log(`Using Patient: ${patient.name} (${patient.id})`);
  console.log(`Using Doctor:  ${doctor.name} (${doctor.id})`);
  console.log(`Using Slot:    ${slot.id} at ${slot.startTime.toISOString()}`);

  // Step 1: Inject Fault Simulator Chaos (500_ERROR)
  console.log('\n[STEP 1] Injecting Chaos: failureMode = ERROR_500...');
  const cfgRes = await fetch('http://localhost:3001/api/chaos/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failureMode: 'ERROR_500', simulatedLatencyMs: 0 }),
  });
  const cfgData = await cfgRes.json();
  console.log('Chaos configured:', cfgData);

  // Step 2: Attempt appointment booking during chaos
  console.log('\n[STEP 2] Attempting create_appointment during fault injection...');
  let apptId: string | null = null;
  try {
    const bookingRes = await CapabilityRegistry.execute(
      'create_appointment',
      {
        patientId: patient.id,
        doctorId: doctor.id,
        hospitalId: doctor.hospitalId,
        slotId: slot.id,
        reason: 'Cardiology evaluation under chaos test',
        idempotencyKey: crypto.randomUUID(),
      },
      {
        actorRole: 'PATIENT',
        patientId: patient.id,
        tenantId: doctor.hospitalId,
        correlationId: crypto.randomUUID(),
      }
    );
    apptId = bookingRes.appointmentId;
    console.log('Capability returned:', bookingRes);
  } catch (err: any) {
    console.log(`Capability failed as expected: [${err.name}] ${err.message}`);
    // Find the appointment created in DB
    const appt = await prisma.appointment.findFirst({
      where: {
        slotId: slot.id,
        patientId: patient.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    apptId = appt?.id || null;
  }

  if (!apptId) {
    throw new Error('Appointment was not persisted in DB during failure!');
  }

  // Step 3: Verify Patient Side & Reconciliation Desk under fault
  console.log('\n[STEP 3] Verifying Database & Dashboards UNDER FAULT:');
  const apptUnderFault = await prisma.appointment.findUnique({
    where: { id: apptId },
  });
  console.log(`  * Appointment ID: ${apptUnderFault?.id}`);
  console.log(`  * Appointment Status: ${apptUnderFault?.status} (MUST be "Synchronization Pending")`);

  if (apptUnderFault?.status !== AppointmentStatus.SYNCHRONIZATION_PENDING) {
    throw new Error(`Expected status to be Synchronization Pending, got: ${apptUnderFault?.status}`);
  }

  // Verify ReconciliationRecord exists and is OPEN
  const openRecon = await prisma.reconciliationRecord.findFirst({
    where: {
      appointmentId: apptId,
      status: 'OPEN',
    },
  });
  console.log(`  * Open ReconciliationRecord ID: ${openRecon?.id}`);
  console.log(`  * Reconciliation Reason: ${openRecon?.reason}`);
  console.log(`  * Reconciliation Status: ${openRecon?.status} (MUST be OPEN)`);

  if (!openRecon) {
    throw new Error('FAIL: ReconciliationRecord was NOT created in DB during EHR failure!');
  }

  // Check Platform Admin Dashboard API response
  const platformAdminDash = await fetch('http://localhost:3001/api/analytics/dashboard/platform-admin')
    .then(r => r.json());
  const foundInAdminDesk = (platformAdminDash.reconciliations || []).some((r: any) => r.id === openRecon.id);
  console.log(`  * Reconciliation visible on Platform Admin Desk: ${foundInAdminDesk ? 'YES' : 'NO'}`);
  if (!foundInAdminDesk) {
    throw new Error('FAIL: Open reconciliation record not visible in Platform Admin dashboard!');
  }

  // Check Patient Dashboard API response
  const patientDash = await fetch(`http://localhost:3001/api/analytics/dashboard/patient?patientId=${patient.id}`)
    .then(r => r.json());
  const foundInPatientDash = (patientDash.appointments || []).find((a: any) => a.id === apptId);
  console.log(`  * Appointment status on Patient Portal: "${foundInPatientDash?.status}" (MUST be "Synchronization Pending")`);
  if (foundInPatientDash?.status !== 'Synchronization Pending') {
    throw new Error(`FAIL: Patient portal shows "${foundInPatientDash?.status}", expected "Synchronization Pending"!`);
  }

  // Step 4: Reset All Chaos
  console.log('\n[STEP 4] Calling Reset All Chaos via POST /api/chaos/reset...');
  const resetRes = await fetch('http://localhost:3001/api/chaos/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const resetData = await resetRes.json();
  console.log('Reset response:', resetData);

  // Step 5: Verify Post-Reset State
  console.log('\n[STEP 5] Verifying Database & Dashboards AFTER RESET:');
  const apptAfterReset = await prisma.appointment.findUnique({
    where: { id: apptId },
  });
  console.log(`  * Appointment Status: ${apptAfterReset?.status} (MUST be "Confirmed")`);
  console.log(`  * External Appointment ID: ${apptAfterReset?.externalAppointmentId}`);

  if (apptAfterReset?.status !== AppointmentStatus.CONFIRMED) {
    throw new Error(`FAIL: Appointment did not transition to Confirmed! Got: ${apptAfterReset?.status}`);
  }

  const reconAfterReset = await prisma.reconciliationRecord.findUnique({
    where: { id: openRecon.id },
  });
  console.log(`  * Reconciliation Record ID: ${reconAfterReset?.id} (Preserved - Not Deleted!)`);
  console.log(`  * Reconciliation Status: ${reconAfterReset?.status} (MUST be "RESOLVED")`);
  console.log(`  * Resolved At: ${reconAfterReset?.resolvedAt?.toISOString()}`);

  if (reconAfterReset?.status !== 'RESOLVED') {
    throw new Error(`FAIL: Reconciliation record status is ${reconAfterReset?.status}, expected RESOLVED!`);
  }

  // Check Patient Dashboard after reset
  const patientDashAfter = await fetch(`http://localhost:3001/api/analytics/dashboard/patient?patientId=${patient.id}`)
    .then(r => r.json());
  const apptInPatientDashAfter = (patientDashAfter.appointments || []).find((a: any) => a.id === apptId);
  console.log(`  * Appointment status on Patient Portal after Reset: "${apptInPatientDashAfter?.status}" (MUST be "Confirmed")`);

  if (apptInPatientDashAfter?.status !== 'Confirmed') {
    throw new Error(`FAIL: Patient dashboard does not show Confirmed! Got: ${apptInPatientDashAfter?.status}`);
  }

  // Check Platform Admin Dashboard after reset
  const platformAdminDashAfter = await fetch('http://localhost:3001/api/analytics/dashboard/platform-admin')
    .then(r => r.json());
  const reconInAdminDeskAfter = (platformAdminDashAfter.reconciliations || []).find((r: any) => r.id === openRecon.id);
  console.log(`  * Reconciliation Desk shows record as: status = "${reconInAdminDeskAfter?.status}"`);

  // Check Notification sent to patient
  const notification = await prisma.notification.findFirst({
    where: {
      recipientId: patient.id,
      templateId: 'APPOINTMENT_CONFIRMATION',
      payloadJson: { contains: apptId },
    },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`  * Patient Confirmation Notification sent: ${notification ? 'YES' : 'NO'}`);

  console.log('\n================================================================');
  console.log('✅ ALL TESTS PASSED: Fault simulation and Chaos Reset Reconciliation working flawlessly!');
  console.log('================================================================\n');
}

verifyChaosReconciliationFlow()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
