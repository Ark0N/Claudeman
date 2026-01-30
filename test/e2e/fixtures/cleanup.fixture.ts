/**
 * Cleanup fixture for E2E tests
 * Tracks and cleans up all resources (sessions, cases, screens)
 *
 * CRITICAL SAFETY: This fixture protects user screens by:
 * 1. Capturing pre-existing screens at MODULE LOAD time - these are NEVER killed
 * 2. Tracking screens created during tests - these ARE cleaned up
 * 3. Protecting current process screen ($CLAUDEMAN_SCREEN_NAME)
 *
 * KEY INSIGHT: The cleanup is based on WHEN screens were created, not naming patterns.
 * Screens that existed before this module loaded are user screens and protected.
 * Screens created after are test screens and will be cleaned up.
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Capture pre-existing screens at MODULE LOAD time (before any tests run).
 * These screens existed before tests started and must NEVER be killed.
 * This is the ONLY reliable way to distinguish user screens from test screens.
 */
const PRE_EXISTING_SCREENS: Set<string> = new Set();
const CURRENT_SCREEN_NAME = process.env.CLAUDEMAN_SCREEN_NAME || '';

// Capture pre-existing screens immediately when this module loads
try {
  const output = execSync('screen -ls 2>/dev/null || true', {
    encoding: 'utf-8',
    timeout: 5000,
  });
  for (const line of output.split('\n')) {
    const match = line.match(/\d+\.([^\s]+)/);
    if (match) {
      PRE_EXISTING_SCREENS.add(match[1]);
    }
  }
  if (PRE_EXISTING_SCREENS.size > 0) {
    console.log(`[CleanupTracker] Protected ${PRE_EXISTING_SCREENS.size} pre-existing user screens`);
  }
} catch {
  // Ignore errors during capture
}

/**
 * Check if a screen name matches user-created patterns (w1-*, s1-*, etc.)
 */
function isUserScreenPattern(screenName: string): boolean {
  // w1-, w2-, s1-, s2-, etc. prefixes are user session patterns
  return /^[ws]\d+-/.test(screenName);
}

/**
 * Check if a screen name looks like a test screen (contains 'test' or 'e2e')
 */
function isE2ETestScreen(screenName: string): boolean {
  return screenName.includes('test') || screenName.includes('e2e');
}

/**
 * Check if a screen is protected (should NEVER be killed)
 *
 * CRITICAL: Protection is based on WHEN the screen was created, not naming.
 * - Screens in PRE_EXISTING_SCREENS existed before tests started = USER screens
 * - Current process screen is always protected
 * - User patterns (w1-*, s1-*) are protected as extra safety
 */
function isProtectedScreen(screenName: string): boolean {
  // Pre-existing screens are ALWAYS protected - this is the primary safeguard
  if (PRE_EXISTING_SCREENS.has(screenName)) {
    return true;
  }
  // Current process's screen is protected
  if (CURRENT_SCREEN_NAME && screenName === CURRENT_SCREEN_NAME) {
    return true;
  }
  // User-created screen patterns (w1-*, s1-*) are protected as extra safety
  if (isUserScreenPattern(screenName)) {
    return true;
  }
  // Everything else can be cleaned up (it was created after tests started)
  return false;
}

