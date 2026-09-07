/**
 * @fileoverview Codeman HTTP client for the PR bot: spawn a claude session in a
 * directory, wait until its composer is up, run one prompt to the END of its turn,
 * read the answer, delete the session.
 *
 * This is the `skills/codeman` §0 preamble translated to TypeScript, and it keeps
 * the traps that preamble documents:
 *  - readiness is the rendered composer (`shift+tab` in the pane), never `idle`;
 *  - the folder-trust dialog is READ off the screen and answered one keystroke at a
 *    time (Claude Code 2.1.252 highlights "No, exit" by default, so a blind Enter kills
 *    the session);
 *  - send-and-wait waits on `stop,blocked,exit`, never on the flapping `idle`, with a
 *    short first wait, one Enter nudge for a stranded prompt, and tagged-duplicate
 *    resends that re-wait without retyping (the server treats an already-applied
 *    (clientId, seq) frame as "wait only");
 *  - the bot deletes only sessions it created, by exact id.
 *
 * The production server is HTTPS with a self-signed certificate on loopback, so the
 * undici Agent skips certificate verification for that one connection.
 */
import { Agent, fetch as undiciFetch } from 'undici';

export interface CodemanClientOptions {
  apiUrl: string;
  username?: string;
  password?: string;
}

export interface CreateSessionOptions {
  workingDir: string;
  name: string;
  modelOverride?: string;
  effort?: string;
  resumeSessionId?: string;
}

export interface WaitResult {
  ended: boolean;
  timedOut: boolean;
  signal?: string;
}

export interface SessionRecord {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  claudeSessionId?: string | null;
  workingDir: string;
  mode: string;
}

export type TurnOutcome = { kind: 'stop' } | { kind: 'blocked' } | { kind: 'exit' } | { kind: 'timeout' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '');
}

/** Which key answers the trust dialog right now, read from the rendered pane. */
export function trustDialogKey(screen: string): 'confirm' | 'move' | null {
  const compact = stripAnsi(screen).replace(/\s+/g, '');
  const matches = compact.match(/❯[0-9.]*(yes,itrustthisfolder|no,exit)/gi);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1].toLowerCase();
  return last.includes('yes,') ? 'confirm' : 'move';
}

export class CodemanClient {
  // headersTimeout/bodyTimeout default to 300 s in undici, which is shorter than one
  // long-poll slice on the wait endpoints (up to 580 s): the first review died at
  // exactly five minutes with a bare "fetch failed". The per-request AbortSignal is
  // the only ceiling here.
  private readonly agent = new Agent({ connect: { rejectUnauthorized: false }, headersTimeout: 0, bodyTimeout: 0 });
  private readonly authHeader?: string;

