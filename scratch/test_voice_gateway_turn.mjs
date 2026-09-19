import WebSocket from 'ws';

async function testVoiceTurn() {
  const url = 'wss://ai-prof-voice-gateway.onrender.com/ws/voice';
  console.log('--- Testing Live Voice Gateway Turn over WSS ---');
  console.log('Target URL:', url);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10000 });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Voice Gateway turn timed out after 15s'));
    }, 15000);

    const receivedMessages = [];

    ws.on('open', () => {
      console.log('1. Connected to Voice Gateway over WSS');
      // Send a patient voice utterance
      const turnPayload = {
        type: 'SPEECH_TRANSCRIPT',
        transcript: 'Hello, I have knee pain and would like to see an orthopedic doctor',
        correlationId: `voice-test-${Date.now()}`
      };
      console.log('2. Sending patient utterance:', turnPayload.transcript);
      ws.send(JSON.stringify(turnPayload));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log(`3. Received server message [${msg.type}]:`, msg.spokenText || msg.text || msg.status || '');
      receivedMessages.push(msg);

      // If we receive the full agent response or error, finish
      if (msg.type === 'AGENT_RESPONSE' || msg.type === 'TURN_COMPLETED' || msg.type === 'PONG') {
        clearTimeout(timeout);
        ws.close();
        resolve(receivedMessages);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

testVoiceTurn()
  .then((msgs) => {
    console.log('\n SUCCESS: Voice Gateway turn completed successfully over live WSS!');
    console.log('Total messages exchanged:', msgs.length);
  })
  .catch((err) => {
    console.error('Voice Gateway turn test failed:', err);
    process.exit(1);
  });
