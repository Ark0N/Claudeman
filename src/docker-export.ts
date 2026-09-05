/**
 * @fileoverview Docker case export / import: move a container (toolchain + any
 * in-image changes) PLUS its workspace to another machine as one portable
 * `.codeman-container.tgz`, and restore it.
 *
 * A full-image export = `docker commit` the running container to an image ->
 * `docker save` that image -> tar the bind-mounted workspace -> a manifest, all
 * bundled into one gzip tarball. A workspace-only export skips the image (fast,
 * files-only). Import validates the manifest + per-member checksums, extracts the
 * workspace with a path-traversal guard, `docker load`s the image and RE-TAGS it
 * into a quarantined namespace (never overwriting a local tag), and hands the
 * caller enough to recreate a hardened case on the destination.
 *
 * Safety (all from the design critic): pause the container spanning the workspace
 * tar AND the commit so the two artifacts are mutually consistent; a free-space
 * precheck (a full docker graph wedges EVERY session on the host); `docker rmi`
 * the intermediate image in a finally; sealed containers refuse a full-image
 * export (an in-container login would ride the committed layer); import rejects
 * absolute / `..` tar members and checksum mismatches. Bounded by
 * runWithConversionLimit so N exports cannot fork-bomb the host.
 *
 * @module docker-export
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { DockerEngine, SessionDocker } from './types.js';
import { runWithConversionLimit } from './document-conversion-limiter.js';
import { isAdoptedContainer } from './docker-hosts.js';

const IS_TEST_MODE = !!process.env.VITEST;

/** Refuse to export when the target filesystem has less than this free (a full graph wedges the daemon). */
export const DOCKER_EXPORT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Manifest schema version (bump on any breaking field change). */
export const DOCKER_EXPORT_SCHEMA = 1;

export type DockerExportMode = 'full' | 'workspace';

export interface DockerExportManifest {
  schemaVersion: number;
  caseName: string;
  mode: DockerExportMode;
  engine: DockerEngine;
  image: string;
  containerWorkdir: string;
  network: string;
  createdAt: number;
  codemanVersion: string;
  mountCredentials: boolean;
  /** True when the bundle provably carries no credentials (convenient-mode workspace, or a full image whose creds were bind-mounted and thus never committed). */
  secretFree: boolean;
  /** sha256 of each bundle member that is present. */
  checksums: { image?: string; workspace?: string };
}

// ========== Pure helpers (unit-tested) ==========

/** Raw argv prefix for the engine (NO shell escaping — used with spawn). */
export function dockerArgv(docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>): string[] {
  const argv: string[] = [docker.engine === 'podman' ? 'podman' : 'docker'];
  if (docker.context) argv.push('--context', docker.context);
  if (docker.daemonHost) argv.push('-H', docker.daemonHost);
  return argv;
}

/** Portable bundle filename for a case export. */
export function exportBundleName(caseName: string, timestamp: number, mode: DockerExportMode): string {
  const suffix = mode === 'workspace' ? 'workspace' : 'container';
  return `${caseName}-${timestamp}.codeman-${suffix}.tgz`;
}

/** Quarantined image tag for an imported bundle (never overwrites a local tag). */
export function importedImageTag(caseName: string, timestamp: number): string {
  return `codeman/imported-${caseName}:${timestamp}`;
}

/** Intermediate commit tag for a full-image export (unique per export, rmi'd in finally). */
export function exportImageTag(caseName: string, timestamp: number): string {
  return `codeman/export-${caseName}:${timestamp}`;
}

/**
 * Reject a tar member path that would escape the extraction root (absolute path
 * or a `..` component). The import-side traversal guard.
 */
export function isSafeTarMember(member: string): boolean {
  const trimmed = member.trim();
  if (!trimmed || trimmed === './') return true;
  if (trimmed.startsWith('/')) return false;
  // Normalize separators and check each component.
  return !trimmed.split('/').some((part) => part === '..');
}

/** Parse the image id/ref from `docker load` output ("Loaded image: x" / "Loaded image ID: sha256:..."). */
export function parseLoadedImageRef(loadOutput: string): string | null {
  const idMatch = loadOutput.match(/Loaded image ID:\s*(sha256:[0-9a-f]+)/i);
  if (idMatch) return idMatch[1];
  const refMatch = loadOutput.match(/Loaded image:\s*(\S+)/i);
  if (refMatch) return refMatch[1];
  return null;
}

