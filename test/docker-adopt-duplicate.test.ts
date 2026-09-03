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

describe('applying a source fills every field, including the two that must differ', () => {
  const fn = ui.slice(ui.indexOf('applyDockerCloneSource()'), ui.indexOf('dockerCloneGuard()'));

  it('carries over container, host and workspace', () => {
    for (const id of ['dockerContainerName', 'dockerHostId', 'dockerWorkspacePath']) {
      expect(fn).toContain(`set('${id}', option.dataset.`);
    }
  });

  it('PRE-FILLS the case name and container workdir rather than clearing them', () => {
    // Editing `/srv/app/api` into `/srv/app/web` beats retyping a long path, and a
    // form with three fields mysteriously filled and two blank reads as broken.
    // What stops an unchanged submit is the guard, not an empty field.
    expect(fn).toContain("set('dockerCaseName', option.value)");
    expect(fn).toContain("set('dockerAdoptWorkdir', option.dataset.workdir)");
  });

  it('remembers what it applied, so the guard can tell unchanged from similar', () => {
    expect(fn).toContain('select.dataset.appliedName = option.value');
    expect(fn).toContain('select.dataset.appliedWorkdir =');
  });

  it('focuses the workdir with the caret at the END, where the edit happens', () => {
    expect(fn).toMatch(/setSelectionRange\(workdir\.value\.length, workdir\.value\.length\)/);
  });

  it('does nothing for the blank "start from scratch" option', () => {
    expect(fn).toMatch(/if \(!option \|\| !option\.value\) return;/);
  });
});

describe('the guard refuses a duplicate that was never edited', () => {
  const fn = ui.slice(ui.indexOf('dockerCloneGuard()'), ui.indexOf('dockerCloneGuard()') + 1400);

  it('flags an unchanged case name', () => {
    expect(fn).toMatch(/appliedName/);
    expect(fn).toContain('give this one a new name');
  });

  it('flags an unchanged container workdir', () => {
    expect(fn).toMatch(/appliedWorkdir/);
    expect(fn).toContain('another directory');
  });

  it('stays silent when no source was picked', () => {
    // Typing a fresh adoption by hand must not be second-guessed.
    expect(fn).toMatch(/if \(!select \|\| !select\.value\) return null;/);
  });

  it('runs BEFORE the request, and focuses the offending field', () => {
    const submit = ui.slice(ui.indexOf('const cloneIssue'), ui.indexOf('const cloneIssue') + 500);
    expect(submit).toContain('cloneIssue.el.focus()');
    expect(submit).toContain('return;');
  });

  it('reports into a status element that actually exists', () => {
    // A dead id would silently drop the explanation next to the field.
    const submit = ui.slice(ui.indexOf('const cloneIssue'), ui.indexOf('const cloneIssue') + 500);
    const id = /getElementById\('([^']+)'\)/.exec(submit)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
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
