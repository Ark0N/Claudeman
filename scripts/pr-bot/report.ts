/**
 * @fileoverview Pure report handling: parse the reviewer's JSON (leniently, it is
 * model output), render the Telegram summary (HTML, under the 4096-char cap), the
 * status list, the inline keyboard, and the backlog order. Unit-tested.
 */
import type { CiState, PrSummary } from './github.js';
import { VERDICTS, type Verdict } from './review-task.js';

export type Severity = 'blocker' | 'major' | 'minor' | 'nit';

export interface Finding {
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  detail: string;
  invariant?: string;
}

export interface CheckResult {
  name: string;
  command?: string;
  result: 'pass' | 'fail' | 'skipped';
  notes?: string;
}

export interface ReviewReport {
  verdict: Verdict;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  changes: string[];
  findings: Finding[];
  checks: CheckResult[];
  scope: 'focused' | 'mixed';
  risk: string;
  recommendation: string;
  draftComment: string;
  assumptions: string[];
}

export const TELEGRAM_MAX = 4096;
/** Leave room for HTML tags the counter cannot see and for the keyboard-less fallback. */
const SUMMARY_BUDGET = 3600;

const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];
const SEVERITY_ICON: Record<Severity, string> = { blocker: '🔴', major: '🟠', minor: '🟡', nit: '⚪' };
const VERDICT_LABEL: Record<Verdict, string> = {
  merge: '✅ MERGE',
  'merge-with-fixes': '🟢 MERGE WITH FIXES',
  'request-changes': '🟠 REQUEST CHANGES',
  close: '❌ CLOSE',
  'needs-discussion': '💬 NEEDS DISCUSSION',
};
const CI_LABEL: Record<CiState, string> = {
  passed: 'CI ✅',
  failed: 'CI ❌',
  pending: 'CI ⏳',
  'awaiting-approval': 'CI ⏸ needs your approval',
  none: 'CI none',
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/** Extract the first JSON object from text that may carry fences or prose around it. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalize model output into a ReviewReport. Returns null only when there is no verdict at all. */
export function parseReport(raw: unknown): ReviewReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const verdictRaw = str(o.verdict).trim().toLowerCase().replace(/[_ ]/g, '-');
  const verdict = (VERDICTS as readonly string[]).includes(verdictRaw) ? (verdictRaw as Verdict) : null;
  if (!verdict) return null;
  const confidenceRaw = str(o.confidence).trim().toLowerCase();
  const confidence = confidenceRaw === 'high' || confidenceRaw === 'low' ? confidenceRaw : 'medium';

  const findings: Finding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings) {
      if (!f || typeof f !== 'object') continue;
      const fo = f as Record<string, unknown>;
      const sevRaw = str(fo.severity).trim().toLowerCase();
      const severity = (SEVERITY_ORDER as string[]).includes(sevRaw) ? (sevRaw as Severity) : 'minor';
      const title = str(fo.title).trim();
      if (!title) continue;
      const line = typeof fo.line === 'number' && Number.isFinite(fo.line) ? Math.trunc(fo.line) : undefined;
      findings.push({
        severity,
        title,
        file: str(fo.file).trim() || undefined,
        line,
        detail: str(fo.detail).trim(),
        invariant: str(fo.invariant).trim() || undefined,
      });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const checks: CheckResult[] = [];
  if (Array.isArray(o.checks)) {
    for (const c of o.checks) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      const name = str(co.name).trim();
      if (!name) continue;
      const resRaw = str(co.result).trim().toLowerCase();
      const result = resRaw === 'pass' || resRaw === 'fail' ? resRaw : 'skipped';
      checks.push({
        name,
        command: str(co.command).trim() || undefined,
        result,
        notes: str(co.notes).trim() || undefined,
      });
    }
  }

  return {
    verdict,
    confidence,
    summary: str(o.summary).trim(),
    changes: strList(o.changes),
    findings,
    checks,
    scope: str(o.scope).trim().toLowerCase() === 'mixed' ? 'mixed' : 'focused',
    risk: str(o.risk).trim(),
    recommendation: str(o.recommendation).trim(),
    draftComment: str(o.draftComment).trim(),
    assumptions: strList(o.assumptions),
  };
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

function findingLine(f: Finding): string {
  const where = f.file ? ` <code>${escapeHtml(f.file)}${f.line ? `:${f.line}` : ''}</code>` : '';
  return `${SEVERITY_ICON[f.severity]} ${escapeHtml(f.title)}${where}`;
}

