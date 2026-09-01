/**
 * A persistent full-screen overlay must not carry `backdrop-filter` while it is
 * hidden.
 *
 * The property promotes the element to its own compositing layer, and a
 * full-screen `position: fixed` layer that is created and then hidden has been
 * observed to leave a stale HIT-TEST region behind in Chrome: the page renders
 * correctly while pointer events over the viewport land on nothing. Reported on
 * a long-lived tab against a remote server (where a connection blip shows and
 * then hides #offlineOverlay): terminal scrolling AND unrelated click-to-expand
 * controls died together, a freshly opened tab was fine, and a console
 * one-liner doing nothing but READING layout restored it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

/** Persistent, full-screen, fixed overlays and the selector that shows each. */
const PERSISTENT_OVERLAYS: Array<{ base: string; shown: string }> = [
  { base: '.offline-overlay', shown: '.offline-overlay:not([hidden])' },
  { base: '.file-preview-overlay', shown: '.file-preview-overlay.visible' },
];

describe('persistent full-screen overlays do not composite while hidden', () => {
  for (const { base, shown } of PERSISTENT_OVERLAYS) {
    it(`${base} keeps backdrop-filter off its base rule`, () => {
      expect(ruleBody(base)).not.toMatch(/backdrop-filter/);
    });

    it(`${base} still blurs once shown, via ${shown}`, () => {
      // Moving the property must not silently DELETE the effect: the overlay is
      // meant to blur what is behind it while it is up.
      const body = ruleBody(shown);
      expect(body).toMatch(/(^|\s)backdrop-filter:\s*blur\(/m);
      expect(body).toMatch(/-webkit-backdrop-filter:\s*blur\(/);
    });
  }

  it('the offline overlay still forces display:none when hidden', () => {
    // The base rule is `display: flex`, so [hidden] alone would not hide it —
    // this is the guard that rule stays put while the block is edited.
    expect(ruleBody('.offline-overlay[hidden]')).toMatch(/display:\s*none\s*!important/);
  });
});
