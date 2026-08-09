/**
 * @fileoverview Agent-skill injection on POST /api/sessions (docs/agent-control-plan.md §2).
 *
 * The quick-start half of this is covered end-to-end in test/quick-start.test.ts;
 * the plain create path had NO coverage, because the shared mock context hardcoded
 * `getAgentSkillEnabled` to false and nothing could flip it. This exercises the real
 * `applyAgentSkill` against a temp working dir, so it asserts bytes on disk rather
 * than a spy call.
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

const MARKER_PREFIX = '<!-- codeman-managed-agent-skill';

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createHarness(agentSkillEnabled: boolean): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ agentSkillEnabled });
  registerSessionRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('POST /api/sessions agent-skill injection', () => {
  let workingDir: string;
  let harness: Harness | undefined;

  const skillDir = () => join(workingDir, '.claude', 'skills', 'codeman');

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-create-skill-'));
  });

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
    await rm(workingDir, { recursive: true, force: true });
  });

  it('injects the packaged skill into the working dir when the gate is ON', async () => {
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-on', mode: 'claude', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.getAgentSkillEnabled).toHaveBeenCalled();

    const skillMd = await readFile(join(skillDir(), 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    // The marker is what makes the copy ours: without it, uninstall refuses to
    // remove what this create wrote.
    expect(skillMd).toContain(MARKER_PREFIX);
    expect(existsSync(join(skillDir(), 'reference', 'endpoints.md'))).toBe(true);
  });

  it('leaves the working dir untouched when the gate is OFF', async () => {
    harness = await createHarness(false);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-off', mode: 'claude', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.getAgentSkillEnabled).toHaveBeenCalled();
    expect(existsSync(skillDir())).toBe(false);
  });

  it('does not inject for a non-claude mode even when the gate is ON', async () => {
    // `.claude/skills/` is read by Claude Code only, so the gate is never even
    // consulted for the other backends.
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-shell', mode: 'shell', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.getAgentSkillEnabled).not.toHaveBeenCalled();
    expect(existsSync(skillDir())).toBe(false);
  });

  it('defaults an omitted mode to claude and injects', async () => {
    // The frontend omits `mode` for a plain claude create, so the default branch
    // is the common path, not an edge case.
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-default-mode', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(skillDir(), 'SKILL.md'))).toBe(true);
  });
});
