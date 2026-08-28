/**
 * @fileoverview Pins the "Run OMP always resumes" bug found live 2026-08-27.
 *
 * Session._resolvedOmpRespawnConfig() resolves-and-pins the newest on-disk omp
 * conversation as a side effect on `this._ompConfig`. That is correct when
 * reattaching to an ALREADY-TRACKED mux session (a dead-pane respawn, or a
 * boot-recovery reattach — the constructor sets `_muxSession` from persisted
 * state before startInteractive() ever runs there). It is wrong for a
 * genuinely brand-new session: startInteractive() computes
 * `respawnPaneOptions: this._buildRespawnPaneOptions()` EAGERLY in the same
 * object literal that builds `createSessionOptions.ompConfig: this._ompConfig`,
 * so the resolve-and-pin side effect ran and poisoned `this._ompConfig` before
 * that field was even read — a fresh "Run OMP" click in a working directory
 * with any prior omp history silently launched `--resume <old-id>` instead of
 * a clean `omp` invocation.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/types.js';

describe('OMP: fresh session vs. reattach must not share resumeSessionId resolution', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'resume-test');
  const sessionDir = join(homedir(), '.omp', 'agent', 'sessions', '-codeman-cases-resume-test');
  const sessions: Session[] = [];

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(join(homedir(), '.omp'), { recursive: true, force: true });
  });

  function seedOmpSessionFile(id: string) {
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `2026-08-27T17-31-08-001Z_${id}.jsonl`), '{}');
  }

  it('a brand-new session (no prior mux session) never inherits an on-disk conversation', async () => {
    seedOmpSessionFile('old-conversation-id');

    const session = new Session({
      workingDir,
      mode: 'omp',
      mux: new TmuxManager(),
      useMux: true,
    });
    sessions.push(session);

    await session.startInteractive();
    const state = session.toState();

    expect(state.ompConfig).toBeUndefined();
    expect(session.claudeSessionId).toBe(session.id);
  });

  it('a reattach to an existing tracked mux session still resolves and pins the real id', async () => {
    seedOmpSessionFile('real-omp-uuid');

    const muxSession: MuxSession = {
      sessionId: 'placeholder',
      muxName: 'codeman-deadbeef',
      pid: 1,
      createdAt: Date.now(),
      workingDir,
      mode: 'omp',
      attached: false,
    };

    const session = new Session({
      workingDir,
      mode: 'omp',
      mux: new TmuxManager(),
      useMux: true,
      muxSession,
    });
    sessions.push(session);

    await session.startInteractive();
    const state = session.toState();

    expect(state.ompConfig?.resumeSessionId).toBe('real-omp-uuid');
    expect(session.claudeSessionId).toBe('real-omp-uuid');
  });
});
