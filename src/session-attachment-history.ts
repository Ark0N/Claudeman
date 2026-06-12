import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { SessionAttachmentHistoryItem } from './types/session.js';
import type { AttachmentDetectedEvent } from './types/tools.js';
import { getAttachmentType } from './attachment-registry.js';

export const ATTACHMENT_HISTORY_LIMIT = 100;

export interface ExternalAttachmentHistoryInput {
  sessionId: string;
  externalPath: string;
  fileName?: string;
  extension?: string;
  size: number;
  mtimeMs?: number;
  timestamp?: number;
}

export function normalizeAttachmentExtension(extensionOrPath: string): string {
  const value = extensionOrPath.startsWith('.') ? extensionOrPath : extname(extensionOrPath) || extensionOrPath;
  return value.toLowerCase().replace(/^\./, '');
}

function historyKey(item: SessionAttachmentHistoryItem): string {
  if (item.source === 'external' && item.externalPath) {
    return `external:${item.externalPath}`;
  }
  return `detected:${item.relativePath || item.fileName}`;
}

function safeExternalHistoryId(item: SessionAttachmentHistoryItem): string {
  const source = item.externalPath || item.id || item.fileName;
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `external:${digest}:${item.fileName}`;
}

export function sanitizeAttachmentHistoryItem(item: SessionAttachmentHistoryItem): SessionAttachmentHistoryItem {
  const { externalPath: _externalPath, ...safe } = item;
  return {
    ...safe,
    id: item.source === 'external' ? safeExternalHistoryId(item) : item.id,
  };
}

export function sanitizeAttachmentHistory(
  history: readonly SessionAttachmentHistoryItem[]
): SessionAttachmentHistoryItem[] {
  return history.map(sanitizeAttachmentHistoryItem);
}

export function upsertAttachmentHistory(
  history: readonly SessionAttachmentHistoryItem[],
  item: SessionAttachmentHistoryItem
): SessionAttachmentHistoryItem[] {
  const nextKey = historyKey(item);
  return [item, ...history.filter((existing) => historyKey(existing) !== nextKey)].slice(0, ATTACHMENT_HISTORY_LIMIT);
}

export function buildDetectedAttachmentHistoryItem(event: AttachmentDetectedEvent): SessionAttachmentHistoryItem {
  return {
    id: `detected:${event.relativePath || event.fileName}`,
    sessionId: event.sessionId,
    fileName: event.fileName,
    extension: normalizeAttachmentExtension(event.extension),
    attachmentType: event.attachmentType,
    size: event.size,
    mtimeMs: 0,
    timestamp: event.timestamp,
    source: 'detected',
    relativePath: event.relativePath,
  };
}

export function buildExternalAttachmentHistoryItem(
  input: ExternalAttachmentHistoryInput
): SessionAttachmentHistoryItem {
  const extension = normalizeAttachmentExtension(input.extension || input.fileName || input.externalPath);
  return {
    id: `external:${createHash('sha256').update(input.externalPath).digest('hex').slice(0, 16)}:${
      input.fileName || basename(input.externalPath)
    }`,
    sessionId: input.sessionId,
    fileName: input.fileName || basename(input.externalPath),
    extension,
    attachmentType: getAttachmentType(extension),
    size: input.size,
    mtimeMs: input.mtimeMs ?? 0,
    timestamp: input.timestamp ?? Date.now(),
    source: 'external',
    externalPath: input.externalPath,
  };
}
