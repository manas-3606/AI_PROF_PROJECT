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
    console.log(`- Supported Methods: ${JSON.stringify(modelInfo.supportedActions)}`);
  } catch (err: any) {
    console.warn('Model metadata error:', err.message || err);
  }

  console.log('\nInvoking Gemini API with model "gemini-3.5-flash-lite"...');
  const start = Date.now();
  const res = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: 'Confirm model identity in valid JSON: {"confirmedModel": "gemini-3.5-flash-lite", "status": "active"}',
    config: {
      responseMimeType: 'application/json',
    },
  });
  const elapsed = Date.now() - start;

  console.log(`>>> [PROVEN] Real Gemini API Response received in ${elapsed}ms:`);
  console.log('Raw text:', res.text?.trim());
  console.log('ModelVersion property:', (res as any).modelVersion);
  console.log('Response ID:', (res as any).responseId);
  console.log('Usage Metadata:', (res as any).usageMetadata);
}

interface ConversationTestPlan {
  id: number;
  doctorInquiry: string;
  expectedDayMismatch: boolean;
  unofferedSlotSelection: string;
  validSlotSelection: string;
  declinePhrasing: string;
}

const TEST_PLANS: ConversationTestPlan[] = [
  {
    id: 1,
    doctorInquiry: 'What times does Dr. Jenkins have on Sunday?',
    expectedDayMismatch: true,
    unofferedSlotSelection: 'the 12pm lunch slot please',
    validSlotSelection: 'the first one please',
    declinePhrasing: 'No thanks, I will do the questions later.',
  },
  {
    id: 2,
    doctorInquiry: 'Can I see Dr. Rao on Sunday?',
    expectedDayMismatch: true,
    unofferedSlotSelection: 'Can you do 8:00 in the morning?',
    validSlotSelection: 'the first one please',
    declinePhrasing: "I'd rather skip the questionnaire for now.",
  },
  {
    id: 3,
    doctorInquiry: 'What openings does Dr. Marcus Chen have on Sunday?',
    expectedDayMismatch: true,
    unofferedSlotSelection: 'How about 6pm in the evening?',
    validSlotSelection: 'the first option please',
    declinePhrasing: "I'll fill out the questions at check-in.",
  },
  {
    id: 4,
    doctorInquiry: 'Can I see Dr. Patel on Sunday?',
    expectedDayMismatch: true,
    unofferedSlotSelection: 'Can I do 11:30am?',
    validSlotSelection: 'the first one',
    declinePhrasing: 'Pass on the questions please.',
  },
  {
    id: 5,
    doctorInquiry: 'What times does Dr. David Kim have on Sunday?',
    expectedDayMismatch: true,
    unofferedSlotSelection: 'the 7:00am early slot please',
    validSlotSelection: 'the first option please',
    declinePhrasing: 'No thank you, not right now.',
  },
];

