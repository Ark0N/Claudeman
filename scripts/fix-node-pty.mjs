#!/usr/bin/env node
/**
 * @fileoverview Repairs node-pty's macOS `spawn-helper` and verifies that a PTY
 * can really be spawned. Called by `scripts/postinstall.js` on every install and
 * exposed as `npm run fix:node-pty` for repairing an install after the fact.
 *
 * Why this exists (issues #6 and #204):
 *
 * node-pty@1.1.0 publishes its macOS prebuilt helper as
 * `prebuilds/darwin-<arch>/spawn-helper` with mode 0644, i.e. no execute bit.
 * On macOS node-pty launches every PTY through that helper with posix_spawnp,
 * which then fails EACCES and surfaces as `Error: posix_spawnp failed.` on every
 * session start.
 *
 * It is macOS-exclusive twice over: `spawn-helper` is an `OS=="mac"` gyp target,
 * and pty.cc only spawns it under `#if defined(__APPLE__)`. node-pty ships
 * prebuilds for darwin and win32 only, so Linux always compiles from source
 * (which produces an executable helper) and never sees the bug.
 *
 * The repair is a chmod, NOT a rebuild: the prebuilt binary itself is fine, and
 * requiring a from-source rebuild would make every macOS install depend on Xcode
 * command line tools. A rebuild is attempted only when a chmod plus a real spawn
 * probe still can't get a working PTY, and the prebuilds tree is backed up first
 * so a failed rebuild can never leave the install worse than it started.
 */

import { chmodSync, cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Errors that mean "the native module or its helper is unusable", i.e. worth a rebuild. */
const NATIVE_FAILURE_PATTERN = /posix_spawnp|spawn-helper|Failed to load native module|Cannot find module/i;

/**
 * Locates the installed node-pty package directory.
 *
 * @returns {string|null} Absolute path to the package root, or null if not installed.
 */
export function findNodePtyDir() {
    // package.json first: node-pty declares no "exports" map, so the subpath resolves,
    // and it lands on the package root directly. require.resolve('node-pty') would give
    // <pkg>/lib/index.js, which is one directory deeper than callers expect.
    try {
        return dirname(require.resolve('node-pty/package.json'));
    } catch {
        /* fall through */
    }
    try {
        return join(dirname(require.resolve('node-pty')), '..');
    } catch {
        return null;
    }
}

/**
 * Lists every `spawn-helper` shipped in a node-pty install.
 *
 * node-pty's own loader (lib/utils.js) checks `build/Release`, `build/Debug` and
 * then `prebuilds/<platform>-<arch>`, and takes the helper from whichever
 * directory the native module loaded out of, so all of them must be executable,
 * not just the one this machine happens to use today.
 *
 * @param {string} ptyDir Absolute path to the node-pty package root.
 * @returns {string[]} Absolute paths of the helpers that exist on disk.
 */
export function listSpawnHelpers(ptyDir) {
    const dirs = [join(ptyDir, 'build', 'Release'), join(ptyDir, 'build', 'Debug')];

    const prebuilds = join(ptyDir, 'prebuilds');
    if (existsSync(prebuilds)) {
        try {
            for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
                if (entry.isDirectory()) dirs.push(join(prebuilds, entry.name));
            }
        } catch {
            /* unreadable prebuilds dir: nothing to repair there */
        }
    }

    return dirs.map((d) => join(d, 'spawn-helper')).filter((p) => existsSync(p));
}

/**
 * Adds the execute bit to every `spawn-helper` that is missing it.
 *
 * @param {string} ptyDir Absolute path to the node-pty package root.
 * @returns {{ repaired: string[], failed: Array<{ path: string, error: string }> }}
 */
export function repairSpawnHelpers(ptyDir) {
    const repaired = [];
    const failed = [];

    for (const helper of listSpawnHelpers(ptyDir)) {
        try {
            const mode = statSync(helper).mode & 0o777;
            if ((mode & 0o111) === 0o111) continue; // already executable by all
            chmodSync(helper, mode | 0o755);
            repaired.push(helper);
        } catch (err) {
            failed.push({ path: helper, error: err instanceof Error ? err.message : String(err) });
        }
    }

    return { repaired, failed };
}

/**
 * Proves node-pty works by actually opening a PTY, which is the only check that
 * exercises the spawn-helper path that breaks. A `require` alone would pass on a
 * broken install, because the helper is only touched at spawn time.
 *
 * @param {string} ptyDir Absolute path to the node-pty package root.
 * @returns {{ ok: boolean, error?: string, nativeFailure?: boolean }}
 */
