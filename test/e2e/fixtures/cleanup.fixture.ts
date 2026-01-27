/**
 * Cleanup fixture for E2E tests
 * Tracks and cleans up all resources (sessions, cases, screens)
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
   * Track a session for cleanup
   */
  trackSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  /**
   * Track a case for cleanup
   */
  trackCase(caseName: string): void {
    this.cases.add(caseName);
  }

  /**
   * Track a screen for cleanup
   */
  trackScreen(screenName: string): void {
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

    // Delete case directories
    for (const caseName of this.cases) {
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
   */
  private killScreen(screenName: string): void {
    try {
      execSync(`screen -S ${screenName} -X quit 2>/dev/null`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // Screen may not exist or already be dead
    }
  }

  /**
   * Force cleanup ALL e2e-test-* cases and claudeman-* screens
   * Use this in afterAll to ensure no orphans remain
   */
  async forceCleanupAll(): Promise<void> {
    // First, clean tracked resources
    await this.cleanup();

    // Force kill ALL e2e-test sessions via API
    try {
      const response = await fetch(`${this.baseUrl}/api/sessions`);
      if (response.ok) {
        const data = await response.json();
        if (data.sessions) {
          for (const session of data.sessions) {
            if (session.name?.startsWith('e2e-test-') || session.workingDir?.includes('e2e-test-')) {
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

    // Kill all e2e-test claudeman screens
    try {
      const screenList = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const screenLines = screenList.split('\n');
      for (const line of screenLines) {
        // Match claudeman-e2e-test-* screens
        const match = line.match(/\d+\.(claudeman-e2e-test-[^\s]+)/);
        if (match) {
          const screenName = match[1];
          this.killScreen(screenName);
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
