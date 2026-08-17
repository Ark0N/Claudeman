/**
 * @fileoverview Unit tests for the TUI's IO layer: discovery, credentials, the
 * typed API surface and degraded-mode tmux enumeration.
 *
 * The API calls run against a real loopback HTTP server that answers in the
 * shapes the routes really produce (the `{success,data}` envelope, plus
 * away-digest's legacy top-level `digest`), so an envelope change breaks these
 * tests rather than the dashboard. tmux is never executed: the exec function is
 * injected, and `test/setup.ts` gives this file its own HOME, so the state file
 * it reads is a fixture of its own making.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../../src/config/instance.js';
import {
  TuiApiError,
  TuiClient,
  basicAuthHeader,
  enumerateTmuxSessions,
  parseEnvFile,
  parseTmuxSessionList,
  readCodemanCredentials,
  tuiServerCandidates,
  type TuiExecFile,
} from '../../src/tui/tui-client.js';

const PORT = 3241;
/** Nothing ever listens here: the "no server" path. */
const DEAD_PORT = 3243;
const BASE_URL = `http://127.0.0.1:${PORT}`;

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const recorded: Recorded[] = [];
type Responder = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** Per-test override; falls back to `defaultResponder`. */
let responder: Responder | null = null;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const defaultResponder: Responder = (req, res) => {
  const url = req.url ?? '';
  if (url.startsWith('/api/status')) {
    return sendJson(res, 200, {
      success: true,
      data: { version: '9.9.9', planUsage: { fiveHour: { usedPercentage: 32, resetAt: 1000 } } },
    });
  }
  if (url.startsWith('/api/sessions/unified')) {
    return sendJson(res, 200, {
      success: true,
      data: { sessions: [{ sessionId: 'abc', name: 'w1-codeman', sources: ['live'] }], total: 1 },
    });
  }
  if (url === '/api/sessions' || url.startsWith('/api/sessions?')) {
    // The light state, plus the two rows the narrowing has to discard.
    return sendJson(res, 200, {
      success: true,
      data: [
        { id: 'abc', lastSubmitAt: 4000, inputTokens: 900, outputTokens: 100, status: 'busy' },
        { id: '', lastSubmitAt: 7000 },
        { id: 'zzz', lastSubmitAt: '5', inputTokens: null },
      ],
    });
  }
  if (url.startsWith('/api/approvals')) {
    return sendJson(res, 200, {
      success: true,
      data: { approvals: [{ id: 'abc:1', sessionId: 'abc', sessionName: 'w1', kind: 'permission', createdAt: 5 }] },
    });
  }
  if (url.includes('/terminal')) {
    return sendJson(res, 200, { success: true, data: { terminalBuffer: 'tail bytes', status: 'idle' } });
  }
  if (url.endsWith('/input')) {
    return sendJson(res, 200, { success: true, data: {} });
  }
  if (url.startsWith('/api/quick-start')) {
    return sendJson(res, 200, { success: true, data: { sessionId: 'new-1', casePath: '/cases/x', caseName: 'x' } });
  }
  if (url.startsWith('/api/cases')) {
    return sendJson(res, 200, { success: true, data: [{ name: 'x', path: '/cases/x', location: 'local' }] });
  }
  if (url.startsWith('/api/search')) {
    return sendJson(res, 200, {
      success: true,
      data: { query: 'foo', groups: [], totalResults: 0, truncated: false },
    });
  }
  if (url.startsWith('/api/away-digest')) {
    // Legacy shape: the payload sits at the TOP level, not under `data`.
    return sendJson(res, 200, { success: true, digest: { totals: { activeSessions: 2 } } });
  }
  if (req.method === 'DELETE') {
    return sendJson(res, 200, { success: true, data: {} });
  }
  return sendJson(res, 404, { success: false, error: 'no route', errorCode: 'NOT_FOUND' });
};

