/**
 * @fileoverview In-memory attachment registry for live external document references.
 *
 * Session-local files keep using the existing workspace-scoped file routes. This
 * registry is only for explicit, live external attachments that need a stable ID
 * so browser requests never contain arbitrary absolute paths.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from './config/attachment-guard.js';
import { EDITABLE_EXTENSIONS } from './config/file-editing.js';
import { validateSessionFilePath } from './web/route-helpers.js';
import type { AttachmentDetectedEvent, AttachmentDetectedType } from './types.js';

/**
 * Playable media extensions, single-sourced here because the WORKSPACE preview
 * (`file-content`'s media classification) and the out-of-workspace attachment
 * path must agree on what plays. They diverged once: a video an agent wrote
 * inside the workspace played with a working scrub bar, while the same file in
 * `/tmp` was refused as an unsupported type, which reads as a bug rather than a
 * boundary. Serving is range-aware in both, which is what makes seeking work.
 */
export const VIDEO_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
export const AUDIO_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'aac',
  'flac',
  'opus',
]);

/**
 * Plain-text extensions, REUSING the File Viewer's edit-mode allowlist rather
 * than curating a second list that would drift from it. The rule reads: if the
 * viewer would open that file for editing inside the workspace, the same file
 * outside it can be read here. `svg` and `env` are absent from that list by
 * design and stay absent here.
 *
 * Why widen at all: the agent in the session can already `cat` any of these,
 * and every path-shaped surface (the picker, the workspace viewer) can already
 * show them. Refusing a `.log` an agent just wrote to `/tmp` bought no
 * confidentiality, it only made the click fail. The confidentiality gate is the
 * path guard that still runs on every registration (sensitive-file blocklist,
 * `/root` and `/etc` trees, realpath before the check), not the file's suffix.
 */
export const TEXT_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = EDITABLE_EXTENSIONS;

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'docx',
  'pptx',
  'md',
  'txt',
  ...VIDEO_ATTACHMENT_EXTENSIONS,
  ...AUDIO_ATTACHMENT_EXTENSIONS,
  ...TEXT_ATTACHMENT_EXTENSIONS,
]);

export type AttachmentSource = 'detected' | 'external';

export interface AttachmentRecord {
  attachmentId: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  extension: string;
  attachmentType: AttachmentDetectedType;
  size: number;
  mtimeMs: number;
  timestamp: number;
  source: AttachmentSource;
}

export interface AttachmentRegistrationResult extends AttachmentDetectedEvent {
  attachmentId: string;
  source: AttachmentSource;
  rawUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
}

export class AttachmentRegistrationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400
  ) {
    super(message);
  }
}

/** Per-session attachment cap. Bounds memory against a client (or a
 *  prompt-injected magic-link flood) registering unbounded distinct paths. */
const MAX_ATTACHMENTS_PER_SESSION = 200;

class AttachmentRegistry {
  private recordsBySession = new Map<string, Map<string, AttachmentRecord>>();

  register(record: AttachmentRecord): void {
    let records = this.recordsBySession.get(record.sessionId);
    if (!records) {
      records = new Map();
      this.recordsBySession.set(record.sessionId, records);
    }
    records.set(record.attachmentId, record);
    // Evict oldest (insertion-order) entries beyond the cap.
    while (records.size > MAX_ATTACHMENTS_PER_SESSION) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  }

  get(sessionId: string, attachmentId: string): AttachmentRecord | undefined {
    return this.recordsBySession.get(sessionId)?.get(attachmentId);
  }

  findByFilePath(sessionId: string, filePath: string): AttachmentRecord | undefined {
    const records = this.recordsBySession.get(sessionId);
    if (!records) return undefined;
    for (const record of records.values()) {
      if (record.filePath === filePath) return record;
    }
    return undefined;
  }

  clearSession(sessionId: string): void {
    this.recordsBySession.delete(sessionId);
  }
}

export const attachmentRegistry = new AttachmentRegistry();

export function isSupportedAttachmentExtension(extension: string): boolean {
  return SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension.toLowerCase().replace(/^\./, ''));
}

export function getAttachmentType(extension: string): AttachmentDetectedType {
  const normalized = extension.toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(normalized)) return 'image';
  if (VIDEO_ATTACHMENT_EXTENSIONS.has(normalized)) return 'video';
  if (AUDIO_ATTACHMENT_EXTENSIONS.has(normalized)) return 'audio';
  if (normalized === 'pdf') return 'pdf';
  if (normalized === 'pptx') return 'presentation';
  if (normalized === 'md') return 'markdown';
  // Everything else in the text family reads as text, including code and
  // config: the card and the preview both treat it as a plain-text file.
  if (normalized === 'txt' || TEXT_ATTACHMENT_EXTENSIONS.has(normalized)) return 'text';
  return 'document';
}