function checksLine(checks: CheckResult[]): string {
  if (!checks.length) return '';
  const parts = checks.map((c) => {
    const icon = c.result === 'pass' ? '✅' : c.result === 'fail' ? '❌' : '⏭';
    return `${escapeHtml(c.name)} ${icon}`;
  });
  return `<b>Checks:</b> ${parts.join(' · ')}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export interface SummaryMeta {
  ci: CiState;
  /** Time the review took, for the footer. */
  durationMin?: number;
}

/** The message the maintainer reads on the phone. HTML parse mode. */
export function formatTelegramSummary(pr: PrSummary, report: ReviewReport, meta: SummaryMeta): string {
  const header =
    `🔍 <b>PR #${pr.number}</b> · ${escapeHtml(truncate(pr.title, 120))}\n` +
    `<i>by ${escapeHtml(pr.author)} · +${pr.additions}/−${pr.deletions} · ${pr.changedFiles} files · ${CI_LABEL[meta.ci]} · ${
      pr.mergeable === 'CONFLICTING'
        ? 'conflicts ⚠️'
        : pr.mergeable === 'MERGEABLE'
          ? 'mergeable'
          : 'mergeability unknown'
    }${pr.isDraft ? ' · draft' : ''}</i>\n` +
    `<a href="${escapeHtml(pr.url)}">${escapeHtml(pr.url)}</a>\n`;
  const verdict = `\n<b>${VERDICT_LABEL[report.verdict]}</b> <i>(confidence ${report.confidence}${report.scope === 'mixed' ? ', mixed scope' : ''})</i>\n`;
  const summary = report.summary ? `\n${escapeHtml(report.summary)}\n` : '';

  const counts = countBySeverity(report.findings);
  const countStr = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}${counts[s] === 1 ? '' : 's'}`)
    .join(', ');
  const findingsHeader = report.findings.length ? `\n<b>Findings</b> (${countStr}):\n` : '\n<b>Findings:</b> none\n';

  const checks = checksLine(report.checks);
  const recommendation = report.recommendation ? `\n<b>Recommendation:</b> ${escapeHtml(report.recommendation)}\n` : '';
  const footer = meta.durationMin !== undefined ? `\n<i>review took ${meta.durationMin} min</i>` : '';

  const fixed = header + verdict + summary + findingsHeader;
  const tail = (checks ? `\n${checks}\n` : '') + recommendation + footer;
  let budget = SUMMARY_BUDGET - fixed.length - tail.length;

  const lines: string[] = [];
  let shown = 0;
  for (const f of report.findings) {
    const line = findingLine(f) + '\n';
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
    shown++;
  }
  const hidden = report.findings.length - shown;
  const more = hidden > 0 ? `<i>… ${hidden} more in the full report</i>\n` : '';
  return fixed + lines.join('') + more + tail;
}

export function formatReviewFailure(
  pr: Pick<PrSummary, 'number' | 'title' | 'author' | 'url'>,
  reason: string
): string {
  return (
    `⚠️ <b>PR #${pr.number}</b> · ${escapeHtml(truncate(pr.title, 120))}\n` +
    `<i>by ${escapeHtml(pr.author)}</i>\n<a href="${escapeHtml(pr.url)}">${escapeHtml(pr.url)}</a>\n\n` +
    `The review did not complete: ${escapeHtml(truncate(reason, 1500))}\n\n` +
    `Use /review ${pr.number} to try again.`
  );
}

/** Split on line boundaries so no chunk exceeds Telegram's cap. */
export function splitTelegramMessage(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let piece = line;
    while (piece.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
    const candidate = current ? `${current}\n${piece}` : piece;
    if (candidate.length > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Callback data is capped at 64 bytes by Telegram; these stay far under it. */
export function buildReportKeyboard(prNumber: number, opts: { ci: CiState; hasDraft: boolean }): InlineButton[][] {
  const rows: InlineButton[][] = [
    [
      { text: '📄 Full report', callback_data: `report:${prNumber}` },
      ...(opts.hasDraft ? [{ text: '💬 Draft comment', callback_data: `draft:${prNumber}` }] : []),
      { text: '🔁 Re-review', callback_data: `review:${prNumber}` },
    ],
    [
      { text: '✅ Merge', callback_data: `merge:${prNumber}` },
      ...(opts.hasDraft ? [{ text: '📮 Post comment', callback_data: `post:${prNumber}` }] : []),
      { text: '🗑 Close', callback_data: `close:${prNumber}` },
    ],
  ];
  if (opts.ci === 'awaiting-approval')
    rows.push([{ text: '▶️ Approve CI run', callback_data: `approveci:${prNumber}` }]);
  return rows;
}

export function confirmKeyboard(action: string, prNumber: number, nonce: string): InlineButton[][] {
  return [
    [
      { text: `Yes, ${action} #${prNumber}`, callback_data: `confirm:${action}:${prNumber}:${nonce}` },
      { text: 'Cancel', callback_data: `cancel:${action}:${prNumber}:${nonce}` },
    ],
  ];
}

export interface StatusRow {
  number: number;
  title: string;
  author: string;
  verdict?: Verdict;
  status: string;
  ci?: CiState;
  mergeable: PrSummary['mergeable'];
  isDraft: boolean;
}

export function formatStatusList(rows: StatusRow[], paused: boolean): string {
  if (!rows.length) return 'No open pull requests.';
  const lines = rows.map((r) => {
    const v = r.verdict
      ? VERDICT_LABEL[r.verdict].split(' ')[0]
      : r.status === 'reviewing'
        ? '⏳'
        : r.status === 'queued'
          ? '🕓'
          : '·';
    const flags = [
      r.ci ? CI_LABEL[r.ci].replace('CI ', '') : '',
      r.mergeable === 'CONFLICTING' ? 'conflicts' : '',
      r.isDraft ? 'draft' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `${v} <b>#${r.number}</b> ${escapeHtml(truncate(r.title, 60))} <i>(${escapeHtml(r.author)}${flags ? `; ${flags}` : ''})</i>`;
  });
  return `${paused ? '⏸ auto-review paused\n' : ''}<b>Open PRs (${rows.length})</b>\n${lines.join('\n')}`;
}

/**
 * Backlog order for a fresh sweep: the ones you can act on first (mergeable, small),
 * conflicting and huge ones last. Ties keep the newer PR first.
 */
export function orderBacklog<T extends Pick<PrSummary, 'number' | 'mergeable' | 'additions' | 'deletions'>>(
  prs: T[]
): T[] {
  const size = (p: T) => p.additions + p.deletions;
  return [...prs].sort((a, b) => {
    const ca = a.mergeable === 'CONFLICTING' ? 1 : 0;
    const cb = b.mergeable === 'CONFLICTING' ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const sa = size(a);
    const sb = size(b);
    if (sa !== sb) return sa - sb;
    return b.number - a.number;
  });
}

export function verdictLabel(v: Verdict): string {
  return VERDICT_LABEL[v];
}
