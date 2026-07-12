import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync('src/web/public/app.js', 'utf8');
const terminalUiSource = readFileSync('src/web/public/terminal-ui.js', 'utf8');
const helpHtml = readFileSync('src/web/public/index.html', 'utf8');
const readme = readFileSync('README.md', 'utf8');

describe('keyboard shortcuts', () => {
  it('uses physical Option+number keys so macOS special characters do not break tab switching', () => {
    expect(appSource).toContain('e.code ||');
    expect(appSource).toContain('Digit([1-9])');
    expect(appSource).toContain('parseInt(digitMatch[1], 10) - 1');
  });

  it('provides Option+bracket shortcuts for previous and next session', () => {
    expect(appSource).toContain("e.code === 'BracketLeft'");
    expect(appSource).toContain("e.code === 'BracketRight'");
    expect(appSource).toContain('this.prevSession()');
    expect(appSource).toContain('this.nextSession()');
  });

  it('suppresses xterm PTY injection for the same physical Alt nav codes (no ESC leak)', () => {
    // terminal-ui.js must gate its xterm pass-through on the SAME physical e.code set the
    // app.js handler consumes; otherwise Alt+[ / Alt+] (and Option+digit on remapped macOS
    // layouts) switch tabs AND inject ESC<char> into the focused terminal. Keep in sync.
    expect(terminalUiSource).toContain('/^(Digit[1-9]|BracketLeft|BracketRight|KeyK)$/.test(ev.code');
  });

  it('documents the Alt/Option shortcuts in help and README', () => {
    expect(helpHtml).toContain('<kbd>Alt/Option</kbd>+<kbd>[</kbd>');
    expect(helpHtml).toContain('<kbd>Alt/Option</kbd>+<kbd>]</kbd>');
    expect(helpHtml).toContain('<kbd>Alt/Option</kbd>+<kbd>1-9</kbd>');
    expect(readme).toContain('`Alt/Option+[` / `Alt/Option+]`');
    expect(readme).toContain('`Alt/Option+1`-`Alt/Option+9`');
  });

  it('documents the Command-K open-session palette in help and README', () => {
    expect(appSource).toContain('this.openCommandPalette()');
    expect(helpHtml).toContain('<kbd>Ctrl/Cmd/Option</kbd>+<kbd>K</kbd>');
    expect(readme).toMatch(/\| `Ctrl\/Cmd\/Option\+K`\s+\| Find open session or start a new one\s+\|/);
  });

  it('gates the palette chord in the xterm custom key handler (no 0x0b kill-line into the PTY)', () => {
    // The document-level capture handler opens the palette, but preventDefault()
    // does NOT stop xterm from evaluating Ctrl+K into 0x0b and writing it to the
    // live PTY — terminal-ui.js must return false for the palette chord.
    expect(terminalUiSource).toMatch(/ev\.type === 'keydown' && this\.shouldOpenCommandPaletteFromShortcut\?\.\(ev\)/);
  });

  it('dispatches document shortcuts through the shortcut registry (rebind/disable aware)', () => {
    // The legacy hardcoded SHORTCUTS table must stay gone — dispatch goes through
    // getShortcutRegistry() + matchesShortcutEvent() so overrides and per-shortcut
    // disables (App Settings → Shortcuts) actually take effect.
    expect(appSource).not.toContain('const SHORTCUTS = [');
    expect(appSource).toContain('const SHORTCUT_ACTIONS = {');
    expect(appSource).toContain('for (const shortcut of this.getShortcutRegistry())');
    expect(appSource).toContain('if (this.matchesShortcutEvent(e, shortcut))');
    expect(appSource).toContain('if (shortcut.disabled || !shortcut.action) continue;');
  });
});
