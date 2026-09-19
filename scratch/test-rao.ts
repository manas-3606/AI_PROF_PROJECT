import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';

async function test() {
  const utterance = 'book an appointment with Dr Arvind Rao at morning Monday';
  console.log('Testing utterance with PatientAccessAgent:', utterance);

  const agent = new PatientAccessAgent({
    conversationId: 'test-conv-' + Date.now(),
    patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
    hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
    channel: 'TEXT'
  });

  const response = await agent.processTurn(utterance);
  console.log('\n--- AGENT RESPONSE ---');
  console.log('Intent Detected:', response.intentDetected);
  console.log('Spoken Text:', response.spokenText);
  console.log('Response Text:', response.responseText);
  console.log('Capability Called:', response.capabilityCalled);
  console.log('Capability Result:', JSON.stringify(response.capabilityResult)?.slice(0, 300));
}

test().catch(console.error).finally(() => process.exit(0));
