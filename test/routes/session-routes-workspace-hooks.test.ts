/**
 * @fileoverview Hooks are installed into the workspace a claude session starts in.
 *
 * Regression cover for the 2026-08-15 report: a session in a LINKED case (the user's
 * own repo, where most sessions live) ran with no hooks block at all, because
 * `writeHooksConfig` only fires when Codeman CREATES a case directory and the old
 * self-heal call deliberately never ADDED one. The visible symptom was an
 * AskUserQuestion dialog blocking the pane while the tab and the phone overview both
 * showed a calm `idle` — no hook event, so no pending-hook state, so no alert.
 *
 * Asserts bytes on disk (the real `ensureCodemanHooks`), not a spy call.
 * Uses app.inject(), so no real HTTP port is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface HooksFile {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  permissions?: unknown;
  model?: unknown;
}

describe('POST /api/sessions workspace hooks', () => {
  let app: FastifyInstance;
  let workingDir: string;

  const settingsPath = () => join(workingDir, '.claude', 'settings.local.json');
  const readSettings = async (): Promise<HooksFile> => JSON.parse(await readFile(settingsPath(), 'utf-8'));

  const createSession = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/sessions', payload });

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-workspace-hooks-'));
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerSessionRoutes(app, createMockRouteContext());
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(workingDir, { recursive: true, force: true });
  });

  it('installs hooks in a workspace that has none (the linked-case bug)', async () => {
    const res = await createSession({ name: 'hooks-fresh', mode: 'claude', workingDir });
    expect(res.statusCode).toBe(200);

    const settings = await readSettings();
    const matchers = (settings.hooks?.Notification ?? []).map((entry) => entry.matcher);
    // permission_prompt is the one an AskUserQuestion dialog raises; the
    // elicitation pair is what CLOSES the resulting Approvals Inbox item.
    expect(matchers).toEqual(
      expect.arrayContaining([
        'idle_prompt',
        'permission_prompt',
        'elicitation_dialog',
        'elicitation_complete',
        'elicitation_response',
      ])
    );
    expect(settings.hooks?.Stop?.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(settings.hooks);
    // The two shapes that have historically shipped dead hooks: no secret header
    // (401 once the gate went unconditional) and no -k (exit 60 on HTTPS installs).
    expect(serialized).toContain('X-Codeman-Hook-Secret');
    expect(serialized).toContain('curl -sk -X POST');
  });

  it('merges into a user-owned settings file without disturbing it', async () => {
    await mkdir(join(workingDir, '.claude'), { recursive: true });
    const userHook = { matcher: 'Write', hooks: [{ type: 'command', command: './my-formatter.sh' }] };
    await writeFile(
      settingsPath(),
      JSON.stringify({ model: 'opus[1m]', permissions: { allow: ['Read'] }, hooks: { PostToolUse: [userHook] } })
    );

    expect((await createSession({ name: 'hooks-merge', mode: 'claude', workingDir })).statusCode).toBe(200);

    const settings = await readSettings();
    expect(settings.model).toBe('opus[1m]');
    expect(settings.permissions).toEqual({ allow: ['Read'] });
    expect(JSON.stringify(settings.hooks)).toContain('./my-formatter.sh');
    expect((settings.hooks?.Notification ?? []).length).toBeGreaterThan(0);
  });

  it('leaves a non-claude session alone (only claude reads .claude hooks)', async () => {
    expect((await createSession({ name: 'hooks-shell', mode: 'shell', workingDir })).statusCode).toBe(200);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('leaves a malformed settings file untouched rather than replacing it', async () => {
    await mkdir(join(workingDir, '.claude'), { recursive: true });
    await writeFile(settingsPath(), '{ not json');

    expect((await createSession({ name: 'hooks-malformed', mode: 'claude', workingDir })).statusCode).toBe(200);
    expect(await readFile(settingsPath(), 'utf-8')).toBe('{ not json');
  });
});
