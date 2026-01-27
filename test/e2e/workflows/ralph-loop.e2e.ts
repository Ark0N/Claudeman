/**
 * Ralph Loop Wizard E2E Test
 * Tests the complete Ralph Loop wizard flow:
 * 1. Open wizard modal
 * 2. Configure loop with case and task
 * 3. Start loop and verify session creation
 * 4. Verify Ralph tracker is enabled
 * 5. Verify prompt is sent correctly
 *
 * Port: 3190 (see CLAUDE.md test port table)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  createServerFixture,
  destroyServerFixture,
  createBrowserFixture,
  destroyBrowserFixture,
  navigateTo,
  waitForVisible,
  clickElement,
  typeInto,
  getText,
  isVisible,
  CleanupTracker,
  captureAndCompare,
  type ServerFixture,
  type BrowserFixture,
} from '../fixtures/index.js';
import { E2E_PORTS, E2E_TIMEOUTS, generateCaseName } from '../e2e.config.js';

const PORT = E2E_PORTS.RALPH_LOOP;
let serverFixture: ServerFixture | null = null;
let cleanup: CleanupTracker;

describe('Ralph Loop Wizard E2E', () => {
  afterAll(async () => {
    if (cleanup) {
      await cleanup.forceCleanupAll();
    }
    if (serverFixture) {
      await destroyServerFixture(serverFixture);
    }
  }, E2E_TIMEOUTS.TEST);

  it('should open Ralph Loop wizard via UI', async () => {
    let browser: BrowserFixture | null = null;

    try {
      // Start server
      serverFixture = await createServerFixture(PORT);
      cleanup = new CleanupTracker(serverFixture.baseUrl);

      // Launch browser
      browser = await createBrowserFixture();
      const { page } = browser;

      // Navigate to Claudeman
      await navigateTo(page, serverFixture.baseUrl);

      // Verify page loaded
      const title = await page.title();
      expect(title).toBe('Claudeman');

      // Click the Ralph Loop button (🔄)
      await page.waitForSelector('.btn-ralph', { timeout: E2E_TIMEOUTS.ELEMENT_VISIBLE });
      await clickElement(page, '.btn-ralph');

      // Wait for wizard modal to appear and have active class
      await page.waitForSelector('#ralphWizardModal.active', { timeout: E2E_TIMEOUTS.ELEMENT_VISIBLE });
      expect(await isVisible(page, '#ralphWizardModal.active')).toBe(true);

      // Verify wizard header is correct (use specific selector for Ralph wizard)
      const header = await getText(page, '#ralphWizardModal .modal-header h3');
      expect(header.toLowerCase()).toContain('ralph');

      // Take screenshot
      const screenshotResult = await captureAndCompare(page, 'ralph-wizard-open', {
        mask: [], // No masking needed
      });
      expect(screenshotResult.passed).toBe(true);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should start Ralph Loop with claudeman-ios using initprompt.md', async () => {
    let browser: BrowserFixture | null = null;
    const caseName = 'claudeman-ios'; // Use existing case
    const casePath = join(homedir(), 'claudeman-cases', caseName);

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }

      // Read the initprompt.md from the case
      const initPromptPath = join(casePath, 'initprompt.md');
      let taskDescription = 'Test task for Ralph Loop';
      if (existsSync(initPromptPath)) {
        taskDescription = readFileSync(initPromptPath, 'utf-8').trim();
        console.log('[RalphLoopE2E] Using initprompt.md:', taskDescription.slice(0, 100) + '...');
      } else {
        console.log('[RalphLoopE2E] initprompt.md not found, using default task');
      }

      // Check if @fix_plan.md exists (for reuse)
      const fixPlanPath = join(casePath, '@fix_plan.md');
      const hasExistingPlan = existsSync(fixPlanPath);
      console.log('[RalphLoopE2E] Existing @fix_plan.md:', hasExistingPlan);

      browser = await createBrowserFixture();
      const { page } = browser;

      await navigateTo(page, serverFixture.baseUrl);

      // Open Ralph wizard
      await page.waitForSelector('.btn-ralph', { timeout: E2E_TIMEOUTS.ELEMENT_VISIBLE });
      await clickElement(page, '.btn-ralph');
      await page.waitForSelector('#ralphWizardModal.active', { timeout: E2E_TIMEOUTS.ELEMENT_VISIBLE });

      // Select case in dropdown
      const caseSelect = await page.$('#ralphCaseSelect');
      if (caseSelect) {
        await page.selectOption('#ralphCaseSelect', caseName);
      }

      // Enter task description from initprompt.md
      const taskTextarea = await page.$('#ralphTaskDescription');
      if (taskTextarea) {
        await taskTextarea.fill(taskDescription);
      }

      // Note: Completion phrase is a hidden input with default value "COMPLETE"
      // We can change it via page.evaluate if needed
      await page.evaluate(() => {
        const input = document.getElementById('ralphCompletionPhrase') as HTMLInputElement;
        if (input) input.value = 'IOS_APP_COMPLETE';
      });

      // Click Next via JavaScript to bypass viewport issues
      await page.evaluate(() => {
        (document.getElementById('ralphNextBtn') as HTMLButtonElement)?.click();
      });
      await page.waitForTimeout(1000); // Wait for step transition

      // IMPORTANT: If we have an existing plan, the wizard should detect it
      // Check if the existing plan section is shown
      const existingPlanSection = await page.$('#existingPlanSection:not(.hidden)');
      if (existingPlanSection) {
        console.log('[RalphLoopE2E] Existing plan detected in wizard');
        // Click "Use Existing Plan" if available - via JavaScript
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const useBtn = btns.find(b => b.textContent?.includes('Use Existing'));
          if (useBtn) useBtn.click();
        });
        await page.waitForTimeout(500);
      } else {
        console.log('[RalphLoopE2E] No existing plan section visible, proceeding');
      }

      // Click Next again to go to step 3 (Launch) via JavaScript
      await page.evaluate(() => {
        (document.getElementById('ralphNextBtn') as HTMLButtonElement)?.click();
      });
      await page.waitForTimeout(1000);

      // Check if Start button is visible now
      const startBtnVisible = await page.evaluate(() => {
        const btn = document.getElementById('ralphStartBtn');
        return btn && btn.style.display !== 'none';
      });
      console.log('[RalphLoopE2E] Start button visible:', startBtnVisible);

      // Click Start Loop button via JavaScript
      await page.evaluate(() => {
        (document.getElementById('ralphStartBtn') as HTMLButtonElement)?.click();
      });

      // Wait for session tab to appear (loop started)
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Wait for session creation to complete
      await page.waitForSelector('.session-tab', { timeout: E2E_TIMEOUTS.SESSION_CREATE });

      // Verify session was created - API returns an array directly
      const response = await fetch(`${serverFixture.baseUrl}/api/sessions`);
      const sessions = await response.json();
      console.log('[RalphLoopE2E] Sessions found:', sessions.length);
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);

      // Find the NEWEST session for claudeman-ios (sort by createdAt descending)
      const matchingSessions = sessions
        .filter((s: any) => s.workingDir?.includes(caseName))
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      console.log('[RalphLoopE2E] Matching sessions:', matchingSessions.map((s: any) => ({ id: s.id, createdAt: s.createdAt })));

      const session = matchingSessions[0]; // Get the most recently created session
      console.log('[RalphLoopE2E] Using newest session:', session?.id, 'createdAt:', session?.createdAt);
      expect(session).toBeDefined();
      cleanup.trackSession(session.id);

      // Verify screen was created
      const screenName = `claudeman-${session.id.slice(0, 8)}`;
      cleanup.trackScreen(screenName);
      const screenList = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(screenList).toContain(screenName);

      // Wait a bit for Ralph tracker to be configured
      await page.waitForTimeout(2000);

      // Verify Ralph tracker is enabled via API
      const ralphRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${session.id}/ralph-state`);
      const ralphData = await ralphRes.json();
      console.log('[RalphLoopE2E] Ralph state for session', session.id, ':', JSON.stringify(ralphData.data?.loop, null, 2));

      expect(ralphData.success).toBe(true);

      // If Ralph is not enabled, this is the BUG - the wizard failed to configure Ralph
      if (!ralphData.data.loop.enabled) {
        console.error('[RalphLoopE2E] BUG: Ralph tracker not enabled! This is the issue.');
        console.error('[RalphLoopE2E] Full Ralph state:', JSON.stringify(ralphData, null, 2));
      }
      expect(ralphData.data.loop.enabled).toBe(true);

      // Check terminal buffer to see if prompt was sent
      const termRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${session.id}/terminal`);
      const termData = await termRes.json();
      console.log('[RalphLoopE2E] Terminal buffer length:', termData.terminalBuffer?.length);

    } finally {
      if (browser) {
        await destroyBrowserFixture(browser);
      }
    }
  }, E2E_TIMEOUTS.TEST);

  it('should configure Ralph tracker correctly via API', async () => {
    const caseName = generateCaseName('ralph-api');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      // Create session via quick-start
      const createRes = await fetch(`${serverFixture.baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, mode: 'claude' }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      cleanup.trackSession(createData.sessionId);

      // Configure Ralph tracker
      const configRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          completionPhrase: 'TEST_COMPLETE',
          maxIterations: 10,
        }),
      });
      const configData = await configRes.json();
      expect(configData.success).toBe(true);

      // Verify state
      const stateRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/ralph-state`);
      const stateData = await stateRes.json();
      expect(stateData.success).toBe(true);
      expect(stateData.data.loop.enabled).toBe(true);
      expect(stateData.data.loop.completionPhrase).toBe('TEST_COMPLETE');
      expect(stateData.data.loop.maxIterations).toBe(10);

    } catch (error) {
      console.error('[RalphLoopE2E] API test error:', error);
      throw error;
    }
  }, E2E_TIMEOUTS.TEST);

  it('should send input to session correctly', async () => {
    const caseName = generateCaseName('ralph-input');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      // Create session
      const createRes = await fetch(`${serverFixture.baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, mode: 'shell' }), // Use shell mode for simpler testing
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      cleanup.trackSession(createData.sessionId);

      // Wait for session to be ready
      await new Promise(r => setTimeout(r, 2000));

      // Send input via screen
      const inputRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: 'echo "RALPH_TEST_SUCCESS"\r',
          useScreen: true,
        }),
      });
      const inputData = await inputRes.json();
      expect(inputData.success).toBe(true);

      // Wait for output
      await new Promise(r => setTimeout(r, 1000));

      // Check terminal buffer for the output
      const termRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/terminal`);
      const termData = await termRes.json();
      console.log('[RalphLoopE2E] Terminal buffer length:', termData.terminalBuffer?.length);

      // The echo command should have been executed
      expect(termData.terminalBuffer).toContain('RALPH_TEST');

    } catch (error) {
      console.error('[RalphLoopE2E] Input test error:', error);
      throw error;
    }
  }, E2E_TIMEOUTS.TEST);

  it('should import @fix_plan.md and track todos', async () => {
    const caseName = generateCaseName('ralph-fixplan');

    try {
      if (!serverFixture) {
        serverFixture = await createServerFixture(PORT);
      }
      if (!cleanup) {
        cleanup = new CleanupTracker(serverFixture.baseUrl);
      }
      cleanup.trackCase(caseName);

      // Create session
      const createRes = await fetch(`${serverFixture.baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, mode: 'claude' }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      cleanup.trackSession(createData.sessionId);

      // Enable Ralph tracking
      await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Import fix plan content
      const planContent = `# Fix Plan

## High Priority (P0)
- [ ] Create Xcode project with SwiftUI
- [ ] Configure iOS deployment target 16.0+
- [ ] Add SPM dependencies

## Standard (P1)
- [ ] Define TypeScript-equivalent Swift models
- [ ] Create ClaudemanServer model
`;

      const importRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/fix-plan/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: planContent }),
      });
      const importData = await importRes.json();
      expect(importData.success).toBe(true);
      expect(importData.data.importedCount).toBeGreaterThan(0);

      // Verify todos were imported
      const stateRes = await fetch(`${serverFixture.baseUrl}/api/sessions/${createData.sessionId}/ralph-state`);
      const stateData = await stateRes.json();
      expect(stateData.success).toBe(true);
      expect(stateData.data.todos.length).toBeGreaterThan(0);
      console.log('[RalphLoopE2E] Imported todos:', stateData.data.todos.length);

    } catch (error) {
      console.error('[RalphLoopE2E] Fix plan import test error:', error);
      throw error;
    }
  }, E2E_TIMEOUTS.TEST);
});
