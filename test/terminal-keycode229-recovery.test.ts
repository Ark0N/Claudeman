import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;

function makeTextarea() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, event: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ type, ...event });
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, bucket) => total + bucket.size, 0);
    },
  };
}

function key(overrides: Record<string, unknown> = {}) {
  return {
    type: 'keydown',
    key: 'x',
    keyCode: 229,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...overrides,
  };
}

function harness({ emitThrows = false } = {}) {
  const source = readFileSync(new URL('../src/web/public/terminal-keycode229-recovery.js', import.meta.url), 'utf8');
  const exposed: Record<string, any> = {};
  vm.runInNewContext(source, { window: exposed, globalThis: exposed }, { filename: 'terminal-keycode229-recovery.js' });

  const textarea = makeTextarea();
  const emitted: string[] = [];
  const microtasks: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let now = 1_000;
  const controller = exposed.CodemanKeyCode229Recovery.create({
    textarea,
    emitRecovered: (data: string) => {
      if (emitThrows) throw new Error('recovery callback failed');
      emitted.push(data);
    },
    queueMicrotask: (callback: () => void) => microtasks.push(callback),
    setTimer: (callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id: number) => timers.delete(id),
    now: () => now,
  });

  return {
    controller,
    emitted,
    textarea,
    advance(ms: number) {
      now += ms;
    },
    flushMicrotasks() {
      while (microtasks.length) microtasks.shift()!();
    },
    flushTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pendingTimers: () => timers.size,
  };
}

describe('keyCode 229 terminal input recovery', () => {
  it('recovers an explicit printable key and Enter after xterm gets the first opportunity', () => {
    const h = harness();

    h.controller.handleKeyEvent(key());
    expect(h.emitted).toEqual([]);
    h.flushMicrotasks();
    expect(h.emitted).toEqual([]);
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);

    h.controller.handleKeyEvent(key({ key: 'Enter' }));
    h.flushMicrotasks();
    h.flushTimers();
    expect(h.emitted).toEqual(['x', '\r']);
  });

  it('lets matching canonical terminal data win before fallback', () => {
    const h = harness();
    h.controller.handleKeyEvent(key());

    expect(h.controller.consumeTerminalData('x')).toBe(false);
    h.flushMicrotasks();
    h.flushTimers();

    expect(h.emitted).toEqual([]);
  });

  it('cancels fallback when the helper textarea receives browser input or composition', () => {
    const input = harness();
    input.controller.handleKeyEvent(key());
    input.textarea.fire('input', { data: 'x' });
    input.flushMicrotasks();
    input.flushTimers();
    expect(input.emitted).toEqual([]);

    const composition = harness();
    composition.controller.handleKeyEvent(key());
    composition.textarea.fire('compositionstart');
    composition.flushMicrotasks();
    composition.flushTimers();
    expect(composition.emitted).toEqual([]);
  });

  it('suppresses one delayed matching canonical value from the recovered key token', () => {
    const h = harness();
    h.controller.handleKeyEvent(key());
    h.flushMicrotasks();
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);

    h.textarea.fire('beforeinput', { data: 'x' });
    h.flushMicrotasks();
    expect(h.controller.consumeTerminalData('x')).toBe(true);
    expect(h.controller.consumeTerminalData('x')).toBe(false);
  });

  it('does not suppress an unattributed same byte after recovery', () => {
    const h = harness();
    h.controller.handleKeyEvent(key());
    h.flushMicrotasks();
    h.flushTimers();

    expect(h.controller.consumeTerminalData('x')).toBe(false);
  });

  it('does not let an immediate ordinary same-character key cancel pending recovery', () => {
    const h = harness();
    h.controller.handleKeyEvent(key());
    h.controller.handleKeyEvent(key({ keyCode: 88 }));

    expect(h.controller.consumeTerminalData('x')).toBe(false);
    h.flushMicrotasks();
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);
  });

  it('resolves overlapping eligible candidates independently of the latest keydown', () => {
    const h = harness();
    h.controller.handleKeyEvent(key({ key: 'x' }));
    h.controller.handleKeyEvent(key({ key: 'y' }));

    expect(h.controller.consumeTerminalData('x')).toBe(false);
    h.flushMicrotasks();
    h.flushTimers();
    expect(h.emitted).toEqual(['y']);
  });

  it('suppresses a claimed recovery even after a newer ordinary keydown', () => {
    const h = harness();
    h.controller.handleKeyEvent(key({ key: 'x' }));
    h.flushMicrotasks();
    h.flushTimers();
    h.textarea.fire('beforeinput', { data: 'x' });

    h.controller.handleKeyEvent(key({ key: 'y', keyCode: 89 }));
    expect(h.controller.consumeTerminalData('x')).toBe(true);
  });

  it('fails open when the recovery callback throws', () => {
    const h = harness({ emitThrows: true });
    h.controller.handleKeyEvent(key());
    h.flushMicrotasks();
    h.flushTimers();
    h.textarea.fire('beforeinput', { data: 'x' });

    expect(h.controller.consumeTerminalData('x')).toBe(false);
    expect(h.emitted).toEqual([]);
  });

  it('keeps rapid repeated 229 keys and an ordinary same-character key distinct', () => {
    const h = harness();
    h.controller.handleKeyEvent(key());
    h.flushMicrotasks();
    h.flushTimers();

    h.controller.handleKeyEvent(key());
    h.textarea.fire('input', { data: 'x' });
    expect(h.controller.consumeTerminalData('x')).toBe(false);
    h.flushMicrotasks();
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);

    h.controller.handleKeyEvent(key({ keyCode: 88 }));
    h.textarea.fire('input', { data: 'x' });
    expect(h.controller.consumeTerminalData('x')).toBe(false);
  });

  it('never recovers an ordinary keydown that xterm already handles', () => {
    const h = harness();
    h.controller.handleKeyEvent(key({ keyCode: 88 }));
    h.flushMicrotasks();
    h.flushTimers();

    expect(h.emitted).toEqual([]);
  });

  it('does not recover real composition, unidentified keys, modifiers, or keyup', () => {
    const h = harness();
    for (const event of [
      key({ isComposing: true }),
      key({ key: 'Process' }),
      key({ key: 'Unidentified' }),
      key({ key: 'Dead' }),
      key({ ctrlKey: true }),
      key({ altKey: true }),
      key({ metaKey: true }),
      key({ getModifierState: (name: string) => name === 'AltGraph' }),
      key({ type: 'keyup' }),
      key({ key: 'ArrowLeft' }),
    ]) {
      h.controller.handleKeyEvent(event);
    }
    h.flushMicrotasks();
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });

  it('expires deduplication and destroys listeners and scheduled work', () => {
    const h = harness();
    expect(h.textarea.listenerCount()).toBeGreaterThan(0);
    h.controller.handleKeyEvent(key());
    h.flushMicrotasks();
    h.flushTimers();
    h.advance(500);
    h.textarea.fire('input', { data: 'x' });
    expect(h.controller.consumeTerminalData('x')).toBe(false);

    h.controller.handleKeyEvent(key({ key: 'y' }));
    h.flushMicrotasks();
    expect(h.pendingTimers()).toBe(1);
    h.controller.destroy();
    expect(h.pendingTimers()).toBe(0);
    expect(h.textarea.listenerCount()).toBe(0);
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);
  });
});
