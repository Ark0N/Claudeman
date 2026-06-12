/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, and tail streaming.
 */

import { FastifyInstance, type FastifyReply } from 'fastify';
import { basename as pathBasename, join } from 'node:path';
import { createReadStream, realpathSync, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { fileStreamManager } from '../../file-stream-manager.js';
import {
  AttachmentRegistrationError,
  attachmentRecordToEvent,
  attachmentRegistry,
  buildFileThumbnailRoute,
  isSupportedAttachmentExtension,
  registerExternalAttachment,
  type AttachmentRecord,
} from '../../attachment-registry.js';
import { generateFirstPageThumbnail } from '../../document-thumbnailer.js';
import { getOfficePreviewPdfPath, getPreviewPdfDownloadName } from '../../document-preview-cache.js';
import { sanitizeAttachmentHistoryItem } from '../../session-attachment-history.js';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from '../../config/attachment-guard.js';
import { findSessionOrFail, validateSessionFilePath } from '../route-helpers.js';
import type { SessionAttachmentHistoryItem, SessionState } from '../../types/session.js';
import { isSensitivePath } from '../sensitive-path.js';
import { SseEvent } from '../sse-events.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

function sanitizeDownloadName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}

function sendRawStream(reply: FastifyReply, content: ReadStream): void {
  const headers = reply.getHeaders();
  reply.hijack();

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      reply.raw.setHeader(name, value);
    }
  }

  content.on('error', (err) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy(err);
      return;
    }

    reply.raw.statusCode = 500;
    reply.raw.end('Failed to read file');
  });
  content.pipe(reply.raw);
}

async function serveRawFile(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string,
  download?: boolean
): Promise<void> {
  const stat = await fs.stat(resolvedPath);
  const MAX_RAW_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50MB, matching file-raw / download
  if (stat.size > MAX_RAW_ATTACHMENT_SIZE) {
    reply
      .code(413)
      .send(
        createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_RAW_ATTACHMENT_SIZE / 1024 / 1024}MB limit)`
        )
      );
    return;
  }
  const content = createReadStream(resolvedPath);
  const safeName = sanitizeDownloadName(fileName);
  if (download || extension === 'svg') {
    reply.header(
      'Content-Type',
      extension === 'svg' ? 'application/octet-stream' : MIME_TYPES[extension] || 'application/octet-stream'
    );
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.header('Content-Length', stat.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    sendRawStream(reply, content);
    return;
  }

  reply.header('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  reply.header('Content-Disposition', `inline; filename="${safeName}"`);
  reply.header('Content-Length', stat.size);
  reply.header('X-Content-Type-Options', 'nosniff');
  sendRawStream(reply, content);
}

function getAttachmentOr404(
  reply: FastifyReply,
  sessionId: string,
  attachmentId: string
): AttachmentRecord | undefined {
  const record = attachmentRegistry.get(sessionId, attachmentId);
  if (!record) {
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Attachment not found'));
    return undefined;
  }
  return record;
}

/**
 * COD-53 defense-in-depth: refuse to stream a record whose underlying path is
 * blocked by the active attachment-guard policy, even though registration
 * already blocks them. Guards against records that predate the guard or were
 * crafted to point at a sensitive file. Resolves symlinks before the check so a
 * record pointing at a symlink that now resolves to a sensitive target is also
 * caught; if the path can't be resolved (deleted/unreadable) the check still
 * runs on the stored path. When workspace confinement is enabled it additionally
 * rejects any record outside the session workspace. Returns true (and sends a
 * 403) when blocked.
 */
async function resolveServableAttachmentPath(
  reply: FastifyReply,
  record: AttachmentRecord,
  sessionWorkingDir?: string
): Promise<string | null> {
  let pathToCheck = record.filePath;
  let resolved = false;
  try {
    pathToCheck = realpathSync(record.filePath);
    resolved = true;
  } catch {
    // Fall back to the stored (already realpath-resolved at registration) path.
  }

  const guard = await loadAttachmentGuardConfig();

  const blocked =
    isBlockedAttachmentPath(pathToCheck, guard.blockedTrees) ||
    isBlockedAttachmentPath(record.filePath, guard.blockedTrees) ||
    (guard.confineToWorkspace && (!sessionWorkingDir || !validateSessionFilePath(sessionWorkingDir, pathToCheck)));

  if (blocked) {
    reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
    return null;
  }
  // Serve the freshly-resolved path, not the stored one: if a path component
  // became a symlink after registration, the guard checked the resolved target
  // but streaming record.filePath would follow the symlink to a swapped file.
  return resolved ? pathToCheck : record.filePath;
}

/**
 * Convert a DOCX/PPTX to a single-PDF preview (LibreOffice when available) and
 * stream it inline. PDF/PNG and text formats don't need conversion — callers
 * redirect those to the raw route instead.
 */
async function serveConvertedPreview(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string
): Promise<void> {
  if (extension !== 'docx' && extension !== 'pptx') {
    reply
      .code(400)
      .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Preview is not supported for this file type'));
    return;
  }

  try {
    const previewPath = await getOfficePreviewPdfPath(resolvedPath, extension);
    if (!previewPath) {
      reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Document preview conversion failed'));
      return;
    }

    const content = await fs.readFile(previewPath);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${getPreviewPdfDownloadName(fileName, extension)}"`);
    reply.header('Cache-Control', 'no-cache');
    reply.header('Content-Length', content.length);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.send(content);
  } catch (err) {
    reply
      .code(500)
      .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to generate preview: ${getErrorMessage(err)}`));
  }
}

/** Generate and stream a first-page thumbnail (PNG) for a supported attachment. */
async function serveThumbnail(reply: FastifyReply, resolvedPath: string, extension: string): Promise<void> {
  const thumbnail = await generateFirstPageThumbnail(resolvedPath, extension);
  if (!thumbnail) {
    reply.code(204).send();
    return;
  }

  reply.header('Content-Type', thumbnail.contentType);
  reply.header('Cache-Control', 'no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.send(thumbnail.content);
}

/**
 * Resolve a session's working dir from the live session, falling back to the
 * persisted record so preview/thumbnail requests keep working for a session
 * that has since detached. Sends a 404 and returns undefined when unknown.
 */
function getKnownSessionWorkingDir(
  ctx: SessionPort & ConfigPort,
  sessionId: string,
  reply: FastifyReply
): string | undefined {
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession) return liveSession.workingDir;

  const stored = ctx.store.getSession(sessionId);
  if (stored) return stored.workingDir;

  reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`));
  return undefined;
}

