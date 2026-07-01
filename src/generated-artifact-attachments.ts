/**
 * @fileoverview Codex generated-artifact attachment registration.
 *
 * Codex image generation prints paths such as `Saved to: file://...`. For local
 * sessions these paths can be registered directly when they are safe. For remote
 * SSH sessions the path exists on the remote host, so Codeman first copies the
 * bytes into its instance data directory and then serves that cached copy through
 * the existing attachment registry.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, join, posix as posixPath } from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { dataPath } from './config/instance.js';
import { registerExternalAttachment, type AttachmentRegistrationResult } from './attachment-registry.js';
import { buildSshConnectionArgv, remoteSshTarget, shellescape } from './remote-hosts.js';
import type { SessionRemote } from './types/session.js';

const execFileAsync = promisify(execFile);

const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 30_000;

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
  remote?: SessionRemote;
}

export async function registerGeneratedArtifactAttachment(
  options: GeneratedArtifactRegistrationOptions
): Promise<AttachmentRegistrationResult> {
  if (options.remote) {
    if (!isAllowedGeneratedArtifactPath(options.filePath, options.remote.remotePath)) {
      throw new Error('Generated artifact path is outside allowed remote locations');
    }
    const localPath = await materializeRemoteGeneratedArtifact(options.sessionId, options.remote, options.filePath);
    return registerExternalAttachment(options.sessionId, localPath, { sessionWorkingDir: options.sessionWorkingDir });
  }

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

async function materializeRemoteGeneratedArtifact(
  sessionId: string,
  remote: SessionRemote,
  remotePath: string
): Promise<string> {
  const fileName = sanitizeCacheFileName(basename(remotePath));
  const digest = createHash('sha256')
    .update(`${remote.username}@${remote.host}:${remote.port ?? 22}:${remotePath}`)
    .digest('hex')
    .slice(0, 16);
  const cacheDir = dataPath('generated-artifacts', sessionId);
  await mkdir(cacheDir, { recursive: true });
  const localPath = join(cacheDir, `${digest}-${fileName}`);

  const args = buildRemoteGeneratedArtifactFetchArgs(remote, remotePath);
  const { stdout } = (await execFileAsync('ssh', args, {
    encoding: 'buffer',
    timeout: REMOTE_FETCH_TIMEOUT_MS,
    maxBuffer: MAX_GENERATED_ARTIFACT_BYTES,
  })) as { stdout: Buffer };

  await fs.writeFile(localPath, stdout);
  return localPath;
}

export function buildRemoteGeneratedArtifactFetchArgs(remote: SessionRemote, remotePath: string): string[] {
  return [
    ...buildSshConnectionArgv(remote),
    '-o',
    'ConnectTimeout=10',
    remoteSshTarget(remote),
    `cat -- ${shellescape(remotePath)}`,
  ];
}

function sanitizeCacheFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
}
