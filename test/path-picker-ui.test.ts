/**
 * @fileoverview Fast VM/static regressions for the shared filesystem picker and
 * extended mobile keyboard actions. No browser or real server required.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const keyboardSource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');
const sessionSource = readFileSync(resolve('src/web/public/session-ui.js'), 'utf8');
const indexSource = readFileSync(resolve('src/web/public/index.html'), 'utf8');

function loadTerminalMixin() {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> };
  const cjkClear = vi.fn();
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    CjkInput: { clear: cjkClear },
    _crashDiag: { log: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(terminalSource, context, { filename: 'terminal-ui.js' });
  return { mixin: FakeCodemanApp.prototype, cjkClear };
}

const terminalHarness = loadTerminalMixin();

function loadKeyboardModule() {
  const app = {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', { workingDir: '/mnt/d/AI' }]]),
    terminal: { focus: vi.fn() },
    clearTerminalInput: vi.fn(),
    insertTerminalText: vi.fn(),
    sendInput: vi.fn(),
  };
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => false },
    URLSearchParams,
    fetch: vi.fn(),
    document: {},
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(
    `${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar; globalThis.__picker = PathPicker;`,
    context
  );
  return {
    app,
    bar: (context as unknown as { __bar: { handleAction(action: string): void } }).__bar,
    picker: (context as unknown as { __picker: { open: ReturnType<typeof vi.fn> } }).__picker,
  };
}

describe('mobile filesystem picker actions', () => {
  it('keeps clear-input separate from the destructive /clear command', () => {
    const { app, bar } = loadKeyboardModule();
    bar.handleAction('clear-input');

    expect(app.clearTerminalInput).toHaveBeenCalledOnce();
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(keyboardSource).toContain('data-action="clear-input"');
    expect(keyboardSource).toContain('data-action="clear" title="/clear"');
  });

  it('opens at the active working directory and inserts the selected path without Enter', () => {
    const { app, bar, picker } = loadKeyboardModule();
    picker.open = vi.fn();

    bar.handleAction('pick-path');

    expect(picker.open).toHaveBeenCalledOnce();
    const options = picker.open.mock.calls[0][0];
    expect(options).toMatchObject({
      sessionId: 'session-1',
      initialPath: '/mnt/d/AI',
      directoriesOnly: false,
    });
    options.onSelect('/mnt/d/AI/project/file.ts');
    expect(app.insertTerminalText).toHaveBeenCalledWith('/mnt/d/AI/project/file.ts');
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('wires Link Existing to the shared folder-only picker', () => {
    expect(indexSource).toContain('onclick="app.openLinkCasePathPicker()"');
    expect(indexSource).toContain('id="linkCasePath"');
    expect(sessionSource).toContain('openLinkCasePathPicker()');
    expect(sessionSource).toContain('directoriesOnly: true');
  });

  it('keeps Choose separate from safe inline file preview', () => {
    expect(keyboardSource).toContain('openPreview(entry)');
    expect(keyboardSource).toContain('/api/filesystem/preview?');
    expect(keyboardSource).toContain("entry.previewKind === 'image'");
    expect(keyboardSource).toContain("entry.previewKind === 'text'");
    expect(keyboardSource).toContain("choose.textContent = 'Choose'");
    expect(keyboardSource).toContain('pre.textContent = content');
  });

  it('inserts a selected path into the editable local-echo prompt without sending it', () => {
    const insertText = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _terminalInputController: { insertText },
      terminal: { focus },
    };

    terminalHarness.mixin.insertTerminalText.call(app, '/mnt/d/AI/project');

    expect(insertText).toHaveBeenCalledWith('/mnt/d/AI/project');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('clears pending and already-flushed prompt text without invoking /clear', () => {
    const clearInput = vi.fn();
    const showToast = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _terminalInputController: { clearInput },
      showToast,
      terminal: { focus },
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(clearInput).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith('Input cleared', 'success');
    expect(focus).toHaveBeenCalledOnce();
    expect(terminalHarness.cjkClear).toHaveBeenCalled();
  });

  it('delegates non-local prompt clearing to the controller', () => {
    const clearInput = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _terminalInputController: { clearInput },
      showToast: vi.fn(),
      terminal: { focus: vi.fn() },
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(clearInput).toHaveBeenCalledOnce();
  });

  it('routes multiline shell paste directly with xterm bracket framing', async () => {
    const handleTerminalData = vi.fn();
    const sendControl = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'shell' }]]),
      terminal: {
        modes: {
          bracketedPasteMode: true,
        },
      },
      _terminalInputController: {
        handleTerminalData,
        sendControl,
      },
      _prepareTerminalPaste: terminalHarness.mixin._prepareTerminalPaste,
    };

    await terminalHarness.mixin.sendPastedText.call(app, 'first\n\nReferences\nmore', { submit: true });

    expect(handleTerminalData).toHaveBeenCalledWith('\x1b[200~first\r\rReferences\rmore\x1b[201~', 'shell-paste');
    expect(sendControl).toHaveBeenCalledWith('\r');
  });
});
