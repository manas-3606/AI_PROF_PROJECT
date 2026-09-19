import WebSocket from 'ws';
import crypto from 'node:crypto';

const GATEWAY_URL = 'ws://localhost:3002/ws/voice';

interface LatencyMeasurement {
  scenario: string;
  utterance: string;
  vadDebounceMs: number;
  serverProcessingMs: number;
  totalTurnLatencyMs: number;
  responseType: string;
  firstSpokenText: string;
}

function openSession(conversationId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_URL}?conversationId=${conversationId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

async function measureTurn(
  conversationId: string,
  utterance: string,
  vadDebounceMs: number
): Promise<LatencyMeasurement> {
  const ws = await openSession(conversationId);

  return new Promise((resolve, reject) => {
    // Simulated patient utterance ends at t0
    const t0 = Date.now();

    // VAD debounce simulates the client waiting for silence before sending frame
    setTimeout(() => {
      const tSend = Date.now();
      const correlationId = `corr-${crypto.randomUUID()}`;

      ws.on('message', (data) => {
        const tReceive = Date.now();
        const parsed = JSON.parse(data.toString());

        if (parsed.type === 'AGENT_TURN' || parsed.type === 'AGENT_FILLER') {
          const simulatedTtsInitMs = 65; // realistic browser SpeechSynthesis onset latency
          const totalTurnLatencyMs = tReceive - t0 + simulatedTtsInitMs;
          const serverProcessingMs = tReceive - tSend;

          ws.close();
          resolve({
            scenario: `VAD Debounce ${vadDebounceMs}ms`,
            utterance,
            vadDebounceMs,
            serverProcessingMs,
            totalTurnLatencyMs,
            responseType: parsed.type,
            firstSpokenText: parsed.spokenText || parsed.fillerText || '',
          });
        }
      });

      ws.send(
        JSON.stringify({
          type: 'USER_UTTERANCE',
          conversationId,
          correlationId,
          text: utterance,
        })
      );
    }, vadDebounceMs);
  });
}

async function runBenchmark() {
  console.log('=== REAL-TIME VOICE TURN LATENCY BENCHMARK ===\n');

  const testCases = [
    { utterance: 'Hello, what can you do?', label: 'Simple greeting / capability check' },
    { utterance: 'I want to see Dr. Arvind Rao tomorrow', label: 'Doctor schedule search' },
    { utterance: 'Book the 2pm slot please', label: 'Slot selection & confirmation' },
  ];

  const debounceSettings = [1200, 1800, 1400];
  const results: LatencyMeasurement[] = [];

  for (const debounce of debounceSettings) {
    console.log(`\n--- Testing VAD Debounce = ${debounce}ms ---`);
    for (const tc of testCases) {
      const convId = `bench-${debounce}-${crypto.randomUUID().slice(0, 6)}`;
      const res = await measureTurn(convId, tc.utterance, debounce);
      results.push(res);
      console.log(
        `[${debounce}ms] "${tc.utterance.slice(0, 25)}..." | Server: ${res.serverProcessingMs}ms | Total Turn Latency: ${res.totalTurnLatencyMs}ms (${res.responseType})`
      );
      // Small pause between sessions
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log('\n=== SUMMARY TABLE ===');
  console.table(
    results.map((r) => ({
      Debounce: `${r.vadDebounceMs}ms`,
      Utterance: r.utterance.slice(0, 30),
      'Server (ms)': r.serverProcessingMs,
      'Total E2E (ms)': r.totalTurnLatencyMs,
      '< 2000ms Target?': r.totalTurnLatencyMs < 2000 ? '✅ PASS' : '❌ EXCEEDS',
      Response: r.firstSpokenText.slice(0, 45) + '...',
    }))
  );

  // Compute averages
  for (const debounce of debounceSettings) {
    const subset = results.filter((r) => r.vadDebounceMs === debounce);
    const avg = Math.round(subset.reduce((a, b) => a + b.totalTurnLatencyMs, 0) / subset.length);
    console.log(`Average E2E Latency for ${debounce}ms debounce: ${avg}ms`);
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
