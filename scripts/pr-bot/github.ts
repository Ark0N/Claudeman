/**
 * @fileoverview GitHub access for the PR bot, entirely through the `gh` CLI.
 *
 * `gh` carries the maintainer's own login, so the bot needs no token of its own and
 * every write (merge, close, comment, CI approval) lands under that account. That is
 * why every write here is only ever reached from an explicit, confirmed Telegram
 * command (see bot.ts); nothing in this file is called on a timer.
 *
 * `classifyCi` and `latestRunPerWorkflow` are pure and unit-tested.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  url: string;
  isCrossRepository: boolean;
  labels: string[];
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrDetail extends PrSummary {
  body: string;
  files: PrFile[];
  authorAssociation: string;
  linkedIssues: { number: number; title: string }[];
  commitCount: number;
  commentCount: number;
  reviewDecision: string;
  headRepo: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export type CiState = 'passed' | 'failed' | 'pending' | 'awaiting-approval' | 'none';

export interface CiStatus {
  state: CiState;
  runs: WorkflowRun[];
}

const PR_LIST_FIELDS =
  'number,title,author,headRefOid,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,additions,deletions,changedFiles,updatedAt,url,isCrossRepository,labels';

export async function gh(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  const child = execFileAsync('gh', args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 60_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  if (opts.input !== undefined && child.child.stdin) {
    child.child.stdin.end(opts.input);
  }
  const { stdout } = await child;
  return stdout;
}

interface RawPr {
  number: number;
  title: string;
  author?: { login?: string };
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  url: string;
  isCrossRepository: boolean;
  labels?: { name: string }[];
}

function toSummary(raw: RawPr): PrSummary {
  const mergeable = raw.mergeable === 'MERGEABLE' || raw.mergeable === 'CONFLICTING' ? raw.mergeable : 'UNKNOWN';
  return {
    number: raw.number,
    title: raw.title ?? '',
    author: raw.author?.login ?? 'unknown',
    headSha: raw.headRefOid,
    baseRef: raw.baseRefName,
    headRef: raw.headRefName,
    isDraft: Boolean(raw.isDraft),
    mergeable,
    mergeState: raw.mergeStateStatus ?? 'UNKNOWN',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    updatedAt: raw.updatedAt ?? '',
    url: raw.url,
    isCrossRepository: Boolean(raw.isCrossRepository),
    labels: (raw.labels ?? []).map((l) => l.name),
  };
}

export async function listOpenPrs(repo: string): Promise<PrSummary[]> {
  const out = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_LIST_FIELDS]);
  const raw = JSON.parse(out) as RawPr[];
  return raw.map(toSummary);
}

export async function getPrDetail(repo: string, number: number): Promise<PrDetail> {
  const fields = `${PR_LIST_FIELDS},body,files,commits,comments,reviewDecision,closingIssuesReferences,headRepository,headRepositoryOwner`;
  const out = await gh(['pr', 'view', String(number), '--repo', repo, '--json', fields]);
  const raw = JSON.parse(out) as RawPr & {
    body?: string;
    files?: { path: string; additions: number; deletions: number }[];
    commits?: unknown[];
    comments?: unknown[];
    reviewDecision?: string;
    closingIssuesReferences?: { number: number; title: string }[];
    headRepository?: { name?: string };
    headRepositoryOwner?: { login?: string };
  };
  let authorAssociation = 'NONE';
  try {
    const assoc = await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.author_association']);
    authorAssociation = assoc.trim() || 'NONE';
  } catch {
    // Metadata only; a failed lookup must not fail the review.
  }
  const owner = raw.headRepositoryOwner?.login;
  const name = raw.headRepository?.name;
  return {
    ...toSummary(raw),
    body: raw.body ?? '',
    files: (raw.files ?? []).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    authorAssociation,
    linkedIssues: (raw.closingIssuesReferences ?? []).map((i) => ({ number: i.number, title: i.title })),
    commitCount: raw.commits?.length ?? 0,
    commentCount: raw.comments?.length ?? 0,
    reviewDecision: raw.reviewDecision ?? '',
    headRepo: owner && name ? `${owner}/${name}` : '',
  };
}

/** The API returns newest first; keep only the newest run of each workflow. */
export function latestRunPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const seen = new Set<string>();
  const out: WorkflowRun[] = [];
  for (const run of runs) {
    if (seen.has(run.name)) continue;
    seen.add(run.name);
    out.push(run);
  }
  return out;
}

/**
 * Collapse workflow runs into one word the report can show. `action_required` is
 * the fork-PR case where GitHub waits for a maintainer to approve the run: the PR
 * looks unchecked and stays that way until someone clicks, so it gets its own state.
 */
export function classifyCi(runs: WorkflowRun[]): CiState {
  const latest = latestRunPerWorkflow(runs);
  if (latest.length === 0) return 'none';
  if (latest.some((r) => r.conclusion === 'action_required')) return 'awaiting-approval';
  if (latest.some((r) => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(r.status)))
    return 'pending';
  if (latest.some((r) => ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(r.conclusion ?? '')))
    return 'failed';
  if (latest.every((r) => ['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''))) return 'passed';
  return 'pending';
}

export async function getCiStatus(repo: string, headSha: string): Promise<CiStatus> {
  const out = await gh([
    'api',
    `repos/${repo}/actions/runs?head_sha=${headSha}&event=pull_request&per_page=30`,
    '--jq',
    '[.workflow_runs[] | {id, name, status, conclusion}]',
  ]);
  const runs = JSON.parse(out) as WorkflowRun[];
  return { state: classifyCi(runs), runs: latestRunPerWorkflow(runs) };
}

export async function approveWorkflowRun(repo: string, runId: number): Promise<void> {
  await gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/approve`]);
}

/** Merge commits, matching the repository's history (`Merge pull request #N from ...`). */
export async function mergePr(repo: string, number: number): Promise<string> {
  return gh(['pr', 'merge', String(number), '--repo', repo, '--merge'], { timeoutMs: 120_000 });
}

export async function closePr(repo: string, number: number, comment: string): Promise<string> {
  const args = ['pr', 'close', String(number), '--repo', repo];
  if (comment.trim()) args.push('--comment', comment);
  return gh(args);
}

export async function commentPr(repo: string, number: number, body: string): Promise<string> {
  return gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body });
}

export async function ghAuthOk(): Promise<boolean> {
  try {
    await gh(['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}
