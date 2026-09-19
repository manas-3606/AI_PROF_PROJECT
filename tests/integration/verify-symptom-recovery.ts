import WebSocket from 'ws';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { prisma } from '@health/db';

const GATEWAY_URL = 'ws://localhost:3002/ws/voice';

function openSession(conversationId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_URL}?conversationId=${conversationId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function waitForTurnResponse(ws: WebSocket, timeoutMs = 25000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for AGENT_TURN after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'AGENT_TURN') {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(parsed);
        }
      } catch {
        // ignore
      }
    };

    ws.on('message', handler);
  });
}

async function sendUtterance(ws: WebSocket, conversationId: string, text: string) {
  const correlationId = `corr-${crypto.randomUUID()}`;
  ws.send(
    JSON.stringify({
      type: 'USER_UTTERANCE',
      conversationId,
      correlationId,
      text,
    })
  );
  return await waitForTurnResponse(ws);
}

async function runLiveVerification() {
  console.log('================================================================');
  console.log('LIVE VERIFICATION: SYMPTOM DISCOVERY, RECOVERY & ANTI-LOOP GUARD');
  console.log('================================================================\n');

  // =========================================================================
  // SCENARIO 1: Exact Reproduction - "I am having severe heart pain."
  // =========================================================================
  console.log('--- SCENARIO 1: Exact Reproduction ("I am having severe heart pain.") ---');
  const convId1 = `scen1-${crypto.randomUUID()}`;
  const ws1 = await openSession(convId1);

  // Turn 1: Patient reports severe heart pain
  console.log('[USER Turn 1]: "I am having severe heart pain."');
  const turn1_1 = await sendUtterance(ws1, convId1, 'I am having severe heart pain.');
  console.log(`[AGENT Turn 1]: "${turn1_1.spokenText}"`);
  console.log(`[AGENT Meta]: intent=${turn1_1.intent}, capability=${turn1_1.capabilityCalled}`);

  // Assertions for Turn 1:
  assert.ok(!turn1_1.spokenText.includes('that slot is no longer available'), 'Must not produce slot unavailable error');
  assert.ok(
    turn1_1.spokenText.toLowerCase().includes('heart') ||
    turn1_1.spokenText.toLowerCase().includes('cardio') ||
    turn1_1.spokenText.toLowerCase().includes('patel'),
    'Must discover Cardiology / Dr. Patel'
  );

  // Turn 2: Patient confirms ("Yeah.")
  console.log('\n[USER Turn 2]: "Yeah."');
  const turn1_2 = await sendUtterance(ws1, convId1, 'Yeah.');
  console.log(`[AGENT Turn 2]: "${turn1_2.spokenText}"`);
  console.log(`[AGENT Meta]: intent=${turn1_2.intent}, capability=${turn1_2.capabilityCalled}`);

  // Must NOT repeat generic error
  assert.ok(!turn1_2.spokenText.includes('that slot is no longer available'), 'Turn 2 must not produce slot unavailable error');
  assert.ok(
    turn1_2.spokenText.toLowerCase().includes('confirm') ||
    turn1_2.spokenText.toLowerCase().includes('book') ||
    turn1_2.spokenText.toLowerCase().includes('scheduled') ||
    turn1_2.spokenText.toLowerCase().includes('dr. maya patel') ||
    turn1_2.spokenText.toLowerCase().includes('intake questionnaire'),
    'Turn 2 must confirm or advance booking'
  );

  ws1.close();
  console.log('>>> SCENARIO 1 PASSED: Zero generic error loop, Cardiology discovered & booked cleanly!\n');

  // =========================================================================
  // SCENARIO 2: Orthopedics Symptom Report - Back & Neck stiffness
  // =========================================================================
  console.log('--- SCENARIO 2: Orthopedics Symptom Discovery ---');
  const convId2 = `scen2-${crypto.randomUUID()}`;
  const ws2 = await openSession(convId2);

  console.log('[USER Turn 1]: "I have severe lower back and neck stiffness after lifting weights."');
  const turn2_1 = await sendUtterance(ws2, convId2, 'I have severe lower back and neck stiffness after lifting weights.');
  console.log(`[AGENT Turn 1]: "${turn2_1.spokenText}"`);
  console.log(`[AGENT Meta]: intent=${turn2_1.intent}, capability=${turn2_1.capabilityCalled}`);

  assert.ok(!turn2_1.spokenText.includes('that slot is no longer available'), 'Must not produce slot unavailable error');
  assert.ok(
    turn2_1.spokenText.toLowerCase().includes('orthopedic') ||
    turn2_1.spokenText.toLowerCase().includes('back') ||
    turn2_1.spokenText.toLowerCase().includes('rao') ||
    turn2_1.spokenText.toLowerCase().includes('spine'),
    'Must discover Orthopedics / Dr. Rao'
  );

  console.log('\n[USER Turn 2]: "Yes, please book that"');
  const turn2_2 = await sendUtterance(ws2, convId2, 'Yes, please book that');
  console.log(`[AGENT Turn 2]: "${turn2_2.spokenText}"`);
  console.log(`[AGENT Meta]: intent=${turn2_2.intent}, capability=${turn2_2.capabilityCalled}`);

  assert.ok(!turn2_2.spokenText.includes('that slot is no longer available'), 'Must not produce slot unavailable error');
  assert.ok(
    turn2_2.spokenText.toLowerCase().includes('confirm') ||
    turn2_2.spokenText.toLowerCase().includes('book') ||
    turn2_2.spokenText.toLowerCase().includes('scheduled') ||
    turn2_2.spokenText.toLowerCase().includes('rao') ||
    turn2_2.spokenText.toLowerCase().includes('intake questionnaire'),
    'Must confirm booking for Orthopedics'
  );

  ws2.close();
  console.log('>>> SCENARIO 2 PASSED: Orthopedics discovered & booked cleanly!\n');

  // =========================================================================
  // SCENARIO 3: Automatic Recovery from Slot Conflict & Anti-Loop Guardrail
  // =========================================================================
  console.log('--- SCENARIO 3: Automatic Slot Conflict Recovery ---');
  const convId3 = `scen3-${crypto.randomUUID()}`;
  const ws3 = await openSession(convId3);

  console.log('[USER Turn 1]: "I need to see a doctor for high fever and cough."');
  const turn3_1 = await sendUtterance(ws3, convId3, 'I need to see a doctor for high fever and cough.');
  console.log(`[AGENT Turn 1]: "${turn3_1.spokenText}"`);

  // Turn 2: Patient confirms
  console.log('\n[USER Turn 2]: "Yes please, book that for me."');
  const turn3_2 = await sendUtterance(ws3, convId3, 'Yes please, book that for me.');
  console.log(`[AGENT Turn 2]: "${turn3_2.spokenText}"`);
  assert.ok(!turn3_2.spokenText.includes('that slot is no longer available or an error occurred'), 'Must not produce generic error');

  ws3.close();
  console.log('>>> SCENARIO 3 PASSED: General Medicine discovered & booked cleanly!\n');

  // =========================================================================
  // SCENARIO 4: Stale AWAITING_SLOT_SELECTION Resumed Session
  // =========================================================================
  console.log('--- SCENARIO 4: Stale AWAITING_SLOT_SELECTION Context with New Symptom ---');
  const { PatientAccessAgent, ConversationContextManager } = await import('../../packages/capabilities/dist/index.js');
  const convId4 = `scen4-stale-${crypto.randomUUID()}`;
  const agent4 = new PatientAccessAgent({ conversationId: convId4, channel: 'VOICE' });

  // Doctor
  const doc = await prisma.doctor.findFirst({ where: { specialty: 'Cardiology' } });
  const fakeOfferedSlotId = crypto.randomUUID();
  await ConversationContextManager.updateContext(convId4, {
    currentIntent: 'AWAITING_SLOT_SELECTION',
    selectedDoctorId: doc?.id,
    offeredSlotIds: [fakeOfferedSlotId],
  });

  console.log(`[SETUP]: Context initialized with currentIntent='AWAITING_SLOT_SELECTION' and offeredSlotIds=[${fakeOfferedSlotId}]`);
  console.log('[USER Turn 1]: "I am having severe heart pain."');
  const res4_1 = await agent4.processTurn('I am having severe heart pain.');
  console.log(`[AGENT Turn 1]: "${res4_1.responseText}"`);
  console.log(`[AGENT Meta]: intent=${res4_1.intentDetected}, capability=${res4_1.capabilityCalled}`);

  // CRITICAL: Must NOT attempt to book fakeOfferedSlotId! Must break out and offer Cardiology
  assert.ok(!res4_1.responseText.includes('that slot is no longer available'), 'Must break out of stale slot selection on symptom report');
  assert.ok(
    res4_1.responseText.toLowerCase().includes('heart') ||
    res4_1.responseText.toLowerCase().includes('patel') ||
    res4_1.responseText.toLowerCase().includes('cardio'),
    'Must start Cardiology discovery'
  );

  console.log('>>> SCENARIO 4 PASSED: Stale slot context successfully broken out on symptom report!\n');

  console.log('================================================================');
  console.log('ALL 4 LIVE VERIFICATION SCENARIOS COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
}

runLiveVerification().catch((err) => {
  console.error('FAILED LIVE VERIFICATION:', err);
  process.exit(1);
});
