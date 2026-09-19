import crypto from 'node:crypto';

async function run5x() {
  const url = 'https://ai-prof-project-1.onrender.com/api/chat/turn';
  const utterance = 'book an appointment with Dr Arvind Rao at morning Monday';
  console.log(`Testing 5 consecutive turns against DEPLOYED instance: ${url}\n`);

  for (let i = 1; i <= 5; i++) {
    const conversationId = crypto.randomUUID();
    console.log(`\n=================== RUN #${i} [convId: ${conversationId}] ===================`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': `corr-test-5x-${Date.now()}-${i}`
        },
        body: JSON.stringify({
          conversationId,
          patientId: 'ea08ea40-d912-4790-a72d-b88c78c286f7',
          hospitalId: '9939cb84-24e1-4446-b2f0-4605917b0482',
          message: utterance
        }),
        signal: AbortSignal.timeout(30000)
      });

      console.log(`HTTP Status: ${res.status}`);
      const data: any = await res.json();
      console.log('Spoken Text:', data.spokenText);
      console.log('Response Text:', data.responseText);
      console.log('Intent Detected:', data.intentDetected);
      console.log('Correlation ID:', data.correlationId);

      const containsRao = data.spokenText?.toLowerCase().includes('arvind rao');
      const containsAnya = data.spokenText?.toLowerCase().includes('anya');
      console.log(`Verification result: Mentions Arvind Rao: ${containsRao}, Mentions Anya: ${containsAnya}`);
    } catch (err: any) {
      console.error(`Run #${i} failed:`, err.message);
    }
  }
}

run5x().catch(console.error);
