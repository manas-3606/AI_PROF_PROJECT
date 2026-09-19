import crypto from 'node:crypto';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { PatientAccessAgent, ConversationContextManager } from '../../packages/capabilities/dist/index.js';

async function testConflictRecoveryAndLoopPrevention() {
  console.log('--- TESTING SLOT CONFLICT AUTOMATIC RECOVERY & LOOP GUARD ---');

  const convId = `conflict-test-${crypto.randomUUID()}`;
  const agent = new PatientAccessAgent({ conversationId: convId, channel: 'VOICE' });

  // 1. Get a doctor and their available slots
  const doctor = await prisma.doctor.findFirst({
    where: { specialty: 'Cardiology' },
    include: {
      slots: {
        where: { isBooked: false, isBlocked: false },
        orderBy: { startTime: 'asc' },
        take: 3
      }
    }
  });

  assert.ok(doctor && doctor.slots.length >= 2, 'Doctor must have at least 2 available slots');
  const slotToConflict = doctor.slots[0];
  const slotAlternative = doctor.slots[1];

  // 2. Set context as if slots were offered
  await ConversationContextManager.updateContext(convId, {
    currentIntent: 'AWAITING_SLOT_SELECTION',
    selectedDoctorId: doctor.id,
    lastOfferedSlotIds: [slotToConflict.id, slotAlternative.id],
    ambiguousOptions: [
      { id: slotToConflict.id, startTime: slotToConflict.startTime.toISOString(), doctorName: doctor.name },
      { id: slotAlternative.id, startTime: slotAlternative.startTime.toISOString(), doctorName: doctor.name }
    ]
  });

  // 3. Mark the slot as BOOKED in the DB to simulate concurrent conflict
  console.log(`[SIMULATION]: Mark slot ${slotToConflict.id} as BOOKED in DB...`);
  await prisma.slot.update({
    where: { id: slotToConflict.id },
    data: { isBooked: true }
  });

  // 4. Patient tries to book that slot ("the first one please")
  console.log('[USER Turn 1]: "the first one please"');
  const res1 = await agent.processTurn('the first one please');
  console.log(`[AGENT Turn 1]: "${res1.responseText}"`);

  // Assertions for Recovery:
  // Must NOT give the dead-end "that slot is no longer available or an error occurred. Would you like to select another time?"
  // Must inform patient the slot was taken and immediately offer available alternative slots!
  assert.ok(res1.responseText.toLowerCase().includes('was just taken') || res1.responseText.toLowerCase().includes('no longer available'));
  assert.ok(res1.responseText.toLowerCase().includes('however') || res1.responseText.toLowerCase().includes('available'));
  assert.ok(!res1.responseText.endsWith('an error occurred. Would you like to select another time?'));

  // 5. Patient now affirms the alternative
  console.log('\n[USER Turn 2]: "Yes, that alternative works."');
  const res2 = await agent.processTurn('Yes, that alternative works.');
  console.log(`[AGENT Turn 2]: "${res2.responseText}"`);

  // Turn 2 must book the alternative cleanly!
  assert.ok(
    res2.responseText.toLowerCase().includes('confirmed') ||
    res2.responseText.toLowerCase().includes('scheduled') ||
    res2.responseText.toLowerCase().includes('intake questionnaire')
  );

  // 6. Now test loop prevention: trigger 2 consecutive failures in a fresh conversation
  console.log('\n--- TESTING ANTI-LOOP GUARDRAIL (ESC TO HUMAN ON REPEATED FAILURES) ---');
  const loopConvId = `loop-guard-${crypto.randomUUID()}`;
  const loopAgent = new PatientAccessAgent({ conversationId: loopConvId, channel: 'VOICE' });

  // Simulate context with a dead slot and no other available slots
  await ConversationContextManager.updateContext(loopConvId, {
    currentIntent: 'AWAITING_SLOT_SELECTION',
    selectedDoctorId: 'invalid-doctor-id',
    lastOfferedSlotIds: ['invalid-slot-id'],
    ambiguousOptions: [{ id: 'invalid-slot-id', startTime: new Date().toISOString(), doctorName: 'Dr. Test' }],
    completedWorkflowState: { bookingFailureCount: 1 } // already failed once
  });

  console.log('[USER Turn 1 (2nd failure attempt)]: "Confirm booking"');
  const resLoop = await loopAgent.processTurn('Confirm booking');
  console.log(`[AGENT Loop Guard Response]: "${resLoop.responseText}"`);
  console.log(`[AGENT Loop Guard Meta]: transferredToHuman=${resLoop.transferredToHuman}`);

  assert.strictEqual(resLoop.transferredToHuman, true, 'Must transfer to human coordinator after repeated failures');
  assert.ok(
    resLoop.responseText.toLowerCase().includes('transfer') ||
    resLoop.responseText.toLowerCase().includes('scheduling desk') ||
    resLoop.responseText.toLowerCase().includes('coordinator')
  );

  console.log('\n>>> CONFLICT RECOVERY & ANTI-LOOP GUARD TEST PASSED 100%!');
}

testConflictRecoveryAndLoopPrevention().catch((err) => {
  console.error('FAILED CONFLICT TEST:', err);
  process.exit(1);
});
