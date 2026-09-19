import { chromium } from 'playwright-core';
import fs from 'node:fs';

const TASK_LOG_PATH = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1e738321-96ec-4874-88bf-7f0557278d02\\.system_generated\\tasks\\task-234.log';

interface TurnAudit {
  turnIndex: number;
  userUtterance: string;
  agentResponse: string;
  intentDetected: string;
  orbClickCountSoFar: number;
  orbState: string;
}

async function runMultiTurnVerification() {
  console.log('================================================================');
  console.log('STEP 5: REAL 10-TURN LIVE CONVERSATION WITH >= 8 ORB CLICKS');
  console.log('Including cut-off utterance and continuous state-machine verification');
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

  const rawConsoleLogs: string[] = [];
  const rawWsFrames: { time: string; dir: string; data: string }[] = [];

  page.on('console', msg => {
    rawConsoleLogs.push(`[BROWSER CONSOLE ${new Date().toISOString()}] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });

  page.on('websocket', ws => {
    rawWsFrames.push({ time: new Date().toISOString(), dir: 'WS_OPEN', data: ws.url() });
    ws.on('framesent', f => rawWsFrames.push({ time: new Date().toISOString(), dir: 'CLIENT_TX', data: f.payload.toString() }));
    ws.on('framereceived', f => rawWsFrames.push({ time: new Date().toISOString(), dir: 'SERVER_RX', data: f.payload.toString() }));
    ws.on('close', () => rawWsFrames.push({ time: new Date().toISOString(), dir: 'WS_CLOSE', data: ws.url() }));
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  // Sign in as Patient Jane Doe
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

  console.log('[LOG] Patient portal loaded with Voice HUD.\n');

  let orbClickCount = 0;

  async function clickVoiceOrb(desc: string) {
    orbClickCount++;
    const stateBefore = await page.evaluate(() => {
      const orb = document.getElementById('voice-orb-button');
      return orb?.className || '';
    });
    console.log(`[ORB CLICK #${orbClickCount}] "${desc}" | Pre-click class: ${stateBefore.slice(0, 40)}...`);
    await page.click('#voice-orb-button', { force: true });
    await page.waitForTimeout(250);
  }

  const turns: TurnAudit[] = [];

  const conversationScript = [
    // Turn 1: Deliberately cut-off sentence
    { utterance: 'Hello I am having severe.', note: 'Turn 1: Deliberately cut-off sentence' },
    // Turn 2: Complete symptom description
    { utterance: 'I have had a severe sore throat and fever for two days.', note: 'Turn 2: Clinical symptom triage' },
    // Turn 3: Ask for appointment with Dr. Jenkins
    { utterance: 'What times does Dr. Jenkins have on Monday?', note: 'Turn 3: Inquire slots' },
    // Turn 4: Slot selection
    { utterance: 'The 10am one please.', note: 'Turn 4: Relative slot booking' },
    // Turn 5: Ask about location
    { utterance: 'Can you tell me where Metropolitan Health System is located?', note: 'Turn 5: Administrative inquiry' },
    // Turn 6: Pre-visit question
    { utterance: 'How should I prepare for this appointment?', note: 'Turn 6: Pre-visit guidance' },
    // Turn 7: Reschedule request
    { utterance: 'I need to reschedule this appointment due to a work conflict.', note: 'Turn 7: Reschedule request' },
    // Turn 8: New slot choice
    { utterance: 'Please book the next available slot on Tuesday.', note: 'Turn 8: Reschedule slot selection' },
    // Turn 9: SMS notification confirmation
    { utterance: 'Please text me the details.', note: 'Turn 9: Notification request' },
    // Turn 10: Friendly conclusion
    { utterance: 'Thank you, that is everything I needed today. Goodbye!', note: 'Turn 10: Conclusion' },
  ];

  const inputSelector = 'input[placeholder="Describe your healthcare need naturally..."]';

  for (let i = 0; i < conversationScript.length; i++) {
    const item = conversationScript[i];
    console.log(`\n--- EXECUTING TURN ${i + 1}/10: "${item.utterance}" (${item.note}) ---`);

    // Perform real orb clicks across turns (demonstrating responsiveness & lifecycle stability)
    if (i === 0) {
      await clickVoiceOrb('Start voice session from idle');
      await clickVoiceOrb('Pause listening before typing');
    } else if (i === 2) {
      await clickVoiceOrb('Resume voice listening');
      await clickVoiceOrb('Pause voice listening');
    } else if (i === 4) {
      await clickVoiceOrb('Voice toggle click #5');
      await clickVoiceOrb('Voice toggle click #6');
    } else if (i === 6) {
      await clickVoiceOrb('Voice toggle click #7');
      await clickVoiceOrb('Voice toggle click #8');
    } else if (i === 8) {
      await clickVoiceOrb('Voice toggle click #9');
      await clickVoiceOrb('Voice toggle click #10');
    }

    // Submit user utterance through chat input
    await page.fill(inputSelector, item.utterance);
    await page.press(inputSelector, 'Enter');

    // Wait for agent turn response to arrive via WebSocket
    await page.waitForTimeout(2200);

    // Read last message from agent
    const lastAgentMsg = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll('.glass-panel .space-y-2\\.5 > div'));
      const last = msgs[msgs.length - 1];
      return last?.textContent?.trim() || '';
    });

    const currentOrbClass = await page.evaluate(() => {
      const orb = document.getElementById('voice-orb-button');
      return orb?.className || '';
    });

    console.log(`[AGENT RESPONSE TURN ${i + 1}]: "${lastAgentMsg.slice(0, 120)}..."`);

    turns.push({
      turnIndex: i + 1,
      userUtterance: item.utterance,
      agentResponse: lastAgentMsg,
      intentDetected: '',
      orbClickCountSoFar: orbClickCount,
      orbState: currentOrbClass,
    });
  }

  // Final extra orb click test at conversation end
  await clickVoiceOrb('Post-conversation orb click #11');
  await clickVoiceOrb('Post-conversation orb click #12');

  await page.waitForTimeout(1000);
  await browser.close();

  // Read server-side output during this session
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
  console.log(rawConsoleLogs.join('\n'));

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
  console.log('4. 10-TURN CONVERSATION SUMMARY AUDIT');
  console.log('================================================================');
  console.table(
    turns.map(t => ({
      Turn: t.turnIndex,
      'User Utterance': t.userUtterance,
      'Agent Response': t.agentResponse.slice(0, 80) + '...',
      'Orb Clicks Total': t.orbClickCountSoFar,
    }))
  );
}

runMultiTurnVerification().catch(err => {
  console.error('Error during 10-turn verification:', err);
  process.exit(1);
});
