import WebSocket from 'ws';
import crypto from 'node:crypto';
import assert from 'node:assert';

const GATEWAY_URL = 'ws://localhost:3002/ws/voice';

function openSession(conversationId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_URL}?conversationId=${conversationId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function waitForMessage(ws: WebSocket, messageType: string, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for message type "${messageType}" after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === messageType) {
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

async function testLiveBargeIn() {
  console.log('\n--- 1. Testing Live Barge-In Interruption ---');
  const convId = `live-bargein-${crypto.randomUUID().slice(0, 6)}`;
  const ws = await openSession(convId);

  // Send a complex turn that triggers a multi-doctor search
  const correlationId1 = `corr-barge-${Date.now()}`;
  ws.send(
    JSON.stringify({
      type: 'USER_UTTERANCE',
      conversationId: convId,
      correlationId: correlationId1,
      text: 'Search for cardiologists in Apollo Hospital',
    })
  );

  // Immediately (within 20ms) trigger patient barge-in interruption while turn is in-flight
  await new Promise((r) => setTimeout(r, 20));
  const tInterrupt = Date.now();
  ws.send(
    JSON.stringify({
      type: 'INTERRUPT',
      conversationId: convId,
      correlationId: correlationId1,
    })
  );

  // Wait for INTERRUPT_ACK
  const ack = await waitForMessage(ws, 'INTERRUPT_ACK');
  const interruptElapsed = Date.now() - tInterrupt;
  console.log(`✅ Received INTERRUPT_ACK in ${interruptElapsed}ms:`, ack);
  assert.strictEqual(ack.type, 'INTERRUPT_ACK');

  // Immediately send new patient utterance right after interruption
  const correlationId2 = `corr-after-barge-${Date.now()}`;
  ws.send(
    JSON.stringify({
      type: 'USER_UTTERANCE',
      conversationId: convId,
      correlationId: correlationId2,
      text: 'Actually, tell me your working hours instead',
    })
  );

  const response = await waitForMessage(ws, 'AGENT_TURN');
  console.log(`✅ Successfully processed new utterance immediately after barge-in: "${response.spokenText.slice(0, 60)}..."`);
  assert.ok(response.spokenText, 'Response must be received');

  ws.close();
}

async function testLiveIdleTimeoutAndKeepalive() {
  console.log('\n--- 2. Testing Live Idle-Timeout & Heartbeat Keepalive ---');
  const convId = `live-idle-${crypto.randomUUID().slice(0, 6)}`;
  const ws = await openSession(convId);

  console.log('Simulating 10 seconds of idle session with 8s heartbeat keepalive...');
  const tStart = Date.now();

  // Send heartbeat ping at 5s
  await new Promise((r) => setTimeout(r, 5000));
  console.log('Dispatching client heartbeat ping...');
  ws.send(
    JSON.stringify({
      type: 'PING',
      conversationId: convId,
      correlationId: `ping-${Date.now()}`,
      timestamp: Date.now(),
    })
  );

  const pong = await waitForMessage(ws, 'PONG');
  console.log(`✅ Received PONG from gateway in ${Date.now() - tStart}ms:`, pong);
  assert.strictEqual(pong.type, 'PONG');

  // Wait another 3s (total 8s+ idle) and send real utterance
  await new Promise((r) => setTimeout(r, 3000));
  console.log('Sending patient utterance after extended idle period...');
  ws.send(
    JSON.stringify({
      type: 'USER_UTTERANCE',
      conversationId: convId,
      correlationId: `corr-idle-${Date.now()}`,
      text: 'Hello, are you still connected?',
    })
  );

  const response = await waitForMessage(ws, 'AGENT_TURN');
  console.log(`✅ Agent responded cleanly after idle period: "${response.spokenText.slice(0, 60)}..."`);
  assert.ok(response.spokenText, 'Response must be received');

  ws.close();
}

async function main() {
  try {
    await testLiveBargeIn();
    await testLiveIdleTimeoutAndKeepalive();
    console.log('\n🎉 Both live pipeline scenarios PASSED with 100% success against running gateway!');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

main();
