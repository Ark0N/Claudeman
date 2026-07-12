import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { generateFirstPageThumbnail } from '../src/document-thumbnailer.js';
import { clearDocumentPreviewCache } from '../src/document-preview-cache.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    callback(null, { stdout: '', stderr: '' });
    return {};
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(async () => ({ size: 100, isFile: () => true })),
    readFile: vi.fn(async () => Buffer.from('png')),
    readdir: vi.fn(async () => ['converted.pdf']),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-thumb-test'),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

const mockedExecFile = vi.mocked(execFile);
const mockedStat = vi.mocked(fs.stat);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedMkdir = vi.mocked(fs.mkdir);
const mockedMkdtemp = vi.mocked(fs.mkdtemp);
const mockedRename = vi.mocked(fs.rename);
const mockedRm = vi.mocked(fs.rm);

describe('document-thumbnailer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDocumentPreviewCache();
    mockedStat.mockImplementation(async (path) => {
      const pathText = String(path);
      if (pathText.includes('codeman-document-preview-cache') && pathText.endsWith('.pdf')) {
        throw new Error('ENOENT');
      }

      return { size: 500 * 1024 * 1024, mtimeMs: 12345, isFile: () => true } as never;
    });
    mockedReadFile.mockResolvedValue(Buffer.from('large thumbnail') as never);
    mockedReaddir.mockResolvedValue(['converted.pdf'] as never);
    mockedMkdir.mockResolvedValue(undefined as never);
    mockedMkdtemp.mockResolvedValue('/tmp/codeman-thumb-test' as never);
    mockedRename.mockResolvedValue(undefined as never);
    mockedRm.mockResolvedValue(undefined as never);
    mockedExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
      return {} as never;
    });
  });

  it('renders first-page thumbnails for large documents without an app-level size cap', async () => {
    const result = await generateFirstPageThumbnail('/tmp/large-deck.pdf', 'pdf');

    expect(result).toEqual({
      content: Buffer.from('large thumbnail'),
      contentType: 'image/png',
    });
    expect(mockedExecFile).toHaveBeenCalledWith(
      'pdftoppm',
      expect.arrayContaining(['-png', '-singlefile', '-f', '1', '-l', '1']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('passes through generated image formats with per-extension content types', async () => {
    const expectations: Array<[string, string]> = [
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['gif', 'image/gif'],
      ['webp', 'image/webp'],
      ['png', 'image/png'],
    ];

    for (const [ext, contentType] of expectations) {
      const result = await generateFirstPageThumbnail(`/tmp/mockup.${ext}`, ext);
      expect(result).toEqual({ content: Buffer.from('large thumbnail'), contentType });
    }
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('renders Office thumbnails from the cached converted PDF after conversion cleanup', async () => {
    mockedMkdtemp.mockImplementation(async (prefix) =>
      String(prefix).includes('codeman-document-preview-cache')
        ? '/tmp/codeman-document-preview-cache/work-test'
        : '/tmp/codeman-thumb-pdf-test'
    );
    mockedExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
      return {} as never;
    });

    const result = await generateFirstPageThumbnail('/tmp/deck.pptx', 'pptx');

    expect(result).toEqual({
      content: Buffer.from('large thumbnail'),
      contentType: 'image/png',
    });
    const pdftoppmCall = mockedExecFile.mock.calls.find(([cmd]) => cmd === 'pdftoppm');
    expect(pdftoppmCall?.[1]).toEqual(
      expect.arrayContaining([expect.stringContaining('codeman-document-preview-cache')])
    );
  });
});
