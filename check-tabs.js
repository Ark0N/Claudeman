const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  
  await page.goto("http://localhost:3199", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  
  // Click first session tab
  await page.locator(".session-tab").first().click();
  await page.waitForTimeout(500);
  
  // Open session options
  await page.locator(".session-tab.active .tab-gear").click();
  await page.waitForTimeout(500);
  
  // Function to check VISIBILITY of summary elements
  async function checkSummaryVisibility(tabName) {
    console.log("\n=== " + tabName.toUpperCase() + " TAB ===");
    
    // Check if summary-specific elements are VISIBLE (not just in DOM)
    
    const summarySection = page.locator(".modal:visible #summary-section, .modal:visible [id*='summary']");
    const summaryVisible = await summarySection.first().isVisible().catch(() => false);
    
    const timelineSection = page.locator(".modal:visible .run-timeline, .modal:visible [class*='timeline']");
    const timelineVisible = await timelineSection.first().isVisible().catch(() => false);
    
    const filterButtons = page.locator(".modal:visible .filter-btn, .modal:visible [class*='filter']");
    const filterVisible = await filterButtons.first().isVisible().catch(() => false);
    
    const exportBtns = page.locator(".modal:visible .export-btn, .modal:visible button:has-text('Copy'), .modal:visible button:has-text('Download')");
    const exportVisible = await exportBtns.first().isVisible().catch(() => false);
    
    console.log("  Summary section visible:", summaryVisible);
    console.log("  Timeline visible:", timelineVisible);
    console.log("  Filter buttons visible:", filterVisible);
    console.log("  Export buttons visible:", exportVisible);
    
    return { summaryVisible, timelineVisible, filterVisible, exportVisible };
  }
  
  // Check Respawn tab (default)
  const respawn = await checkSummaryVisibility("Respawn");
  
  // Check Context tab  
  await page.locator(".modal:visible .modal-tab-btn[data-tab='context']").click();
  await page.waitForTimeout(200);
  const context = await checkSummaryVisibility("Context");
  
  // Check Ralph tab
  await page.locator(".modal:visible .modal-tab-btn[data-tab='ralph']").click();
  await page.waitForTimeout(200);
  const ralph = await checkSummaryVisibility("Ralph");
  
  // Check Summary tab
  await page.locator(".modal:visible .modal-tab-btn[data-tab='summary']").click();
  await page.waitForTimeout(200);
  const summary = await checkSummaryVisibility("Summary");
  
  await browser.close();
  
  console.log("\n=== FINAL BUG ASSESSMENT ===");
  const hasBugRespawn = respawn.summaryVisible || respawn.timelineVisible;
  const hasBugContext = context.summaryVisible || context.timelineVisible;
  const hasBugRalph = ralph.summaryVisible || ralph.timelineVisible;
  const summaryWorking = summary.summaryVisible || summary.timelineVisible;
  
  console.log("Respawn tab leaking summary content:", hasBugRespawn ? "YES - BUG EXISTS" : "No - Fixed");
  console.log("Context tab leaking summary content:", hasBugContext ? "YES - BUG EXISTS" : "No - Fixed");
  console.log("Ralph tab leaking summary content:", hasBugRalph ? "YES - BUG EXISTS" : "No - Fixed");
  console.log("Summary tab showing its content:", summaryWorking ? "Yes - Working correctly" : "No - Check if empty or hidden");
  
  const bugFixed = (hasBugRespawn === false) && (hasBugContext === false) && (hasBugRalph === false);
  if (bugFixed) {
    console.log("\n*** BUG IS FIXED - Summary content only appears in Summary tab ***");
  } else {
    console.log("\n*** BUG STILL EXISTS - Summary content bleeding to other tabs ***");
  }
  
})().catch(e => { console.error(e); process.exit(1); });
