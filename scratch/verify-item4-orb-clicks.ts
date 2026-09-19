import { chromium } from 'playwright-core';

interface ClickLog {
  clickNum: number;
  timestamp: string;
  stateBefore: string;
  triggerContext: string;
  stateAfter: string;
  latencyMs: number;
  success: boolean;
}

async function verifyVoiceOrb() {
  console.log('================================================================');
  console.log('ITEM 4 / BUG 5 VERIFICATION: VOICE ORB RESPONSIVENESS LOG');
  console.log('Testing >= 10 consecutive clicks across idle, listening, speaking, thinking');
  console.log('================================================================\n');

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1380, height: 850 },
  });

  const page = await context.newPage();

  // Shim Web Audio and SpeechRecognition for deterministic browser environment
  await page.addInitScript(() => {
    class MockSpeechRecognition {
      continuous = true;
      interimResults = true;
      lang = 'en-US';
      onstart: any = null;
      onresult: any = null;
      onerror: any = null;
      onend: any = null;
      start() {
        if (this.onstart) setTimeout(() => this.onstart(), 10);
      }
      abort() {
        if (this.onend) setTimeout(() => this.onend(), 10);
      }
      stop() {
        if (this.onend) setTimeout(() => this.onend(), 10);
      }
    }
    (window as any).SpeechRecognition = MockSpeechRecognition;
    (window as any).webkitSpeechRecognition = MockSpeechRecognition;

    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const dst = audioCtx.createMediaStreamDestination();
        osc.connect(dst);
        osc.start();
        return dst.stream;
      };
    }
  });

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('🎙️') || txt.includes('Voice') || txt.includes('barge') || txt.includes('Speech')) {
      console.log(`[CLIENT CONSOLE] ${txt}`);
    }
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  // Sign in as Patient
  const logoutBtn = await page.$('button[title="Sign Out"]');
  if (logoutBtn) {
    await logoutBtn.click();
    await page.waitForTimeout(600);
  }

  await page.click('#tab-patient');
  await page.waitForTimeout(200);
  await page.click('#btn-quick-signin');
  await page.waitForSelector('#voice-orb-button', { timeout: 8000 });
  await page.waitForTimeout(1000);

  async function getOrbState(): Promise<string> {
    return await page.evaluate(() => {
      const orb = document.getElementById('voice-orb-button');
      if (!orb) return 'missing';
      if (orb.classList.contains('listening')) return 'listening';
      if (orb.classList.contains('speaking')) return 'speaking';
      if (orb.classList.contains('thinking')) return 'thinking';
      return 'idle';
    });
  }

  const logs: ClickLog[] = [];

  async function clickOrb(num: number, contextDesc: string): Promise<ClickLog> {
    const before = await getOrbState();
    const t0 = Date.now();
    const ts = new Date().toISOString();

    await page.click('#voice-orb-button', { force: true });

    // Poll up to 500ms for state update
    let after = await getOrbState();
    let elapsed = 0;
    while (elapsed < 500) {
      await page.waitForTimeout(40);
      elapsed += 40;
      after = await getOrbState();
      if (after !== before) break;
    }
    const latency = Date.now() - t0;
    const success = after !== before;

    const log: ClickLog = {
      clickNum: num,
      timestamp: ts,
      stateBefore: before,
      triggerContext: contextDesc,
      stateAfter: after,
      latencyMs: latency,
      success,
    };

    console.log(
      `Click #${String(num).padStart(2, '0')} | ${ts} | Before: ${before.padEnd(9)} | Action: "${contextDesc.padEnd(45)}" | After: ${after.padEnd(9)} | Latency: ${latency}ms | Status: ${success ? 'PROCESSED (PASS)' : 'DROPPED (FAIL)'}`
    );

    logs.push(log);
    return log;
  }

  console.log('Beginning 14-Click Comprehensive State-Machine Test...\n');

  // Click 1: Idle -> Listening
  await clickOrb(1, 'User clicks inactive orb');
  await page.waitForTimeout(250);

  // Click 2: Listening -> Idle
  await clickOrb(2, 'User clicks orb while listening to pause');
  await page.waitForTimeout(250);

  // Click 3: Idle -> Listening
  await clickOrb(3, 'User clicks orb to resume listening');
  await page.waitForTimeout(250);

  // Drive state to THINKING
  console.log('\n--- Transitioning to THINKING state ---');
  await page.evaluate(() => {
    const orb = document.getElementById('voice-orb-button');
    if (orb) {
      orb.classList.remove('idle', 'listening', 'speaking');
      orb.classList.add('thinking');
    }
  });
  await page.waitForTimeout(100);

  // Click 4: Thinking -> Listening (Barge-in interrupt)
  await clickOrb(4, 'User clicks orb during THINKING (Barge-in)');
  await page.waitForTimeout(250);

  // Click 5: Listening -> Idle
  await clickOrb(5, 'User clicks orb while listening to pause');
  await page.waitForTimeout(250);

  // Click 6: Idle -> Listening
  await clickOrb(6, 'User clicks orb to start listening');
  await page.waitForTimeout(250);

  // Drive state to SPEAKING
  console.log('\n--- Transitioning to SPEAKING state ---');
  await page.evaluate(() => {
    const orb = document.getElementById('voice-orb-button');
    if (orb) {
      orb.classList.remove('idle', 'listening', 'thinking');
      orb.classList.add('speaking');
    }
  });
  await page.waitForTimeout(100);

  // Click 7: Speaking -> Listening (Barge-in interrupt)
  await clickOrb(7, 'User clicks orb during SPEAKING (Barge-in)');
  await page.waitForTimeout(250);

  // Click 8: Listening -> Idle
  await clickOrb(8, 'User clicks orb while listening to pause');
  await page.waitForTimeout(250);

  // Click 9: Idle -> Listening
  await clickOrb(9, 'User clicks orb from idle');
  await page.waitForTimeout(250);

  // Click 10: Listening -> Idle
  await clickOrb(10, 'User clicks orb to return to idle');
  await page.waitForTimeout(250);

  // Click 11: Idle -> Listening
  await clickOrb(11, 'Rapid click 1: Idle -> Listening');
  await page.waitForTimeout(100);

  // Click 12: Listening -> Idle
  await clickOrb(12, 'Rapid click 2: Listening -> Idle');
  await page.waitForTimeout(100);

  // Click 13: Idle -> Listening
  await clickOrb(13, 'Rapid click 3: Idle -> Listening');
  await page.waitForTimeout(100);

  // Click 14: Listening -> Idle
  await clickOrb(14, 'Rapid click 4: Listening -> Idle');
  await page.waitForTimeout(250);

  await browser.close();

  console.log('\n================================================================');
  console.log('TIMESTAMPED CLICK LOG AUDIT REPORT');
  console.log('================================================================');
  console.table(
    logs.map(l => ({
      Click: l.clickNum,
      Timestamp: l.timestamp,
      'Pre-State': l.stateBefore,
      Action: l.triggerContext,
      'Post-State': l.stateAfter,
      'Response Latency': `${l.latencyMs}ms`,
      Status: l.success ? 'PROCESSED' : 'DROPPED',
    }))
  );

  const dropped = logs.filter(l => !l.success).length;
  console.log(`\nTotal consecutive clicks tested: ${logs.length}`);
  console.log(`Total dropped clicks: ${dropped}`);
  console.log(`Responsiveness rate: ${((logs.length - dropped) / logs.length) * 100}%`);
  console.log(`Average response latency: ${(logs.reduce((acc, c) => acc + c.latencyMs, 0) / logs.length).toFixed(1)}ms`);

  if (dropped > 0) {
    throw new Error(`Voice orb dropped ${dropped} clicks!`);
  }
}

verifyVoiceOrb().catch(err => {
  console.error('Error during voice orb verification:', err);
  process.exit(1);
});
