import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';
import { prisma } from '../packages/db/src/index.js';
import crypto from 'node:crypto';

async function runPhase0() {
  console.log('================================================================');
  console.log('=== PHASE 0: REGRESSION CHECK ON PRIOR FIXES ===');
  console.log('================================================================\n');

  let p0Passed = true;

  // ---------------------------------------------------------------------------
  // TEST 1: Multi-option slot selection
  // "the 9am one", "second option", "not the late one"
  // ---------------------------------------------------------------------------
  console.log('--- TEST 1: Multi-Option Slot Selection ("the 9am one", "second option", "not the late one") ---');

  // Let's create or find doctor Arvind Rao
  const doctor = await prisma.doctor.findFirst({
    where: { name: { contains: 'Rao' } },
    include: { hospital: true }
  });
  if (!doctor) {
    throw new Error('Doctor Arvind Rao not found in DB');
  }

  // Ensure patient Jane Doe exists
  const patient = await prisma.patient.findFirst({
    where: { name: { contains: 'Jane' } }
  });
  if (!patient) {
    throw new Error('Patient Jane Doe not found in DB');
  }

  // Test 1A: "second option"
  const conv1Id = `phase0-test1-second-opt-${Date.now()}`;
  const agent1 = new PatientAccessAgent({
    conversationId: conv1Id,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
  });

  console.log(`\nScenario 1A: Patient requests Dr. Rao, then picks "second option"`);
  const turn1A_1 = await agent1.processTurn('I would like to schedule an appointment with Dr. Arvind Rao');
  console.log(`Patient: "I would like to schedule an appointment with Dr. Arvind Rao"`);
  console.log(`Agent: "${turn1A_1.responseText}"`);

  const offeredSlots = turn1A_1.context.ambiguousOptions || [];
  console.log(`Offered Slots (${offeredSlots.length}):`);
  offeredSlots.forEach((s: any, idx: number) => {
    console.log(`  [${idx}] Slot ID: ${s.slotId} | Start: ${s.startTime}`);
  });

  if (offeredSlots.length < 2) {
    console.log('❌ FAIL: Less than 2 slots offered for multi-option selection test');
    p0Passed = false;
  } else {
    const expectedSlot = offeredSlots[1];
    const turn1A_2 = await agent1.processTurn('I will take the second option please');
    console.log(`Patient: "I will take the second option please"`);
    console.log(`Agent: "${turn1A_2.responseText}"`);

    const bookedApptId = turn1A_2.context.activeAppointmentId;
    if (!bookedApptId) {
      console.log('❌ FAIL: No appointment was booked in Turn 2');
      p0Passed = false;
    } else {
      const bookedAppt = await prisma.appointment.findUnique({
        where: { id: bookedApptId }
      });
      console.log(`Booked Appointment ID: ${bookedAppt?.id}`);
      console.log(`Booked Appointment StartTime: ${bookedAppt?.startTime.toISOString()}`);
      console.log(`Expected Slot StartTime:      ${new Date(expectedSlot.startTime).toISOString()}`);

      const matches = bookedAppt?.startTime.getTime() === new Date(expectedSlot.startTime).getTime();
      if (matches) {
        console.log('✅ PASS: Booked appointment matches exactly the second option requested by patient');
      } else {
        console.log('❌ FAIL: Booked appointment DOES NOT match the second option requested by patient!');
        p0Passed = false;
      }
    }
  }

  // Test 1B: "the 9am one" / specific time selection
  console.log(`\nScenario 1B: Multi-option selection by specific time ("the 9am one" or specific hour)`);
  const conv1BId = `phase0-test1-time-${Date.now()}`;
  const agent1B = new PatientAccessAgent({
    conversationId: conv1BId,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
  });

  const turn1B_1 = await agent1B.processTurn('What openings does Dr. Arvind Rao have this week?');
  console.log(`Patient: "What openings does Dr. Arvind Rao have this week?"`);
  console.log(`Agent: "${turn1B_1.responseText}"`);

  const offered1B = turn1B_1.context.ambiguousOptions || [];
  console.log(`Offered Slots (${offered1B.length}):`);
  offered1B.forEach((s: any, idx: number) => {
    console.log(`  [${idx}] Slot ID: ${s.slotId} | Start: ${s.startTime}`);
  });

  if (offered1B.length > 0) {
    // Determine the hour of slot 0 or slot 1
    const targetSlot = offered1B[0];
    const targetDate = new Date(targetSlot.startTime);
    const timePhrase = targetDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    const utterance = `I'll take the ${timePhrase} one`;

    console.log(`Patient: "${utterance}"`);
    const turn1B_2 = await agent1B.processTurn(utterance);
    console.log(`Agent: "${turn1B_2.responseText}"`);

    const bookedApptId = turn1B_2.context.activeAppointmentId;
    if (!bookedApptId) {
      console.log(`❌ FAIL: No appointment booked for "${utterance}"`);
      p0Passed = false;
    } else {
      const bookedAppt = await prisma.appointment.findUnique({
        where: { id: bookedApptId }
      });
      console.log(`Booked Appointment StartTime: ${bookedAppt?.startTime.toISOString()}`);
      console.log(`Expected Slot StartTime:      ${new Date(targetSlot.startTime).toISOString()}`);
      const matches = bookedAppt?.startTime.getTime() === new Date(targetSlot.startTime).getTime();
      if (matches) {
        console.log(`✅ PASS: Booked appointment matches exactly "${utterance}"`);
      } else {
        console.log(`❌ FAIL: Booked appointment DOES NOT match target slot for "${utterance}"!`);
        p0Passed = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Decline questionnaire, then wait with NO input
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: Decline questionnaire, then wait with NO input ---');

  const conv2Id = `phase0-test2-decline-${Date.now()}`;
  const agent2 = new PatientAccessAgent({
    conversationId: conv2Id,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
  });

  console.log(`\nScenario 2A: Decline questionnaire ("no thanks, I will pass") -> wait with NO input ("")`);
  const turn2_1 = await agent2.processTurn('I need an orthopedic appointment for my shoulder pain');
  console.log(`Patient: "I need an orthopedic appointment for my shoulder pain"`);
  console.log(`Agent: "${turn2_1.responseText}"`);

  const turn2_2 = await agent2.processTurn('Yes, please book that first opening');
  console.log(`Patient: "Yes, please book that first opening"`);
  console.log(`Agent: "${turn2_2.responseText}"`);

  // Decline questionnaire
  const turn2_3 = await agent2.processTurn("No thank you, I'll pass for now");
  console.log(`Patient: "No thank you, I'll pass for now"`);
  console.log(`Agent: "${turn2_3.responseText}"`);

  // Wait with NO input (silence / empty utterance)
  console.log(`Patient: [Waits with NO input / silence: ""]`);
  const turn2_4 = await agent2.processTurn('');
  console.log(`Agent: "${turn2_4.responseText}"`);
  console.log(`Intent Detected: ${turn2_4.intentDetected}`);

  const isGenericGreeting = turn2_4.responseText.includes('Hello! I am your AI Patient Access Assistant') ||
                           turn2_4.intentDetected === 'GREETING_OR_GENERAL_HELP';

  if (isGenericGreeting) {
    console.log('❌ FAIL: Agent self-reset to generic greeting upon silence/no-input after declining questionnaire!');
    p0Passed = false;
  } else {
    console.log('✅ PASS: Agent did NOT reset to generic greeting on silence');
  }

  // Variation 2B: Decline with "not right now" then user says "thank you" or silence
  console.log(`\nScenario 2B (Variation): Decline with "not right now" -> wait with silence`);
  const conv2BId = `phase0-test2b-decline-${Date.now()}`;
  const agent2B = new PatientAccessAgent({
    conversationId: conv2BId,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
  });

  await agent2B.processTurn('I need to book Dr. Arvind Rao');
  await agent2B.processTurn('Book the opening');
  const turn2B_3 = await agent2B.processTurn('Not right now');
  console.log(`Patient: "Not right now"`);
  console.log(`Agent: "${turn2B_3.responseText}"`);

  const turn2B_4 = await agent2B.processTurn('');
  console.log(`Patient: [Waits with NO input: ""]`);
  console.log(`Agent: "${turn2B_4.responseText}"`);
  console.log(`Intent Detected: ${turn2B_4.intentDetected}`);

  const isGenericGreeting2B = turn2B_4.responseText.includes('Hello! I am your AI Patient Access Assistant') ||
                             turn2B_4.intentDetected === 'GREETING_OR_GENERAL_HELP';

  if (isGenericGreeting2B) {
    console.log('❌ FAIL: Variation 2B reset to generic greeting on silence!');
    p0Passed = false;
  } else {
    console.log('✅ PASS: Variation 2B did NOT reset to generic greeting on silence');
  }

  console.log('\n================================================================');
  console.log(`PHASE 0 OVERALL RESULT: ${p0Passed ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log('================================================================');
}

runPhase0().catch((err) => {
  console.error('Phase 0 execution error:', err);
  process.exit(1);
});
