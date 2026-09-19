import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';

async function testMultiTurn() {
  console.log('=== MULTI-TURN TEST: Dr. Arvind Rao & Slot Phrasings ===');

  const testCases = [
    { name: 'Ordinal', turn2: 'Book the second slot' },
    { name: 'Spoken with space', turn2: 'book the 10 00 slot' },
    { name: 'Spoken words', turn2: 'ten o clock' }
  ];

  for (const tc of testCases) {
    console.log(`\n----------------- TEST: ${tc.name} ("${tc.turn2}") -----------------`);
    const agent = new PatientAccessAgent({
      conversationId: 'test-conv-' + Math.random().toString(36).substring(7),
      patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
      hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
      channel: 'TEXT'
    });

    const res1 = await agent.processTurn('book an appointment with Dr Arvind Rao at morning Monday');
    console.log('Turn 1 response:', res1.spokenText);
    console.log('Turn 1 intent:', res1.intentDetected);

    const res2 = await agent.processTurn(tc.turn2);
    console.log('Turn 2 response:', res2.spokenText);
    console.log('Turn 2 intent:', res2.intentDetected);
    console.log('Turn 2 capability:', res2.capabilityCalled);
  }
}

testMultiTurn().catch(console.error).finally(() => process.exit(0));
