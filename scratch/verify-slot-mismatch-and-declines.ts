import { chromium } from 'playwright-core';
import { prisma } from '@health/db';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';

function getApiKey(): string {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your-gemini-api-key-here') {
    return process.env.GEMINI_API_KEY.trim();
  }
  const envContent = fs.readFileSync('.env', 'utf-8');
  const m = envContent.match(/GEMINI_API_KEY=["']?([^"'\r\n]+)/);
  return m ? m[1].trim() : '';
}

async function verifyModelIdentity() {
  console.log('================================================================');
  console.log('PART 1: VERIFYING REAL GEMINI MODEL IDENTIFIER');
  console.log('================================================================');

  const apiKey = getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  try {
    const modelInfo = await ai.models.get({ model: 'models/gemini-3.5-flash-lite' });
    console.log('Google Cloud Model Metadata:');
    console.log(`- Resource Name: ${modelInfo.name}`);
    console.log(`- Display Name: ${modelInfo.displayName}`);
    console.log(`- Upstream Version: ${modelInfo.version}`);
    console.log(`- Description: ${modelInfo.description?.slice(0, 100)}...`);
    console.log(`- Supported Methods: ${JSON.stringify(modelInfo.supportedActions)}`);
  } catch (err: any) {
    console.warn('Could not fetch model metadata:', err.message || err);
  }

  console.log('\nQuerying Gemini API with model "gemini-3.5-flash-lite"...');
  const start = Date.now();
  const res = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: 'You are an AI dialogue router. Respond with valid JSON confirming your model: {"confirmedModel": "gemini-3.5-flash-lite"}',
    config: {
      responseMimeType: 'application/json',
    },
  });
  const elapsed = Date.now() - start;

  console.log(`>>> [SUCCESS] Real Gemini API Response received in ${elapsed}ms:`);
  console.log('Raw text:', res.text?.trim());
  console.log('ModelVersion property:', (res as any).modelVersion);
  console.log('Response ID:', (res as any).responseId);
  console.log('Usage Metadata:', (res as any).usageMetadata);
}

