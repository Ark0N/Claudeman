#!/usr/bin/env node
/**
 * @fileoverview Records real codex TUI output into JSONL fixtures for the
 * predictive-echo replay tests (packages/xterm-zerolag-input/test/codex-replay.test.ts).
 *
 * The pipeline reproduces production byte-for-byte: codex runs inside tmux
 * (status off, like tmux-manager.ts sessions) driven through a node-pty client,
 * and every chunk passes through the SAME full strip session.ts applies to
 * codex-mode output (alt-screen toggles, \x1b[3J, mouse DECSETs, with the
 * split-sequence carry). What lands in the fixture is what xterm.js receives.
 *
 * Fixture format: line 1 is a meta object {scenario, cols, rows, codexVersion,
 * recordedAt}; every following line is {delayMs, data} where delayMs is the gap
 * since the previous chunk and data is the stripped chunk. Keystroke injection
 * points are recorded as {keyAt: true, data} lines so the replay knows where
 * predictChar() calls belong.
 *
 * Usage: node scripts/dev/record-codex-frames.mjs <scenario|all> [--out <dir>]
 * Scenarios: type-hello, slash-picker, wrap, streaming-burst, paste-bracketed
 *
 * The CODEX_HOME is a throwaway temp dir with a fake auth.json; the fake key is
 * asserted absent from every recorded byte before the fixture is written.
 */
import pty from 'node-pty';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_KEY = 'sk-test-123';
const COLS = 100;
const ROWS = 30;
const BOOT_WAIT_MS = 4500;
// NOT under /tmp: codex prints a "Refusing to create helper binaries under
// temporary dir" warning that embeds the CODEX_HOME path when it lives in /tmp.
// The repo's gitignored tmp/ avoids both the warning and the path leak.
const SCRATCH = join(ROOT, 'tmp');

