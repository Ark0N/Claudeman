/**
 * E2E Test Fixtures
 * Central export for all fixture utilities
 */

export {
  createServerFixture,
  destroyServerFixture,
  type ServerFixture,
} from './server.fixture.js';

export {
  createBrowserFixture,
  destroyBrowserFixture,
  navigateTo,
  waitForVisible,
  clickElement,
  typeInto,
  getText,
  isVisible,
  getElementCount,
  type BrowserFixture,
} from './browser.fixture.js';

export {
  createMobileSafariFixture,
  destroyMobileBrowserFixture,
  tap,
  swipe,
  swipeHorizontal,
  longPress,
  getComputedStyle,
  hasBodyClass,
  getMinHeight,
  type MobileBrowserFixture,
  type MobileViewport,
} from './mobile-browser.fixture.js';

export {
  CleanupTracker,
} from './cleanup.fixture.js';

export {
  captureAndCompare,
  captureScreenshot,
  updateBaseline,
  type ScreenshotOptions,
  type ScreenshotResult,
} from './screenshot.fixture.js';
