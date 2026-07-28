import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Structural tests for the xterm snapshot/replay slice (COD-81). app.js has no
// bundler and is hard to drive through a real DOM, so — following the repo's
// existing pattern for app.js — these assert the source structure that makes
// the snapshot first-paint correct rather than executing it.
describe('xterm snapshot/replay (codex tab-switch)', () => {
  const appSource = () => readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

  it('rejects blank xterm snapshots before saving or restoring them', () => {
    const source = appSource();
    const helper = source.indexOf('_isUsableXtermSnapshot(snapshot)');
    const save = source.indexOf('this._xtermSnapshots.set(this.activeSessionId, snapshot)');
    const restore = source.indexOf('SNAPSHOT_RESTORE:', save);
    const restoreBlock = source.slice(save, restore);

    expect(helper).toBeGreaterThan(-1);
    // The save is gated on a usability check immediately above it.
    const usabilityGate = source.lastIndexOf('if (this._isUsableXtermSnapshot(snapshot))', save);
    expect(usabilityGate).toBeGreaterThan(-1);
    expect(usabilityGate).toBeLessThan(save);
    // …and so is each restore path (in-memory + persisted).
    expect(restoreBlock).toContain('if (snapshot && !this._isUsableXtermSnapshot(snapshot))');
    expect(restoreBlock).toContain('persisted && this._isUsableXtermSnapshot(persisted)');
  });

  it('declares the snapshot-restore flag before selectSession uses it', () => {
    const source = appSource();
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const warmDeclaration = source.indexOf('const canWarmRestore = targetWasWarm && snapshotWasInMemory;', selectStart);
    const declaration = source.indexOf('let restoredSnapshot = false;', selectStart);
    const snapshotBranch = source.indexOf(
      "if (snapshot && (canWarmRestore || !sessionIsBusy) && session?.mode !== 'shell')",
      selectStart
    );
    const rewriteDecision = source.indexOf('const needsRewrite', selectStart);

    expect(selectStart).toBeGreaterThan(-1);
    expect(warmDeclaration).toBeGreaterThan(selectStart);
    expect(warmDeclaration).toBeLessThan(snapshotBranch);
    expect(declaration).toBeGreaterThan(selectStart);
    expect(declaration).toBeLessThan(snapshotBranch);
    expect(declaration).toBeLessThan(rewriteDecision);
  });

  it('fetches after a non-warm snapshot but skips the canonical replay for a valid warm restore', () => {
    const source = appSource();
    const snapshotRestore = source.indexOf('SNAPSHOT_RESTORE:');
    const warmDelta = source.indexOf('WARM_DELTA:', snapshotRestore);
    const cacheRestore = source.indexOf('Instant byte-cache restore', snapshotRestore);
    const warmFetchGate = source.indexOf('if (!usedWarmRestore)', cacheRestore);
    const fetchStart = source.indexOf("FETCH_START'", snapshotRestore);
    const needsRewrite = source.indexOf('const needsRewrite', fetchStart);
    const rewriteDecision = source.indexOf('if (needsRewrite)', needsRewrite);
    const snapshotBlock = source.slice(snapshotRestore, cacheRestore);
    const postSnapshotRestore = source.slice(snapshotRestore, rewriteDecision);

    expect(snapshotRestore).toBeGreaterThan(-1);
    expect(warmDelta).toBeGreaterThan(snapshotRestore);
    expect(cacheRestore).toBeGreaterThan(snapshotRestore);
    expect(warmFetchGate).toBeGreaterThan(cacheRestore);
    expect(fetchStart).toBeGreaterThan(cacheRestore);
    expect(fetchStart).toBeGreaterThan(warmFetchGate);
    expect(needsRewrite).toBeGreaterThan(fetchStart);
    expect(rewriteDecision).toBeGreaterThan(needsRewrite);
    // Snapshot restoration itself does not end the outer load transaction.
    expect(snapshotBlock).not.toContain('this._finishBufferLoad();');
    expect(postSnapshotRestore).toContain('restoredSnapshot');
    expect(postSnapshotRestore).toContain('paintedLatestFrame');
    expect(postSnapshotRestore).toContain('clearedForBusy');
    expect(postSnapshotRestore).toContain('canonicalBuffer !== cachedBuffer');
  });

  it('flushes live output queued during a warm restore instead of discarding it', () => {
    const source = appSource();
    const warmRestore = source.indexOf("WARM_RESTORE_DONE'");
    const finish = source.indexOf('_finishBufferLoad(bufferLoadOwner', warmRestore);
    const finishBlock = source.slice(finish, finish + 180);

    expect(warmRestore).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(warmRestore);
    expect(finishBlock).toContain('bufferWasEmpty || usedWarmRestore');
  });

  it('forces replay after clearing a busy tab even when the fetched frame matches cache', () => {
    const source = appSource();
    const cacheRestore = source.indexOf('Instant byte-cache restore');
    const busyClear = source.indexOf('CACHE_SKIP_BUSY', cacheRestore);
    const needsRewrite = source.indexOf('const needsRewrite', busyClear);
    const rewriteDecision = source.indexOf('if (needsRewrite)', needsRewrite);
    const replayBlock = source.slice(cacheRestore, rewriteDecision);

    expect(cacheRestore).toBeGreaterThan(-1);
    expect(busyClear).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(busyClear);
    expect(rewriteDecision).toBeGreaterThan(needsRewrite);
    expect(replayBlock).toContain('clearedForBusy');
    expect(replayBlock).toContain('paintedLatestFrame');
    expect(replayBlock).toContain('restoredSnapshot');
    expect(replayBlock).toContain('canonicalBuffer !== cachedBuffer');
  });

  it('loads the SerializeAddon and keeps a per-session snapshot map', () => {
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    expect(terminalSource).toContain('this._xtermSnapshots = new Map()');
    expect(terminalSource).toContain('new SerializeAddon.SerializeAddon()');
    expect(terminalSource).toContain('this.terminal.loadAddon(this._serializeAddon)');
  });

  it('keeps a stable bounded history range across repeated session switches', () => {
    const source = appSource();
    const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');

    expect(constants).toContain('const TERMINAL_SNAPSHOT_SCROLLBACK = 10_000;');
    expect(source).toContain('this._serializeAddon.serialize({ scrollback: TERMINAL_SNAPSHOT_SCROLLBACK })');
    expect(source).not.toContain('this._serializeAddon.serialize({ scrollback: 1000 })');
  });

  it('evicts the in-memory snapshot cache and persists with a bounded localStorage budget', () => {
    const source = appSource();
    // In-memory cache is LRU-bounded…
    expect(source).toContain('if (this._xtermSnapshots.size > 20)');
    // …per-snapshot localStorage writes are size-capped…
    expect(source).toContain('snapshot.length < 256 * 1024');
    // …and the persisted key set is pruned of dead sessions.
    expect(source).toContain("k.startsWith('codeman-xs-')");
  });
});
