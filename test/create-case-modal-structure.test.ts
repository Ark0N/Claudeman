/**
 * @fileoverview Static guard for the Add Case modal's submit controls (#368).
 *
 * Below 860px the shared set-* surface hides the modal footer, and for eight
 * releases that footer held the only Create/Clone/Link button, so no case could
 * be added from a phone and nothing failed. This pins the contract that fixed it:
 * a header submit button exists after the close button, and the two JS paths
 * that toggle submit state drive BOTH buttons.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const sessionUi = readFileSync(resolve(publicDir, 'session-ui.js'), 'utf8');
const mobileCss = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');

function caseModal(): string {
  const start = html.indexOf('<div class="modal" id="createCaseModal">');
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="modal"', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

function methodBody(signature: string): string {
  const start = sessionUi.indexOf(`\n  ${signature} {`);
  expect(start, `${signature} not found in session-ui.js`).toBeGreaterThan(-1);
  return sessionUi.slice(start, sessionUi.indexOf('\n  },', start));
}

describe('Add Case modal submit controls', () => {
  it('hides the footer on phones, so the header must carry a submit button', () => {
    expect(mobileCss).toMatch(
      /:is\(#appSettingsModal, #sessionOptionsModal, #createCaseModal\) \.set-foot \{\s*display: none;/
    );
    const modal = caseModal();
    const head = modal.slice(0, modal.indexOf('<div class="set-body">'));
    const closeIdx = head.indexOf('class="modal-close"');
    const saveIdx = head.indexOf('class="set-head-save" id="caseModalSubmitMobile" onclick="app.submitCaseModal()"');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    // Close stays first in the DOM; row-reverse paints Save to its left.
    expect(closeIdx).toBeLessThan(saveIdx);
    expect(modal).toContain('id="caseModalSubmit" onclick="app.submitCaseModal()"');
  });

  it('drives the footer and header submit buttons together', () => {
    for (const sig of ['switchCaseModalTab(tabName)', 'async submitCaseModal()']) {
      const body = methodBody(sig);
      expect(body, sig).toContain("'caseModalSubmit'");
      expect(body, sig).toContain("'caseModalSubmitMobile'");
    }
  });

  it('dims the header button while a submit is pending, where it is the only one visible', () => {
    expect(mobileCss).toMatch(/#createCaseModal \.set-head-save\.loading \{\s*opacity: 0\.6;\s*pointer-events: none;/);
  });
});
