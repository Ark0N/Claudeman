/**
 * Regression tests for the node-pty spawn-helper repair (issues #6, #204).
 *
 * node-pty@1.1.0 publishes `prebuilds/darwin-<arch>/spawn-helper` with mode 0644,
 * so on macOS every PTY spawn dies with `posix_spawnp failed.`. These tests pin
 * the two things the old fix got wrong: it looked ONLY in `build/Release` (which
 * does not exist on macOS, where the prebuilt binary is used), and it never
 * checked whether the repair actually worked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSpawnHelperFailure,
  listSpawnHelpers,
  repairSpawnHelperPermissions,
  spawnPtyWithHelperRepair,
  resetSpawnHelperRepairState,
  SPAWN_HELPER_FIX_HINT,
} from '../src/utils/node-pty-repair.js';

/** Builds a fake node-pty tree; each entry is a directory that gets a spawn-helper. */
function makeFakePtyDir(helpers: Array<{ dir: string; mode: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'codeman-node-pty-'));
  for (const { dir, mode } of helpers) {
    const full = join(root, dir);
    mkdirSync(full, { recursive: true });
    const helper = join(full, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    chmodSync(helper, mode);
  }
  return root;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('node-pty spawn-helper repair', () => {
  const created: string[] = [];

  beforeEach(() => resetSpawnHelperRepairState());

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(helpers: Array<{ dir: string; mode: number }>): string {
    const root = makeFakePtyDir(helpers);
    created.push(root);
    return root;
  }

  describe('isSpawnHelperFailure', () => {
    it('matches the native error node-pty throws on macOS', () => {
      expect(isSpawnHelperFailure(new Error('posix_spawnp failed.'))).toBe(true);
    });

    it('matches errors that name the helper directly', () => {
      expect(isSpawnHelperFailure(new Error('ENOENT: no such file, spawn-helper'))).toBe(true);
    });

    it('ignores unrelated spawn failures', () => {
      expect(isSpawnHelperFailure(new Error('cwd does not exist'))).toBe(false);
      expect(isSpawnHelperFailure(undefined)).toBe(false);
    });
  });

  describe('listSpawnHelpers', () => {
    it('finds the prebuilt helper, which is the ONLY one that exists on macOS', () => {
      // A stock macOS install has no build/ directory at all: node-pty ships a
      // darwin prebuild, so node-gyp never runs.
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);
      expect(listSpawnHelpers(root)).toEqual([join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper')]);
    });

    it('finds helpers across build/Release, build/Debug and every prebuilds arch', () => {
      const root = fixture([
        { dir: 'build/Release', mode: 0o755 },
        { dir: 'build/Debug', mode: 0o644 },
        { dir: 'prebuilds/darwin-arm64', mode: 0o644 },
        { dir: 'prebuilds/darwin-x64', mode: 0o644 },
      ]);
      expect(listSpawnHelpers(root).sort()).toEqual(
        [
          join(root, 'build', 'Release', 'spawn-helper'),
          join(root, 'build', 'Debug', 'spawn-helper'),
          join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
          join(root, 'prebuilds', 'darwin-x64', 'spawn-helper'),
        ].sort()
      );
    });

    it('returns nothing for a Linux install, which has no spawn-helper at all', () => {
      const root = fixture([]);
      mkdirSync(join(root, 'build', 'Release'), { recursive: true });
      writeFileSync(join(root, 'build', 'Release', 'pty.node'), 'stub');
      expect(listSpawnHelpers(root)).toEqual([]);
    });
  });

  describe('repairSpawnHelperPermissions', () => {
    it('adds the execute bit to the 0644 prebuilt helper', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);
      const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');

      const repaired = repairSpawnHelperPermissions(root);

      expect(repaired).toEqual([helper]);
      expect(modeOf(helper) & 0o111).toBe(0o111);
    });

    it('is a no-op on an already-executable helper', () => {
      const root = fixture([{ dir: 'build/Release', mode: 0o755 }]);
      expect(repairSpawnHelperPermissions(root)).toEqual([]);
      expect(modeOf(join(root, 'build', 'Release', 'spawn-helper'))).toBe(0o755);
    });

    it('repairs every copy, not just the first one found', () => {
      const root = fixture([
        { dir: 'prebuilds/darwin-arm64', mode: 0o644 },
        { dir: 'prebuilds/darwin-x64', mode: 0o644 },
      ]);
      expect(repairSpawnHelperPermissions(root)).toHaveLength(2);
      for (const arch of ['darwin-arm64', 'darwin-x64']) {
        expect(modeOf(join(root, 'prebuilds', arch, 'spawn-helper')) & 0o111).toBe(0o111);
      }
    });

    it('preserves the non-execute permission bits it was given', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o640 }]);
      const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
      repairSpawnHelperPermissions(root);
      expect(modeOf(helper)).toBe(0o755 | 0o640);
    });

    it('returns nothing when node-pty has no helper to repair', () => {
      expect(repairSpawnHelperPermissions(fixture([]))).toEqual([]);
    });
  });

  describe('spawnPtyWithHelperRepair', () => {
    it('passes the spawn result straight through when nothing is wrong', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o755 }]);
      expect(spawnPtyWithHelperRepair(() => 'pty', root)).toBe('pty');
    });

    it('repairs and retries once after a posix_spawnp failure', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);
      const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');

      let attempts = 0;
      const result = spawnPtyWithHelperRepair(() => {
        attempts++;
        // Mirror the real failure: node-pty only throws while the helper is 0644.
        if ((modeOf(helper) & 0o111) !== 0o111) throw new Error('posix_spawnp failed.');
        return 'pty';
      }, root);

      expect(result).toBe('pty');
      expect(attempts).toBe(2);
      expect(modeOf(helper) & 0o111).toBe(0o111);
    });

    it('rethrows unrelated errors untouched, without chmodding anything', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);
      const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');

      expect(() =>
        spawnPtyWithHelperRepair(() => {
          throw new Error('cwd does not exist');
        }, root)
      ).toThrow('cwd does not exist');

      expect(modeOf(helper)).toBe(0o644);
    });

    it('surfaces the manual fix command when the retry still fails', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);

      expect(() =>
        spawnPtyWithHelperRepair(() => {
          throw new Error('posix_spawnp failed.');
        }, root)
      ).toThrow(SPAWN_HELPER_FIX_HINT);
    });

    it('surfaces the fix command when there is no helper to repair', () => {
      const root = fixture([]);

      expect(() =>
        spawnPtyWithHelperRepair(() => {
          throw new Error('posix_spawnp failed.');
        }, root)
      ).toThrow(SPAWN_HELPER_FIX_HINT);
    });

    it('does not chmod-storm: only the first failure triggers a repair attempt', () => {
      const root = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);
      const boom = () => {
        throw new Error('posix_spawnp failed.');
      };

      expect(() => spawnPtyWithHelperRepair(boom, root)).toThrow(SPAWN_HELPER_FIX_HINT);

      // Second call: repair already attempted, so it fails fast with the hint and
      // never re-walks the tree.
      const untouched = fixture([{ dir: 'prebuilds/darwin-arm64', mode: 0o644 }]);
      expect(() => spawnPtyWithHelperRepair(boom, untouched)).toThrow(SPAWN_HELPER_FIX_HINT);
      expect(modeOf(join(untouched, 'prebuilds', 'darwin-arm64', 'spawn-helper'))).toBe(0o644);
    });
  });
});
