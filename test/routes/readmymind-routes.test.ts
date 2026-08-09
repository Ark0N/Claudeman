/**
 * @fileoverview Read My Mind route tests (src/web/routes/readmymind-routes.ts)
 * via app.inject(), no live port.
 *
 * The routes read the process-wide `intentStore` singleton, whose data file
 * resolves under this test file's temp HOME (test/setup.ts). The singleton's
 * in-memory map lives for the whole file, so each test uses a distinct
 * session workingDir to stay isolated.
 *
 * The predictor singleton is stubbed (`vi.spyOn(readMyMindPredictor,
 * 'predict')`): nothing here ever spawns tmux or the claude CLI.
 *
 * Port: SessionPort & ConfigPort & InfraPort.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerReadMyMindRoutes } from '../../src/web/routes/readmymind-routes.js';
import { readMyMindPredictor, type PredictionResult } from '../../src/readmymind-predictor.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

const SESSION_ID = 'test-session-1';

let harness: RouteTestHarness;
let caseCounter = 0;

beforeEach(async () => {
  harness = await createRouteTestHarness(registerReadMyMindRoutes);
  // Unique (nonexistent) workingDir per test: resolveDir falls back to the raw
  // string, so the key is stable and no other test's profile bleeds in.
  caseCounter++;
  sessionUnderTest().workingDir = `/nonexistent/readmymind-case-${caseCounter}`;
});

afterEach(async () => {
  await harness.app.close();
});

function sessionUnderTest(): { workingDir: string; owner?: string } {
  return harness.ctx.sessions.get(SESSION_ID) as unknown as { workingDir: string; owner?: string };
}

describe('GET /api/sessions/:id/intent', () => {
  it('returns an empty transient profile for a fresh case', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.intent.goals).toBe('');
    expect(body.data.intent.recentPrompts).toEqual([]);
    expect(body.data.intent.updatedAt).toBe(0);
  });

  it('404s an unknown session id', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/nope/intent' });
    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });
});

describe('PUT /api/sessions/:id/intent', () => {
  it('round-trips goals through the store', async () => {
    const put = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'ship 1.17 with the readmymind phase 1' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.intent.goals).toBe('ship 1.17 with the readmymind phase 1');
    expect(put.json().data.intent.updatedAt).toBeGreaterThan(0);

    const get = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(get.json().data.intent.goals).toBe('ship 1.17 with the readmymind phase 1');
  });

  it('rejects over-long goals and unknown keys (strict schema)', async () => {
    const tooLong = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'x'.repeat(8193) },
    });
    expect(tooLong.statusCode).toBe(400);

    const extraKey = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'ok', recentPrompts: [] },
    });
    expect(extraKey.statusCode).toBe(400);
  });
});

describe('DELETE /api/sessions/:id/intent', () => {
  it('forgets the case and reports whether anything existed', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'temporary' },
    });

    const first = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.deleted).toBe(true);

    const second = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(second.json().data.deleted).toBe(false);

    const get = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(get.json().data.intent.goals).toBe('');
  });
});

describe('POST /api/sessions/:id/readmymind', () => {
  const RESULT: PredictionResult = {
    suggestions: [{ prompt: 'run the tests', why: 'a fix just landed', kind: 'verify' }],
    durationMs: 1234,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the stubbed suggestions and feeds user signals into the prompt', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'GOALS_MARKER ship the release' },
    });

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.suggestions).toEqual(RESULT.suggestions);
    expect(body.data.durationMs).toBe(1234);

    expect(predict).toHaveBeenCalledTimes(1);
    const options = predict.mock.calls[0][0];
    expect(options.sessionId).toBe(SESSION_ID);
    expect(options.model).toBe('claude-opus-4-5-20251101');
    expect(options.prompt).toContain('TRUST TIERS');
    expect(options.prompt).toContain('GOALS_MARKER');
  });

  it('threads steer and rejected suggestions into the rethink section', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/readmymind`,
      payload: { steer: 'STEER_MARKER the mobile bug', rejected: ['REJECTED_MARKER run the tests'] },
    });
    expect(res.statusCode).toBe(200);
    const prompt = predict.mock.calls[0][0].prompt;
    expect(prompt).toContain('STEER_MARKER');
    expect(prompt).toContain('REJECTED_MARKER');
  });

  it('409s while a prediction is already running for the session', async () => {
    let release: (value: PredictionResult) => void = () => {};
    // First call hangs until released; later calls resolve immediately.
    vi.spyOn(readMyMindPredictor, 'predict')
      .mockImplementationOnce(() => new Promise<PredictionResult>((resolve) => (release = resolve)))
      .mockResolvedValue(RESULT);

    const first = harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    // Let the first request reach the in-flight registration.
    await vi.waitFor(() => expect(readMyMindPredictor.predict).toHaveBeenCalled());

    const second = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(second.statusCode).toBe(409);
    expect(second.json().errorCode).toBe('CONFLICT');

    release(RESULT);
    expect((await first).statusCode).toBe(200);

    // The slot frees once the prediction settles.
    const third = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(third.statusCode).toBe(200);
  });

  it('400s non-claude sessions', async () => {
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    (harness.ctx.sessions.get(SESSION_ID) as unknown as { mode: string }).mode = 'shell';
    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(res.statusCode).toBe(400);
    expect(readMyMindPredictor.predict).not.toHaveBeenCalled();
  });

  it('502s a predictor failure with the clean error message', async () => {
    vi.spyOn(readMyMindPredictor, 'predict').mockRejectedValue(new Error('Predictor returned malformed JSON'));
    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('malformed JSON');

    // The in-flight slot is released after a failure.
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const retry = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(retry.statusCode).toBe(200);
  });

  it('rejects unknown body keys (strict schema)', async () => {
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/readmymind`,
      payload: { autoSend: true },
    });
    expect(res.statusCode).toBe(400);
    expect(readMyMindPredictor.predict).not.toHaveBeenCalled();
  });

  it('404s an unknown session id', async () => {
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const res = await harness.app.inject({ method: 'POST', url: '/api/sessions/nope/readmymind' });
    expect(res.statusCode).toBe(404);
  });
});

describe('multi-user scoping', () => {
  let savedMultiuser: string | undefined;

  beforeEach(() => {
    savedMultiuser = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
  });

  afterEach(() => {
    if (savedMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMultiuser;
  });

  it("404s (never 403s) another user's session", async () => {
    const scoped = await createRouteTestHarness(registerReadMyMindRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    try {
      (scoped.ctx.sessions.get(SESSION_ID) as unknown as { owner?: string }).owner = 'alice';
      const res = await scoped.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
      expect(res.statusCode).toBe(404);
    } finally {
      await scoped.app.close();
    }
  });

  it('serves the owner normally', async () => {
    const scoped = await createRouteTestHarness(registerReadMyMindRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    try {
      const session = scoped.ctx.sessions.get(SESSION_ID) as unknown as { owner?: string; workingDir: string };
      session.owner = 'bob';
      session.workingDir = `/nonexistent/readmymind-owned-${Date.now()}`;
      const res = await scoped.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    } finally {
      await scoped.app.close();
    }
  });
});
