import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Check what's actually in localStorage right now (user's real settings)
  const stored = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('claudeman-app-settings'));
    } catch { return null; }
  });
  console.log('Current stored settings:', JSON.stringify(stored, null, 2));

  // Check the tabs state
  const state = await page.evaluate(() => {
    const el = document.getElementById('sessionTabs');
    const style = window.getComputedStyle(el);
    return {
      classList: el.className,
      flexWrap: style.flexWrap,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      height: el.offsetHeight,
      scrollHeight: el.scrollHeight,
      numTabs: el.querySelectorAll('.session-tab').length,
      tabHeights: [...el.querySelectorAll('.session-tab')].map(t => t.offsetHeight),
    };
  });
  console.log('Tab container state:', JSON.stringify(state, null, 2));

  // Now try: set tabTwoRows to false explicitly
  console.log('\n--- Setting tabTwoRows=false explicitly ---');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('claudeman-app-settings') || '{}');
    s.tabTwoRows = false;
    localStorage.setItem('claudeman-app-settings', JSON.stringify(s));
    app._cachedAppSettings = null;
    app.applyTabWrapSettings();
  });
  await page.waitForTimeout(500);

  const state2 = await page.evaluate(() => {
    const el = document.getElementById('sessionTabs');
    const style = window.getComputedStyle(el);
    return {
      classList: el.className,
      flexWrap: style.flexWrap,
      height: el.offsetHeight,
    };
  });
  console.log('After explicit false:', JSON.stringify(state2, null, 2));

  // Now try: set tabTwoRows to true
  console.log('\n--- Setting tabTwoRows=true ---');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('claudeman-app-settings') || '{}');
    s.tabTwoRows = true;
    localStorage.setItem('claudeman-app-settings', JSON.stringify(s));
    app._cachedAppSettings = null;
    app.applyTabWrapSettings();
  });
  await page.waitForTimeout(500);

  const state3 = await page.evaluate(() => {
    const el = document.getElementById('sessionTabs');
    const style = window.getComputedStyle(el);
    return {
      classList: el.className,
      flexWrap: style.flexWrap,
      height: el.offsetHeight,
    };
  });
  console.log('After explicit true:', JSON.stringify(state3, null, 2));

} catch (err) {
  console.error('Error:', err.message);
} finally {
  await browser.close();
  process.exit(0);
}
