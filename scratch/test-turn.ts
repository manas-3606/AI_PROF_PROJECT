import { PatientAccessAgent } from '@health/capabilities';

async function run() {
  const agent = new PatientAccessAgent({ conversationId: 'test-rao-slots-' + Date.now() });
  const res1 = await agent.processTurn('Book Dr. Rao');
  console.log('TURN 1:');
  console.log('Spoken:', res1.spokenText);
  console.log('Intent:', res1.intentDetected);
  console.log('Capability:', res1.capabilityCalled);
  console.log('ClarificationNeeded:', res1.clarificationNeeded);
  console.log('Context:', res1.context);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
