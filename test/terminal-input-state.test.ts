import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type InputDraft = {
  pendingText: string;
  flushedText: string;
  cjkText: string;
  updatedAt: number;
};

type InputSnapshot = {
  pendingText?: string;
  compositionText?: string;
  flushedText?: string;
  cjkText?: string;
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
      key === 'codeman:sessionDrafts' &&
      Array.from(this.values.keys()).some((candidate) => candidate.startsWith('codeman-xs-'))
    ) {
      const error = new Error('quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    super.setItem(key, value);
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
    expect(JSON.parse(storage.getItem('codeman:sessionDrafts') || '{}').drafts?.['session-a']?.pendingText).toBe(
      'irreplaceable'
    );
  });
});
