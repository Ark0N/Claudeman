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
    const warmDeclaration = source.indexOf(
      'const canWarmRestore = targetWasReplayable && snapshotWasInMemory;',
      selectStart
    );
    const declaration = source.indexOf('let restoredSnapshot = false;', selectStart);
    const snapshotBranch = source.indexOf(
      "if (snapshot && (canWarmRestore || !sessionIsBusy) && session?.mode !== 'shell')",
      selectStart
    );
    const rewriteDecision = source.indexOf(
      'restoredSnapshot || clearedForBusy || data.terminalBuffer !== cachedBuffer',
      selectStart
    );

    expect(selectStart).toBeGreaterThan(-1);
    expect(warmDeclaration).toBeGreaterThan(selectStart);
    expect(warmDeclaration).toBeLessThan(snapshotBranch);
    expect(declaration).toBeGreaterThan(selectStart);
    expect(declaration).toBeLessThan(snapshotBranch);
    expect(declaration).toBeLessThan(rewriteDecision);
  });

  it('uses cold xterm snapshots as first paint before fetching the canonical terminal frame', () => {
    const source = appSource();
    const snapshotRestore = source.indexOf('SNAPSHOT_RESTORE:');
    const cacheRestore = source.indexOf('Instant cache restore', snapshotRestore);
    const fetchStart = source.indexOf("FETCH_START'", snapshotRestore);
    const fetchGate = source.lastIndexOf('if (!usedWarmRestore)', fetchStart);
    const needsRewrite = source.indexOf('const needsRewrite', fetchStart);
    const snapshotBlock = source.slice(snapshotRestore, cacheRestore);
    const postSnapshotRestore = source.slice(snapshotRestore, needsRewrite + 160);

    expect(snapshotRestore).toBeGreaterThan(-1);
    expect(cacheRestore).toBeGreaterThan(snapshotRestore);
    expect(fetchGate).toBeGreaterThan(cacheRestore);
    expect(fetchStart).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(fetchStart);
    // A cold snapshot restore must not finish the load before the guarded
    // canonical fetch. Valid warm replay is covered by warm-terminal-cache.test.
    expect(snapshotBlock).not.toContain('this._finishBufferLoad();');
    expect(postSnapshotRestore).toContain('restoredSnapshot');
    expect(postSnapshotRestore).toContain('restoredSnapshot || clearedForBusy || data.terminalBuffer !== cachedBuffer');
  });

  it('forces replay after clearing a busy tab even when the fetched frame matches cache', () => {
    const source = appSource();
    const cacheRestore = source.indexOf('Instant cache restore');
    const busyClear = source.indexOf('CACHE_SKIP_BUSY', cacheRestore);
    const needsRewrite = source.indexOf('const needsRewrite', busyClear);
    const replayBlock = source.slice(cacheRestore, needsRewrite + 160);

    expect(cacheRestore).toBeGreaterThan(-1);
    expect(busyClear).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(busyClear);
    expect(replayBlock).toContain('clearedForBusy');
    expect(replayBlock).toContain('restoredSnapshot || clearedForBusy || data.terminalBuffer !== cachedBuffer');
  });

  it('loads the SerializeAddon and keeps a per-session snapshot map', () => {
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    expect(terminalSource).toContain('this._xtermSnapshots = new Map()');
    expect(terminalSource).toContain('new SerializeAddon.SerializeAddon()');
    expect(terminalSource).toContain('this.terminal.loadAddon(this._serializeAddon)');
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
