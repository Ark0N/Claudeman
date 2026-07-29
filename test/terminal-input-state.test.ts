import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type InputDraft = {
  pendingText: string;
  flushedText: string;
  cjkText: string;
  updatedAt: number;
  ptyOwned?: boolean;
};

type InputSnapshot = {
  pendingText?: string;
  compositionText?: string;
  flushedText?: string;
  cjkText?: string;
  ptyOwned?: boolean;
};

type TerminalInputStateStore = {
  capture: (sessionId: string, snapshot: InputSnapshot, options?: { persist?: boolean }) => InputDraft | null;
  handoff: (
    sessionId: string,
    snapshot: InputSnapshot,
    options?: { persist?: boolean }
  ) => { flushText: string; draft: InputDraft | null };
  set: (sessionId: string, draft: Partial<InputDraft>, options?: { persist?: boolean }) => InputDraft | null;
  get: (sessionId: string) => InputDraft | null;
  has: (sessionId: string) => boolean;
  hasFlushed: (sessionId: string) => boolean;
  clear: (sessionId: string, options?: { persist?: boolean }) => void;
  clearAll: (options?: { persist?: boolean }) => void;
  load: () => void;
  persistNow: () => boolean;
};

type StoreOptions = {
  storage?: MemoryStorage | null;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  requestIdle?: (callback: () => void, options: { timeout: number }) => unknown;
  cancelIdle?: (handle: unknown) => void;
  maxDrafts?: number;
  maxDraftAgeMs?: number;
  maxPersistedChars?: number;
  maxTotalPersistedChars?: number;
};

type TerminalInputStateStoreConstructor = new (options?: StoreOptions) => TerminalInputStateStore;

