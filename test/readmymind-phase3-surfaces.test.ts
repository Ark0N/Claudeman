// Port: none (pure static analysis, runs in CI, no browser/server).
//
// Regression guard for the Read My Mind phase-3 surfaces (alternates, steer,
// phone accessory key, overview waiting-row shortcut). The browser E2E that
// exercised these lives outside CI, so this test pins the load-bearing facts
// statically, in the style of mobile-header-buttons-policy.test.ts:
//
// 1. The accessory-bar 🧠 key exists in BOTH layouts and ships `hidden`
//    (setMode() swaps innerHTML; a key present in only one layout silently
//    vanishes when the user toggles extendedKeyboardBar).
// 2. `.accessory-btn[hidden]` is re-asserted as display:none !important:
//    the base rule is display:inline-flex, which beats the UA [hidden] rule,
//    so without this the key can never hide (same trap as .home-sessions).
// 3. The header 🧠 button stays OFF phones (the accessory key + overview strip
//    are the phone surfaces).
// 4. The overview shortcut is gated to `waiting` rows only: on red rows a
//    dialog is on screen and text sent via POST /input would land in its menu.
//    Answer-aware routing through the approvals endpoint is phase-3 PR 2;
//    loosening this gate before that lands is a real misdelivery bug.
// 5. The 'readmymind' action must NOT refocus the terminal (the modal takes
//    over; a refocus would pop the phone keyboard back up over it).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');

const accessoryJs = readFileSync(join(PUBLIC, 'keyboard-accessory.js'), 'utf8');
const overviewJs = readFileSync(join(PUBLIC, 'mobile-overview.js'), 'utf8');
const stylesCss = readFileSync(join(PUBLIC, 'styles.css'), 'utf8');
const mobileCss = readFileSync(join(PUBLIC, 'mobile.css'), 'utf8');
const indexHtml = readFileSync(join(PUBLIC, 'index.html'), 'utf8');

/** Extract a template-literal property body, e.g. `_simpleButtons: \`...\``. */
function templateBody(source: string, prop: string): string {
  const m = source.match(new RegExp(`${prop}:\\s*\``));
  if (!m || m.index === undefined) return '';
  const start = m.index + m[0].length;
  const end = source.indexOf('`', start);
  return end === -1 ? '' : source.slice(start, end);
}

describe('read my mind phase-3 surfaces (static policy)', () => {
  it('accessory 🧠 key exists in BOTH layouts and ships hidden', () => {
    for (const layout of ['_simpleButtons', '_extendedButtons']) {
      const body = templateBody(accessoryJs, layout);
      expect(body, `${layout} template found`).not.toBe('');
      const keys = body.match(/data-action="readmymind"/g) || [];
      expect(keys.length, `${layout} has exactly one readmymind key`).toBe(1);
      const tag = body.match(/<button[^>]*data-action="readmymind"[^>]*>/);
      expect(tag, `${layout} readmymind button tag parses`).toBeTruthy();
      expect(tag![0], `${layout} key ships hidden (refreshReadMyMind reveals it)`).toContain('hidden');
    }
  });

  it('refreshReadMyMind is re-applied after every innerHTML rebuild', () => {
    // init() and setMode() both assign innerHTML, which resurrects the default
    // `hidden` attribute; each must re-derive visibility afterwards.
    const calls = accessoryJs.match(/this\.refreshReadMyMind\(\)/g) || [];
    expect(calls.length, 'called from init() and setMode() at least').toBeGreaterThanOrEqual(2);
    // The setMode rebuild specifically must be followed by a refresh.
    expect(accessoryJs).toMatch(
      /innerHTML = mode === 'extended' \? this\._extendedButtons : this\._simpleButtons;[\s\S]{0,300}?this\.refreshReadMyMind\(\)/
    );
  });

  it('accessory [hidden] re-assertion exists (inline-flex beats the UA rule)', () => {
    expect(stylesCss).toMatch(/\.accessory-btn\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  });

  it('the readmymind action never refocuses the terminal', () => {
    const refocus = accessoryJs.match(/refocusActions\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(refocus, 'refocusActions set found').toBeTruthy();
    expect(refocus![1]).not.toContain('readmymind');
  });

  it('header 🧠 button stays hidden on phones', () => {
    expect(mobileCss).toMatch(/\.btn-icon-header\.btn-readmymind\s*\{\s*display:\s*none\s*!important;/);
  });

  it('overview shortcut is gated to waiting rows only (red rows have a dialog on screen)', () => {
    const defIdx = overviewJs.indexOf('_readMyMindRowShortcut(row) {');
    expect(defIdx, '_readMyMindRowShortcut definition found').toBeGreaterThan(-1);
    const gate = overviewJs.slice(defIdx, overviewJs.indexOf('_buildMobileOverviewRmmStrip(sessionId) {'));
    expect(gate, 'definition precedes its strip builder').not.toBe('');
    expect(gate).toContain("row.state !== 'waiting'");
  });

  it('alternates container and steer input exist with i18n protection', () => {
    // Suggestion content is observed/injectable text; the container-level skip
    // covers the dynamically inserted rows (i18n skip checks ancestors).
    expect(indexHtml).toMatch(/id="readMyMindAlternates"[^>]*data-i18n-skip/);
    expect(indexHtml).toContain('id="readMyMindSteer"');
    // The steer field lives OUTSIDE the result div so it stays available in
    // the error phase (steering a failed run's retry).
    const resultDiv = indexHtml.slice(
      indexHtml.indexOf('class="readmymind-result"'),
      indexHtml.indexOf('class="readmymind-error"')
    );
    expect(resultDiv).not.toContain('id="readMyMindSteer"');
  });
});
