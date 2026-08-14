/**
 * @fileoverview Unit tests for the agent-skill injection helpers in hooks-config.ts
 * (`applyAgentSkill`, `installAgentSkillInto`, `removeAgentSkillFrom`).
 *
 * These run against the REAL packaged source (`skills/codeman/` at the repo root),
 * so they double as a guard that the skill files exist and are readable: an npm
 * publish without them would be caught here before the `files` entry silently
 * ignores the missing directory.
 *
 * Pure filesystem tests in a per-test temp dir. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  applyAgentSkill,
  installAgentSkillInto,
  removeAgentSkillFrom,
  refreshUserAgentSkill,
  seedAgentSessionPreamble,
} from '../src/hooks-config.js';

const MARKER_PREFIX = '<!-- codeman-managed-agent-skill';

let casePath: string;
const skillDir = () => join(casePath, '.claude', 'skills', 'codeman');

beforeEach(async () => {
  casePath = await mkdtemp(join(tmpdir(), 'codeman-agent-skill-'));
});

afterEach(async () => {
  await rm(casePath, { recursive: true, force: true });
});

describe('installAgentSkillInto / applyAgentSkill(enabled)', () => {
  it('installs SKILL.md (marker appended) and the reference files from the packaged source', async () => {
    const result = await applyAgentSkill(casePath, true);
    expect(result).toBe('installed');

    const skillMd = await readFile(join(skillDir(), 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    expect(skillMd).toContain(MARKER_PREFIX);

    // Reference files ride along byte-for-byte (no marker there).
    const sourceEndpoints = await readFile(
      join(process.cwd(), 'skills', 'codeman', 'reference', 'endpoints.md'),
      'utf-8'
    );
    const injectedEndpoints = await readFile(join(skillDir(), 'reference', 'endpoints.md'), 'utf-8');
    expect(injectedEndpoints).toBe(sourceEndpoints);
    expect(existsSync(join(skillDir(), 'reference', 'recipes.md'))).toBe(true);
  });

  it('is idempotent: a second run reports unchanged', async () => {
    await applyAgentSkill(casePath, true);
    expect(await applyAgentSkill(casePath, true)).toBe('unchanged');
  });

  it('refreshes a stale Codeman-managed copy back to the packaged content', async () => {
    await applyAgentSkill(casePath, true);
    const original = await readFile(join(skillDir(), 'SKILL.md'), 'utf-8');
    // Simulate an older injected version: content differs but the marker is intact.
    await writeFile(join(skillDir(), 'SKILL.md'), `stale content\n${MARKER_PREFIX}: old -->\n`);

    expect(await applyAgentSkill(casePath, true)).toBe('refreshed');
    expect(await readFile(join(skillDir(), 'SKILL.md'), 'utf-8')).toBe(original);
  });

  it('never clobbers a user-authored skills/codeman (no marker)', async () => {
    await mkdir(skillDir(), { recursive: true });
    await writeFile(join(skillDir(), 'SKILL.md'), '---\nname: codeman\n---\nmy own skill\n');

    expect(await applyAgentSkill(casePath, true)).toBe('foreign');
    expect(await readFile(join(skillDir(), 'SKILL.md'), 'utf-8')).toContain('my own skill');
    expect(existsSync(join(skillDir(), 'reference'))).toBe(false);
  });

  it('refuses to write through a symlinked skill dir (dogfooding layout)', async () => {
    await mkdir(join(casePath, '.claude', 'skills'), { recursive: true });
    await symlink(join(casePath, 'elsewhere'), skillDir());
    expect(await installAgentSkillInto(skillDir())).toBe('symlink');
  });

  it('refuses to write through a symlinked skills/ parent', async () => {
    await mkdir(join(casePath, 'real-skills'), { recursive: true });
    await mkdir(join(casePath, '.claude'), { recursive: true });
    await symlink(join(casePath, 'real-skills'), join(casePath, '.claude', 'skills'));
    expect(await installAgentSkillInto(skillDir())).toBe('symlink');
    expect(await readdir(join(casePath, 'real-skills'))).toEqual([]);
  });
});

describe('removeAgentSkillFrom / applyAgentSkill(disabled)', () => {
  it('removes our copy and prunes the emptied directories', async () => {
    await applyAgentSkill(casePath, true);
    expect(await applyAgentSkill(casePath, false)).toBe('removed');
    expect(existsSync(skillDir())).toBe(false);
    expect(existsSync(join(casePath, '.claude', 'skills'))).toBe(false);
    // `.claude` itself is not ours to prune.
    expect(existsSync(join(casePath, '.claude'))).toBe(true);
  });

  it('reports absent when there is nothing to remove', async () => {
    expect(await applyAgentSkill(casePath, false)).toBe('absent');
  });

  it('leaves a user-authored copy untouched', async () => {
    await mkdir(skillDir(), { recursive: true });
    await writeFile(join(skillDir(), 'SKILL.md'), 'my own skill\n');
    expect(await applyAgentSkill(casePath, false)).toBe('foreign');
    expect(existsSync(join(skillDir(), 'SKILL.md'))).toBe(true);
  });

  it("preserves a user's extra files in the directory (no rm -rf)", async () => {
    await applyAgentSkill(casePath, true);
    await writeFile(join(skillDir(), 'reference', 'my-notes.md'), 'mine\n');

    expect(await applyAgentSkill(casePath, false)).toBe('removed');
    expect(existsSync(join(skillDir(), 'SKILL.md'))).toBe(false);
    expect(existsSync(join(skillDir(), 'reference', 'endpoints.md'))).toBe(false);
    // The user's file and the directories holding it survive.
    expect(await readFile(join(skillDir(), 'reference', 'my-notes.md'), 'utf-8')).toBe('mine\n');
  });
});

describe('preamble single-source (seed + §0 heredoc parity)', () => {
  const packagedDir = join(process.cwd(), 'skills', 'codeman');

  it("SKILL.md's §0 heredoc is byte-identical to the packaged preamble.sh", async () => {
    const skillMd = await readFile(join(packagedDir, 'SKILL.md'), 'utf-8');
    const openTag = "<<'PREAMBLE'\n";
    const open = skillMd.indexOf(openTag);
    expect(open).toBeGreaterThan(-1);
    const start = open + openTag.length;
    const end = skillMd.indexOf('\nPREAMBLE\n', start);
    expect(end).toBeGreaterThan(start);
    // slice(.., end + 1) keeps the final line's own newline.
    const heredoc = skillMd.slice(start, end + 1);

    // The server seeds preamble.sh while agents that paste §0 write the heredoc; any
    // byte of drift between the two would make the §0 grep rewrite a seeded file (or
    // worse, ship different behavior depending on which path wrote it).
    const preamble = await readFile(join(packagedDir, 'preamble.sh'), 'utf-8');
    expect(preamble).toBe(heredoc);
  });

  it('seedAgentSessionPreamble writes the stamped preamble to the XDG cache path, 0600', async () => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    const cacheDir = join(casePath, 'xdg-cache');
    process.env.XDG_CACHE_HOME = cacheDir;
    try {
      await seedAgentSessionPreamble('seed-test-session');
      const target = join(cacheDir, 'codeman-agent-seed-test-session.sh');
      const content = await readFile(target, 'utf-8');
      expect(content.startsWith('# ---- Codeman agent preamble')).toBe(true);
      expect(content).toMatch(/\nCODEMAN_PREAMBLE=\d+\.\d+\.\d+\n$/);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevXdg;
    }
  });

  it('seedAgentSessionPreamble falls back to ~/.cache when XDG_CACHE_HOME is unset', async () => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      await seedAgentSessionPreamble('seed-home-session');
      // setup.ts points HOME at a per-file fixture, so this never touches the real ~.
      const target = join(homedir(), '.cache', 'codeman-agent-seed-home-session.sh');
      expect(existsSync(target)).toBe(true);
    } finally {
      if (prevXdg !== undefined) process.env.XDG_CACHE_HOME = prevXdg;
    }
  });
});

describe('refreshUserAgentSkill (the user-level copy must not rot)', () => {
  const userSkillDir = () => join(homedir(), '.claude', 'skills', 'codeman');

  it('reports absent and installs nothing when there is no user-level copy', async () => {
    expect(await refreshUserAgentSkill()).toBe('absent');
    expect(existsSync(userSkillDir())).toBe(false);
  });

  it('refreshes a stale Codeman-managed user copy back to the packaged content', async () => {
    await mkdir(userSkillDir(), { recursive: true });
    // An old injected version: different content, marker intact. This is the exact
    // shape that shadowed every fresh per-case injection on 2026-08-14.
    await writeFile(join(userSkillDir(), 'SKILL.md'), `old skill body\n\n${MARKER_PREFIX}: installed by Codeman -->\n`);

    expect(await refreshUserAgentSkill()).toBe('refreshed');
    const refreshed = await readFile(join(userSkillDir(), 'SKILL.md'), 'utf-8');
    expect(refreshed.startsWith('---\nname: codeman')).toBe(true);
    expect(existsSync(join(userSkillDir(), 'reference', 'endpoints.md'))).toBe(true);

    // And a second run settles to unchanged.
    expect(await refreshUserAgentSkill()).toBe('unchanged');
  });

  it("leaves a user's own (unmarked) skill alone", async () => {
    await mkdir(userSkillDir(), { recursive: true });
    await writeFile(join(userSkillDir(), 'SKILL.md'), 'my own codeman skill\n');
    expect(await refreshUserAgentSkill()).toBe('foreign');
    expect(await readFile(join(userSkillDir(), 'SKILL.md'), 'utf-8')).toBe('my own codeman skill\n');
  });
});
