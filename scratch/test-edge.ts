import { chromium } from 'playwright-core';
import path from 'node:path';

async function testEdge() {
  console.log('Launching Microsoft Edge via playwright-core...');
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://localhost:5173');
  console.log('Page loaded, title:', await page.title());

  const screenshotPath = path.resolve('scratch/test-edge.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Screenshot saved to:', screenshotPath);

  await browser.close();
  console.log('Edge test completed successfully!');
}

testEdge().catch(err => {
  console.error('Edge test error:', err);
  process.exit(1);
});
