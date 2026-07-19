/**
 * @fileoverview Case management routes.
 * Handles CRUD for cases (directories under ~/codeman-cases and linked folders),
 * fix-plan reading, and ralph-wizard file serving.
 */

import { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, createReadStream } from 'node:fs';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { ApiResponse, CaseInfo } from '../../types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import {
  CreateCaseSchema,
  LinkCaseSchema,
  CaseOrderSchema,
  RemoteCaseLinkSchema,
  RemoteHostSchema,
  DockerCaseLinkSchema,
  DockerHostSchema,
  DockerExportSchema,
  DockerImportSchema,
} from '../schemas.js';
import { exportDockerCase, importDockerBundle, listDockerExports, exportBundleName } from '../../docker-export.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { writeHooksConfig } from '../../hooks-config.js';
import { CASES_DIR, SETTINGS_PATH, validatePathWithinBase, parseBody, readJsonConfig } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, ConfigPort } from '../ports/index.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import {
  checkDockerAvailable,
  checkDockerTmuxAvailable,
  DEFAULT_AGENT_IMAGE,
  dockerContainerName,
  dockerDisplayPath,
  readDockerCases,
  readDockerHosts,
  toSessionDocker,
  writeDockerCases,
  writeDockerHosts,
} from '../../docker-hosts.js';
import { buildDockerRemoveCommand } from '../../tmux-manager.js';
import {
  checkRemoteTmuxAvailable,
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  writeRemoteCases,
  writeRemoteHosts,
} from '../../remote-hosts.js';

const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CODEMAN_CONFIG_DIR = getDataDir();
const SAFE_CASE_NAME = /^[a-zA-Z0-9_-]+$/;
const DOCKER_EXPORTS_DIR = dataPath('docker-exports');
/** Auto-created host profile for the one-click "Run in Docker" case flow. */
const DEFAULT_DOCKER_HOST_ID = 'default';

/** App version for export manifests (best-effort read of package.json). */
const APP_VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string) || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** Read and parse linked-cases.json, returning empty object on missing/invalid file. */
async function readLinkedCases(): Promise<Record<string, string>> {
  return readJsonConfig<Record<string, string>>(LINKED_CASES_FILE, 'linked cases', {});
}

/** Resolve a case name to its directory path, checking linked cases first, then CASES_DIR. */
async function resolveCasePath(name: string): Promise<string> {
  const linkedCases = await readLinkedCases();
  if (linkedCases[name]) return linkedCases[name];
  return join(CASES_DIR, name);
}

