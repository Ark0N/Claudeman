/**
 * @fileoverview Read My Mind intent route tests (src/web/routes/readmymind-routes.ts)
 * via app.inject(), no live port.
 *
 * The routes read the process-wide `intentStore` singleton, whose data file
 * resolves under this test file's temp HOME (test/setup.ts). The singleton's
 * in-memory map lives for the whole file, so each test uses a distinct
 * session workingDir to stay isolated.
 *
 * Port: SessionPort.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerReadMyMindRoutes } from '../../src/web/routes/readmymind-routes.js';
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
