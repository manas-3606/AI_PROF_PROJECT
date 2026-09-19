import { chromium } from 'playwright-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEPLOYED_URL = 'https://ai-prof-project-1.onrender.com';

async function testVoiceOrb() {
  console.log('🚀 Testing Voice Orb on live deployed URL:', DEPLOYED_URL);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();

  const consoleLogs: string[] = [];
  const errors: string[] = [];
  const wsMessages: string[] = [];

  page.on('console', msg => {
    const text = `[CONSOLE ${msg.type()}] ${msg.text()}`;
    consoleLogs.push(text);
    console.log(text);
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  page.on('pageerror', err => {
    const text = `[PAGE ERROR] ${err.message}`;
    errors.push(text);
    console.error(text);
  });

  page.on('websocket', ws => {
    console.log(`[WS CREATED] URL: ${ws.url()}`);
    ws.on('framesent', f => console.log(`[WS SENT] ${f.payload}`));
    ws.on('framereceived', f => {
      console.log(`[WS RECEIVED] ${f.payload}`);
      wsMessages.push(String(f.payload));
    });
    ws.on('close', () => console.log('[WS CLOSED]'));
    ws.on('socketerror', e => console.error(`[WS ERROR] ${e}`));
  });

  console.log('Navigating to deployed site...');
  await page.goto(DEPLOYED_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Check login state
  const patientTab = page.locator('#tab-patient');
  if (await patientTab.isVisible()) {
    console.log('Clicking patient tab...');
    await patientTab.click();
    await page.waitForTimeout(500);
    const quickSignIn = page.locator('#btn-quick-signin');
    if (await quickSignIn.isVisible()) {
      console.log('Clicking quick signin...');
      await quickSignIn.click();
      await page.waitForTimeout(2000);
    }
  }

  // Look for voice orb button
  const voiceOrb = page.locator('#voice-orb-button');
  console.log('Waiting for voice orb button...');
  await voiceOrb.waitFor({ state: 'visible', timeout: 10000 });
  console.log('Voice orb button is visible! Clicking it...');

  await voiceOrb.click();
  await page.waitForTimeout(3000);

  // Check text or status of Voice HUD
  const liveMicBadge = page.locator('text=LIVE MIC');
  const isMicLive = await liveMicBadge.isVisible();
  console.log('Is LIVE MIC badge visible?', isMicLive);

  const micError = page.locator('.text-rose-400');
  if (await micError.count() > 0) {
    console.log('Mic Error text displayed:', await micError.first().innerText());
  }

  await browser.close();
  console.log('\n--- SUMMARY ---');
  console.log('Total console logs:', consoleLogs.length);
  console.log('Errors encountered:', errors);
  console.log('WS messages count:', wsMessages.length);
}

testVoiceOrb().catch(console.error);
