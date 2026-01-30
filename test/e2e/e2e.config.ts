/**
 * E2E Test Configuration
 * Contains port allocations and shared test configuration
 */

// Port allocations for E2E tests
// See CLAUDE.md test port table for full list
export const E2E_PORTS = {
  QUICK_START: 3183,
  SESSION_INPUT: 3184,
  SESSION_DELETE: 3185,
  MULTI_SESSION: 3186,
  AGENT_INTERACTIONS: 3187,
  INPUT_INTERACTIONS: 3188,
  RESPAWN_FLOW: 3189,
  RALPH_LOOP: 3190,
  MOBILE_SAFARI: 3191,
} as const;

// Mobile device viewports for responsive testing
export const MOBILE_VIEWPORTS = {
  // iPhone 17 Pro - 402x874 @3x
  IPHONE_17_PRO: {
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  // iPhone 17 Pro Max - 440x956 @3x
  IPHONE_17_PRO_MAX: {
    width: 440,
    height: 956,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  // iPad Pro 11" - 834x1194 @2x
  IPAD_PRO_11: {
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
} as const;

// Timeouts for various operations
export const E2E_TIMEOUTS = {
  /** Default test timeout */
  TEST: 90000,
  /** Browser fixture creation */
  BROWSER_SETUP: 30000,
  /** Server startup */
  SERVER_STARTUP: 15000,
  /** Session creation */
  SESSION_CREATE: 30000,
  /** Screen creation verification */
  SCREEN_VERIFY: 15000,
  /** Terminal visibility */
  TERMINAL_VISIBLE: 10000,
  /** Agent spawn detection */
  AGENT_SPAWN: 30000,
  /** General element visibility */
  ELEMENT_VISIBLE: 15000,
} as const;

// Test case naming prefix (for easy cleanup)
export const E2E_CASE_PREFIX = 'e2e-test-';

// Generate unique case name for tests
export function generateCaseName(testName: string): string {
  return `${E2E_CASE_PREFIX}${testName}-${Date.now()}`;
}