export function verifyPtySpawn(ptyDir) {
    let child;
    try {
        const pty = require(ptyDir); // directory require → node-pty's "main" (lib/index.js)
        const file = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/echo';
        const args = process.platform === 'win32' ? ['/c', 'exit'] : ['codeman-node-pty-check'];
        child = pty.spawn(file, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: tmpdir(),
            env: process.env,
        });
        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message, nativeFailure: NATIVE_FAILURE_PATTERN.test(message) };
    } finally {
        try {
            child?.kill();
        } catch {
            /* the probe child exits on its own anyway */
        }
    }
}

/**
 * Rebuilds node-pty from source, preserving the prebuilds tree across a failure.
 *
 * node-pty's install script deletes `prebuilds/` as soon as
 * `npm_config_build_from_source` is set and only then shells out to node-gyp, so
 * a machine without a compiler toolchain would otherwise be left with neither a
 * prebuilt nor a compiled binary.
 *
 * @param {string} ptyDir Absolute path to the node-pty package root.
 * @param {string} cwd Directory to run npm from (the package root that owns node_modules).
 * @returns {{ ok: boolean, error?: string }}
 */
function rebuildFromSource(ptyDir, cwd) {
    const prebuilds = join(ptyDir, 'prebuilds');
    const backup = join(ptyDir, '.prebuilds-codeman-backup');

    let backedUp = false;
    if (existsSync(prebuilds)) {
        try {
            rmSync(backup, { recursive: true, force: true });
            cpSync(prebuilds, backup, { recursive: true });
            backedUp = true;
        } catch {
            /* best effort: proceed without a safety net rather than skip the repair */
        }
    }

    try {
        execSync('npm rebuild node-pty --build-from-source', { cwd, stdio: 'pipe', timeout: 300000 });
        return { ok: true };
    } catch (err) {
        if (backedUp && !existsSync(prebuilds)) {
            try {
                cpSync(backup, prebuilds, { recursive: true });
            } catch {
                /* nothing further we can do */
            }
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
        rmSync(backup, { recursive: true, force: true });
    }
}

/**
 * Full repair flow: chmod, verify, and only rebuild if a working PTY still can't
 * be opened.
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.log] Progress sink (default: silent).
 * @param {(line: string) => void} [options.warn] Warning sink (default: same as log).
 * @param {boolean} [options.allowRebuild] Permit a from-source rebuild (default: true).
 * @returns {Promise<{ ok: boolean, repaired: string[], rebuilt: boolean, reason?: string }>}
 */
export async function fixNodePty(options = {}) {
    const log = options.log ?? (() => {});
    const warn = options.warn ?? log;
    const allowRebuild = options.allowRebuild ?? true;

    const ptyDir = findNodePtyDir();
    if (!ptyDir) {
        return { ok: false, repaired: [], rebuilt: false, reason: 'node-pty is not installed' };
    }

    const { repaired, failed } = repairSpawnHelpers(ptyDir);
    for (const f of failed) warn(`could not chmod ${f.path}: ${f.error}`);
    if (repaired.length > 0) {
        log(`made node-pty spawn-helper executable (${repaired.length} file${repaired.length === 1 ? '' : 's'})`);
    }

    const first = verifyPtySpawn(ptyDir);
    if (first.ok) return { ok: true, repaired, rebuilt: false };

    if (!allowRebuild || !first.nativeFailure) {
        return { ok: false, repaired, rebuilt: false, reason: first.error };
    }

    warn(`node-pty could not open a PTY (${first.error}), rebuilding from source...`);
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const rebuild = rebuildFromSource(ptyDir, projectRoot);
    if (!rebuild.ok) {
        return { ok: false, repaired, rebuilt: false, reason: `rebuild failed: ${rebuild.error}` };
    }

    const after = repairSpawnHelpers(ptyDir);
    repaired.push(...after.repaired);

    const second = verifyPtySpawn(ptyDir);
    return second.ok
        ? { ok: true, repaired, rebuilt: true }
        : { ok: false, repaired, rebuilt: true, reason: second.error };
}

// ---------------------------------------------------------------------------
// CLI: node scripts/fix-node-pty.mjs [--quiet]
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
    const quiet = process.argv.includes('--quiet');
    const say = (line) => {
        if (!quiet) console.log(line);
    };

    const result = await fixNodePty({ log: say, warn: (line) => console.warn(line) });

    if (result.ok) {
        say(result.repaired.length > 0 || result.rebuilt ? 'node-pty repaired, PTY spawning works' : 'node-pty is healthy');
        process.exit(0);
    }

    console.error(`node-pty is not usable: ${result.reason}`);
    console.error('Try:  cd node_modules/node-pty && npx node-gyp rebuild');
    process.exit(1);
}
