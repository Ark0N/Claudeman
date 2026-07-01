/**
 * @fileoverview Parses terminal magic links that request attachment cards.
 */

import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedAttachmentExtension } from './attachment-registry.js';

const MAGIC_LINK_RE = /codeman:\/\/attach\?([^\s<>"']+)/g;
const CODEX_SAVED_FILE_RE = /\bSaved to:\s*(file:\/\/[^\s<>"']+)/gi;

export interface TerminalAttachmentRequest {
  path: string;
  source: 'external' | 'codex-generated';
}

export function parseAttachmentMagicLinks(data: string): string[] {
  return parseMagicAttachmentRequests(data).map((request) => request.path);
}

export function parseTerminalAttachmentRequests(data: string): TerminalAttachmentRequest[] {
  const results: TerminalAttachmentRequest[] = [];
  const seen = new Set<string>();

  for (const request of [...parseMagicAttachmentRequests(data), ...parseCodexGeneratedArtifactRequests(data)]) {
    const key = `${request.source}:${request.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(request);
  }

  return results;
}

function parseMagicAttachmentRequests(data: string): TerminalAttachmentRequest[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const match of data.matchAll(MAGIC_LINK_RE)) {
    const query = trimTrailingPunctuation(match[1] || '');
    try {
      const params = new URLSearchParams(query);
      const filePath = params.get('path');
      if (!filePath || !isAbsolute(filePath)) continue;
      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      if (!isSupportedAttachmentExtension(extension)) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      results.push(filePath);
    } catch {
      // Ignore malformed terminal text. Magic links are advisory.
    }
  }

  return results.map((path) => ({ path, source: 'external' }));
}

function parseCodexGeneratedArtifactRequests(data: string): TerminalAttachmentRequest[] {
  const results: TerminalAttachmentRequest[] = [];
  const seen = new Set<string>();

  for (const match of data.matchAll(CODEX_SAVED_FILE_RE)) {
    const rawUrl = trimTrailingPunctuation(match[1] || '');
    try {
      const filePath = fileURLToPath(rawUrl);
      if (!isAbsolute(filePath)) continue;
      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      if (!isSupportedAttachmentExtension(extension)) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      results.push({ path: filePath, source: 'codex-generated' });
    } catch {
      // Ignore malformed terminal text. Generated-artifact links are advisory.
    }
  }

  return results;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, '');
}
