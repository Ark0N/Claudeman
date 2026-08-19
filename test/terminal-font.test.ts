import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadFontHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTerminalFont: {
        DEFAULT_STACK: string;
        resolve: (custom?: unknown) => string;
      };
    }
  ).CodemanTerminalFont;
}

const font = loadFontHelper();

describe('CodemanTerminalFont', () => {
  it('returns the default stack for empty or missing input', () => {
    expect(font.resolve(undefined)).toBe(font.DEFAULT_STACK);
    expect(font.resolve('')).toBe(font.DEFAULT_STACK);
    expect(font.resolve('   ')).toBe(font.DEFAULT_STACK);
    expect(font.resolve(42)).toBe(font.DEFAULT_STACK);
  });

  it('keeps the symbols fallback ahead of monospace in the default stack', () => {
    const symbolsAt = font.DEFAULT_STACK.indexOf('"Symbols Nerd Font Mono"');
    const monoAt = font.DEFAULT_STACK.lastIndexOf('monospace');
    expect(symbolsAt).toBeGreaterThan(-1);
    expect(monoAt).toBeGreaterThan(symbolsAt);
  });

  it('prepends a custom family and preserves the full default stack', () => {
    expect(font.resolve('Menlo')).toBe(`Menlo, ${font.DEFAULT_STACK}`);
  });

  it('quotes names that need quoting for CSS', () => {
    expect(font.resolve('JetBrainsMono Nerd Font')).toBe(`"JetBrainsMono Nerd Font", ${font.DEFAULT_STACK}`);
  });

  it('normalizes already-quoted input instead of double-quoting', () => {
    expect(font.resolve('"JetBrainsMono Nerd Font"')).toBe(`"JetBrainsMono Nerd Font", ${font.DEFAULT_STACK}`);
    expect(font.resolve("'Iosevka Term'")).toBe(`"Iosevka Term", ${font.DEFAULT_STACK}`);
  });

  it('accepts a comma-separated list', () => {
    expect(font.resolve('Iosevka, MesloLGS NF')).toBe(`Iosevka, "MesloLGS NF", ${font.DEFAULT_STACK}`);
  });

  it('drops generic families so they cannot shadow the symbols fallback', () => {
    expect(font.resolve('monospace')).toBe(font.DEFAULT_STACK);
    expect(font.resolve('Hack, monospace')).toBe(`Hack, ${font.DEFAULT_STACK}`);
  });
});
