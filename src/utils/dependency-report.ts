/**
 * @fileoverview Renders ToolResult[] from the dependency checker into a
 * human-readable grouped table or JSON, and computes the process exit code.
 * Plain text by default (no color) so output is stable and snapshot-friendly;
 * the CLI layer passes a `ReportStyle` to paint it (see `cli.ts`, `doctor`).
 *
 * Column widths are measured, not hardcoded: "Antigravity CLI" is 15 characters
 * and the old `padEnd(14)` pushed its whole row one column right.
 *
 * @module utils/dependency-report
 */

import { columnWidths, padStyled } from '../cli-style.js';
import type { ProbeEnvironment, ToolCategory } from '../config/dependency-registry.js';
import type { ToolResult, ToolStatus } from './dependency-checker.js';

const CATEGORY_ORDER: ToolCategory[] = ['core', 'office', 'other'];

/**
 * Paint hooks for the CLI layer. Every hook is identity by default, so this
 * module never decides anything about color and its output stays byte-stable
 * for tests.
 */
export interface ReportStyle {
  title(text: string): string;
  heading(text: string): string;
  glyph(result: ToolResult, glyph: string): string;
  label(text: string): string;
  status(result: ToolResult, text: string): string;
  path(text: string): string;
  meta(text: string): string;
  summary(text: string): string;
}

const identity = (text: string): string => text;

const PLAIN_STYLE: ReportStyle = {
  title: identity,
  heading: identity,
  glyph: (_result, glyph) => glyph,
  label: identity,
  status: (_result, text) => text,
  path: identity,
  meta: identity,
  summary: identity,
};

function glyph(r: ToolResult): string {
  if (r.status === 'ok') return '✓';
  if (r.status === 'skipped') return '○';
  return r.required ? '✗' : '○';
}

function statusText(r: ToolResult): string {
  if (r.status === 'ok') return r.version ?? 'installed';
  if (r.status === 'outdated') return `${r.version ?? '?'} (below minimum)`;
  if (r.status === 'skipped') return 'n/a';
  if (r.status === 'error') return 'version error';
  return 'not found';
}

export function computeExitCode(results: ToolResult[]): number {
  const failed = results.some(
    (r) => r.required && (r.status === 'missing' || r.status === 'outdated' || r.status === 'error')
  );
  return failed ? 1 : 0;
}

export function renderTable(
  results: ToolResult[],
  environment: ProbeEnvironment,
  style: ReportStyle = PLAIN_STYLE
): string {
  // Widths are taken across ALL categories so the groups line up with each other.
  const [labelWidth, statusWidth] = columnWidths(results.map((r) => [r.label, statusText(r)]));
  const lines: string[] = [style.title(`Codeman dependency check — ${environment}`), ''];
  for (const category of CATEGORY_ORDER) {
    const rows = results.filter((r) => r.category === category);
    if (rows.length === 0) continue;
    lines.push(style.heading(category.toUpperCase()));
    for (const r of rows) {
      const label = padStyled(r.label, labelWidth ?? 0, style.label);
      const status = padStyled(statusText(r), statusWidth ?? 0, (text) => style.status(r, text));
      const detail = r.path ? `  ${style.path(r.path)}` : '';
      lines.push(`  ${style.glyph(r, glyph(r))} ${label} ${status}${detail}`.trimEnd());
      if (r.usedBy.length) lines.push(style.meta(`        used by: ${r.usedBy.join(', ')}`));
      if (r.installHint) lines.push(style.meta(`        install: ${r.installHint}`));
    }
    lines.push('');
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const requiredMissing = results.filter((r) => r.required && r.status !== 'ok' && r.status !== 'skipped').length;
  const optionalMissing = results.filter((r) => !r.required && r.status === 'missing').length;
  lines.push(
    style.summary(`Summary: ${ok} ok · ${requiredMissing} required missing · ${optionalMissing} optional missing`)
  );
  return lines.join('\n');
}

export interface DependencyReportJson {
  platform: { environment: ProbeEnvironment };
  summary: { ok: number; requiredMissing: number; optionalMissing: number; exitCode: number };
  tools: ToolResult[];
}

export function renderJson(results: ToolResult[], environment: ProbeEnvironment): DependencyReportJson {
  const byStatus = (s: ToolStatus) => results.filter((r) => r.status === s).length;
  return {
    platform: { environment },
    summary: {
      ok: byStatus('ok'),
      requiredMissing: results.filter((r) => r.required && r.status !== 'ok' && r.status !== 'skipped').length,
      optionalMissing: results.filter((r) => !r.required && r.status === 'missing').length,
      exitCode: computeExitCode(results),
    },
    tools: results,
  };
}
