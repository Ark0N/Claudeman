/**
 * @fileoverview Session management routes.
 * Covers session CRUD, input/output, terminal buffer, quick-start, quick-run,
 * auto-clear, auto-compact, image watcher, flicker filter, and logout.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type SessionColor,
  type CodexConfig,
  type GeminiConfig,
  type AntigravityConfig,
} from '../../types.js';
import { Session, isAltScreenStripMode } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import {
  CreateSessionSchema,
  SessionNameSchema,
  SessionColorSchema,
  RunPromptSchema,
  SessionInputWithLimitSchema,
  ResizeSchema,
  AutoClearSchema,
  AutoCompactSchema,
  AutoResumeSchema,
  PinSessionSchema,
  ImageWatcherSchema,
  FlickerFilterSchema,
  QuickRunSchema,
  QuickStartSchema,
  InteractiveStartSchema,
  SessionOrderUpdateSchema,
} from '../schemas.js';
import { mergeSessionOrder } from '../../session-order.js';
import {
  autoConfigureRalph,
  canAccessOwned,
  CASES_DIR,
  findSessionOrFail,
  getAuthUser,
  isAdmin,
  isWorkingDirAllowed,
  ownerFor,
  parseBody,
  persistAndBroadcastSession,
  resolveCasesDir,
  sessionCapacityMessage,
  SETTINGS_PATH,
  validatePathWithinBase,
} from '../route-helpers.js';
import { canUsernameRunPrivilegedCommands, resolveClaudeModeForUsername } from '../../user-store.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import {
  writeHooksConfig,
  updateCaseModel,
  stripCaseEnvKeys,
  applyStatusLineConfig,
  refreshStaleCodemanHooks,
} from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { imageWatcher } from '../../image-watcher.js';
import { convertHeicToJpeg } from '../heic-jpeg-converter.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import {
  mergeUnifiedSessions,
  filterAndPaginate,
  type LiveSessionInput,
  type PersistedSessionInput,
  type LifecycleInput,
  type HistoryInput,
  type MuxStatInput,
} from '../../services/unified-session-service.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort } from '../ports/index.js';
import { RunSummaryTracker } from '../../run-summary.js';

import { MAX_INPUT_LENGTH, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js';
import { MAX_PASTE_IMAGE_BYTES } from '../../config/buffer-limits.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import {
  checkRemoteTmuxAvailable,
  readRemoteCases,
  readRemoteHosts,
  toAttachedSessionRemote,
  toSessionRemote,
} from '../../remote-hosts.js';
import {
  checkDockerAvailable,
  checkDockerConfigDrift,
  checkDockerTmuxAvailable,
  ensureAgentBaseImage,
  DEFAULT_AGENT_IMAGE,
  persistDockerCaseClaudeSessionId,
  readDockerCases,
  readDockerHosts,
  toSessionDocker,
} from '../../docker-hosts.js';
import { LRUMap } from '../../utils/lru-map.js';

// Path to linked-cases registry (same file used by case-routes resolveCasePath)
const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CODEMAN_CONFIG_DIR = getDataDir();

// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
// eslint-disable-next-line no-control-regex
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

/**
 * Match xterm alternate-screen mode toggles + the standalone scrollback-erase.
 *
 * - DECSET/DECRST 47, 1047, 1049 = enter/exit alternate screen buffer
 *   (1049 also saves cursor and clears the alt buffer).
 * - CSI 3 J = erase saved lines (scrollback).
 *
 * Codex AND Claude Code emit `\x1b[?1049h` and clear-scrollback sequences (the
 * latter intermittently, e.g. full-screen pickers/dialogs). xterm.js obeys them
 * by switching to the alt buffer (no native scrollback) and wiping saved lines,
 * so the user's conversation history disappears on every tab switch / pane
 * refresh (and scroll-up breaks live). Stripping these from the replayed byte
 * stream keeps everything in the main buffer with scrollback intact. Mirrors the
 * live-stream strip in Session._handleTerminalOutput (isAltScreenStripMode).
 */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_TOGGLE_PATTERN = /\x1b\[\?(?:47|1047|1049)[hl]/g;
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK_PATTERN = /\x1b\[3J/g;
// Mouse-tracking enables (X10/button/any-event/UTF-8/SGR/alt-scroll) — once on,
// xterm.js forwards wheel events to the app instead of scrolling the viewport.
// Live streams are stripped at the source, but buffers persisted BEFORE that
// strip existed can still carry them; strip on replay for parity.
// eslint-disable-next-line no-control-regex
const MOUSE_TRACKING_PATTERN = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g;

/**
 * Strip redundant Ink spinner/status-bar redraw frames from the terminal buffer.
 * Ink (Claude Code's TUI) uses absolute cursor positioning (CSI n d = VPA) to animate
 * the spinner and update the status bar. During long thinking phases, these frames
 * accumulate to 500KB+ of repeated overwrites to the same rows.
 *
 * Strategy: detect "redraw clusters" — dense runs of VPA escapes where each is within
 * FRAME_GAP bytes of the previous (i.e. continuous rerendering of the same UI region).
 * Collapse each big cluster down to just the bytes from its last VPA onwards (the final
 * frame). Content *between* clusters (Claude's streamed response text) is preserved.
 *
 * Without clustering, a single first-VPA-finds-all approach would discard the entire
 * conversation after Claude's first render — losing 100KB+ of legitimate scrollback.
 */
export function stripInkRedrawBloat(buffer: string): string {
  // eslint-disable-next-line no-control-regex
  const vpaRe = /\x1b\[\d+d/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = vpaRe.exec(buffer)) !== null) {
    positions.push(m.index);
  }
  if (positions.length < 10) return buffer; // Too few VPAs to be bloat

  // Group consecutive VPAs into clusters separated by gaps > FRAME_GAP.
  // Within a cluster, VPAs are close together (continuous rerenders).
  // Between clusters, real terminal output (response text) lives.
  const FRAME_GAP = 8 * 1024; // 8KB — one Ink frame is typically 1-4KB
  const MIN_BLOAT_SIZE = 32 * 1024; // Only collapse clusters spanning >= 32KB

  const clusters: { start: number; end: number }[] = [];
  let cs = positions[0];
  let ce = positions[0];
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - ce <= FRAME_GAP) {
      ce = positions[i];
    } else {
      clusters.push({ start: cs, end: ce });
      cs = positions[i];
      ce = positions[i];
    }
  }
  clusters.push({ start: cs, end: ce });

  // For each big cluster, replace [start..end] with the bytes from `end` onwards
  // (which contains the last frame's content up to where the next cluster, or
  // post-cluster content, begins).
  const parts: string[] = [];
  let cursor = 0;
  for (const cl of clusters) {
    if (cl.end - cl.start < MIN_BLOAT_SIZE) continue;
    parts.push(buffer.slice(cursor, cl.start));
    cursor = cl.end;
  }
  parts.push(buffer.slice(cursor));
  return parts.join('');
}

/**
 * Validate image bytes against a declared extension. Sniffs the first ~12 bytes
 * for a known magic-number signature. Defends against polyglots (e.g. HTML or
 * SVG disguised under a `Content-Type: image/png` header) and against simple
 * extension-only spoofing — both the multipart filename and the Content-Type
 * are attacker-controlled, the raw bytes are not.
 *
 * Signatures: https://en.wikipedia.org/wiki/List_of_file_signatures
 */
export function imageMagicMatchesExt(data: Buffer, ext: string): boolean {
  if (data.length < 12) return false;
  const u32be = (off: number): number => data.readUInt32BE(off);
  switch (ext) {
    case '.png':
      return u32be(0) === 0x89504e47 && u32be(4) === 0x0d0a1a0a;
    case '.jpg':
    case '.jpeg':
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case '.gif':
      return (
        data[0] === 0x47 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x38 &&
        (data[4] === 0x37 || data[4] === 0x39) &&
        data[5] === 0x61
      );
    case '.webp':
      // RIFF....WEBP
      return u32be(0) === 0x52494646 && u32be(8) === 0x57454250;
    case '.bmp':
      return data[0] === 0x42 && data[1] === 0x4d;
    case '.heic':
    case '.heif': {
      // ISO Base Media File Format: size + "ftyp" + major brand. The brand
      // list matches heic-decode's own isHeic() — accepting more brands here
      // would only route bytes into a conversion that always throws.
      if (u32be(4) !== 0x66747970) return false;
      const brand = data.subarray(8, 12).toString('ascii');
      return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
    }
    default:
      return false;
  }
}

// Per-(IP, sessionId) token bucket for paste-image. 30 requests/minute.
// Bucket map entries are pruned when they drift > 1h stale to bound memory
// against a flood of unique IP keys.
const PASTE_RATE_TOKENS = 30;
const PASTE_RATE_REFILL_PER_MS = PASTE_RATE_TOKENS / 60_000;
const PASTE_BUCKET_TTL_MS = 60 * 60 * 1000;
const PASTE_BUCKET_GC_THRESHOLD = 1000;
const pasteRateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

