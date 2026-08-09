/**
 * @fileoverview Tests for `codeman skill install|uninstall` target resolution
 * (`resolveCliCasePath` / `resolveSkillTargetPath` in src/cli.ts).
 *
 * The linked-cases lookup shipped in 1.14.2 with no guard: before it, `--case`
 * rejected every case linked in from outside `~/codeman-cases` with "Case not
 * found" even though the server resolved the same name fine. These tests pin both
 * halves of that resolution (registry first, cases dir as fallback) and the
 * tolerance rules around a missing or malformed registry.
 *
 * `test/setup.ts` gives this file its own temporary HOME, so `homedir()` and
 * `dataPath()` already point into a per-file fixture: no os mocking needed.
 * Port: N/A (pure path resolution, no server).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataPath } from '../src/config/instance.js';
import { program, resolveCliCasePath, resolveSkillTargetPath } from '../src/cli.js';

const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CASES_DIR = join(homedir(), 'codeman-cases');
const LINKED_ROOT = join(homedir(), 'elsewhere');

/** Where the packaged skill lands under a case. Mirrors `applyAgentSkill()`. */
function skillDirIn(casePath: string): string {
  return join(casePath, '.claude', 'skills', 'codeman');
}

function writeLinkedCases(content: string): void {
  mkdirSync(dataPath(), { recursive: true });
  writeFileSync(LINKED_CASES_FILE, content, 'utf-8');
}

beforeEach(() => {
  rmSync(LINKED_CASES_FILE, { force: true });
  rmSync(CASES_DIR, { recursive: true, force: true });
  rmSync(LINKED_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(LINKED_CASES_FILE, { force: true });
  rmSync(CASES_DIR, { recursive: true, force: true });
  rmSync(LINKED_ROOT, { recursive: true, force: true });
});

describe('resolveSkillTargetPath (global)', () => {
  it('targets the user-scope skill dir when no --case is given', () => {
    expect(resolveSkillTargetPath({})).toEqual({
      target: join(homedir(), '.claude', 'skills', 'codeman'),
    });
  });

  it('never consults the linked-cases registry for the global target', () => {
    // A registry entry named after nothing in particular must not divert the
    // global install, which is not case-scoped at all.
    writeLinkedCases(JSON.stringify({ anything: join(LINKED_ROOT, 'anything') }));
    expect(resolveSkillTargetPath({}).target).toBe(join(homedir(), '.claude', 'skills', 'codeman'));
  });
});

describe('resolveCliCasePath / resolveSkillTargetPath (--case)', () => {
  it('resolves a LINKED case through linked-cases.json, not the cases dir', () => {
    // The 1.14.2 regression: a case linked in from outside ~/codeman-cases was
    // resolved to a cases-dir path that does not exist, so install refused it.
    const linkedPath = join(LINKED_ROOT, 'my-repo');
    mkdirSync(linkedPath, { recursive: true });
    writeLinkedCases(JSON.stringify({ 'my-repo': linkedPath }));

    expect(resolveCliCasePath('my-repo')).toBe(linkedPath);
    expect(resolveSkillTargetPath({ case: 'my-repo' })).toEqual({ target: skillDirIn(linkedPath) });
    expect(existsSync(join(CASES_DIR, 'my-repo'))).toBe(false);
  });

  it('falls back to the cases dir for a name the registry does not list', () => {
    const casePath = join(CASES_DIR, 'plain-case');
    mkdirSync(casePath, { recursive: true });
    writeLinkedCases(JSON.stringify({ 'other-case': join(LINKED_ROOT, 'other-case') }));

    expect(resolveCliCasePath('plain-case')).toBe(casePath);
    expect(resolveSkillTargetPath({ case: 'plain-case' })).toEqual({ target: skillDirIn(casePath) });
  });

  it('reports the resolved path instead of exiting when the case does not exist', () => {
    // process.exit(1) lives in the CLI wrapper on purpose: calling it here would
    // kill the test runner.
    expect(resolveSkillTargetPath({ case: 'nope' })).toEqual({ missingCase: join(CASES_DIR, 'nope') });
  });

  it('reports the LINKED path when the registry points at a directory that is gone', () => {
    const linkedPath = join(LINKED_ROOT, 'moved-away');
    writeLinkedCases(JSON.stringify({ 'moved-away': linkedPath }));

    expect(resolveSkillTargetPath({ case: 'moved-away' })).toEqual({ missingCase: linkedPath });
  });
});

describe('linked-cases.json tolerance', () => {
  const casePath = () => join(CASES_DIR, 'tolerant');

  beforeEach(() => {
    mkdirSync(casePath(), { recursive: true });
  });

  it('degrades to the cases dir when the registry file is absent', () => {
    expect(existsSync(LINKED_CASES_FILE)).toBe(false);
    expect(resolveSkillTargetPath({ case: 'tolerant' })).toEqual({ target: skillDirIn(casePath()) });
  });

  it('degrades to the cases dir on malformed JSON rather than throwing', () => {
    writeLinkedCases('{ not json at all');
    expect(() => resolveCliCasePath('tolerant')).not.toThrow();
    expect(resolveSkillTargetPath({ case: 'tolerant' })).toEqual({ target: skillDirIn(casePath()) });
  });

  it('degrades to the cases dir when the registry is valid JSON of the wrong shape', () => {
    // A null / array / non-string-valued entry must read as "no linked case",
    // never as a target path.
    for (const body of ['null', '[]', JSON.stringify({ tolerant: 42 }), JSON.stringify({ tolerant: '' })]) {
      writeLinkedCases(body);
      expect(resolveCliCasePath('tolerant')).toBe(casePath());
    }
  });
});

describe('skill command wiring', () => {
  it('registers install and uninstall, both accepting --case and --global', () => {
    const skill = program.commands.find((cmd) => cmd.name() === 'skill');
    expect(skill).toBeDefined();

    const subcommands = skill!.commands.map((cmd) => cmd.name());
    expect(subcommands).toEqual(expect.arrayContaining(['install', 'uninstall']));

    for (const name of ['install', 'uninstall']) {
      const flags = skill!.commands
        .find((cmd) => cmd.name() === name)!
        .options.map((opt) => opt.long)
        .sort();
      expect(flags).toEqual(['--case', '--global']);
    }
  });
});
