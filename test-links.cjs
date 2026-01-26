const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors']
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Capture console messages
  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push('[' + msg.type() + '] ' + msg.text());
  });

  console.log('Opening https://localhost:3000...');
  await page.goto('https://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  console.log('Looking for shell button...');
  // Click Run Shell button
  const shellBtn = page.locator('button:has-text("Run Shell")');
  if (await shellBtn.count() > 0) {
    await shellBtn.click();
    console.log('Clicked Run Shell');
  } else {
    console.log('Run Shell button not found');
  }

  await page.waitForTimeout(3000);

  // Type command in terminal
  console.log('Typing command...');
  await page.keyboard.type('echo "tail -f /tmp/test.log"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  // Take screenshot
  await page.screenshot({ path: '/tmp/link-test-1.png', fullPage: true });
  console.log('Screenshot 1 saved');

  // Move mouse over terminal area (approximate coordinates for /tmp/test.log)
  const terminal = page.locator('.xterm-screen');
  const box = await terminal.boundingBox();
  if (box) {
    console.log('Terminal at: ' + box.x + ', ' + box.y + ', ' + box.width + 'x' + box.height);

    // Move mouse across the area where the path should be (roughly line 2)
    const y = box.y + 50; // Approximate line 2
    for (let x = box.x + 50; x < box.x + 300; x += 10) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(50);
    }
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/link-test-2.png', fullPage: true });
  console.log('Screenshot 2 saved');

  // Print console logs
  console.log('\n=== Console Logs ===');
  consoleLogs.filter(l => l.includes('LinkProvider')).forEach(l => console.log(l));

  // Check if "Found links" appeared
  const foundLinks = consoleLogs.some(l => l.includes('Found links'));
  console.log('\nLinks detected:', foundLinks);

  await browser.close();
})();
