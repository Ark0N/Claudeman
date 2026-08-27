/**
 * @fileoverview Scan `~/.omp/agent/sessions/*&#47;*.jsonl` for Past Sessions rows,
 * the omp analog of what `scanProjectDir()` (session-routes.ts) does for
 * Claude's own `~/.claude/projects` transcripts.
 *
 * Without this, an omp conversation exists ONLY as a Codeman-level live/
 * persisted session record — delete that (a "Kill Tmux" close, or any other
 * cleanup) and the conversation vanishes from Past Sessions entirely, even
 * though `omp` itself never forgot it. Claude conversations don't have that
 * problem because Codeman already reads them back from Claude's own
 * transcript files independent of its own session bookkeeping; this gives
 * omp conversations the same treatment.
 *
 * Each omp session file's SECOND line is a `{"type":"session","id":...,
 * "cwd":...}` header carrying the real (unmangled) working directory and the
 * session's own id directly — no need to reverse-engineer the mangled
 * directory name the way Claude Code's own scanner has to (see
 * `decodeProjectKey()` in session-routes.ts and its "lossy" caveat). Prompt
 * text comes from each `{"type":"message","message":{"role":"user",...}}`
 * entry, giving a real first-message title instead of a bare case name.
 *
 * Unlike Claude's transcripts (which can run to tens of MB of tool-call
 * output), an omp session file is the conversation only, so this reads each
 * file whole rather than doing head/tail windows — bounded by a size cap so
 * one unexpectedly huge file can't blow up memory.
 *
 * @module omp-transcript
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function ompSessionsRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions');
}

/** Skip anything absurdly large rather than parsing it whole into memory. */
const MAX_OMP_SESSION_FILE_BYTES = 2 * 1024 * 1024;

/** Defensive cap on total files scanned across every directory, mirroring
 *  the Claude scanner's own instinct not to let one pathological tree stall
 *  a request — a real omp install has, at most, a few hundred of these. */
const MAX_OMP_SESSION_FILES = 2000;

export interface OmpHistorySession {
  sessionId: string;
  workingDir: string;
  sizeBytes: number;
  /** ISO timestamp, from the file's own mtime. */
  lastModified: string;
  firstPrompt?: string;
  lastPrompt?: string;
}

function extractUserPromptText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== 'user' || !Array.isArray(m.content)) return undefined;
  const parts: string[] = [];
  for (const block of m.content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  const joined = parts.join(' ').trim();
  return joined || undefined;
}

/** Parse one omp session `.jsonl` file, or null when it's unreadable, empty, or has no session header. */
function parseOmpSessionFile(filePath: string): OmpHistorySession | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0 || stat.size > MAX_OMP_SESSION_FILE_BYTES) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId: string | undefined;
  let workingDir: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type === 'session' && typeof e.id === 'string' && typeof e.cwd === 'string' && e.cwd.startsWith('/')) {
      // A corrupted or malformed session file could carry a relative or empty
      // cwd; requiring an absolute path keeps a downstream resume attempt
      // from being pointed at a nonsense working directory.
      sessionId = e.id;
      workingDir = e.cwd;
    } else if (e.type === 'message') {
      const prompt = extractUserPromptText(e.message);
      if (prompt) {
        if (!firstPrompt) firstPrompt = prompt;
        lastPrompt = prompt;
      }
    }
  }

  if (!sessionId || !workingDir) return null;
  return {
    sessionId,
    workingDir,
    sizeBytes: stat.size,
    lastModified: stat.mtime.toISOString(),
    firstPrompt,
    lastPrompt,
  };
}

/**
 * Scan every omp conversation on disk into Past-Sessions rows. Best-effort
 * throughout: a missing `~/.omp` (never installed/used), an unreadable
 * directory, or one corrupt file yields fewer rows rather than throwing —
 * this feeds the same unified merge the Claude transcript scanner does, and
 * one broken source must never blank the whole Past Sessions list.
 */
export function scanOmpSessionsHistory(): OmpHistorySession[] {
  const root = ompSessionsRoot();
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(root);
  } catch {
    return [];
  }

  const out: OmpHistorySession[] = [];
  for (const dirName of dirEntries) {
    if (out.length >= MAX_OMP_SESSION_FILES) break;
    const dirPath = join(root, dirName);
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (out.length >= MAX_OMP_SESSION_FILES) break;
      if (!file.endsWith('.jsonl')) continue;
      try {
        const parsed = parseOmpSessionFile(join(dirPath, file));
        if (parsed) out.push(parsed);
      } catch {
        // One bad file must not sink the whole scan.
      }
    }
  }
  return out;
}
