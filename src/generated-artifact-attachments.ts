/**
 * @fileoverview Codex generated-artifact attachment registration.
 *
 * Codex image generation prints paths such as `Saved to: file://...`. These
 * paths are registered directly when they fall within allowed locations (workspace
 * or well-known Codex generated-image directories).
 */

import { posix as posixPath } from 'node:path';
import { registerExternalAttachment, type AttachmentRegistrationResult } from './attachment-registry.js';

const CODEX_GENERATED_DIR_MARKERS = [
  '/.codex-personal/generated_images/',
  '/.codex/generated_images/',
  '/.codex-personal/generated_artifacts/',
  '/.codex/generated_artifacts/',
];

export interface GeneratedArtifactRegistrationOptions {
  sessionId: string;
  filePath: string;
  sessionWorkingDir: string;
}

export async function registerGeneratedArtifactAttachment(
  options: GeneratedArtifactRegistrationOptions
): Promise<AttachmentRegistrationResult> {
  const forceWorkspaceConfinement = !isAllowedGeneratedArtifactPath(options.filePath, options.sessionWorkingDir);
  return registerExternalAttachment(options.sessionId, options.filePath, {
    sessionWorkingDir: options.sessionWorkingDir,
    forceWorkspaceConfinement,
  });
}

export function isAllowedGeneratedArtifactPath(filePath: string, workingDir: string): boolean {
  const normalizedPath = posixPath.normalize(filePath);
  if (isPathInside(normalizedPath, workingDir)) return true;
  return CODEX_GENERATED_DIR_MARKERS.some((marker) => normalizedPath.includes(marker));
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const normalizedRoot = ensureTrailingSlash(posixPath.normalize(rootPath));
  const normalizedPath = posixPath.normalize(filePath);
  return normalizedPath === normalizedRoot.slice(0, -1) || normalizedPath.startsWith(normalizedRoot);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
