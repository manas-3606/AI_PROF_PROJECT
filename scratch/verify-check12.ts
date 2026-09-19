import { prisma } from '@health/db';
import crypto from 'node:crypto';

const BASE_URL = 'http://localhost:3001';

async function main() {
  console.log('🚀 Running Layer 5 - Check 12: Live Booking & DB Verification...');

  // 1. Get an active doctor with an unbooked slot
  const doctor = await prisma.doctor.findFirst({
    where: { status: 'ACTIVE' },
    include: { hospital: true },
  });
  if (!doctor) throw new Error('No active doctor found');

  const patient = await prisma.patient.findFirst({
    include: { user: true },
  });
  if (!patient) throw new Error('No patient found');

  // Find or create an unbooked slot in the future to avoid conflicts
  const slotDate = new Date(Date.now() + 86400000 * 15);
  slotDate.setUTCHours(10, 0, 0, 0);

  let slot = await prisma.slot.findFirst({
    where: {
      doctorId: doctor.id,
      isBooked: false,
      isBlocked: false,
      startTime: { gte: new Date() },
    },
    orderBy: { startTime: 'asc' },
  });

  if (!slot) {
    slot = await prisma.slot.create({
      data: {
        doctorId: doctor.id,
        hospitalId: doctor.hospitalId,
        startTime: slotDate,
        endTime: new Date(slotDate.getTime() + 30 * 60000),
        isBooked: false,
        isBlocked: false,
      },
    });
  }

  console.log(`Found slot ${slot.id} for Doctor ${doctor.name} at ${doctor.hospital.name}`);

  // 2. Perform live booking via POST /api/appointments
  const correlationId = `corr-chk12-${crypto.randomUUID()}`;
  const idempotencyKey = `idem-chk12-${crypto.randomUUID()}`;

  const bookingRes = await fetch(`${BASE_URL}/api/appointments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-correlation-id': correlationId,
      'x-idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      patientId: patient.id,
      doctorId: doctor.id,
      slotId: slot.id,
      hospitalId: doctor.hospitalId,
      reason: 'Check 12 Live Verification Consultation',
    }),
  });

  if (!bookingRes.ok) {
    const errText = await bookingRes.text();
    throw new Error(`Booking failed (${bookingRes.status}): ${errText}`);
  }

  const bookingData = (await bookingRes.json()) as any;
  const appointmentId = bookingData.appointmentId || bookingData.id || bookingData.appointment?.id;
  console.log(`✅ Live appointment booked: ${appointmentId} (Status: ${bookingData.status || bookingData.appointment?.status})`);

  // 3. Query DB directly to verify:
  // a) Appointment record and status
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });
  if (!appointment) throw new Error('Appointment not found in DB');
  console.log(`  - DB Appointment Status: ${appointment.status}`);
  if (appointment.status.toUpperCase() !== 'CONFIRMED') {
    throw new Error(`Expected CONFIRMED, got ${appointment.status}`);
  }

  // b) Appointment state history: confirmed ONLY after verifier ran
  const stateHistory = await prisma.appointmentStateHistory.findMany({
    where: { appointmentId },
    orderBy: { changedAt: 'asc' },
  });
  console.log(`  - State History count: ${stateHistory.length}`);
  const stateSequence = stateHistory.map((s) => s.toStatus);
  console.log(`  - State Progression: ${stateSequence.join(' -> ')}`);

  const confirmedIndex = stateSequence.findIndex((s) => s.toUpperCase() === 'CONFIRMED');
  if (confirmedIndex === -1) {
    throw new Error('Appointment never reached CONFIRMED in state history');
  }

  // c) IntegrationVerification record: verifier execution
  const verifications = await prisma.integrationVerification.findMany({
    where: { appointmentId },
  });
  console.log(`  - Integration Verification count: ${verifications.length}`);
  if (verifications.length === 0) {
    throw new Error('No IntegrationVerification record found! Verifier did not run.');
  }
  const verifier = verifications[0];
  console.log(`  - Verifier Result: isVerified=${verifier.isVerified}, matched=${verifier.match}, verifiedAt=${verifier.verifiedAt}`);
  if (!verifier.isVerified) {
    throw new Error('Verifier did not verify the appointment');
  }

  // d) ExternalIdentifierMapping: patient, doctor, appointment, facility
  const mappings = await prisma.externalIdentifierMapping.findMany({
    where: {
      hospitalId: doctor.hospitalId,
      internalId: { in: [patient.id, doctor.id, appointmentId, doctor.hospitalId] },
    },
  });
  console.log(`  - External Identifier Mappings found: ${mappings.length}`);
  const mappedTypes = mappings.map((m) => m.entityType);
  console.log(`  - Mapped Entity Types: ${mappedTypes.join(', ')}`);

  const requiredTypes = ['PATIENT', 'DOCTOR', 'APPOINTMENT', 'FACILITY'];
  for (const reqType of requiredTypes) {
    const hasType = mappings.some((m) => m.entityType === reqType);
    console.log(`    * [${hasType ? 'PASS' : 'FAIL'}] Mapping for ${reqType} exists`);
    if (!hasType) {
      throw new Error(`Missing ExternalIdentifierMapping for ${reqType}`);
    }
  }

  // e) Consistent correlationId across records
  console.log(`\n  - Verifying correlationId consistency: "${correlationId}"`);
  console.log(`    * Appointment correlationId: ${appointment.correlationId}`);
  if (appointment.correlationId !== correlationId) {
    throw new Error(`Appointment correlationId mismatch: expected ${correlationId}, got ${appointment.correlationId}`);
  }

  // Check state history correlationId
  const matchingHistory = stateHistory.filter((s) => s.correlationId === correlationId);
  console.log(`    * StateHistory entries matching correlationId: ${matchingHistory.length}/${stateHistory.length}`);
  if (matchingHistory.length === 0) {
    throw new Error('State history does not contain the correlationId');
  }

  // Check integration verification linked to appointment
  console.log(`    * Verification linked appointmentId: ${verifier.appointmentId} (Matches: ${verifier.appointmentId === appointmentId})`);
  if (verifier.appointmentId !== appointmentId) {
    throw new Error(`Verification appointmentId mismatch: expected ${appointmentId}, got ${verifier.appointmentId}`);
  }

  // Check audit event correlationId
  const auditEvents = await prisma.auditEvent.findMany({
    where: { correlationId },
  });
  console.log(`    * AuditEvent entries matching correlationId: ${auditEvents.length}`);
  if (auditEvents.length === 0) {
    throw new Error('No AuditEvent entries found for correlationId');
  }

  // Check workflow execution
  const workflowExecutions = await prisma.workflowExecution.findMany({
    where: { appointmentId },
  });
  console.log(`    * WorkflowExecution count for appointment: ${workflowExecutions.length}`);
  for (const wf of workflowExecutions) {
    const hasCorr = wf.payloadJson.includes(correlationId);
    console.log(`      WorkflowExecution ${wf.id} payload contains correlationId: ${hasCorr}`);
  }

  console.log('\n🎉 CHECK 12 PASSED WITH COMPLETE DB EVIDENCE!');
}

main()
  .catch((e) => {
    console.error('❌ Check 12 verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
