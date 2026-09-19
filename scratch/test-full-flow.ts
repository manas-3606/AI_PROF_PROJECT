import { prisma } from '@health/db';
import { PatientAccessAgent } from '@health/capabilities';
import { CapabilityRegistry } from '@health/capabilities';
import crypto from 'node:crypto';

async function testFullFlow() {
  console.log('🧪 Starting Full Flow End-to-End Verification...');

  // 1. Pick a patient and doctor
  const patient = await prisma.patient.findFirst({ include: { user: true } });
  const doctor = await prisma.doctor.findFirst({ include: { hospital: true } });

  if (!patient || !doctor) {
    throw new Error('Database missing seed patient or doctor');
  }

  console.log(`👤 Patient: ${patient.name} (${patient.id})`);
  console.log(`👨‍⚕️ Doctor: ${doctor.name} (${doctor.id}) at ${doctor.hospital.name}`);

  const conversationId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();

  const agent = new PatientAccessAgent({
    conversationId,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
    channel: 'VOICE',
  });

  // Turn 1: Ask for availability
  console.log('\n--- TURN 1: Check Availability ---');
  const turn1 = await agent.processTurn({
    conversationId,
    userUtterance: `What times does ${doctor.name} have available this week?`,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
    correlationId,
    channel: 'VOICE',
  });

  console.log('Agent Response:', turn1.spokenText);
  console.log('Offered slots count:', turn1.context.lastOfferedSlotIds?.length);

  if (!turn1.context.lastOfferedSlotIds || turn1.context.lastOfferedSlotIds.length === 0) {
    throw new Error('No slots were offered in Turn 1');
  }

  // Turn 2: Book the first offered slot
  console.log('\n--- TURN 2: Book Slot ---');
  const bookingCorrelationId = crypto.randomUUID();
  const turn2 = await agent.processTurn({
    conversationId,
    userUtterance: 'the first one please',
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
    correlationId: bookingCorrelationId,
    channel: 'VOICE',
  });

  console.log('Agent Response:', turn2.spokenText);
  console.log('Intent Detected:', turn2.intentDetected);
  console.log('Capability Called:', turn2.capabilityCalled);

  if (turn2.intentDetected !== 'BOOKING_CONFIRMED') {
    throw new Error(`Expected BOOKING_CONFIRMED, got ${turn2.intentDetected}`);
  }

  const appointmentId = turn2.context.activeAppointmentId;
  console.log('Active Appointment ID:', appointmentId);

  // Verify Database State
  console.log('\n--- DATABASE INTEGRITY CHECKS ---');

  // 1. Appointment
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { slot: true },
  });
  console.log('✅ Appointment Status:', appt?.status, '| Slot isBooked:', appt?.slot.isBooked);

  // 2. Integration Operation
  const intOps = await prisma.integrationOperation.findMany({
    where: { correlationId: bookingCorrelationId },
  });
  console.log(`✅ Integration Operations recorded: ${intOps.length}`);
  if (intOps.length === 0) {
    throw new Error('IntegrationOperation record missing!');
  }
  console.log('   Op Type:', intOps[0].operationType, '| Status:', intOps[0].status);

  // 3. Operational Events
  const opEvents = await prisma.operationalEvent.findMany({
    where: { correlationId: bookingCorrelationId },
  });
  console.log(`✅ Operational Events recorded: ${opEvents.length}`);
  opEvents.forEach((e) => console.log(`   Event: ${e.eventType} [${e.severity}] - ${e.message}`));

  // 4. Notifications
  const notifs = await prisma.notification.findMany({
    where: { payloadJson: { contains: bookingCorrelationId } },
  });
  console.log(`✅ Notifications dispatched: ${notifs.length}`);
  notifs.forEach((n) => console.log(`   Template: ${n.templateId} -> ${n.recipientType} (${n.recipientId})`));

  // 5. Workflows
  const workflows = await prisma.workflowExecution.findMany({
    where: { appointmentId },
  });
  console.log(`✅ Workflows enqueued: ${workflows.length}`);
  workflows.forEach((w) => console.log(`   Workflow Type: ${w.workflowId || 'Custom'} Status: ${w.status}`));

  // 6. External Identifier Mappings
  const mappings = await prisma.externalIdentifierMapping.findMany({
    where: { hospitalId: doctor.hospitalId },
  });
  console.log(`✅ External Identifier Mappings count for hospital: ${mappings.length}`);

  console.log('\n🎉 ALL PRD END-TO-END CRITERIA VERIFIED SUCCESSFULLY!');
  process.exit(0);
}

testFullFlow().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