  constructor(private readonly opts: CodemanClientOptions) {
    if (opts.password) {
      this.authHeader = 'Basic ' + Buffer.from(`${opts.username || 'admin'}:${opts.password}`).toString('base64');
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    timeoutMs = 60_000
  ): Promise<T> {
    const url = new URL(this.opts.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await undiciFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: this.agent,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      const detail = cause ? ` (${cause.code ?? ''} ${cause.message ?? ''})`.replace(/\(\s+/, '(').trim() : '';
      throw new Error(`${method} ${path}: ${(err as Error).message}${detail}`);
    }
    const text = await res.text();
    let json: { success?: boolean; data?: T; error?: string; errorCode?: string } & Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${method} ${path}: non-JSON ${res.status} response: ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.success === false) {
      throw new Error(
        `${method} ${path}: ${res.status} ${json.errorCode ?? ''} ${json.error ?? text.slice(0, 200)}`.trim()
      );
    }
    // Most routes use the {success, data} envelope; a few legacy GETs return the raw shape.
    return (json.success === true && json.data !== undefined ? json.data : json) as T;
  }

  async status(): Promise<{ version?: string }> {
    return this.request<{ version?: string }>('GET', '/api/status');
  }

  async listSessions(): Promise<SessionRecord[]> {
    const data = await this.request<SessionRecord[] | { sessions: SessionRecord[] }>('GET', '/api/sessions');
    return Array.isArray(data) ? data : (data.sessions ?? []);
  }

  async getSession(id: string): Promise<SessionRecord> {
    return this.request<SessionRecord>('GET', `/api/sessions/${id}`);
  }

  /** Create + start. Creation alone leaves pid null and no pane, so the two are one step here. */
  async createInteractiveSession(opts: CreateSessionOptions): Promise<string> {
    const created = await this.request<{ session: { id: string } }>('POST', '/api/sessions', {
      workingDir: opts.workingDir,
      mode: 'claude',
      name: opts.name,
      modelOverride: opts.modelOverride,
      effort: opts.effort,
      resumeSessionId: opts.resumeSessionId,
    });
    const id = created.session?.id;
    if (!id) throw new Error('POST /api/sessions returned no session id');
    await this.request('POST', `/api/sessions/${id}/interactive`, {});
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    if (!id || id.length < 8) throw new Error(`refusing to delete session "${id}"`);
    await this.request('DELETE', `/api/sessions/${id}`);
  }

  async waitOutput(id: string, match: string, from: 'now' | 'buffer', timeoutMs: number): Promise<boolean> {
    const data = await this.request<{ wait?: { matched?: boolean } }>(
      'GET',
      `/api/sessions/${id}/wait-output`,
      undefined,
      { match, from, timeout: timeoutMs },
      timeoutMs + 15_000
    );
    return Boolean(data.wait?.matched);
  }

  async waitSignal(id: string, until: string, timeoutMs: number): Promise<WaitResult> {
    const data = await this.request<{ wait?: WaitResult }>(
      'GET',
      `/api/sessions/${id}/wait`,
      undefined,
      { until, timeout: timeoutMs },
      timeoutMs + 15_000
    );
    return data.wait ?? { ended: false, timedOut: true };
  }

  async terminalText(id: string): Promise<string> {
    const data = await this.request<{ terminalBuffer?: string }>('GET', `/api/sessions/${id}/terminal`, undefined, {
      full: '1',
    });
    return data.terminalBuffer ?? '';
  }

  async sendKeys(id: string, input: string, clientId: string, seq: number): Promise<void> {
    await this.request('POST', `/api/sessions/${id}/input`, { input, useMux: true, clientId, seq });
  }

  async lastResponse(id: string): Promise<string> {
    const data = await this.request<{ text?: string }>('GET', `/api/sessions/${id}/last-response`);
    return data.text ?? '';
  }

  /** Composer wait, trust-dialog fallback, composer wait again. Throws when the pane never gets there. */
  async ensureReady(id: string, log: (m: string) => void): Promise<void> {
    if (await this.waitOutput(id, 'shift+tab', 'buffer', 5000)) return;
    for (let i = 1; i <= 6; i++) {
      const key = trustDialogKey(await this.terminalText(id));
      if (!key) break;
      log(`trust dialog on screen: ${key === 'confirm' ? 'Enter' : 'arrow down'}`);
      await this.sendKeys(id, key === 'confirm' ? '\r' : '\x1b[B', `prbot-trust-${id}`, i);
      if (key === 'confirm') break;
      await sleep(1000);
    }
    if (await this.waitOutput(id, 'shift+tab', 'buffer', 45_000)) return;
    throw new Error('the session never drew its composer (no `shift+tab` in the pane after 50s)');
  }

  /**
   * Send ONE prompt and block until the turn ends, the session blocks on a question,
   * the pane exits, or `deadlineMs` passes. `isDone` lets the caller finish early on
   * an out-of-band signal (the report file appearing), which also covers a stop edge
   * that fired between two waits.
   */
  async runTurn(
    id: string,
    prompt: string,
    opts: { deadlineMs: number; isDone?: () => boolean; log: (m: string) => void }
  ): Promise<TurnOutcome> {
    if (prompt.includes('\n'))
      throw new Error('runTurn prompts must be single-line (embedded newlines are stripped by tmux)');
    const clientId = `prbot-${id}`;
    const seq = Math.floor(Date.now() / 1000);
    const frame = { input: prompt + '\r', useMux: true, clientId, seq, wait: 'stop,blocked,exit', waitTimeout: 20_000 };
    const started = Date.now();
    const post = (body: unknown, timeout: number) =>
      this.request<{ delivered?: boolean; wait?: WaitResult }>(
        'POST',
        `/api/sessions/${id}/input`,
        body,
        undefined,
        timeout + 15_000
      );

    let r = await post(frame, 20_000);
    if (!r.delivered) throw new Error('the prompt was not delivered (pane dead?)');
    let wait = r.wait;
    let nudged = false;
    while (true) {
      if (wait && !wait.timedOut) return toOutcome(wait);
      if (opts.isDone?.()) return { kind: 'stop' };
      const remaining = opts.deadlineMs - (Date.now() - started);
      if (remaining <= 0) return { kind: 'timeout' };
      if (!nudged) {
        // An Ink repaint occasionally eats the Enter: a bare \r is the missing key when
        // the prompt is stranded and a no-op when the turn is genuinely running.
        nudged = true;
        await this.sendKeys(id, '\r', clientId, seq + 1);
      }
      const slice = Math.min(remaining, 580_000);
      opts.log(`still working (${Math.round((Date.now() - started) / 60_000)} min)`);
      r = await post({ ...frame, waitTimeout: slice }, slice);
      wait = r.wait;
    }
  }
}

function toOutcome(wait: WaitResult): TurnOutcome {
  const signal = wait.signal ?? '';
  if (signal === 'blocked') return { kind: 'blocked' };
  if (signal === 'exit') return { kind: 'exit' };
  return { kind: 'stop' };
}