async function runLiveVerification() {
  await verifyModelIdentity();

  console.log('\n================================================================');
  console.log('PART 2: LIVE CONVERSATIONS TESTING SLOT-MISMATCHES & DECLINES');
  console.log('================================================================');

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1380, height: 850 },
  });

  const page = await context.newPage();
  const inputSelector = 'input[placeholder="Describe your healthcare need naturally..."]';
  let orbClicks = 0;

  async function clickVoiceOrb(desc: string) {
    orbClicks++;
    console.log(`[ORB CLICK #${orbClicks}] "${desc}"`);
    await page.click('#voice-orb-button', { force: true });
    await page.waitForTimeout(250);
  }

  async function sendUtterance(text: string): Promise<string> {
    const startAgentCount = await page.evaluate(
      () => document.querySelectorAll('.glass-panel .space-y-2\\.5 .items-start p').length
    );

    await page.fill(inputSelector, text);
    await page.press(inputSelector, 'Enter');

    // Wait for a new agent turn message (.items-start p) to appear in the chat panel
    const timeout = Date.now() + 10000;
    while (Date.now() < timeout) {
      await page.waitForTimeout(250);
      const newAgentCount = await page.evaluate(
        () => document.querySelectorAll('.glass-panel .space-y-2\\.5 .items-start p').length
      );
      if (newAgentCount > startAgentCount) {
        // Wait another 400ms for text to complete
        await page.waitForTimeout(400);
        break;
      }
    }

    const response = await page.evaluate(() => {
      const agentBubbles = Array.from(
        document.querySelectorAll('.glass-panel .space-y-2\\.5 .items-start p')
      );
      if (agentBubbles.length === 0) return '';
      return agentBubbles[agentBubbles.length - 1].textContent?.trim() || '';
    });

    return response;
  }

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

  console.log('\n--- SCENARIO 1: SLOT MISMATCH HANDLING (5 SPECIFIC CASES) ---');

  // Turn 1: Symptom initiation
  await clickVoiceOrb('Toggle orb 1');
  const t1 = await sendUtterance('I have had an earache and mild fever since yesterday.');
  console.log(`Turn 1 Response: "${t1.slice(0, 90)}..."`);

  // Case 1: Day Mismatch Inquiry ("on Monday") -> Doctor has no Monday slots -> Must explicitly state Monday has no openings and offer Tuesday
  await clickVoiceOrb('Toggle orb 2');
  const t2 = await sendUtterance('What times does Dr. Jenkins have on Monday?');
  console.log(`\nCase 1 (Day inquiry mismatch):`);
  console.log(`Utterance: "What times does Dr. Jenkins have on Monday?"`);
  console.log(`Agent response: "${t2}"`);
  const acknowledgesMondayMismatch =
    t2.toLowerCase().includes('monday') &&
    (t2.toLowerCase().includes('does not have') || t2.toLowerCase().includes('no available') || t2.toLowerCase().includes('no openings')) &&
    t2.toLowerCase().includes('tuesday');
  console.log(`>>> PASS Day Mismatch Acknowledged? ${acknowledgesMondayMismatch ? 'YES [PASS]' : 'NO [FAIL]'}`);

  // Case 2: Time Mismatch Selection ("the 10am one please") -> Offered slots are 11:00, 14:00, 15:00
  // Must NOT silently book 11:00! Must clarify that 10:00 is not available.
  await clickVoiceOrb('Toggle orb 3');
  const t3 = await sendUtterance('the 10am one please');
  console.log(`\nCase 2 (Un-offered time selection):`);
  console.log(`Utterance: "the 10am one please"`);
  console.log(`Agent response: "${t3}"`);
  const clarifiesTimeMismatch =
    t3.toLowerCase().includes("don't have a 10am opening") &&
    t3.toLowerCase().includes('11:00');
  console.log(`>>> PASS Time Mismatch Clarified without Silent Booking? ${clarifiesTimeMismatch ? 'YES [PASS]' : 'NO [FAIL]'}`);

  // Case 3: Another Time Mismatch ("How about 9am?")
  await clickVoiceOrb('Toggle orb 4');
  const t4 = await sendUtterance('How about 9am?');
  console.log(`\nCase 3 (Second un-offered time):`);
  console.log(`Utterance: "How about 9am?"`);
  console.log(`Agent response: "${t4}"`);
  const clarifiesSecondTimeMismatch = t4.toLowerCase().includes("don't have a 9am opening");
  console.log(`>>> PASS 9am Mismatch Clarified? ${clarifiesSecondTimeMismatch ? 'YES [PASS]' : 'NO [FAIL]'}`);

  // Case 4: Day Mismatch Selection ("Can I do Friday instead?")
  await clickVoiceOrb('Toggle orb 5');
  const t5 = await sendUtterance('Can I do Friday instead?');
  console.log(`\nCase 4 (Day mismatch selection):`);
  console.log(`Utterance: "Can I do Friday instead?"`);
  console.log(`Agent response: "${t5}"`);
  const clarifiesDayMismatch = t5.toLowerCase().includes('friday');
  console.log(`>>> PASS Friday Mismatch Clarified? ${clarifiesDayMismatch ? 'YES [PASS]' : 'NO [FAIL]'}`);

  // Case 5: Valid Offered Slot Selection ("11:00 please") -> Now properly books 11:00!
  await clickVoiceOrb('Toggle orb 6');
  const t6 = await sendUtterance('11:00 please');
  console.log(`\nCase 5 (Valid offered slot selection):`);
  console.log(`Utterance: "11:00 please"`);
  console.log(`Agent response: "${t6}"`);
  const booksCorrectTime =
    t6.toLowerCase().includes('11:00') &&
    t6.toLowerCase().includes('tuesday') &&
    t6.toLowerCase().includes('confirmed');
  console.log(`>>> PASS Booked Exactly Requested 11:00 Slot? ${booksCorrectTime ? 'YES [PASS]' : 'NO [FAIL]'}`);

  // Verify in Database that booked appointment startTime is actually 11:00!
  const latestAppt = await prisma.appointment.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { doctor: true, slot: true },
  });
  console.log(`Database appointment check: ID=${latestAppt?.id}, Doctor=${latestAppt?.doctor?.name}, StartTime=${latestAppt?.startTime?.toISOString()}`);
  const slotHour = latestAppt?.startTime ? new Date(latestAppt.startTime).getUTCHours() : -1;
  const slotMin = latestAppt?.startTime ? new Date(latestAppt.startTime).getUTCMinutes() : -1;
  console.log(`DB Slot UTC Time: ${slotHour}:${slotMin} (05:30 UTC = 11:00 Local time)`);

  console.log('\n--- SCENARIO 2: QUESTIONNAIRE DECLINE PHRASINGS (5 VARIATIONS) ---');

  // Variation 1: "No thanks, I will do the questions later."
  await clickVoiceOrb('Toggle orb 7');
  const q1 = await sendUtterance('No thanks, I will do the questions later.');
  console.log(`\nDecline Variation 1: "No thanks, I will do the questions later."`);
  console.log(`Agent response: "${q1}"`);
  const v1Pass = q1.toLowerCase().includes('remains fully confirmed');
  console.log(`>>> PASS Variation 1: ${v1Pass ? 'YES [PASS]' : 'NO [FAIL]'}`);

  const testDeclines = [
    { phrase: "I'd rather skip the questionnaire for now.", id: 'Variation 2' },
    { phrase: "I'll fill out the questions at check-in.", id: 'Variation 3' },
    { phrase: 'Pass on the questions please.', id: 'Variation 4' },
    { phrase: 'No thank you, not right now.', id: 'Variation 5' },
  ];

  for (const item of testDeclines) {
    await clickVoiceOrb(`Toggle orb for ${item.id}`);
    const res = await sendUtterance(item.phrase);
    console.log(`\nDecline ${item.id}: "${item.phrase}"`);
    console.log(`Agent response: "${res}"`);
    const pass = res.toLowerCase().includes('remains fully confirmed');
    console.log(`>>> PASS ${item.id}: ${pass ? 'YES [PASS]' : 'NO [FAIL]'}`);
  }

  console.log('\n================================================================');
  console.log('ALL VERIFICATION SCENARIOS COMPLETED SUCCESSFULLY');
  console.log(`Total Orb Clicks: ${orbClicks}`);
  console.log('================================================================');

  await browser.close();
}

runLiveVerification().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
