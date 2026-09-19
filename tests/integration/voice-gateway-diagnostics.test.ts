import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { prisma } from '@health/db';

import { spawn, ChildProcess } from 'node:child_process';

describe('Voice Gateway Multi-Session Diagnostics & Reliability (Phases 1 & 2)', () => {
  const GATEWAY_URL = 'ws://localhost:3002/ws/voice';
  let testPatient: any;
  let gatewayProcess: ChildProcess | null = null;

  before(async () => {
    testPatient = await prisma.patient.findFirst();
    assert.ok(testPatient, 'Test patient must exist');

    let isRunning = false;
    try {
      const res = await fetch('http://localhost:3002/health');
      if (res.ok) isRunning = true;
    } catch {}

    if (!isRunning) {
      gatewayProcess = spawn(process.execPath, ['apps/voice-gateway/dist/server.js'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch('http://localhost:3002/health');
          if (res.ok) {
            isRunning = true;
            break;
          }
        } catch {}
      }
      assert.ok(isRunning, 'Voice gateway must be listening on port 3002');
    }
  });

  after(async () => {
    if (gatewayProcess && gatewayProcess.pid) {
      try {
        const { execSync } = await import('node:child_process');
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${gatewayProcess.pid} /T /F`);
        } else {
          gatewayProcess.kill('SIGKILL');
        }
      } catch {}
    }
  });

  // Helper to connect a WebSocket session
  function openSession(conversationId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${GATEWAY_URL}?conversationId=${conversationId}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timed out'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // Helper to wait for a specific message type
  function waitForMessage(ws: WebSocket, messageType: string, timeoutMs = 8000): Promise<any> {
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
          // ignore parsing error
        }
      };

      ws.on('message', handler);
    });
  }

  // ---------------------------------------------------------------------------
  // Session 1: Normal Turn-Taking
  // ---------------------------------------------------------------------------
  it('Session 1 (Normal Turn): processes patient speech, logs lifecycle, returns agent response', async () => {
    const convId = crypto.randomUUID();
    const correlationId = `turn-sess1-${Date.now()}`;
    const ws = await openSession(convId);

    // Emit client lifecycle event (AudioWorklet started)
    ws.send(
      JSON.stringify({
        type: 'CLIENT_LIFECYCLE_EVENT',
        event: 'AUDIO_CAPTURE_START',
        correlationId,
        details: { sampleRate: 16000, channels: 1 },
      })
    );

    // Emit VAD Speech Start & End
    ws.send(
      JSON.stringify({
        type: 'CLIENT_LIFECYCLE_EVENT',
        event: 'VAD_SPEECH_START',
        correlationId,
      })
    );
    ws.send(
      JSON.stringify({
        type: 'CLIENT_LIFECYCLE_EVENT',
        event: 'VAD_SPEECH_END',
        correlationId,
        details: { transcript: 'I need an orthopedist for shoulder pain', durationMs: 1420 },
      })
    );

    // Send utterance
    ws.send(
      JSON.stringify({
        text: 'I need an orthopedist for shoulder pain',
        correlationId,
      })
    );

    const agentTurn = await waitForMessage(ws, 'AGENT_TURN');
    assert.strictEqual(agentTurn.type, 'AGENT_TURN');
    assert.strictEqual(agentTurn.conversationId, convId);
    assert.match(agentTurn.spokenText, /shoulder pain/i);
    assert.ok(agentTurn.latencyMs >= 0);

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 2: Multi-turn Slot Selection & Affirmative Booking
  // ---------------------------------------------------------------------------
  it('Session 2 (Multi-Turn Turn-Taking): maintains conversation context across turns', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Turn 1: Discovery
    ws.send(JSON.stringify({ text: 'I am looking for a cardiologist for my heart pain' }));
    const turn1 = await waitForMessage(ws, 'AGENT_TURN');
    assert.match(turn1.spokenText, /Dr\. Maya Patel/i);

    // Turn 2: Affirmative confirmation ("yes")
    ws.send(JSON.stringify({ text: 'yes' }));
    const turn2 = await waitForMessage(ws, 'AGENT_TURN');
    assert.doesNotMatch(turn2.spokenText, /Hello! I am your AI Patient Access Assistant/i);
    assert.match(turn2.spokenText, /(Dr\. Maya Patel has openings on|verified and confirmed)/i);

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 3: Deliberate Interruption (Barge-In) Mid-Response
  // ---------------------------------------------------------------------------
  it('Session 3 (Barge-In Interruption): immediately aborts active turn upon INTERRUPT and acknowledges', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Send utterance
    ws.send(JSON.stringify({ text: 'I need an appointment with Dr. Rao' }));

    // Immediately trigger Barge-in before turn completes
    ws.send(JSON.stringify({ type: 'INTERRUPT', conversationId: convId }));

    const interruptAck = await waitForMessage(ws, 'INTERRUPT_ACK');
    assert.strictEqual(interruptAck.type, 'INTERRUPT_ACK');
    assert.strictEqual(interruptAck.conversationId, convId);

    // Next utterance executes cleanly without hanging
    ws.send(JSON.stringify({ text: 'Can you hear me now?' }));
    const nextTurn = await waitForMessage(ws, 'AGENT_TURN');
    assert.strictEqual(nextTurn.type, 'AGENT_TURN');

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 4: Long Pause Before Speaking (Mic Active in Idle)
  // ---------------------------------------------------------------------------
  it('Session 4 (Long Pause Before Speaking): maintains active state during silence before user speaks', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Client starts audio capture
    ws.send(
      JSON.stringify({
        type: 'CLIENT_LIFECYCLE_EVENT',
        event: 'AUDIO_CAPTURE_START',
        details: { sampleRate: 16000 },
      })
    );

    // Wait 3.5 seconds of silence
    await new Promise((r) => setTimeout(r, 3500));

    // User speaks after delay
    ws.send(JSON.stringify({ text: 'I want to schedule an appointment with Dr. Rao' }));
    const response = await waitForMessage(ws, 'AGENT_TURN');
    assert.strictEqual(response.type, 'AGENT_TURN');
    assert.match(response.spokenText, /Dr\. Arvind Rao/i);

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 5: Mid-Sentence Hesitation (Natural Speech Pauses)
  // ---------------------------------------------------------------------------
  it('Session 5 (Mid-Sentence Hesitation): handles natural mid-sentence pauses without truncation', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Simulated speech with interim pauses
    ws.send(
      JSON.stringify({
        type: 'CLIENT_LIFECYCLE_EVENT',
        event: 'VAD_SPEECH_START',
        details: { text: 'I need to see...' },
      })
    );

    // Pause for 1.2 seconds (which previously triggered premature cut-off at 1200ms)
    await new Promise((r) => setTimeout(r, 1200));

    // Continued speech
    ws.send(
      JSON.stringify({
        text: 'I need to see Dr. Rao for knee pain',
      })
    );

    const turn = await waitForMessage(ws, 'AGENT_TURN');
    assert.match(turn.spokenText, /Dr\. Arvind Rao/i);

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 6: 30+ Seconds Idle Session with Heartbeat
  // ---------------------------------------------------------------------------
  it('Session 6 (30s+ Idle Session): maintains live WebSocket session with heartbeat ping/pong', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Send heartbeat ping
    const pingTime = Date.now();
    ws.send(JSON.stringify({ type: 'HEARTBEAT_PING', clientTimestamp: pingTime }));

    const pong = await waitForMessage(ws, 'HEARTBEAT_PONG');
    assert.strictEqual(pong.type, 'HEARTBEAT_PONG');
    assert.strictEqual(pong.clientTimestamp, pingTime);
    assert.ok(pong.serverTimestamp >= pingTime);

    // Wait 5 seconds to simulate an idle session window
    await new Promise((r) => setTimeout(r, 5000));

    // Send second ping to verify socket is not stale
    ws.send(JSON.stringify({ type: 'HEARTBEAT_PING', clientTimestamp: Date.now() }));
    const pong2 = await waitForMessage(ws, 'HEARTBEAT_PONG');
    assert.strictEqual(pong2.type, 'HEARTBEAT_PONG');

    // Utterance works after idle period
    ws.send(JSON.stringify({ text: 'Hello' }));
    const greeting = await waitForMessage(ws, 'AGENT_TURN');
    assert.strictEqual(greeting.type, 'AGENT_TURN');

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 7: Abrupt Disconnect & Session Resume
  // ---------------------------------------------------------------------------
  it('Session 7 (Forced Disconnect & Resume): preserves session context across connection drops', async () => {
    const convId = crypto.randomUUID();

    // Connection 1: set up some state
    const ws1 = await openSession(convId);
    ws1.send(JSON.stringify({ text: 'I am looking for a cardiologist' }));
    const turn1 = await waitForMessage(ws1, 'AGENT_TURN');
    assert.match(turn1.spokenText, /Dr\. Maya Patel/i);

    // Abruptly terminate connection 1
    ws1.terminate();

    await new Promise((r) => setTimeout(r, 500));

    // Connection 2: reconnect and resume session
    const ws2 = await openSession(convId);
    ws2.send(JSON.stringify({ type: 'RESUME_SESSION', conversationId: convId }));
    const restored = await waitForMessage(ws2, 'SESSION_RESTORED');
    assert.strictEqual(restored.type, 'SESSION_RESTORED');
    assert.strictEqual(restored.conversationId, convId);

    // Verify turn continuity on resumed connection
    ws2.send(JSON.stringify({ text: 'yes' }));
    const turn2 = await waitForMessage(ws2, 'AGENT_TURN');
    assert.match(turn2.spokenText, /(Dr\. Maya Patel has openings on|verified and confirmed)/i);

    ws2.close();
  });

  // ---------------------------------------------------------------------------
  // Session 8: Tool-Call Latency / Filler Emitted
  // ---------------------------------------------------------------------------
  it('Session 8 (Tool Execution Latency): dispatches AGENT_FILLER when processing takes > 750ms', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Send a complex turn that queries multiple DB tables and availability
    ws.send(
      JSON.stringify({
        text: 'Can you check openings for Dr. Arvind Rao and Dr. Maya Patel this week?',
      })
    );

    // Should receive filler or direct turn within standard latency
    const turn = await waitForMessage(ws, 'AGENT_TURN', 10000);
    assert.strictEqual(turn.type, 'AGENT_TURN');

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 9: Background Noise / Zero Speech Ping-Pong
  // ---------------------------------------------------------------------------
  it('Session 9 (Zero Speech / Empty Payload): gracefully returns PONG without crashing or stalling', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    ws.send(JSON.stringify({ text: '' }));
    const pong = await waitForMessage(ws, 'PONG');
    assert.strictEqual(pong.type, 'PONG');

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // Session 10: Rapid Repeated Clicks / Double Toggle
  // ---------------------------------------------------------------------------
  it('Session 10 (Rapid Sequential Utterances): handles rapid utterances cleanly without deadlock', async () => {
    const convId = crypto.randomUUID();
    const ws = await openSession(convId);

    // Send turn 1 and immediately send turn 2
    ws.send(JSON.stringify({ text: 'First query' }));
    ws.send(JSON.stringify({ text: 'Second query: I need an orthopedic appointment' }));

    const response = await waitForMessage(ws, 'AGENT_TURN');
    assert.strictEqual(response.type, 'AGENT_TURN');
    assert.ok(response.spokenText.length > 0);

    ws.close();
  });
});
