import { chromium } from 'playwright-core';
import fs from 'node:fs';

const TASK_LOG_PATH = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1e738321-96ec-4874-88bf-7f0557278d02\\.system_generated\\tasks\\task-234.log';

async function runDiagnostics() {
  console.log('================================================================');
  console.log('STEP 1 & 3: REPRODUCING CUT-OFF UTTERANCE & ORB LIFECYCLE DEGRADATION');
  console.log('Target utterance: "Hello I am having severe."');
  console.log('================================================================\n');

  const initialServerLogSize = fs.existsSync(TASK_LOG_PATH) ? fs.statSync(TASK_LOG_PATH).size : 0;

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1380, height: 850 },
  });

  const page = await context.newPage();

  // Instrument browser to track SpeechRecognition instances and lifecycle
  await page.addInitScript(() => {
    (window as any).__recognitionInstances = [];
    (window as any).__recognitionEvents = [];

    const OriginalSpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    class InstrumentedTestSpeechRecognition {
      id = (window as any).__recognitionInstances.length + 1;
      continuous = true;
      interimResults = true;
      lang = 'en-US';
      state = 'created';
      onstart: any = null;
      onresult: any = null;
      onerror: any = null;
      onend: any = null;

      constructor() {
        (window as any).__recognitionInstances.push(this);
        (window as any).__recognitionEvents.push({
          time: new Date().toISOString(),
          instanceId: this.id,
          event: 'INSTANTIATED',
        });
      }

      start() {
        this.state = 'active_listening';
        (window as any).__recognitionEvents.push({
          time: new Date().toISOString(),
          instanceId: this.id,
          event: 'START_CALLED',
        });
        if (this.onstart) setTimeout(() => this.onstart(), 5);
      }

      abort() {
        const oldState = this.state;
        this.state = 'aborted';
        (window as any).__recognitionEvents.push({
          time: new Date().toISOString(),
          instanceId: this.id,
          event: 'ABORT_CALLED',
          fromState: oldState,
        });
        if (this.onend) setTimeout(() => this.onend(), 5);
      }

      stop() {
        const oldState = this.state;
        this.state = 'stopped';
        (window as any).__recognitionEvents.push({
          time: new Date().toISOString(),
          instanceId: this.id,
          event: 'STOP_CALLED',
          fromState: oldState,
        });
        if (this.onend) setTimeout(() => this.onend(), 5);
      }
    }

    (window as any).SpeechRecognition = InstrumentedTestSpeechRecognition;
    (window as any).webkitSpeechRecognition = InstrumentedTestSpeechRecognition;

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

  const rawBrowserConsole: string[] = [];
  const rawWsFrames: { time: string; dir: string; data: string }[] = [];

  page.on('console', msg => {
    rawBrowserConsole.push(`[BROWSER CONSOLE ${new Date().toISOString()}] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });

  page.on('websocket', ws => {
    rawWsFrames.push({ time: new Date().toISOString(), dir: 'WS_OPEN', data: ws.url() });
    ws.on('framesent', f => rawWsFrames.push({ time: new Date().toISOString(), dir: 'CLIENT_TX', data: f.payload.toString() }));
    ws.on('framereceived', f => rawWsFrames.push({ time: new Date().toISOString(), dir: 'SERVER_RX', data: f.payload.toString() }));
    ws.on('close', () => rawWsFrames.push({ time: new Date().toISOString(), dir: 'WS_CLOSE', data: ws.url() }));
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  // Sign in as Patient
  const logoutBtn = await page.$('button[title="Sign Out"]');
  if (logoutBtn) {
    await logoutBtn.click();
    await page.waitForTimeout(500);
  }

  await page.click('#tab-patient');
  await page.waitForTimeout(200);
  await page.click('#btn-quick-signin');
  await page.waitForSelector('#voice-orb-button', { timeout: 8000 });
  await page.waitForTimeout(1000);

  console.log('[LOG] Successfully logged into patient portal.\n');

  // -------------------------------------------------------------------------
  // PART A: REPRODUCE CUT-OFF UTTERANCE "Hello I am having severe."
  // -------------------------------------------------------------------------
  console.log('>>> INJECTING CUT-OFF UTTERANCE: "Hello I am having severe." <<<');
  const cutoffTime = new Date().toISOString();

  // Find input element by placeholder "Describe your healthcare need naturally..."
  const inputSelector = 'input[placeholder="Describe your healthcare need naturally..."]';
  await page.waitForSelector(inputSelector);
  await page.fill(inputSelector, 'Hello I am having severe.');
  await page.press(inputSelector, 'Enter');

  // Wait 6 seconds to capture response and any subsequent events
  await page.waitForTimeout(6000);

  // -------------------------------------------------------------------------
  // PART B: REPRODUCE ORB CLICK DEGRADATION (CLICKS 1 THROUGH 8)
  // -------------------------------------------------------------------------
  console.log('\n>>> EXECUTING ORB CLICKS 1 THROUGH 8 TO TRACK OBJECT LIFECYCLE <<<');

  const orbAudit: any[] = [];

  for (let i = 1; i <= 8; i++) {
    const preClickDiag = await page.evaluate(() => {
      const instances = (window as any).__recognitionInstances || [];
      const orb = document.getElementById('voice-orb-button');
      return {
        totalInstancesCreated: instances.length,
        activeInstanceId: instances.length > 0 ? instances[instances.length - 1].id : null,
        activeInstanceState: instances.length > 0 ? instances[instances.length - 1].state : 'none',
        orbClass: orb?.className || '',
      };
    });

    const t0 = Date.now();
    const ts = new Date().toISOString();

    await page.click('#voice-orb-button', { force: true });
    await page.waitForTimeout(800); // Wait for turn / TTS / recognition transition

    const postClickDiag = await page.evaluate(() => {
      const instances = (window as any).__recognitionInstances || [];
      const orb = document.getElementById('voice-orb-button');
      return {
        totalInstancesCreated: instances.length,
        activeInstanceId: instances.length > 0 ? instances[instances.length - 1].id : null,
        activeInstanceState: instances.length > 0 ? instances[instances.length - 1].state : 'none',
        orbClass: orb?.className || '',
      };
    });

    const elapsed = Date.now() - t0;

    orbAudit.push({
      click: i,
      timestamp: ts,
      preClick: preClickDiag,
      postClick: postClickDiag,
      latencyMs: elapsed,
    });

    console.log(`[CLICK ${i}] Pre: instances=${preClickDiag.totalInstancesCreated}, lastState=${preClickDiag.activeInstanceState} -> Post: instances=${postClickDiag.totalInstancesCreated}, lastState=${postClickDiag.activeInstanceState}`);
  }

  // Read chat messages currently in HUD
  const renderedMessages = await page.evaluate(() => {
    const msgs = Array.from(document.querySelectorAll('.glass-panel .space-y-2\\.5 > div'));
    return msgs.map(m => m.textContent?.trim());
  });

  // Get full lifecycle events
  const fullRecognitionLifecycle = await page.evaluate(() => {
    return (window as any).__recognitionEvents;
  });

  await browser.close();

  // Read task-234.log for server logs during this test
  let rawServerOutput = '';
  if (fs.existsSync(TASK_LOG_PATH)) {
    const currentSize = fs.statSync(TASK_LOG_PATH).size;
    if (currentSize > initialServerLogSize) {
      const allText = fs.readFileSync(TASK_LOG_PATH, 'utf-8');
      rawServerOutput = allText.slice(allText.length - (currentSize - initialServerLogSize));
    }
  }

  console.log('\n================================================================');
  console.log('1. COMPLETE RAW BROWSER CONSOLE OUTPUT');
  console.log('================================================================');
  console.log(rawBrowserConsole.join('\n'));

  console.log('\n================================================================');
  console.log('2. COMPLETE WEBSOCKET MESSAGE SEQUENCE');
  console.log('================================================================');
  rawWsFrames.forEach(f => {
    console.log(`[${f.time}] [${f.dir}] ${f.data}`);
  });

  console.log('\n================================================================');
  console.log('3. COMPLETE RAW SERVER-SIDE LOG OUTPUT (VOICE-GATEWAY + API-SERVER)');
  console.log('================================================================');
  console.log(rawServerOutput);

  console.log('\n================================================================');
  console.log('4. RAW DIAGNOSTIC: SPEECHRECOGNITION OBJECT LIFECYCLE & ORB AUDIT');
  console.log('================================================================');
  console.log(JSON.stringify(orbAudit, null, 2));

  console.log('\n================================================================');
  console.log('5. ALL INSTANCE LIFECYCLE EVENTS');
  console.log('================================================================');
  console.log(JSON.stringify(fullRecognitionLifecycle, null, 2));

  console.log('\n================================================================');
  console.log('6. RENDERED HUD CHAT MESSAGES');
  console.log('================================================================');
  renderedMessages.forEach((m, i) => console.log(`[Msg ${i + 1}] ${m}`));
}

runDiagnostics().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