export function registerCaseRoutes(app: FastifyInstance, ctx: EventPort & ConfigPort): void {
  // ═══════════════════════════════════════════════════════════════
  // Case CRUD (list, create, link, detail, fix-plan)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Cases ==========

  app.get('/api/cases', async (): Promise<CaseInfo[]> => {
    const cases: CaseInfo[] = [];

    // Get cases from CASES_DIR
    try {
      const entries = await fs.readdir(CASES_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && SAFE_CASE_NAME.test(e.name)) {
          cases.push({
            name: e.name,
            path: join(CASES_DIR, e.name),
            hasClaudeMd: existsSync(join(CASES_DIR, e.name, 'CLAUDE.md')),
            location: 'local',
          });
        }
      }
    } catch {
      // CASES_DIR may not exist yet
    }

    // Get linked cases
    const linkedCases = await readLinkedCases();
    const existingNames = new Set(cases.map((c) => c.name));
    for (const [name, path] of Object.entries(linkedCases)) {
      if (!existingNames.has(name) && SAFE_CASE_NAME.test(name) && existsSync(path)) {
        cases.push({
          name,
          path,
          hasClaudeMd: existsSync(join(path, 'CLAUDE.md')),
          linked: true,
          location: 'linked-local',
        });
      }
    }

    // Get remote cases
    const remoteHosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const remoteHostMap = new Map(remoteHosts.map((host) => [host.id, host]));
    for (const remoteCase of await readRemoteCases(CODEMAN_CONFIG_DIR)) {
      const host = remoteHostMap.get(remoteCase.hostId);
      if (!host || !SAFE_CASE_NAME.test(remoteCase.name)) continue;
      existingNames.add(remoteCase.name);
      const remoteCaseInfo: CaseInfo = {
        name: remoteCase.name,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remoteCase.remotePath,
        },
      };
      const existingIndex = cases.findIndex((item) => item.name === remoteCase.name);
      if (existingIndex === -1) {
        cases.push(remoteCaseInfo);
      } else {
        cases[existingIndex] = remoteCaseInfo;
      }
    }

    // Get docker cases
    const dockerHosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const dockerHostMap = new Map(dockerHosts.map((host) => [host.id, host]));
    for (const dockerCase of await readDockerCases(CODEMAN_CONFIG_DIR)) {
      const host = dockerHostMap.get(dockerCase.hostId);
      if (!host || !SAFE_CASE_NAME.test(dockerCase.name)) continue;
      existingNames.add(dockerCase.name);
      const container = dockerCase.container ?? dockerContainerName(dockerCase.name);
      const dockerCaseInfo: CaseInfo = {
        name: dockerCase.name,
        path: dockerDisplayPath({ container, path: dockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(dockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: dockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
        },
      };
      const existingIndex = cases.findIndex((item) => item.name === dockerCase.name);
      if (existingIndex === -1) {
        cases.push(dockerCaseInfo);
      } else {
        cases[existingIndex] = dockerCaseInfo;
      }
    }

    // Sort by persisted caseOrder from settings.json
    const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings', {});
    const caseOrder = Array.isArray(settings.caseOrder) ? (settings.caseOrder as string[]) : [];
    if (caseOrder.length > 0) {
      const orderMap = new Map(caseOrder.map((name, idx) => [name, idx]));
      cases.sort((a, b) => {
        const ai = orderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    }

    return cases;
  });

  app.post('/api/cases', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const { name, description } = parseBody(CreateCaseSchema, req.body);

    const casePath = validatePathWithinBase(name, CASES_DIR);
    if (!casePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    try {
      mkdirSync(casePath, { recursive: true });
      mkdirSync(join(casePath, 'src'), { recursive: true });

      // Read settings to get custom template path
      const templatePath = await ctx.getDefaultClaudeMdPath();
      const claudeMd = generateClaudeMd(name, description || '', templatePath);
      writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

      // Write .claude/settings.local.json with hooks for desktop notifications
      await writeHooksConfig(casePath);

      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });

      return { success: true, data: { case: { name, path: casePath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.get('/api/remote-hosts', async () => readRemoteHosts(CODEMAN_CONFIG_DIR));

  app.post('/api/remote-hosts', async (req): Promise<ApiResponse<{ host: unknown }>> => {
    const host = parseBody(RemoteHostSchema, req.body);
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Remote host already exists');
    }
    await writeRemoteHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/remote-hosts/:id', async (req): Promise<ApiResponse<{ host: unknown }>> => {
    const { id } = req.params as { id: string };
    const host = parseBody(RemoteHostSchema, { ...(req.body as object), id });
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
    const next = [...hosts];
    next[index] = host;
    await writeRemoteHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/remote-hosts/:id', async (req): Promise<ApiResponse<{ id: string }>> => {
    const { id } = req.params as { id: string };
    const cases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (cases.some((item) => item.hostId === id)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Remote host is still used by remote cases');
    }
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    await writeRemoteHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post('/api/cases/remote-link', async (req): Promise<ApiResponse<{ case: unknown }>> => {
    const remoteCase = { ...parseBody(RemoteCaseLinkSchema, req.body), type: 'remote' as const };
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const host = hosts.find((item) => item.id === remoteCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

    const linkedCases = await readLinkedCases();
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (
      remoteCases.some((item) => item.name === remoteCase.name) ||
      linkedCases[remoteCase.name] ||
      existsSync(join(CASES_DIR, remoteCase.name))
    ) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    // Courtesy validation: tmux is a hard prerequisite for durable remote sessions.
    // Verify it up-front so linking surfaces a clear error now instead of a dead pane
    // at first launch (also confirms the SSH connection actually works).
    const tmuxCheck = await checkRemoteTmuxAvailable(host);
    if (!tmuxCheck.ok) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'remote host is missing tmux');
    }

    await writeRemoteCases(CODEMAN_CONFIG_DIR, [...remoteCases, remoteCase]);
    ctx.broadcast(SseEvent.CaseLinked, { name: remoteCase.name, path: remoteCase.remotePath, type: 'remote' });
    return { success: true, data: { case: remoteCase } };
  });

  // ========== Docker hosts + docker cases (COD-Docker) ==========

  app.get('/api/docker-hosts', async () => readDockerHosts(CODEMAN_CONFIG_DIR));

  app.post('/api/docker-hosts', async (req): Promise<ApiResponse<{ host: unknown }>> => {
    const host = parseBody(DockerHostSchema, req.body);
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Docker host already exists');
    }
    await writeDockerHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/docker-hosts/:id', async (req): Promise<ApiResponse<{ host: unknown }>> => {
    const { id } = req.params as { id: string };
    const host = parseBody(DockerHostSchema, { ...(req.body as object), id });
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
    const next = [...hosts];
    next[index] = host;
    await writeDockerHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/docker-hosts/:id', async (req): Promise<ApiResponse<{ id: string }>> => {
    const { id } = req.params as { id: string };
    const cases = await readDockerCases(CODEMAN_CONFIG_DIR);
    if (cases.some((item) => item.hostId === id)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Docker host is still used by docker cases');
    }
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    await writeDockerHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post(
    '/api/cases/docker-link',
    async (req): Promise<ApiResponse<{ case: unknown; capsEnforced?: boolean; isDesktop?: boolean }>> => {
      const dockerCase = { ...parseBody(DockerCaseLinkSchema, req.body), type: 'docker' as const };
      const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
      const host = hosts.find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      if (
        dockerCases.some((item) => item.name === dockerCase.name) ||
        linkedCases[dockerCase.name] ||
        existsSync(join(CASES_DIR, dockerCase.name))
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // The workspace is a REAL host directory (bind-mounted into the container), so
      // create it now if missing. Scaffolding (.claude/settings.local.json + CLAUDE.md)
      // is written by quick-start on first launch, matching local-case behaviour.
      if (!existsSync(dockerCase.hostWorkspacePath)) {
        try {
          mkdirSync(dockerCase.hostWorkspacePath, { recursive: true });
        } catch (err) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            `Could not create workspace: ${getErrorMessage(err)}`
          );
        }
      }

      // Courtesy validation: docker daemon must be reachable AND the base image must
      // contain tmux (a hard prerequisite for durable in-container sessions). Surfaces
      // a clear error at link time instead of a dead pane on first launch.
      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const tmuxCheck = await checkDockerTmuxAvailable(toSessionDocker(host, dockerCase));
      if (!tmuxCheck.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'base image is missing tmux');
      }

      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, dockerCase]);
      ctx.broadcast(SseEvent.CaseLinked, {
        name: dockerCase.name,
        path: dockerCase.hostWorkspacePath,
        type: 'docker',
      });
      return {
        success: true,
        data: { case: dockerCase, capsEnforced: availability.capsEnforced, isDesktop: availability.isDesktop },
      };
    }
  );

  // One-click "Run in Docker": create a NORMAL case (folder in CASES_DIR, scaffolded)
  // AND link it to a hardened container with default settings, auto-provisioning a
  // shared `default` docker host so the user never touches host/image/network fields.
  app.post(
    '/api/cases/docker-quickcreate',
    async (req): Promise<ApiResponse<{ case: unknown; capsEnforced?: boolean; isDesktop?: boolean }>> => {
      const { name, description } = parseBody(CreateCaseSchema, req.body);
      const casePath = validatePathWithinBase(name, CASES_DIR);
      if (!casePath) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');

      // Collision across every case kind.
      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
      if (
        existsSync(casePath) ||
        dockerCases.some((item) => item.name === name) ||
        remoteCases.some((item) => item.name === name) ||
        linkedCases[name]
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // Auto-provision the shared `default` docker host (convenient, hardened defaults).
      const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
      let host = hosts.find((item) => item.id === DEFAULT_DOCKER_HOST_ID);
      if (!host) {
        host = {
          id: DEFAULT_DOCKER_HOST_ID,
          label: 'Default',
          image: DEFAULT_AGENT_IMAGE,
          network: 'bridge',
          mountCredentials: true,
          resumeOnStart: true,
          hooksEnabled: true,
        };
        await writeDockerHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
      }

      // Probe the daemon + base image BEFORE scaffolding, so a missing docker/image
      // surfaces a clear error instead of leaving an orphaned case folder.
      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const dockerCase = { name, type: 'docker' as const, hostId: host.id, hostWorkspacePath: casePath };
      const tmuxCheck = await checkDockerTmuxAvailable(toSessionDocker(host, dockerCase));
      if (!tmuxCheck.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          tmuxCheck.error || 'base image is missing tmux (build it: node scripts/build-agent-image.mjs)'
        );
      }

      // Scaffold the case folder exactly like a normal case.
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });
        const templatePath = await ctx.getDefaultClaudeMdPath();
        writeFileSync(join(casePath, 'CLAUDE.md'), generateClaudeMd(name, description || '', templatePath));
        await writeHooksConfig(casePath);
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }

      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, dockerCase]);
      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });
      ctx.broadcast(SseEvent.CaseLinked, { name, path: casePath, type: 'docker' });
      return {
        success: true,
        data: { case: dockerCase, capsEnforced: availability.capsEnforced, isDesktop: availability.isDesktop },
      };
    }
  );

  // ========== Docker export / import ==========

  // Export a docker case to a portable bundle. Runs in the BACKGROUND (a full image
  // save can take minutes) and broadcasts docker:exportComplete / docker:exportFailed.
  app.post('/api/docker-cases/:name/export', async (req): Promise<ApiResponse<{ started: true; bundle: string }>> => {
    const { name } = req.params as { name: string };
    const { mode = 'full' } = parseBody(DockerExportSchema, req.body ?? {});
    const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find((item) => item.name === name);
    if (!dockerCase) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker case not found');
    const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

    const sessionDocker = toSessionDocker(host, dockerCase);
    if (mode === 'full' && !sessionDocker.mountCredentials) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'full-image export is refused for a sealed container (its in-container login would ride the committed layer). Use a workspace-only export.'
      );
    }

    const timestamp = Date.now();
    const bundle = exportBundleName(name, timestamp, mode);
    // Fire-and-forget: the client watches for the SSE completion event.
    void exportDockerCase({
      docker: sessionDocker,
      caseName: name,
      timestamp,
      exportsDir: DOCKER_EXPORTS_DIR,
      mode,
      codemanVersion: APP_VERSION,
    })
      .then((result) => {
        ctx.broadcast(SseEvent.DockerExportComplete, {
          name,
          bundle: basename(result.bundlePath),
          sizeBytes: result.sizeBytes,
          mode,
        });
      })
      .catch((err) => {
        ctx.broadcast(SseEvent.DockerExportFailed, { name, mode, error: getErrorMessage(err) });
      });

    return { success: true, data: { started: true, bundle } };
  });

  app.get('/api/docker-exports', async (): Promise<ApiResponse<{ exports: unknown[] }>> => {
    return { success: true, data: { exports: await listDockerExports(DOCKER_EXPORTS_DIR) } };
  });

  // Download an export bundle (filename resolved WITHIN the exports dir — no traversal).
  app.get('/api/docker-exports/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid bundle filename');
    }
    const full = join(DOCKER_EXPORTS_DIR, filename);
    if (!existsSync(full)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Export not found');
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(full));
  });

  app.delete('/api/docker-exports/:filename', async (req): Promise<ApiResponse<{ filename: string }>> => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid bundle filename');
    }
    const full = join(DOCKER_EXPORTS_DIR, filename);
    if (!existsSync(full)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Export not found');
    await fs.rm(full, { force: true });
    return { success: true, data: { filename } };
  });

  // Import a bundle (already present in the exports dir) into a NEW docker case.
  app.post('/api/docker-cases/import', async (req): Promise<ApiResponse<{ case: unknown }>> => {
    const { bundle, newCaseName, destWorkspacePath } = parseBody(DockerImportSchema, req.body);
    const bundlePath = join(DOCKER_EXPORTS_DIR, bundle);
    if (!existsSync(bundlePath)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Bundle not found in exports dir');

    // Name-collision guard across ALL case kinds.
    const linkedCases = await readLinkedCases();
    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    if (
      dockerCases.some((item) => item.name === newCaseName) ||
      linkedCases[newCaseName] ||
      existsSync(join(CASES_DIR, newCaseName))
    ) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    const timestamp = Date.now();
    let result;
    try {
      result = await importDockerBundle({ bundlePath, destWorkspace: destWorkspacePath, engine: 'docker', timestamp });
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Import failed: ${getErrorMessage(err)}`);
    }

    // Create a dedicated docker host pointing at the quarantined imported image
    // (full mode) or the manifest's base image (workspace-only).
    const hostId = `imported-${newCaseName}`;
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    if (!hosts.some((h) => h.id === hostId)) {
      await writeDockerHosts(CODEMAN_CONFIG_DIR, [
        ...hosts,
        {
          id: hostId,
          label: `Imported: ${newCaseName}`,
          engine: result.manifest.engine,
          image: result.importedImage ?? result.manifest.image,
          network: (['bridge', 'none', 'custom'].includes(result.manifest.network)
            ? result.manifest.network
            : 'bridge') as 'bridge' | 'none' | 'custom',
        },
      ]);
    }
    const newCase = {
      name: newCaseName,
      type: 'docker' as const,
      hostId,
      hostWorkspacePath: destWorkspacePath,
      containerWorkdir: result.manifest.containerWorkdir,
    };
    await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, newCase]);
    ctx.broadcast(SseEvent.DockerImportComplete, { name: newCaseName, path: destWorkspacePath, type: 'docker' });
    return { success: true, data: { case: newCase } };
  });

  // Link an existing folder as a case
  app.post('/api/cases/link', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const { name, path: folderPath } = parseBody(LinkCaseSchema, req.body, 'Invalid request body');

    // Expand ~ to home directory
    const expandedPath = folderPath.startsWith('~') ? join(homedir(), folderPath.slice(1)) : folderPath;

    // Validate the folder exists
    if (!existsSync(expandedPath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${expandedPath}`);
    }

    // Check if case name already exists in CASES_DIR
    const casePath = join(CASES_DIR, name);
    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A case with this name already exists in codeman-cases.');
    }

    // Load existing linked cases
    const linkedCases = await readLinkedCases();

    // Check if name is already linked
    if (linkedCases[name]) {
      return createErrorResponse(
        ApiErrorCode.ALREADY_EXISTS,
        `Case "${name}" is already linked to ${linkedCases[name]}`
      );
    }

    // Save the linked case
    linkedCases[name] = expandedPath;
    try {
      const codemanDir = getDataDir();
      if (!existsSync(codemanDir)) {
        mkdirSync(codemanDir, { recursive: true });
      }
      await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
      ctx.broadcast(SseEvent.CaseLinked, { name, path: expandedPath });
      return { success: true, data: { case: { name, path: expandedPath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Delete / Unlink Case ==========

  app.delete('/api/cases/:name', async (req): Promise<ApiResponse<{ name: string }>> => {
    const { name } = req.params as { name: string };

    if (!validatePathWithinBase(name, CASES_DIR)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (remoteCases.some((item) => item.name === name)) {
      await writeRemoteCases(
        CODEMAN_CONFIG_DIR,
        remoteCases.filter((item) => item.name !== name)
      );
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'remote-unlinked' });
      return { success: true, data: { name } };
    }

    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    const dockerCase = dockerCases.find((item) => item.name === name);
    if (dockerCase) {
      await writeDockerCases(
        CODEMAN_CONFIG_DIR,
        dockerCases.filter((item) => item.name !== name)
      );
      // Best-effort `docker rm -f` the per-case container (case-delete is the
      // explicit teardown that removes it; the bind-mounted workspace survives).
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (host) {
        try {
          exec(buildDockerRemoveCommand(toSessionDocker(host, dockerCase)), { timeout: 15_000 }, () => {});
        } catch {
          /* best-effort — never blocks the unlink */
        }
      }
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'docker-unlinked' });
      return { success: true, data: { name } };
    }

    // Check linked cases first — unlink only, don't delete the actual directory
    const linkedCases = await readLinkedCases();
    if (linkedCases[name]) {
      delete linkedCases[name];
      try {
        await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
        ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'unlinked' });
        return { success: true, data: { name } };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    }

    // Case in CASES_DIR — delete the entire directory
    const casePath = join(CASES_DIR, name);
    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Case "${name}" not found`);
    }

    try {
      await fs.rm(casePath, { recursive: true, force: true });
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'deleted' });
      return { success: true, data: { name } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Reorder Cases ==========

  app.put('/api/cases/order', async (req): Promise<ApiResponse<{ order: string[] }>> => {
    const { order } = parseBody(CaseOrderSchema, req.body, 'Invalid order data');

    try {
      const dir = getDataDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
      } catch {
        /* ignore */
      }
      const merged = { ...existing, caseOrder: order };
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
      ctx.broadcast(SseEvent.CaseOrderChanged, { order });
      return { success: true, data: { order } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.get('/api/cases/:name', async (req) => {
    const { name } = req.params as { name: string };

    if (!validatePathWithinBase(name, CASES_DIR)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    const remoteCase = remoteCases.find((item) => item.name === name);
    if (remoteCase) {
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === remoteCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
      return {
        name,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remoteCase.remotePath,
        },
      };
    }

    const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find((item) => item.name === name);
    if (dockerCase) {
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      const container = dockerCase.container ?? dockerContainerName(dockerCase.name);
      return {
        name,
        path: dockerDisplayPath({ container, path: dockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(dockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: dockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
        },
      };
    }

    const casePath = await resolveCasePath(name);

    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }

    const linked = casePath !== join(CASES_DIR, name);
    return {
      name,
      path: casePath,
      hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
      ...(linked && { linked: true }),
    };
  });

  // Read @fix_plan.md from a case directory (for wizard to detect existing plans)
  app.get('/api/cases/:name/fix-plan', async (req) => {
    const { name } = req.params as { name: string };

    if (!validatePathWithinBase(name, CASES_DIR)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Get case path (check linked cases first, then CASES_DIR)
    const casePath = await resolveCasePath(name);

    const fixPlanPath = join(casePath, '@fix_plan.md');

    if (!existsSync(fixPlanPath)) {
      return { exists: false, content: null, todos: [] };
    }

    try {
      const content = await fs.readFile(fixPlanPath, 'utf-8');

      // Parse todos from the content (similar to ralph-tracker's importFixPlanMarkdown)
      const todos: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: string | null;
      }> = [];
      const todoPattern = /^-\s*\[([ xX-])\]\s*(.+)$/;
      const p0HeaderPattern = /^##\s*(High Priority|Critical|P0|Critical Path)/i;
      const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
      const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
      const completedHeaderPattern = /^##\s*Completed/i;

      let currentPriority: string | null = null;
      let inCompletedSection = false;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();

        if (p0HeaderPattern.test(trimmed)) {
          currentPriority = 'P0';
          inCompletedSection = false;
          continue;
        }
        if (p1HeaderPattern.test(trimmed)) {
          currentPriority = 'P1';
          inCompletedSection = false;
          continue;
        }
        if (p2HeaderPattern.test(trimmed)) {
          currentPriority = 'P2';
          inCompletedSection = false;
          continue;
        }
        if (completedHeaderPattern.test(trimmed)) {
          inCompletedSection = true;
          continue;
        }

        const match = trimmed.match(todoPattern);
        if (match) {
          const [, checkboxState, taskContent] = match;
          let status: 'pending' | 'in_progress' | 'completed';

          if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
            status = 'completed';
          } else if (checkboxState === '-') {
            status = 'in_progress';
          } else {
            status = 'pending';
          }

          todos.push({
            content: taskContent.trim(),
            status,
            priority: inCompletedSection ? null : currentPriority,
          });
        }
      }

      // Calculate stats in a single pass for better performance
      let pending = 0,
        inProgress = 0,
        completed = 0;
      for (const t of todos) {
        if (t.status === 'pending') pending++;
        else if (t.status === 'in_progress') inProgress++;
        else if (t.status === 'completed') completed++;
      }
      const stats = { total: todos.length, pending, inProgress, completed };

      return {
        exists: true,
        content,
        todos,
        stats,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read @fix_plan.md: ${err}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Ralph Wizard Files (per-case prompt/result serving)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Wizard Files ==========

  app.get('/api/cases/:caseName/ralph-wizard/files', async (req) => {
    const { caseName } = req.params as { caseName: string };
    if (!validatePathWithinBase(caseName, CASES_DIR)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const casePath = await resolveCasePath(caseName);

    const wizardDir = join(casePath, 'ralph-wizard');

    if (!existsSync(wizardDir)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Ralph wizard directory not found');
    }

    // List all subdirectories and their files
    const files: Array<{ agentType: string; promptFile?: string; resultFile?: string }> = [];
    const entries = readdirSync(wizardDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const agentDir = join(wizardDir, entry.name);
        const agentFiles: { agentType: string; promptFile?: string; resultFile?: string } = {
          agentType: entry.name,
        };

        if (existsSync(join(agentDir, 'prompt.md'))) {
          agentFiles.promptFile = `${entry.name}/prompt.md`;
        }
        if (existsSync(join(agentDir, 'result.json'))) {
          agentFiles.resultFile = `${entry.name}/result.json`;
        }

        if (agentFiles.promptFile || agentFiles.resultFile) {
          files.push(agentFiles);
        }
      }
    }

    return { success: true, data: { files, caseName } };
  });

  // Read a specific ralph-wizard file
  // Cache disabled to ensure fresh prompts when starting new plan generations
  app.get('/api/cases/:caseName/ralph-wizard/file/:filePath', async (req, reply) => {
    const { caseName, filePath } = req.params as { caseName: string; filePath: string };
    if (!validatePathWithinBase(caseName, CASES_DIR)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Prevent browser caching - prompts change between plan generations
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    const casePath = await resolveCasePath(caseName);

    const wizardDir = join(casePath, 'ralph-wizard');

    // Decode the file path (it may be URL encoded)
    const decodedPath = decodeURIComponent(filePath);
    const fullPath = join(wizardDir, decodedPath);

    // Security: ensure path is within wizard directory
    const resolvedPath = resolve(fullPath);
    const resolvedWizard = resolve(wizardDir);
    if (!resolvedPath.startsWith(resolvedWizard)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file path');
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
      throw err;
    }
    const isJson = filePath.endsWith('.json');

    // Parse JSON content safely (may contain invalid JSON or unescaped control characters)
    let parsed: unknown = null;
    if (isJson) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try repairing common JSON issues (unescaped control characters, trailing commas)
        try {
          let repaired = content;
          // Fix trailing commas before closing brackets
          repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
          // Fix unescaped control characters within JSON strings
          repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
            return match
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
              .replace(
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f]/g,
                (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
              );
          });
          parsed = JSON.parse(repaired);
        } catch {
          // Still invalid - return null for parsed, content available as raw string
        }
      }
    }

    return {
      success: true,
      data: {
        content,
        filePath: decodedPath,
        isJson,
        parsed,
      },
    };
  });
}
