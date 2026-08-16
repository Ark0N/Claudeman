/**
 * @fileoverview End-to-end test for `codeman tui` in a real terminal.
 *
 * The dashboard is spawned under node-pty against a fake API server, so this
 * covers everything the pure tests cannot: raw-mode key decoding, the frame
 * actually reaching a terminal, SSE-driven refresh, and the exit sequence that
 * has to restore the user's screen. Frames are addressed absolutely rather than
 * newline-separated, so the assertions parse the LAST frame out of the captured
 * bytes and read its list column.
 *
 * The child gets its own data dir and a tmux socket name nothing runs on, which
 * keeps the enumeration that degraded mode and the attach path use from seeing
 * the machine's real sessions. Nothing here attaches, kills or writes anything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as pty from 'node-pty';
import { computeLayout } from '../../src/tui/tui-layout.js';
import type { UnifiedSessionItem } from '../../src/services/unified-session-service.js';

const PORT = 3244;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(import.meta.dirname, '..', '..');
const COLS = 100;
const ROWS = 30;
const LIST_WIDTH = computeLayout(COLS, ROWS).list.width;

const NOW = Date.now();

/** Mutable so a test can add a session and announce it over SSE. */
let sessions: UnifiedSessionItem[] = [];

function resetSessions(): void {
  sessions = [
    {
      sessionId: 'bbbb2222-0000-0000-0000-000000000000',
      name: 'w2-beta',
      mode: 'claude',
      sources: ['live'],
      isWorking: true,
      workingDir: '/tmp/beta',
      createdAt: NOW - 600_000,
      lastActivityAt: NOW,
    },
    {
      sessionId: 'aaaa1111-0000-0000-0000-000000000000',
      name: 'w1-alpha',
      mode: 'claude',
      sources: ['live'],
      status: 'idle',
      workingDir: '/tmp/alpha',
      createdAt: NOW - 900_000,
      lastActivityAt: NOW - 60_000,
    },
    {
      sessionId: 'cccc3333-0000-0000-0000-000000000000',
      name: 'w3-gamma',
      sources: ['history'],
      workingDir: '/tmp/gamma',
      lastActivityAt: NOW - 3_600_000,
    },
  ];
}

let server: http.Server;
const sseClients = new Set<http.ServerResponse>();
let dataDir = '';

function sendJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function pushEvent(event: string, data: unknown): void {
  for (const client of sseClients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  // The suite runs inside a Codeman-managed tmux pane, whose environment would
  // otherwise point the child at the LIVE server and make it think it is nested.
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CODEMAN_SESSION_ID;
  delete env.FORCE_COLOR;
  delete env.CODEMAN_PORT;
  return {
    ...env,
    CODEMAN_API_URL: BASE_URL,
    CODEMAN_DATA_DIR: dataDir,
    CODEMAN_TMUX_SOCKET: 'codeman-tui-e2e',
    CODEMAN_TUI_GLYPHS: 'ascii',
    NO_COLOR: '1',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'codeman-tui-e2e-'));
  resetSessions();
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: init\ndata: ${JSON.stringify({ version: '9.9.9', planUsage: null })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.startsWith('/api/status')) return sendJson(res, { success: true, data: { version: '9.9.9' } });
    if (url.startsWith('/api/sessions/unified')) return sendJson(res, { success: true, data: { sessions } });
    if (url.startsWith('/api/approvals')) return sendJson(res, { success: true, data: { approvals: [] } });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'no route', errorCode: 'NOT_FOUND' }));
  });
  await new Promise<void>((done) => server.listen(PORT, '127.0.0.1', done));
});

