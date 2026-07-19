#!/usr/bin/env node

/**
 * capture-readme-gifs.mjs
 *
 * Deterministic README GIFs — no real server, Claude CLI, or tmux. Reuses the
 * mock-injection pipeline from capture-readme-screenshots.mjs (static file
 * server + page.route mocks), drives a scripted timeline in the page, records
 * it with Playwright video, and converts to GIF via ffmpeg palette encoding.
 *
 * Scenes:
 *   1. subagent-demo.gif  — terminal spawns 3 parallel agents; floating agent
 *      windows open one by one and stream tool-call activity live (driven
 *      through the real _onSubagentDiscovered/_onSubagentToolCall handlers).
 *   2. zerolag-demo.gif   — side-by-side typing: instant local echo (zerolag)
 *      vs bursty ~350 ms server echo, rendered with the vendored xterm.
 *
 * Usage:  node scripts/capture-readme-gifs.mjs
 *         SCREENSHOT_OUT_DIR=/path/to/review node scripts/capture-readme-gifs.mjs
 * Output: docs/images/ (or flat into SCREENSHOT_OUT_DIR)
 * Requires: ffmpeg
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PORT,
  SESSION_IDS,
  STANDARD_SESSIONS,
  buildInitPayload,
  startStaticServer,
  setupRoutes,
  injectState,
  outPath,
  RST, GRN, YEL, MAG, CYN, GRY, BOLD,
} from './capture-readme-screenshots.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GIF_COLORS = 192;

// ─── ffmpeg conversion (palette recipe from capture-subagent-gif.mjs) ────────

function webmToGif(videoPath, gifPath, { ss, duration, width, fps }) {
  // One GLOBAL palette (default stats_mode=full) + ordered dither: per-frame
  // palettes (stats_mode=single:new=1) make dirty rectangles visibly mismatch
  // on flat dark UI, and error-diffusion dither shimmers between frames.
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  execSync(
    `ffmpeg -y -loglevel error -ss ${ss.toFixed(2)} -t ${duration} -i "${videoPath}" ` +
      `-vf "${filters},split[s0][s1];[s0]palettegen=max_colors=${GIF_COLORS}:reserve_transparent=0[p];` +
      `[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "${gifPath}"`,
    { stdio: 'inherit' }
  );
}

// ─── Scene 1: subagent demo ──────────────────────────────────────────────────

const SUBAGENT_VIEWPORT = { width: 1440, height: 810 };

// Terminal content visible before the agents spawn
const TERMINAL_PRESPAWN = [
  '',
  `${GRN}●${RST} Working on ${CYN}/home/arkon/codeman-cases/testcase${RST} - I'll use the ${BOLD}Task tool${RST} to spawn parallel agents.`,
  '',
  `${GRN}●${RST} ${BOLD}Read${RST}(/home/arkon/codeman-cases/testcase/CLAUDE.md)`,
  `  ${GRY}░${RST} Read ${BOLD}127${RST} lines ${GRY}│${RST} ${CYN}1.2KB${RST}`,
  '',
  `${GRN}●${RST} ${BOLD}Bash${RST}(find . -name "*.ts" -not -path "*/node_modules/*" | head -20)`,
  `  ${GRY}░${RST} ./src/index.ts`,
  `  ${GRY}░${RST} ./src/session.ts`,
  `  ${GRY}░${RST} ./src/web/server.ts`,
  `  ${GRY}░${RST} ${GRY}... (17 more)${RST}`,
  '',
  `${GRN}●${RST} I'll spawn 3 parallel research agents to analyze different parts of the codebase simultaneously.`,
  '',
].join('\r\n');

function makeAgent(agentId, description, startedOffsetMs) {
  return {
    agentId,
    sessionId: 'claude-sess-w1-0001',
    projectHash: 'abc123',
    filePath: `/tmp/${agentId}.jsonl`,
    startedAt: new Date(Date.now() - startedOffsetMs).toISOString(),
    lastActivityAt: Date.now(),
    status: 'active',
    toolCallCount: 0,
    entryCount: 0,
    fileSize: 4000,
    description,
    model: 'claude-haiku-4-5-20251001',
    modelShort: 'haiku',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    parentSessionId: SESSION_IDS.w1,
  };
}

// Timeline events: t (ms from scene start) + kind
//   term     — write raw data to the session terminal
//   discover — register subagent + open + position its floating window
//   tool     — stream a tool call into an agent window
//   msg      — stream an assistant message into an agent window
//   complete — flip an agent to completed
function buildSubagentTimeline() {
  const T = (lines) => lines.join('\r\n') + '\r\n';
  const tool = (t, agentId, name, input) => ({ t, kind: 'tool', agentId, tool: name, input });
  const msg = (t, agentId, text) => ({ t, kind: 'msg', agentId, text });

  return [
    {
      t: 600,
      kind: 'term',
      data: T([
        `${GRN}●${RST} ${BOLD}Task${RST}(Find and document all API endpoints in src/)`,
        `  ${GRY}░${RST} Spawned ${CYN}agent-001${RST} ${GRY}(haiku)${RST}`,
        '',
      ]),
    },
    {
      t: 1000,
      kind: 'discover',
      agent: makeAgent('agent-001', 'Find and document all API endpoints in src/', 2000),
      x: 440, y: 45,
    },
    tool(1500, 'agent-001', 'Glob', { pattern: 'src/**/*.ts' }),
    {
      t: 2000,
      kind: 'term',
      data: T([
        `${GRN}●${RST} ${BOLD}Task${RST}(Explore and understand test structure in test/)`,
        `  ${GRY}░${RST} Spawned ${CYN}agent-002${RST} ${GRY}(haiku)${RST}`,
        '',
      ]),
    },
    tool(2200, 'agent-001', 'Read', { file_path: '/home/arkon/codeman/src/web/server.ts' }),
    {
      t: 2500,
      kind: 'discover',
      agent: makeAgent('agent-002', 'Explore and understand test structure in test/', 1200),
      x: 880, y: 45,
    },
    tool(3000, 'agent-002', 'Glob', { pattern: 'test/**/*.test.ts' }),
    {
      t: 3300,
      kind: 'term',
      data: T([
        `${GRN}●${RST} ${BOLD}Task${RST}(Analyze TypeScript type definitions in src/types.ts)`,
        `  ${GRY}░${RST} Spawned ${CYN}agent-003${RST} ${GRY}(haiku)${RST}`,
        '',
      ]),
    },
    tool(3500, 'agent-001', 'Grep', { pattern: 'app\\.get|app\\.post|app\\.delete', path: 'src/' }),
    {
      t: 3800,
      kind: 'discover',
      agent: makeAgent('agent-003', 'Analyze TypeScript type definitions in src/types.ts', 400),
      x: 660, y: 400,
    },
    tool(4100, 'agent-002', 'Read', { file_path: '/home/arkon/codeman/test/respawn-test-utils.ts' }),
    {
      t: 4500,
      kind: 'term',
      data: T([
        `${MAG}✻${RST} ${YEL}Waiting for agents...${RST} ${GRY}(${BOLD}esc${RST}${GRY} to interrupt · 32s · ↓ 1.7k tokens · thinking)${RST}`,
        '',
      ]),
    },
    tool(4700, 'agent-003', 'Read', { file_path: '/home/arkon/codeman/src/types.ts' }),
    tool(5200, 'agent-001', 'Read', { file_path: '/home/arkon/codeman/src/web/schemas.ts' }),
    tool(5600, 'agent-002', 'Read', { file_path: '/home/arkon/codeman/config/vitest.config.ts' }),
    tool(6100, 'agent-003', 'Grep', { pattern: 'export (interface|type)', path: 'src/types/' }),
    msg(6700, 'agent-001', 'Found 47 API endpoints across server.ts. Documenting REST paths...'),
    tool(7100, 'agent-002', 'Grep', { pattern: 'const PORT =', path: 'test/' }),
    msg(7700, 'agent-002', 'Analyzing test patterns: MockSession, unique ports, fileParallelism: false...'),
    tool(8100, 'agent-003', 'Read', { file_path: '/home/arkon/codeman/src/types/index.ts' }),
    msg(8700, 'agent-003', 'Mapped 38 exported interfaces across 15 domain files. Building summary...'),
    {
      t: 9300,
      kind: 'term',
      data: T([
        `${GRN}●${RST} ${CYN}agent-001${RST}: ${GRY}12 tool calls — Glob, Read(server.ts), Grep(endpoints)...${RST}`,
        `${GRN}●${RST} ${CYN}agent-002${RST}: ${GRY}8 tool calls — Glob, Read(test-utils), Read(vitest.config)...${RST}`,
        `${GRN}●${RST} ${CYN}agent-003${RST}: ${GRY}7 tool calls — Read(types.ts), Grep(interface)...${RST}`,
        '',
      ]),
    },
    tool(10100, 'agent-001', 'Glob', { pattern: 'src/web/routes/*.ts' }),
    tool(10600, 'agent-002', 'Read', { file_path: '/home/arkon/codeman/test/setup.ts' }),
    tool(11100, 'agent-003', 'Grep', { pattern: 'assertNever', path: 'src/' }),
    {
      t: 11600,
      kind: 'term',
      data: T([`${GRN}●${RST} ${GRY}171.8k, 13s${RST} ${GRY}│${RST} ${GRY}1.7k tokens${RST} ${GRY}│${RST} ${GRY}thinking${RST}`, '']),
    },
  ];
}

