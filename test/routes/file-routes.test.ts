/**
 * @fileoverview Tests for file-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { ApiErrorCode } from '../../src/types.js';

// Mock fs/promises for file operations
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, isDirectory: () => true })),
  },
}));

// Mock realpathSync for symlink resolution
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
  };
});

// Mock fileStreamManager
vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileStreamManager } from '../../src/file-stream-manager.js';

const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedFileStreamManager = vi.mocked(fileStreamManager);

describe('file-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();

    // Default: realpathSync returns the path unchanged
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    // Default stat
    mockedStat.mockResolvedValue({ size: 100, isFile: () => true, isDirectory: () => true } as never);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/filesystem/browse ==========

  describe('GET /api/filesystem/browse', () => {
    it('lists the active session folder lazily with directories first', async () => {
      mockedReaddir.mockResolvedValueOnce([
        {
          name: 'notes.txt',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: 'src',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as never);

      const path = harness.ctx._session.workingDir;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe(path);
      expect(body.data.roots[0]).toEqual({ label: 'Current Folder', path });
      expect(body.data.entries.map((entry: { name: string; type: string }) => [entry.name, entry.type])).toEqual([
        ['src', 'directory'],
        ['notes.txt', 'file'],
      ]);
    });

    it('rejects paths outside the configured roots', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?path=${encodeURIComponent('/tmp/not-an-allowed-root')}`,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('does not expose hidden entries or symlinks that escape the allowed roots', async () => {
      const root = harness.ctx._session.workingDir;
      mockedReaddir.mockResolvedValueOnce([
        {
          name: '.secret',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: 'outside-link',
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        },
      ] as never);
      mockedRealpathSync.mockImplementation((path: string) =>
        path === `${root}/outside-link` ? ('/etc/shadow' as never) : (path as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(root)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.entries).toEqual([]);
    });

    it('returns 404 for an unknown session scope', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?sessionId=missing-session',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.NOT_FOUND });
    });
  });

  // ========== GET /api/sessions/:id/files ==========

  describe('GET /api/sessions/:id/files', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/files',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns file tree for valid session', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false, name_: 'package.json' },
      ] as never);
      // Nested readdir for src/ returns empty
      mockedReaddir.mockResolvedValueOnce([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.root).toBe(harness.ctx._session.workingDir);
      expect(body.data.tree).toBeDefined();
    });

    it('respects depth parameter', async () => {
      mockedReaddir.mockResolvedValue([] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('excludes hidden files by default', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Hidden files should be excluded
      expect(body.data.totalFiles).toBe(1);
    });

    it('includes hidden files when showHidden=true', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.totalFiles).toBe(2);
    });

    it('excludes node_modules and .git directories', async () => {
      let callCount = 0;
      mockedReaddir.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return [
            { name: 'node_modules', isDirectory: () => true },
            { name: '.git', isDirectory: () => true },
            { name: 'src', isDirectory: () => true },
          ] as never;
        }
        return [] as never;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // node_modules and .git are in excludeDirs set — only src should be counted
      expect(body.data.totalDirectories).toBe(1); // only src
    });
  });

  // ========== GET /api/sessions/:id/file-content ==========

  describe('GET /api/sessions/:id/file-content', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-content?path=test.ts',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing path');
    });

    it('returns text file content', async () => {
      const fileContent = 'const x = 1;\nconst y = 2;\n';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src/test.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(fileContent);
      expect(body.data.extension).toBe('ts');
    });

    it('returns binary metadata for image files', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=logo.png`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('image');
      expect(body.data.url).toContain('file-raw');
    });

    it('returns audio metadata for audio files', async () => {
      mockedStat.mockResolvedValue({ size: 2048 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=clip.mp3`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('audio');
      expect(body.data.url).toContain('file-raw');
    });

    it('flags known-binary extensions (e.g. xlsx) instead of dumping mojibake', async () => {
      mockedStat.mockResolvedValue({ size: 4096 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=sheet.xlsx`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('binary');
      expect(body.data.content).toBeUndefined();
    });

    it('sniffs NUL bytes and flags binary content for unknown extensions', async () => {
      const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
      mockedReadFile.mockResolvedValue(binary as never);
      mockedStat.mockResolvedValue({ size: binary.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=mystery.dat`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('binary');
      expect(body.data.content).toBeUndefined();
    });

    it('rejects path traversal attempts', async () => {
      // realpathSync resolves the symlink to a path outside workingDir
      mockedRealpathSync.mockReturnValue('/etc/passwd' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=../../etc/passwd`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects files that are too large', async () => {
      mockedStat.mockResolvedValue({ size: 20 * 1024 * 1024 } as never); // 20MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=large-file.txt`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('too large');
    });

    it('truncates content when exceeding line limit', async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
      mockedReadFile.mockResolvedValue(lines as never);
      mockedStat.mockResolvedValue({ size: lines.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=big.txt&lines=100`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.truncated).toBe(true);
      expect(body.data.totalLines).toBe(600);
    });

    it('returns file not found when realpathSync throws', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=nonexistent.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== GET /api/sessions/:id/file-raw ==========

  describe('GET /api/sessions/:id/file-raw', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-raw?path=test.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('serves raw file with correct content type', async () => {
      const content = Buffer.from('fake png data');
      mockedReadFile.mockResolvedValue(content as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=image.png`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('serves workspace SVG as an untrusted attachment instead of inline image/svg+xml', async () => {
      const content = Buffer.from('<svg><script>alert("xss")</script></svg>');
      mockedReadFile.mockResolvedValue(content as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=malicious.svg`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toContain('attachment; filename="malicious.svg"');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects path traversal in raw file serving', async () => {
      mockedRealpathSync.mockReturnValue('/etc/shadow' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=../../etc/shadow`,
      });
      // Path traversal returns 404 ("File not found") to avoid revealing the target exists.
      expect(res.statusCode).toBe(404);
    });

    it('rejects overly large raw files', async () => {
      mockedStat.mockResolvedValue({ size: 100 * 1024 * 1024 } as never); // 100MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=huge.bin`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========== DELETE /api/sessions/:id/tail-file/:streamId ==========

  describe('DELETE /api/sessions/:id/tail-file/:streamId', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent/tail-file/stream-1',
      });
      expect(res.statusCode).toBe(404);
    });

    it('closes an existing stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/stream-1`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.closed).toBe(true);
      expect(mockedFileStreamManager.closeStream).toHaveBeenCalledWith('stream-1');
    });

    it('returns closed: false for unknown stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/nonexistent`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.closed).toBe(false);
    });
  });

  // ========== GET /api/download ==========

  describe('GET /api/download', () => {
    it('requires a sessionId to scope downloads', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?path=${encodeURIComponent('/tmp/test-workdir/report.txt')}`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('downloads files scoped to the session working directory', async () => {
      const content = Buffer.from('download content');
      mockedReadFile.mockResolvedValue(content as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=report.txt`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="report.txt"');
      expect(res.body).toBe('download content');
    });

    it('rejects absolute paths outside the session working directory', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent('/var/log/app.log')}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('rejects symlink targets that escape the session working directory', async () => {
      mockedRealpathSync.mockReturnValue('/tmp/outside-workdir/link.log' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(
          '/tmp/test-workdir/link.log'
        )}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('blocks sensitive files even when they are inside the session working directory', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=.env`,
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
