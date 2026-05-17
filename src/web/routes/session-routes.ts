/**
 * @fileoverview Session management routes.
 * Covers session CRUD, input/output, terminal buffer, quick-start, quick-run,
 * auto-clear, auto-compact, image watcher, flicker filter, and logout.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type QuickStartResponse,
  type SessionColor,
} from '../../types.js';
import { Session } from '../../session.js';
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
  ImageWatcherSchema,
  FlickerFilterSchema,
  QuickRunSchema,
  QuickStartSchema,
} from '../schemas.js';
import {
  autoConfigureRalph,
  CASES_DIR,
  findSessionOrFail,
  parseBody,
  persistAndBroadcastSession,
  SETTINGS_PATH,
  validatePathWithinBase,
} from '../route-helpers.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import { writeHooksConfig, updateCaseModel, stripCaseEnvKeys } from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { imageWatcher } from '../../image-watcher.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort } from '../ports/index.js';
import { MAX_CONCURRENT_SESSIONS } from '../../config/map-limits.js';
import { RunSummaryTracker } from '../../run-summary.js';

import { MAX_INPUT_LENGTH, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js';

// Path to linked-cases registry (same file used by case-routes resolveCasePath)
const LINKED_CASES_FILE = join(homedir(), '.codeman', 'linked-cases.json');

// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
// eslint-disable-next-line no-control-regex
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

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
    return { success: true };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session CRUD (list, create, rename, color, delete, detail)
  // ═══════════════════════════════════════════════════════════════

  // ========== Session Listing ==========

  app.get('/api/sessions', async () => {
    return ctx.getLightSessionsState();
  });

  // ========== Session Creation ==========

  app.post('/api/sessions', async (req) => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`
      );
    }

    const body = parseBody(CreateSessionSchema, req.body);
    const workingDir = body.workingDir || process.cwd();

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
    //   - Claude mode (OpenCode doesn't read .claude/settings.local.json)
    //   - workingDir inside CASES_DIR (Codeman's managed territory — we never mutate
    //     .claude/settings.local.json in arbitrary user repos that POST /api/sessions
    //     can target, because those may have hand-authored values).
    const canStripDisk =
      body.mode !== 'opencode' &&
      body.envOverrides &&
      Object.keys(body.envOverrides).length > 0 &&
      workingDir.startsWith(CASES_DIR + '/');
    if (canStripDisk) {
      await stripCaseEnvKeys(workingDir, Object.keys(body.envOverrides!));
    }

    // Write model override to .claude/settings.local.json if provided
    if (body.modelOverride !== undefined) {
      await updateCaseModel(workingDir, body.modelOverride || null);
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
        : mode !== 'shell'
          ? modelConfig?.defaultModel || undefined
          : undefined;
    const claudeModeConfig = await ctx.getClaudeModeConfig();
    const session = new Session({
      workingDir,
      mode,
      name: body.name || '',
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? body.openCodeConfig : undefined,
      resumeSessionId: validatedResumeId,
      envOverrides: body.envOverrides,
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
    return { success: true, session: lightState };
  });

  // ========== Rename Session ==========

  app.put('/api/sessions/:id/name', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionNameSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    const name = String(body.name || '').slice(0, MAX_SESSION_NAME_LENGTH);
    session.name = name;
    // Also update the mux session name if applicable
    ctx.mux.updateSessionName(id, session.name);
    persistAndBroadcastSession(ctx, session);
    return { success: true, name: session.name };
  });

  // ========== Set Session Color ==========

  app.put('/api/sessions/:id/color', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionColorSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (!validColors.includes(body.color)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid color');
    }

    session.setColor(body.color as SessionColor);
    persistAndBroadcastSession(ctx, session);
    return { success: true, color: session.color };
  });

  // ========== Delete Session ==========

  app.delete('/api/sessions/:id', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const query = req.query as { killMux?: string };
    const killMux = query.killMux !== 'false'; // Default to true

    if (!ctx.sessions.has(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    await ctx.cleanupSession(id, killMux, 'user_delete');
    return { success: true };
  });

  // ========== Delete All Sessions ==========

  app.delete('/api/sessions', async (): Promise<ApiResponse<{ killed: number }>> => {
    const sessionIds = Array.from(ctx.sessions.keys());
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
    const session = findSessionOrFail(ctx, id);

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
    const session = findSessionOrFail(ctx, id);

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
    const session = findSessionOrFail(ctx, id);

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
    const session = findSessionOrFail(ctx, id);

    const tracker = ctx.runSummaryTrackers.get(id);
    if (!tracker) {
      // Create a fresh tracker if one doesn't exist (shouldn't happen normally)
      const newTracker = new RunSummaryTracker(id, session.name);
      ctx.runSummaryTrackers.set(id, newTracker);
      return { success: true, summary: newTracker.getSummary() };
    }

    // Update session name in case it changed
    tracker.setSessionName(session.name);

    return { success: true, summary: tracker.getSummary() };
  });

  // ========== Get Active Tools ==========

  app.get('/api/sessions/:id/active-tools', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

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

  app.post('/api/sessions/:id/run', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const { prompt } = parseBody(RunPromptSchema, req.body);
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // Run async, don't wait
    session.runPrompt(prompt).catch((err) => {
      ctx.broadcast(SseEvent.SessionError, { id, error: err.message });
    });

    ctx.broadcast(SseEvent.SessionRunning, { id, prompt });
    return { success: true };
  });

  // ========== Start Interactive Mode ==========

  app.post('/api/sessions/:id/interactive', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      // Ralph tracker is not supported for opencode sessions
      if (
        session.mode !== 'opencode' &&
        ctx.store.getConfig().ralphEnabled &&
        !session.ralphTracker.autoEnableDisabled
      ) {
        autoConfigureRalph(session, session.workingDir, ctx);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Start Shell Mode ==========

  app.post('/api/sessions/:id/shell', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      await session.startShell();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: 'shell',
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id, mode: 'shell' });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Terminal I/O (input, resize, buffer)
  // ═══════════════════════════════════════════════════════════════

  // ========== Send Input ==========

  app.post('/api/sessions/:id/input', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const { input, useMux } = parseBody(SessionInputWithLimitSchema, req.body);
    const session = findSessionOrFail(ctx, id);

    const inputStr = String(input);
    if (inputStr.length > MAX_INPUT_LENGTH) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Input exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`
      );
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
    return { success: true };
  });

  // ========== Send Named Key (tmux send-keys -H) ==========
  // Sends raw hex bytes to tmux pane for keys like Shift+Enter / Ctrl+Enter.
  // Uses send-keys -H (hex) to inject 0x0a (line feed) which Claude Code's
  // Ink input recognizes as "insert newline" vs 0x0d (carriage return = submit).

  app.post('/api/sessions/:id/send-key', async (req): Promise<ApiResponse> => {
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

    const session = findSessionOrFail(ctx, id);
    const muxName = session.muxName;
    if (!muxName) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No tmux session');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('tmux', ['send-keys', '-H', '-t', muxName, ...hex], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      console.error('[Server] send-key failed:', err);
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'tmux send-keys failed');
    }
    return { success: true };
  });

  // ========== Resize Terminal ==========

  app.post('/api/sessions/:id/resize', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const { cols, rows } = parseBody(ResizeSchema, req.body);
    const session = findSessionOrFail(ctx, id);

    session.resize(cols, rows);
    return { success: true };
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

  app.get('/api/sessions/:id/last-response', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    // Scan ~/.claude/projects/*/ for the transcript file
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');

    // Adopt the current conversation id if the user ran `/clear` — Claude CLI's
    // interactive PTY emits no JSON on stdout, so without this lookup the
    // stored id stays pinned to the pre-/clear transcript.
    const activeId = await resolveActiveClaudeSessionIdFromHistory(session, projectsDir);
    if (activeId && activeId !== session.claudeSessionId) {
      session.adoptClaudeSessionId(activeId);
    }

    // The Claude conversation ID (used as JSONL filename)
    const claudeSessionId = session.claudeSessionId || session.id;
    let transcriptText = '';
    let transcriptTimestamp = '';

    try {
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const jsonlPath = join(projectsDir, projDir, `${claudeSessionId}.jsonl`);
        try {
          const content = await fs.readFile(jsonlPath, 'utf8');
          const lines = content.trim().split('\n');

          // Search from end for last assistant message with text
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.type === 'assistant' && entry.message?.content) {
                const blocks = Array.isArray(entry.message.content)
                  ? entry.message.content
                  : [{ type: 'text', text: String(entry.message.content) }];
                const textBlocks = blocks
                  .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                  .map((b: { type: string; text?: string }) => b.text);
                if (textBlocks.length > 0) {
                  transcriptText = textBlocks.join('\n\n');
                  transcriptTimestamp = entry.timestamp || '';
                  break;
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
          if (transcriptText) break; // Found it, stop scanning directories
        } catch {
          // File doesn't exist in this project dir, continue
        }
      }
    } catch {
      // projects dir doesn't exist
    }

    // If ?context=full, return all user+assistant messages for conversation view
    const query = req.query as { context?: string };
    if (query.context === 'full' && transcriptText) {
      const allMessages: Array<{ role: string; text: string; timestamp?: string }> = [];
      try {
        const projectDirs = await fs.readdir(projectsDir);
        for (const projDir of projectDirs) {
          const jsonlPath = join(projectsDir, projDir, `${claudeSessionId}.jsonl`);
          try {
            const content = await fs.readFile(jsonlPath, 'utf8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'user' && entry.message?.content) {
                  const text =
                    typeof entry.message.content === 'string'
                      ? entry.message.content
                      : (entry.message.content as Array<{ type: string; text?: string }>)
                          .filter((b) => b.type === 'text' && b.text)
                          .map((b) => b.text)
                          .join('\n');
                  // Skip system/command messages
                  if (text && !text.startsWith('<local-command') && !text.startsWith('<command-name>')) {
                    allMessages.push({ role: 'user', text, timestamp: entry.timestamp });
                  }
                } else if (entry.type === 'assistant' && entry.message?.content) {
                  const blocks = Array.isArray(entry.message.content)
                    ? entry.message.content
                    : [{ type: 'text', text: String(entry.message.content) }];
                  const text = blocks
                    .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                    .map((b: { type: string; text?: string }) => b.text)
                    .join('\n\n');
                  if (text) {
                    allMessages.push({ role: 'assistant', text, timestamp: entry.timestamp });
                  }
                }
              } catch {
                /* skip */
              }
            }
            if (allMessages.length > 0) break;
          } catch {
            /* continue */
          }
        }
      } catch {
        /* ignore */
      }
      return { text: transcriptText, timestamp: transcriptTimestamp, messages: allMessages };
    }

    return {
      text: transcriptText,
      timestamp: transcriptTimestamp,
    };
  });

  // ========== Get Terminal Buffer ==========

  // Query params:
  //   tail=<bytes> - Only return last N bytes (faster initial load)
  app.get('/api/sessions/:id/terminal', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tail?: string };
    const session = findSessionOrFail(ctx, id);

    const tailBytes = query.tail ? parseInt(query.tail, 10) : 0;
    const fullSize = session.terminalBufferLength;
    let truncated = false;
    let cleanBuffer: string;

    // Strip redundant Ink spinner/status redraws BEFORE tailing.
    // During long thinking phases, Ink rewrites the same rows thousands of times
    // (500KB+). Without stripping, tail mode returns only spinner frames and
    // the terminal appears empty when switching tabs.
    const strippedBuffer = stripInkRedrawBloat(session.terminalBuffer);

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
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Settings (auto-clear, auto-compact, image watcher, flicker filter)
  // ═══════════════════════════════════════════════════════════════

  // ========== Auto-Clear ==========

  app.post('/api/sessions/:id/auto-clear', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoClearSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

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
    const session = findSessionOrFail(ctx, id);

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

  // ========== Image Watcher ==========

  app.post('/api/sessions/:id/image-watcher', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ImageWatcherSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

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
    const session = findSessionOrFail(ctx, id);

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
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`
      );
    }

    const {
      prompt,
      workingDir,
      envOverrides: runEnvOverrides,
    } = parseBody(QuickRunSchema, req.body, 'Invalid request body');

    if (!prompt.trim()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'prompt is required');
    }
    const dir = workingDir || process.cwd();

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

    const session = new Session({ workingDir: dir, envOverrides: runEnvOverrides });
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
      return { success: true, sessionId: session.id, ...result };
    } catch (err) {
      // Clean up session on error too
      await ctx.cleanupSession(session.id, true, 'run_prompt_error');
      return { success: false, sessionId: session.id, error: getErrorMessage(err) };
    }
  });

  // ========== Quick Start ==========

  app.post('/api/quick-start', async (req): Promise<QuickStartResponse> => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.`
      );
    }

    const {
      caseName = 'testcase',
      mode = 'claude',
      openCodeConfig,
      envOverrides,
    } = parseBody(QuickStartSchema, req.body);

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
    const linkedCasePath = linkedCases[caseName];
    const casePath = linkedCasePath || validatePathWithinBase(caseName, CASES_DIR);
    if (!casePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    // Create case folder and CLAUDE.md if it doesn't exist (only for non-linked cases)
    if (!existsSync(casePath)) {
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = await ctx.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(caseName, '', templatePath);
        writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

        // Write .claude/settings.local.json with hooks for desktop notifications
        // (Claude-specific — OpenCode uses its own plugin system)
        if (mode !== 'opencode') {
          await writeHooksConfig(casePath);
        }

        ctx.broadcast(SseEvent.CaseCreated, { name: caseName, path: casePath });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }
    }

    // Strip stale disk entries for keys this request is actively setting (Claude only —
    // see POST /api/sessions for full rationale).
    if (mode !== 'opencode' && envOverrides && Object.keys(envOverrides).length > 0) {
      await stripCaseEnvKeys(casePath, Object.keys(envOverrides));
    }

    // Create a new session with the case as working directory
    // Apply global Nice priority config and model config from settings
    const niceConfig = await ctx.getGlobalNiceConfig();
    const qsModelConfig = await ctx.getModelConfig();
    const qsModel =
      mode === 'opencode'
        ? openCodeConfig?.model
        : mode !== 'shell'
          ? qsModelConfig?.defaultModel || undefined
          : undefined;
    const qsClaudeModeConfig = await ctx.getClaudeModeConfig();
    const session = new Session({
      workingDir: casePath,
      mux: ctx.mux,
      useMux: true,
      mode: mode,
      niceConfig: niceConfig,
      model: qsModel,
      claudeMode: qsClaudeModeConfig.claudeMode,
      allowedTools: qsClaudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? openCodeConfig : undefined,
      envOverrides,
    });

    // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
    // so the initial state already has the phrase configured (only if globally enabled)
    if (mode === 'claude' && ctx.store.getConfig().ralphEnabled) {
      autoConfigureRalph(session, casePath, ctx);
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
        // Both 'claude' and 'opencode' modes use startInteractive()
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
        success: true,
        sessionId: session.id,
        casePath,
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
   * Decode a Claude project key (e.g. "-Users-teigen-Documents-Workspace-AI-project-Mirror")
   * back to a filesystem path ("/Users/teigen/Documents/Workspace/AI_project/Mirror").
   *
   * Claude CLI encodes both '/' and '_' as '-', so each '-' in the key could be
   * any of: '/' (path separator), '_' (underscore), or '-' (literal dash).
   *
   * Strategy: look-ahead matching. At each '-', try consuming multiple segments
   * joined by '_' or '-' to find an existing child directory, then recurse.
   * E.g. for segments [AI, project, Mirror] inside /Workspace:
   *   try /Workspace/AI (no) -> /Workspace/AI_project (yes!) -> continue with [Mirror]
   */
  async function decodeProjectKey(projKey: string): Promise<string> {
    const encoded = projKey.startsWith('-') ? projKey.slice(1) : projKey;
    const segments = encoded.split('-');

    const isDir = async (p: string): Promise<boolean> =>
      fs
        .stat(p)
        .then((s) => s.isDirectory())
        .catch(() => false);

    let current = '';
    let i = 0;

    while (i < segments.length) {
      // Try progressively longer child names by joining segments with '_' or '-'
      let matched = false;
      // Limit look-ahead to avoid excessive fs checks (max 4 segments per component)
      const maxLook = Math.min(i + 4, segments.length);
      for (let end = i; end < maxLook; end++) {
        // Build candidate child name from segments[i..end]
        // Try all separator combinations: for 2+ segments, try '_' first then '-'
        const candidates: string[] = [];
        if (end === i) {
          candidates.push(segments[i]);
        } else {
          // Build with underscores between joined segments
          candidates.push(segments.slice(i, end + 1).join('_'));
          // Build with dashes (literal)
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
      if (!matched) {
        // No directory match found — append as-is and move on
        current = current + '/' + segments[i];
        i++;
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

  app.get('/api/history/sessions', async () => {
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
    const results: Array<{
      sessionId: string;
      workingDir: string;
      projectKey: string;
      sizeBytes: number;
      lastModified: string;
      firstPrompt?: string;
    }> = [];
    const headBuf = Buffer.alloc(16384);

    try {
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const projPath = join(projectsDir, projDir);
        const stat = await fs.stat(projPath).catch(() => null);
        if (!stat?.isDirectory()) continue;

        // Decode project key to working dir. Claude CLI encodes '/' as '-',
        // but path components may also contain '-' (e.g. "AI_project" vs "AI-project").
        // Use recursive backtracking: try each '-' as either '/' or literal '-',
        // verify which decoded path actually exists on disk.
        const workingDir = await decodeProjectKey(projDir);

        const entries = await fs.readdir(projPath);
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue;
          const sessionId = entry.replace('.jsonl', '');
          // Only valid UUIDs
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) continue;

          const filePath = join(projPath, entry);
          const fileStat = await fs.stat(filePath).catch(() => null);
          if (!fileStat) continue;
          // Skip files too small to contain real conversation (metadata-only sessions
          // like file-history-snapshot entries are typically < 4KB)
          if (fileStat.size < 4000) continue;

          // Quick content check: verify actual conversation data exists.
          // Sessions with only file-history-snapshot or hook_progress entries have
          // no "user"/"assistant" messages and will fail claude --resume.
          // Read first 16KB to check content and extract first user prompt.
          let firstPrompt: string | undefined;
          const head = await readFileHead(filePath, headBuf);
          const hasConversation = (text: string) =>
            text.includes('"type":"user"') || text.includes('"type":"assistant"') || text.includes('"type":"summary"');

          let foundContent = head ? hasConversation(head) : false;

          // For large files, head may not contain user messages (e.g. /init followed
          // by large system entries). Check the tail as well.
          let tail: string | null = null;
          if (!foundContent && fileStat.size > 16384) {
            const tailBuf = Buffer.alloc(32768);
            tail = await readFileTail(filePath, tailBuf, fileStat.size);
            if (tail) foundContent = hasConversation(tail);
          }

          if (!foundContent) continue; // No conversation content — skip

          if (head) firstPrompt = extractFirstUserPrompt(head);

          // If head scan found no usable prompt (e.g. session started with /init),
          // try reading the tail for a recent user message.
          if (!firstPrompt && fileStat.size > 65536) {
            if (!tail) {
              const tailBuf = Buffer.alloc(32768);
              tail = await readFileTail(filePath, tailBuf, fileStat.size);
            }
            if (tail) firstPrompt = extractFirstUserPrompt(tail);
          }

          results.push({
            sessionId,
            workingDir,
            projectKey: projDir,
            sizeBytes: fileStat.size,
            lastModified: fileStat.mtime.toISOString(),
            firstPrompt,
          });
        }
      }
    } catch {
      // Projects dir may not exist
    }

    // Sort by lastModified descending
    results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return { sessions: results.slice(0, 50) };
  });

  // ═══════════════════════════════════════════════════════════════
  // Paste Image (clipboard / drag-drop upload)
  // ═══════════════════════════════════════════════════════════════

  const MAX_PASTE_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
  const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

  app.post('/api/sessions/:id/paste-image', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('multipart/form-data')) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Parse multipart boundary
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing boundary');
    }

    // Collect raw body with size limit
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req.raw) {
      totalSize += chunk.length;
      if (totalSize > MAX_PASTE_IMAGE_SIZE) {
        reply.code(413);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'File too large (max 10MB)');
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Extract image from multipart body
    const boundary = '--' + boundaryMatch[1];
    const boundaryBuf = Buffer.from(boundary);
    const parts: { headers: string; data: Buffer }[] = [];
    let pos = 0;

    while (pos < body.length) {
      const start = body.indexOf(boundaryBuf, pos);
      if (start === -1) break;
      const afterBoundary = start + boundaryBuf.length;
      if (body[afterBoundary] === 0x2d && body[afterBoundary + 1] === 0x2d) break;
      const headerStart = afterBoundary + 2;
      const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
      if (headerEnd === -1) break;
      const headers = body.subarray(headerStart, headerEnd).toString();
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(boundaryBuf, dataStart);
      const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2;
      parts.push({ headers, data: body.subarray(dataStart, dataEnd) });
      pos = nextBoundary === -1 ? body.length : nextBoundary;
    }

    const imagePart = parts.find((p) => p.headers.includes('name="image"'));
    if (!imagePart || imagePart.data.length === 0) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No image uploaded');
    }

    // Determine extension from filename or Content-Type
    let ext = '.png';
    const filenameMatch = imagePart.headers.match(/filename="(.+?)"/);
    if (filenameMatch) {
      const origExt = extname(filenameMatch[1]).toLowerCase();
      if (ALLOWED_IMAGE_EXTS.has(origExt)) ext = origExt;
    }
    const ctMatch = imagePart.headers.match(/Content-Type:\s*image\/(png|jpeg|jpg|webp|gif|bmp)/i);
    if (ctMatch) {
      const map: Record<string, string> = {
        png: '.png',
        jpeg: '.jpg',
        jpg: '.jpg',
        webp: '.webp',
        gif: '.gif',
        bmp: '.bmp',
      };
      ext = map[ctMatch[1].toLowerCase()] ?? ext;
    }

    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unsupported image type: ${ext}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}`
      );
    }

    // Save to {workingDir}/.claude-images/
    const imageDir = join(session.workingDir, '.claude-images');
    if (!existsSync(imageDir)) {
      mkdirSync(imageDir, { recursive: true });
    }
    const filename = `paste-${Date.now()}${ext}`;
    const filepath = join(imageDir, filename);
    await fs.writeFile(filepath, imagePart.data);

    return { success: true, path: filepath, filename };
  });
}