function client(overrides: Record<string, unknown> = {}): TuiClient {
  return new TuiClient({ baseUrl: BASE_URL, timeoutMs: 4000, ...overrides });
}

let server: http.Server;
const originalApiUrl = process.env.CODEMAN_API_URL;
const originalPort = process.env.CODEMAN_PORT;

beforeAll(async () => {
  // This suite runs inside a Codeman-managed session, which exports
  // CODEMAN_API_URL pointing at the LIVE server. Discovery consults it, so it
  // has to be out of the way before any test calls connect().
  delete process.env.CODEMAN_API_URL;
  delete process.env.CODEMAN_PORT;

  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      (responder ?? defaultResponder)(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalApiUrl !== undefined) process.env.CODEMAN_API_URL = originalApiUrl;
  if (originalPort !== undefined) process.env.CODEMAN_PORT = originalPort;
});

beforeEach(() => {
  recorded.length = 0;
  responder = null;
});

describe('parseEnvFile', () => {
  it('reads plain assignments and skips comments and blanks', () => {
    expect(parseEnvFile('# comment\n\nCODEMAN_USERNAME=bob\nCODEMAN_PASSWORD=hunter2\n')).toEqual({
      CODEMAN_USERNAME: 'bob',
      CODEMAN_PASSWORD: 'hunter2',
    });
  });

  it('strips one layer of matching quotes', () => {
    expect(parseEnvFile('A="quoted"\nB=\'single\'\nC="mismatched\'')).toEqual({
      A: 'quoted',
      B: 'single',
      C: '"mismatched\'',
    });
  });

  it('ignores lines that are not assignments', () => {
    expect(parseEnvFile('not an assignment\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });
});

describe('readCodemanCredentials', () => {
  it('falls back to the data dir .env when the environment has nothing', () => {
    const envPath = dataPath('.env');
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, 'CODEMAN_USERNAME=fileuser\nCODEMAN_PASSWORD=filepass\n', 'utf-8');
    expect(readCodemanCredentials()).toEqual({ username: 'fileuser', password: 'filepass' });
  });

  it('lets the environment win over the file', () => {
    const envPath = dataPath('.env');
    writeFileSync(envPath, 'CODEMAN_USERNAME=fileuser\nCODEMAN_PASSWORD=filepass\n', 'utf-8');
    process.env.CODEMAN_PASSWORD = 'envpass';
    try {
      expect(readCodemanCredentials()).toEqual({ username: 'fileuser', password: 'envpass' });
    } finally {
      delete process.env.CODEMAN_PASSWORD;
    }
  });

  it('reports admin with no password when nothing is configured', () => {
    expect(readCodemanCredentials('/nonexistent/codeman/.env')).toEqual({ username: 'admin' });
  });
});

describe('basicAuthHeader', () => {
  it('is absent without a password and base64 with one', () => {
    expect(basicAuthHeader({ username: 'admin' })).toBeUndefined();
    expect(basicAuthHeader({ username: 'admin', password: 's3cret' })).toBe(
      `Basic ${Buffer.from('admin:s3cret').toString('base64')}`
    );
  });
});

describe('tuiServerCandidates', () => {
  it('prefers an explicit API url and trims its trailing slash', () => {
    expect(tuiServerCandidates({ apiUrl: 'https://box:8443/' })).toEqual(['https://box:8443']);
  });

  it('probes both schemes on loopback, https first', () => {
    expect(tuiServerCandidates({ port: 5000 })).toEqual(['https://127.0.0.1:5000', 'http://127.0.0.1:5000']);
  });

  it('falls back to port 3000 for junk', () => {
    expect(tuiServerCandidates({ port: 'not-a-port' })).toEqual(['https://127.0.0.1:3000', 'http://127.0.0.1:3000']);
  });
});

describe('TuiClient envelope handling', () => {
  it('unwraps the sessions list', async () => {
    const sessions = await client().fetchUnifiedSessions(10);
    expect(sessions).toEqual([{ sessionId: 'abc', name: 'w1-codeman', sources: ['live'] }]);
    expect(recorded[0].url).toBe('/api/sessions/unified?limit=10');
  });

  it('unwraps pending approvals', async () => {
    const approvals = await client().fetchApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe('abc:1');
  });

  it('turns a success:false envelope into a typed error carrying the code', async () => {
    responder = (_req, res) =>
      sendJson(res, 404, { success: false, error: 'Session not found', errorCode: 'NOT_FOUND' });
    await expect(client().fetchTerminalTail('gone', 1000)).rejects.toMatchObject({
      name: 'TuiApiError',
      status: 404,
      errorCode: 'NOT_FOUND',
      message: 'Session not found',
    });
  });

  it('turns a non-JSON failure into a typed error too', async () => {
    responder = (_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('bad gateway');
    };
    const err = await client()
      .fetchApprovals()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TuiApiError);
    expect((err as TuiApiError).status).toBe(502);
  });

  it('sends Basic auth when a password is configured, and none when it is not', async () => {
    await client({ username: 'admin', password: 's3cret' }).fetchApprovals();
    expect(recorded[0].headers.authorization).toBe(`Basic ${Buffer.from('admin:s3cret').toString('base64')}`);

    recorded.length = 0;
    await client({ envFilePath: '/nonexistent/codeman/.env' }).fetchApprovals();
    expect(recorded[0].headers.authorization).toBeUndefined();
  });
});

describe('TuiClient.answerApproval', () => {
  it('reports success', async () => {
    responder = (_req, res) =>
      sendJson(res, 200, { success: true, data: { id: 'abc:1', sessionId: 'abc', action: 'approve' } });
    await expect(client().answerApproval('abc:1', { action: 'approve' })).resolves.toEqual({
      ok: true,
      id: 'abc:1',
      sessionId: 'abc',
      action: 'approve',
    });
  });

  it('reports a 409 as a typed "gone" result, not an exception', async () => {
    responder = (_req, res) =>
      sendJson(res, 409, { success: false, error: 'The dialog is no longer on screen', errorCode: 'CONFLICT' });
    const result = await client().answerApproval('abc:1', { action: 'option', option: 2 });
    expect(result).toEqual({ ok: false, reason: 'gone', message: 'The dialog is no longer on screen' });
  });

  it('separates "already resolved" from "digit rejected"', async () => {
    responder = (_req, res) => sendJson(res, 404, { success: false, error: 'gone', errorCode: 'NOT_FOUND' });
    expect((await client().answerApproval('x', { action: 'deny' })).ok).toBe(false);
    expect(await client().answerApproval('x', { action: 'deny' })).toMatchObject({ reason: 'not-found' });

    responder = (_req, res) => sendJson(res, 400, { success: false, error: 'bad option', errorCode: 'INVALID_INPUT' });
    expect(await client().answerApproval('x', { action: 'option', option: 9 })).toMatchObject({ reason: 'rejected' });
  });

  it('posts the answer body verbatim', async () => {
    responder = (_req, res) => sendJson(res, 200, { success: true, data: { id: 'a', sessionId: 'b', action: 'text' } });
    await client().answerApproval('a b/c', { action: 'text', text: 'yes please' });
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].url).toBe('/api/approvals/a%20b%2Fc/answer');
    expect(JSON.parse(recorded[0].body)).toEqual({ action: 'text', text: 'yes please' });
  });
});

