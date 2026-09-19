import { chromium } from 'playwright-core';
import path from 'node:path';

const ARTIFACT_DIR = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1e738321-96ec-4874-88bf-7f0557278d02';

async function captureScreenshots() {
  console.log('================================================================');
  console.log('CAPTURING ROLE-BASED HEADER SCREENSHOTS (ITEM 5 / BUG 6)');
  console.log('================================================================\n');

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const page = await browser.newPage({ viewport: { width: 1380, height: 850 } });
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  // Helper to ensure clean login screen
  async function ensureLoggedOut() {
    const logoutBtn = await page.$('button[title="Sign Out"]');
    if (logoutBtn) {
      console.log('Logging out existing session...');
      await logoutBtn.click();
      await page.waitForTimeout(800);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. PLATFORM ADMIN
  // ---------------------------------------------------------------------------
  console.log('--- 1. Testing Platform Admin ---');
  await ensureLoggedOut();
  await page.click('#tab-platform-admin');
  await page.waitForTimeout(300);
  await page.click('#btn-platform-quick-signin');
  await page.waitForSelector('header', { timeout: 5000 });
  await page.waitForTimeout(1000);

  // Verify Fault Simulator button exists
  const platformFaultBtn = await page.$('button[title="Open Chaos & Fault Simulator"]');
  console.log(`[PLATFORM ADMIN] Fault Simulator button found: ${platformFaultBtn ? 'YES' : 'NO'}`);
  if (!platformFaultBtn) throw new Error('Fault Simulator button missing in Platform Admin!');

  // Capture Platform Admin Header
  const headerElem1 = await page.$('header');
  const shot1 = path.join(ARTIFACT_DIR, 'header_platform_admin.png');
  await headerElem1?.screenshot({ path: shot1 });
  console.log(`[SCREENSHOT] Saved: ${shot1}`);

  // Click Fault Simulator button and capture modal
  console.log('Clicking Fault Simulator button to verify functionality...');
  await platformFaultBtn.click();
  await page.waitForSelector('text=EHR Chaos & Failure Injection Panel', { timeout: 3000 });
  await page.waitForTimeout(500);

  const shotModal = path.join(ARTIFACT_DIR, 'modal_platform_admin_chaos.png');
  await page.screenshot({ path: shotModal });
  console.log(`[SCREENSHOT] Saved open Chaos Modal: ${shotModal}`);

  // Close modal
  const closeBtn = await page.$('button:has(.lucide-x)');
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForTimeout(500);
  }

  // ---------------------------------------------------------------------------
  // 2. HOSPITAL ADMIN
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Testing Hospital Admin ---');
  await ensureLoggedOut();
  await page.click('#tab-hospital-admin');
  await page.waitForTimeout(300);
  await page.click('#btn-quick-signin');
  await page.waitForSelector('header', { timeout: 5000 });
  await page.waitForTimeout(1000);

  // Assert Fault Simulator button DOES NOT exist
  const hospAdminFaultBtn = await page.$('button[title="Open Chaos & Fault Simulator"]');
  console.log(`[HOSPITAL ADMIN] Fault Simulator button found: ${hospAdminFaultBtn ? 'YES (FAIL)' : 'NO (CORRECT)'}`);
  if (hospAdminFaultBtn) throw new Error('Fault Simulator button MUST NOT be present for Hospital Admin!');

  const headerElem2 = await page.$('header');
  const shot2 = path.join(ARTIFACT_DIR, 'header_hospital_admin.png');
  await headerElem2?.screenshot({ path: shot2 });
  console.log(`[SCREENSHOT] Saved: ${shot2}`);

  // ---------------------------------------------------------------------------
  // 3. DOCTOR
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Testing Doctor ---');
  await ensureLoggedOut();
  await page.click('#tab-doctor');
  await page.waitForTimeout(300);
  await page.click('#btn-quick-signin');
  await page.waitForSelector('header', { timeout: 5000 });
  await page.waitForTimeout(1000);

  // Assert Fault Simulator button DOES NOT exist
  const doctorFaultBtn = await page.$('button[title="Open Chaos & Fault Simulator"]');
  console.log(`[DOCTOR] Fault Simulator button found: ${doctorFaultBtn ? 'YES (FAIL)' : 'NO (CORRECT)'}`);
  if (doctorFaultBtn) throw new Error('Fault Simulator button MUST NOT be present for Doctor!');

  const headerElem3 = await page.$('header');
  const shot3 = path.join(ARTIFACT_DIR, 'header_doctor.png');
  await headerElem3?.screenshot({ path: shot3 });
  console.log(`[SCREENSHOT] Saved: ${shot3}`);

  // ---------------------------------------------------------------------------
  // 4. PATIENT
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Testing Patient ---');
  await ensureLoggedOut();
  await page.click('#tab-patient');
  await page.waitForTimeout(300);
  await page.click('#btn-quick-signin');
  await page.waitForSelector('header', { timeout: 5000 });
  await page.waitForTimeout(1000);

  // Assert Fault Simulator button DOES NOT exist
  const patientFaultBtn = await page.$('button[title="Open Chaos & Fault Simulator"]');
  console.log(`[PATIENT] Fault Simulator button found: ${patientFaultBtn ? 'YES (FAIL)' : 'NO (CORRECT)'}`);
  if (patientFaultBtn) throw new Error('Fault Simulator button MUST NOT be present for Patient!');

  const headerElem4 = await page.$('header');
  const shot4 = path.join(ARTIFACT_DIR, 'header_patient.png');
  await headerElem4?.screenshot({ path: shot4 });
  console.log(`[SCREENSHOT] Saved: ${shot4}`);

  await browser.close();
  console.log('\n================================================================');
  console.log('ALL ROLE HEADERS VERIFIED AND SCREENSHOTS CAPTURED: 100% PASS');
  console.log('================================================================');
}

captureScreenshots().catch(err => {
  console.error('Screenshot capture error:', err);
  process.exit(1);
});