/**
 * Validate an imported bundle's manifest BEFORE any of its fields are trusted.
 * A bundle is cross-machine input (potentially authored by someone else), and its
 * fields flow into stored host/case config that the schema layer never sees:
 * `engine` becomes the probe/launch binary selector, `image`/`containerWorkdir`
 * reach the shellescaped launch string, `network` is a create arg. Mirror the
 * DockerHostSchema/DockerCaseLinkSchema constraints here (throwing, since this is
 * not a web-layer module). Exported for unit tests.
 */
export function validateImportManifest(manifest: DockerExportManifest): void {
  const fail = (msg: string): never => {
    throw new Error(`invalid bundle manifest: ${msg}`);
  };
  if (manifest.schemaVersion !== DOCKER_EXPORT_SCHEMA) {
    fail(`unsupported export schema version ${manifest.schemaVersion} (expected ${DOCKER_EXPORT_SCHEMA})`);
  }
  if (manifest.mode !== 'full' && manifest.mode !== 'workspace') fail(`unknown mode ${String(manifest.mode)}`);
  if (manifest.engine !== 'docker' && manifest.engine !== 'podman') fail(`unknown engine ${String(manifest.engine)}`);
  if (typeof manifest.caseName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(manifest.caseName)) fail('bad caseName');
  if (
    typeof manifest.image !== 'string' ||
    manifest.image.length > 512 ||
    !/^[a-zA-Z0-9][\w./:@-]*$/.test(manifest.image)
  ) {
    fail('bad image reference');
  }
  if (
    typeof manifest.containerWorkdir !== 'string' ||
    manifest.containerWorkdir.length > 2000 ||
    !manifest.containerWorkdir.startsWith('/') ||
    // comma: --mount specs are comma-delimited CSV; shell escaping cannot protect it
    /[`$\\"'\n\r;&|<>,]/.test(manifest.containerWorkdir)
  ) {
    fail('bad containerWorkdir');
  }
  if (!['bridge', 'none', 'custom'].includes(manifest.network)) fail(`unknown network ${String(manifest.network)}`);
  if (typeof manifest.checksums !== 'object' || manifest.checksums === null) fail('missing checksums');
}

// ========== IO helpers ==========

function run(
  cmd: string,
  args: string[],
  opts: { timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${opts.timeout}ms`));
      }, opts.timeout);
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Stream `docker save <tag>` stdout to a raw tar file (no shell, no double-gzip).
 * Uses stream `pipeline` so completion means the write stream is FULLY flushed to
 * disk (a naive child 'close' resolves before the last chunks land, truncating the
 * file — a real bug caught in end-to-end testing), AND waits for a clean exit code.
 */
