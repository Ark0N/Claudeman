/**
 * @fileoverview Tests for the Codex branch of GET /api/sessions/:id/last-response (PR #152).
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Fixture rollouts live in a per-test temp CODEX_HOME (the route resolves
 * `process.env.CODEX_HOME || ~/.codex` at request time), exercising the real
 * locator/parser code paths against real files:
 *   - originator match beats the cwd+mtime fallback when two panes share a dir
 *   - resume-uuid filename match (resumed rollouts keep foreign session_meta)
 *   - history.jsonl pin outranks the originator match
 *   - event_msg vs legacy response_item user-turn dedup keeps old-codex turns
 *   - injected-context rows (AGENTS.md, environment_context, …) are filtered
 *   - response envelope shape; Claude-mode behavior unchanged (regression guard)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, createMockSession, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Mirror of the production uniform-envelope hook (server.ts) — same local
 * harness idiom as session-routes.test.ts, so assertions match the wire format.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

// ── Rollout fixture helpers (shapes observed on codex-cli 0.144) ──────────────

const sessionMeta = (cwd: string, originator?: string) => ({
  type: 'session_meta',
  payload: { cwd, originator },
});

const assistantMsg = (text: string, timestamp = '2026-07-01T00:00:00Z') => ({
  timestamp,
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

const legacyUserMsg = (text: string, timestamp = '2026-07-01T00:00:00Z') => ({
  timestamp,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

const eventUserMsg = (message: string, timestamp = '2026-07-01T00:00:00Z') => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'user_message', message },
});

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Fixed epoch (seconds) for deterministic mtime ordering.
const BASE_MTIME = 1_750_000_000;

describe('GET /api/sessions/:id/last-response (codex)', () => {
  let harness: LocalHarness;
  let codexHome: string;
  let prevCodexHome: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any; // MockSession, loosened for codex-only fields (codexConfig, codexLastSubmitAt)
  let workdir: string;

  /** Write a rollout under CODEX_HOME/sessions/<date>/ with a controlled mtime. */
  function writeRollout(name: string, entries: unknown[], mtimeSec: number): string {
    const dir = join(codexHome, 'sessions', '2026', '07', '01');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, name);
    let content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    // The locator skips files under 100 bytes (blank padding lines are ignored by the parser).
    while (content.length < 100) content += '\n';
    writeFileSync(filePath, content);
    utimesSync(filePath, mtimeSec, mtimeSec);
    return filePath;
  }

  function writeHistory(entries: Array<{ session_id: string; ts: number }>): void {
    writeFileSync(join(codexHome, 'history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  async function getLastResponse(id: string, full = false) {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/last-response${full ? '?context=full' : ''}`,
    });
    return { res, body: JSON.parse(res.body) };
  }

  beforeEach(async () => {
    codexHome = mkdtempSync(join(tmpdir(), 'codeman-codex-rv-'));
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    harness = await createEnvelopeHarness(registerSessionRoutes);
    session = harness.ctx._session;
    session.mode = 'codex';
    workdir = join(codexHome, 'workdir');
    session.workingDir = workdir;
  });

  afterEach(async () => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
    await harness.app.close();
  });

  // ── Locator: originator vs cwd fallback ─────────────────────────────────

  it('originator match beats the cwd+mtime fallback when two panes share a dir', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paneB: any = createMockSession('codex-b');
    paneB.mode = 'codex';
    paneB.workingDir = workdir;
    harness.ctx.sessions.set('codex-b', paneB);

    // Pane B's rollout is NEWER — the naive cwd+mtime heuristic would show it for pane A.
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [sessionMeta(workdir, `codeman_${session.id}`), assistantMsg('answer A')],
      BASE_MTIME
    );
    writeRollout(
      `rollout-2026-07-01T00-01-00-${UUID_B}.jsonl`,
      [sessionMeta(workdir, 'codeman_codex-b'), assistantMsg('answer B')],
      BASE_MTIME + 100
    );

    const a = await getLastResponse(session.id);
    expect(a.res.statusCode).toBe(200);
    expect(a.body.data.text).toBe('answer A');

    const b = await getLastResponse('codex-b');
    expect(b.body.data.text).toBe('answer B');
  });

  it('cwd fallback excludes rollouts claimed by other panes and skips foreign cwds', async () => {
    // Pane has no originator-stamped rollout (pre-existing pane). Newest same-cwd
    // rollout belongs to another codeman pane → must fall through to the unclaimed one.
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [sessionMeta(workdir), assistantMsg('unclaimed answer')],
      BASE_MTIME
    );
    writeRollout(
      `rollout-2026-07-01T00-01-00-${UUID_B}.jsonl`,
      [sessionMeta(workdir, 'codeman_some-other-pane'), assistantMsg('sibling answer')],
      BASE_MTIME + 100
    );
    writeRollout(
      `rollout-2026-07-01T00-02-00-${UUID_C}.jsonl`,
      [sessionMeta('/elsewhere/entirely'), assistantMsg('foreign-cwd answer')],
      BASE_MTIME + 200
    );

    const { body } = await getLastResponse(session.id);
    expect(body.data.text).toBe('unclaimed answer');
  });

  // ── Locator: resume-uuid match ───────────────────────────────────────────

  it('resolves a resumed pane via the rollout filename uuid despite foreign session_meta', async () => {
    session.codexConfig = { resumeSessionId: UUID_A };

    // Resumed rollouts keep the ORIGINAL session_meta (foreign originator + launch cwd),
    // so neither originator nor cwd matching can find them — only the filename uuid.
    writeRollout(
      `rollout-2026-06-30T12-00-00-${UUID_A}.jsonl`,
      [sessionMeta('/original/launch/dir', 'codex_cli_rs'), assistantMsg('resumed answer')],
      BASE_MTIME
    );
    // A newer same-cwd decoy must NOT win over the uuid match.
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_B}.jsonl`,
      [sessionMeta(workdir), assistantMsg('decoy answer')],
      BASE_MTIME + 100
    );

    const { body } = await getLastResponse(session.id);
    expect(body.data.text).toBe('resumed answer');
  });

  // ── Locator: history.jsonl pin ───────────────────────────────────────────

  it('history.jsonl pin (pane last-submit correlation) outranks the originator match', async () => {
    const submitAtSec = BASE_MTIME + 500;
    session.codexLastSubmitAt = submitAtSec * 1000;
    writeHistory([{ session_id: UUID_B, ts: submitAtSec }]);

    // Originator-stamped rollout exists and is NEWER, but the pane /resume'd onto
    // UUID_B inside the TUI — the history pin must follow it there.
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [sessionMeta(workdir, `codeman_${session.id}`), assistantMsg('originator answer')],
      BASE_MTIME + 600
    );
    writeRollout(
      `rollout-2026-06-30T12-00-00-${UUID_B}.jsonl`,
      [sessionMeta('/original/launch/dir', 'codex_cli_rs'), assistantMsg('history answer')],
      BASE_MTIME
    );

    const { body } = await getLastResponse(session.id);
    expect(body.data.text).toBe('history answer');
  });

  // ── Reader: dedup + filtering ────────────────────────────────────────────

  it('event_msg/legacy dedup keeps old-codex turns and drops event twins (mixed-version rollout)', async () => {
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [
        sessionMeta(workdir, `codeman_${session.id}`),
        // Old-codex turn: response_item only, no event_msg twin — must survive.
        legacyUserMsg('old prompt'),
        assistantMsg('old answer'),
        // Modern turn: event_msg + duplicate response_item row — one user row only.
        eventUserMsg('new prompt'),
        legacyUserMsg('new prompt'),
        assistantMsg('new answer'),
      ],
      BASE_MTIME
    );

    const { body } = await getLastResponse(session.id, true);
    expect(body.data.text).toBe('new answer');
    expect(body.data.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ['user', 'old prompt'],
      ['assistant', 'old answer'],
      ['user', 'new prompt'],
      ['assistant', 'new answer'],
    ]);
  });

  it('filters injected-context rows from the full thread', async () => {
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [
        sessionMeta(workdir, `codeman_${session.id}`),
        legacyUserMsg('# AGENTS.md instructions for the workspace'),
        legacyUserMsg('<environment_context>\n<cwd>/somewhere</cwd>'),
        eventUserMsg('<user_instructions>be nice</user_instructions>'),
        legacyUserMsg('real question'),
        assistantMsg('real answer'),
      ],
      BASE_MTIME
    );

    const { body } = await getLastResponse(session.id, true);
    expect(body.data.messages).toEqual([
      { role: 'user', text: 'real question', timestamp: '2026-07-01T00:00:00Z' },
      { role: 'assistant', text: 'real answer', timestamp: '2026-07-01T00:00:00Z' },
    ]);
  });

  it('renders an image placeholder for image-only event_msg inputs', async () => {
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [
        sessionMeta(workdir, `codeman_${session.id}`),
        { timestamp: '2026-07-01T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', images: ['a', 'b'] } },
        assistantMsg('looked at the images'),
      ],
      BASE_MTIME
    );

    const { body } = await getLastResponse(session.id, true);
    expect(body.data.messages[0]).toEqual({
      role: 'user',
      text: '*[image ×2]*',
      timestamp: '2026-07-01T00:00:00Z',
    });
  });

  // ── Envelope shape + Claude-mode regression guard ────────────────────────

  it('returns the {success:true,data:{text,timestamp}} envelope; messages only with ?context=full', async () => {
    writeRollout(
      `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
      [sessionMeta(workdir, `codeman_${session.id}`), assistantMsg('the answer', '2026-07-01T01:02:03Z')],
      BASE_MTIME
    );

    const brief = await getLastResponse(session.id);
    expect(brief.res.statusCode).toBe(200);
    expect(brief.body).toEqual({
      success: true,
      data: { text: 'the answer', timestamp: '2026-07-01T01:02:03Z' },
    });

    const full = await getLastResponse(session.id, true);
    expect(full.body.success).toBe(true);
    expect(Array.isArray(full.body.data.messages)).toBe(true);
  });

  it('returns an empty envelope (not an error) when no rollout matches', async () => {
    const brief = await getLastResponse(session.id);
    expect(brief.res.statusCode).toBe(200);
    expect(brief.body).toEqual({ success: true, data: { text: '', timestamp: '' } });

    const full = await getLastResponse(session.id, true);
    expect(full.body.data.messages).toEqual([]);
  });

  it('leaves Claude-mode sessions on the ~/.claude/projects reader (regression guard)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'codeman-claude-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      session.mode = 'claude';
      const projDir = join(fakeHome, '.claude', 'projects', 'proj1');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(
        join(projDir, `${session.id}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-01T00:00:00Z',
          message: { content: [{ type: 'text', text: 'claude answer' }] },
        }) + '\n'
      );
      // A codex rollout for the same session id must NOT be consulted in claude mode.
      writeRollout(
        `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`,
        [sessionMeta(workdir, `codeman_${session.id}`), assistantMsg('codex answer')],
        BASE_MTIME
      );

      const { res, body } = await getLastResponse(session.id);
      expect(res.statusCode).toBe(200);
      expect(body.data.text).toBe('claude answer');
      expect(body.data.timestamp).toBe('2026-07-01T00:00:00Z');
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('recovers a restored Claude pane by transcript-id prefix and returns only its latest response', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'codeman-restored-claude-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const restored = createMockSession('restored-deadbeef');
      restored.mode = 'claude';
      restored.workingDir = '/stale/server/cwd';
      const restoredWithTranscript = restored as typeof restored & {
        claudeSessionId: string;
        adoptClaudeSessionId: (id: string) => void;
      };
      restoredWithTranscript.claudeSessionId = restored.id;
      restoredWithTranscript.adoptClaudeSessionId = vi.fn((id: string) => {
        restoredWithTranscript.claudeSessionId = id;
      });
      harness.ctx.sessions.set(restored.id, restored);

      const transcriptId = 'deadbeef-1111-4222-8333-444444444444';
      const projDir = join(fakeHome, '.claude', 'projects', '-actual-project');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(
        join(projDir, `${transcriptId}.jsonl`),
        [
          {
            type: 'user',
            timestamp: '2026-07-01T00:00:00Z',
            message: { content: 'first prompt' },
          },
          {
            type: 'assistant',
            timestamp: '2026-07-01T00:01:00Z',
            message: { content: [{ type: 'text', text: 'older response' }] },
          },
          {
            type: 'user',
            timestamp: '2026-07-01T00:02:00Z',
            message: { content: 'latest prompt' },
          },
          {
            type: 'assistant',
            timestamp: '2026-07-01T00:03:00Z',
            message: { content: [{ type: 'text', text: 'actual latest response' }] },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n'
      );

      const { res, body } = await getLastResponse(restored.id);
      expect(res.statusCode).toBe(200);
      expect(body.data).toEqual({
        text: 'actual latest response',
        timestamp: '2026-07-01T00:03:00Z',
      });
      expect(restoredWithTranscript.adoptClaudeSessionId).toHaveBeenCalledWith(transcriptId);
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
