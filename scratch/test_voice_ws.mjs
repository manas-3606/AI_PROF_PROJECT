import WebSocket from 'ws';

async function testWs() {
  const url = 'wss://ai-prof-voice-gateway.onrender.com/ws/voice';
  console.log('Connecting to WebSocket:', url);

  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      handshakeTimeout: 10000,
    });

    const timer = setTimeout(() => {
      console.log('WebSocket connection TIMEOUT after 10s');
      ws.terminate();
      resolve({ connected: false, reason: 'TIMEOUT' });
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timer);
      console.log(' WebSocket connected successfully over WSS!');
      ws.send(JSON.stringify({ type: 'ping' }));
    });

    ws.on('message', (data) => {
      console.log('Received WebSocket message:', data.toString());
      ws.close();
      resolve({ connected: true, response: data.toString() });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      console.log('WebSocket error:', err.message);
      resolve({ connected: false, error: err.message });
    });
  });
}

testWs().then(res => console.log('Result:', res));
