import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

// iPhone 14 Pro viewport
const MOBILE_VP = { width: 393, height: 852 };
// iPad viewport
const TABLET_VP = { width: 768, height: 1024 };

async function testMobile(page, label, vp) {
  await page.setViewportSize(vp);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const results = [];

  // 1. Check settings modal renders and tabs are visible
  // Open settings via mobile toolbar button or header button
  const settingsBtn = await page.$('.btn-settings-mobile') || await page.$('.btn-settings');
  if (settingsBtn) {
    await settingsBtn.click();
    await page.waitForTimeout(500);

    const modal = await page.$('#appSettingsModal.active');
    results.push({ test: `${label}: Settings modal opens`, pass: !!modal });

    if (modal) {
      // Check tab buttons are visible and not overflowing
      const tabs = await page.$$('#appSettingsModal .modal-tab-btn');
      results.push({ test: `${label}: Settings has ${tabs.length} tabs`, pass: tabs.length === 5 });

      // Check first tab (Display) content is visible
      const displayTab = await page.$('#settings-display');
      const displayVisible = displayTab ? await displayTab.isVisible() : false;
      results.push({ test: `${label}: Display tab content visible`, pass: displayVisible });

      // Check settings-grid layout
      const settingsGrid = await page.$('#settings-display .settings-grid');
      if (settingsGrid) {
        const gridStyle = await settingsGrid.evaluate(el => {
          const cs = window.getComputedStyle(el);
          return cs.gridTemplateColumns;
        });
        const isSingleCol = vp.width < 430;
        if (isSingleCol) {
          // On phone, should be single column
          const colCount = gridStyle.split(' ').length;
          results.push({ test: `${label}: Settings grid is single-col (${colCount} cols)`, pass: colCount === 1 });
        } else {
          results.push({ test: `${label}: Settings grid columns = ${gridStyle}`, pass: true });
        }
      }

      // Switch to notifications tab and check event grid
      const notifTab = await page.$('[data-tab="settings-notifications"]');
      if (notifTab) {
        await notifTab.click();
        await page.waitForTimeout(300);
        const eventGrid = await page.$('.event-type-grid');
        if (eventGrid) {
          const eventGridVisible = await eventGrid.isVisible();
          results.push({ test: `${label}: Event type grid visible`, pass: eventGridVisible });

          const gridCols = await eventGrid.evaluate(el => {
            return window.getComputedStyle(el).gridTemplateColumns;
          });
          results.push({ test: `${label}: Event grid cols = ${gridCols}`, pass: true });
        }
      }

      // Check modal tab scrollability
      const tabsContainer = await page.$('#appSettingsModal .modal-tabs');
      if (tabsContainer) {
        const overflow = await tabsContainer.evaluate(el => {
          const cs = window.getComputedStyle(el);
          return { overflowX: cs.overflowX, flexWrap: cs.flexWrap };
        });
        results.push({ test: `${label}: Tab bar overflow-x=${overflow.overflowX}, flex-wrap=${overflow.flexWrap}`, pass: overflow.overflowX === 'auto' || overflow.flexWrap === 'nowrap' });
      }

      // Close modal
      const closeBtn = await page.$('#appSettingsModal .modal-close');
      if (closeBtn) await closeBtn.click();
      await page.waitForTimeout(300);
    }
  } else {
    results.push({ test: `${label}: Settings button found`, pass: false });
  }

  // 2. Check subagent badge sizing
  // We can check the CSS computed style for .tab-subagent-badge if any exist
  const badges = await page.$$('.tab-subagent-badge');
  if (badges.length > 0) {
    const badgeHeight = await badges[0].evaluate(el => {
      return parseFloat(window.getComputedStyle(el).height);
    });
    if (vp.width < 430) {
      results.push({ test: `${label}: Subagent badge height=${badgeHeight}px (expect ~14)`, pass: badgeHeight <= 16 });
    } else {
      results.push({ test: `${label}: Subagent badge height=${badgeHeight}px`, pass: true });
    }
  } else {
    results.push({ test: `${label}: No subagent badges to check (OK)`, pass: true });
  }

  // 3. Check subagent windows if any are open
  const subWindows = await page.$$('.subagent-window');
  if (subWindows.length > 0 && vp.width < 430) {
    for (const sw of subWindows) {
      const swStyle = await sw.evaluate(el => {
        const cs = window.getComputedStyle(el);
        return {
          position: cs.position,
          width: cs.width,
          borderRadius: cs.borderRadius,
        };
      });
      results.push({ test: `${label}: Subagent window position=${swStyle.position}, width=${swStyle.width}`, pass: swStyle.position === 'fixed' });
    }
  }

  // 4. Check header height
  const header = await page.$('.header');
  if (header) {
    const headerHeight = await header.evaluate(el => {
      return parseFloat(window.getComputedStyle(el).height);
    });
    const expectedMax = vp.width < 430 ? 40 : 55;
    results.push({ test: `${label}: Header height=${headerHeight}px (max ${expectedMax})`, pass: headerHeight <= expectedMax });
  }

  // 5. Check toolbar is fixed at bottom on mobile
  if (vp.width < 430) {
    const toolbar = await page.$('.toolbar');
    if (toolbar) {
      const toolbarPos = await toolbar.evaluate(el => {
        return window.getComputedStyle(el).position;
      });
      results.push({ test: `${label}: Toolbar position=${toolbarPos}`, pass: toolbarPos === 'fixed' });
    }
  }

  return results;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    // Test mobile viewport
    const mobilePage = await browser.newPage();
    const mobileResults = await testMobile(mobilePage, 'Phone (393px)', MOBILE_VP);
    await mobilePage.close();

    // Test tablet viewport
    const tabletPage = await browser.newPage();
    const tabletResults = await testMobile(tabletPage, 'Tablet (768px)', TABLET_VP);
    await tabletPage.close();

    const all = [...mobileResults, ...tabletResults];
    const passed = all.filter(r => r.pass).length;
    const failed = all.filter(r => !r.pass).length;

    console.log('\n=== Mobile Optimization Test Results ===\n');
    for (const r of all) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.test}`);
    }
    console.log(`\n  ${passed} passed, ${failed} failed out of ${all.length} tests\n`);

    if (failed > 0) process.exit(1);
  } finally {
    await browser.close();
  }
})();