export function buildAttachmentRoutes(
  sessionId: string,
  attachmentId: string
): {
  rawUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
} {
  const encodedId = encodeURIComponent(attachmentId);
  return {
    rawUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/raw`,
    previewUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/preview`,
    thumbnailUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/thumbnail`,
  };
}

export function buildFileThumbnailRoute(sessionId: string, relativePath: string): string {
  return `/api/sessions/${sessionId}/file-thumbnail?path=${encodeURIComponent(relativePath)}`;
}

export function attachmentRecordToEvent(record: AttachmentRecord): AttachmentRegistrationResult {
  const routes = buildAttachmentRoutes(record.sessionId, record.attachmentId);
  return {
    sessionId: record.sessionId,
    filePath: record.fileName,
    relativePath: '',
    fileName: record.fileName,
    extension: record.extension,
    attachmentType: record.attachmentType,
    timestamp: record.timestamp,
    size: record.size,
    attachmentId: record.attachmentId,
    source: record.source,
    ...routes,
  };
}

/** Options for {@link registerExternalAttachment}. */
export interface RegisterExternalAttachmentOptions {
  /**
   * The registering session's working directory. Required to enforce workspace
   * confinement — either when the global mode is enabled
   * (`attachmentConfineToWorkspace` / `CODEMAN_ATTACHMENT_CONFINE`) or when
   * {@link forceWorkspaceConfinement} is set for this call.
   */
  sessionWorkingDir?: string;
  /**
   * Force workspace confinement for THIS registration regardless of the global
   * setting. Used by the terminal-output `codeman://attach` magic-link scanner:
   * terminal output is attacker-influenceable (a prompt-injected session can
   * print an arbitrary path), so passive magic links may only reference files
   * inside the session workspace. Deliberate cross-workspace attachment still
   * works through the explicit, Origin-guarded `POST /attachments` route and the
   * `codeman attach` CLI (which POSTs directly when a session id is known).
   */
  forceWorkspaceConfinement?: boolean;
}

export async function registerExternalAttachment(
  sessionId: string,
  requestedPath: string,
  options: RegisterExternalAttachmentOptions = {}
): Promise<AttachmentRegistrationResult> {
  if (!requestedPath || !isAbsolute(requestedPath)) {
    throw new AttachmentRegistrationError('Attachment path must be an absolute local path');
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(requestedPath);
  } catch {
    throw new AttachmentRegistrationError('Attachment file not found', 404);
  }

  // COD-53: enforce the active attachment-guard policy on the symlink-resolved
  // path before doing anything else.
  const guard = await loadAttachmentGuardConfig();

  if (guard.confineToWorkspace || options.forceWorkspaceConfinement) {
    // Workspace-confined: the file MUST resolve inside the session's workspace.
    // Applies when the global strict mode is on (opt-in, default OFF) OR when
    // the caller forces it for this registration (the magic-link scanner — see
    // forceWorkspaceConfinement). Strictly more restrictive than the blocklist.
    const workingDir = options.sessionWorkingDir;
    if (!workingDir || !validateSessionFilePath(workingDir, resolvedPath)) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
  }

  // Blocklist (DEFAULT, also applied alongside confinement as defense in
  // depth): pre-populated secret locations + the /root and /etc trees + any
  // operator-configured extra trees. Symlinks are already resolved above.
  // Cross-workspace attachment of non-blocked files stays allowed, so
  // codeman-publish and the ~/.codeman review loop keep working.
  if (isBlockedAttachmentPath(resolvedPath, guard.blockedTrees)) {
    throw new AttachmentRegistrationError('Access to this file is blocked', 403);
  }

  const extension = extname(resolvedPath).toLowerCase().replace(/^\./, '');
  if (!isSupportedAttachmentExtension(extension)) {
    throw new AttachmentRegistrationError('Unsupported attachment type');
  }

  const stat = await fs.stat(resolvedPath);
  if (typeof stat.isFile === 'function' && !stat.isFile()) {
    throw new AttachmentRegistrationError('Attachment path is not a file');
  }

  const existing = attachmentRegistry.findByFilePath(sessionId, resolvedPath);
  if (existing) {
    existing.size = stat.size;
    existing.mtimeMs = stat.mtimeMs ?? 0;
    existing.timestamp = Date.now();
    return attachmentRecordToEvent(existing);
  }

  const record: AttachmentRecord = {
    attachmentId: `att_${randomUUID()}`,
    sessionId,
    filePath: resolvedPath,
    fileName: basename(resolvedPath),
    extension,
    attachmentType: getAttachmentType(extension),
    size: stat.size,
    mtimeMs: stat.mtimeMs ?? 0,
    timestamp: Date.now(),
    source: 'external',
  };
  attachmentRegistry.register(record);
  return attachmentRecordToEvent(record);
}
