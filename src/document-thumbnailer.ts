/**
 * @fileoverview Best-effort first-page thumbnails for attachment cards.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { getOfficePreviewPdfPath } from './document-preview-cache.js';
import { runWithConversionLimit } from './document-conversion-limiter.js';

const execFileAsync = promisify(execFile);
const THUMBNAIL_CONVERSION_TIMEOUT_MS = 5 * 60_000;

/** Browser-renderable image formats served as-is (no conversion). */
const IMAGE_PASSTHROUGH_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface ThumbnailResult {
  content: Buffer;
  contentType: string;
}

export async function generateFirstPageThumbnail(filePath: string, extension: string): Promise<ThumbnailResult | null> {
  const ext = extension.toLowerCase().replace(/^\./, '');

  try {
    await fs.stat(filePath);

    const passthroughContentType = IMAGE_PASSTHROUGH_CONTENT_TYPES[ext];
    if (passthroughContentType) {
      return { content: await fs.readFile(filePath), contentType: passthroughContentType };
    }

    if (ext === 'pdf') {
      return renderPdfFirstPage(filePath);
    }

    if (ext === 'docx' || ext === 'pptx') {
      return renderOfficeFirstPage(filePath);
    }
  } catch (err) {
    console.warn(`[Thumbnailer] Failed to generate ${ext} thumbnail for ${filePath}:`, getThumbnailErrorMessage(err));
    return null;
  }

  return null;
}

async function renderOfficeFirstPage(filePath: string): Promise<ThumbnailResult | null> {
  try {
    const previewPdfPath = await getOfficePreviewPdfPath(filePath, extname(filePath).toLowerCase().replace(/^\./, ''));
    if (!previewPdfPath) return null;
    return await renderPdfFirstPage(previewPdfPath);
  } catch (err) {
    console.warn(
      `[Thumbnailer] Failed to convert Office file to PDF for thumbnail (${filePath}):`,
      getThumbnailErrorMessage(err)
    );
    return null;
  }
}

async function renderPdfFirstPage(filePath: string): Promise<ThumbnailResult | null> {
  let previewDir: string | undefined;
  try {
    previewDir = await fs.mkdtemp(join(tmpdir(), 'codeman-thumb-pdf-'));
    const prefix = join(previewDir, basename(filePath, extname(filePath)));
    await runWithConversionLimit(() =>
      execFileAsync('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '520', filePath, prefix], {
        timeout: THUMBNAIL_CONVERSION_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
    );
    const content = await fs.readFile(`${prefix}.png`);
    return { content, contentType: 'image/png' };
  } catch (err) {
    console.warn(
      `[Thumbnailer] Failed to render PDF first page for thumbnail (${filePath}):`,
      getThumbnailErrorMessage(err)
    );
    return null;
  } finally {
    if (previewDir) {
      await fs.rm(previewDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function getThumbnailErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