export function consumePasteToken(key: string, now: number = Date.now()): boolean {
  if (pasteRateBuckets.size > PASTE_BUCKET_GC_THRESHOLD) {
    for (const [k, b] of pasteRateBuckets) {
      if (now - b.lastRefill > PASTE_BUCKET_TTL_MS) pasteRateBuckets.delete(k);
    }
  }
  let b = pasteRateBuckets.get(key);
  if (!b) {
    b = { tokens: PASTE_RATE_TOKENS, lastRefill: now };
    pasteRateBuckets.set(key, b);
  }
  const delta = (now - b.lastRefill) * PASTE_RATE_REFILL_PER_MS;
  b.tokens = Math.min(PASTE_RATE_TOKENS, b.tokens + delta);
  b.lastRefill = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Test hook: reset between runs.
export function _resetPasteRateBuckets(): void {
  pasteRateBuckets.clear();
}

/**
 * Security (multi-user §6.3): the Claude-only permission-mode downgrade does not
 * cover the other CLIs' bypass switches. Codex `--dangerously-bypass-approvals-and-sandbox`,
 * Gemini `--approval-mode yolo`, and Antigravity `--dangerously-skip-permissions` disable
 * the safety classifier the non-granted-user downgrade is meant to keep on, so clamp them
 * for a non-granted owner. buildGeminiCommand defaults an ABSENT approvalMode to yolo, so
 * the gemini config must be MATERIALIZED (auto_edit) even when the request sent none.
 * Antigravity is like Codex: an ABSENT config already defaults safe (no bypass flag), so
 * only a sent config needs the flag forced off. No-op in single-user mode / for a granted
 * owner (canUsernameRunPrivilegedCommands returns true when !isMultiUserMode()).
 */
async function clampExternalCliBypassForOwner(
  owner: string | undefined,
  codexConfig: CodexConfig | undefined,
  geminiConfig: GeminiConfig | undefined,
  antigravityConfig: AntigravityConfig | undefined
): Promise<{
  codexConfig: CodexConfig | undefined;
  geminiConfig: GeminiConfig | undefined;
  antigravityConfig: AntigravityConfig | undefined;
}> {
  const granted = await canUsernameRunPrivilegedCommands(owner);
  if (granted) return { codexConfig, geminiConfig, antigravityConfig };
  // Non-granted: force codex/antigravity bypass off (only meaningful when a config was
  // sent) and materialize gemini to auto_edit (clamps an explicit 'yolo' and the yolo default).
  const clampedCodex = codexConfig ? { ...codexConfig, dangerouslyBypassApprovals: false } : codexConfig;
  const clampedGemini: GeminiConfig = { ...(geminiConfig ?? {}), approvalMode: 'auto_edit' };
  const clampedAntigravity = antigravityConfig
    ? { ...antigravityConfig, dangerouslySkipPermissions: false }
    : antigravityConfig;
  return { codexConfig: clampedCodex, geminiConfig: clampedGemini, antigravityConfig: clampedAntigravity };
}

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort
): void {
  // ═══════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════

  // ========== Logout ==========

  app.post('/api/logout', async (req, reply) => {
    // Invalidate server-side session token (not just the browser cookie)
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken) {
      ctx.authSessions?.delete(sessionToken);
    }
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    return {};
  });

  // ═══════════════════════════════════════════════════════════════
  // Session CRUD (list, create, rename, color, delete, detail)
  // ═══════════════════════════════════════════════════════════════

  // ========== Session Listing ==========

  app.get('/api/sessions', async (req) => {
    const list = ctx.getLightSessionsState();
    if (!isMultiUserMode()) return list;
    const user = getAuthUser(req);
    if (user.role === 'admin') return list;
    return (list as Array<{ owner?: string }>).filter((s) => canAccessOwned(user, s.owner));
  });

  // ========== Session Tab Order (global sync, COD-131) ==========

  app.put('/api/session-order', async (req): Promise<ApiResponse<{ order: string[] }>> => {
    const { order } = parseBody(SessionOrderUpdateSchema, req.body, 'Invalid session order');
    // Server is authoritative but never drops ids it knows about that the
    // pushing device hadn't loaded yet — those fall to the end (mergeSessionOrder).
    const merged = mergeSessionOrder(order, ctx.store.getSessionOrder());
    ctx.store.setSessionOrder(merged);
    ctx.broadcast(SseEvent.SessionOrderChanged, { order: merged });
    return { success: true, data: { order: merged } };
  });

  // ========== Session Creation ==========

  app.post('/api/sessions', async (req) => {
    const owner = ownerFor(req);
    // Global + per-user session cap.
    const capMsg = sessionCapacityMessage(ctx.sessions, owner);
    if (capMsg) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, capMsg);

    const body = parseBody(CreateSessionSchema, req.body);
    let workingDir = body.workingDir || process.cwd();
    let remote = undefined;

    // COD-105 — attach to a discovered (non-owned) remote tmux session. The
    // remote session is already running, so we skip the tmux-prereq probe and
    // build a NON-owned SessionRemote (detach-not-kill on close). Remote CASE
    // creation (owned durable sessions) is handled by the dedicated case-create
    // endpoint below, which #145 consolidated remote-host resolution into.
    if (body.attachRemoteSession) {
      const { hostId, remoteSessionName } = body.attachRemoteSession;
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
      workingDir = `${host.username}@${host.host}:${remoteSessionName}`;
      remote = toAttachedSessionRemote(host, remoteSessionName, workingDir);
    }

    // Multi-user: shell mode is arbitrary command execution as the host account,
    // gated behind the same grant as bypass (section 6.3). Resolve the owner's grant
    // from the store so a GRANTED regular user is not wrongly denied (AuthUser role alone can't tell).
    if (body.mode === 'shell' && !(await canUsernameRunPrivilegedCommands(owner))) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Shell sessions require the can-bypass-permissions grant');
    }

    // Multi-user linchpin (section 6.2): a non-admin's workingDir must resolve
    // inside their own case space. Enforced BEFORE any disk-mutating call below so
    // a foreign path can never be written into.
    if (!isWorkingDirAllowed(getAuthUser(req), workingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }

    // Validate workingDir exists and is a directory
    if (body.workingDir) {
      try {
        const stat = statSync(workingDir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // envOverrides flow through Session → tmux setenv (ephemeral, per-session).
    //
    // For keys the caller is actively setting, strip any stale disk entry a prior
    // Codeman version may have written. Scope limited to:
    //   - Claude mode (OpenCode/Codex/Gemini don't read .claude/settings.local.json)
    //   - workingDir inside CASES_DIR / the per-user case space (Codeman's managed
    //     territory — we never mutate .claude/settings.local.json in arbitrary user
    //     repos that POST /api/sessions can target, as those may have hand-authored
    //     values).
    const managedCasesBase = resolveCasesDir(getAuthUser(req));
    const canStripDisk =
      body.mode !== 'opencode' &&
      body.mode !== 'codex' &&
      body.mode !== 'gemini' &&
      body.mode !== 'antigravity' &&
      body.envOverrides &&
      Object.keys(body.envOverrides).length > 0 &&
      (workingDir.startsWith(CASES_DIR + '/') || workingDir.startsWith(managedCasesBase + '/'));
    if (canStripDisk) {
      await stripCaseEnvKeys(workingDir, Object.keys(body.envOverrides!));
    }

    // Write model override to .claude/settings.local.json if provided
    if (body.modelOverride !== undefined) {
      await updateCaseModel(workingDir, body.modelOverride || null);
    }

    // Plan-usage statusLine exporter (App Settings → Display → "Plan Usage
    // Limits"). Claude-only; runs for ANY working dir (linked cases / real repos,
    // where most sessions live), mirroring updateCaseModel above.
    //
    // ADD-ONLY: we never remove on create. Sessions in a repo share one
    // settings.local.json, so a single create-with-false (e.g. a client whose
    // synced setting hadn't loaded yet) must NOT yank the statusLine out from
    // under other live sessions in that repo — that breaks their footer + the
    // chip's data feed for everyone. The exporter is benign when the chip is off
    // (the footer just shows session status). isOurs-guarded so a user's own
    // statusLine is never touched.
    if ((body.mode ?? 'claude') === 'claude' && body.statusLineTelemetry === true) {
      await applyStatusLineConfig(workingDir, true);
    }

    // COD-91 self-heal: refresh a pre-secret hooks block in an existing case so the now
    // unconditional hook-secret gate keeps accepting its hook events. No-op for fresh
    // cases (writeHooksConfig already wrote the secret) and for non-Codeman/absent hooks.
    if ((body.mode ?? 'claude') === 'claude') {
      await refreshStaleCodemanHooks(workingDir).catch(() => {});
    }

    // Check OpenCode availability if requested
    if (body.mode === 'opencode') {
      const { isOpenCodeAvailable } = await import('../../utils/opencode-cli-resolver.js');
      if (!isOpenCodeAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
        );
      }
    }

    // Check Codex availability if requested
    if (body.mode === 'codex') {
      const { isCodexAvailable } = await import('../../utils/codex-cli-resolver.js');
      if (!isCodexAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Codex CLI not found. Install with: npm install -g @openai/codex'
        );
      }
    }

    // Check Gemini availability if requested
    if (body.mode === 'gemini') {
      const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
        );
      }
    }
    if (body.mode === 'antigravity') {
      const { isAntigravityAvailable } = await import('../../utils/antigravity-cli-resolver.js');
      if (!isAntigravityAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash'
        );
      }
    }

    // Pre-validate resumeSessionId: check that the conversation file actually exists
    // in Claude's projects directory. If not, skip resume to avoid confusing
    // "No conversation found" errors from Claude CLI.
    let validatedResumeId = body.resumeSessionId;
    if (validatedResumeId) {
      const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
      let found = false;
      try {
        const projectDirs = await fs.readdir(projectsDir);
        for (const projDir of projectDirs) {
          const sessionFile = join(projectsDir, projDir, `${validatedResumeId}.jsonl`);
          try {
            const stat = await fs.stat(sessionFile);
            if (stat.size > 4000) {
              found = true;
              break;
            }
          } catch {
            // File doesn't exist in this project dir
          }
        }
      } catch {
        // Projects dir doesn't exist
      }
      if (!found) {
        console.log(`[Session] Resume session ${validatedResumeId} not found on disk, starting fresh`);
        validatedResumeId = undefined;
      }
    }

    const globalNice = await ctx.getGlobalNiceConfig();
    const modelConfig = await ctx.getModelConfig();
    const mode = body.mode || 'claude';
    const model =
      mode === 'opencode'
        ? body.openCodeConfig?.model
        : mode === 'codex'
          ? body.codexConfig?.model
          : mode === 'gemini'
            ? body.geminiConfig?.model
            : mode === 'antigravity'
              ? body.antigravityConfig?.model
              : mode !== 'shell'
                ? modelConfig?.defaultModel || undefined
                : undefined;
    const claudeModeConfig = await ctx.getClaudeModeConfig();
    // Section 6.3: force non-granted users to a classifier-guarded mode.
    const effectiveClaudeMode = await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, owner);
    // Section 6.3: clamp Codex/Gemini/Antigravity bypass switches for a non-granted owner (no-op single-user/granted).
    const {
      codexConfig: gatedCodexConfig,
      geminiConfig: gatedGeminiConfig,
      antigravityConfig: gatedAntigravityConfig,
    } = await clampExternalCliBypassForOwner(owner, body.codexConfig, body.geminiConfig, body.antigravityConfig);
    const terminalHistoryConfig = await ctx.getTerminalHistoryConfig();
    const session = new Session({
      workingDir,
      mode,
      name: body.name || '',
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model,
      claudeMode: effectiveClaudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? body.openCodeConfig : undefined,
      codexConfig: mode === 'codex' ? gatedCodexConfig : undefined,
      geminiConfig: mode === 'gemini' ? gatedGeminiConfig : undefined,
      antigravityConfig: mode === 'antigravity' ? gatedAntigravityConfig : undefined,
      resumeSessionId: validatedResumeId,
      envOverrides: body.envOverrides,
      effort: body.effort,
      tmuxHistoryLimit: terminalHistoryConfig.tmuxHistoryLimit,
      remote,
      owner,
    });

    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({ event: 'created', sessionId: session.id, name: session.name });

    // Use light state for broadcast + response — buffers are fetched on-demand via /terminal.
    // Avoids serializing 2-3MB of terminal+text buffers per session creation.
    const lightState = ctx.getSessionStateWithRespawn(session);
    ctx.broadcast(SseEvent.SessionCreated, lightState);
    return { session: lightState };
  });

  // ========== Rename Session ==========

  app.put('/api/sessions/:id/name', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionNameSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    const name = String(body.name || '').slice(0, MAX_SESSION_NAME_LENGTH);
    session.name = name;
    // Also update the mux session name if applicable
    ctx.mux.updateSessionName(id, session.name);
    persistAndBroadcastSession(ctx, session);
    return { name: session.name };
  });

  // ========== Set Session Color ==========

  app.put('/api/sessions/:id/color', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionColorSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (!validColors.includes(body.color)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid color');
    }

    session.setColor(body.color as SessionColor);
    persistAndBroadcastSession(ctx, session);
    return { color: session.color };
  });

  // ========== Delete Session ==========

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { killMux?: string };
    const killMux = query.killMux !== 'false'; // Default to true

    // Security: owner-scoped lookup 404s foreign/missing sessions uniformly (no existence leak, no cross-user kill).
    const session = findSessionOrFail(ctx, id, req);

    await ctx.cleanupSession(session.id, killMux, 'user_delete');
    return {};
  });

  // ========== Delete All Sessions ==========

  app.delete('/api/sessions', async (req): Promise<ApiResponse<{ killed: number }>> => {
    // Security: scope the bulk sweep to sessions the caller can access — a non-admin
    // must not wipe other users' sessions (canAccessOwned is allow-all for admin/single-user).
    const user = getAuthUser(req);
    const sessionIds = Array.from(ctx.sessions.values())
      .filter((s) => canAccessOwned(user, s.owner))
      .map((s) => s.id);
    let killed = 0;

    for (const id of sessionIds) {
      if (ctx.sessions.has(id)) {
        await ctx.cleanupSession(id, true, 'user_bulk_delete');
        killed++;
      }
    }

    return { success: true, data: { killed } };
  });

  // ========== Get Session Detail ==========

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    // Use light state (no full buffers) — terminal buffer available via /terminal endpoint.
    // Full buffers were 2-3MB and caused slowness when polled frequently (e.g. Ralph wizard).
    return ctx.getSessionStateWithRespawn(session);
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Data (output, ralph state, run summary, active tools)
  // ═══════════════════════════════════════════════════════════════

  // ========== Get Session Output ==========

  app.get('/api/sessions/:id/output', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        textOutput: session.textOutput,
        messages: session.messages,
        errorBuffer: session.errorBuffer,
      },
    };
  });

  // ========== Get Ralph State ==========

  app.get('/api/sessions/:id/ralph-state', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        loop: session.ralphLoopState,
        todos: session.ralphTodos,
        todoStats: session.ralphTodoStats,
      },
    };
  });

  // ========== Get Run Summary ==========

  app.get('/api/sessions/:id/run-summary', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    const tracker = ctx.runSummaryTrackers.get(id);
    if (!tracker) {
      // Create a fresh tracker if one doesn't exist (shouldn't happen normally)
      const newTracker = new RunSummaryTracker(id, session.name);
      ctx.runSummaryTrackers.set(id, newTracker);
      return { summary: newTracker.getSummary() };
    }

    // Update session name in case it changed
    tracker.setSessionName(session.name);

    return { summary: tracker.getSummary() };
  });

  // ========== Get Active Tools ==========

  app.get('/api/sessions/:id/active-tools', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        tools: session.activeTools,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Execution (run prompt, interactive mode, shell mode)
  // ═══════════════════════════════════════════════════════════════

  // ========== Run Prompt ==========

  app.post('/api/sessions/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const { prompt } = parseBody(RunPromptSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // Run async, don't wait
    session.runPrompt(prompt).catch((err) => {
      ctx.broadcast(SseEvent.SessionError, { id, error: err.message });
    });

    ctx.broadcast(SseEvent.SessionRunning, { id, prompt });
    return {};
  });

  // ========== Start Interactive Mode ==========

  app.post('/api/sessions/:id/interactive', async (req) => {
    const { id } = req.params as { id: string };
    // Body is optional (auto-reattach callers send none) — same idiom as /interactive-respawn.
    const bodyResult = req.body
      ? InteractiveStartSchema.safeParse(req.body)
      : { success: true as const, data: {} as { clearBreaker?: boolean } };
    if (!bodyResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { clearBreaker } = bodyResult.data;
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      // Ralph tracker is not supported for opencode / codex / gemini / antigravity sessions
      if (
        session.mode !== 'opencode' &&
        session.mode !== 'codex' &&
        session.mode !== 'gemini' &&
        session.mode !== 'antigravity' &&
        ctx.store.getConfig().ralphEnabled &&
        !session.ralphTracker.autoEnableDisabled
      ) {
        autoConfigureRalph(session, session.workingDir, ctx);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      // COD-118: ONLY an explicit user-initiated restart (body {clearBreaker:true})
      // clears a tripped PTY-exit circuit breaker. This endpoint is ALSO the frontend's
      // automatic re-attach path (selectSession auto-POSTs it for any pid===null
      // session), so an unconditional reset here would re-arm the exact crash loop
      // the breaker exists to stop — auto-reattach sends no body and must not clear.
      if (clearBreaker) {
        session.resetRespawnBreaker();
      }
      // Re-attach listener wiring if a prior PTY exit detached it: the wiring exit
      // handler removes ALL session listeners (incl. respawnBreakerTripped), and only
      // session-create/boot-recovery paths ran setupSessionListeners before this fix —
      // without this, a re-attached session's SSE/terminal/trip events go unobserved.
      // setupSessionListeners is idempotent (no-op while refs are still attached).
      await ctx.setupSessionListeners(session);
      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Start Shell Mode ==========

  app.post('/api/sessions/:id/shell', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Re-attach listener wiring if a prior PTY exit detached it (see /interactive).
      await ctx.setupSessionListeners(session);
      await session.startShell();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: 'shell',
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id, mode: 'shell' });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });
      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Terminal I/O (input, resize, buffer)
  // ═══════════════════════════════════════════════════════════════

  // ========== Send Input ==========

  app.post('/api/sessions/:id/input', async (req) => {
    const { id } = req.params as { id: string };
    const { input, useMux, seq, clientId } = parseBody(SessionInputWithLimitSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);

    const inputStr = String(input);
    if (inputStr.length > MAX_INPUT_LENGTH) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Input exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`
      );
    }

    // Reliable delivery (POST fallback when the WebSocket is down): a 2xx IS the
    // client's ACK, so a tagged duplicate redelivery must still return 200 but
    // skip the write. Untagged requests (curl/legacy) always apply.
    if (typeof clientId === 'string' && typeof seq === 'number' && !session.shouldApplyInput(clientId, seq)) {
      return {};
    }

    // Write input to PTY. Direct write is synchronous; writeViaMux
    // (tmux send-keys) is fire-and-forget to avoid blocking the HTTP response.
    if (useMux) {
      // Fire-and-forget: don't block HTTP response on tmux child process.
      // Fallback to direct write on failure.
      session
        .writeViaMux(inputStr)
        .then((ok) => {
          if (!ok) {
            console.warn(`[Server] writeViaMux failed for session ${id}, falling back to direct write`);
            session.write(inputStr);
          }
        })
        .catch(() => {
          session.write(inputStr);
        });
    } else {
      session.write(inputStr);
    }
    return {};
  });

  // ========== Send Named Key (tmux send-keys -H) ==========
  // Sends raw hex bytes to tmux pane for keys like Shift+Enter / Ctrl+Enter.
  // Uses send-keys -H (hex) to inject 0x0a (line feed) which Claude Code's
  // Ink input recognizes as "insert newline" vs 0x0d (carriage return = submit).

  app.post('/api/sessions/:id/send-key', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const key = typeof body?.key === 'string' ? body.key : '';

    // Map key names to hex byte sequences
    const KEY_HEX_MAP: Record<string, string[]> = {
      'S-Enter': ['0a'], // \n (line feed)
      'C-Enter': ['0a'], // \n (line feed)
    };
    const hex = KEY_HEX_MAP[key];
    if (!hex) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Key not allowed: ${key}`);
    }

    const session = findSessionOrFail(ctx, id, req);
    const muxName = session.muxName;
    if (!muxName) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No tmux session');
    }

    try {
      // Route through the dedicated Codeman socket — bare `tmux` would target the
      // user's default server and never find this session (same #80 regression class).
      await new Promise<void>((resolve, reject) => {
        execFile(
          'tmux',
          ['-L', ctx.mux.muxSocket, 'send-keys', '-H', '-t', muxName, ...hex],
          { timeout: 5000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (err) {
      console.error('[Server] send-key failed:', err);
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'tmux send-keys failed');
    }
    return {};
  });

  // ========== Resize Terminal ==========

  app.post('/api/sessions/:id/resize', async (req) => {
    const { id } = req.params as { id: string };
    const { cols, rows, viewportType, force } = parseBody(ResizeSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);

    session.resize(cols, rows, { viewportType, force });
    return {};
  });

  // ========== Get Last Response (from transcript JSONL) ==========

  // Resolves the most recent Claude conversation id for a session's cwd by
  // tailing ~/.claude/history.jsonl. After `/clear`, Claude Code keeps writing
  // to a new <uuid>.jsonl; history.jsonl is the only source-of-truth update
  // that does not rely on project-local hooks (we intentionally don't install
  // hooks in arbitrary user repos, see the POST /api/sessions comment).
  //
  // Entries from OTHER Codeman sessions in the same cwd are filtered out by
  // their known claudeSessionIds so concurrent tabs don't shadow each other,
  // as long as each has had its id resolved at least once.
  async function resolveActiveClaudeSessionIdFromHistory(
    session: Session,
    projectsDir: string
  ): Promise<string | null> {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const otherClaudeIds = new Set<string>();
    for (const s of ctx.sessions.values()) {
      if (s.id !== session.id && s.workingDir === session.workingDir && s.claudeSessionId) {
        otherClaudeIds.add(s.claudeSessionId);
      }
    }

    let candidateSid: string | null = null;
    try {
      const content = await fs.readFile(historyPath, 'utf8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { project?: string; sessionId?: string };
          if (
            entry.project === session.workingDir &&
            typeof entry.sessionId === 'string' &&
            !otherClaudeIds.has(entry.sessionId)
          ) {
            candidateSid = entry.sessionId;
            break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      return null;
    }
    if (!candidateSid || candidateSid === session.id) return candidateSid;

    // Safety: only adopt if the candidate's jsonl is more recently written
    // than our initial conversation's jsonl. Blocks stale ids inherited from
    // a prior Codeman session that happened to share this cwd.
    try {
      const projectDirs = await fs.readdir(projectsDir);
      let candidateMtime = 0;
      let initialMtime = 0;
      for (const projDir of projectDirs) {
        try {
          const cs = await fs.stat(join(projectsDir, projDir, `${candidateSid}.jsonl`));
          if (cs.mtimeMs > candidateMtime) candidateMtime = cs.mtimeMs;
        } catch {
          /* not in this dir */
        }
        try {
          const is = await fs.stat(join(projectsDir, projDir, `${session.id}.jsonl`));
          if (is.mtimeMs > initialMtime) initialMtime = is.mtimeMs;
        } catch {
          /* not in this dir */
        }
      }
      if (candidateMtime === 0) return null;
      if (initialMtime > 0 && candidateMtime <= initialMtime) return null;
    } catch {
      return null;
    }
    return candidateSid;
  }

  interface ClaudeResponseMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp?: string;
  }

  interface ClaudeTranscriptEntry {
    type?: string;
    timestamp?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    isCompactSummary?: boolean;
    message?: { content?: unknown };
  }

  function extractClaudeText(content: unknown, separator: string): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          !!block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: string }).text === 'string'
      )
      .map((block) => block.text)
      .join(separator);
  }

  function isClaudeSyntheticUserMessage(entry: ClaudeTranscriptEntry, text: string): boolean {
    if (entry.isMeta || entry.isCompactSummary) return true;
    return /^(?:<local-command|<command-name>|<task-notification>|<system-reminder>|<teammate-message\b|Another Claude session sent a message:|Base directory for this skill:)/i.test(
      text
    );
  }

  /**
   * Claude writes one logical turn as many JSONL rows: text, thinking and tool
   * blocks share message ids, while tool results are represented as user rows.
   * Build viewer cards from real user boundaries instead of treating every row
   * as a separate chat message.
   */
  function parseClaudeResponseTranscript(
    content: string,
    full: boolean
  ): { text: string; timestamp: string; messages?: ClaudeResponseMessage[] } {
    let lastText = '';
    let lastTimestamp = '';
    const messages: ClaudeResponseMessage[] = [];
    let currentUserFragments = new Set<string>();
    let currentAssistantFragments = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry: ClaudeTranscriptEntry;
      try {
        entry = JSON.parse(line) as ClaudeTranscriptEntry;
      } catch {
        continue;
      }
      // Sidechains belong to agents/forks, not the main conversation. Meta user
      // rows include repeated image dimensions and other UI-generated context.
      if (entry.isSidechain) continue;

      if (entry.type === 'user') {
        const text = extractClaudeText(entry.message?.content, '\n').trim();
        // A tool_result block has no text block and naturally drops out here.
        if (!text || isClaudeSyntheticUserMessage(entry, text)) continue;
        if (!full) continue;

        const previous = messages.at(-1);
        if (previous?.role === 'user') {
          // Claude can replay the initial user row while restoring a transcript.
          // Only collapse duplicates within the same unanswered user turn; the
          // same prompt after an assistant response remains a legitimate turn.
          if (currentUserFragments.has(text)) continue;
          previous.text += `\n\n${text}`;
          currentUserFragments.add(text);
        } else {
          messages.push({ role: 'user', text, timestamp: entry.timestamp });
          currentUserFragments = new Set([text]);
        }
        currentAssistantFragments.clear();
        continue;
      }

      if (entry.type !== 'assistant') continue;
      const text = extractClaudeText(entry.message?.content, '\n\n').trim();
      if (!text) continue;
      lastText = text;
      lastTimestamp = entry.timestamp || '';
      if (!full) continue;

      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        // Replayed snapshots sometimes repeat an identical text block. Distinct
        // progress/final blocks are kept, but remain inside one Claude card.
        if (currentAssistantFragments.has(text)) continue;
        previous.text += `\n\n${text}`;
        previous.timestamp = entry.timestamp || previous.timestamp;
        currentAssistantFragments.add(text);
      } else {
        messages.push({ role: 'assistant', text, timestamp: entry.timestamp });
        currentAssistantFragments = new Set([text]);
      }
      currentUserFragments.clear();
    }

    return full ? { text: lastText, timestamp: lastTimestamp, messages } : { text: lastText, timestamp: lastTimestamp };
  }

  /** Locate a top-level Claude transcript, including recovered tmux sessions. */
  async function findClaudeTranscript(
    projectsDir: string,
    conversationId: string,
    codemanSessionId: string
  ): Promise<{ sessionId: string; path: string } | null> {
    let projectDirs: import('node:fs').Dirent[];
    try {
      projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const safeIds = [...new Set([conversationId, codemanSessionId])].filter((value) => /^[a-zA-Z0-9._-]+$/.test(value));
    for (const candidateId of safeIds) {
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const jsonlPath = join(projectsDir, projectDir.name, `${candidateId}.jsonl`);
        try {
          const stat = await fs.stat(jsonlPath);
          if (stat.isFile()) return { sessionId: candidateId, path: jsonlPath };
        } catch {
          /* continue */
        }
      }
    }

    // If mux-sessions.json was lost or stale, reconcileSessions() historically
    // recovered `codeman-40568a29` as `restored-40568a29` and used the server cwd.
    // The tmux name still carries the first eight UUID characters, which safely
    // reconnects the viewer when exactly one matching top-level transcript exists.
    const restoredMatch = /^restored-([a-f0-9]{8,})$/i.exec(codemanSessionId);
    if (!restoredMatch) return null;
    const fragment = restoredMatch[1].toLowerCase();
    const candidates: Array<{ sessionId: string; path: string; mtimeMs: number }> = [];
    const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const dirPath = join(projectsDir, projectDir.name);
      let files: import('node:fs').Dirent[];
      try {
        files = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const candidateId = file.name.slice(0, -'.jsonl'.length);
        if (!candidateId.toLowerCase().startsWith(fragment) || !uuidPattern.test(candidateId)) continue;
        const path = join(dirPath, file.name);
        const stat = await fs.stat(path).catch(() => null);
        if (stat) candidates.push({ sessionId: candidateId, path, mtimeMs: stat.mtimeMs });
      }
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.sessionId));
    if (candidateIds.size !== 1) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0] ?? null;
  }

  app.get('/api/sessions/:id/last-response', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    // Codex sessions don't write to ~/.claude/projects — their transcripts
    // live in ~/.codex/sessions/**. Branch to a Codex-specific reader so the
    // response-viewer works for Codex panes too.
    if (session.mode === 'codex') {
      const codexQuery = req.query as { context?: string };
      return await readCodexLastResponse(session, codexQuery.context === 'full');
    }

    // Scan ~/.claude/projects/*/ for the transcript file
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');

    // Adopt the current conversation id if the user ran `/clear` — Claude CLI's
    // interactive PTY emits no JSON on stdout, so without this lookup the
    // stored id stays pinned to the pre-/clear transcript.
    const activeId = await resolveActiveClaudeSessionIdFromHistory(session, projectsDir);
    if (activeId && activeId !== session.claudeSessionId) {
      session.adoptClaudeSessionId(activeId);
      // Docker sessions: keep the case's resume seed following the live conversation.
      if (session.docker) {
        void persistDockerCaseClaudeSessionId(CODEMAN_CONFIG_DIR, session.docker.containerName, activeId).catch(
          () => {}
        );
      }
    }

    const query = req.query as { context?: string };
    const claudeSessionId = session.claudeSessionId || session.id;
    const transcript = await findClaudeTranscript(projectsDir, claudeSessionId, session.id);
    if (!transcript) {
      return query.context === 'full' ? { text: '', timestamp: '', messages: [] } : { text: '', timestamp: '' };
    }

    if (transcript.sessionId !== session.claudeSessionId && transcript.sessionId !== session.id) {
      session.adoptClaudeSessionId(transcript.sessionId);
      if (session.docker) {
        void persistDockerCaseClaudeSessionId(
          CODEMAN_CONFIG_DIR,
          session.docker.containerName,
          transcript.sessionId
        ).catch(() => {});
      }
    }

    try {
      const content = await fs.readFile(transcript.path, 'utf8');
      return parseClaudeResponseTranscript(content, query.context === 'full');
    } catch {
      return query.context === 'full' ? { text: '', timestamp: '', messages: [] } : { text: '', timestamp: '' };
    }
  });

  function isCodexInjectedContext(text: string): boolean {
    return (
      /^# AGENTS\.md instructions\b/i.test(text) ||
      /^<environment_context\b/i.test(text) ||
      /^<turn_aborted\b/i.test(text) ||
      /^<codex_internal_context\b/i.test(text) ||
      /^<recommended_plugins\b/i.test(text) ||
      /^<user_instructions\b/i.test(text) ||
      /^# Options\b/i.test(text)
    );
  }

  // ── Codex response-viewer support ───────────────────────────────────────────────────────
  // Read the rollout's session_meta identity fields (plus turn_context cwd as
  // a fallback when the huge session_meta line got truncated by the head read).
  function readCodexRolloutMeta(head: string): { cwd?: string; originator?: string } {
    let cwd: string | undefined;
    let originator: string | undefined;
    for (const line of head.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          payload?: { cwd?: string; originator?: string };
        };
        if (entry.type === 'session_meta') {
          cwd ??= entry.payload?.cwd;
          originator ??= entry.payload?.originator;
        } else if (entry.type === 'turn_context') {
          cwd ??= entry.payload?.cwd;
        }
      } catch {
        // Malformed or truncated head line — keep scanning.
      }
      if (cwd && originator) break;
    }
    return { cwd, originator };
  }

  // The pane's last Enter (Session.codexLastSubmitAt) correlated against
  // ~/.codex/history.jsonl, which logs every submitted user message as
  // {session_id, ts}. This identifies the thread the pane is ACTUALLY on and
  // is the only signal that survives /resume, /new and /fork typed inside the
  // codex TUI itself. An entry is credited to this pane only when its Enter is
  // the closest among all codex panes, so a menu keystroke in another pane
  // can't steal the attribution.
  const codexHistoryPinCache = new LRUMap<string, { submitAt: number; threadId: string }>({ maxSize: 1024 });
  async function resolveCodexThreadFromHistory(
    session: { id: string; codexLastSubmitAt?: number },
    codexHome: string
  ): Promise<string | null> {
    const submitAt = session.codexLastSubmitAt || 0;
    if (!submitAt) return null;
    const cached = codexHistoryPinCache.get(session.id);
    if (cached && cached.submitAt === submitAt) return cached.threadId;

    const histPath = join(codexHome, 'history.jsonl');
    const st = await fs.stat(histPath).catch(() => null);
    if (!st || st.size === 0) return null;
    const tail = await readFileTail(histPath, Buffer.alloc(65536), st.size);
    if (!tail) return null;

    const WINDOW_MS = 15_000;
    const otherSubmits: number[] = [];
    for (const s of ctx.sessions.values()) {
      if (s.id !== session.id && s.mode === 'codex' && s.codexLastSubmitAt) {
        otherSubmits.push(s.codexLastSubmitAt);
      }
    }

    let best: { threadId: string; dist: number } | undefined;
    for (const line of tail.split('\n')) {
      if (!line) continue;
      let e: { session_id?: string; ts?: number };
      try {
        e = JSON.parse(line);
      } catch {
        continue; // first tail line may be cut mid-JSON
      }
      if (!e.session_id || typeof e.ts !== 'number') continue;
      const tsMs = e.ts * 1000; // history timestamps are unix seconds
      const dist = Math.abs(tsMs - submitAt);
      if (dist > WINDOW_MS) continue;
      if (otherSubmits.some((o) => Math.abs(tsMs - o) < dist)) continue; // another pane is closer
      if (!best || dist < best.dist) best = { threadId: e.session_id, dist };
    }
    if (!best) return null;
    codexHistoryPinCache.set(session.id, { submitAt, threadId: best.threadId });
    return best.threadId;
  }

  // Locate THIS pane's rollout, in order of confidence:
  //   0. history match — the thread the pane last submitted a message to
  //      (see resolveCodexThreadFromHistory); tracks the pane through
  //      /resume //new //fork typed inside the TUI.
  //   1. originator match — Codeman spawns codex panes with
  //      CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codeman_<sessionId>, which codex
  //      writes into session_meta.originator of every rollout it creates
  //      (including new files after /new in the same pane; newest match wins).
  //   2. resume-id match — resumed rollouts keep their ORIGINAL session_meta
  //      (codex appends without rewriting it), so originator matching can't
  //      see them; but the rollout uuid is in the filename and we know the id.
  //   3. legacy cwd+mtime heuristic — panes started before this feature, or
  //      TUI-resumed threads before their first tracked submit. Case-blind
  //      cwd compare (codex records the launch-time case, /mnt paths vary)
  //      and rollouts claimed by OTHER codeman panes are excluded.
  async function findActiveCodexFile(session: {
    id: string;
    workingDir: string;
    codexLastSubmitAt?: number;
    codexConfig?: { resumeSessionId?: string };
  }): Promise<string | null> {
    const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '/tmp', '.codex');
    const sessionsDir = join(codexHome, 'sessions');

    const files: Array<{ path: string; mtimeMs: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const st = await fs.stat(fullPath).catch(() => null);
        if (!st || st.size < 100) continue;
        files.push({ path: fullPath, mtimeMs: st.mtimeMs });
      }
    };
    await walk(sessionsDir);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const historyThreadId = await resolveCodexThreadFromHistory(session, codexHome);
    if (historyThreadId) {
      const hit = files.find((f) => basename(f.path).endsWith(`-${historyThreadId}.jsonl`));
      if (hit) return hit.path;
    }

    const rawResumeId = session.codexConfig?.resumeSessionId;
    const resumeId =
      rawResumeId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(rawResumeId)
        ? rawResumeId
        : undefined;
    const idMatch = resumeId ? files.find((f) => basename(f.path).endsWith(`-${resumeId}.jsonl`)) : undefined;

    // Scan newest-first for our originator; anything strictly older than the
    // id match can never beat it, so the head reads stop there (mtime ties are
    // still scanned — a /new rollout may land in the same clock tick). The
    // 128 KiB head budget covers the session_meta line, which embeds full
    // base_instructions (observed max ~22 KiB on codex 0.144).
    const originator = `codeman_${session.id}`;
    const wantCwd = session.workingDir.toLowerCase();
    const headBuf = Buffer.alloc(131072);
    let cwdFallback: { path: string; mtimeMs: number } | undefined;
    for (const f of files) {
      if (idMatch && f.mtimeMs < idMatch.mtimeMs) break;
      const meta = await readCodexRolloutMetaCached(f.path, headBuf);
      if (!meta) continue;
      if (meta.originator === originator) return f.path; // newest-first → first hit wins
      if (
        !cwdFallback &&
        !idMatch &&
        meta.cwd?.toLowerCase() === wantCwd &&
        // A rollout stamped by another codeman pane belongs to that pane.
        !(meta.originator?.startsWith('codeman_') && meta.originator !== originator)
      ) {
        cwdFallback = f;
      }
    }

    return idMatch?.path ?? cwdFallback?.path ?? null;
  }

  // session_meta is written once when codex creates the rollout and never
  // rewritten (verified: resume appends without touching it), so the parsed
  // identity of a given path can be cached forever. This turns the per-request
  // scan into stat calls plus head reads for new files only.
  const codexRolloutMetaCache = new LRUMap<string, { cwd?: string; originator?: string }>({ maxSize: 4096 });
  async function readCodexRolloutMetaCached(
    filePath: string,
    headBuf: Buffer
  ): Promise<{ cwd?: string; originator?: string } | null> {
    const cached = codexRolloutMetaCache.get(filePath);
    if (cached) return cached;
    const head = await readFileHead(filePath, headBuf);
    if (!head) return null;
    const meta = readCodexRolloutMeta(head);
    // Don't cache a still-incomplete head: a rollout being created may not
    // have flushed session_meta/turn_context yet.
    if (!meta.cwd && !meta.originator) return meta;
    codexRolloutMetaCache.set(filePath, meta);
    return meta;
  }

  function extractCodexBlockText(content: unknown, kinds: string[]): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === 'object' &&
          kinds.includes((b as { type?: string }).type || '') &&
          typeof (b as { text?: string }).text === 'string'
      )
      .map((b) => b.text)
      .join('\n\n');
  }

  // Single pass over a Codex rollout: track the last assistant message (for the
  // default eye view) and, when `full`, the whole user/assistant thread.
  //
  // User turns come from event_msg/user_message when available: codex emits one
  // per REAL user input, and injected context (AGENTS.md, environment_context,
  // compaction summaries, …) never appears there — so no filtering heuristics.
  // response_item user rows duplicate those inputs mixed with the injections;
  // they are kept only as a fallback for old rollouts without event_msg rows.
  async function readCodexLastResponse(
    session: { id: string; workingDir: string; codexConfig?: { resumeSessionId?: string } },
    full: boolean
  ): Promise<{
    text: string;
    timestamp: string;
    messages?: Array<{ role: string; text: string; timestamp?: string }>;
  }> {
    const empty = full ? { text: '', timestamp: '', messages: [] } : { text: '', timestamp: '' };
    const filePath = await findActiveCodexFile(session);
    if (!filePath) return empty;

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return empty;
    }

    let lastText = '';
    let lastTimestamp = '';
    const messages: Array<{ role: string; text: string; timestamp?: string; legacyUser?: boolean }> = [];
    // Multiset of event-sourced user texts: a real input appears BOTH as an
    // event_msg and as a response_item row, so each event text cancels exactly
    // one legacy twin. Legacy rows without an event twin (turns written by an
    // older codex appending to the same rollout) survive — a file-wide boolean
    // would wrongly drop them.
    const eventUserTexts = new Map<string, number>();

    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry: {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: unknown;
          message?: unknown;
          images?: unknown;
          local_images?: unknown;
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (full && entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        let text = typeof entry.payload.message === 'string' ? entry.payload.message.trim() : '';
        if (text && isCodexInjectedContext(text)) continue;
        if (text) eventUserTexts.set(text, (eventUserTexts.get(text) || 0) + 1);
        // Image-only (or image+text) inputs: the text field alone would make
        // the turn vanish, so surface a placeholder.
        const imageCount =
          (Array.isArray(entry.payload.images) ? entry.payload.images.length : 0) +
          (Array.isArray(entry.payload.local_images) ? entry.payload.local_images.length : 0);
        if (imageCount > 0) text = text ? `${text}\n\n*[image ×${imageCount}]*` : `*[image ×${imageCount}]*`;
        if (text) messages.push({ role: 'user', text, timestamp: entry.timestamp });
        continue;
      }
      if (entry.type !== 'response_item' || entry.payload?.type !== 'message') continue;
      const role = entry.payload?.role;
      if (role === 'assistant') {
        const text = extractCodexBlockText(entry.payload?.content, ['output_text', 'text']);
        if (text) {
          lastText = text;
          lastTimestamp = entry.timestamp || '';
          if (full) messages.push({ role: 'assistant', text, timestamp: entry.timestamp });
        }
      } else if (role === 'user' && full) {
        const text = extractCodexBlockText(entry.payload?.content, ['input_text', 'text']).trim();
        // Drop Codex's injected context turns (AGENTS.md, environment_context, …)
        // so the thread shows real user prompts only.
        if (text && !isCodexInjectedContext(text)) {
          messages.push({ role: 'user', text, timestamp: entry.timestamp, legacyUser: true });
        }
      }
    }

    const thread = messages
      .filter((m) => {
        if (!m.legacyUser) return true;
        const n = eventUserTexts.get(m.text) || 0;
        if (n > 0) {
          eventUserTexts.set(m.text, n - 1);
          return false; // duplicate of an event_msg row already in the thread
        }
        return true;
      })
      .map(({ role, text, timestamp }) => ({ role, text, timestamp }));

    return full
      ? { text: lastText, timestamp: lastTimestamp, messages: thread }
      : { text: lastText, timestamp: lastTimestamp };
  }

  // ========== Get Terminal Buffer ==========

  // Query params:
  //   tail=<bytes> - Only return last N bytes (faster initial load)
  //   full=1       - Full page reload: replay the entire tmux scrollback (COD-47)
  app.get('/api/sessions/:id/terminal', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tail?: string; full?: string };
    const session = findSessionOrFail(ctx, id, req);

    // `full=1` is the EXPLICIT full-reload signal (COD-47): the browser reloaded
    // the page and wants the whole scroll history back, so we capture the ENTIRE
    // tmux scrollback and the user gets back history that scrolled off Codeman's
    // byte buffer. Requests WITHOUT it — tab switches (`tail=`) and the legacy
    // no-param callers (response-viewer fallback, clearTerminal refresh) — keep
    // the fast visible-frame capture.
    const tailBytes = query.tail ? parseInt(query.tail, 10) : 0;
    const isFullReload = query.full === '1' || query.full === 'true';
    const { tmuxHistoryLimit, terminalBufferMaxBytes } = await ctx.getTerminalHistoryConfig();

    // Prepend the live tmux pane buffer so tab-switch replay shows the current
    // on-screen frame, not just the accumulated byte history. This matters for
    // TUI modes (codex/opencode) that repaint only their latest frame: the
    // accumulated buffer alone replays as the idle banner. We clear the viewport
    // (`\x1b[H\x1b[2J`) between the history and the live pane so they don't
    // overlap. `captureActivePaneBuffer` is a no-op ('') under test mode and
    // returns null when unavailable, in which case we fall back to history.
    const muxName = session.muxName;
    const liveMuxBuffer =
      muxName && typeof ctx.mux.captureActivePaneBuffer === 'function'
        ? ctx.mux.captureActivePaneBuffer(
            muxName,
            isFullReload
              ? { fullHistory: true, historyLimitLines: tmuxHistoryLimit, maxCaptureBytes: terminalBufferMaxBytes }
              : undefined
          )
        : null;
    const hasLiveMuxBuffer = liveMuxBuffer !== null && liveMuxBuffer.length > 0;
    const source: 'history' | 'mux-visible' | 'mux-full-history' = hasLiveMuxBuffer
      ? isFullReload
        ? 'mux-full-history'
        : 'mux-visible'
      : 'history';
    let rawBuffer: string;
    if (liveMuxBuffer !== null && liveMuxBuffer.length > 0) {
      // Full-history capture is the RENDERED form of everything already in the
      // byte buffer (up to tmux eviction) — return it alone. Prepending the byte
      // history would replay the whole conversation twice: `\x1b[2J` clears only
      // the viewport, not xterm scrollback. The history+clear+frame concat stays
      // for the visible-frame path, where the single pane frame lacks history.
      rawBuffer = isFullReload
        ? liveMuxBuffer
        : session.terminalBufferLength > 0
          ? `${session.terminalBuffer}\x1b[H\x1b[2J${liveMuxBuffer}`
          : liveMuxBuffer;
    } else {
      rawBuffer = session.terminalBuffer;
    }
    const fullSize = rawBuffer.length;
    let truncated = false;
    let cleanBuffer: string;

    // Cap the payload EARLY — before the regex normalization passes below run
    // over it. A full-history tmux capture can be tens of MB of scrollback;
    // normalizing all of it would stall the event loop only to discard most
    // bytes anyway. Keep the most RECENT bytes (slice from the end) and align
    // to a line boundary so we never start mid-ANSI-escape.
    if (terminalBufferMaxBytes > 0 && rawBuffer.length > terminalBufferMaxBytes) {
      rawBuffer = rawBuffer.slice(-terminalBufferMaxBytes);
      truncated = true;
      const capNewline = rawBuffer.indexOf('\n');
      if (capNewline > 0 && capNewline < 4096) {
        rawBuffer = rawBuffer.slice(capNewline + 1);
      }
    }

    // Strip redundant Ink spinner/status redraws BEFORE tailing.
    // During long thinking phases, Ink rewrites the same rows thousands of times
    // (500KB+). Without stripping, tail mode returns only spinner frames and
    // the terminal appears empty when switching tabs.
    let strippedBuffer = session.mode === 'shell' ? rawBuffer : stripInkRedrawBloat(rawBuffer);

    // Strip alt-screen toggles and scrollback-erase from Codex/Claude byte
    // streams. xterm.js obeys them by switching to its scrollback-less alt
    // buffer and wiping saved lines, so conversation history disappears on tab
    // switch. Same gate as the live-stream strip in session.ts.
    if (isAltScreenStripMode(session.mode)) {
      strippedBuffer = strippedBuffer
        .replace(ALT_SCREEN_TOGGLE_PATTERN, '')
        .replace(ERASE_SCROLLBACK_PATTERN, '')
        .replace(MOUSE_TRACKING_PATTERN, '');
    }

    if (tailBytes > 0 && strippedBuffer.length > tailBytes) {
      // Fast path: tail from the end, skip expensive banner search on full 2MB buffer.
      // Banner is near the top and gets discarded by tail anyway.
      cleanBuffer = strippedBuffer.slice(-tailBytes);
      truncated = true;
      // Avoid starting mid-ANSI-escape: find first newline within the first 4KB
      // and start from there. This prevents xterm.js from parsing a partial escape
      // sequence which corrupts cursor position for all subsequent Ink redraws.
      const firstNewline = cleanBuffer.indexOf('\n');
      if (firstNewline > 0 && firstNewline < 4096) {
        cleanBuffer = cleanBuffer.slice(firstNewline + 1);
      }
    } else {
      // Full buffer: clean junk before actual Claude content
      cleanBuffer = strippedBuffer;

      // Find where Claude banner starts (has color codes before "Claude")
      const claudeMatch = cleanBuffer.match(CLAUDE_BANNER_PATTERN);
      if (claudeMatch && claudeMatch.index !== undefined && claudeMatch.index > 0) {
        let lineStart = claudeMatch.index;
        while (lineStart > 0 && cleanBuffer[lineStart - 1] !== '\n') {
          lineStart--;
        }
        cleanBuffer = cleanBuffer.slice(lineStart);
      }
    }

    // Remove Ctrl+L and leading whitespace (cheap on tailed subset)
    cleanBuffer = cleanBuffer.replace(CTRL_L_PATTERN, '').replace(LEADING_WHITESPACE_PATTERN, '');

    return {
      terminalBuffer: cleanBuffer,
      status: session.status,
      fullSize,
      truncated,
      source,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Settings (auto-clear, auto-compact, image watcher, flicker filter)
  // ═══════════════════════════════════════════════════════════════

  // ========== Auto-Clear ==========

  app.post('/api/sessions/:id/auto-clear', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoClearSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.setAutoClear(body.enabled, body.threshold);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoClear: {
          enabled: session.autoClearEnabled,
          threshold: session.autoClearThreshold,
        },
      },
    };
  });

  // ========== Auto-Compact ==========

  app.post('/api/sessions/:id/auto-compact', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoCompactSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.setAutoCompact(body.enabled, body.threshold, body.prompt);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoCompact: {
          enabled: session.autoCompactEnabled,
          threshold: session.autoCompactThreshold,
          prompt: session.autoCompactPrompt,
        },
      },
    };
  });

  // ========== Auto-Resume (usage-limit pause) ==========

  app.post('/api/sessions/:id/auto-resume', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoResumeSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.setAutoResume(body.enabled);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoResume: {
          enabled: session.autoResumeEnabled,
          resumeAt: session.autoResumeAt ?? undefined,
        },
      },
    };
  });

  // ========== Pin (float to top of the session manager list, COD-139) ==========

  app.post('/api/sessions/:id/pin', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(PinSessionSchema, req.body, 'Invalid request body');

    const session = ctx.sessions.get(id);
    if (session) {
      if (!canAccessOwned(getAuthUser(req), session.owner)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`);
      }
      session.setPinned(body.pinned);
      // Persist + broadcast session:updated (keeps tabs/state consistent), then a
      // dedicated session:pinned event so the session manager list re-sorts live.
      persistAndBroadcastSession(ctx, session);
      ctx.broadcast(SseEvent.SessionPinned, {
        id,
        pinned: session.pinned,
        pinnedAt: session.pinnedAt ?? undefined,
      });

      return {
        success: true,
        data: {
          pinned: session.pinned,
          pinnedAt: session.pinnedAt ?? undefined,
        },
      };
    }

    // COD-142 keeps a pinned session's record after kill (demoteOrRemoveSession),
    // so pin toggles must also work WITHOUT a live Session — otherwise a
    // pinned-then-killed record could never be unpinned (cleanup skips pinned
    // records, and the record has no live session to route through).
    const persisted = ctx.store.getSession(id);
    if (!persisted || !canAccessOwned(getAuthUser(req), persisted.owner)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`);
    }
    const pinnedAt = body.pinned ? Date.now() : undefined;
    ctx.store.setSession(id, { ...persisted, pinned: body.pinned || undefined, pinnedAt });
    ctx.broadcast(SseEvent.SessionPinned, { id, pinned: body.pinned, pinnedAt });
    return { success: true, data: { pinned: body.pinned, pinnedAt } };
  });

  // ========== Image Watcher ==========

  app.post('/api/sessions/:id/image-watcher', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ImageWatcherSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    if (body.enabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    } else {
      imageWatcher.unwatchSession(session.id);
    }

    // Store state on session for persistence
    session.imageWatcherEnabled = body.enabled;
    ctx.persistSessionState(session);

    return {
      success: true,
      data: {
        imageWatcherEnabled: body.enabled,
      },
    };
  });

  // ========== Flicker Filter ==========

  app.post('/api/sessions/:id/flicker-filter', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(FlickerFilterSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.flickerFilterEnabled = body.enabled;
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        flickerFilterEnabled: body.enabled,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Quick Actions (quick-run, quick-start)
  // ═══════════════════════════════════════════════════════════════

  // ========== Quick Run ==========

  app.post('/api/run', async (req) => {
    const runOwner = ownerFor(req);
    const capMsg = sessionCapacityMessage(ctx.sessions, runOwner);
    if (capMsg) return createErrorResponse(ApiErrorCode.SESSION_BUSY, capMsg);

    const {
      prompt,
      workingDir,
      envOverrides: runEnvOverrides,
    } = parseBody(QuickRunSchema, req.body, 'Invalid request body');

    if (!prompt.trim()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'prompt is required');
    }
    const dir = workingDir || process.cwd();

    // Multi-user: confine a non-admin's one-shot working dir to their space.
    if (!isWorkingDirAllowed(getAuthUser(req), dir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }

    // Validate workingDir exists and is a directory
    if (workingDir) {
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // Section 6.3: the one-shot spawn path (runPrompt/buildPromptArgs) respects the
    // session's claudeMode, so resolve it for the owner (bypass -> auto for non-granted).
    const runClaudeModeConfig = await ctx.getClaudeModeConfig();
    const runClaudeMode = await resolveClaudeModeForUsername(runClaudeModeConfig.claudeMode, runOwner);
    const session = new Session({
      workingDir: dir,
      envOverrides: runEnvOverrides,
      claudeMode: runClaudeMode,
      allowedTools: runClaudeModeConfig.allowedTools,
      owner: runOwner,
    });
    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'run_prompt',
    });

    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    try {
      const result = await session.runPrompt(prompt);
      // Clean up session after completion to prevent memory leak
      await ctx.cleanupSession(session.id, true, 'run_prompt_complete');
      return { sessionId: session.id, ...result };
    } catch (err) {
      // Clean up session on error too. The session is destroyed here, so its id
      // is only useful for log correlation — carry it in the error message.
      await ctx.cleanupSession(session.id, true, 'run_prompt_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `${getErrorMessage(err)} (session ${session.id})`);
    }
  });

  // ========== Quick Start ==========

  app.post('/api/quick-start', async (req) => {
    const owner = ownerFor(req);
    const capMsg = sessionCapacityMessage(ctx.sessions, owner);
    if (capMsg) return createErrorResponse(ApiErrorCode.SESSION_BUSY, capMsg);

    const {
      caseName = 'testcase',
      sessionName,
      mode = 'claude',
      modelOverride,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      envOverrides,
      effort,
    } = parseBody(QuickStartSchema, req.body);

    // Multi-user: shell mode is arbitrary host-account execution, gated by the grant.
    // Resolve the owner's grant from the store so a GRANTED regular user is not wrongly denied.
    if (mode === 'shell' && !(await canUsernameRunPrivilegedCommands(owner))) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Shell sessions require the can-bypass-permissions grant');
    }

    // Resolve the remote case FIRST — the CLI executes on the REMOTE host over ssh,
    // so the LOCAL availability gates below (isCodexAvailable() etc.) don't apply and
    // would wrongly reject a machine that hasn't got the CLI installed locally.
    let remote = undefined;
    let docker = undefined;
    let dockerResumeId: string | undefined;
    let casePath: string | null = null;
    // Security: fold ownership INTO the match (don't early-return) so a NON-OWNED
    // same-named remote/docker case is skipped and control falls through to the caller's
    // own LOCAL case — remote/docker names are globally unique but local names are
    // per-user, so a name collision must not shadow the caller's own case. canAccessOwned
    // is allow-all for admins/single-user, so flag-OFF stays byte-identical.
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    const remoteCase = remoteCases.find(
      (item) => item.name === caseName && canAccessOwned(getAuthUser(req), item.owner)
    );
    const dockerCase = remoteCase
      ? undefined
      : (await readDockerCases(CODEMAN_CONFIG_DIR)).find(
          (item) => item.name === caseName && canAccessOwned(getAuthUser(req), item.owner)
        );
    if (remoteCase) {
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === remoteCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

      // Per-session config that is applied to the LOCAL tmux/CLI wrapper (env vars via
      // tmux setenv, effort/model CLI args, codex/gemini/opencode config) does NOT
      // cross ssh, so it would silently no-op. Reject rather than pretend it worked —
      // remote command/env customization goes through the per-host command override.
      if (
        (envOverrides && Object.keys(envOverrides).length > 0) ||
        effort ||
        modelOverride !== undefined ||
        codexConfig ||
        geminiConfig ||
        antigravityConfig ||
        openCodeConfig
      ) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          'envOverrides, effort, modelOverride, and per-CLI config are not supported for remote cases (they do not cross ssh). Configure the remote command via the host command override instead.'
        );
      }

      // tmux is a hard prerequisite on the remote host (the agent runs inside a remote
      // tmux server so it survives ssh drops). Probe before spawning so a missing tmux
      // surfaces a clear, structured error instead of a dead "tmux: command not found" pane.
      const tmuxCheck = await checkRemoteTmuxAvailable(host);
      if (!tmuxCheck.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'remote host is missing tmux');
      }

      casePath = remoteCase.remotePath;
      remote = toSessionRemote(host, remoteCase);
    } else if (dockerCase) {
      // Docker case: the CLI executes INSIDE a container via local tmux + `docker
      // exec`, so the LOCAL availability gates below don't apply. Mirror the remote
      // branch's rejection of per-session config that would not cross into the
      // container (it would silently no-op). (Ownership is enforced in the .find above.)
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      if (
        (envOverrides && Object.keys(envOverrides).length > 0) ||
        effort ||
        codexConfig ||
        geminiConfig ||
        antigravityConfig ||
        openCodeConfig
      ) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          'envOverrides, effort, and per-CLI config are not supported for docker cases (they do not cross into the container). Configure the container via the docker host command override instead.'
        );
      }

      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const sessionDocker = toSessionDocker(host, dockerCase);
      // Ensure the base image exists, auto-building the default image on first use so
      // it is never a blocker. Dedup'd with any build kicked off at case-create, so
      // this awaits the SAME in-flight build rather than starting a second one.
      const ensured = await ensureAgentBaseImage(sessionDocker, sessionDocker.image, {
        onProgress: (line) => ctx.broadcast(SseEvent.DockerImageBuildProgress, { name: dockerCase.name, line }),
      });
      if (!ensured.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, ensured.error || 'base image not available');
      }
      if (ensured.built) {
        ctx.broadcast(SseEvent.DockerImageBuildComplete, { name: dockerCase.name, image: sessionDocker.image });
      }
      // tmux is a hard prerequisite (the in-container tmux makes reconnect durable).
      // Skip the extra container-run probe for our OWN default image (the baked
      // Dockerfile always contains tmux); still verify a custom image.
      if (sessionDocker.image !== DEFAULT_AGENT_IMAGE) {
        const tmuxCheck = await checkDockerTmuxAvailable(sessionDocker);
        if (!tmuxCheck.ok) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'base image is missing tmux');
        }
      }

      // Config drift (docs/docker-cases-plan.md §4): the desired create-config no
      // longer matches the existing container's codeman.confighash label. Refuse to
      // silently launch into the stale container — the frontend confirms a recreate
      // (POST /api/docker-cases/:name/recreate; workspace + transcripts ride bind
      // mounts and the conversation resumes), or the user reverts the host edit.
      const drift = await checkDockerConfigDrift(sessionDocker);
      if (drift.exists && drift.drifted) {
        return createErrorResponse(
          ApiErrorCode.CONFLICT,
          `Container config for case "${dockerCase.name}" changed since the container was created. Recreate the container to apply it (workspace and conversation survive), or revert the docker host edit.`
        );
      }

      casePath = dockerCase.hostWorkspacePath; // a REAL host dir (bind-mounted into the container)
      docker = sessionDocker;
      // Seed resume so a relaunch resumes the case's last conversation from the
      // bind-mounted transcript (decision: resume-on-start default ON).
      if (sessionDocker.resumeOnStart && dockerCase.lastClaudeSessionId) {
        dockerResumeId = dockerCase.lastClaudeSessionId;
      }
    } else {
      // Check OpenCode availability if requested
      if (mode === 'opencode') {
        const { isOpenCodeAvailable } = await import('../../utils/opencode-cli-resolver.js');
        if (!isOpenCodeAvailable()) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
          );
        }
      }

      // Check Codex availability if requested
      if (mode === 'codex') {
        const { isCodexAvailable } = await import('../../utils/codex-cli-resolver.js');
        if (!isCodexAvailable()) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'Codex CLI not found. Install with: npm install -g @openai/codex'
          );
        }
      }

      // Check Gemini availability if requested
      if (mode === 'gemini') {
        const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
        if (!isGeminiAvailable()) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
          );
        }
      }

      // Check Antigravity availability if requested
      if (mode === 'antigravity') {
        const { isAntigravityAvailable } = await import('../../utils/antigravity-cli-resolver.js');
        if (!isAntigravityAvailable()) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash'
          );
        }
      }

      // Resolve case path: check linked-cases registry first, then fall back to CASES_DIR.
      // This mirrors the behaviour of resolveCasePath() in case-routes so that linked
      // external project directories are honoured by quick-start just like regular case routes.
      let linkedCases: Record<string, string> = {};
      try {
        const raw = await fs.readFile(LINKED_CASES_FILE, 'utf-8');
        linkedCases = JSON.parse(raw);
      } catch {
        // File missing or unparseable — treat as empty registry
      }
      // Multi-user: the linked-cases registry is ownerless/global, so only admins may
      // resolve a name to an arbitrary linked path. A non-admin resolves inside their
      // OWN case space only (single-user: isAdmin true, so linked cases still honoured).
      const linked = isAdmin(req) ? linkedCases[caseName] : undefined;
      casePath = linked || validatePathWithinBase(caseName, resolveCasesDir(getAuthUser(req)));
      if (!casePath) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
      }
    }

    // By this point casePath is guaranteed non-null: for remote cases it was set from remoteCase.remotePath,
    // for local cases the !casePath guard above returned early. TypeScript can't narrow across the if/else.
    const resolvedCasePath = casePath as string;

    // Multi-user linchpin (section 6.2): confine the resolved workingDir to the caller's
    // own case space BEFORE any mkdir/scaffold below creates or mutates it. Applies to
    // LOCAL and DOCKER cases (docker.hostWorkspacePath is a real host dir the file routes
    // trust); skipped for REMOTE, whose path is an ssh path that would spuriously fail
    // realpath confinement. No-op for admins / single-user mode.
    if (!remote && !isWorkingDirAllowed(getAuthUser(req), resolvedCasePath)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'case path is outside your workspace');
    }

    // Create case folder and CLAUDE.md if it doesn't exist (only for non-linked, non-remote,
    // non-docker cases — docker workspaces are scaffolded in their own block below)
    if (!remote && !docker && !existsSync(resolvedCasePath)) {
      try {
        mkdirSync(resolvedCasePath, { recursive: true });
        mkdirSync(join(resolvedCasePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = await ctx.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(caseName, '', templatePath);
        writeFileSync(join(resolvedCasePath, 'CLAUDE.md'), claudeMd);

        // Write .claude/settings.local.json with hooks for desktop notifications
        // (Claude-specific — OpenCode, Codex, Gemini, and Antigravity use their own systems)
        if (mode !== 'opencode' && mode !== 'codex' && mode !== 'gemini' && mode !== 'antigravity') {
          await writeHooksConfig(resolvedCasePath);
        }

        ctx.broadcast(SseEvent.CaseCreated, { name: caseName, path: resolvedCasePath });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }
    } else if (!remote && !docker && mode !== 'opencode') {
      // COD-91 self-heal for an EXISTING case: refresh a pre-secret hooks block so the
      // now-unconditional hook-secret gate keeps accepting its hook events. No-op when
      // the hooks aren't ours or already carry the secret. Skipped for remote cases —
      // resolvedCasePath is a REMOTE path that doesn't exist on the local filesystem.
      await refreshStaleCodemanHooks(resolvedCasePath).catch(() => {});
    }

    // Docker cases: the workspace is a REAL host dir bind-mounted into the container.
    // Scaffold hooks (+ a CLAUDE.md) if MISSING so in-container permission prompts and
    // hook-idle detection fire (decision: wire hooks now). Never clobbers an existing
    // configured project. Skipped for external CLIs (they use their own systems).
    if (
      docker &&
      docker.hooksEnabled &&
      mode !== 'opencode' &&
      mode !== 'codex' &&
      mode !== 'gemini' &&
      mode !== 'antigravity'
    ) {
      try {
        if (!existsSync(join(resolvedCasePath, 'CLAUDE.md'))) {
          const templatePath = await ctx.getDefaultClaudeMdPath();
          writeFileSync(join(resolvedCasePath, 'CLAUDE.md'), generateClaudeMd(caseName, '', templatePath));
        }
        if (!existsSync(join(resolvedCasePath, '.claude', 'settings.local.json'))) {
          await writeHooksConfig(resolvedCasePath);
        } else {
          await refreshStaleCodemanHooks(resolvedCasePath).catch(() => {});
        }
      } catch {
        /* non-fatal — the session still runs, hooks may be degraded */
      }
    }

    // Model override → <case>/.claude/settings.local.json (claude-mode; local AND
    // docker — the docker workspace is a real host dir, so the settings file crosses
    // the bind mount and the in-container claude reads it). Remote was rejected above.
    if (mode === 'claude' && modelOverride !== undefined) {
      await updateCaseModel(resolvedCasePath, modelOverride || null);
    }

    // Strip stale disk entries for keys this request is actively setting (Claude only —
    // see POST /api/sessions for full rationale).
    if (
      mode !== 'opencode' &&
      mode !== 'codex' &&
      mode !== 'gemini' &&
      mode !== 'antigravity' &&
      !remote &&
      envOverrides &&
      Object.keys(envOverrides).length > 0
    ) {
      await stripCaseEnvKeys(resolvedCasePath, Object.keys(envOverrides));
    }

    // Create a new session with the case as working directory
    // Apply global Nice priority config and model config from settings
    const niceConfig = await ctx.getGlobalNiceConfig();
    const qsModelConfig = await ctx.getModelConfig();
    const qsModel =
      mode === 'opencode'
        ? openCodeConfig?.model
        : mode === 'codex'
          ? codexConfig?.model
          : mode === 'gemini'
            ? geminiConfig?.model
            : mode === 'antigravity'
              ? antigravityConfig?.model
              : mode !== 'shell'
                ? qsModelConfig?.defaultModel || undefined
                : undefined;
    const qsClaudeModeConfig = await ctx.getClaudeModeConfig();
    const qsEffectiveClaudeMode = await resolveClaudeModeForUsername(qsClaudeModeConfig.claudeMode, owner);
    // Section 6.3: clamp Codex/Gemini/Antigravity bypass switches for a non-granted owner (no-op single-user/granted).
    const {
      codexConfig: qsGatedCodexConfig,
      geminiConfig: qsGatedGeminiConfig,
      antigravityConfig: qsGatedAntigravityConfig,
    } = await clampExternalCliBypassForOwner(owner, codexConfig, geminiConfig, antigravityConfig);
    const qsTerminalHistoryConfig = await ctx.getTerminalHistoryConfig();
    const session = new Session({
      workingDir: resolvedCasePath,
      name: sessionName ? sessionName.slice(0, MAX_SESSION_NAME_LENGTH) : '',
      mux: ctx.mux,
      useMux: true,
      mode: mode,
      niceConfig: niceConfig,
      model: qsModel,
      claudeMode: qsEffectiveClaudeMode,
      allowedTools: qsClaudeModeConfig.allowedTools,
      owner,
      openCodeConfig: mode === 'opencode' ? openCodeConfig : undefined,
      codexConfig: mode === 'codex' ? qsGatedCodexConfig : undefined,
      geminiConfig: mode === 'gemini' ? qsGatedGeminiConfig : undefined,
      antigravityConfig: mode === 'antigravity' ? qsGatedAntigravityConfig : undefined,
      envOverrides,
      effort,
      remote,
      docker,
      resumeSessionId: dockerResumeId,
      tmuxHistoryLimit: qsTerminalHistoryConfig.tmuxHistoryLimit,
    });

    // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
    // so the initial state already has the phrase configured (only if globally enabled)
    if (mode === 'claude' && !remote && !docker && ctx.store.getConfig().ralphEnabled) {
      autoConfigureRalph(session, resolvedCasePath, ctx);
      if (!session.ralphTracker.enabled) {
        session.ralphTracker.enable();
        session.ralphTracker.enableAutoEnable(); // Allow re-enabling on restart
      }
    }

    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'quick_start',
    });
    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    // Start in the appropriate mode
    try {
      if (mode === 'shell') {
        await session.startShell();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode: 'shell',
        });
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode: 'shell' });
      } else {
        // 'claude', 'opencode', 'codex', and 'gemini' modes use startInteractive()
        await session.startInteractive();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode,
        });
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode });
      }
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      // Docker + claude: the pane command pins the conversation id (--session-id /
      // --resume, claudeDockerPaneCommand), so persist it as the case's resume seed
      // NOW — a later container stop/reboot relaunch resumes this conversation even
      // if no in-container hook ever reaches the host (loopback bind, no bridge
      // listener). Hook/last-response adoption updates it again after /clear.
      if (docker && mode === 'claude') {
        void persistDockerCaseClaudeSessionId(
          CODEMAN_CONFIG_DIR,
          docker.containerName,
          session.claudeSessionId || session.id
        ).catch(() => {});
      }

      // Save lastUsedCase to settings for TUI/web sync
      try {
        const settingsFilePath = SETTINGS_PATH;
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await fs.readFile(settingsFilePath, 'utf-8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        settings.lastUsedCase = caseName;
        const dir = dirname(settingsFilePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Use async write to avoid blocking event loop
        fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2)).catch((err) => {
          // Non-critical but log for debugging
          console.warn('[Server] Failed to save settings (lastUsedCase):', err);
        });
      } catch (err) {
        // Non-critical but log for debugging
        console.warn('[Server] Failed to prepare settings update:', err);
      }

      return {
        sessionId: session.id,
        casePath: resolvedCasePath,
        caseName,
      };
    } catch (err) {
      // Clean up session on error to prevent orphaned resources
      await ctx.cleanupSession(session.id, true, 'quick_start_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // History — list past Claude conversations for resume
  // ═══════════════════════════════════════════════════════════════

  /** Extract the text of the first user message from a JSONL transcript head. */
  function extractFirstUserPrompt(head: string): string | undefined {
    const MAX_PROMPT_LEN = 120;
    // Iterate lines without allocating a full split array
    let start = 0;
    while (start < head.length) {
      const end = head.indexOf('\n', start);
      const line = end === -1 ? head.slice(start) : head.slice(start, end);
      start = end === -1 ? head.length : end + 1;
      if (!line.includes('"type":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' || !entry.message) continue;
        const content = entry.message.content;
        let text: string | undefined;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type: string }) => b.type === 'text');
          if (textBlock) text = textBlock.text;
        }
        if (!text) continue;
        // Strip XML-like system/command tags and ANSI escapes from transcripts
        text = text
          .replace(/<[^>]+>/g, '')
          .replace(new RegExp(String.raw`\x1b\[[0-9;]*[a-zA-Z]`, 'g'), '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!text) continue;
        // Skip system-injected messages, slash command artifacts, and expanded skill prompts
        if (
          /^(Caveat:|init\b|clear\b|resume\b|\/[a-z][\w-]*\b|You are a |\[Request |Set model to )/i.test(text) ||
          /^(Please )?(analyze|review) this codebase/i.test(text) ||
          /^(Read|Implement the following) .+, then (search|list|check) /i.test(text) ||
          /^\d+ vulnerabilit/i.test(text) ||
          /\btoolu_/.test(text) ||
          /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/.test(text) ||
          /\b(sk-ant-|ANTHROPIC_API_KEY|API_KEY=|SECRET|TOKEN=)/i.test(text) ||
          text.length < 8
        )
          continue;
        return text.length > MAX_PROMPT_LEN ? text.slice(0, MAX_PROMPT_LEN) + '\u2026' : text;
      } catch {
        // Malformed line — skip
      }
    }
    return undefined;
  }

  /**
   * The `entrypoint` field Claude Code stamps on its own message records:
   * 'cli' for a real interactive session, something else (e.g. 'sdk-py') for
   * an SDK/automated invocation. Used to exclude non-interactive transcripts
   * (CI review bots, etc.) from the resumable history list — they were never
   * something a user can resume into.
   *
   * Scoped to `"type":"user"`/`"type":"assistant"` lines specifically, mirroring
   * `extractFirstUserPrompt`'s type check, rather than any line that happens to
   * contain the substring "entrypoint". A transcript that started under an older
   * Claude Code version (no entrypoint field) and got resumed under a newer one
   * mid-conversation could otherwise pick up the field from a much later message
   * than the true first one, misattributing the session's origin.
   */
  function extractTranscriptEntrypoint(text: string): string | undefined {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const line = end === -1 ? text.slice(start) : text.slice(start, end);
      start = end === -1 ? text.length : end + 1;
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      if (!line.includes('"entrypoint"')) continue;
      try {
        const entry = JSON.parse(line);
        if ((entry.type === 'user' || entry.type === 'assistant') && typeof entry.entrypoint === 'string') {
          return entry.entrypoint;
        }
      } catch {
        // Malformed/truncated line — skip
      }
    }
    return undefined;
  }

  /**
   * Extract the text of the LAST user message from a JSONL transcript chunk
   * (COD-145). Mirrors `extractFirstUserPrompt` exactly — same user-message
   * detection, same noise/secret/slash-command filters, same 120-char cap — but
   * keeps the last qualifying match instead of returning on the first. Scan the
   * file tail for this (the most recent prompt lives near the end).
   */
  function extractLastUserPrompt(text: string): string | undefined {
    const MAX_PROMPT_LEN = 120;
    let result: string | undefined;
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const line = end === -1 ? text.slice(start) : text.slice(start, end);
      start = end === -1 ? text.length : end + 1;
      if (!line.includes('"type":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' || !entry.message) continue;
        const content = entry.message.content;
        let msgText: string | undefined;
        if (typeof content === 'string') {
          msgText = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type: string }) => b.type === 'text');
          if (textBlock) msgText = textBlock.text;
        }
        if (!msgText) continue;
        msgText = msgText
          .replace(/<[^>]+>/g, '')
          .replace(new RegExp(String.raw`\x1b\[[0-9;]*[a-zA-Z]`, 'g'), '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!msgText) continue;
        if (
          /^(Caveat:|init\b|clear\b|resume\b|\/[a-z][\w-]*\b|You are a |\[Request |Set model to )/i.test(msgText) ||
          /^(Please )?(analyze|review) this codebase/i.test(msgText) ||
          /^(Read|Implement the following) .+, then (search|list|check) /i.test(msgText) ||
          /^\d+ vulnerabilit/i.test(msgText) ||
          /\btoolu_/.test(msgText) ||
          /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/.test(msgText) ||
          /\b(sk-ant-|ANTHROPIC_API_KEY|API_KEY=|SECRET|TOKEN=)/i.test(msgText) ||
          msgText.length < 8
        )
          continue;
        result = msgText.length > MAX_PROMPT_LEN ? msgText.slice(0, MAX_PROMPT_LEN) + '…' : msgText;
      } catch {
        // Malformed line — skip
      }
    }
    return result;
  }

  /**
   * Decode a Claude project key (e.g. "-Users-teigen-Documents-Workspace-AI-project-Mirror")
   * back to a filesystem path ("/Users/teigen/Documents/Workspace/AI_project/Mirror").
   *
   * Claude CLI encodes both '/' and '_' as '-', so each '-' in the key could be
   * any of: '/' (path separator), '_' (underscore), or '-' (literal dash).
   *
   * Strategy: recursive backtracking with longest-match-first preference.
   * At each segment boundary, try joining as many segments as possible (with '_'
   * or '-') into a single existing directory name. If a shorter match leads to a
   * dead end, backtrack and try the next-shorter candidate.
   *
   * Why backtracking: when both `diary/` and `diary-app/` exist as siblings, the
   * naive shortest-match would pick `diary` and then fail to find `app` inside,
   * leaving the rest of the key unresolved. Longest-first picks `diary-app`.
   */
  async function decodeProjectKey(projKey: string): Promise<string> {
    const encoded = projKey.startsWith('-') ? projKey.slice(1) : projKey;
    const segments = encoded.split('-');

    const isDirCache = new Map<string, boolean>();
    const isDir = async (p: string): Promise<boolean> => {
      const cached = isDirCache.get(p);
      if (cached !== undefined) return cached;
      const result = await fs
        .stat(p)
        .then((s) => s.isDirectory())
        .catch(() => false);
      isDirCache.set(p, result);
      return result;
    };

    // Recursive backtracking: returns the deepest valid path that consumes all
    // segments. Tries the longest segment-join first at each step so that
    // dash-containing directory names win over shorter same-prefix siblings.
    async function tryDecode(idx: number, current: string): Promise<string | null> {
      if (idx >= segments.length) return current;
      const maxLook = Math.min(idx + 4, segments.length);
      // Longest first: end = maxLook-1 down to idx
      for (let end = maxLook - 1; end >= idx; end--) {
        const candidates: string[] = [];
        if (end === idx) {
          // Skip an EMPTY segment: `isDir(current + '/' + '')` stats `current + '/'`,
          // which always succeeds, so the empty candidate would match unconditionally
          // and swallow the doubled dash that is the whole signature of a dotdir. It
          // then resolves "/home/x/.sib" to "/home/x//sib" whenever a non-dot sibling
          // exists, and shadows the dotdir branch below in every other case.
          if (segments[idx] !== '') candidates.push(segments[idx]);
        } else {
          candidates.push(segments.slice(idx, end + 1).join('-'));
          candidates.push(segments.slice(idx, end + 1).join('_'));
        }
        for (const child of candidates) {
          const candidate = current + '/' + child;
          if (await isDir(candidate)) {
            const result = await tryDecode(end + 1, candidate);
            if (result) return result;
          }
        }
      }
      // The encoder maps both '/' and '.' to '-', so a literal '.' in the
      // original path (e.g. "/home/timkjr/.codeman") collapses into an empty
      // split segment here. Retry this window as a dotdir/dotfile: ".<join>".
      if (segments[idx] === '' && idx + 1 < segments.length) {
        const dotMaxLook = Math.min(idx + 1 + 4, segments.length);
        for (let end = dotMaxLook - 1; end >= idx + 1; end--) {
          const dotCandidates =
            end === idx + 1
              ? [segments[idx + 1]]
              : [segments.slice(idx + 1, end + 1).join('-'), segments.slice(idx + 1, end + 1).join('_')];
          for (const child of dotCandidates) {
            const candidate = current + '/.' + child;
            if (await isDir(candidate)) {
              const result = await tryDecode(end + 1, candidate);
              if (result) return result;
            }
          }
        }
      }
      return null;
    }

    const decoded = await tryDecode(0, '');
    if (decoded) return decoded;

    // Fallback: greedy shortest-match (original behavior) — best effort when
    // no fully-valid path exists (e.g. directory was deleted after the
    // conversation was recorded).
    let current = '';
    let i = 0;
    while (i < segments.length) {
      let matched = false;
      const maxLook = Math.min(i + 4, segments.length);
      for (let end = i; end < maxLook; end++) {
        const candidates: string[] = [];
        if (end === i) {
          // Same empty-segment skip as tryDecode above. This loop is shortest-match
          // first, so without it the empty candidate matches on the very first try
          // and sets `matched`, leaving the dotdir branch below permanently dead.
          if (segments[i] !== '') candidates.push(segments[i]);
        } else {
          candidates.push(segments.slice(i, end + 1).join('_'));
          candidates.push(segments.slice(i, end + 1).join('-'));
        }
        for (const child of candidates) {
          const candidate = current + '/' + child;
          if (await isDir(candidate)) {
            current = candidate;
            i = end + 1;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched && segments[i] === '' && i + 1 < segments.length) {
        const dotMaxLook = Math.min(i + 1 + 4, segments.length);
        for (let end = i + 1; end < dotMaxLook; end++) {
          const dotCandidates =
            end === i + 1
              ? [segments[i + 1]]
              : [segments.slice(i + 1, end + 1).join('_'), segments.slice(i + 1, end + 1).join('-')];
          for (const child of dotCandidates) {
            const candidate = current + '/.' + child;
            if (await isDir(candidate)) {
              current = candidate;
              i = end + 1;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (!matched) {
        if (segments[i] === '') {
          // Nothing on disk matched (the usual reason this fallback runs at all is
          // that the directory was deleted). An empty segment still means the
          // encoder ate a literal '.', so guess the dotdir form rather than
          // appending a bare '/' and emitting a "//" path.
          if (i + 1 < segments.length) {
            current = current + '/.' + segments[i + 1];
            i += 2;
          } else {
            i++;
          }
        } else {
          current = current + '/' + segments[i];
          i++;
        }
      }
    }
    const finalExists = await fs
      .access(current)
      .then(() => true)
      .catch(() => false);
    return finalExists ? current : process.env.HOME || '/tmp';
  }

  /** Read the first 16KB of a file for content sniffing. */
  async function readFileHead(path: string, buf: Buffer): Promise<string | null> {
    try {
      const fd = await fs.open(path, 'r');
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      return buf.toString('utf8', 0, bytesRead);
    } catch {
      return null;
    }
  }

  /** Read the last `buf.length` bytes of a file (for tail-scanning user prompts). */
  async function readFileTail(path: string, buf: Buffer, fileSize: number): Promise<string | null> {
    try {
      const fd = await fs.open(path, 'r');
      const offset = Math.max(0, fileSize - buf.length);
      const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
      await fd.close();
      const text = buf.toString('utf8', 0, bytesRead);
      // Skip first partial line when we didn't read from the start
      if (offset > 0) {
        const nl = text.indexOf('\n');
        return nl >= 0 ? text.slice(nl + 1) : null;
      }
      return text;
    } catch {
      return null;
    }
  }

  type HistorySession = {
    sessionId: string;
    workingDir: string;
    projectKey: string;
    sizeBytes: number;
    lastModified: string;
    firstPrompt?: string;
    lastPrompt?: string;
  };

  // Scan a single project directory and return all valid history sessions in it.
  // Reused by both the global overview and the single-folder drill-down.
  async function scanProjectDir(projPath: string, projDir: string, headBuf: Buffer): Promise<HistorySession[]> {
    const out: HistorySession[] = [];
    const stat = await fs.stat(projPath).catch(() => null);
    if (!stat?.isDirectory()) return out;

    const workingDir = await decodeProjectKey(projDir);
    const entries = await fs.readdir(projPath).catch(() => [] as string[]);

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace('.jsonl', '');
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) continue;

      const filePath = join(projPath, entry);
      const fileStat = await fs.stat(filePath).catch(() => null);
      if (!fileStat) continue;
      if (fileStat.size < 4000) continue;

      let firstPrompt: string | undefined;
      const head = await readFileHead(filePath, headBuf);
      const hasConversation = (text: string) =>
        text.includes('"type":"user"') || text.includes('"type":"assistant"') || text.includes('"type":"summary"');

      let foundContent = head ? hasConversation(head) : false;
      let tail: string | null = null;
      if (!foundContent && fileStat.size > headBuf.length) {
        const tailBuf = Buffer.alloc(32768);
        tail = await readFileTail(filePath, tailBuf, fileStat.size);
        if (tail) foundContent = hasConversation(tail);
      }
      if (!foundContent) continue;

      if (head) firstPrompt = extractFirstUserPrompt(head);
      if (!firstPrompt && fileStat.size > headBuf.length) {
        if (!tail) {
          const tailBuf = Buffer.alloc(32768);
          tail = await readFileTail(filePath, tailBuf, fileStat.size);
        }
        if (tail) firstPrompt = extractFirstUserPrompt(tail);
      }

      // COD-145: last (most recent) user prompt lives near the END of the file, so
      // prefer the tail. For large files where no tail was read yet, read one
      // (mirrors the firstPrompt > headBuf.length block). Small files fit in `head`,
      // which then contains the whole transcript — scan it for the last match instead.
      if (!tail && fileStat.size > headBuf.length) {
        const tailBuf = Buffer.alloc(32768);
        tail = await readFileTail(filePath, tailBuf, fileStat.size);
      }
      const lastPrompt =
        (tail ? extractLastUserPrompt(tail) : undefined) ?? (head ? extractLastUserPrompt(head) : undefined);

      // Automated/SDK-driven invocations (CI review bots, etc.) write transcripts
      // into the same ~/.claude/projects tree as interactive sessions but were
      // never something a user can resume into — no PTY, no running process, and
      // their "conversation" is typically a single one-shot prompt (often with a
      // full diff embedded, which is exactly why it dwarfs this scanner's read
      // windows and shows up above as blank or as an identical boilerplate
      // sentence across many rows). Checked last, so it reuses whatever `head`/
      // `tail` the prompt extraction above already read rather than triggering
      // an extra file read. Missing entrypoint (older transcripts) reads as
      // interactive — fail open, matching every other gating check in this
      // codebase.
      const entrypoint =
        (head ? extractTranscriptEntrypoint(head) : undefined) ??
        (tail ? extractTranscriptEntrypoint(tail) : undefined);
      if (entrypoint && entrypoint !== 'cli') continue;

      out.push({
        sessionId,
        workingDir,
        projectKey: projDir,
        sizeBytes: fileStat.size,
        lastModified: fileStat.mtime.toISOString(),
        firstPrompt,
        lastPrompt,
      });
    }
    return out;
  }

  app.get('/api/history/sessions', async (req) => {
    const query = req.query as { projectKey?: string; offset?: string; limit?: string };
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
    // 128KB (was 16KB): a session restarted many times over the course of a long
    // conversation accumulates small bookkeeping lines (mode/permission-mode/
    // last-prompt/queue-operation, one batch per restart) ahead of the real first
    // message. 16KB was enough margin for a handful of restarts but not dozens —
    // a genuinely tiny first message still came up blank because the metadata
    // alone crossed the window. 128KB matches the existing precedent elsewhere in
    // this file (line ~1431) rather than inventing a new size.
    const headBuf = Buffer.alloc(131072);
    // Multi-user: this scans the host-wide ~/.claude/projects tree, so a non-admin
    // must only see history whose decoded workingDir is inside their own case space.
    // Do NOT trust the caller-supplied projectKey — confine on the decoded path.
    // No-op for admins / single-user mode.
    const user = getAuthUser(req);
    const scopeHistory = isMultiUserMode() && user.role !== 'admin';

    // Single-folder drill-down: when projectKey is provided, scan only that
    // directory, bypass the 50-cap, and honor offset/limit pagination.
    if (query.projectKey) {
      // Validate projectKey format to prevent path traversal
      if (!/^[A-Za-z0-9_-]+$/.test(query.projectKey)) {
        return { sessions: [], total: 0 };
      }
      const offset = Math.max(0, parseInt(query.offset || '0', 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10) || 20));
      const projPath = join(projectsDir, query.projectKey);
      let all = await scanProjectDir(projPath, query.projectKey, headBuf);
      // Confine to the caller's workspace (a projectKey maps to a single foreign cwd).
      if (scopeHistory) all = all.filter((r) => isWorkingDirAllowed(user, r.workingDir));
      all.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      return { sessions: all.slice(offset, offset + limit), total: all.length };
    }

    // Global overview: scan all projects, return up to 50 most-recent sessions.
    let results: HistorySession[] = [];
    try {
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const projPath = join(projectsDir, projDir);
        const list = await scanProjectDir(projPath, projDir, headBuf);
        results.push(...list);
      }
    } catch {
      // Projects dir may not exist
    }

    // Multi-user: drop rows outside the non-admin caller's own case space.
    if (scopeHistory) results = results.filter((r) => isWorkingDirAllowed(user, r.workingDir));
    results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return { sessions: results.slice(0, 50) };
  });

  // Unified, read-only session list: merges live + persisted + lifecycle +
  // transcript history + mux stats into one de-duplicated, searchable list
  // (COD-121). Pure merge/filter logic lives in unified-session-service.ts.
  app.get('/api/sessions/unified', async (req) => {
    const query = req.query as { q?: string; offset?: string; limit?: string };

    if (ctx.testMode) {
      return { sessions: [], total: 0 };
    }

    // Live (in-memory) sessions.
    const live: LiveSessionInput[] = [...ctx.sessions.values()].map((s) => {
      const st = s.toState();
      return {
        id: st.id,
        name: st.name,
        mode: st.mode,
        status: st.status,
        isWorking: s.isWorking,
        workingDir: st.workingDir,
        createdAt: st.createdAt,
        lastActivityAt: st.lastActivityAt,
        claudeSessionId: s.claudeSessionId ?? undefined,
        pinned: st.pinned,
        pinnedAt: st.pinnedAt,
      };
    });

    // Persisted sessions (state.json). resumeSessionId is the Claude
    // conversation UUID a resumed session continues — feed it to the merge's
    // alias map so its transcript row folds into this session.
    const persisted: PersistedSessionInput[] = Object.values(ctx.store.getState().sessions).map((p) => ({
      id: p.id,
      name: p.name,
      mode: p.mode,
      status: p.status,
      workingDir: p.workingDir,
      createdAt: p.createdAt,
      lastActivityAt: p.lastActivityAt,
      claudeSessionId: p.resumeSessionId,
      pinned: p.pinned,
      pinnedAt: p.pinnedAt,
    }));

    // Lifecycle audit log (newest-first, capped).
    let lifecycle: LifecycleInput[] = [];
    try {
      const entries = await getLifecycleLog().query({ limit: 2000 });
      lifecycle = entries.map((e) => ({
        sessionId: e.sessionId,
        name: e.name,
        mode: e.mode,
        ts: e.ts,
        event: e.event,
      }));
    } catch {
      // Lifecycle log may be unavailable; treat as empty.
    }

    // Transcript history (~/.claude/projects) — reuse the same scanner as the overview.
    const history: HistoryInput[] = [];
    try {
      const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
      // 128KB (was 16KB) — see the sibling allocation above for why.
      const headBuf = Buffer.alloc(131072);
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const projPath = join(projectsDir, projDir);
        const list = await scanProjectDir(projPath, projDir, headBuf);
        for (const h of list) {
          history.push({
            sessionId: h.sessionId,
            workingDir: h.workingDir,
            sizeBytes: h.sizeBytes,
            lastModified: h.lastModified,
            firstPrompt: h.firstPrompt,
            lastPrompt: h.lastPrompt,
            projectKey: h.projectKey,
          });
        }
      }
    } catch {
      // Projects dir may not exist.
    }

    // Mux process stats (best-effort; guard against mocks lacking the method).
    let mux: MuxStatInput[] = [];
    try {
      const getStats = (ctx.mux as { getSessionsWithStats?: () => Promise<unknown[]> }).getSessionsWithStats;
      if (typeof getStats === 'function') {
        const muxSessions = (await getStats.call(ctx.mux)) as Array<{
          sessionId: string;
          muxName?: string;
          mode?: string;
          remote?: unknown;
          stats?: { memoryMB: number; cpuPercent: number };
        }>;
        mux = muxSessions.map((m) => ({
          sessionId: m.sessionId,
          muxName: m.muxName,
          mode: m.mode,
          remote: m.remote !== undefined ? true : undefined,
          stats: m.stats ? { memoryMB: m.stats.memoryMB, cpuPercent: m.stats.cpuPercent } : undefined,
        }));
      }
    } catch {
      // Mux stats are optional.
    }

    // Multi-user: a non-admin only sees their own sessions; host-wide transcript
    // history (not tied to an owned session) is admin-only.
    let sLive = live;
    let sPersisted = persisted;
    let sLifecycle = lifecycle;
    let sHistory = history;
    const uUser = getAuthUser(req);
    if (isMultiUserMode() && uUser.role !== 'admin') {
      const ownedLive = new Set(
        [...ctx.sessions.values()].filter((s) => canAccessOwned(uUser, s.owner)).map((s) => s.id)
      );
      const stored = ctx.store.getState().sessions as Record<string, { id: string; owner?: string }>;
      const ownedPersisted = new Set(
        Object.values(stored)
          .filter((p) => canAccessOwned(uUser, p.owner))
          .map((p) => p.id)
      );
      const isOwned = (id: string) => ownedLive.has(id) || ownedPersisted.has(id);
      sLive = live.filter((l) => isOwned(l.id));
      sPersisted = persisted.filter((p) => isOwned(p.id));
      sLifecycle = lifecycle.filter((e) => isOwned(e.sessionId));
      sHistory = [];
    }

    const merged = mergeUnifiedSessions({
      live: sLive,
      persisted: sPersisted,
      lifecycle: sLifecycle,
      history: sHistory,
      mux,
    });
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : undefined;
    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
    return filterAndPaginate(merged, {
      q: query.q,
      offset: Number.isNaN(offset as number) ? undefined : offset,
      limit: Number.isNaN(limit as number) ? undefined : limit,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Paste Image (clipboard / drag-drop upload)
  // ═══════════════════════════════════════════════════════════════

  const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);
  // The per-file size cap (MAX_PASTE_IMAGE_BYTES) is enforced by @fastify/multipart (registered in server.ts).

  app.post('/api/sessions/:id/paste-image', async (req, reply) => {
    // CSRF defense: state-changing routes must come from same origin.
    // Cookies are SameSite=lax, multipart/form-data is a "simple" CORS request
    // (no preflight), so a cross-origin <form enctype="multipart/form-data">
    // submit attaches the session cookie unimpeded. Reject unless Origin/Referer
    // matches req.host. Non-browser clients (no Origin AND no Referer) must
    // supply X-Codeman-CSRF — a header browsers cannot add cross-origin without
    // a preflight, which our CORS config does not allow from other origins.
    const reqHost = req.headers.host;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    let csrfOk = false;
    if (origin) {
      try {
        csrfOk = new URL(origin).host === reqHost;
      } catch {
        /* invalid Origin → not ok */
      }
    } else if (referer) {
      try {
        csrfOk = new URL(referer).host === reqHost;
      } catch {
        /* invalid Referer → not ok */
      }
    } else {
      csrfOk = !!req.headers['x-codeman-csrf'];
    }
    if (!csrfOk) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'CSRF check failed');
    }

    const { id } = req.params as { id: string };

    // Rate limit per (IP, sessionId): 30/min. Defends against disk-fill DoS
    // — even an authenticated attacker can otherwise loop large image POSTs.
    if (!consumePasteToken(`${req.ip}:${id}`)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Rate limit exceeded (30 uploads/min per session)');
    }

    const session = findSessionOrFail(ctx, id, req);

    if (!req.isMultipart()) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Read the single file part. @fastify/multipart enforces the per-file size
    // cap (MAX_PASTE_IMAGE_BYTES) and the 1-file/4-field count limits (server.ts),
    // replacing a hand-rolled
    // boundary scanner with several bugs: literal boundary matches anywhere in
    // body, LF-only clients silently corrupted the last byte (hard-coded \r\n
    // offsets), no part-count cap.
    let part: import('@fastify/multipart').MultipartFile | undefined;
    try {
      part = await req.file();
    } catch (err: unknown) {
      reply.code(413);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || 'Invalid multipart payload');
    }
    if (!part) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No image uploaded');
    }
    if (part.fieldname !== 'image') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Unexpected field "${part.fieldname}", expected "image"`);
    }
    let imageBytes: Buffer;
    try {
      imageBytes = await part.toBuffer();
    } catch (err: unknown) {
      reply.code(413);
      const maxMb = Math.round(MAX_PASTE_IMAGE_BYTES / (1024 * 1024));
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || `File too large (max ${maxMb}MB)`);
    }
    if (imageBytes.length === 0) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Empty file');
    }

    // Determine extension from filename or Content-Type.
    let ext = '.png';
    if (part.filename) {
      const origExt = extname(part.filename).toLowerCase();
      if (ALLOWED_IMAGE_EXTS.has(origExt)) ext = origExt;
    }
    const mimeMatch = (part.mimetype || '').toLowerCase().match(/^image\/(png|jpeg|jpg|webp|gif|bmp|heic|heif)$/);
    if (mimeMatch) {
      const map: Record<string, string> = {
        png: '.png',
        jpeg: '.jpg',
        jpg: '.jpg',
        webp: '.webp',
        gif: '.gif',
        bmp: '.bmp',
        heic: '.heic',
        heif: '.heif',
      };
      ext = map[mimeMatch[1]] ?? ext;
    }

    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unsupported image type: ${ext}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}`
      );
    }

    // Route HEIC on the raw bytes, NOT the declared ext/mime: on some Android
    // galleries (e.g. MIUI) a HEIF comes back mislabeled as image/jpeg, and
    // browsers that cannot decode HEIF upload the original file as-is — so a
    // HEIC payload can arrive under any declared type. Filename and
    // Content-Type are attacker-supplied anyway; only the bytes are trusted.
    if (imageMagicMatchesExt(imageBytes, '.heic')) {
      try {
        imageBytes = await convertHeicToJpeg(imageBytes);
        ext = '.jpg';
      } catch (err: unknown) {
        console.warn(
          `[paste-image] HEIC conversion failed: filename=${JSON.stringify(part.filename)} mime=${JSON.stringify(part.mimetype)} error=${getErrorMessage(err)}`
        );
        reply.code(415);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Could not convert HEIC image to JPEG');
      }
    } else if (!imageMagicMatchesExt(imageBytes, ext)) {
      // Sniff actual bytes — a polyglot HTML/PNG would otherwise pass and
      // serve back with image/png MIME. Log the real header so format
      // mismatches can be pinned down without a reproduce-and-guess loop. The
      // client re-encodes images to JPEG/PNG before upload, so this is rare.
      console.warn(
        `[paste-image] magic mismatch: filename=${JSON.stringify(part.filename)} mime=${JSON.stringify(part.mimetype)} declaredExt=${ext} magic=${imageBytes.subarray(0, 12).toString('hex')}`
      );
      reply.code(415);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Image bytes do not match declared type ${ext}`);
    }

    // Save to {workingDir}/.claude-images/
    // Refuse symlinks at imageDir — an agent or postinstall script could plant
    // `.claude-images -> ~/.ssh/` and redirect future writes outside workingDir.
    // We lstat (not stat) so we see the symlink itself. Use mkdir without
    // `recursive` so the leaf creation does not follow a symlink either, and
    // O_EXCL|O_NOFOLLOW on the file open so the write itself is symlink-safe.
    const imageDir = join(session.workingDir, '.claude-images');
    try {
      const dirStat = await fs.lstat(imageDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.claude-images is not a regular directory');
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Non-recursive mkdir: does not follow symlinks for the leaf.
      // session.workingDir is guaranteed to exist (live session).
      try {
        await fs.mkdir(imageDir);
      } catch (mkErr: unknown) {
        // Concurrent uploads (a batch of photos) race to create .claude-images —
        // the losers get EEXIST. Treat an already-present REAL directory as
        // success, but re-verify it isn't a symlink a racing actor planted
        // (preserve the symlink-safety guarantee above).
        if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr;
        const raceStat = await fs.lstat(imageDir);
        if (raceStat.isSymbolicLink() || !raceStat.isDirectory()) {
          reply.code(403);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.claude-images is not a regular directory');
        }
      }
    }
    // Date.now() collides on same-ms uploads from two tabs (last-write wins
    // silently). Append 8 hex chars so concurrent pastes get distinct names.
    const filename = `paste-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    const filepath = join(imageDir, filename);
    // O_EXCL: refuse to overwrite (collision is impossible with random suffix,
    // but defends against TOCTOU). O_NOFOLLOW: refuse if filepath is a symlink.
    const fh = await fs.open(
      filepath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
    );
    try {
      await fh.writeFile(imageBytes);
    } finally {
      await fh.close();
    }

    return { path: filepath, filename };
  });
}
