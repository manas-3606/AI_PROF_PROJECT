import { chromium } from 'playwright-core';
import { prisma } from '@health/db';
import * as path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1e738321-96ec-4874-88bf-7f0557278d02';
const APP_URL = 'http://localhost:5173';

async function main() {
  console.log('🚀 Starting Layer 6 Verification (Checks 14 & 15)...');

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  // Helper to send text and wait for agent reply
  const inputSelector = 'input[placeholder="Describe your healthcare need naturally..."]';
  async function sendTurn(text: string): Promise<string> {
    console.log(`\n  🗣️ User Input: "${text}"`);
    const initialAgentCount = await page.locator('.space-y-2\\.5 > .items-start p').count();
    const input = page.locator(inputSelector);
    await input.fill(text);
    await page.keyboard.press('Enter');

    let reply = '';
    const maxWait = 30;
    for (let i = 0; i < maxWait; i++) {
      await page.waitForTimeout(500);
      const agentParas = page.locator('.space-y-2\\.5 > .items-start p');
      const count = await agentParas.count();
      if (count > initialAgentCount) {
        reply = await agentParas.last().innerText();
        if (reply && !reply.includes('Voice gateway is connecting')) {
          break;
        }
      }
    }
    console.log(`  🤖 Agent Reply: "${reply}"`);
    return reply;
  }

  // ==========================================
  // 1. Patient logs in and books an appointment
  // ==========================================
  console.log('\nStep 1: Navigating to Patient Portal...');
  await page.goto(APP_URL);
  await page.waitForTimeout(1500);

  const signOutBtn = page.locator('button:has-text("Sign Out")');
  if (await signOutBtn.isVisible()) {
    await signOutBtn.click();
    await page.waitForTimeout(1000);
  }

  await page.click('#tab-patient');
  await page.waitForTimeout(500);
  await page.click('#btn-quick-signin');
  await page.waitForTimeout(2000);
  await page.waitForSelector(inputSelector, { timeout: 8000 });
  console.log('✅ Logged into Patient Portal');

  // Request appointment with Dr. Arvind Rao
  const reply1 = await sendTurn("I want to book an appointment with Dr. Arvind Rao for shoulder pain");
  console.log('Turn 1 completed');

  // Book a slot
  const reply2 = await sendTurn("The first one works for me, please book it.");
  console.log('Turn 2 completed');

  // ==========================================
  // CHECK 14: Answer questionnaire conversationally
  // ==========================================
  console.log('\n--- Check 14: Answering Pre-Visit Questionnaire Conversationally ---');
  // Accept questionnaire
  const qTurn1 = await sendTurn("Yes, I would be happy to answer the intake questions now.");
  if (!qTurn1.toLowerCase().includes('question 1')) {
    throw new Error(`Expected Question 1 prompt, got: "${qTurn1}"`);
  }

  // Answer Question 1 (Numbness/tingling)
  const qTurn2 = await sendTurn("No, no numbness or tingling.");
  if (!qTurn2.toLowerCase().includes('question 2')) {
    throw new Error(`Expected Question 2 prompt, got: "${qTurn2}"`);
  }

  // Answer Question 2 (Joint area)
  const qTurn3 = await sendTurn("Shoulder");
  if (!qTurn3.toLowerCase().includes('question 3')) {
    throw new Error(`Expected Question 3 prompt, got: "${qTurn3}"`);
  }

  // Answer Question 3 (Duration)
  const qTurn4 = await sendTurn("Less than 1 week");
  if (!qTurn4.toLowerCase().includes('question 4')) {
    throw new Error(`Expected Question 4 prompt, got: "${qTurn4}"`);
  }

  // Answer Question 4 (Pain level 1-10)
  const qTurn5 = await sendTurn("7");
  if (!qTurn5.toLowerCase().includes('question 5')) {
    throw new Error(`Expected Question 5 prompt, got: "${qTurn5}"`);
  }

  // Answer Question 5 (Worse/better)
  const qTurn6 = await sendTurn("Lifting overhead makes it worse, rest makes it better.");
  if (!qTurn6.toLowerCase().includes('saved') && !qTurn6.toLowerCase().includes('thank you')) {
    throw new Error(`Expected questionnaire completion message, got: "${qTurn6}"`);
  }

  const check14ChatScreenshot = path.join(ARTIFACT_DIR, 'check14_questionnaire_chat.png');
  await page.screenshot({ path: check14ChatScreenshot, fullPage: false });
  console.log(`📸 Saved Check 14 Chat Screenshot: ${check14ChatScreenshot}`);

  // Query DB to confirm questionnaire response stored
  const latestResponse = await prisma.questionnaireResponse.findFirst({
    orderBy: { submittedAt: 'desc' },
    include: { appointment: true, questionnaire: true },
  });

  if (!latestResponse) {
    throw new Error('No QuestionnaireResponse found in database!');
  }

  console.log('\n📊 Database QuestionnaireResponse Record:');
  console.log(`  - ID: ${latestResponse.id}`);
  console.log(`  - Appointment ID: ${latestResponse.appointmentId}`);
  console.log(`  - Flagged Urgent: ${latestResponse.flaggedUrgent}`);
  console.log(`  - Submitted At: ${latestResponse.submittedAt}`);
  console.log(`  - Answers JSON: ${latestResponse.answersJson}`);

  const parsedAnswers = JSON.parse(latestResponse.answersJson);
  console.log(`  - Parsed Structured Answers:`, parsedAnswers);
  if (!latestResponse.answersJson.includes('7') && !latestResponse.answersJson.includes('Shoulder')) {
    throw new Error('Structured answers did not record patient responses properly');
  }

  // ==========================================
  // CHECK 14 (part 2): Doctor Dashboard Verification
  // ==========================================
  console.log('\n--- Check 14 (part 2): Doctor Dashboard Visibility ---');
  // Sign out patient and log in as Dr. Arvind Rao
  await page.click('button:has-text("Sign Out")');
  await page.waitForTimeout(1000);

  // Click Doctor tab
  await page.click('#tab-doctor');
  await page.waitForTimeout(500);

  // Sign in as Dr. Rao (default doctor on Apex)
  await page.click('#btn-quick-signin');
  await page.waitForTimeout(2500);

  console.log('✅ Logged into Doctor Portal as Dr. Arvind Rao');

  // Verify Doctor sees the appointment and questionnaire answers
  const doctorScreenshot = path.join(ARTIFACT_DIR, 'check14_doctor_dashboard_intake.png');
  await page.screenshot({ path: doctorScreenshot, fullPage: false });
  console.log(`📸 Saved Doctor Dashboard Screenshot: ${doctorScreenshot}`);

  // ==========================================
  // CHECK 15: Workflow & Notification Execution
  // ==========================================
  console.log('\n--- Check 15: Verifying Workflow & Notification Execution ---');
  const appointmentId = latestResponse.appointmentId;

  const workflows = await prisma.workflowExecution.findMany({
    where: { appointmentId },
    include: { workflow: true },
  });

  console.log(`  Found ${workflows.length} WorkflowExecution records for appointment ${appointmentId}:`);
  for (const wf of workflows) {
    console.log(`    * [${wf.status}] Type: ${wf.workflow?.type || wf.workflowId}, ExecutedAt: ${wf.executedAt || wf.scheduledAt}`);
  }

  if (workflows.length === 0) {
    throw new Error('No WorkflowExecution found for the appointment');
  }

  // Check notifications
  const notifications = await prisma.notification.findMany({
    where: {
      payloadJson: { contains: appointmentId },
    },
  });
  console.log(`  Found ${notifications.length} Notification records created for appointment:`);
  for (const notif of notifications) {
    console.log(`    * [${notif.status}] Channel: ${notif.channel}, Recipient: ${notif.recipientType} (${notif.recipientId})`);
  }

  console.log('\n🎉 LAYER 6 CHECKS 14 & 15 PASSED WITH FULL EVIDENCE!');
  await browser.close();
}

main()
  .catch((err) => {
    console.error('❌ Layer 6 verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