describe('TuiClient.sendInput', () => {
  it('always terminates with a carriage return and never sends a bare newline', async () => {
    await client().sendInput('abc', 'hello world');
    expect(JSON.parse(recorded[0].body)).toMatchObject({ input: 'hello world\r', useMux: true });
  });

  it('collapses embedded newlines into spaces (multi-line breaks Ink)', async () => {
    await client().sendInput('abc', 'echo A\necho B\r\nline three  ');
    expect(JSON.parse(recorded[0].body).input).toBe('echo A echo B line three\r');
  });

  it('tags every send with a stable clientId and a monotonic seq', async () => {
    const c = client();
    await c.sendInput('abc', 'one');
    await c.sendInput('abc', 'two');
    await c.sendInput('def', 'three');
    const bodies = recorded.map((entry) => JSON.parse(entry.body) as { clientId: string; seq: number });
    expect(bodies.map((b) => b.seq)).toEqual([1, 2, 3]);
    expect(new Set(bodies.map((b) => b.clientId)).size).toBe(1);
    expect(bodies[0].clientId).toMatch(/^codeman-tui-\d+$/);
    expect(c.lastInputSeq).toBe(3);
  });
});

describe('TuiClient remaining API surface', () => {
  it('fetches a terminal tail by byte count', async () => {
    await expect(client().fetchTerminalTail('abc', 4096)).resolves.toBe('tail bytes');
    expect(recorded[0].url).toBe('/api/sessions/abc/terminal?tail=4096');
  });

  it('reads the turn stamp and token counters off the light session state', async () => {
    const metrics = await client().fetchLiveSessionMetrics();
    expect(recorded[0].url).toBe('/api/sessions');
    // Narrowed to the three fields, keyed by id: a row with no usable id is
    // dropped rather than folded in under an empty key, and a field of the
    // wrong type is left absent rather than merged as a string.
    expect(metrics).toEqual([
      { sessionId: 'abc', lastSubmitAt: 4000, inputTokens: 900, outputTokens: 100 },
      { sessionId: 'zzz' },
    ]);
  });

  it('reports an unreadable session list as empty rather than throwing', async () => {
    responder = (_req, res) => sendJson(res, 200, { success: true, data: { sessions: 'not an array' } });
    await expect(client().fetchLiveSessionMetrics()).resolves.toEqual([]);
  });

  it('starts sessions through quick-start', async () => {
    const result = await client().quickStart({ caseName: 'x', mode: 'claude', parentSessionId: 'abc' });
    expect(result.sessionId).toBe('new-1');
    expect(recorded[0].url).toBe('/api/quick-start');
    expect(JSON.parse(recorded[0].body)).toEqual({ caseName: 'x', mode: 'claude', parentSessionId: 'abc' });
  });

  it('lists cases', async () => {
    await expect(client().fetchCases()).resolves.toEqual([{ name: 'x', path: '/cases/x', location: 'local' }]);
  });

  it('deletes a session by exact id', async () => {
    await client().deleteSession('abc');
    expect(recorded[0].method).toBe('DELETE');
    expect(recorded[0].url).toBe('/api/sessions/abc');
  });

  it('searches with an encoded query', async () => {
    await client().search('a b', 5);
    expect(recorded[0].url).toBe('/api/search?q=a+b&limit=5');
  });

  it('reads the away digest from its legacy top-level shape', async () => {
    await expect(client().fetchAwayDigest('24h')).resolves.toEqual({ totals: { activeSessions: 2 } });
    expect(recorded[0].url).toBe('/api/away-digest?range=24h');
  });

  it('reads plan usage off the status snapshot', async () => {
    await expect(client().fetchPlanUsage()).resolves.toEqual({ fiveHour: { usedPercentage: 32, resetAt: 1000 } });
  });

  it('reports a missing plan-usage snapshot as null rather than throwing', async () => {
    responder = (_req, res) => sendJson(res, 200, { success: true, data: { version: '1.0.0', planUsage: null } });
    await expect(client().fetchPlanUsage()).resolves.toBeNull();
  });
});

