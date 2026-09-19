import { chromium } from 'playwright-core';
import * as path from 'path';

async function capturePatientLogin() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Navigating to http://localhost:5173...');
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  // If already logged in, sign out first
  const isSignOutVisible = await page.locator('button:has-text("Sign Out")').isVisible();
  if (isSignOutVisible) {
    console.log('Signing out to view login page...');
    await page.click('button:has-text("Sign Out")');
    await page.waitForTimeout(1000);
  }

  // Click on the Patient role tab
  console.log('Clicking on Patient tab...');
  await page.click('button:has-text("Patient")');
  await page.waitForTimeout(500);

  // Open the dropdown to show the options
  console.log('Opening patient dropdown...');
  await page.click('#dropdown-toggle-btn');
  await page.waitForTimeout(500);

  // Capture screenshot
  const artifactDir = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1df22142-06a1-4eda-be3a-131ba5fa49e1';
  const screenshotPath = path.join(artifactDir, 'patient_login_no_hospital.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Saved screenshot to ${screenshotPath}`);

  await browser.close();
}

capturePatientLogin().catch((err) => {
  console.error('Error during screenshot capture:', err);
  process.exit(1);
});