const SUBAGENT_TAIL_HOLD = 2500; // hold the final frame

async function recordSubagentScene(browser, videoDir) {
  console.log('\n1/2 Recording subagent-demo...');

  const context = await browser.newContext({
    viewport: SUBAGENT_VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: SUBAGENT_VIEWPORT },
  });
  const recStart = Date.now();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Start with NO subagents — they appear during the recording
  const initPayload = buildInitPayload(STANDARD_SESSIONS);
  await setupRoutes(page, initPayload, TERMINAL_PRESPAWN);
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await injectState(page, initPayload, TERMINAL_PRESPAWN, SESSION_IDS.w1);

  await page.evaluate(() => {
    try { window.app?.fitAddon?.fit(); } catch {}
    window.app?.terminal?.scrollToBottom();
  });
  await sleep(500);

  const timeline = buildSubagentTimeline();
  const totalMs = Math.max(...timeline.map((e) => e.t)) + SUBAGENT_TAIL_HOLD;
  const sceneStart = Date.now();

  // Run the whole timeline inside the page so events interleave naturally
  await page.evaluate((events) => {
    const app = window.app;
    for (const ev of events) {
      setTimeout(() => {
        try {
          if (ev.kind === 'term') {
            app.terminal.write(ev.data);
            app.terminal.scrollToBottom();
          } else if (ev.kind === 'discover') {
            app._onSubagentDiscovered(ev.agent);
            app.openSubagentWindow(ev.agent.agentId);
            // The spawn animation (400ms) lands on the auto-grid; glide to our tile after it
            setTimeout(() => {
              const win = app.subagentWindows.get(ev.agent.agentId);
              if (win?.element) {
                win.element.style.transition = 'left 0.25s ease, top 0.25s ease';
                win.element.style.left = `${ev.x}px`;
                win.element.style.top = `${ev.y}px`;
              }
            }, 520);
            setTimeout(() => {
              const win = app.subagentWindows.get(ev.agent.agentId);
              if (win?.element) win.element.style.transition = '';
              app.updateConnectionLines();
            }, 850);
          } else if (ev.kind === 'tool') {
            app._onSubagentToolCall({
              agentId: ev.agentId,
              tool: ev.tool,
              input: ev.input,
              timestamp: new Date().toISOString(),
            });
          } else if (ev.kind === 'msg') {
            app._onSubagentMessage({
              agentId: ev.agentId,
              role: 'assistant',
              text: ev.text,
              timestamp: new Date().toISOString(),
            });
          } else if (ev.kind === 'complete') {
            app._onSubagentCompleted({ agentId: ev.agentId, timestamp: new Date().toISOString() });
          }
        } catch (err) {
          console.error('timeline event failed', ev, err);
        }
      }, ev.t);
    }
  }, timeline);

  await sleep(totalMs + 500);

  await page.close();
  const videoPath = await page.video().path();
  await context.close();

  return {
    videoPath,
    ss: (sceneStart - recStart) / 1000 - 0.4,
    duration: (totalMs + 400) / 1000,
  };
}