describe('TuiClient.connect', () => {
  it('discovers the loopback server and reports its identity', async () => {
    const info = await new TuiClient({ port: PORT, probeTimeoutMs: 1000 }).connect();
    expect(info?.baseUrl).toBe(BASE_URL);
    expect(info?.version).toBe('9.9.9');
    expect(info?.hostname).toBeTruthy();
    expect(info?.authRequired).toBeUndefined();
  });

  it('reports a server that rejects our credentials instead of calling it down', async () => {
    responder = (_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="codeman"' });
      res.end('Unauthorized');
    };
    const info = await new TuiClient({ port: PORT, probeTimeoutMs: 1000 }).connect();
    expect(info?.baseUrl).toBe(BASE_URL);
    expect(info?.authRequired).toBe(true);
  });

  it('returns null when nothing answers', async () => {
    await expect(new TuiClient({ port: DEAD_PORT, probeTimeoutMs: 500 }).connect()).resolves.toBeNull();
  });

  it('refuses to talk to an unconnected client', async () => {
    await expect(new TuiClient({ port: DEAD_PORT }).fetchApprovals()).rejects.toThrow(/not connected/);
  });
});

describe('degraded-mode tmux enumeration', () => {
  const listing = [
    'codeman-1a2b3c4d\t1\t1700000000\t1',
    'codeman-deadbeef\t0\t1700000100\t2',
    'claudeman-cafe0001\t0\t1700000200\t1',
    'my-own-tmux-session\t1\t1700000300\t1',
    'codeman-ssh-abc\t0\t1700000400\t1',
  ].join('\n');

  it('parses the list format and keeps only Codeman-owned names', () => {
    const rows = parseTmuxSessionList(listing);
    expect(rows.map((row) => row.muxName)).toEqual(['codeman-1a2b3c4d', 'codeman-deadbeef', 'claudeman-cafe0001']);
    expect(rows[0]).toMatchObject({ sessionIdPrefix: '1a2b3c4d', attached: true, createdAt: 1_700_000_000_000 });
    expect(rows[1]).toMatchObject({ attached: false, windows: 2 });
  });

  it('never shells out: the tmux call is an argv array on the instance socket', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: TuiExecFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: listing, stderr: '' };
    };
    await enumerateTmuxSessions({ exec, socket: 'codeman-beta', statePath: '/nonexistent/state.json' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('tmux');
    expect(calls[0].args.slice(0, 4)).toEqual(['-L', 'codeman-beta', 'list-sessions', '-F']);
  });

  it('decorates rows with names and dirs from state.json, matching on the id prefix', async () => {
    const statePath = dataPath('state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        sessions: {
          '1a2b3c4d-1111-2222-3333-444444444444': {
            name: 'w1-codeman',
            workingDir: '/home/dev/codeman',
            mode: 'claude',
          },
        },
      }),
      'utf-8'
    );
    const exec: TuiExecFile = async () => ({ stdout: listing, stderr: '' });
    const rows = await enumerateTmuxSessions({ exec, statePath });
    expect(rows[0]).toMatchObject({
      sessionId: '1a2b3c4d-1111-2222-3333-444444444444',
      name: 'w1-codeman',
      workingDir: '/home/dev/codeman',
      mode: 'claude',
    });
    // No state entry: the row still exists, it just has no decoration.
    expect(rows[1].sessionId).toBeUndefined();
    expect(rows[1].name).toBeUndefined();
  });

  it('refuses to guess when two ids share a prefix', async () => {
    const statePath = dataPath('ambiguous-state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        sessions: {
          '1a2b3c4d-aaaa': { name: 'first' },
          '1a2b3c4d-bbbb': { name: 'second' },
        },
      }),
      'utf-8'
    );
    const exec: TuiExecFile = async () => ({ stdout: 'codeman-1a2b3c4d\t0\t1700000000\t1', stderr: '' });
    const rows = await enumerateTmuxSessions({ exec, statePath });
    expect(rows[0].name).toBeUndefined();
  });

  it('treats a dead tmux server as an empty list', async () => {
    const exec: TuiExecFile = async () => {
      throw new Error('no server running on /tmp/tmux-1000/codeman');
    };
    await expect(enumerateTmuxSessions({ exec })).resolves.toEqual([]);
  });
});
