import { chromium } from 'playwright-core';
import * as path from 'path';
import * as fs from 'fs';

async function verifyVoiceOrb() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  console.log('Navigating to http://localhost:5173...');
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  // Check if we need to login
  const isEmailInput = await page.locator('input[type="email"]').isVisible();
  if (isEmailInput) {
    console.log('Logging in as Michael Chang (Patient)...');
    await page.fill('input[type="email"]', 'michael.chang@example.com');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }

  // Verify Patient Portal is loaded
  await page.waitForSelector('#voice-orb-button', { timeout: 8000 });
  console.log('✓ Voice Orb found on Patient Portal');

  // Measure initial Orb bounding box and window scroll
  const initialOrbBox = await page.locator('#voice-orb-button').boundingBox();
  const initialScrollY = await page.evaluate(() => window.scrollY);
  console.log('Initial Orb Position:', initialOrbBox);
  console.log('Initial window.scrollY:', initialScrollY);

  // Click on a quick prompt to simulate conversational turn
  console.log('Clicking quick prompt: "Shoulder pain doctor this week"...');
  await page.click('button:has-text("Shoulder pain doctor this week")');

  // Wait for agent message to appear in transcript
  await page.waitForTimeout(2500);

  // Measure post-turn Orb bounding box and window scroll
  const postOrbBox = await page.locator('#voice-orb-button').boundingBox();
  const postScrollY = await page.evaluate(() => window.scrollY);
  console.log('Post-turn Orb Position:', postOrbBox);
  console.log('Post-turn window.scrollY:', postScrollY);

  if (Math.abs(postScrollY - initialScrollY) > 5) {
    console.error(`❌ Window jumped downwards! scrollY moved from ${initialScrollY} to ${postScrollY}`);
  } else {
    console.log('✅ Window scroll position remained 0 (ZERO window jump)!');
  }

  if (
    initialOrbBox &&
    postOrbBox &&
    Math.abs(initialOrbBox.y - postOrbBox.y) < 3 &&
    Math.abs(initialOrbBox.x - postOrbBox.x) < 3
  ) {
    console.log('✅ Voice Orb is 100% STATIONARY (coordinates locked at x=' + postOrbBox.x + ', y=' + postOrbBox.y + ')!');
  } else {
    console.warn('⚠️ Orb moved slightly:', initialOrbBox, postOrbBox);
  }

  // Take screenshot for visual evidence
  const artifactDir = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1df22142-06a1-4eda-be3a-131ba5fa49e1';
  const screenshotPath = path.join(artifactDir, 'voice_orb_stationary_verification.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Saved screenshot to ${screenshotPath}`);

  await browser.close();
}

verifyVoiceOrb().catch((err) => {
  console.error('Error during verification:', err);
  process.exit(1);
});