// ─── Scene 2: zerolag typing comparison ──────────────────────────────────────

const ZEROLAG_VIEWPORT = { width: 1280, height: 470 };
const TYPED_TEXT = 'echo "zero lag typing from anywhere"';
const TYPE_INTERVAL_MS = 110;
const REMOTE_FLUSH_MS = 350; // server-echo pane flushes queued chars in bursts
const ZEROLAG_TAIL_HOLD = 1800;

const ZEROLAG_HTML = `<!DOCTYPE html>
<html>
<head>
<link rel="stylesheet" href="http://localhost:${PORT}/vendor/xterm.css">
<script src="http://localhost:${PORT}/vendor/xterm.min.js"></script>
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1280px; height: 470px; background: #0a0a0c;
    display: flex; align-items: center; justify-content: center; gap: 48px;
    font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .pane { width: 560px; }
  .card {
    background: #131316; border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px; overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.45);
  }
  .card-head {
    display: flex; align-items: baseline; gap: 10px;
    padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; align-self: center; }
  .title { font-size: 15px; font-weight: 600; color: #e8e8ea; }
  .sub { font-size: 12.5px; color: #8b8b92; }
  .term { padding: 16px 8px 12px 16px; height: 165px; }
  .good .dot { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.7); }
  .bad  .dot { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,0.7); }
  .tag {
    margin-top: 14px; text-align: center; font-size: 14.5px; color: #7e7e86;
  }
  .tag b { color: #22c55e; font-weight: 600; }
  .bad-tag b { color: #ef4444; }
</style>
</head>
<body>
  <div class="pane">
    <div class="card good">
      <div class="card-head">
        <span class="dot"></span>
        <span class="title">With zerolag-input</span>
        <span class="sub">instant local echo</span>
      </div>
      <div class="term" id="termLeft"></div>
    </div>
    <div class="tag">keystrokes echo in <b>0 ms</b></div>
  </div>
  <div class="pane">
    <div class="card bad">
      <div class="card-head">
        <span class="dot"></span>
        <span class="title">Without</span>
        <span class="sub">server round-trip echo</span>
      </div>
      <div class="term" id="termRight"></div>
    </div>
    <div class="tag bad-tag">keystrokes echo after <b>~350 ms</b></div>
  </div>
</body>
</html>`;