// Mirror of the codex-mode FULL strip in session.ts _handleTerminalOutput().
function makeStripper() {
  let carry = '';
  return (data) => {
    data = carry + data;
    carry = '';
    const splitTail = data.match(/\x1b(?:\[\??[0-9]{0,4})?$/);
    if (splitTail) {
      carry = splitTail[0];
      data = data.slice(0, -splitTail[0].length);
    }
    return data
      .replace(/\x1b\[\?(?:47|1047|1049)[hl]/g, '')
      .replace(/\x1b\[3J/g, '')
      .replace(/\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g, '');
  };
}

// Each step: wait `waitMs` after the previous step, then write `keys` to the pty.
const SCENARIOS = {
  'type-hello': [
    ...'hello'.split('').map((ch, i) => ({ waitMs: i === 0 ? BOOT_WAIT_MS : 90, keys: ch })),
    { waitMs: 1500, keys: '' },
  ],
  'slash-picker': [
    { waitMs: BOOT_WAIT_MS, keys: '/' },
    { waitMs: 400, keys: 'm' },
    { waitMs: 150, keys: 'o' },
    { waitMs: 1200, keys: '\x1b' },
    { waitMs: 500, keys: '' },
  ],
  wrap: [
    { waitMs: BOOT_WAIT_MS, keys: '' },
    ...'the quick brown fox jumps over the lazy dog and keeps running until the composer box has to wrap this line twice over'
      .split('')
      .map((ch) => ({ waitMs: 25, keys: ch })),
    { waitMs: 1500, keys: '' },
  ],
  'streaming-burst': [
    ...'hello'.split('').map((ch, i) => ({ waitMs: i === 0 ? BOOT_WAIT_MS : 40, keys: ch })),
    { waitMs: 300, keys: '\r' },
    { waitMs: 5000, keys: '' },
  ],
  'paste-bracketed': [
    { waitMs: BOOT_WAIT_MS, keys: 'a' },
    { waitMs: 90, keys: 'b' },
    { waitMs: 400, keys: '\x1b[200~XYZpasted\x1b[201~' },
    { waitMs: 1500, keys: '' },
  ],
  // REAL-AUTH streaming (CODEX_RECORD_REAL=1 only): a genuine model response
  // streaming above the pinned composer while keystrokes land mid-stream.
  // This is the one shape the fake-key lab can never produce: real output
  // pushes lines to history (baseY grows), exercising the no-drop-on-baseY
  // rule against reality. Uses the user's real ~/.codex; the fixture is
  // secret-scanned (sk- / JWT prefixes) before it is written.
  'streaming-real': {
    realAuth: true,
    steps: [
      { waitMs: BOOT_WAIT_MS, keys: '\r' }, // trust dialog (untrusted workdir)
      { waitMs: 2500, keys: '' },
      ...'reply with the single word hello'.split('').map((ch) => ({ waitMs: 15, keys: ch })),
      { waitMs: 400, keys: '\r' },
      { waitMs: 4000, keys: 'a' }, // typed MID-STREAM
      { waitMs: 120, keys: 'b' },
      { waitMs: 120, keys: 'c' },
      { waitMs: 14000, keys: '' },
    ],
  },
  // First-run trust dialog: the modal surface where typed chars must NOT be
  // predicted (the predictWhen ghost eliminator). Recorded UNTRUSTED so the
  // dialog actually appears; 'x' exercises typing at a non-composer cursor.
  'trust-modal': {
    trusted: false,
    steps: [
      { waitMs: BOOT_WAIT_MS, keys: 'x' },
      { waitMs: 800, keys: '\r' },
      { waitMs: 2500, keys: '' },
    ],
  },
};

async function record(scenario, outDir) {
  const spec = SCENARIOS[scenario];
  if (!spec) throw new Error(`unknown scenario ${scenario}`);
  const steps = Array.isArray(spec) ? spec : spec.steps;
  const trusted = Array.isArray(spec) ? true : (spec.trusted ?? true);
  const realAuth = Array.isArray(spec) ? false : (spec.realAuth ?? false);
  if (realAuth && process.env.CODEX_RECORD_REAL !== '1') {
    console.log(`${scenario}: SKIPPED (needs CODEX_RECORD_REAL=1 and a real ~/.codex login)`);
    return;
  }

  mkdirSync(SCRATCH, { recursive: true });
  const lab = mkdtempSync(join(SCRATCH, 'codexrec-'));
  const workdir = mkdtempSync(join(SCRATCH, 'codexrec-work-'));
  if (!realAuth) {
    writeFileSync(join(lab, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: FAKE_KEY }));
    if (trusted) {
      // Pre-trust the workdir so boot goes straight to the composer instead of
      // the first-run trust dialog (which trust-modal records deliberately).
      writeFileSync(join(lab, 'config.toml'), `[projects."${workdir}"]\ntrust_level = "trusted"\n`);
    }
  }
  const sock = `codexrec-${process.pid}`;
  const codexVersion = execSync('codex --version', { encoding: 'utf8' }).trim();

  const lines = [];
  const strip = makeStripper();
  let lastChunkAt = null;
  let recording = true;
  const proc = pty.spawn(
    'tmux',
    ['-L', sock, '-f', '/dev/null', 'new-session', '-s', 'rec', ';', 'set', '-t', 'rec', 'status', 'off'],
    {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: workdir,
      env: realAuth ? { ...process.env, SHELL: '/bin/bash' } : { ...process.env, CODEX_HOME: lab, SHELL: '/bin/bash' },
    }
  );
  proc.onData((data) => {
    if (!recording) return; // teardown frames ([server exited]) stay out
    const now = performance.now();
    const stripped = strip(data);
    if (!stripped) return; // timing folds into the next chunk's delay
    lines.push({ delayMs: lastChunkAt === null ? 0 : Math.round(now - lastChunkAt), data: stripped });
    lastChunkAt = now;
  });

  // tmux session starts with a shell; launch codex in it so the strip pipeline
  // sees the same attach-then-launch order production uses.
  await sleep(700);
  proc.write(`exec codex\r`);

  for (const step of steps) {
    await sleep(step.waitMs);
    if (step.keys) {
      lines.push({ keyAt: true, data: step.keys });
      proc.write(step.keys);
    }
  }

  recording = false;
  try {
    execSync(`tmux -L ${sock} kill-server`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  proc.kill();
  await sleep(200);

  const allBytes = lines.map((l) => l.data).join('');
  if (allBytes.includes(FAKE_KEY)) throw new Error(`fixture ${scenario} leaked the fake key; NOT writing`);
  if (allBytes.includes(lab)) throw new Error(`fixture ${scenario} leaked the lab path; NOT writing`);
  if (realAuth && /sk-[A-Za-z0-9_-]{8}|eyJ[A-Za-z0-9_-]{20}/.test(allBytes))
    throw new Error(`fixture ${scenario} may contain credential material; NOT writing`);

  mkdirSync(outDir, { recursive: true });
  const meta = { scenario, cols: COLS, rows: ROWS, codexVersion, recordedAt: new Date().toISOString() };
  const out = join(outDir, `${scenario}.jsonl`);
  writeFileSync(out, [JSON.stringify(meta), ...lines.map((l) => JSON.stringify(l))].join('\n') + '\n');
  rmSync(lab, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
  console.log(`${scenario}: ${lines.length} lines -> ${out}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const arg = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outDir =
  outIdx !== -1 ? process.argv[outIdx + 1] : join(ROOT, 'packages', 'xterm-zerolag-input', 'test', 'fixtures', 'codex');
const wanted = arg === 'all' || !arg ? Object.keys(SCENARIOS) : [arg];
for (const s of wanted) {
  await record(s, outDir);
}
