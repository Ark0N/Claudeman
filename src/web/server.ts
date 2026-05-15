/**
 * @fileoverview Codeman web server — central hub coordinating all subsystems.
 *
 * Fastify-based web server providing:
 * - ~111 REST API routes (delegated to `src/web/routes/` domain modules)
 * - SSE streaming at `/api/events` with backpressure handling
 * - Static file serving for the web UI (1-year cache in production)
 * - 60fps terminal streaming via batched PTY output (16-50ms adaptive)
 *
 * Coordinates: SessionManager, RespawnController, SubagentWatcher, TeamWatcher,
 * TranscriptWatcher, ImageWatcher, TunnelManager, PushSubscriptionStore,
 * PlanOrchestrator, RunSummaryTracker, FileStreamManager.
 *
 * Key exports:
 * - `WebServer` class — implements all port interfaces, extends EventEmitter
 * - `startWebServer(options)` — factory function to create and start the server
 *
 * Implements port interfaces: `SessionPort`, `EventPort`, `ConfigPort`,
 * `RespawnPort`, `MuxPort`, `FilePort`, `ScheduledPort`, `PushPort`, `TeamPort`
 * (see `src/web/ports/` for definitions)
 *
 * @dependencies All major subsystems (session, respawn-controller, subagent-watcher,
 *   team-watcher, tunnel-manager, state-store, etc.)
 * @consumedby src/index.ts (entry point), src/cli.ts
 * @emits SSE events via broadcast() — see sse-events.ts for full registry
 *
 * @module web/server
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir, hostname as getHostname } from 'node:os';
import { EventEmitter } from 'node:events';
import { Session, type BackgroundTask } from '../session.js';
import type { ClaudeMode, SessionState } from '../types.js';
import { RespawnController, RespawnConfig } from '../respawn-controller.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import { createMultiplexer } from '../mux-factory.js';
import { getStore } from '../state-store.js';
import { extractCompletionPhrase } from '../ralph-config.js';
import { fileStreamManager } from '../file-stream-manager.js';
import {
  subagentWatcher,
  type SubagentInfo,
  type SubagentToolCall,
  type SubagentProgress,
  type SubagentMessage,
  type SubagentToolResult,
} from '../subagent-watcher.js';
import { imageWatcher } from '../image-watcher.js';
import { TranscriptWatcher } from '../transcript-watcher.js';
import { TeamWatcher } from '../team-watcher.js';
import { TunnelManager } from '../tunnel-manager.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'node:module';
import { RunSummaryTracker } from '../run-summary.js';
import { PlanOrchestrator } from '../plan-orchestrator.js';
import { OrchestratorLoop } from '../orchestrator-loop.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { PushSubscriptionStore } from '../push-store.js';
import webpush from 'web-push';
import { SseStreamManager } from './sse-stream-manager.js';
import {
  type SessionListenerRefs,
  createSessionListeners,
  attachSessionListeners,
  detachSessionListeners,
} from './session-listener-wiring.js';
import {
  wireRespawnListeners,
  setupTimedRespawn,
  restoreRespawnController,
  saveRespawnConfig,
  type RespawnWiringDeps,
} from './respawn-event-wiring.js';

// Load version from package.json
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');
import {
  getErrorMessage,
  ApiErrorCode,
  createErrorResponse,
  type PersistedRespawnConfig,
  type NiceConfig,
  type ImageDetectedEvent,
  DEFAULT_NICE_CONFIG,
} from '../types.js';
import { CleanupManager, KeyedDebouncer, StaleExpirationMap } from '../utils/index.js';
import { MAX_CONCURRENT_SESSIONS, MAX_SSE_CLIENTS } from '../config/map-limits.js';
import { SseEvent } from './sse-events.js';
import type { ScheduledRun } from './ports/index.js';
import { registerAuthMiddleware, registerSecurityHeaders } from './middleware/auth.js';
import {
  registerPushRoutes,
  registerTeamRoutes,
  registerMuxRoutes,
  registerFileRoutes,
  registerScheduledRoutes,
  registerHookEventRoutes,
  registerSystemRoutes,
  registerCaseRoutes,
  registerSessionRoutes,
  registerRespawnRoutes,
  registerRalphRoutes,
  registerPlanRoutes,
  registerClipboardRoutes,
  registerOrchestratorRoutes,
  registerWsRoutes,
} from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

import {
  SESSIONS_LIST_CACHE_TTL,
  SCHEDULED_CLEANUP_INTERVAL,
  SCHEDULED_RUN_MAX_AGE,
  SSE_HEARTBEAT_INTERVAL,
  SESSION_LIMIT_WAIT_MS,
  ITERATION_PAUSE_MS,
  STATS_COLLECTION_INTERVAL_MS,
  INACTIVITY_TIMEOUT_MS,
} from '../config/server-timing.js';

/**
 * Get or generate a self-signed TLS certificate for HTTPS.
 * Certs are stored in ~/.codeman/certs/ and reused across restarts.
 */
function getOrCreateSelfSignedCert(): { key: string; cert: string } {
  const certsDir = join(homedir(), '.codeman', 'certs');
  const keyPath = join(certsDir, 'server.key');
  const certPath = join(certsDir, 'server.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf-8'),
      cert: readFileSync(certPath, 'utf-8'),
    };
  }

  mkdirSync(certsDir, { recursive: true, mode: 0o700 });

  // Generate self-signed cert valid for 365 days, covering localhost and common LAN access patterns
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes ` +
      `-keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -subj "/CN=codeman" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"`,
    { stdio: 'pipe' }
  );

  // Restrict private key to owner-only (prevent other local users from reading it)
  chmodSync(keyPath, 0o600);

  return {
    key: readFileSync(keyPath, 'utf-8'),
    cert: readFileSync(certPath, 'utf-8'),
  };
}