// Persisted sessions carry the private (externalPath-bearing) history under a
// `__attachmentHistory` key so the list route can re-register external files.
type StoredSessionWithPrivateAttachmentHistory = SessionState & {
  __attachmentHistory?: SessionAttachmentHistoryItem[];
};

type AttachmentHistoryRouteItem = Omit<SessionAttachmentHistoryItem, 'externalPath'> & {
  missing: boolean;
  rawUrl?: string;
  url?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  attachmentId?: string;
};

function appendDownloadFlag(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}download=true`;
}

function getSessionAttachmentHistory(
  ctx: SessionPort & ConfigPort,
  sessionId: string
): { workingDir: string; history: SessionAttachmentHistoryItem[] } | undefined {
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession) {
    return {
      workingDir: liveSession.workingDir,
      history: liveSession.getAttachmentHistoryForPersist() ?? liveSession.attachmentHistory ?? [],
    };
  }

  const stored = ctx.store.getSession(sessionId) as StoredSessionWithPrivateAttachmentHistory | undefined;
  if (!stored) return undefined;

  return {
    workingDir: stored.workingDir,
    history: stored.__attachmentHistory ?? stored.attachmentHistory ?? [],
  };
}

// History item for a file detected inside the workspace: re-stat for live
// size/mtime and resolve preview/thumbnail/raw routes off the relative path.
async function buildDetectedAttachmentRouteItem(
  sessionId: string,
  workingDir: string,
  item: SessionAttachmentHistoryItem
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.relativePath) {
    return { ...safe, missing: true };
  }

  const validated = validateSessionFilePath(workingDir, item.relativePath);
  if (!validated) {
    return { ...safe, missing: true };
  }

  let size = item.size;
  let mtimeMs = item.mtimeMs;
  try {
    const stat = await fs.stat(validated.resolvedPath);
    size = stat.size;
    mtimeMs = stat.mtimeMs ?? mtimeMs;
  } catch {
    return { ...safe, missing: true };
  }

  const encodedPath = encodeURIComponent(item.relativePath);
  const rawUrl = `/api/sessions/${sessionId}/file-raw?path=${encodedPath}`;
  const previewUrl =
    item.extension === 'docx' || item.extension === 'pptx'
      ? `/api/sessions/${sessionId}/file-preview?path=${encodedPath}`
      : rawUrl;
  const thumbnailUrl = isSupportedAttachmentExtension(item.extension)
    ? buildFileThumbnailRoute(sessionId, item.relativePath)
    : undefined;

  return {
    ...safe,
    size,
    mtimeMs,
    missing: false,
    rawUrl,
    url: rawUrl,
    previewUrl,
    thumbnailUrl,
    downloadUrl: appendDownloadFlag(rawUrl),
  };
}

// History item for an explicitly published external file: re-register it to mint
// a fresh id + by-id routes (the guard runs again), or mark it missing.
async function buildExternalAttachmentRouteItem(
  sessionId: string,
  item: SessionAttachmentHistoryItem,
  sessionWorkingDir?: string
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.externalPath) {
    return { ...safe, missing: true };
  }

  try {
    const event = await registerExternalAttachment(sessionId, item.externalPath, { sessionWorkingDir });
    return {
      ...safe,
      fileName: event.fileName,
      extension: event.extension,
      attachmentType: event.attachmentType,
      size: event.size,
      missing: false,
      attachmentId: event.attachmentId,
      rawUrl: event.rawUrl,
      url: event.rawUrl,
      previewUrl: event.previewUrl,
      thumbnailUrl: event.thumbnailUrl,
      downloadUrl: appendDownloadFlag(event.rawUrl),
    };
  } catch (err) {
    if (err instanceof AttachmentRegistrationError) {
      return { ...safe, missing: true };
    }
    throw err;
  }
}

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort): void {
  // File tree listing
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const { depth, showHidden } = req.query as { depth?: string; showHidden?: string };
    const session = findSessionOrFail(ctx, id);

    const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;

    // Default excludes - large/generated directories
    const excludeDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '__pycache__',
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.venv',
      'venv',
      '.tox',
      'target',
      'vendor',
    ]);

    interface FileTreeNode {
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
      extension?: string;
      children?: FileTreeNode[];
    }

    let totalFiles = 0;
    let totalDirectories = 0;
    let truncated = false;
    const maxFiles = 5000;

    const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
      if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
        truncated = true;
        return [];
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const nodes: FileTreeNode[] = [];

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles) {
            truncated = true;
            break;
          }

          // Skip hidden files unless requested
          if (!includeHidden && entry.name.startsWith('.')) continue;

          // Skip excluded directories
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = fullPath.slice(workingDir.length + 1);

          if (entry.isDirectory()) {
            totalDirectories++;
            const children = await scanDirectory(fullPath, currentDepth + 1);
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'directory',
              children,
            });
          } else {
            totalFiles++;
            const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined;
            let size: number | undefined;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // Skip if can't stat
            }
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size,
              extension: ext,
            });
          }
        }

        return nodes;
      } catch {
        // Can't read directory (permission denied, etc.)
        return [];
      }
    };

    const tree = await scanDirectory(workingDir, 1);

    return {
      success: true,
      data: {
        root: workingDir,
        tree,
        totalFiles,
        totalDirectories,
        truncated,
      },
    };
  });

  // Get file content for preview (File Browser)
  app.get('/api/sessions/:id/file-content', async (req) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines, raw } = req.query as { path?: string; lines?: string; raw?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
    }
    const { resolvedPath } = validated;

    try {
      const stat = await fs.stat(resolvedPath);

      // Check if it's a binary/media file
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const binaryExts = new Set([
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'ico',
        'svg',
        'bmp',
        'mp4',
        'webm',
        'mov',
        'avi',
        'mp3',
        'wav',
        'ogg',
        'pdf',
        'zip',
        'tar',
        'gz',
        'exe',
        'dll',
        'so',
        'woff',
        'woff2',
        'ttf',
        'eot',
      ]);
      const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      const videoExts = new Set(['mp4', 'webm', 'mov', 'avi']);

      if (raw === 'true' || binaryExts.has(ext)) {
        // Return metadata for binary files
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type: imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : 'binary',
            extension: ext,
            url: `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`,
          },
        };
      }

      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (stat.size > MAX_TEXT_FILE_SIZE) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit)`
        );
      }

      // Read text file with line limit (bounded to prevent DoS)
      const MAX_LINES_LIMIT = 10000;
      const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const allLines = content.split('\n');
      const truncatedContent = allLines.length > maxLines;
      const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

      return {
        success: true,
        data: {
          path: filePath,
          content: displayContent,
          size: stat.size,
          totalLines: allLines.length,
          truncated: truncatedContent,
          extension: ext,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // Serve raw file content (for images/binary files)
  app.get('/api/sessions/:id/file-raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, download } = req.query as { path?: string; download?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    try {
      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_RAW_FILE_SIZE = 50 * 1024 * 1024; // 50MB for raw files
      const stat = await fs.stat(resolvedPath);
      if (stat.size > MAX_RAW_FILE_SIZE) {
        reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_RAW_FILE_SIZE / 1024 / 1024}MB limit)`
            )
          );
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        bmp: 'image/bmp',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        pdf: 'application/pdf',
        json: 'application/json',
      };

      const content = await fs.readFile(resolvedPath);
      const rawBasename = filePath!.split('/').pop() || 'download';
      // Sanitize filename for Content-Disposition header (prevent header injection)
      const basename = rawBasename.replace(/["\\\r\n]/g, '_');
      if (download === 'true' || ext === 'svg') {
        reply.raw.writeHead(200, {
          'Content-Type': ext === 'svg' ? 'application/octet-stream' : mimeTypes[ext] || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${basename}"`,
          'Content-Length': content.length,
          'X-Content-Type-Options': 'nosniff',
        });
        reply.raw.end(content);
        return;
      }
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.send(content);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // ===== Live external attachments =====
  // Register an explicit, live external file (absolute host path) as an
  // attachment with a stable id so browser requests never carry arbitrary
  // paths. Registration enforces the COD-53 attachment-guard policy. Serving is
  // by id via the /raw route below; document previews/thumbnails and the
  // attachment-history list are layered on separately.
  app.post('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = (req.body || {}) as { path?: string };

    if (!body.path || typeof body.path !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing attachment path'));
      return;
    }

    try {
      const event = await registerExternalAttachment(id, body.path, { sessionWorkingDir: session.workingDir });
      ctx.broadcast(SseEvent.AttachmentDetected, event);
      return { success: true, data: event };
    } catch (err) {
      if (err instanceof AttachmentRegistrationError) {
        reply.code(err.statusCode).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        return;
      }
      return reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to register attachment: ${getErrorMessage(err)}`)
        );
    }
  });

  // List a session's attachment history (live session or persisted), resolving
  // each entry to current metadata + routes. External entries are re-registered.
  app.get('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sessionHistory = getSessionAttachmentHistory(ctx, id);
    if (!sessionHistory) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`));
      return;
    }

    const items = await Promise.all(
      sessionHistory.history.map((item) =>
        item.source === 'external'
          ? buildExternalAttachmentRouteItem(id, item, sessionHistory.workingDir)
          : buildDetectedAttachmentRouteItem(id, sessionHistory.workingDir, item)
      )
    );

    return {
      success: true,
      data: {
        items,
        count: items.length,
      },
    };
  });

  // Metadata poll for a single registered attachment (re-stats for live
  // size/mtime as the underlying file is rewritten).
  app.get('/api/sessions/:id/attachments/:attachmentId', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    if (!(await resolveServableAttachmentPath(reply, record, workingDir))) return;
    const event = attachmentRecordToEvent(record);
    let size = record.size;
    let mtimeMs = record.mtimeMs;
    try {
      const stat = await fs.stat(record.filePath);
      size = stat.size;
      mtimeMs = stat.mtimeMs ?? mtimeMs;
    } catch {
      // File temporarily unavailable mid-write — keep cached values.
    }
    return {
      success: true,
      data: {
        path: record.fileName,
        size,
        mtimeMs,
        type: record.attachmentType,
        extension: record.extension,
        url: event.rawUrl,
        previewUrl: event.previewUrl,
        thumbnailUrl: event.thumbnailUrl,
        attachmentId: record.attachmentId,
        fileName: record.fileName,
      },
    };
  });

  // Serve the raw bytes of a registered attachment by id. Re-checks the
  // attachment-guard policy on every request (defense-in-depth) before streaming.
  app.get('/api/sessions/:id/attachments/:attachmentId/raw', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const { download } = req.query as { download?: string };
    const session = findSessionOrFail(ctx, id);
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, session.workingDir);
    if (!servePath) return;

    try {
      await serveRawFile(reply, servePath, record.fileName, record.extension, download === 'true');
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Serve a converted PDF preview of a registered attachment by id. Office docs
  // convert server-side; PDF/PNG/text redirect to the raw route.
  app.get('/api/sessions/:id/attachments/:attachmentId/preview', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;

    // Only Office formats need server-side conversion; PDF/PNG and text formats
    // (md/txt) preview directly from their raw bytes.
    if (record.extension !== 'docx' && record.extension !== 'pptx') {
      reply.redirect(`/api/sessions/${id}/attachments/${encodeURIComponent(attachmentId)}/raw`);
      return;
    }

    await serveConvertedPreview(reply, servePath, record.fileName, record.extension);
  });

  // Serve a first-page thumbnail of a registered attachment by id.
  app.get('/api/sessions/:id/attachments/:attachmentId/thumbnail', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;
    await serveThumbnail(reply, servePath, record.extension);
  });

  // Serve converted document previews for a workspace-relative path. DOCX/PPTX
  // are converted to PDF via LibreOffice; PDF/PNG/text preview through file-raw.
  app.get('/api/sessions/:id/file-preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    if (ext !== 'docx' && ext !== 'pptx') {
      reply.redirect(`/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`);
      return;
    }

    await serveConvertedPreview(reply, resolvedPath, filePath, ext);
  });

  // Serve a first-page thumbnail for a workspace-relative path.
  app.get('/api/sessions/:id/file-thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!isSupportedAttachmentExtension(ext)) {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Thumbnail is not supported for this file type'));
      return;
    }

    await serveThumbnail(reply, validated.resolvedPath, ext);
  });

  // Stream file content via tail -f (SSE endpoint)
  app.get('/api/sessions/:id/tail-file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines } = req.query as { path?: string; lines?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Set up SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track stream for cleanup
    const streamRef: { id?: string } = {};

    // Create the file stream
    const result = await fileStreamManager.createStream({
      sessionId: id,
      filePath,
      workingDir: session.workingDir,
      lines: lines ? parseInt(lines, 10) : undefined,
      onData: (data) => {
        // Send data as SSE event
        reply.raw.write(`data: ${JSON.stringify({ type: 'data', content: data })}\n\n`);
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
        reply.raw.end();
      },
      onError: (error) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      },
    });

    if (!result.success) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
      reply.raw.end();
      return;
    }

    streamRef.id = result.streamId;

    // Notify client of successful connection
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', streamId: result.streamId, filePath })}\n\n`);

    // Handle client disconnect
    req.raw.on('close', () => {
      if (streamRef.id) {
        fileStreamManager.closeStream(streamRef.id);
      }
    });
  });

  // Close a file stream. Returns { closed } rather than { success: closed } —
  // a top-level `success` key would collide with the envelope discriminator
  // (the preSerialization hook would pass `{success:false}` through as a
  // malformed error envelope instead of wrapping it).
  app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
    const { id, streamId } = req.params as { id: string; streamId: string };
    findSessionOrFail(ctx, id); // Validates session exists
    const closed = fileStreamManager.closeStream(streamId);
    return { closed };
  });
  // Session-scoped file download.
  // Uses the same realpath-based workspace boundary as file preview/raw routes;
  // the shared sensitive-path blocklist (../sensitive-path.js, also used by the
  // attachment guard) remains defense-in-depth, not the primary boundary.
  app.get('/api/download', async (req, reply) => {
    const { path: filePath, sessionId } = req.query as { path?: string; sessionId?: string };

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    if (!sessionId) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing sessionId parameter'));
      return;
    }

    const session = findSessionOrFail(ctx, sessionId);
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    // Check sensitive path blocklist
    if (isSensitivePath(resolvedPath)) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
      return;
    }

    try {
      const stat = await fs.stat(resolvedPath);

      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a file'));
        return;
      }

      // 50MB size limit
      const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
      if (stat.size > MAX_DOWNLOAD_SIZE) {
        reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              `File too large (${Math.round(stat.size / 1024 / 1024)}MB > 50MB limit)`
            )
          );
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        json: 'application/json',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        xml: 'application/xml',
        zip: 'application/zip',
        gz: 'application/gzip',
        tar: 'application/x-tar',
      };

      const filename = pathBasename(resolvedPath);
      const content = await fs.readFile(resolvedPath);
      // Bypass Fastify compression — write directly to raw response
      reply.raw.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': content.length,
      });
      reply.raw.end(content);
      return;
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });
}
