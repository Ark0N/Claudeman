/**
 * @fileoverview "Duplicate an existing case" in the container-adoption form.
 *
 * The server already allows one ADOPTED container to back several cases, each
 * pointing at a different directory inside it (classifyAdoptContainerConflict).
 * Re-typing the container, host and workspace by hand for every directory is the
 * friction that would leave that capability unused, so the form carries them over
 * and clears only the two fields that MUST differ.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
const ui = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
const routes = readFileSync(resolve(import.meta.dirname, '../src/web/routes/case-routes.ts'), 'utf8');
const apiTypes = readFileSync(resolve(import.meta.dirname, '../src/types/api.ts'), 'utf8');

describe('the API exposes what the picker needs', () => {
  it('reports each docker case s directory inside the container', () => {
    // Without it the picker cannot show WHICH directory a case already uses, which
    // is the one thing the user needs to see before choosing a different one.
    expect(apiTypes).toMatch(/containerWorkdir\?: string;/);
    expect(routes).toContain('containerWorkdir: dockerCase.containerWorkdir ?? dockerCase.hostWorkspacePath');
  });

  it('reports whether the container is owned, on EVERY case-shaped response', () => {
    // Two sites build a docker CaseInfo (the list and the single-case lookup);
    // filling only one leaves the picker blind depending on which the UI read.
    expect(routes.match(/owned: dockerCase\.owned !== false,/g) ?? []).toHaveLength(2);
  });

  it('treats an ABSENT owned flag as owned, so legacy cases are not offered', () => {
    // `owned` is optional and predates this field; truthiness would read a legacy
    // case as adopted and offer a duplicate the server then refuses.
    expect(routes).toContain('dockerCase.owned !== false');
  });
});

describe('the picker only offers what the server would accept', () => {
  const fn = ui.slice(ui.indexOf('async _loadDockerCloneOptions()'), ui.indexOf('applyDockerCloneSource()'));

  it('filters to ADOPTED cases only', () => {
    expect(fn).toMatch(/c\.docker\.owned === false/);
  });

  it('hides the row entirely when there is nothing to duplicate', () => {
    expect(fn).toMatch(/row\.hidden = cases\.length === 0/);
  });

  it('builds options with textContent, never markup', () => {
    // Case names and container names are user- and engine-supplied strings.
    expect(fn).toContain('option.textContent =');
    expect(fn).not.toContain('innerHTML');
  });
});

describe('applying a source fills what stays and clears what must differ', () => {
  const fn = ui.slice(ui.indexOf('applyDockerCloneSource()'), ui.indexOf('applyDockerCloneSource()') + 1400);

  it('carries over container, host and workspace', () => {
    for (const id of ['dockerContainerName', 'dockerHostId', 'dockerWorkspacePath']) {
      expect(fn).toContain(`set('${id}', option.dataset.`);
    }
  });

  it('clears the case name and the container workdir', () => {
    // Keeping either would pre-fill a value the server is certain to refuse —
    // the name as an existing case, the workdir as an exact twin.
    expect(fn).toContain("set('dockerCaseName', '')");
    expect(fn).toContain("set('dockerAdoptWorkdir', '')");
  });

  it('focuses the workdir, the field the user came here to change', () => {
    expect(fn).toMatch(/getElementById\('dockerAdoptWorkdir'\)\?\.focus\(\)/);
  });

  it('does nothing for the blank "start from scratch" option', () => {
    expect(fn).toMatch(/if \(!option \|\| !option\.value\) return;/);
  });
});

describe('the row is wired into the adoption panel', () => {
  it('lives in the adopt-only block and starts hidden', () => {
    expect(html).toMatch(/id="dockerAdoptCloneRow"[^>]*hidden/);
    expect(html).toMatch(/class="form-row docker-adopt-only" id="dockerAdoptCloneRow"/);
  });

  it('loads its options whenever adopt mode turns on', () => {
    // Slice from the DEFINITION, not the first call site.
    const start = ui.indexOf('_syncDockerAdoptMode() {');
    expect(start).toBeGreaterThan(-1);
    const sync = ui.slice(start, start + 900);
    expect(sync).toContain('_loadDockerCloneOptions()');
  });
});