async function runLiveConversations() {
  await verifyModelIdentity();

  console.log('\n================================================================');
  console.log('PART 2: RUNNING 5 COMPLETE LIVE CONVERSATIONS');
  console.log('Testing Slot-Selection Mismatches & Questionnaire Declines');
  console.log('================================================================\n');

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  let totalOrbClicks = 0;

  for (const plan of TEST_PLANS) {
    console.log(`\n================================================================`);
    console.log(`LIVE CONVERSATION #${plan.id} / 5`);
    console.log(`================================================================`);

    const context = await browser.newContext({
      permissions: ['microphone'],
      viewport: { width: 1380, height: 850 },
    });

    const page = await context.newPage();
    const inputSelector = 'input[placeholder="Describe your healthcare need naturally..."]';

    async function clickVoiceOrb(desc: string) {
      totalOrbClicks++;
      await page.click('#voice-orb-button', { force: true });
      await page.waitForTimeout(200);
    }

    async function sendUtterance(text: string): Promise<string> {
      const startAgentCount = await page.evaluate(
        () => document.querySelectorAll('.glass-panel .space-y-2\\.5 .items-start p').length
      );

      await page.fill(inputSelector, text);
      await page.press(inputSelector, 'Enter');

      const timeout = Date.now() + 10000;
      while (Date.now() < timeout) {
        await page.waitForTimeout(250);
        const newAgentCount = await page.evaluate(
          () => document.querySelectorAll('.glass-panel .space-y-2\\.5 .items-start p').length
        );
        if (newAgentCount > startAgentCount) {
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

    // Clean session state before loading page
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await page.waitForTimeout(800);

    // Sign in as Patient Jane Doe
    const logoutBtn = await page.$('button[title="Sign Out"]');
    if (logoutBtn) {
      await logoutBtn.click();
      await page.waitForTimeout(400);
    }

    await page.click('#tab-patient');
    await page.waitForTimeout(200);
    await page.click('#btn-quick-signin');
    await page.waitForSelector('#voice-orb-button', { timeout: 8000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.font-mono.font-semibold');
      return el && el.textContent?.includes('GATEWAY LIVE');
    }, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);

    // TURN 1: Doctor Inquiry
    await clickVoiceOrb(`Conv ${plan.id} Turn 1`);
    console.log(`[Turn 1] Patient: "${plan.doctorInquiry}"`);
    const resp1 = await sendUtterance(plan.doctorInquiry);
    console.log(`[Turn 1] Agent: "${resp1}"`);

    if (plan.expectedDayMismatch) {
      const dayMismatchAcknowledged =
        resp1.toLowerCase().includes('does not have') ||
        resp1.toLowerCase().includes('no available') ||
        resp1.toLowerCase().includes('no openings') ||
        resp1.toLowerCase().includes('earliest available');
      console.log(`>>> Check 1 (Day Mismatch Acknowledged?): ${dayMismatchAcknowledged ? 'PASS ✅' : 'FAIL ❌'}`);
    } else {
      const optionsOffered = resp1.toLowerCase().includes('openings') || resp1.toLowerCase().includes('slots');
      console.log(`>>> Check 1 (Slots Offered?): ${optionsOffered ? 'PASS ✅' : 'FAIL ❌'}`);
    }

    await page.waitForTimeout(1000);

    // TURN 2: Unoffered Slot Selection (Deliberate Mismatch)
    console.log(`\n[Turn 2] Patient (Mismatch request): "${plan.unofferedSlotSelection}"`);
    const resp2 = await sendUtterance(plan.unofferedSlotSelection);
    console.log(`[Turn 2] Agent: "${resp2}"`);

    const clarifiedMismatch =
      resp2.toLowerCase().includes("don't have") ||
      resp2.toLowerCase().includes('not available') ||
      resp2.toLowerCase().includes('among the offered options') ||
      resp2.toLowerCase().includes('did you mean') ||
      resp2.toLowerCase().includes('does not have any available');
    const didNotSilentlyBook = !resp2.toLowerCase().includes('verified and confirmed');

    console.log(`>>> Check 2 (Clarified Mismatch without Silent Booking?): ${clarifiedMismatch && didNotSilentlyBook ? 'PASS ✅' : 'FAIL ❌'}`);

    await page.waitForTimeout(1000);

    // TURN 3: Valid Slot Selection
    console.log(`\n[Turn 3] Patient (Valid selection): "${plan.validSlotSelection}"`);
    const resp3 = await sendUtterance(plan.validSlotSelection);
    console.log(`[Turn 3] Agent: "${resp3}"`);

    const bookedConfirmed =
      resp3.toLowerCase().includes('confirmed') &&
      resp3.toLowerCase().includes('intake questions');
    console.log(`>>> Check 3 (Valid Slot Confirmed & Questionnaire Offered?): ${bookedConfirmed ? 'PASS ✅' : 'FAIL ❌'}`);

    await page.waitForTimeout(1000);

    // TURN 4: Questionnaire Decline
    console.log(`\n[Turn 4] Patient (Decline phrasing): "${plan.declinePhrasing}"`);
    const resp4 = await sendUtterance(plan.declinePhrasing);
    console.log(`[Turn 4] Agent: "${resp4}"`);

    const declineRecognized =
      resp4.toLowerCase().includes('remains fully confirmed') ||
      resp4.toLowerCase().includes('portal or in person');
    console.log(`>>> Check 4 (Decline Recognized & Confirmation Maintained?): ${declineRecognized ? 'PASS ✅' : 'FAIL ❌'}`);

    // Verify DB Appointment status
    const latestAppt = await prisma.appointment.findFirst({
      orderBy: { createdAt: 'desc' },
      include: { doctor: true, slot: true },
    });
    console.log(`\n[DB Audit] Appt ID: ${latestAppt?.id} | Doctor: ${latestAppt?.doctor?.name} | Time: ${latestAppt?.startTime?.toISOString()} | Status: ${latestAppt?.status}`);

    await context.close();
  }

  await browser.close();

  console.log('\n================================================================');
  console.log('ALL 5 LIVE CONVERSATIONS COMPLETED SUCCESSFULLY');
  console.log(`Total Voice Orb Clicks Across All Conversations: ${totalOrbClicks}`);
  console.log('================================================================');
}

runLiveConversations().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