class MemoryStorage {
  protected readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

class QuotaStorage extends MemoryStorage {
  override setItem(key: string, value: string): void {
    if (
      key.startsWith('codeman:sessionDrafts:draft:') &&
      Array.from(this.values.keys()).some((candidate) => candidate.startsWith('codeman-xs-'))
    ) {
      const error = new Error('quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    super.setItem(key, value);
  }
}

class RecordingStorage extends MemoryStorage {
  readonly writes: string[] = [];

  override setItem(key: string, value: string): void {
    this.writes.push(key);
    super.setItem(key, value);
  }
}

class NonQuotaFailingStorage extends MemoryStorage {
  failWrites = false;

  override setItem(key: string, value: string): void {
    if (this.failWrites) {
      const error = new Error('storage disabled');
      error.name = 'SecurityError';
      throw error;
    }
    super.setItem(key, value);
  }
}

class FailingRemoveStorage extends MemoryStorage {
  failDraftRemovals = false;

  override removeItem(key: string): void {
    if (this.failDraftRemovals && key.startsWith('codeman:sessionDrafts:draft:')) {
      throw new Error('remove failed');
    }
    super.removeItem(key);
  }
}

function loadStore(): TerminalInputStateStoreConstructor {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-input-state.js'), 'utf8');
  const context = vm.createContext({
    console,
    globalThis: {},
  });
  vm.runInContext(source, context, { filename: 'terminal-input-state.js' });
  return (
    context.globalThis as {
      TerminalInputStateStore: TerminalInputStateStoreConstructor;
    }
  ).TerminalInputStateStore;
}

function createStore(
  Store: TerminalInputStateStoreConstructor,
  storage: MemoryStorage | null = new MemoryStorage(),
  now = () => 100
): TerminalInputStateStore {
  return new Store({
    storage,
    now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
}

function draftKey(sessionId: string): string {
  return `codeman:sessionDrafts:draft:${encodeURIComponent(sessionId)}`;
}

function persistedDraft(storage: MemoryStorage, sessionId: string): InputDraft | null {
  const raw = storage.getItem(draftKey(sessionId));
  return raw ? (JSON.parse(raw).draft as InputDraft) : null;
}

describe('TerminalInputStateStore', () => {
  it('does not rebind injected platform timer functions to the store', () => {
    const Store = loadStore();
    let setTimerReceiver: unknown = 'not called';
    let clearTimerReceiver: unknown = 'not called';
    const store = new Store({
      storage: new MemoryStorage(),
      setTimer: function (this: unknown) {
        setTimerReceiver = this;
        return 7;
      },
      clearTimer: function (this: unknown) {
        clearTimerReceiver = this;
      },
    });

    store.set('session-a', { pendingText: 'draft' });
    store.persistNow();

    expect(setTimerReceiver).toBeUndefined();
    expect(clearTimerReceiver).toBeUndefined();
  });

  it('uses idle scheduling when the browser provides it', () => {
    const Store = loadStore();
    const callbacks: Array<() => void> = [];
    let timeout = 0;
    const store = new Store({
      storage: new MemoryStorage(),
      debounceMs: 175,
      requestIdle: (callback, options) => {
        callbacks.push(callback);
        timeout = options.timeout;
        return 1;
      },
      cancelIdle: () => {},
      setTimer: () => {
        throw new Error('timer fallback should not be used');
      },
    });

    store.set('session-a', { pendingText: 'draft' });

    expect(callbacks).toHaveLength(1);
    expect(timeout).toBe(175);
  });

  it('coalesces scheduled persistence and can schedule again after the timer fires', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    const callbacks: Array<() => void> = [];
    const store = new Store({
      storage,
      now: () => 100,
      setTimer: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer: () => {},
    });

    store.set('session-a', { pendingText: 'a' });
    store.set('session-a', { pendingText: 'ab' });
    expect(callbacks).toHaveLength(1);

    callbacks.shift()!();
    expect(persistedDraft(storage, 'session-a')?.pendingText).toBe('ab');

    store.set('session-a', { pendingText: 'abc' });
    expect(callbacks).toHaveLength(1);
  });

  it('captures one exact editable record per session without exposing mutable internals', () => {
    const Store = loadStore();
    const store = createStore(Store);

    const captured = store.capture(
      'session-a',
      {
        pendingText: 'first paragraph\n\nsecond paragraph',
        compositionText: '候補',
        flushedText: 'already sent',
        cjkText: '中文',
      },
      { persist: false }
    );

    expect(captured).toEqual({
      pendingText: 'first paragraph\n\nsecond paragraph候補',
      flushedText: 'already sent',
      cjkText: '中文',
      updatedAt: 100,
    });
    captured!.pendingText = 'mutated outside';
    expect(store.get('session-a')?.pendingText).toBe('first paragraph\n\nsecond paragraph候補');
    expect(store.hasFlushed('session-a')).toBe(true);
  });

  it('returns pending text as an explicit handoff output and keeps composition editable', () => {
    const Store = loadStore();
    const store = createStore(Store);

    const result = store.handoff(
      'session-a',
      {
        pendingText: 'flush me',
        compositionText: 'keep me',
        flushedText: 'older text',
        cjkText: '保留',
      },
      { persist: false }
    );

    expect(result).toEqual({
      flushText: 'flush me',
      draft: {
        pendingText: 'keep me',
        flushedText: 'older textflush me',
        cjkText: '保留',
        updatedAt: 100,
      },
    });
    expect(store.get('session-a')).toEqual(result.draft);
  });

  it('persists and reloads multiline Unicode drafts without loss', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    const first = createStore(Store, storage, () => 321);
    first.set(
      'session-a',
      {
        pendingText: 'References\n--------------------\n\nWisdom–Holman',
        flushedText: '',
        cjkText: '轨道',
      },
      { persist: false }
    );

    expect(first.persistNow()).toBe(true);
    const second = createStore(Store, storage, () => 999);

    expect(second.get('session-a')).toEqual({
      pendingText: 'References\n--------------------\n\nWisdom–Holman',
      flushedText: '',
      cjkText: '轨道',
      updatedAt: 321,
    });
  });

  it('persists PTY-owned editing even when no overlay text remains', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    const first = createStore(Store, storage, () => 321);

    expect(first.set('session-a', { ptyOwned: true }, { persist: false })).toEqual({
      pendingText: '',
      flushedText: '',
      cjkText: '',
      updatedAt: 321,
      ptyOwned: true,
    });
    expect(first.persistNow()).toBe(true);

    const second = createStore(Store, storage, () => 999);
    expect(second.get('session-a')).toEqual({
      pendingText: '',
      flushedText: '',
      cjkText: '',
      updatedAt: 321,
      ptyOwned: true,
    });
  });

  it('migrates the aggregate storage format to per-session records', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    storage.setItem(
      'codeman:sessionDrafts',
      JSON.stringify({
        version: 1,
        drafts: {
          'session-a': {
            pendingText: 'legacy',
            flushedText: '',
            cjkText: '',
            updatedAt: 100,
          },
        },
      })
    );
    const store = createStore(Store, storage);

    expect(store.get('session-a')?.pendingText).toBe('legacy');
    expect(store.persistNow()).toBe(true);
    expect(storage.getItem('codeman:sessionDrafts')).toBeNull();
    expect(persistedDraft(storage, 'session-a')?.pendingText).toBe('legacy');
  });

  it('writes only sessions whose drafts changed', () => {
    const Store = loadStore();
    const storage = new RecordingStorage();
    const store = createStore(Store, storage);
    store.set('session-a', { pendingText: 'a' }, { persist: false });
    store.set('session-b', { pendingText: 'b' }, { persist: false });
    expect(store.persistNow()).toBe(true);
    storage.writes.length = 0;

    store.set('session-a', { pendingText: 'updated' }, { persist: false });
    expect(store.persistNow()).toBe(true);

    expect(storage.writes).toEqual([draftKey('session-a')]);
  });

  it('clears one session or the complete store through explicit APIs', () => {
    const Store = loadStore();
    const store = createStore(Store);
    store.set('session-a', { pendingText: 'a' }, { persist: false });
    store.set('session-b', { pendingText: 'b' }, { persist: false });

    store.clear('session-a', { persist: false });
    expect(store.has('session-a')).toBe(false);
    expect(store.has('session-b')).toBe(true);

    store.clearAll({ persist: false });
    expect(store.has('session-b')).toBe(false);
  });

  it('evicts reproducible terminal snapshots before abandoning typed drafts', () => {
    const Store = loadStore();
    const storage = new QuotaStorage();
    MemoryStorage.prototype.setItem.call(storage, 'codeman-xs-old-a', 'snapshot');
    MemoryStorage.prototype.setItem.call(storage, 'codeman-xs-old-b', 'snapshot');
    MemoryStorage.prototype.setItem.call(storage, 'keep-me', 'other state');
    const store = createStore(Store, storage);
    store.set('session-a', { pendingText: 'irreplaceable' }, { persist: false });

    expect(store.persistNow()).toBe(true);
    expect(storage.getItem('codeman-xs-old-a')).toBeNull();
    expect(storage.getItem('codeman-xs-old-b')).toBeNull();
    expect(storage.getItem('keep-me')).toBe('other state');
    expect(persistedDraft(storage, 'session-a')?.pendingText).toBe('irreplaceable');
  });

  it('does not evict terminal snapshots for non-quota storage failures', () => {
    const Store = loadStore();
    const storage = new NonQuotaFailingStorage();
    storage.setItem('codeman-xs-warm-session', 'snapshot');
    const store = createStore(Store, storage);
    store.set('session-a', { pendingText: 'irreplaceable' }, { persist: false });
    storage.failWrites = true;

    expect(store.persistNow()).toBe(false);
    expect(storage.getItem('codeman-xs-warm-session')).toBe('snapshot');
  });

  it('bounds stale session retention and refuses oversized writes without truncating memory', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    const store = new Store({
      storage,
      now: () => 1_000,
      maxDrafts: 2,
      maxDraftAgeMs: 500,
      maxPersistedChars: 200,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    store.set('expired', { pendingText: 'old', updatedAt: 100 }, { persist: false });
    store.set('session-a', { pendingText: 'a', updatedAt: 800 }, { persist: false });
    store.set('session-b', { pendingText: 'b', updatedAt: 900 }, { persist: false });

    expect(store.persistNow()).toBe(true);
    expect(storage.getItem(draftKey('expired'))).toBeNull();
    expect(persistedDraft(storage, 'session-a')?.pendingText).toBe('a');
    expect(persistedDraft(storage, 'session-b')?.pendingText).toBe('b');

    store.set('session-b', { pendingText: 'x'.repeat(500) }, { persist: false });
    expect(store.persistNow()).toBe(false);
    expect(store.persistNow()).toBe(false);
    expect(store.get('session-b')?.pendingText).toBe('x'.repeat(500));
    expect(storage.getItem(draftKey('session-b'))).toBeNull();
    expect(createStore(Store, storage, () => 1_000).get('session-b')).toBeNull();
  });

  it('retries stale-record removal for an oversized live draft', () => {
    const Store = loadStore();
    const storage = new FailingRemoveStorage();
    storage.setItem(
      draftKey('session-a'),
      JSON.stringify({
        version: 1,
        draft: {
          pendingText: 'stale',
          flushedText: '',
          cjkText: '',
          updatedAt: 100,
        },
      })
    );
    const store = new Store({
      storage,
      now: () => 200,
      maxPersistedChars: 100,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    store.set('session-a', { pendingText: 'x'.repeat(500) }, { persist: false });
    storage.failDraftRemovals = true;

    expect(store.persistNow()).toBe(false);
    expect(persistedDraft(storage, 'session-a')?.pendingText).toBe('stale');

    storage.failDraftRemovals = false;
    expect(store.persistNow()).toBe(false);
    expect(storage.getItem(draftKey('session-a'))).toBeNull();
  });

  it('bounds total durable draft storage by reclaiming the oldest clean session', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    const store = new Store({
      storage,
      now: () => 1_000,
      maxPersistedChars: 500,
      maxTotalPersistedChars: 260,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    store.set('session-a', { pendingText: 'a'.repeat(40), updatedAt: 100 }, { persist: false });
    expect(store.persistNow()).toBe(true);
    store.set('session-b', { pendingText: 'b'.repeat(40), updatedAt: 200 }, { persist: false });
    expect(store.persistNow()).toBe(true);
    store.set('session-c', { pendingText: 'c'.repeat(40), updatedAt: 300 }, { persist: false });

    expect(store.persistNow()).toBe(false);
    expect(storage.getItem(draftKey('session-a'))).toBeNull();
    expect(persistedDraft(storage, 'session-b')?.pendingText).toBe('b'.repeat(40));
    expect(persistedDraft(storage, 'session-c')?.pendingText).toBe('c'.repeat(40));
    expect(store.get('session-a')?.pendingText).toBe('a'.repeat(40));
  });

  it('retains legacy aggregate data when an oversized draft cannot migrate', () => {
    const Store = loadStore();
    const storage = new MemoryStorage();
    storage.setItem(
      'codeman:sessionDrafts',
      JSON.stringify({
        version: 1,
        drafts: {
          'session-a': {
            pendingText: 'x'.repeat(500),
            flushedText: '',
            cjkText: '',
            updatedAt: 100,
          },
        },
      })
    );
    const store = new Store({
      storage,
      now: () => 200,
      maxPersistedChars: 100,
      setTimer: () => 1,
      clearTimer: () => {},
    });

    expect(store.persistNow()).toBe(false);
    expect(storage.getItem('codeman:sessionDrafts')).not.toBeNull();
    expect(createStore(Store, storage, () => 300).get('session-a')?.pendingText).toBe('x'.repeat(500));
  });
});
