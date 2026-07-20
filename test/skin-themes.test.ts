/**
 * @fileoverview Static and VM regressions for Codeman UI/xterm skin parity.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const indexSource = readFileSync(resolve('src/web/public/index.html'), 'utf8');
const stylesSource = readFileSync(resolve('src/web/public/styles.css'), 'utf8');
const mobileStylesSource = readFileSync(resolve('src/web/public/mobile.css'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');

const LIGHT_SKINS = ['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn'] as const;

function hexRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error(`Expected six-digit hex color, got ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const channels = hexRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function loadTerminalThemes() {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> };
  const document = { documentElement: { dataset: { skin: 'paper-gray' } } };
  const window: Record<string, unknown> = {};
  vm.runInNewContext(terminalSource, { CodemanApp: FakeCodemanApp, document, window }, { filename: 'terminal-ui.js' });
  return {
    mixin: FakeCodemanApp.prototype,
    themes: window.CODEMAN_XTERM_THEMES as Record<string, Record<string, string>>,
    isLight: window.codemanCurrentSkinIsLight as (skin?: string) => boolean,
  };
}

describe('Codeman light skins', () => {
  const terminal = loadTerminalThemes();

  it('keeps the picker, pre-paint allowlist, CSS, and xterm palette in sync', () => {
    for (const skin of LIGHT_SKINS) {
      expect(indexSource).toContain(`value="${skin}"`);
      expect(indexSource).toContain(`'${skin}'`);
      expect(stylesSource).toContain(`html[data-skin="${skin}"]`);
      expect(stylesSource).toMatch(new RegExp(`html\\[data-skin="${skin}"\\] \\{[\\s\\S]*?color-scheme: light;`));
      expect(terminal.themes[skin]).toBeDefined();
      expect(terminal.isLight(skin)).toBe(true);
    }
    expect(terminal.isLight('daylight-blue')).toBe(false);
  });

  it('provides readable dark-on-light terminal foregrounds', () => {
    for (const skin of LIGHT_SKINS) {
      const theme = terminal.themes[skin];
      expect(contrastRatio(theme.background, theme.foreground), skin).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('switches live terminals between light and dark contrast policies', () => {
    const main = { options: {} as Record<string, unknown>, rows: 24, refresh: vi.fn() };
    const teammate = { options: {} as Record<string, unknown>, rows: 12, refresh: vi.fn() };
    const app = {
      terminal: main,
      teammateTerminals: new Map([['agent-1', { terminal: teammate }]]),
    };

    terminal.mixin.applyTerminalSkin.call(app, 'paper-gray');
    expect(main.options.minimumContrastRatio).toBe(4.5);
    expect(teammate.options.minimumContrastRatio).toBe(4.5);
    expect((main.options.theme as Record<string, string>).background).toBe('#f6f8fa');

    terminal.mixin.applyTerminalSkin.call(app, 'daylight-blue');
    expect(main.options.minimumContrastRatio).toBe(1);
    expect(teammate.options.minimumContrastRatio).toBe(1);
    expect((main.options.theme as Record<string, string>).background).toBe('#161b23');
  });

  it('uses skin variables for the pre-paint skeleton and native controls', () => {
    expect(indexSource).toContain('background:var(--term-bg,#161b23)');
    expect(indexSource).toContain('background:var(--glass-bg,rgba(31,38,48,0.85))');
    expect(stylesSource).toContain('color-scheme: light;');
    expect(stylesSource).toContain('background: var(--floating-bg);');
    expect(mobileStylesSource).toContain(':is(.header, .toolbar, .keyboard-accessory-bar)');
    expect(mobileStylesSource).toContain(':is(.case-settings-popover-mobile, .mobile-case-picker-sheet)');
  });
});