afterAll(async () => {
  for (const client of sseClients) client.destroy();
  sseClients.clear();
  await new Promise<void>((done) => server.close(() => done()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frame parsing
// ─────────────────────────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;

/**
 * The last COMPLETE frame, one entry per terminal row. Frames start at
 * `ESC [ 1;1 H` and address every row absolutely, so splitting on the
 * addressing sequences reconstructs the lines. The pty delivers a frame in
 * several chunks, so the newest one is often half-written: taking it would make
 * every assertion that indexes a line racy.
 */
function frameLines(raw: string): string[] {
  const frames = raw.split('\u001b[1;1H').slice(1);
  for (let i = frames.length - 1; i >= 0; i--) {
    const lines = frames[i].split(/\u001b\[\d+;1H/).map((line) => line.replace(ANSI, '').replace(/\s+$/, ''));
    if (lines.length >= ROWS) return lines.slice(0, ROWS);
  }
  return [];
}

/** Just the sidebar column, so a name in the preview pane cannot answer for a row. */
function listLines(raw: string): string[] {
  return frameLines(raw).map((line) => line.slice(0, LIST_WIDTH).replace(/\s+$/, ''));
}

function rowFor(raw: string, name: string): string {
  return listLines(raw).find((line) => line.includes(name)) ?? '';
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard
// ─────────────────────────────────────────────────────────────────────────────

describe('codeman tui (under a pty)', () => {
  let term: pty.IPty;
  let output = '';
  let exitCode: number | null = null;

  beforeAll(async () => {
    term = pty.spawn('npx', ['tsx', 'src/index.ts', 'tui'], {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: ROOT,
      env: childEnv(),
    });
    term.onData((data) => {
      output += data;
    });
    term.onExit(({ exitCode: code }) => {
      exitCode = code;
    });
    await waitFor(() => output.includes('w2-beta'), 'the first frame', 25_000);
  }, 40_000);

  afterAll(() => {
    if (exitCode === null) term.kill();
  });

  it('enters the alternate screen and hides the cursor', () => {
    expect(output).toContain('\u001b[?1049h');
    expect(output).toContain('\u001b[?25l');
  });

  it('groups the sessions the way the dashboard promises', () => {
    const lines = listLines(output);
    const index = (needle: string) => lines.findIndex((line) => line.includes(needle));
    expect(index('WORKING')).toBeGreaterThan(0);
    expect(index('WORKING')).toBeLessThan(index('w2-beta'));
    expect(index('w2-beta')).toBeLessThan(index('IDLE'));
    expect(index('IDLE')).toBeLessThan(index('w1-alpha'));
    expect(index('w1-alpha')).toBeLessThan(index('RECENT'));
    expect(index('RECENT')).toBeLessThan(index('w3-gamma'));
  });

  it('shows the header facts and only the keys that work', () => {
    const lines = frameLines(output);
    expect(lines[0]).toContain('codeman');
    expect(lines[0]).toContain('v9.9.9');
    // Two live rows; the history row is not a session you have open.
    expect(lines[0]).toContain('2 sessions');
    const footer = lines[ROWS - 1];
    expect(footer).toContain('attach');
    expect(footer).toContain('x kill');
    expect(footer).not.toContain('search');
  });

  it('holds the preview seam open instead of pretending to load one', () => {
    expect(frameLines(output).join('\n')).toContain('live preview is not wired up yet');
  });

  it('starts with the first row selected and moves the cursor with j / k', async () => {
    expect(rowFor(output, 'w2-beta').startsWith('>')).toBe(true);

    term.write('j');
    await waitFor(() => rowFor(output, 'w1-alpha').startsWith('>'), 'j to select the next row');
    expect(rowFor(output, 'w2-beta').startsWith('>')).toBe(false);

    term.write('k');
    await waitFor(() => rowFor(output, 'w2-beta').startsWith('>'), 'k to select the previous row');
  });

  it('moves the cursor with the arrow keys', async () => {
    term.write('\u001b[B');
    await waitFor(() => rowFor(output, 'w1-alpha').startsWith('>'), 'the down arrow to move the cursor');
    term.write('\u001b[A');
    await waitFor(() => rowFor(output, 'w2-beta').startsWith('>'), 'the up arrow to move the cursor');
  });

  it('picks up a session announced over SSE', async () => {
    sessions = [
      ...sessions,
      {
        sessionId: 'dddd4444-0000-0000-0000-000000000000',
        name: 'w4-delta',
        mode: 'shell',
        sources: ['live'],
        status: 'idle',
        workingDir: '/tmp/delta',
        createdAt: NOW,
        lastActivityAt: NOW,
      },
    ];
    pushEvent('session:created', { id: 'dddd4444-0000-0000-0000-000000000000' });
    await waitFor(() => listLines(output).some((line) => line.includes('w4-delta')), 'the new session to appear');
    expect(frameLines(output)[0]).toContain('3 sessions');
  });

  it('opens and closes the help overlay', async () => {
    term.write('?');
    await waitFor(() => frameLines(output).some((line) => line.includes('Keys')), 'the help overlay');
    expect(frameLines(output).join('\n')).toContain('kill (typed confirmation)');

    term.write('\u001b');
    await waitFor(() => !frameLines(output).some((line) => line.includes('Keys')), 'escape to close the overlay');
  });

  it('asks for the session name before killing anything', async () => {
    term.write('x');
    await waitFor(() => frameLines(output).some((line) => line.includes('Kill session')), 'the kill confirmation');
    const overlay = frameLines(output).join('\n');
    expect(overlay).toContain('Type the name to confirm');
    expect(overlay).toContain('w2-beta');

    term.write('\u001b');
    await waitFor(() => !frameLines(output).some((line) => line.includes('Kill session')), 'escape to cancel the kill');
  });

  it('quits on q and restores the screen it took over', async () => {
    term.write('q');
    await waitFor(() => exitCode !== null, 'the TUI to exit', 10_000);
    expect(exitCode).toBe(0);
    expect(output).toContain('\u001b[?25h');
    expect(output).toContain('\u001b[?1049l');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The non-interactive fast paths
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with pipes, which is exactly the "not a TTY" case. */
function runPiped(args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', 'src/index.ts', ...args], { cwd: ROOT, env: childEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('codeman tui --list', () => {
  it('prints the numbered list and exits 0 when piped', async () => {
    const result = await runPiped(['tui', '--list']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('w2-beta');
    expect(result.stdout).toContain('w1-alpha');
    expect(result.stdout).toContain('/tmp/alpha');
    // Same ordering as the dashboard: WORKING first, history last.
    expect(result.stdout.indexOf('w2-beta')).toBeLessThan(result.stdout.indexOf('w1-alpha'));
    expect(result.stdout.indexOf('w1-alpha')).toBeLessThan(result.stdout.indexOf('w3-gamma'));
    expect(result.stdout).toMatch(/^\s+1\s+working\s+w2-beta/m);
  }, 30_000);
});

describe('codeman tui without a terminal', () => {
  it('refuses to open the dashboard and points at the fast paths', async () => {
    const result = await runPiped(['tui']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive terminal');
    expect(result.stderr).toContain('--list');
    expect(result.stdout).not.toContain('\u001b[?1049h');
  }, 30_000);
});
