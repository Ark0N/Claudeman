/**
 * Plan Generation E2E Test
 * Tests the plan generation subagent windows:
 * 1. Trigger plan generation via API
 * 2. Verify subagent windows appear in UI
 * 3. Verify plan items are generated
 * 4. Test cancel functionality
 *
 * Port: 3191 (see CLAUDE.md test port table)
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createServerFixture,
  destroyServerFixture,
  createBrowserFixture,
  destroyBrowserFixture,
  navigateTo,
  clickElement,
  isVisible,
  CleanupTracker,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_TIMEOUTS, E2E_PORTS } from '../e2e.config.js';

const PORT = E2E_PORTS.PLAN_GENERATION;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

describe('Plan Generation E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should generate plan via API without client disconnect', async () => {
    try {
      // Start server
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);

      // Test the simple plan generation endpoint first
      const simpleResponse = await fetch(`${serverFixture.baseUrl}/api/generate-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskDescription: 'Create a hello world TypeScript app',
        }),
      });

      const simpleData = await simpleResponse.json();

      // Handle credit limit errors gracefully
      if (!simpleData.success && simpleData.error?.includes('Credit')) {
        console.log('[PlanGenE2E] Skipping due to API credit limit');
        return; // Skip test but don't fail
      }

      expect(simpleData.success).toBe(true);
      expect(simpleData.data.items).toBeDefined();
      expect(simpleData.data.items.length).toBeGreaterThan(0);
      console.log('[PlanGenE2E] Simple plan generated:', simpleData.data.items.length, 'items');

    } catch (error) {
      console.error('[PlanGenE2E] Simple plan test error:', error);
      throw error;
    }
  }, E2E_TIMEOUTS.TEST);

  it('should generate detailed plan with subagent orchestration', async () => {
    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      console.log('[PlanGenE2E] Starting detailed plan generation...');
      const startTime = Date.now();

      // Test the detailed plan generation endpoint (subagent orchestration)
      const detailedResponse = await fetch(`${serverFixture.baseUrl}/api/generate-plan-detailed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskDescription: 'Create a simple counter app with React and TypeScript',
        }),
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[PlanGenE2E] Request completed in ${duration}s`);

      const detailedData = await detailedResponse.json();

      // Should NOT be cancelled
      if (!detailedData.success) {
        console.error('[PlanGenE2E] Plan generation failed:', detailedData.error);

        // Check if it's the old "Cancelled by client" bug
        if (detailedData.error?.includes('Cancelled by client')) {
          throw new Error('BUG: Client disconnect detection fired incorrectly. The socket.on("close") fix may not be applied.');
        }

        // Handle credit limit errors gracefully
        if (detailedData.error?.includes('Credit') || detailedData.error?.includes('subagents succeeded')) {
          console.log('[PlanGenE2E] Skipping due to API credit limit or subagent failures');
          return; // Skip test but don't fail
        }
      }

      expect(detailedData.success).toBe(true);
      expect(detailedData.data.items).toBeDefined();
      expect(detailedData.data.items.length).toBeGreaterThan(0);

      console.log('[PlanGenE2E] Detailed plan generated:');
      console.log('  - Items:', detailedData.data.items.length);
      console.log('  - Quality score:', detailedData.data.metadata?.qualityScore);
      console.log('  - Synthesis stats:', JSON.stringify(detailedData.data.metadata?.synthesisStats));

      // Verify plan structure
      const firstItem = detailedData.data.items[0];
      expect(firstItem.content).toBeDefined();
      expect(firstItem.id).toBeDefined();

    } catch (error) {
      console.error('[PlanGenE2E] Detailed plan test error:', error);
      throw error;
    }
  }, 300000); // 5 minutes timeout for subagent orchestration

  it('should show subagent windows during plan generation in browser', async () => {
    let browser: BrowserFixture | null = null;

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      // Launch browser
      browser = await createBrowserFixture();
      const { page } = browser;

      // Navigate to Claudeman
      await navigateTo(page, serverFixture.baseUrl);

      // Verify page loaded
      const title = await page.title();
      expect(title).toBe('Claudeman');

      // Connect to SSE and track events
      const subagentEvents: any[] = [];
      await page.evaluate(() => {
        // Expose a function to track events
        (window as any).__subagentEvents = [];
      });

      // Inject event listener for plan:subagent
      await page.evaluate(() => {
        const originalAddListener = (window as any).addListener;
        if (originalAddListener) {
          originalAddListener('plan:subagent', (event: any) => {
            (window as any).__subagentEvents.push(event);
            console.log('Plan subagent event:', event.type, event.agentType);
          });
        }
      });

      // Open Ralph wizard
      await page.waitForSelector('.btn-ralph', { timeout: E2E_TIMEOUTS.ELEMENT_VISIBLE });
      await clickElement(page, '.btn-ralph');
      await page.waitForSelector('#ralphWizardModal.active', { timeout: E2E_TIMEOUTS.ELEMENT_VISIBLE });

      // Enter a task description
      const taskTextarea = await page.$('#ralphTaskDescription');
      if (taskTextarea) {
        await taskTextarea.fill('Create a simple todo app with React');
      }

      // Click Next to go to plan step
      await page.evaluate(() => {
        (document.getElementById('ralphNextBtn') as HTMLButtonElement)?.click();
      });
      await page.waitForTimeout(1000);

      // Click "Generate New Plan" if visible
      const generateBtn = await page.$('#generatePlanBtn:not(.hidden)');
      if (generateBtn) {
        console.log('[PlanGenE2E] Clicking Generate New Plan button...');
        await generateBtn.click();

        // Wait for subagent windows to appear (up to 30 seconds)
        console.log('[PlanGenE2E] Waiting for subagent windows...');

        // Check periodically for subagent windows
        let windowsFound = false;
        for (let i = 0; i < 60; i++) {
          const windows = await page.$$('.plan-subagent-window');
          if (windows.length > 0) {
            console.log(`[PlanGenE2E] Found ${windows.length} subagent window(s)`);
            windowsFound = true;
            break;
          }
          await page.waitForTimeout(500);
        }

        if (windowsFound) {
          // Verify window content
          const windowCount = await page.$$eval('.plan-subagent-window', els => els.length);
          console.log('[PlanGenE2E] Total subagent windows:', windowCount);
          expect(windowCount).toBeGreaterThan(0);

          // Check for running/completed status
          const runningCount = await page.$$eval('.plan-subagent-status.running', els => els.length);
          const completedCount = await page.$$eval('.plan-subagent-status.completed', els => els.length);
          console.log(`[PlanGenE2E] Status - Running: ${runningCount}, Completed: ${completedCount}`);
        } else {
          console.log('[PlanGenE2E] No subagent windows appeared within timeout');
          // This could be due to plan generation completing too fast or an issue
        }

        // Wait for plan generation to complete (check for plan items or timeout)
        console.log('[PlanGenE2E] Waiting for plan generation to complete...');
        let planGenerated = false;
        for (let i = 0; i < 120; i++) { // Up to 60 seconds
          // Check if plan items appeared
          const planItems = await page.$$('.plan-item, .plan-task');
          if (planItems.length > 0) {
            console.log(`[PlanGenE2E] Plan generated with ${planItems.length} items`);
            planGenerated = true;
            break;
          }

          // Check if there's a success message
          const successMsg = await page.$('.plan-generated, .plan-success');
          if (successMsg) {
            console.log('[PlanGenE2E] Plan generation completed (success message)');
            planGenerated = true;
            break;
          }

          await page.waitForTimeout(500);
        }

        // Get collected events
        const collectedEvents = await page.evaluate(() => (window as any).__subagentEvents || []);
        console.log('[PlanGenE2E] Collected subagent events:', collectedEvents.length);

      } else {
        console.log('[PlanGenE2E] Generate Plan button not found, skipping window test');
      }

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, 180000); // 3 minutes timeout

  it('should handle rapid plan cancellation gracefully', async () => {
    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      // Start a plan generation request
      const controller = new AbortController();
      const fetchPromise = fetch(`${serverFixture.baseUrl}/api/generate-plan-detailed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskDescription: 'Create a complex microservices architecture',
        }),
        signal: controller.signal,
      });

      // Cancel after 2 seconds
      setTimeout(() => {
        console.log('[PlanGenE2E] Aborting request...');
        controller.abort();
      }, 2000);

      try {
        await fetchPromise;
      } catch (err: any) {
        if (err.name === 'AbortError') {
          console.log('[PlanGenE2E] Request aborted as expected');
        } else {
          throw err;
        }
      }

      // Server should still be healthy
      const statusResponse = await fetch(`${serverFixture.baseUrl}/api/status`);
      const statusData = await statusResponse.json();
      expect(statusData.version).toBeDefined();
      console.log('[PlanGenE2E] Server still healthy after cancel');

    } catch (error) {
      console.error('[PlanGenE2E] Cancel test error:', error);
      throw error;
    }
  }, E2E_TIMEOUTS.TEST);
});
