import { describe, it, expect } from 'vitest';
import { renderTable, renderJson, computeExitCode } from '../src/utils/dependency-report.js';
import type { ToolResult } from '../src/utils/dependency-checker.js';

const results: ToolResult[] = [
  {
    id: 'node',
    label: 'Node.js',
    category: 'core',
    required: true,
    usedBy: [],
    status: 'ok',
    version: '22.22.1',
    path: '/n',
  },
  {
    id: 'tmux',
    label: 'tmux',
    category: 'core',
    required: true,
    usedBy: [],
    status: 'missing',
    installHint: 'sudo apt install tmux',
  },
  {
    id: 'libreoffice',
    label: 'LibreOffice',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'thumbnails'],
    status: 'missing',
  },
  {
    id: 'msoffice',
    label: 'MS Office',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'thumbnails'],
    status: 'skipped',
    reason: 'not applicable on linux',
  },
];

describe('computeExitCode', () => {
  it('non-zero when a required tool is missing/outdated/error', () => {
    expect(computeExitCode(results)).toBe(1);
  });
  it('zero when only optional tools are missing', () => {
    const ok = results.filter((r) => r.id !== 'tmux');
    expect(computeExitCode(ok)).toBe(0);
  });
});

describe('renderTable', () => {
  it('groups by category and shows status, version, and install hints', () => {
    const out = renderTable(results, 'linux');
    expect(out).toContain('CORE');
    expect(out).toContain('Node.js');
    expect(out).toContain('22.22.1');
    expect(out).toContain('OFFICE');
    expect(out).toContain('document preview');
    expect(out).toContain('sudo apt install tmux');
  });

  it('stays color-free unless the caller passes a style', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderTable(results, 'linux')).not.toMatch(/\x1b\[/);
  });

  it('aligns the status column past a label wider than the old padEnd(14)', () => {
    const wide: ToolResult[] = [
      ...results,
      { id: 'agy', label: 'Antigravity CLI', category: 'core', required: false, usedBy: [], status: 'missing' },
    ];
    const lines = renderTable(wide, 'linux').split('\n');
    const nodeLine = lines.find((l) => l.includes('Node.js'))!;
    const agyLine = lines.find((l) => l.includes('Antigravity CLI'))!;
    expect(nodeLine.indexOf('22.22.1')).toBe(agyLine.indexOf('not found'));
  });

  it('applies the caller-supplied paint hooks without shifting the columns', () => {
    const plain = renderTable(results, 'linux').split('\n');
    const styled = renderTable(results, 'linux', {
      title: (t) => `T{${t}}`,
      heading: (t) => `H{${t}}`,
      glyph: (_r, g) => `G{${g}}`,
      label: (t) => `L{${t}}`,
      status: (_r, t) => `S{${t}}`,
      path: (t) => `P{${t}}`,
      meta: (t) => `M{${t}}`,
      summary: (t) => `Z{${t}}`,
    }).split('\n');
    expect(styled[0]).toBe(`T{${plain[0]}}`);
    expect(styled.find((l) => l.includes('CORE'))).toBe('H{CORE}');
    const nodeLine = styled.find((l) => l.includes('Node.js'))!;
    expect(nodeLine).toContain('G{✓}');
    expect(nodeLine).toContain('L{Node.js}');
    expect(nodeLine).toContain('S{22.22.1}');
    expect(nodeLine).toContain('P{/n}');
    expect(styled.some((l) => l.startsWith('M{        used by:'))).toBe(true);
    expect(styled[styled.length - 1]).toBe(`Z{${plain[plain.length - 1]}}`);
    // Padding lives outside the paint, so a row with no path detail ends at its
    // status text rather than trailing invisible spaces inside a color run.
    expect(styled.find((l) => l.includes('S{n/a}'))!.endsWith('S{n/a}')).toBe(true);
  });
});

describe('renderJson', () => {
  it('includes environment, summary, and per-tool data', () => {
    const json = renderJson(results, 'linux');
    expect(json.platform.environment).toBe('linux');
    expect(json.summary.exitCode).toBe(1);
    expect(json.summary.ok).toBe(1);
    expect(json.tools).toHaveLength(4);
  });
});
