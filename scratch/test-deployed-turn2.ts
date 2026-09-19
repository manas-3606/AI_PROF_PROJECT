import crypto from 'node:crypto';

async function testTurn2() {
  const url = 'https://ai-prof-project-1.onrender.com/api/chat/turn';
  console.log(`Testing multi-turn flow on DEPLOYED instance: ${url}\n`);

  const conversationId = crypto.randomUUID();
  console.log(`>>> Turn 1: Initial request for Dr Arvind Rao [convId: ${conversationId}]`);
  const res1 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-correlation-id': `corr-multi-1-${Date.now()}` },
    body: JSON.stringify({
      conversationId,
      patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
      hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
      message: 'book an appointment with Dr Arvind Rao at morning Monday'
    })
  });
  const data1: any = await res1.json();
  console.log('Turn 1 Status:', res1.status);
  console.log('Turn 1 Spoken:', data1.spokenText);

  console.log(`\n>>> Turn 2: "Book the second slot"`);
  const res2 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-correlation-id': `corr-multi-2-${Date.now()}` },
    body: JSON.stringify({
      conversationId,
      patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
      hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
      message: 'Book the second slot'
    })
  });
  const data2: any = await res2.json();
  console.log('Turn 2 Status:', res2.status);
  console.log('Turn 2 Spoken:', data2.spokenText);
  console.log('Turn 2 Intent:', data2.intentDetected);
  console.log('Turn 2 Capability:', data2.capabilityCalled);
  console.log('Turn 2 Correlation ID:', data2.correlationId);

  // Another conversation testing spoken time format: "book the 10 30 AM slot"
  const conv2 = crypto.randomUUID();
  console.log(`\n>>> Conv 2 - Turn 1: Request Dr Arvind Rao [convId: ${conv2}]`);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-correlation-id': `corr-conv2-1-${Date.now()}` },
    body: JSON.stringify({
      conversationId: conv2,
      patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
      hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
      message: 'book an appointment with Dr Arvind Rao at morning Monday'
    })
  });

  console.log(`>>> Conv 2 - Turn 2: "book the 10 30 AM slot"`);
  const resTime = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-correlation-id': `corr-conv2-2-${Date.now()}` },
    body: JSON.stringify({
      conversationId: conv2,
      patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
      hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
      message: 'book the 10 30 AM slot'
    })
  });
  const dataTime: any = await resTime.json();
  console.log('Conv 2 - Turn 2 Status:', resTime.status);
  console.log('Conv 2 - Turn 2 Spoken:', dataTime.spokenText);
  console.log('Conv 2 - Turn 2 Intent:', dataTime.intentDetected);
  console.log('Conv 2 - Turn 2 Capability:', dataTime.capabilityCalled);
}

testTurn2().catch(console.error);
