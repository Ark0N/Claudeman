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
    expect(terminalUiSource).toContain('/^(Digit[1-9]|BracketLeft|BracketRight)$/.test(ev.code');
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
    expect(helpHtml).toContain('<kbd>Ctrl/Cmd</kbd>+<kbd>K</kbd>');
    expect(readme).toMatch(/\| `Ctrl\/Cmd\+K`\s+\| Find open session or start a new one\s+\|/);
  });
});
