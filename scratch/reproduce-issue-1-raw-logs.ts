import { chromium } from 'playwright-core';
import fs from 'node:fs';

const TASK_LOG_PATH = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1e738321-96ec-4874-88bf-7f0557278d02\\.system_generated\\tasks\\task-234.log';

async function reproduce() {
  console.log('=== STARTING REPRODUCTION: CUT-OFF UTTERANCE "Hello I am having severe." ===\n');

  // Record initial task log size
  const initialLogSize = fs.existsSync(TASK_LOG_PATH) ? fs.statSync(TASK_LOG_PATH).size : 0;

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1380, height: 850 },
  });

  const page = await context.newPage();

  const rawConsoleLogs: string[] = [];
  const rawWsFrames: { time: string; direction: string; payload: string }[] = [];

  page.on('console', msg => {
    rawConsoleLogs.push(`[BROWSER CONSOLE ${new Date().toISOString()}] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });

  page.on('websocket', ws => {
    rawWsFrames.push({
      time: new Date().toISOString(),
      direction: 'WS_OPEN',
      payload: ws.url(),
    });

    ws.on('framesent', frame => {
      rawWsFrames.push({
        time: new Date().toISOString(),
        direction: 'CLIENT -> SERVER (SENT)',
        payload: frame.payload.toString(),
      });
    });

    ws.on('framereceived', frame => {
      rawWsFrames.push({
        time: new Date().toISOString(),
        direction: 'SERVER -> CLIENT (RECEIVED)',
        payload: frame.payload.toString(),
      });
    });
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

  console.log('[LOG] Patient signed in. Ready to inject cut-off utterance.\n');

  const sendTime = new Date().toISOString();
  console.log(`[ACTION ${sendTime}] Typing and sending cut-off utterance: "Hello I am having severe."`);

  // Fill text input and press Enter
  await page.fill('input[placeholder*="Type a healthcare request"]', 'Hello I am having severe.');
  await page.press('input[placeholder*="Type a healthcare request"]', 'Enter');

  // Wait 12 seconds to observe any reset, timer fires, or secondary events
  await page.waitForTimeout(12000);

  // Read chat messages on screen
  const renderedMessages = await page.evaluate(() => {
    const msgs = Array.from(document.querySelectorAll('.glass-panel .space-y-3 > div'));
    return msgs.map(m => m.textContent?.trim());
  });

  await browser.close();

  // Read new server logs from task-234.log
  const finalLogSize = fs.existsSync(TASK_LOG_PATH) ? fs.statSync(TASK_LOG_PATH).size : 0;
  let rawServerLogs = '';
  if (finalLogSize > initialLogSize) {
    const fd = fs.openSync(TASK_LOG_PATH, 'r');
    const buf = Buffer.alloc(finalLogSize - initialLogSize);
    fs.readSync(fd, buf, 0, finalLogSize - initialLogSize, initialLogSize);
    fs.closeSync(fd);
    rawServerLogs = buf.toString('utf-8');
  }

  console.log('\n================================================================');
  console.log('1. COMPLETE RAW BROWSER CONSOLE OUTPUT');
  console.log('================================================================');
  console.log(rawConsoleLogs.join('\n') || '(no console output)');

  console.log('\n================================================================');
  console.log('2. COMPLETE WEBSOCKET MESSAGE SEQUENCE');
  console.log('================================================================');
  rawWsFrames.forEach(f => {
    console.log(`[${f.time}] [${f.direction}] ${f.payload}`);
  });

  console.log('\n================================================================');
  console.log('3. COMPLETE RAW SERVER-SIDE LOG OUTPUT (VOICE-GATEWAY + API-SERVER)');
  console.log('================================================================');
  console.log(rawServerLogs || '(no server output)');

  console.log('\n================================================================');
  console.log('4. MESSAGES CURRENTLY RENDERED IN VOICE HUD CHAT');
  console.log('================================================================');
  renderedMessages.forEach((m, i) => console.log(`[Msg #${i + 1}] ${m}`));
}

reproduce().catch(err => {
  console.error('Error during reproduction:', err);
  process.exit(1);
});
