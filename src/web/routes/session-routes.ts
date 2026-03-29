/**
 * @fileoverview Session management routes.
 * Covers session CRUD, input/output, terminal buffer, quick-start, quick-run,
 * auto-clear, auto-compact, image watcher, flicker filter, and logout.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { writeHooksConfig, updateCaseEnvVars, updateCaseModel } from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { imageWatcher } from '../../image-watcher.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort } from '../ports/index.js';
import { MAX_CONCURRENT_SESSIONS } from '../../config/map-limits.js';
import { RunSummaryTracker } from '../../run-summary.js';

import { MAX_INPUT_LENGTH, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js';

// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
// eslint-disable-next-line no-control-regex
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

/**
 * Strip redundant Ink spinner/status-bar redraw frames from the terminal buffer.
 * Ink (Claude Code's TUI) uses absolute cursor positioning (CSI n d = VPA, CSI n;m H = CUP)
 * to animate the spinner and update the status bar. During long thinking phases, these frames
 * accumulate to 500KB+ of repeated overwrites to the same rows. When the buffer is tailed,
 * only spinner frames are returned, making the terminal appear empty.
 *
 * Strategy: find where absolute-positioned redraws begin (first VPA sequence), then keep
 * only the last ~4KB of redraw frames (the final visual state) and discard the rest.
 */
function stripInkRedrawBloat(buffer: string): string {
  // Find where Ink's absolute-positioned redraws start (first CSI n d = VPA)
  // eslint-disable-next-line no-control-regex
  const firstVPA = buffer.search(/\x1b\[\d+d/);
  if (firstVPA === -1) return buffer; // No Ink redraws

  const contentPart = buffer.slice(0, firstVPA);
  const redrawPart = buffer.slice(firstVPA);

  // If the redraw section is small (<16KB), not worth stripping
  if (redrawPart.length < 16384) return buffer;

  // Find the last complete Ink frame by searching for where the VPA row
  // number drops (cursor jumps back to viewport top for a new render cycle).
  // Search the last 64KB — a single Ink frame with response content can be
  // 10-20KB, so 4KB was too small and caused partial frames (blank gap).
  const searchLen = Math.min(redrawPart.length, 65536);
  const searchWindow = redrawPart.slice(-searchLen);

  // eslint-disable-next-line no-control-regex
  const vpaRe = /\x1b\[(\d+)d/g;
  let lastFrameStart = 0;
  let prevRow = -1;
  let match;
  while ((match = vpaRe.exec(searchWindow)) !== null) {
    const row = parseInt(match[1], 10);
    // Row number dropped significantly — Ink started a new frame
    if (prevRow > 0 && row < prevRow - 5) {
      lastFrameStart = match.index;
    }
    prevRow = row;
  }

  return contentPart + searchWindow.slice(lastFrameStart);
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

    // Write env overrides to .claude/settings.local.json if provided
    if (body.envOverrides && Object.keys(body.envOverrides).length > 0) {
      await updateCaseEnvVars(workingDir, body.envOverrides);
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
      resumeSessionId: body.resumeSessionId,
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
    const muxName = (session as any)._muxSession?.muxName;
    if (!muxName) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No tmux session');
    }

    try {
      const { execFileSync } = await import('child_process');
      execFileSync('tmux', ['send-keys', '-H', '-t', muxName, ...hex], { timeout: 5000 });
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

    const { prompt, workingDir } = parseBody(QuickRunSchema, req.body, 'Invalid request body');

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

    const session = new Session({ workingDir: dir });
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

    const { caseName = 'testcase', mode = 'claude', openCodeConfig } = parseBody(QuickStartSchema, req.body);

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

    const casePath = validatePathWithinBase(caseName, CASES_DIR);
    if (!casePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    // Create case folder and CLAUDE.md if it doesn't exist
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
        return text.length > MAX_PROMPT_LEN ? text.slice(0, MAX_PROMPT_LEN) + '…' : text;
      } catch {
        // Malformed line — skip
      }
    }
    return undefined;
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

        // Decode project key to working dir. The encoding replaces '/' with '-',
        // which is lossy when path components contain '-'. Do naive decode first,
        // then verify it exists. Fall back to HOME if the decoded path is invalid.
        const naiveDecode = projDir.replace(/^-/, '/').replace(/-/g, '/');
        const dirExists = await fs
          .access(naiveDecode)
          .then(() => true)
          .catch(() => false);
        const workingDir = dirExists ? naiveDecode : process.env.HOME || '/tmp';

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

          if (fileStat.size < 50000) {
            if (
              !head ||
              (!head.includes('"type":"user"') &&
                !head.includes('"type":"assistant"') &&
                !head.includes('"type":"summary"'))
            ) {
              continue; // No conversation content — skip
            }
          }
          if (head) firstPrompt = extractFirstUserPrompt(head);

          // If head scan found no usable prompt (e.g. session started with /init),
          // try reading the tail for a recent user message.
          if (!firstPrompt && fileStat.size > 65536) {
            const tailBuf = Buffer.alloc(32768);
            const tail = await readFileTail(filePath, tailBuf, fileStat.size);
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
}