async function recordZerolagScene(browser, videoDir) {
  console.log('\n2/2 Recording zerolag-demo...');

  const context = await browser.newContext({
    viewport: ZEROLAG_VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: ZEROLAG_VIEWPORT },
  });
  const recStart = Date.now();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  await page.setContent(ZEROLAG_HTML, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Terminal !== 'undefined');

  await page.evaluate(() => {
    const theme = {
      background: '#131316',
      foreground: '#e8e8ea',
      cursor: '#22c55e',
      cursorAccent: '#131316',
    };
    const mk = (id) => {
      const term = new Terminal({
        cols: 44,
        rows: 5,
        fontSize: 20,
        fontFamily: "'SF Mono', 'Cascadia Code', Menlo, monospace",
        cursorBlink: true,
        cursorStyle: 'block',
        theme,
      });
      term.open(document.getElementById(id));
      term.write('\x1b[32m❯\x1b[0m ');
      return term;
    };
    window.termLeft = mk('termLeft');
    window.termRight = mk('termRight');
  });
  await sleep(600);

  const sceneStart = Date.now();
  const typingMs = TYPED_TEXT.length * TYPE_INTERVAL_MS;
  const totalMs = typingMs + REMOTE_FLUSH_MS + ZEROLAG_TAIL_HOLD;

  await page.evaluate(
    ({ text, interval, flushEvery }) => {
      let i = 0;
      const remoteQueue = [];
      const typer = setInterval(() => {
        if (i >= text.length) { clearInterval(typer); return; }
        const ch = text[i++];
        window.termLeft.write(ch); // local echo: instant
        remoteQueue.push(ch); // server echo: waits for the round-trip
      }, interval);
      const flusher = setInterval(() => {
        if (remoteQueue.length) window.termRight.write(remoteQueue.splice(0).join(''));
        if (i >= text.length && remoteQueue.length === 0) clearInterval(flusher);
      }, flushEvery);
    },
    { text: TYPED_TEXT, interval: TYPE_INTERVAL_MS, flushEvery: REMOTE_FLUSH_MS }
  );

  await sleep(totalMs + 400);

  await page.close();
  const videoPath = await page.video().path();
  await context.close();

  return {
    videoPath,
    ss: (sceneStart - recStart) / 1000 - 0.6, // small lead-in with idle cursors
    duration: (totalMs + 600) / 1000,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Codeman README GIF Capture');
  console.log('='.repeat(60));

  const server = await startStaticServer();
  const videoDir = mkdtempSync(join(tmpdir(), 'codeman-gifs-'));
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const sub = await recordSubagentScene(browser, videoDir);
    const subGif = outPath('images', 'subagent-demo.gif');
    webmToGif(sub.videoPath, subGif, { ss: Math.max(0, sub.ss), duration: sub.duration, width: 960, fps: 8 });
    console.log(`  Saved: ${subGif}`);

    const zl = await recordZerolagScene(browser, videoDir);
    const zlGif = outPath('images', 'zerolag-demo.gif');
    webmToGif(zl.videoPath, zlGif, { ss: Math.max(0, zl.ss), duration: zl.duration, width: 900, fps: 10 });
    console.log(`  Saved: ${zlGif}`);

    console.log('\nDone.');
  } catch (err) {
    console.error('\nFatal error:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    rmSync(videoDir, { recursive: true, force: true });
  }
}

process.on('SIGINT', () => process.exit(1));

main();