async function saveImageToTar(argv: string[], tag: string, outPath: string): Promise<void> {
  const child = spawn(argv[0], [...argv.slice(1), 'save', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker save exited ${code}: ${stderr.trim()}`))
    );
  });
  // pipeline resolves only after the destination has fully flushed.
  await Promise.all([pipeline(child.stdout, createWriteStream(outPath)), exited]);
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function freeBytes(path: string): Promise<number> {
  try {
    const stat = await fs.statfs(path);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return Number.POSITIVE_INFINITY; // statfs unsupported — don't block
  }
}

async function isContainerRunning(argv: string[], container: string): Promise<boolean> {
  try {
    const { stdout } = await run(argv[0], [...argv.slice(1), 'inspect', '-f', '{{.State.Running}}', container], {
      timeout: 15_000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export interface ExportResult {
  bundlePath: string;
  manifest: DockerExportManifest;
  sizeBytes: number;
}

/**
 * Export a docker case to a portable bundle. Bounded by runWithConversionLimit.
 * `full` mode commits + saves the image AND tars the workspace; `workspace` mode
 * tars just the workspace. The container is paused across the artifact capture so
 * image and workspace are mutually consistent.
 */
export async function exportDockerCase(params: {
  docker: SessionDocker;
  caseName: string;
  timestamp: number;
  exportsDir: string;
  mode: DockerExportMode;
  codemanVersion: string;
}): Promise<ExportResult> {
  const { docker, caseName, timestamp, exportsDir, mode, codemanVersion } = params;

  if (mode === 'full' && !docker.mountCredentials) {
    throw new Error(
      'full-image export is refused for a sealed (mountCredentials:false) container: an in-container login would ride the committed image layer. Use a workspace-only export.'
    );
  }

  if (IS_TEST_MODE) {
    // No real docker/tar under vitest — return a deterministic stub.
    const manifest: DockerExportManifest = {
      schemaVersion: DOCKER_EXPORT_SCHEMA,
      caseName,
      mode,
      engine: docker.engine,
      image: docker.image,
      containerWorkdir: docker.containerWorkdir,
      network: docker.network,
      createdAt: timestamp,
      codemanVersion,
      mountCredentials: docker.mountCredentials,
      secretFree: true,
      checksums: {},
    };
    return { bundlePath: join(exportsDir, exportBundleName(caseName, timestamp, mode)), manifest, sizeBytes: 0 };
  }

  return runWithConversionLimit(async () => {
    if (!existsSync(exportsDir)) mkdirSync(exportsDir, { recursive: true });

    const free = await freeBytes(exportsDir);
    if (free < DOCKER_EXPORT_MIN_FREE_BYTES) {
      throw new Error(
        `not enough free space to export (need >= ${Math.round(DOCKER_EXPORT_MIN_FREE_BYTES / 1e9)}GB, have ${Math.round(free / 1e9)}GB). A full docker graph wedges every session on the host.`
      );
    }

    const argv = dockerArgv(docker);
    const bundlePath = join(exportsDir, exportBundleName(caseName, timestamp, mode));
    const stageDir = join(exportsDir, `.stage-${caseName}-${timestamp}`);
    mkdirSync(stageDir, { recursive: true });
    // ⚠️ NEVER pause an ADOPTED container. The freeze exists only to make the committed
    // image and the workspace tar mutually consistent, and it is a lifecycle mutation on a
    // container that belongs to the user — it stops their processes for however long the
    // tar takes. A workspace-only export of an adopted case therefore accepts a live
    // filesystem, the same guarantee `tar` gives on any running host directory. Full-image
    // export is refused for an adopted case at the route, before reaching here.
    const wasRunning = !isAdoptedContainer(docker) && (await isContainerRunning(argv, docker.containerName));
    let commitTag: string | undefined;

    try {
      if (wasRunning) {
        await run(argv[0], [...argv.slice(1), 'pause', docker.containerName], { timeout: 30_000 }).catch(() => {});
      }

      const checksums: DockerExportManifest['checksums'] = {};

      if (mode === 'full') {
        commitTag = exportImageTag(caseName, timestamp);
        // Blank instance-specific committed env so the image carries no stale host refs.
        await run(
          argv[0],
          [
            ...argv.slice(1),
            'commit',
            '-c',
            'ENV CODEMAN_API_URL=',
            '-c',
            'ENV CODEMAN_HOOK_SECRET_FILE=',
            docker.containerName,
            commitTag,
          ],
          { timeout: 300_000 }
        );
        const imageTar = join(stageDir, 'image.tar');
        await saveImageToTar(argv, commitTag, imageTar);
        checksums.image = await sha256File(imageTar);
      }

      const workspaceTar = join(stageDir, 'workspace.tar');
      await run('tar', ['-cf', workspaceTar, '-C', docker.hostWorkspacePath, '.'], { timeout: 300_000 });
      checksums.workspace = await sha256File(workspaceTar);

      const manifest: DockerExportManifest = {
        schemaVersion: DOCKER_EXPORT_SCHEMA,
        caseName,
        mode,
        engine: docker.engine,
        image: docker.image,
        containerWorkdir: docker.containerWorkdir,
        network: docker.network,
        createdAt: timestamp,
        codemanVersion,
        mountCredentials: docker.mountCredentials,
        // Convenient mode keeps creds on bind mounts (never committed), so the bundle is secret-free.
        secretFree: docker.mountCredentials,
        checksums,
      };
      await fs.writeFile(join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const members =
        mode === 'full' ? ['manifest.json', 'image.tar', 'workspace.tar'] : ['manifest.json', 'workspace.tar'];
      await run('tar', ['-czf', bundlePath, '-C', stageDir, ...members], { timeout: 300_000 });

      const stat = await fs.stat(bundlePath);
      return { bundlePath, manifest, sizeBytes: stat.size };
    } finally {
      // Always remove the intermediate image + stage dir, and unpause.
      if (commitTag) {
        await run(argv[0], [...argv.slice(1), 'rmi', commitTag], { timeout: 60_000 }).catch(() => {});
      }
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      if (wasRunning) {
        await run(argv[0], [...argv.slice(1), 'unpause', docker.containerName], { timeout: 30_000 }).catch(() => {});
      }
    }
  });
}

export interface ImportResult {
  manifest: DockerExportManifest;
  /** Quarantined image ref the destination case should use (full mode only). */
  importedImage?: string;
  /** Directory the workspace was extracted into. */
  workspacePath: string;
}

/**
 * Import a bundle produced by exportDockerCase: validate the manifest + per-member
 * checksums, extract the workspace (traversal-guarded) into destWorkspace, and, in
 * full mode, `docker load` the image and re-tag it into a quarantined namespace.
 */
export async function importDockerBundle(params: {
  bundlePath: string;
  destWorkspace: string;
  engine: DockerEngine;
  timestamp: number;
  /** Schema-validated destination case name; the quarantine tag derives from THIS,
   *  never from the (attacker-authored) manifest.caseName. */
  newCaseName: string;
}): Promise<ImportResult> {
  const { bundlePath, destWorkspace, engine, timestamp, newCaseName } = params;
  const argv: string[] = [engine === 'podman' ? 'podman' : 'docker'];

  if (IS_TEST_MODE) {
    const raw = await fs.readFile(bundlePath, 'utf-8').catch(() => '{}');
    const manifest = JSON.parse(raw) as DockerExportManifest;
    validateImportManifest(manifest);
    return { manifest, workspacePath: destWorkspace };
  }

  const stageDir = `${destWorkspace}.import-stage-${timestamp}`;
  mkdirSync(stageDir, { recursive: true });
  try {
    // Outer-bundle traversal guard (defense in depth: GNU/bsd tar already refuse
    // `..`/absolute members by default, but the bundle is cross-machine input).
    const { stdout: bundleMembers } = await run('tar', ['-tzf', bundlePath], { timeout: 60_000 });
    for (const member of bundleMembers.split('\n').filter(Boolean)) {
      if (!isSafeTarMember(member)) throw new Error(`unsafe path in bundle archive: ${member}`);
    }
    await run('tar', ['--no-same-owner', '-xzf', bundlePath, '-C', stageDir], { timeout: 300_000 });

    const manifestRaw = await fs.readFile(join(stageDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as DockerExportManifest;
    validateImportManifest(manifest);

    // Integrity: verify checksums before trusting any member.
    const workspaceTar = join(stageDir, 'workspace.tar');
    if (manifest.checksums.workspace) {
      const actual = await sha256File(workspaceTar);
      if (actual !== manifest.checksums.workspace)
        throw new Error('workspace checksum mismatch (corrupt or tampered bundle)');
    }

    // Traversal guard: reject absolute / `..` members before extraction.
    const { stdout: memberList } = await run('tar', ['-tf', workspaceTar], { timeout: 60_000 });
    for (const member of memberList.split('\n').filter(Boolean)) {
      if (!isSafeTarMember(member)) throw new Error(`unsafe path in workspace archive: ${member}`);
    }
    mkdirSync(destWorkspace, { recursive: true });
    await run('tar', ['--no-same-owner', '-xf', workspaceTar, '-C', destWorkspace], { timeout: 300_000 });

    let importedImage: string | undefined;
    if (manifest.mode === 'full') {
      const imageTar = join(stageDir, 'image.tar');
      if (manifest.checksums.image) {
        const actual = await sha256File(imageTar);
        if (actual !== manifest.checksums.image)
          throw new Error('image checksum mismatch (corrupt or tampered bundle)');
      }
      const { stdout } = await run(argv[0], [...argv.slice(1), 'load', '-i', imageTar], { timeout: 300_000 });
      const loadedRef = parseLoadedImageRef(stdout);
      if (!loadedRef) throw new Error('could not determine loaded image ref');
      // Quarantine: re-tag by the loaded ref/id, never trusting the bundle's original
      // tag; the tag name derives from the caller's schema-validated newCaseName.
      importedImage = importedImageTag(newCaseName, timestamp);
      await run(argv[0], [...argv.slice(1), 'tag', loadedRef, importedImage], { timeout: 60_000 });
    }

    return { manifest, importedImage, workspacePath: destWorkspace };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** List export bundles in the exports dir (newest first), with size + mtime. */
export async function listDockerExports(
  exportsDir: string
): Promise<Array<{ name: string; sizeBytes: number; mtimeMs: number }>> {
  if (!existsSync(exportsDir)) return [];
  const entries = await fs.readdir(exportsDir).catch(() => [] as string[]);
  const out: Array<{ name: string; sizeBytes: number; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.endsWith('.tgz')) continue;
    try {
      const stat = await fs.stat(join(exportsDir, name));
      out.push({ name: basename(name), sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
