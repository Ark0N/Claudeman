import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('1. Loading page...');
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(1500);
  
  console.log('2. Opening App Settings...');
  await page.locator('button[title="App Settings"]').click();
  await page.waitForTimeout(500);
  console.log(`  Modal active: ${(await page.locator('#appSettingsModal.active').count()) > 0}`);
  
  console.log('3. Clicking Display tab...');
  await page.locator('[data-tab="settings-display"]').click();
  await page.waitForTimeout(300);
  
  // Scroll the modal body to the bottom to reveal all settings
  await page.locator('#settings-display').evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(200);
  
  console.log('4. Tab Switch Animation section...');
  const header = page.locator('.settings-section-header:text("Tab Switch Animation")');
  console.log(`  Header visible: ${await header.isVisible()}`);
  
  console.log('5. Checking controls...');
  const toggleLabel = page.locator('#appSettingsTabFadeEnabled').locator('xpath=ancestor::label');
  console.log(`  ✓ Enable toggle: visible=${await toggleLabel.isVisible()}`);
  for (const id of ['appSettingsTabFadeInDuration','appSettingsTabFadeInEasing','appSettingsTabFadeOutDuration','appSettingsTabFadeOutEasing']) {
    console.log(`  ✓ #${id}: visible=${await page.locator('#' + id).isVisible()}`);
  }
  
  console.log('6. Defaults...');
  const enabled = await page.locator('#appSettingsTabFadeEnabled').isChecked();
  const inDur = await page.locator('#appSettingsTabFadeInDuration').inputValue();
  const inEase = await page.locator('#appSettingsTabFadeInEasing').inputValue();
  const outDur = await page.locator('#appSettingsTabFadeOutDuration').inputValue();
  const outEase = await page.locator('#appSettingsTabFadeOutEasing').inputValue();
  console.log(`  enabled=${enabled}, inDur=${inDur}, inEase=${inEase}, outDur=${outDur}, outEase=${outEase}`);
  
  console.log('7. Modifying settings...');
  // Click the toggle label (switch slider) instead of the hidden checkbox
  await toggleLabel.click();
  const nowChecked = await page.locator('#appSettingsTabFadeEnabled').isChecked();
  console.log(`  Toggle clicked, now checked=${nowChecked}`);
  
  await page.locator('#appSettingsTabFadeInDuration').fill('500');
  await page.locator('#appSettingsTabFadeInEasing').selectOption('linear');
  await page.locator('#appSettingsTabFadeOutDuration').fill('200');
  await page.locator('#appSettingsTabFadeOutEasing').selectOption('ease-out');
  console.log('  All values changed');
  
  // Save — scroll back up to find the save button in the footer
  const saveBtn = page.locator('#appSettingsModal .modal-footer button.btn-primary');
  await saveBtn.scrollIntoViewIfNeeded();
  await saveBtn.click();
  console.log('  Saved');
  await page.waitForTimeout(500);
  
  // Re-open to verify persistence
  console.log('8. Persistence check...');
  await page.locator('button[title="App Settings"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-tab="settings-display"]').click();
  await page.waitForTimeout(300);
  // Scroll down again
  await page.locator('#settings-display').evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(200);
  
  const p = {
    enabled: await page.locator('#appSettingsTabFadeEnabled').isChecked(),
    inDur: await page.locator('#appSettingsTabFadeInDuration').inputValue(),
    inEase: await page.locator('#appSettingsTabFadeInEasing').inputValue(),
    outDur: await page.locator('#appSettingsTabFadeOutDuration').inputValue(),
    outEase: await page.locator('#appSettingsTabFadeOutEasing').inputValue(),
  };
  
  const checks = [
    [!p.enabled, `enabled=${p.enabled} (expect false)`],
    [p.inDur === '500', `inDur=${p.inDur} (expect 500)`],
    [p.inEase === 'linear', `inEase=${p.inEase} (expect linear)`],
    [p.outDur === '200', `outDur=${p.outDur} (expect 200)`],
    [p.outEase === 'ease-out', `outEase=${p.outEase} (expect ease-out)`],
  ];
  
  let allPass = true;
  for (const [ok, msg] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
    if (!ok) allPass = false;
  }
  
  console.log(`\n${allPass ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}`);
  await browser.close();
  process.exit(allPass ? 0 : 1);
}

main().catch(err => { console.error('CRASH:', err.message); process.exit(1); });