export class WebServer extends EventEmitter {
  private app: FastifyInstance;
  private sessions: Map<string, Session> = new Map();
  private respawnControllers: Map<string, RespawnController> = new Map();
  private respawnTimers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }> = new Map();
  private runSummaryTrackers: Map<string, RunSummaryTracker> = new Map();
  private transcriptWatchers: Map<string, TranscriptWatcher> = new Map();
  // Store session listener references for explicit cleanup (prevents memory leaks)
  private sessionListenerRefs: Map<string, SessionListenerRefs> = new Map();
  private scheduledRuns: Map<string, ScheduledRun> = new Map();
  private sse: SseStreamManager;
  private store = getStore();
  private port: number;
  private https: boolean;
  private testMode: boolean;
  private mux: TerminalMultiplexer;
  // Centralized cleanup for standalone timers (intervals + resettable timeouts)
  private cleanup = new CleanupManager();
  // Cached light state for SSE init (avoids rebuilding on every reconnect)
  private cachedLightState: { data: Record<string, unknown>; timestamp: number } | null = null;
  private static readonly LIGHT_STATE_CACHE_TTL_MS = 1000;
  // Cached sessions list for getLightSessionsState() (avoids re-serializing all sessions on every call)
  private cachedSessionsList: { data: unknown[]; timestamp: number } | null = null;
  // Token recording for daily stats (track what's been recorded to avoid double-counting)
  private lastRecordedTokens: Map<string, { input: number; output: number }> = new Map();
  // Server startup time for respawn grace period calculation
  private readonly serverStartTime: number = Date.now();
  // Pending respawn start timers (for cleanup on shutdown)
  private pendingRespawnStarts: Map<string, NodeJS.Timeout> = new Map();
  // Active plan orchestrators (for cancellation via API)
  private activePlanOrchestrators: Map<string, PlanOrchestrator> = new Map();
  private persistDeb = new KeyedDebouncer(100);
  // Stored listener handlers for cleanup
  private subagentWatcherHandlers: {
    discovered: (info: SubagentInfo) => void;
    updated: (info: SubagentInfo) => void;
    toolCall: (data: SubagentToolCall) => void;
    toolResult: (data: SubagentToolResult) => void;
    progress: (data: SubagentProgress) => void;
    message: (data: SubagentMessage) => void;
    completed: (info: SubagentInfo) => void;
    error: (error: Error, agentId?: string) => void;
  } | null = null;
  private imageWatcherHandlers: {
    detected: (event: ImageDetectedEvent) => void;
    error: (error: Error, sessionId?: string) => void;
  } | null = null;
  private tunnelManager: TunnelManager = new TunnelManager();
  private authSessions: StaleExpirationMap<string, import('./ports/auth-port.js').AuthSessionRecord> | null = null;
  private authFailures: StaleExpirationMap<string, number> | null = null;
  private qrAuthFailures: StaleExpirationMap<string, number> | null = null;
  private pushStore: PushSubscriptionStore = new PushSubscriptionStore();
  private teamWatcher: TeamWatcher = new TeamWatcher();
  private _orchestratorLoop: import('../orchestrator-loop.js').OrchestratorLoop | null = null;
  private teamWatcherHandlers: {
    teamCreated: (config: unknown) => void;
    teamUpdated: (config: unknown) => void;
    teamRemoved: (config: unknown) => void;
    taskUpdated: (data: unknown) => void;
  } | null = null;
  private readonly titleHostname: string;
  private readonly windowTitle: string;
  private readonly indexHtmlTemplate: string;
  constructor(port: number = 3000, https: boolean = false, testMode: boolean = false, titleHostname?: string) {
    super();
    this.setMaxListeners(0);
    this.port = port;
    this.https = https;
    this.testMode = testMode;
    this.titleHostname = titleHostname || getHostname();
    this.windowTitle = `codeman:${this.titleHostname}`;
    this.indexHtmlTemplate = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');

    if (https) {
      const { key, cert } = getOrCreateSelfSignedCert();
      this.app = Fastify({ logger: false, https: { key, cert } });
    } else {
      this.app = Fastify({ logger: false });
    }
    this.mux = createMultiplexer();
    this.sse = new SseStreamManager(
      {
        getSessionStateWithRespawn: (sessionId) => {
          const session = this.sessions.get(sessionId);
          return session ? this.getSessionStateWithRespawn(session) : null;
        },
      },
      this.cleanup
    );

    // Set up mux event listeners
    this.mux.on('sessionCreated', (session) => {
      this.broadcast(SseEvent.MuxCreated, session);
    });
    this.mux.on('sessionKilled', (data) => {
      this.broadcast(SseEvent.MuxKilled, data);
    });
    this.mux.on('sessionDied', (data) => {
      getLifecycleLog().log({
        event: 'mux_died',
        sessionId: (data as { sessionId?: string }).sessionId || 'unknown',
        extra: data as Record<string, unknown>,
      });
      this.broadcast(SseEvent.MuxDied, data);
    });
    this.mux.on('statsUpdated', (sessions) => {
      this.broadcast(SseEvent.MuxStatsUpdated, sessions);
    });

    // Set up subagent watcher listeners
    this.setupSubagentWatcherListeners();

    // Set up image watcher listeners
    this.setupImageWatcherListeners();

    // Set up team watcher listeners
    this.setupTeamWatcherListeners();

    // Set up tunnel manager listeners
    this.tunnelManager.on('started', (data: { url: string }) => {
      this.sse.setTunnelActive(true);
      this.broadcast(SseEvent.TunnelStarted, data);
    });
    this.tunnelManager.on('stopped', () => {
      this.sse.setTunnelActive(false);
      this.broadcast(SseEvent.TunnelStopped, {});
    });
    this.tunnelManager.on('error', (message: string) => {
      this.broadcast(SseEvent.TunnelError, { message });
    });
    this.tunnelManager.on('progress', (data: { message: string }) => {
      this.broadcast(SseEvent.TunnelProgress, data);
    });

    // QR token rotation — broadcast inline SVG for instant desktop refresh
    this.tunnelManager.on('qrTokenRotated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast(SseEvent.TunnelQrRotated, { svg });
        } catch {
          // QR generation failed — skip this rotation
        }
      }
    });

    this.tunnelManager.on('qrTokenRegenerated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast(SseEvent.TunnelQrRegenerated, { svg });
        } catch {
          // QR generation failed — skip
        }
      }
    });
  }

  /**
   * Set up event listeners for subagent watcher.
   * Broadcasts real-time subagent activity to SSE clients.
   *
   * The SubagentWatcher now extracts descriptions directly from the parent session's
   * transcript, which contains the exact Task tool call with the description parameter.
   * This is more reliable than the previous timing-based correlation approach.
   */
  private setupSubagentWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.subagentWatcherHandlers = {
      discovered: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentDiscovered, info),
      updated: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentUpdated, info),
      toolCall: (data: SubagentToolCall) => this.broadcast(SseEvent.SubagentToolCall, data),
      toolResult: (data: SubagentToolResult) => this.broadcast(SseEvent.SubagentToolResult, data),
      progress: (data: SubagentProgress) => this.broadcast(SseEvent.SubagentProgress, data),
      message: (data: SubagentMessage) => this.broadcast(SseEvent.SubagentMessage, data),
      completed: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentCompleted, info),
      error: (error: Error, agentId?: string) => {
        console.error(`[SubagentWatcher] Error${agentId ? ` for ${agentId}` : ''}:`, error.message);
      },
    };

    subagentWatcher.on('subagent:discovered', this.subagentWatcherHandlers.discovered);
    subagentWatcher.on('subagent:updated', this.subagentWatcherHandlers.updated);
    subagentWatcher.on('subagent:tool_call', this.subagentWatcherHandlers.toolCall);
    subagentWatcher.on('subagent:tool_result', this.subagentWatcherHandlers.toolResult);
    subagentWatcher.on('subagent:progress', this.subagentWatcherHandlers.progress);
    subagentWatcher.on('subagent:message', this.subagentWatcherHandlers.message);
    subagentWatcher.on('subagent:completed', this.subagentWatcherHandlers.completed);
    subagentWatcher.on('subagent:error', this.subagentWatcherHandlers.error);
  }

  /**
   * Clean up subagent watcher listeners to prevent memory leaks.
   */
  private cleanupSubagentWatcherListeners(): void {
    if (this.subagentWatcherHandlers) {
      subagentWatcher.off('subagent:discovered', this.subagentWatcherHandlers.discovered);
      subagentWatcher.off('subagent:updated', this.subagentWatcherHandlers.updated);
      subagentWatcher.off('subagent:tool_call', this.subagentWatcherHandlers.toolCall);
      subagentWatcher.off('subagent:tool_result', this.subagentWatcherHandlers.toolResult);
      subagentWatcher.off('subagent:progress', this.subagentWatcherHandlers.progress);
      subagentWatcher.off('subagent:message', this.subagentWatcherHandlers.message);
      subagentWatcher.off('subagent:completed', this.subagentWatcherHandlers.completed);
      subagentWatcher.off('subagent:error', this.subagentWatcherHandlers.error);
      this.subagentWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for image watcher.
   * Broadcasts image detection events to SSE clients for auto-popup.
   */
  private setupImageWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.imageWatcherHandlers = {
      detected: (event: ImageDetectedEvent) => this.broadcast(SseEvent.ImageDetected, event),
      error: (error: Error, sessionId?: string) => {
        console.error(`[ImageWatcher] Error${sessionId ? ` for ${sessionId}` : ''}:`, error.message);
      },
    };

    imageWatcher.on('image:detected', this.imageWatcherHandlers.detected);
    imageWatcher.on('image:error', this.imageWatcherHandlers.error);
  }

  /**
   * Clean up image watcher listeners to prevent memory leaks.
   */
  private cleanupImageWatcherListeners(): void {
    if (this.imageWatcherHandlers) {
      imageWatcher.off('image:detected', this.imageWatcherHandlers.detected);
      imageWatcher.off('image:error', this.imageWatcherHandlers.error);
      this.imageWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for team watcher.
   * Broadcasts team activity events to SSE clients.
   */
  private setupTeamWatcherListeners(): void {
    this.teamWatcherHandlers = {
      teamCreated: (config: unknown) => this.broadcast(SseEvent.TeamCreated, config),
      teamUpdated: (config: unknown) => this.broadcast(SseEvent.TeamUpdated, config),
      teamRemoved: (config: unknown) => this.broadcast(SseEvent.TeamRemoved, config),
      taskUpdated: (data: unknown) => this.broadcast(SseEvent.TeamTaskUpdated, data),
    };

    this.teamWatcher.on('teamCreated', this.teamWatcherHandlers.teamCreated);
    this.teamWatcher.on('teamUpdated', this.teamWatcherHandlers.teamUpdated);
    this.teamWatcher.on('teamRemoved', this.teamWatcherHandlers.teamRemoved);
    this.teamWatcher.on('taskUpdated', this.teamWatcherHandlers.taskUpdated);
  }

  /**
   * Clean up team watcher listeners to prevent memory leaks.
   */
  private cleanupTeamWatcherListeners(): void {
    if (this.teamWatcherHandlers) {
      this.teamWatcher.off('teamCreated', this.teamWatcherHandlers.teamCreated);
      this.teamWatcher.off('teamUpdated', this.teamWatcherHandlers.teamUpdated);
      this.teamWatcher.off('teamRemoved', this.teamWatcherHandlers.teamRemoved);
      this.teamWatcher.off('taskUpdated', this.teamWatcherHandlers.taskUpdated);
      this.teamWatcherHandlers = null;
    }
  }

  /**
   * Build a route context object satisfying all 5 port interfaces.
   * Single object with zero runtime cost — ISP enforced at the type level.
   */
  private createRouteContext() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      // SessionPort
      sessions: this.sessions as ReadonlyMap<string, Session>,
      addSession: (session: Session) => {
        this.sessions.set(session.id, session);
      },
      cleanupSession: this.cleanupSession.bind(this),
      setupSessionListeners: this.setupSessionListeners.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      persistSessionStateNow: this._persistSessionStateNow.bind(this),
      getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
      // EventPort
      broadcast: this.broadcast.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      batchTerminalData: this.batchTerminalData.bind(this),
      broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
      batchTaskUpdate: this.batchTaskUpdate.bind(this),
      getSseClientCount: () => this.sse.remoteClientCount,
      // RespawnPort
      respawnControllers: this.respawnControllers,
      respawnTimers: this.respawnTimers,
      setupRespawnListeners: this.setupRespawnListeners.bind(this),
      setupTimedRespawn: this.setupTimedRespawn.bind(this),
      restoreRespawnController: this.restoreRespawnController.bind(this),
      saveRespawnConfig: this.saveRespawnConfig.bind(this),
      // ConfigPort
      store: this.store,
      port: this.port,
      https: this.https,
      testMode: this.testMode,
      serverStartTime: this.serverStartTime,
      getGlobalNiceConfig: this.getGlobalNiceConfig.bind(this),
      getModelConfig: this.getModelConfig.bind(this),
      getClaudeModeConfig: this.getClaudeModeConfig.bind(this),
      getDefaultClaudeMdPath: this.getDefaultClaudeMdPath.bind(this),
      getLightState: this.getLightState.bind(this),
      getLightSessionsState: this.getLightSessionsState.bind(this),
      startTranscriptWatcher: this.startTranscriptWatcher.bind(this),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      // InfraPort
      mux: this.mux,
      runSummaryTrackers: this.runSummaryTrackers,
      activePlanOrchestrators: this.activePlanOrchestrators,
      scheduledRuns: this.scheduledRuns,
      teamWatcher: this.teamWatcher,
      tunnelManager: this.tunnelManager,
      pushStore: this.pushStore,
      startScheduledRun: this.startScheduledRun.bind(this),
      stopScheduledRun: this.stopScheduledRun.bind(this),
      // AuthPort
      authSessions: this.authSessions,
      qrAuthFailures: this.qrAuthFailures,
      // OrchestratorPort — use getter so routes always see current value (not a null snapshot)
      get orchestratorLoop() {
        return self._orchestratorLoop;
      },
      initOrchestratorLoop: () => this.initOrchestratorLoop(),
    };
  }

  private async setupRoutes(): Promise<void> {
    // Allow multipart/form-data for screenshot uploads — skip Fastify's body parser
    // so the route handler can read the raw stream directly.
    this.app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => {
      done(null);
    });

    // Enable gzip/brotli compression for all responses.
    // Massive win: 793KB uncompressed → ~120KB compressed for static assets.
    // Threshold 1024 = don't compress tiny responses (headers > savings).
    await this.app.register(fastifyCompress, {
      threshold: 1024,
    });

    // Cookie plugin (needed for auth session tokens)
    await this.app.register(fastifyCookie);

    // Auth middleware (Basic Auth + session cookies + rate limiting)
    const authState = registerAuthMiddleware(this.app, this.https);
    if (authState) {
      this.authSessions = authState.authSessions;
      this.authFailures = authState.authFailures;
      this.qrAuthFailures = authState.qrAuthFailures;
    }

    // WebSocket support (terminal I/O — low-latency bidirectional channel)
    await this.app.register(fastifyWebsocket);

    // Security headers + CORS
    registerSecurityHeaders(this.app, this.https);
    this.app.get('/', async (_req, reply) => {
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(this.renderIndexHtml());
    });
    this.app.get('/index.html', async (_req, reply) => {
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(this.renderIndexHtml());
    });
    // Service worker must never be cached — browsers check for SW updates on navigation
    this.app.get('/sw.js', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache, no-store')
        .header('Service-Worker-Allowed', '/')
        .type('application/javascript')
        .sendFile('sw.js', join(__dirname, 'public'));
    });

    // Serve static files — content-hashed assets (e.g. app.a3f8c2e1.js) are immutable, cache aggressively.
    // HTML must revalidate every time so browsers pick up new hashed filenames after deploys.
    // cacheControl disabled so setHeaders has full control (fastify-static's reply.headers() overwrites setHeaders otherwise).
    // preCompressed: serve pre-built .br/.gz files (from build step) to avoid per-request CPU compression
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
      cacheControl: false,
      preCompressed: true,
      setHeaders: (res, path) => {
        // Use .includes() not .endsWith() — preCompressed serves .html.br/.html.gz
        if (path.includes('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // SSE endpoint for real-time updates
    this.app.get('/api/events', (req, reply) => {
      // Enforce SSE client limit to prevent memory exhaustion from too many connections
      if (this.sse.clientCount >= MAX_SSE_CLIENTS) {
        reply.code(503).send('Too many SSE connections');
        return;
      }

      // Parse optional session subscription filter from query parameter.
      // /api/events?sessions=id1,id2 — client only receives session:terminal
      //   events for those sessions (other events broadcast to all clients).
      // /api/events?clientId=<uuid> — enables live filter updates via
      //   POST /api/events/subscribe without reconnecting.
      const query = req.query as { sessions?: string; clientId?: string };
      let sessionFilter: Set<string> | null = null;
      if (query.sessions) {
        const ids = query.sessions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length > 0) {
          sessionFilter = new Set(ids);
        }
      }
      const clientId = typeof query.clientId === 'string' && query.clientId ? query.clientId : undefined;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      // Track tunnel clients — cloudflared proxies locally so req.ip is always
      // 127.0.0.1; detect tunnel traffic via Cf-Connecting-Ip header instead.
      const isRemote = !!req.headers['cf-connecting-ip'];
      this.sse.addClient(reply, sessionFilter, isRemote, clientId);

      // Send initial state
      // Use light state for SSE init to avoid sending 2MB+ terminal buffers
      // Buffers are fetched on-demand when switching tabs
      this.sse.sendSSE(reply, SseEvent.Init, this.getLightState());
      // Flush Cloudflare tunnel buffer with padding — ensures the init event
      // (and any immediately following events) are delivered without proxy delay.
      this.sse.sendPadding(reply);

      req.raw.on('close', () => {
        this.sse.removeClient(reply);
      });
    });

    // Live subscription update — change a connected client's session filter
    // without forcing an SSE reconnect. Body: { clientId, sessions: string[] | null }
    // Empty/null sessions array = remove filter (receive all session:terminal events).
    this.app.post('/api/events/subscribe', (req, reply) => {
      const body = (req.body || {}) as { clientId?: string; sessions?: string[] | null };
      if (!body.clientId || typeof body.clientId !== 'string') {
        reply.code(400).send({ error: 'clientId required' });
        return;
      }
      const sessions = Array.isArray(body.sessions) ? body.sessions.filter((s) => typeof s === 'string') : null;
      const updated = this.sse.updateClientFilter(body.clientId, sessions);
      reply.code(updated ? 204 : 404).send();
    });

    // Global error handler for structured errors thrown by findSessionOrFail
    this.app.setErrorHandler((error, _req, reply) => {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const body = (error as { body?: unknown }).body;
      if (body) {
        reply.code(statusCode).send(body);
      } else {
        reply.code(statusCode).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(error)));
      }
    });

    // Crash diagnostics beacon — frontend POSTs breadcrumbs, GET to read them
    let _crashBreadcrumbs = '';
    this.app.addContentTypeParser('text/plain;charset=UTF-8', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, { data: body });
      }
    });
    this.app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, { data: body });
      }
    });
    this.app.post('/api/crash-diag', (req, reply) => {
      _crashBreadcrumbs = String((req.body as { data?: string })?.data || '');
      reply.code(204).send();
    });
    this.app.get('/api/crash-diag', (_req, reply) => {
      reply.code(200).send({ breadcrumbs: _crashBreadcrumbs, timestamp: Date.now() });
    });

    // Register all route modules
    const ctx = this.createRouteContext();
    registerPushRoutes(this.app, ctx);
    registerTeamRoutes(this.app, ctx);
    registerMuxRoutes(this.app, ctx);
    registerFileRoutes(this.app, ctx);
    registerScheduledRoutes(this.app, ctx);
    registerHookEventRoutes(this.app, ctx);
    registerSystemRoutes(this.app, ctx);
    registerCaseRoutes(this.app, ctx);
    registerSessionRoutes(this.app, ctx);
    registerRespawnRoutes(this.app, ctx);
    registerRalphRoutes(this.app, ctx);
    registerPlanRoutes(this.app, ctx);
    registerClipboardRoutes(this.app, ctx);
    registerOrchestratorRoutes(this.app, ctx);
    registerWsRoutes(this.app, ctx);
  }

  /**
   * Start a transcript watcher for a session.
   * Creates a new watcher or updates an existing one with the new transcript path.
   */
  private startTranscriptWatcher(sessionId: string, transcriptPath: string): void {
    let watcher = this.transcriptWatchers.get(sessionId);

    if (!watcher) {
      watcher = new TranscriptWatcher();

      // Wire up transcript events to the respawn controller
      watcher.on('transcript:complete', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptComplete();
        }
        this.broadcast(SseEvent.TranscriptComplete, { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:plan_mode', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptPlanMode();
        }
        this.broadcast(SseEvent.TranscriptPlanMode, { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_start', (toolName: string) => {
        this.broadcast(SseEvent.TranscriptToolStart, { sessionId, toolName, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_end', (toolName: string, isError: boolean) => {
        this.broadcast(SseEvent.TranscriptToolEnd, {
          sessionId,
          toolName,
          isError,
          timestamp: Date.now(),
        });
      });

      watcher.on('transcript:error', (error: Error) => {
        console.error(`[Transcript] Error for session ${sessionId}:`, error.message);
      });

      this.transcriptWatchers.set(sessionId, watcher);
    }

    // Start or update the watcher with the transcript path
    watcher.updatePath(transcriptPath);
  }

  /**
   * Stop the transcript watcher for a session.
   */
  private stopTranscriptWatcher(sessionId: string): void {
    const watcher = this.transcriptWatchers.get(sessionId);
    if (watcher) {
      watcher.removeAllListeners(); // Prevent memory leaks from attached listeners
      watcher.stop();
      this.transcriptWatchers.delete(sessionId);
    }
  }

  /** Debounced wrapper — coalesces rapid persistSessionState calls per session */
  private persistSessionState(session: Session): void {
    this.persistDeb.schedule(session.id, () => {
      // Session may have been removed during debounce
      if (this.sessions.has(session.id)) {
        this._persistSessionStateNow(session);
      }
    });
  }

  /** Persists full session state including respawn config to state.json */
  private _persistSessionStateNow(session: Session): void {
    // See session-manager.updateSessionState: __envOverrides is an internal disk-only
    // field kept off SessionState to avoid leaking via API broadcasts.
    const base = session.toState();
    const envOverrides = session.getEnvOverridesForPersist();
    const state = (envOverrides ? { ...base, __envOverrides: envOverrides } : base) as SessionState;
    const controller = this.respawnControllers.get(session.id);
    if (controller) {
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(session.id);
      const durationMinutes = timerInfo ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000) : undefined;
      state.respawnConfig = { ...config, durationMinutes };
      // Use config.enabled instead of controller.state - this way the respawn
      // will be restored on server restart even if it was temporarily stopped
      // due to errors. Intentional stops via /respawn/stop call clearRespawnConfig().
      state.respawnEnabled = config.enabled;
    } else {
      // Don't overwrite respawnConfig if it exists in state - preserve it for restart
      const existingState = this.store.getSession(session.id);
      if (existingState?.respawnConfig) {
        state.respawnConfig = existingState.respawnConfig;
        state.respawnEnabled = existingState.respawnConfig.enabled ?? false;
      } else {
        state.respawnEnabled = false;
      }
    }
    this.store.setSession(session.id, state);
  }

  private saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void {
    saveRespawnConfig(sessionId, config, this.mux, durationMinutes);
  }

  // Clean up all resources associated with a session
  // Track sessions currently being cleaned up to prevent concurrent cleanup races
  private cleaningUp: Set<string> = new Set();

  private async cleanupSession(sessionId: string, killMux: boolean = true, reason?: string): Promise<void> {
    // Guard against concurrent cleanup of the same session
    if (this.cleaningUp.has(sessionId)) return;
    this.cleaningUp.add(sessionId);

    try {
      await this._doCleanupSession(sessionId, killMux, reason);
    } finally {
      this.cleaningUp.delete(sessionId);
    }
  }

  private async _doCleanupSession(sessionId: string, killMux: boolean, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({
      event: killMux ? 'deleted' : 'detached',
      sessionId,
      name: session?.name,
      mode: session?.mode,
      reason: reason || 'unknown',
    });

    // Stop watching @fix_plan.md for this session
    if (session) {
      session.ralphTracker.stopWatchingFixPlan();
    }

    // Kill all subagents spawned by this session (scoped to sessionId to avoid cross-session kills)
    if (session && killMux) {
      try {
        await subagentWatcher.killSubagentsForSession(session.workingDir, sessionId);
      } catch (err) {
        console.error(`[Server] Failed to kill subagents for session ${sessionId}:`, err);
      }
    }

    // Stop and remove respawn controller - but save config first for restart recovery
    const controller = this.respawnControllers.get(sessionId);
    if (controller) {
      // Save the config BEFORE removing controller, so it can be restored on restart
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(sessionId);
      const durationMinutes = timerInfo ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000) : undefined;
      this.saveRespawnConfig(sessionId, config, durationMinutes);

      controller.stop();
      controller.removeAllListeners();
      this.respawnControllers.delete(sessionId);
      // Notify UI that respawn is stopped for this session
      this.broadcast(SseEvent.RespawnStopped, { sessionId, reason: 'session_cleanup' });
    }

    // Clear respawn timer
    const timerInfo = this.respawnTimers.get(sessionId);
    if (timerInfo) {
      clearTimeout(timerInfo.timer);
      this.respawnTimers.delete(sessionId);
    }

    // Clear pending respawn start timer (from restoration grace period)
    const pendingStart = this.pendingRespawnStarts.get(sessionId);
    if (pendingStart) {
      clearTimeout(pendingStart);
      this.pendingRespawnStarts.delete(sessionId);
    }

    // Stop transcript watcher
    this.stopTranscriptWatcher(sessionId);

    // Stop and remove run summary tracker
    const summaryTracker = this.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordSessionStopped();
      summaryTracker.stop();
      this.runSummaryTrackers.delete(sessionId);
    }

    // Clear pending persist-debounce timer (prevents stale closure holding session ref)
    this.persistDeb.cancelKey(sessionId);

    // Clear batches, per-session timers, and pending state updates
    this.sse.cleanupSessionBatches(sessionId);

    // Reset Ralph tracker on the session before cleanup
    if (session) {
      session.ralphTracker.fullReset();
    }

    // Clear Ralph state from store
    this.store.removeRalphState(sessionId);

    // Broadcast Ralph cleared to update UI
    this.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId,
      state: {
        enabled: false,
        active: false,
        completionPhrase: null,
        startedAt: null,
        cycleCount: 0,
        maxIterations: null,
        lastActivity: Date.now(),
        elapsedHours: null,
      },
    });
    this.broadcast(SseEvent.SessionRalphTodoUpdate, {
      sessionId,
      todos: [],
      stats: { total: 0, pending: 0, inProgress: 0, completed: 0 },
    });

    // Stop session and remove listeners
    if (session) {
      // Accumulate tokens to global stats before removing session
      // This preserves lifetime usage even after sessions are deleted
      if (killMux && (session.inputTokens > 0 || session.outputTokens > 0 || session.totalCost > 0)) {
        this.store.addToGlobalStats(session.inputTokens, session.outputTokens, session.totalCost);
        // Record to daily stats (for what hasn't been recorded yet via periodic recording)
        const lastRecorded = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
        const deltaInput = session.inputTokens - lastRecorded.input;
        const deltaOutput = session.outputTokens - lastRecorded.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        }
        this.lastRecordedTokens.delete(sessionId);
        console.log(
          `[Server] Added to global stats: ${session.inputTokens + session.outputTokens} tokens, $${session.totalCost.toFixed(4)} from session ${sessionId}`
        );
      }

      // Explicitly remove stored listeners to break closure references (prevents memory leak)
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        detachSessionListeners(session, listeners);
        this.sessionListenerRefs.delete(sessionId);
      }

      session.removeAllListeners();
      // Close any active file streams for this session
      fileStreamManager.closeSessionStreams(sessionId);
      // Stop watching for images in this session's directory
      imageWatcher.unwatchSession(sessionId);
      await session.stop(killMux);
      this.sessions.delete(sessionId);
      // Only remove from state.json if we're also killing the mux session.
      // When killMux=false (server shutdown), preserve state for recovery.
      if (killMux) {
        this.store.removeSession(sessionId);
      }
    }

    this.broadcast(SseEvent.SessionDeleted, { id: sessionId });
  }

  private renderIndexHtml(): string {
    return this.indexHtmlTemplate.replace(
      '<title>Codeman</title>',
      `<title>${escapeHtmlText(this.windowTitle)}</title>`
    );
  }

  private async setupSessionListeners(session: Session): Promise<void> {
    // Create run summary tracker for this session
    const summaryTracker = new RunSummaryTracker(session.id, session.name);
    this.runSummaryTrackers.set(session.id, summaryTracker);
    summaryTracker.recordSessionStarted(session.mode, session.workingDir);

    // Set working directory for Ralph tracker to auto-load @fix_plan.md (not supported for opencode sessions)
    if (session.mode !== 'opencode') {
      session.ralphTracker.setWorkingDir(session.workingDir);
    }

    // Start watching for new images in this session's working directory (if enabled globally and per-session)
    if ((await this.isImageWatcherEnabled()) && session.imageWatcherEnabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    }

    // Create and attach all listener handlers via dependency injection
    const listeners = createSessionListeners(session, this.buildSessionListenerDeps());
    this.sessionListenerRefs.set(session.id, listeners);
    attachSessionListeners(session, listeners);
  }

  /** Build the deps object for session listener wiring. */
  private buildSessionListenerDeps() {
    return {
      broadcast: this.broadcast.bind(this),
      batchTerminalData: this.batchTerminalData.bind(this),
      batchTaskUpdate: this.batchTaskUpdate.bind(this),
      broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
      getRunSummaryTracker: (id: string) => this.runSummaryTrackers.get(id),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      cleanupSessionBatches: (id: string) => this.sse.cleanupSessionBatches(id),
      cancelPersistDebounce: (id: string) => this.persistDeb.cancelKey(id),
      removeRunSummaryTracker: (id: string) => {
        const tracker = this.runSummaryTrackers.get(id);
        if (tracker) {
          tracker.recordSessionStopped();
          tracker.stop();
          this.runSummaryTrackers.delete(id);
        }
      },
      removeSessionListenerRefs: (id: string) => {
        const refs = this.sessionListenerRefs.get(id);
        const sess = this.sessions.get(id);
        if (refs && sess) {
          detachSessionListeners(sess, refs);
        }
        this.sessionListenerRefs.delete(id);
      },
      cleanupRespawnOnExit: (id: string) => {
        const controller = this.respawnControllers.get(id);
        if (controller) {
          controller.stop();
          controller.removeAllListeners();
          this.respawnControllers.delete(id);
        }
        const timerInfo = this.respawnTimers.get(id);
        if (timerInfo) {
          clearTimeout(timerInfo.timer);
          this.respawnTimers.delete(id);
        }
      },
      getStore: () => this.store,
    };
  }

  private setupRespawnListeners(sessionId: string, controller: RespawnController): void {
    wireRespawnListeners(sessionId, controller, this.buildRespawnWiringDeps());
  }

  private setupTimedRespawn(sessionId: string, durationMinutes: number): void {
    setupTimedRespawn(sessionId, durationMinutes, this.buildRespawnWiringDeps());
  }

  private restoreRespawnController(session: Session, config: PersistedRespawnConfig, source: string): void {
    restoreRespawnController(session, config, source, this.buildRespawnWiringDeps());
  }

  private buildRespawnWiringDeps(): RespawnWiringDeps {
    return {
      broadcast: this.broadcast.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      getSession: (id) => this.sessions.get(id),
      sessionExists: (id) => this.sessions.has(id),
      getRunSummaryTracker: (id) => this.runSummaryTrackers.get(id),
      getRespawnControllers: () => this.respawnControllers,
      getRespawnTimers: () => this.respawnTimers,
      getPendingRespawnStarts: () => this.pendingRespawnStarts,
      teamWatcher: this.teamWatcher,
      serverStartTime: this.serverStartTime,
      respawnRestoreGracePeriodMs: 2 * 60 * 1000,
      mux: this.mux,
    };
  }

  // Helper to get custom CLAUDE.md template path from settings
  private async getDefaultClaudeMdPath(): Promise<string | undefined> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');

    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.defaultClaudeMdPath) {
        return settings.defaultClaudeMdPath;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read settings:', err);
      }
    }
    return undefined;
  }

  // Read ~/.codeman/settings.json once and return the parsed object.
  // Cached for 2s to avoid redundant reads during session creation bursts.
  private _settingsCache: { data: Record<string, unknown>; ts: number } | null = null;
  private async readSettings(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this._settingsCache && now - this._settingsCache.ts < 2000) {
      return this._settingsCache.data;
    }
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      this._settingsCache = { data, ts: now };
      return data;
    } catch {
      return {};
    }
  }

  // Helper to get global Nice priority config from settings
  private async getGlobalNiceConfig(): Promise<NiceConfig | undefined> {
    const settings = await this.readSettings();
    const nice = settings.nice as { enabled?: boolean; niceValue?: number } | undefined;
    if (nice && nice.enabled) {
      return {
        enabled: nice.enabled ?? false,
        niceValue: nice.niceValue ?? DEFAULT_NICE_CONFIG.niceValue,
      };
    }
    return undefined;
  }

  // Helper to get Claude CLI startup mode from settings
  private async getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }> {
    const settings = await this.readSettings();
    const claudeMode = settings.claudeMode as string | undefined;
    const allowedTools = settings.allowedTools as string | undefined;
    // Only return valid modes
    if (claudeMode === 'dangerously-skip-permissions' || claudeMode === 'normal' || claudeMode === 'allowedTools') {
      return { claudeMode, allowedTools };
    }
    return {};
  }

  // Helper to get model configuration from settings
  private async getModelConfig(): Promise<{
    defaultModel?: string;
    agentTypeOverrides?: Record<string, string>;
  } | null> {
    const settings = await this.readSettings();
    return (
      (settings.modelConfig as {
        defaultModel?: string;
        agentTypeOverrides?: Record<string, string>;
      }) || null
    );
  }

  private async startScheduledRun(prompt: string, workingDir: string, durationMinutes: number): Promise<ScheduledRun> {
    const id = uuidv4();
    const now = Date.now();

    const run: ScheduledRun = {
      id,
      prompt,
      workingDir,
      durationMinutes,
      startedAt: now,
      endAt: now + durationMinutes * 60 * 1000,
      status: 'running',
      sessionId: null,
      completedTasks: 0,
      totalCost: 0,
      logs: [`[${new Date().toISOString()}] Scheduled run started`],
    };

    this.scheduledRuns.set(id, run);
    this.broadcast(SseEvent.ScheduledCreated, run);

    // Start the run loop (fire-and-forget with error handling)
    this.runScheduledLoop(id).catch((err) => {
      console.error(`[WebServer] Scheduled run ${id} failed:`, err);
      const failedRun = this.scheduledRuns.get(id);
      if (failedRun && failedRun.status === 'running') {
        failedRun.status = 'stopped';
        failedRun.logs.push(`[${new Date().toISOString()}] Error: ${getErrorMessage(err)}`);
        this.broadcast(SseEvent.ScheduledStopped, { id, reason: 'error' });
      }
    });

    return run;
  }

  private async runScheduledLoop(runId: string): Promise<void> {
    const run = this.scheduledRuns.get(runId);
    if (!run || run.status !== 'running') return;

    const addLog = (msg: string) => {
      run.logs.push(`[${new Date().toISOString()}] ${msg}`);
      this.broadcast(SseEvent.ScheduledLog, { id: runId, log: run.logs[run.logs.length - 1] });
    };

    while (Date.now() < run.endAt && run.status === 'running') {
      // Check session limit before creating new session
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        addLog(`Waiting: maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
        await new Promise((r) => setTimeout(r, SESSION_LIMIT_WAIT_MS));
        continue;
      }

      let session: Session | null = null;
      try {
        // Create a session for this iteration
        session = new Session({ workingDir: run.workingDir });
        this.sessions.set(session.id, session);
        this.store.incrementSessionsCreated();
        this.persistSessionState(session);
        await this.setupSessionListeners(session);
        run.sessionId = session.id;

        addLog(`Starting task iteration with session ${session.id.slice(0, 8)}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Run the prompt
        const timeRemaining = Math.round((run.endAt - Date.now()) / 60000);
        const enhancedPrompt = `${run.prompt}\n\nNote: You have approximately ${timeRemaining} minutes remaining in this scheduled run. Work efficiently.`;

        const result = await session.runPrompt(enhancedPrompt);
        run.completedTasks++;
        run.totalCost += result.cost;

        addLog(`Task completed. Cost: $${result.cost.toFixed(4)}. Total tasks: ${run.completedTasks}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Clean up the session after iteration to prevent memory leaks
        await this.cleanupSession(session.id, true, 'scheduled_run');
        run.sessionId = null;

        // Small pause between iterations
        await new Promise((r) => setTimeout(r, ITERATION_PAUSE_MS));
      } catch (err) {
        addLog(`Error: ${getErrorMessage(err)}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Clean up the session on error too
        if (session) {
          try {
            await this.cleanupSession(session.id, true, 'scheduled_run_error');
          } catch {
            // Ignore cleanup errors
          }
          run.sessionId = null;
        }

        // Continue despite errors
        await new Promise((r) => setTimeout(r, SESSION_LIMIT_WAIT_MS));
      }
    }

    if (run.status === 'running') {
      run.status = 'completed';
      addLog(`Scheduled run completed. Total tasks: ${run.completedTasks}, Total cost: $${run.totalCost.toFixed(4)}`);
    }

    this.broadcast(SseEvent.ScheduledCompleted, run);
  }

  private async stopScheduledRun(id: string): Promise<void> {
    const run = this.scheduledRuns.get(id);
    if (!run) return;

    run.status = 'stopped';
    run.logs.push(`[${new Date().toISOString()}] Run stopped by user`);

    // Use cleanupSession for proper resource cleanup (listeners, respawn, etc.)
    if (run.sessionId && this.sessions.has(run.sessionId)) {
      await this.cleanupSession(run.sessionId, true, 'scheduled_run_stopped');
      run.sessionId = null;
    }

    this.broadcast(SseEvent.ScheduledStopped, run);
  }

  /**
   * Get session state with respawn controller info included.
   * Use this for session:updated broadcasts to preserve respawn state on the frontend.
   */
  private getSessionStateWithRespawn(session: Session) {
    const controller = this.respawnControllers.get(session.id);
    return {
      ...session.toLightDetailedState(),
      respawnEnabled: controller?.getConfig()?.enabled ?? false,
      respawnConfig: controller?.getConfig() ?? null,
      respawn: controller?.getStatus() ?? null,
    };
  }

  /**
   * Get lightweight session state for SSE init - excludes full terminal buffers
   * to prevent browser freezes on SSE reconnect. Full buffers are fetched
   * on-demand when switching tabs via /api/sessions/:id/buffer
   */
  private getLightSessionsState() {
    const now = Date.now();
    if (this.cachedSessionsList && now - this.cachedSessionsList.timestamp < SESSIONS_LIST_CACHE_TTL) {
      return this.cachedSessionsList.data;
    }
    // getSessionStateWithRespawn already uses toLightDetailedState() which
    // excludes terminalBuffer and textOutput — no extra stripping needed
    const data = Array.from(this.sessions.values()).map((s) => this.getSessionStateWithRespawn(s));
    this.cachedSessionsList = { data, timestamp: now };
    return data;
  }

  // Clean up old completed scheduled runs
  private cleanupScheduledRuns(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, run] of this.scheduledRuns) {
      // Only clean up completed, failed, or stopped runs
      if (run.status !== 'running') {
        const age = now - (run.endAt || run.startedAt);
        if (age > SCHEDULED_RUN_MAX_AGE) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.scheduledRuns.delete(id);
      this.broadcast(SseEvent.ScheduledDeleted, { id });
    }

    if (toDelete.length > 0) {
      console.log(`[Server] Cleaned up ${toDelete.length} old scheduled run(s)`);
    }
  }

  /**
   * Cleans up stale sessions from state file that don't have active sessions.
   * Called on startup and can be called via API endpoint.
   * @returns Number of sessions cleaned up
   */
  private cleanupStaleSessions(): number {
    const activeSessionIds = new Set(this.sessions.keys());
    const result = this.store.cleanupStaleSessions(activeSessionIds);
    const lifecycleLog = getLifecycleLog();
    for (const s of result.cleaned) {
      lifecycleLog.log({ event: 'stale_cleaned', sessionId: s.id, name: s.name });
    }
    return result.count;
  }

  /**
   * Get lightweight state for SSE init - excludes full terminal buffers
   * to prevent browser freezes. Terminal buffers are fetched on-demand.
   */
  private getLightState() {
    const now = Date.now();
    if (this.cachedLightState && now - this.cachedLightState.timestamp < WebServer.LIGHT_STATE_CACHE_TTL_MS) {
      return this.cachedLightState.data;
    }

    const respawnStatus: Record<string, ReturnType<RespawnController['getStatus']>> = {};
    for (const [sessionId, controller] of this.respawnControllers) {
      respawnStatus[sessionId] = controller.getStatus();
    }

    const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
    for (const [sessionId, session] of this.sessions) {
      activeSessionTokens[sessionId] = {
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      };
    }

    const result = {
      version: APP_VERSION,
      sessions: this.getLightSessionsState(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
      respawnStatus,
      globalStats: this.store.getAggregateStats(activeSessionTokens),
      subagents: subagentWatcher.getRecentSubagents(15), // 15 min to avoid stale agents
      timestamp: now,
      inputCjkForm: process.env.INPUT_CJK_FORM?.toUpperCase() === 'ON',
    };

    this.cachedLightState = { data: result, timestamp: now };
    return result;
  }

  // ========== SSE Delegates (SseStreamManager) ==========

  private broadcast(event: string, data: unknown): void {
    // Invalidate caches on structural changes (creation/deletion)
    if (event === SseEvent.SessionCreated || event === SseEvent.SessionDeleted) {
      this.cachedLightState = null;
      this.cachedSessionsList = null;
    }
    this.sse.broadcast(event, data);
  }

  private batchTerminalData(sessionId: string, data: string): void {
    this.sse.batchTerminalData(sessionId, data);
  }

  private batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    this.sse.batchTaskUpdate(sessionId, task);
  }

  private broadcastSessionStateDebounced(sessionId: string): void {
    this.sse.broadcastSessionStateDebounced(sessionId);
  }

  // ========== Web Push ==========

  /** Map SSE event names to push notification payloads */
  private static readonly PUSH_EVENT_MAP: Record<
    string,
    { title: string; urgency: string; actions?: Array<{ action: string; title: string }> }
  > = {
    [SseEvent.HookPermissionPrompt]: {
      title: 'Permission Required',
      urgency: 'critical',
      actions: [
        { action: 'approve', title: 'Approve' },
        { action: 'deny', title: 'Deny' },
      ],
    },
    [SseEvent.HookElicitationDialog]: { title: 'Question Asked', urgency: 'critical' },
    [SseEvent.HookIdlePrompt]: { title: 'Waiting for Input', urgency: 'warning' },
    [SseEvent.HookStop]: { title: 'Response Complete', urgency: 'info' },
    [SseEvent.SessionError]: { title: 'Session Error', urgency: 'critical' },
    [SseEvent.RespawnBlocked]: { title: 'Respawn Blocked', urgency: 'critical' },
    [SseEvent.SessionRalphCompletionDetected]: { title: 'Task Complete', urgency: 'warning' },
  };

  /**
   * Send push notifications for a given event to all subscribed devices.
   * Only events in PUSH_EVENT_MAP trigger push. Per-subscription preferences are checked.
   * Expired subscriptions (410/404) are auto-removed.
   */
  private sendPushNotifications(event: string, data: Record<string, unknown>): void {
    const template = WebServer.PUSH_EVENT_MAP[event];
    if (!template) return;

    const subscriptions = this.pushStore.getAll();
    if (subscriptions.length === 0) return;

    const vapidKeys = this.pushStore.getVapidKeys();
    webpush.setVapidDetails('mailto:codeman@localhost', vapidKeys.publicKey, vapidKeys.privateKey);

    const sessionName = (data.sessionName as string) || '';
    const sessionId = (data.sessionId as string) || '';

    // Build body text from event data
    let body = sessionName ? `[${sessionName}]` : '';
    if (event === SseEvent.SessionError && data.error) {
      body += body ? ' ' : '';
      body += String(data.error).slice(0, 200);
    } else if (event === SseEvent.RespawnBlocked && data.reason) {
      body += body ? ' ' : '';
      body += String(data.reason);
    } else if (event === SseEvent.SessionRalphCompletionDetected && data.phrase) {
      body += body ? ' ' : '';
      body += String(data.phrase);
    } else if (event === SseEvent.HookPermissionPrompt && data.tool_name) {
      body += body ? ' ' : '';
      body += `Tool: ${String(data.tool_name)}`;
    }

    const payload = JSON.stringify({
      title: template.title,
      // Hostname-aware prefix so OS-level notifications from multiple Codeman
      // instances (laptop / dev box / NAS) are unambiguous in the system tray.
      // Mirrors the in-page Notification format in notification-manager.js.
      hostTitle: this.windowTitle,
      body,
      tag: `codeman-${event}-${sessionId}`,
      sessionId,
      urgency: template.urgency,
      actions: template.actions,
    });

    for (const sub of subscriptions) {
      // Check per-subscription preferences
      if (sub.pushPreferences[event] === false) continue;

      const pushSub = {
        endpoint: sub.endpoint,
        keys: sub.keys,
      };

      webpush.sendNotification(pushSub, payload).catch((err: { statusCode?: number }) => {
        // Auto-remove expired/invalid subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushStore.removeByEndpoint(sub.endpoint);
        }
      });
    }
  }

  private cleanupDeadSSEClients(): void {
    this.sse.cleanupDeadClients();
  }

  /**
   * Records token usage for long-running sessions periodically.
   * Called every 5 minutes to capture usage in daily stats without waiting for session deletion.
   */
  private recordPeriodicTokenUsage(): void {
    for (const [sessionId, session] of this.sessions) {
      const last = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
      const deltaInput = session.inputTokens - last.input;
      const deltaOutput = session.outputTokens - last.output;

      if (deltaInput > 0 || deltaOutput > 0) {
        this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        this.lastRecordedTokens.set(sessionId, {
          input: session.inputTokens,
          output: session.outputTokens,
        });
      }
    }
  }

  async start(): Promise<void> {
    await this.setupRoutes();

    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({ event: 'server_started', sessionId: '*' });
    await lifecycleLog.trimIfNeeded();

    // Restore mux sessions BEFORE accepting connections
    // This prevents race conditions where clients connect before state is ready
    // CRITICAL: Skip in test mode to prevent tests from picking up user sessions
    if (!this.testMode) {
      await this.restoreMuxSessions();
    }

    // Clean up stale sessions from state file that don't have active mux sessions
    this.cleanupStaleSessions();

    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    const protocol = this.https ? 'https' : 'http';
    console.log(`Codeman web interface running at ${protocol}://localhost:${this.port}`);

    // Security warning: server binds to 0.0.0.0 (all interfaces) — warn if no auth configured
    if (!process.env.CODEMAN_PASSWORD) {
      console.warn('\n⚠  WARNING: No CODEMAN_PASSWORD set — server is accessible without authentication.');
      console.warn('   Anyone on your network can access and control Claude sessions.');
      console.warn('   Set CODEMAN_PASSWORD environment variable to enable auth.\n');
    }

    // Set API URL for child processes (MCP server, spawned sessions)
    process.env.CODEMAN_API_URL = `${protocol}://localhost:${this.port}`;

    // Start scheduled runs cleanup timer
    this.cleanup.setInterval(
      () => {
        this.cleanupScheduledRuns();
      },
      SCHEDULED_CLEANUP_INTERVAL,
      { description: 'scheduled runs cleanup' }
    );

    // Start SSE client health check timer (prevents memory leaks from dead connections)
    this.cleanup.setInterval(
      () => {
        this.cleanupDeadSSEClients();
      },
      SSE_HEARTBEAT_INTERVAL,
      { description: 'SSE heartbeat + dead client cleanup' }
    );

    // Start token recording timer (every 5 minutes for long-running sessions)
    this.cleanup.setInterval(
      () => {
        this.recordPeriodicTokenUsage();
      },
      INACTIVITY_TIMEOUT_MS,
      { description: 'periodic token recording' }
    );

    // Start subagent watcher for Claude Code background agent visibility (if enabled)
    if (await this.isSubagentTrackingEnabled()) {
      subagentWatcher.start();
      console.log('Subagent watcher started - monitoring ~/.claude/projects for background agent activity');
    } else {
      console.log('Subagent watcher disabled by user settings');
    }

    // Start image watcher for auto-popup of screenshots (if enabled)
    if (await this.isImageWatcherEnabled()) {
      imageWatcher.start();
      console.log('Image watcher started - monitoring session directories for new images');
    } else {
      console.log('Image watcher disabled by user settings');
    }

    // Tunnel only starts when user clicks the toggle in the UI — never on boot.
    // Reset persisted tunnelEnabled so the UI toggle reflects actual state.
    if (await this.isTunnelEnabled()) {
      const settingsPath = join(homedir(), '.codeman', 'settings.json');
      try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        settings.tunnelEnabled = false;
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      } catch {
        /* ignore */
      }
      console.log('Cloudflare tunnel setting reset (tunnel only starts on explicit UI toggle)');
    }

    // Start team watcher for agent team awareness (always on — lightweight polling)
    this.teamWatcher.start();
    console.log('Team watcher started - monitoring ~/.claude/teams/ for agent team activity');
  }

  /**
   * Check if subagent tracking is enabled in settings (default: true)
   */
  private async isSubagentTrackingEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to true if not explicitly set
      return settings.subagentTrackingEnabled ?? true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read subagent tracking setting:', err);
      }
    }
    return true; // Default enabled
  }

  /**
   * Check if image watcher is enabled in settings (default: false)
   */
  private async isImageWatcherEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to false if not explicitly set (matches UI default)
      return settings.imageWatcherEnabled ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read image watcher setting:', err);
      }
    }
    return false; // Default disabled (matches UI default)
  }

  /**
   * Check if Cloudflare tunnel is enabled in settings (default: false)
   */
  private async isTunnelEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      return settings.tunnelEnabled ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read tunnel setting:', err);
      }
    }
    return false;
  }

  private async restoreMuxSessions(): Promise<void> {
    try {
      // Reconcile mux sessions to find which ones are still alive (also discovers unknown ones)
      const { alive, dead, discovered } = await this.mux.reconcileSessions();

      if (discovered.length > 0) {
        console.log(`[Server] Discovered ${discovered.length} unknown mux session(s)`);
      }

      if (alive.length > 0 || discovered.length > 0) {
        console.log(`[Server] Found ${alive.length + discovered.length} alive mux session(s) from previous run`);

        // For each alive mux session, create a Session object if it doesn't exist
        const muxSessions = this.mux.getSessions();
        for (const muxSession of muxSessions) {
          if (!this.sessions.has(muxSession.sessionId)) {
            // Restore session settings from state.json (single source of truth)
            const savedState = this.store.getSession(muxSession.sessionId);

            // Determine the correct session name (priority: savedState > muxSession > muxName)
            // This ensures renamed sessions keep their name after server restart
            const sessionName = savedState?.name || muxSession.name || muxSession.muxName;

            // Create a session object for this mux session
            const recoveryClaudeMode = await this.getClaudeModeConfig();
            // Recover envOverrides from the internal __envOverrides field written by
            // session-manager (see updateSessionState). Cast to read the non-public field.
            const savedEnvOverrides = (savedState as { __envOverrides?: Record<string, string> })?.__envOverrides;
            const session = new Session({
              id: muxSession.sessionId, // Preserve the original session ID
              workingDir: muxSession.workingDir,
              mode: muxSession.mode,
              name: sessionName,
              mux: this.mux,
              useMux: true,
              muxSession: muxSession, // Pass the existing session so startInteractive() can attach to it
              claudeMode: recoveryClaudeMode.claudeMode,
              allowedTools: recoveryClaudeMode.allowedTools,
              envOverrides: savedEnvOverrides,
            });

            // Update session name if it was a "Restored:" placeholder or doesn't match saved name
            if (savedState?.name && muxSession.name !== savedState.name) {
              this.mux.updateSessionName(muxSession.sessionId, savedState.name);
            }
            if (savedState) {
              // Auto-compact
              if (savedState.autoCompactEnabled !== undefined || savedState.autoCompactThreshold !== undefined) {
                session.setAutoCompact(
                  savedState.autoCompactEnabled ?? false,
                  savedState.autoCompactThreshold,
                  savedState.autoCompactPrompt
                );
              }
              // Auto-clear
              if (savedState.autoClearEnabled !== undefined || savedState.autoClearThreshold !== undefined) {
                session.setAutoClear(savedState.autoClearEnabled ?? false, savedState.autoClearThreshold);
              }
              // Token tracking
              if (
                savedState.inputTokens !== undefined ||
                savedState.outputTokens !== undefined ||
                savedState.totalCost !== undefined
              ) {
                session.restoreTokens(
                  savedState.inputTokens ?? 0,
                  savedState.outputTokens ?? 0,
                  savedState.totalCost ?? 0
                );
                // Initialize lastRecordedTokens to prevent re-counting restored tokens as new daily usage
                this.lastRecordedTokens.set(session.id, {
                  input: savedState.inputTokens ?? 0,
                  output: savedState.outputTokens ?? 0,
                });
                const totalTokens = (savedState.inputTokens ?? 0) + (savedState.outputTokens ?? 0);
                if (totalTokens > 0) {
                  console.log(
                    `[Server] Restored tokens for session ${session.id}: ${totalTokens} tokens, $${(savedState.totalCost ?? 0).toFixed(4)}`
                  );
                }
              }
              // Ralph / Todo tracker (not supported for opencode sessions)
              if (session.mode !== 'opencode') {
                if (savedState.ralphAutoEnableDisabled) {
                  session.ralphTracker.disableAutoEnable();
                  console.log(`[Server] Restored Ralph auto-enable disabled for session ${session.id}`);
                } else if (savedState.ralphEnabled) {
                  // If Ralph was enabled and not explicitly disabled, allow re-enabling on restart
                  session.ralphTracker.enableAutoEnable();
                }
                if (savedState.ralphEnabled) {
                  session.ralphTracker.enable();
                  if (savedState.ralphCompletionPhrase) {
                    session.ralphTracker.startLoop(savedState.ralphCompletionPhrase);
                  }
                  console.log(
                    `[Server] Restored Ralph tracker for session ${session.id} (phrase: ${savedState.ralphCompletionPhrase || 'none'})`
                  );
                }
              }
              // Nice priority config
              if (savedState.niceEnabled !== undefined) {
                session.setNice({
                  enabled: savedState.niceEnabled,
                  niceValue: savedState.niceValue,
                });
              }
              // Flicker filter (frontend-applied but persisted)
              if (savedState.flickerFilterEnabled !== undefined) {
                session.flickerFilterEnabled = savedState.flickerFilterEnabled;
              }
              // Respawn controller (not supported for opencode sessions)
              if (session.mode !== 'opencode' && savedState.respawnEnabled && savedState.respawnConfig) {
                try {
                  this.restoreRespawnController(session, savedState.respawnConfig, 'state.json');
                } catch (err) {
                  console.error(`[Server] Failed to restore respawn for session ${session.id}:`, err);
                }
              }
            }

            // Fallback: restore respawn from mux-sessions.json if state.json didn't have it (not supported for opencode)
            if (
              session.mode !== 'opencode' &&
              !this.respawnControllers.has(session.id) &&
              muxSession.respawnConfig?.enabled
            ) {
              try {
                this.restoreRespawnController(session, muxSession.respawnConfig, 'mux-sessions.json');
              } catch (err) {
                console.error(
                  `[Server] Failed to restore respawn from mux-sessions.json for session ${session.id}:`,
                  err
                );
              }
            }

            // Fallback: restore Ralph state from state-inner.json if not already set and not explicitly disabled
            // Ralph tracker is not supported for opencode sessions
            if (
              session.mode !== 'opencode' &&
              !session.ralphTracker.enabled &&
              !session.ralphTracker.autoEnableDisabled
            ) {
              const ralphState = this.store.getRalphState(muxSession.sessionId);
              if (ralphState?.loop?.enabled) {
                session.ralphTracker.restoreState(ralphState.loop, ralphState.todos);
                console.log(`[Server] Restored Ralph state from inner store for session ${session.id}`);
              }
            }

            // Fallback: auto-detect completion phrase from CLAUDE.md (not supported for opencode)
            if (
              session.mode !== 'opencode' &&
              session.ralphTracker.enabled &&
              !session.ralphTracker.loopState.completionPhrase
            ) {
              const claudeMdPath = join(session.workingDir, 'CLAUDE.md');
              const completionPhrase = extractCompletionPhrase(claudeMdPath);
              if (completionPhrase) {
                session.ralphTracker.startLoop(completionPhrase);
                console.log(`[Server] Auto-detected completion phrase for session ${session.id}: ${completionPhrase}`);
              }
            }

            this.sessions.set(session.id, session);
            await this.setupSessionListeners(session);

            // Auto-attach PTY to the surviving tmux session immediately.
            // This ensures ALL sessions resume capturing output right away,
            // not just the one the client happens to select first.
            try {
              await session.startInteractive();
              getLifecycleLog().log({
                event: 'recovered',
                sessionId: session.id,
                name: session.name,
              });
              console.log(`[Server] Restored and attached session ${session.id} from mux ${muxSession.muxName}`);
            } catch (attachErr) {
              console.error(`[Server] Failed to attach session ${session.id}, keeping as detached:`, attachErr);
              getLifecycleLog().log({
                event: 'recovered',
                sessionId: session.id,
                name: session.name,
              });
            }

            this.persistSessionState(session);
          }
        }

        // Start stats collection for mux sessions
        this.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      // Start mouse mode sync (tmux only) — toggles mouse on/off based on pane count.
      // Mouse off = native xterm.js selection; mouse on = tmux pane clicking (split layouts).
      // Always start, even with no sessions — new sessions may be created later.
      if ('startMouseModeSync' in this.mux) {
        (this.mux as { startMouseModeSync: (ms?: number) => void }).startMouseModeSync();
      }

      if (dead.length > 0) {
        console.log(`[Server] Cleaned up ${dead.length} dead mux session(s)`);
      }
    } catch (err) {
      console.error('[Server] Failed to restore mux sessions:', err);
    }
  }

  private initOrchestratorLoop(): import('../orchestrator-loop.js').OrchestratorLoop {
    if (this._orchestratorLoop) return this._orchestratorLoop;

    this._orchestratorLoop = new OrchestratorLoop(this.mux, process.cwd());
    return this._orchestratorLoop;
  }

  async stop(): Promise<void> {
    getLifecycleLog().log({ event: 'server_stopped', sessionId: '*' });
    // Set stopping flag to prevent new timer creation during shutdown
    this.sse.setStopping();

    // Dispose all managed timers (intervals + resettable timeouts)
    this.cleanup.dispose();

    // Gracefully close all SSE connections and clear batching state
    this.sse.stop();

    this.lastRecordedTokens.clear();

    // Stop multiplexer and flush pending saves
    this.mux.destroy();

    // Flush any pending persist-debounce timers and persist dirty sessions
    this.persistDeb.flushAll((sessionId) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        this._persistSessionStateNow(session);
      }
    });

    // Clear cached state
    this.cachedLightState = null;
    this.cachedSessionsList = null;

    // Clear all pending respawn start timers (from restoration grace period)
    for (const timer of this.pendingRespawnStarts.values()) {
      clearTimeout(timer);
    }
    this.pendingRespawnStarts.clear();

    // Stop all respawn controllers and remove listeners
    for (const controller of this.respawnControllers.values()) {
      controller.stop();
      controller.removeAllListeners();
    }
    this.respawnControllers.clear();

    // Stop orchestrator loop if running
    if (this._orchestratorLoop) {
      await this._orchestratorLoop.stop();
      this._orchestratorLoop.destroy();
      this._orchestratorLoop = null;
    }

    // Stop all scheduled runs first (they have their own session cleanup)
    await Promise.allSettled(Array.from(this.scheduledRuns.keys()).map((id) => this.stopScheduledRun(id)));

    // On server shutdown, DO NOT call cleanupSession — it tears down session state,
    // removes listeners, kills PTY processes, and broadcasts session:deleted.
    // Instead, just persist current state and let the PTY die naturally when process exits.
    // The tmux sessions survive independently, and restoreMuxSessions() will find them on restart.
    for (const [sessionId, session] of this.sessions) {
      // Persist final state so recovery has up-to-date tokens, ralph state, etc.
      this._persistSessionStateNow(session);
      // Remove listeners to avoid spurious events during teardown
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        detachSessionListeners(session, listeners);
        this.sessionListenerRefs.delete(sessionId);
      }
      session.removeAllListeners();
      // Close file streams and image watchers (these are server-side resources)
      fileStreamManager.closeSessionStreams(sessionId);
      imageWatcher.unwatchSession(sessionId);
    }
    // Don't delete sessions from the map or state.json — recovery needs them

    // Flush state store to prevent data loss from debounced saves
    this.store.flushAll();

    // Clean up watcher listeners to prevent memory leaks
    this.cleanupSubagentWatcherListeners();
    this.cleanupImageWatcherListeners();
    this.cleanupTeamWatcherListeners();

    // Stop subagent watcher
    subagentWatcher.stop();

    // Stop image watcher
    imageWatcher.stop();

    // Stop team watcher
    this.teamWatcher.stop();

    // Stop tunnel
    this.tunnelManager.stop();
    this.tunnelManager.removeAllListeners();

    // Destroy file stream manager (clears cleanup timer and kills remaining tail processes)
    fileStreamManager.destroy();

    // Stop all remaining tracked resources before clearing their Maps
    for (const tracker of this.runSummaryTrackers.values()) {
      tracker.stop();
    }
    for (const watcher of this.transcriptWatchers.values()) {
      watcher.removeAllListeners();
      watcher.stop();
    }
    for (const orchestrator of this.activePlanOrchestrators.values()) {
      orchestrator.cancel();
    }

    // Clear remaining Maps that accumulate session references
    for (const { timer } of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
    this.runSummaryTrackers.clear();
    this.transcriptWatchers.clear();
    this.sessionListenerRefs.clear();
    this.scheduledRuns.clear();
    // Dispose StaleExpirationMaps (stops internal cleanup timers)
    if (this.authSessions) {
      this.authSessions.dispose();
      this.authSessions = null;
    }
    if (this.authFailures) {
      this.authFailures.dispose();
      this.authFailures = null;
    }
    if (this.qrAuthFailures) {
      this.qrAuthFailures.dispose();
      this.qrAuthFailures = null;
    }
    this.activePlanOrchestrators.clear();
    this.cleaningUp.clear();

    // Dispose push store (flush pending saves)
    this.pushStore.dispose();

    await this.app.close();
  }
}

export async function startWebServer(
  port: number = 3000,
  https: boolean = false,
  testMode: boolean = false,
  titleHostname?: string
): Promise<WebServer> {
  const server = new WebServer(port, https, testMode, titleHostname);
  await server.start();
  return server;
}