export class CleanupTracker {
  private sessions: Set<string> = new Set();
  private cases: Set<string> = new Set();
  private screens: Set<string> = new Set();
  private baseUrl: string;
  private casesDir: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.casesDir = join(homedir(), 'claudeman-cases');
  }

  /**
   * Track a session for cleanup.
   * Sessions are deleted via API which handles screen cleanup.
   */
  trackSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  /**
   * Track a case for cleanup.
   * SAFETY: Only e2e-test-* cases will be deleted during cleanup.
   */
  trackCase(caseName: string): void {
    this.cases.add(caseName);
  }

  /**
   * Track a screen for cleanup.
   * SAFETY: Protected screens (pre-existing) will be skipped during actual cleanup.
   */
  trackScreen(screenName: string): void {
    // Still warn but allow tracking - actual protection happens at kill time
    if (isProtectedScreen(screenName)) {
      console.warn(`[CleanupTracker] WARNING: Tracking protected screen ${screenName} - will be skipped during cleanup`);
    }
    this.screens.add(screenName);
  }

  /**
   * Clean up all tracked resources
   */
  async cleanup(): Promise<void> {
    // Delete sessions via API
    for (const sessionId of this.sessions) {
      try {
        await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore errors, session may already be deleted
      }
    }
    this.sessions.clear();

    // Delete case directories - ONLY e2e-test-* cases
    for (const caseName of this.cases) {
      // SAFETY: Double-check case name before deletion
      if (!caseName.startsWith('e2e-test-')) {
        console.warn(`[CleanupTracker] BLOCKED deletion of non-e2e-test case: ${caseName}`);
        continue;
      }
      try {
        const casePath = join(this.casesDir, caseName);
        if (existsSync(casePath)) {
          rmSync(casePath, { recursive: true, force: true });
        }
      } catch {
        // Ignore errors
      }
    }
    this.cases.clear();

    // Kill tracked screens
    for (const screenName of this.screens) {
      this.killScreen(screenName);
    }
    this.screens.clear();
  }

  /**
   * Kill a specific screen session
   * SAFETY: Refuses to kill protected or non-e2e-test screens
   */
  private killScreen(screenName: string): void {
    // CRITICAL SAFETY CHECK: Never kill protected screens
    if (isProtectedScreen(screenName)) {
      console.warn(`[CleanupTracker] BLOCKED attempt to kill protected screen: ${screenName}`);
      return;
    }

    // Double-check: only kill e2e-test screens
    if (!isE2ETestScreen(screenName)) {
      console.warn(`[CleanupTracker] BLOCKED attempt to kill non-e2e-test screen: ${screenName}`);
      return;
    }

    try {
      console.log(`[CleanupTracker] Killing e2e-test screen: ${screenName}`);
      execSync(`screen -S ${screenName} -X quit 2>/dev/null`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // Screen may not exist or already be dead
    }
  }

  /**
   * Force cleanup ALL test-created resources.
   * This cleans up:
   * - All tracked sessions (via API)
   * - All e2e-test-* case directories
   * - ALL claudeman screens created AFTER this module loaded (not in PRE_EXISTING_SCREENS)
   */
  async forceCleanupAll(): Promise<void> {
    // First, clean tracked resources
    await this.cleanup();

    // Delete ONLY e2e-test sessions via API
    // CRITICAL: NEVER delete sessions based on screen name - only explicit e2e-test markers
    try {
      const response = await fetch(`${this.baseUrl}/api/sessions`);
      if (response.ok) {
        const data = await response.json();
        const sessions = Array.isArray(data) ? data : data.sessions || [];
        for (const session of sessions) {
          // ONLY delete sessions with explicit e2e-test markers
          // Never use screen name matching - it's not reliable
          const isTestSession = session.name?.includes('e2e-test') ||
                               session.workingDir?.includes('e2e-test');
          if (isTestSession) {
            try {
              await fetch(`${this.baseUrl}/api/sessions/${session.id}`, {
                method: 'DELETE',
              });
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Server may be down
    }

    // Clean up e2e-test-* case directories
    try {
      if (existsSync(this.casesDir)) {
        const entries = execSync(`ls -1 "${this.casesDir}" 2>/dev/null || true`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim().split('\n').filter(Boolean);

        for (const entry of entries) {
          if (entry.startsWith('e2e-test-')) {
            const casePath = join(this.casesDir, entry);
            rmSync(casePath, { recursive: true, force: true });
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    // Kill ONLY screens that explicitly contain 'test' in the name
    // CRITICAL: Never kill screens based on timing/pre-existing checks alone
    // This is the only safe approach - rely on explicit test naming
    try {
      const screenList = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const screenLines = screenList.split('\n');
      for (const line of screenLines) {
        // Match any claudeman-* screen
        const match = line.match(/\d+\.(claudeman-[^\s]+)/);
        if (match) {
          const screenName = match[1];
          // ONLY kill screens with explicit 'test' in the name
          if (screenName.includes('test') && !isProtectedScreen(screenName)) {
            this.killScreen(screenName);
          }
        }
      }
    } catch {
      // Ignore screen cleanup errors
    }
  }

  /**
   * Get list of screens that match a pattern
   */
  getScreensByPattern(pattern: string): string[] {
    try {
      const screenList = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const screens: string[] = [];
      const screenLines = screenList.split('\n');
      for (const line of screenLines) {
        if (line.includes(pattern)) {
          const match = line.match(/\d+\.([^\s]+)/);
          if (match) {
            screens.push(match[1]);
          }
        }
      }
      return screens;
    } catch {
      return [];
    }
  }

  /**
   * Check if a screen exists
   */
  screenExists(screenName: string): boolean {
    try {
      const screenList = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return screenList.includes(screenName);
    } catch {
      return false;
    }
  }
}

// Export safety utilities for use in other test files
export { PRE_EXISTING_SCREENS, isProtectedScreen, isE2ETestScreen, isUserScreenPattern };
