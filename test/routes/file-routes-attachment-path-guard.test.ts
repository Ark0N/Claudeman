/**
 * @fileoverview COD-53 — attachment path-traversal / sensitive-file guard.
 *
 * Verifies the sensitive-path blocklist is enforced at:
 *  - attachment registration (POST /api/sessions/:id/attachments)
 *  - raw / preview / thumbnail serving (defense-in-depth against a record that
 *    was crafted or registered before the guard existed)
 * while still allowing legitimate cross-workspace attachment (codeman-publish
 * skill + the ~/.codeman review-card loop) to succeed.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

// Mock fs/promises for file operations
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, mtimeMs: 1 })),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-preview-test'),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

// Mock realpathSync for symlink resolution (identity by default)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    createReadStream: vi.fn(() => Readable.from([Buffer.from('file content')])),
  };
});

vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import {
  attachmentRegistry,
  registerExternalAttachment,
  type AttachmentRecord,
} from '../../src/attachment-registry.js';
import { SseEvent } from '../../src/web/sse-events.js';

const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedCreateReadStream = vi.mocked(createReadStream);

describe('file-routes attachment path guard (COD-53)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();
    attachmentRegistry.clearSession('test-session-1');
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    mockedStat.mockResolvedValue({ size: 100, isFile: () => true, mtimeMs: 1 } as never);
    mockedCreateReadStream.mockReturnValue(Readable.from([Buffer.from('file content')]) as never);
  });

  afterEach(async () => {
    await harness.app.close();
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    // Reset attachment-guard env knobs so one test can't leak into the next.
    delete process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS;
    delete process.env.CODEMAN_ATTACHMENT_CONFINE;
  });

  // ===== BLOCK: registration rejects a sensitive path =====

  it('rejects registering a .env file that carries a supported extension', async () => {
    // A dotenv-style secret file named with a supported extension still leaks
    // secrets; the blocklist's /\.env\./ pattern catches `.env.<ext>`.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/home/someone/project/.env.txt' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('rejects registering an SSH key path even with a supported extension', async () => {
    const sshTxt = `${homedir()}/.ssh/id_rsa.txt`;
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: sshTxt },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('rejects registering a sensitive path that a symlink resolves to', async () => {
    // The requested path looks innocent (.md) but realpath resolves it to an SSH key dir.
    mockedRealpathSync.mockReturnValue(`${homedir()}/.ssh/known_hosts.md` as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/home/someone/project/innocent.md' },
    });

    expect(res.statusCode).toBe(403);
  });

  // ===== BLOCK (defense-in-depth): raw serving rejects a sensitive record =====

  it('refuses to serve raw bytes for a record whose path is sensitive', async () => {
    // Simulate a record that was registered before the guard existed (or crafted).
    const record: AttachmentRecord = {
      attachmentId: 'att_sensitive',
      sessionId: harness.ctx._sessionId,
      filePath: `${homedir()}/.ssh/id_rsa.txt`,
      fileName: 'id_rsa.txt',
      extension: 'txt',
      attachmentType: 'text',
      size: 100,
      mtimeMs: 1,
      timestamp: Date.now(),
      source: 'external',
    };
    attachmentRegistry.register(record);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/att_sensitive/raw`,
    });

    expect(res.statusCode).toBe(403);
    expect(mockedCreateReadStream).not.toHaveBeenCalled();
  });

  // ===== PRESERVE: legitimate cross-workspace attachment still works =====

  it('still registers a normal cross-workspace file (codeman-publish / loop review card)', async () => {
    mockedStat.mockResolvedValue({ size: 512, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: `${homedir()}/.codeman/jira-autoloop-questions.md` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('jira-autoloop-questions.md');
    expect(body.data.extension).toBe('md');
  });

  it('still registers an arbitrary project-dir file (WSL path)', async () => {
    mockedStat.mockResolvedValue({ size: 4096, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/mnt/c/decks/board-update.pdf' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('board-update.pdf');
  });

  it('still serves raw bytes for a legitimately registered cross-workspace file', async () => {
    const content = Buffer.from('# notes');
    mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
    mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);

    const registerRes = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: `${homedir()}/.codeman/review-card.md` },
    });
    const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

    const rawRes = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw`,
    });

    expect(rawRes.statusCode).toBe(200);
    expect(rawRes.headers['content-type']).toBe('text/markdown');
  });

  // ===== BLOCK (broadened defaults): /root and /etc trees =====

  it('rejects registering a file anywhere under /root by default', async () => {
    // /root is the root account home — blocked as a whole tree by default,
    // even for an ordinary-looking note with a supported extension.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/root/secret-notes.md' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('rejects registering a file anywhere under /etc by default', async () => {
    // The whole /etc tree is blocked by default (not just /etc/shadow).
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/etc/codeman/config-dump.txt' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('does not block a lookalike sibling dir like /etcetera (separator-aware)', async () => {
    // The /etc tree block must be path-separator-aware so an unrelated
    // /etcetera/... path is NOT caught by accident.
    mockedStat.mockResolvedValue({ size: 10, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/etcetera/notes.md' },
    });

    expect(res.statusCode).toBe(200);
  });

  // ===== CONFIG: extend the blocked set via env =====

  it('rejects a path added via the extra-blocked-paths config', async () => {
    process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = '/srv/secrets,/data/private';
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/srv/secrets/keys.pdf' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('still allows a normal path NOT in the configured blocked set', async () => {
    process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = '/srv/secrets,/data/private';
    mockedStat.mockResolvedValue({ size: 20, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/srv/public/report.pdf' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('report.pdf');
  });

  // ===== CONFINEMENT MODE ON (opt-in) =====

  it('confinement ON: rejects a file OUTSIDE the session workspace', async () => {
    process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
    // Mock session workspace is /tmp/test-workdir; this file resolves elsewhere.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/home/someone/elsewhere/report.pdf' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('confinement ON: allows a file INSIDE the session workspace', async () => {
    process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
    // Mock session workspace is /tmp/test-workdir (see MockSession).
    const insidePath = '/tmp/test-workdir/docs/report.pdf';
    mockedRealpathSync.mockReturnValue(insidePath as never);
    mockedStat.mockResolvedValue({ size: 30, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: insidePath },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('report.pdf');
  });

  // ===== CONFINEMENT OFF (default) regression: legit cross-workspace attach =====

  it('confinement OFF (default): legit cross-workspace attach still succeeds', async () => {
    // No CODEMAN_ATTACHMENT_CONFINE set → default OFF. A ~/.codeman review-card
    // file lives OUTSIDE the /tmp/test-workdir session workspace and must still
    // attach (protects codeman-publish + the loop's review-card channel).
    mockedStat.mockResolvedValue({ size: 64, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: `${homedir()}/.codeman/jira-autoloop-questions.md` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('jira-autoloop-questions.md');
  });

  // ===== Magic-link scan path: FORCED workspace confinement =====
  // The terminal-output `codeman://attach` scanner registers with
  // forceWorkspaceConfinement: true so a prompt-injected session printing an
  // arbitrary path can't expose a host file, even though global confine is OFF.
  describe('forced workspace confinement (magic-link scan path)', () => {
    it('rejects an out-of-workspace path even when global confinement is OFF', async () => {
      mockedRealpathSync.mockImplementation((p: string) => p as never);
      mockedStat.mockResolvedValue({ size: 10, isFile: () => true, mtimeMs: 1 } as never);
      await expect(
        registerExternalAttachment('test-session-mlc', '/home/someone/secret/report.pdf', {
          sessionWorkingDir: '/tmp/test-workdir',
          forceWorkspaceConfinement: true,
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      attachmentRegistry.clearSession('test-session-mlc');
    });

    it('allows an in-workspace path on the forced path', async () => {
      const inside = '/tmp/test-workdir/sub/report.pdf';
      mockedRealpathSync.mockReturnValue(inside as never);
      mockedStat.mockResolvedValue({ size: 10, isFile: () => true, mtimeMs: 1 } as never);
      const event = await registerExternalAttachment('test-session-mlc', inside, {
        sessionWorkingDir: '/tmp/test-workdir',
        forceWorkspaceConfinement: true,
      });
      expect(event.fileName).toBe('report.pdf');
      attachmentRegistry.clearSession('test-session-mlc');
    });
  });

  // ===== Quiet registration (click-to-preview) =====
  // The file-preview overlay registers a clicked out-of-workspace path to mint
  // an id it can render by. It is already putting the file on screen, so the
  // usual attachment card + unread badge would announce what the user is
  // looking at. `notify: false` suppresses ONLY the broadcast — the guard, the
  // registry entry and the by-id routes are identical either way.
  describe('quiet registration', () => {
    const outside = '/tmp/claude-1000/scratchpad/probe-run-native.png';

    it('broadcasts by default, so the CLI and publish paths keep their card', async () => {
      mockedStat.mockResolvedValue({ size: 128, isFile: () => true, mtimeMs: 5 } as never);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: outside },
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(SseEvent.AttachmentDetected, expect.anything());
    });

    it('registers and serves a clicked path without broadcasting when notify is false', async () => {
      const content = Buffer.from('PNGDATA');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: outside, notify: false },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.fileName).toBe('probe-run-native.png');
      expect(harness.ctx.broadcast).not.toHaveBeenCalled();

      // The preview renders from this route, so the id has to be live.
      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/raw`,
      });
      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe('image/png');
    });
  });
});
