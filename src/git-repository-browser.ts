import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const GIT_METADATA_LIMIT = 2 * 1024 * 1024;
const GIT_DIFF_LIMIT = 2 * 1024 * 1024;
const FILE_PREVIEW_LIMIT = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const COMMIT_LIMIT = 30;

interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
  truncated: boolean;
}

interface RunGitOptions {
  allowedExitCodes?: number[];
  maxBytes?: number;
  truncate?: boolean;
}

export interface GitWorktreeScope {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  head: string;
  current: boolean;
  main: boolean;
  locked: boolean;
}

export interface GitRepositoryDiscovery {
  repositoryRoot: string;
  currentScopeId: string;
  worktrees: GitWorktreeScope[];
}

export interface GitChange {
  path: string;
  oldPath?: string;
  code: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface GitRepositoryOverview {
  available: boolean;
  repositoryRoot: string | null;
  selectedScopeId: string | null;
  worktrees: GitWorktreeScope[];
  changes: GitChange[];
  commits: GitCommitSummary[];
}

export interface GitCommitDetails extends GitCommitSummary {
  changes: GitChange[];
}

export interface GitDiffDetail {
  path: string;
  oldPath?: string;
  commit: string | null;
  label: string;
  patch: string;
  beforeContent: string | null;
  afterContent: string | null;
  beforeExists: boolean;
  afterExists: boolean;
  binary: boolean;
  truncated: boolean;
  additions: number;
  deletions: number;
}

interface GitScopeResolution {
  repository: GitRepositoryDiscovery;
  scope: GitWorktreeScope;
}

interface FileSnapshot {
  exists: boolean;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

export class GitRepositoryScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitRepositoryScopeError';
  }
}

async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const maxBytes = options.maxBytes ?? GIT_METADATA_LIMIT;
  const truncate = options.truncate ?? false;

  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let limitError: Error | null = null;
    let timedOut = false;
    let settled = false;

    const append = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = Math.max(0, maxBytes - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        if (truncate) {
          truncated = true;
          child.kill();
        } else {
          limitError = new Error(`Git output exceeded ${maxBytes} bytes`);
          child.kill();
        }
      }
      return currentBytes + Math.min(chunk.length, remaining);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, Buffer.from(chunk), stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, Buffer.from(chunk), stderrBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    timer.unref?.();

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Git command timed out after ${GIT_TIMEOUT_MS}ms`));
        return;
      }
      if (limitError) {
        reject(limitError);
        return;
      }

      const result: GitCommandResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code: code ?? (truncated ? 0 : 1),
        truncated,
      };
      if (!truncated && !allowedExitCodes.includes(result.code)) {
        const detail = result.stderr.toString('utf8').trim();
        reject(new Error(detail || `Git exited with code ${result.code}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function scopeId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

function parseWorktrees(output: string, currentRoot: string): GitWorktreeScope[] {
  return output
    .split('\0\0')
    .filter(Boolean)
    .map((record, index) => {
      const fields = record.split('\0');
      const values = new Map<string, string>();
      let locked = false;
      for (const field of fields) {
        const separator = field.indexOf(' ');
        const key = separator === -1 ? field : field.slice(0, separator);
        const value = separator === -1 ? '' : field.slice(separator + 1);
        values.set(key, value);
        if (key === 'locked') locked = true;
      }
      const path = values.get('worktree') || '';
      const branchRef = values.get('branch');
      return {
        id: scopeId(path),
        path,
        name: basename(path) || path,
        branch: branchRef?.replace(/^refs\/heads\//, '') || null,
        head: values.get('HEAD') || '',
        current: resolve(path) === resolve(currentRoot),
        main: index === 0,
        locked,
      };
    })
    .filter((scope) => Boolean(scope.path));
}

export async function discoverGitRepository(workingDir: string): Promise<GitRepositoryDiscovery | null> {
  try {
    const rootResult = await runGit(workingDir, ['rev-parse', '--show-toplevel'], {
      allowedExitCodes: [0, 128],
    });
    if (rootResult.code !== 0) return null;
    const currentRoot = rootResult.stdout.toString('utf8').trim();
    if (!currentRoot) return null;

    const worktreeResult = await runGit(currentRoot, ['worktree', 'list', '--porcelain', '-z']);
    const worktrees = parseWorktrees(worktreeResult.stdout.toString('utf8'), currentRoot);
    if (worktrees.length === 0) return null;
    const currentScope = worktrees.find((scope) => scope.current) ?? worktrees[0];
    return {
      repositoryRoot: worktrees[0].path,
      currentScopeId: currentScope.id,
      worktrees,
    };
  } catch {
    return null;
  }
}

async function resolveScope(workingDir: string, requestedScope?: string): Promise<GitScopeResolution | null> {
  const repository = await discoverGitRepository(workingDir);
  if (!repository) return null;
  const scope =
    !requestedScope || requestedScope === 'current'
      ? repository.worktrees.find((candidate) => candidate.id === repository.currentScopeId)
      : repository.worktrees.find((candidate) => candidate.id === requestedScope);
  if (!scope) {
    throw new GitRepositoryScopeError('Repository worktree scope not found');
  }
  return { repository, scope };
}

export async function resolveRepositoryBrowseRoot(workingDir: string, requestedScope?: string): Promise<string | null> {
  const resolution = await resolveScope(workingDir, requestedScope);
  return resolution?.scope.path ?? null;
}

function parseStatusCode(code: string): GitChange['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('U')) return 'conflicted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('C')) return 'copied';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  return 'modified';
}

function shortStatusCode(status: GitChange['status']): string {
  switch (status) {
    case 'untracked':
      return '?';
    case 'conflicted':
      return 'U';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'deleted':
      return 'D';
    case 'added':
      return 'A';
    default:
      return 'M';
  }
}

function parseStatus(output: string): GitChange[] {
  const records = output.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;

    let xy = '..';
    let path = '';
    let oldPath: string | undefined;
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      xy = fields[1] || '..';
      path = fields.slice(8).join(' ');
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      xy = fields[1] || '..';
      path = fields.slice(9).join(' ');
      oldPath = records[++i] || undefined;
    } else if (record.startsWith('? ')) {
      xy = '??';
      path = record.slice(2);
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ');
      xy = 'UU';
      path = fields.slice(10).join(' ');
    } else {
      continue;
    }

    const status = parseStatusCode(xy);
    changes.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      code: shortStatusCode(status),
      status,
      staged: xy[0] !== '.' && xy[0] !== '?',
      unstaged: xy[1] !== '.' || xy === '??',
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  return changes;
}

function parseNumstat(
  output: string
): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      // Rename/copy numstat records place old and new names in the next fields.
      i += 2;
      path = records[i] || '';
    }
    if (!path) continue;
    const binary = added === '-' || deleted === '-';
    stats.set(path, {
      additions: binary ? null : Number.parseInt(added, 10) || 0,
      deletions: binary ? null : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return stats;
}

async function hasHead(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], {
    allowedExitCodes: [0, 128],
  });
  return result.code === 0;
}

async function getChanges(cwd: string): Promise<GitChange[]> {
  const statusResult = await runGit(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--renames']);
  const changes = parseStatus(statusResult.stdout.toString('utf8'));
  if (changes.length === 0 || !(await hasHead(cwd))) return changes;

  const statResult = await runGit(cwd, ['diff', '--no-ext-diff', '--numstat', '-z', 'HEAD', '--']);
  const stats = parseNumstat(statResult.stdout.toString('utf8'));
  for (const change of changes) {
    const stat = stats.get(change.path);
    if (!stat) continue;
    change.additions = stat.additions;
    change.deletions = stat.deletions;
    change.binary = stat.binary;
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function parseCommitRecord(record: string): GitCommitSummary | null {
  const [hash, shortHash, author, authoredAt, ...subjectParts] = record.split('\x1f');
  if (!hash || !shortHash) return null;
  return {
    hash,
    shortHash,
    author: author || '',
    authoredAt: authoredAt || '',
    subject: subjectParts.join('\x1f'),
  };
}

async function getRecentCommits(cwd: string): Promise<GitCommitSummary[]> {
  if (!(await hasHead(cwd))) return [];
  const result = await runGit(cwd, [
    'log',
    `-${COMMIT_LIMIT}`,
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x00',
  ]);
  return result.stdout
    .toString('utf8')
    .split('\0')
    .map(parseCommitRecord)
    .filter((commit): commit is GitCommitSummary => commit !== null);
}

export async function getGitRepositoryOverview(
  workingDir: string,
  requestedScope?: string
): Promise<GitRepositoryOverview> {
  const resolution = await resolveScope(workingDir, requestedScope);
  if (!resolution) {
    return {
      available: false,
      repositoryRoot: null,
      selectedScopeId: null,
      worktrees: [],
      changes: [],
      commits: [],
    };
  }

  const [changes, commits] = await Promise.all([
    getChanges(resolution.scope.path),
    getRecentCommits(resolution.scope.path),
  ]);
  return {
    available: true,
    repositoryRoot: resolution.repository.repositoryRoot,
    selectedScopeId: resolution.scope.id,
    worktrees: resolution.repository.worktrees,
    changes,
    commits,
  };
}

function parseNameStatus(output: string): GitChange[] {
  const fields = output.split('\0').filter(Boolean);
  const changes: GitChange[] = [];
  for (let i = 0; i < fields.length; ) {
    const rawCode = fields[i++];
    const code = rawCode[0] || 'M';
    let oldPath: string | undefined;
    let path = fields[i++] || '';
    if (code === 'R' || code === 'C') {
      oldPath = path;
      path = fields[i++] || '';
    }
    const status = parseStatusCode(`${code}.`);
    changes.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      code: shortStatusCode(status),
      status,
      staged: true,
      unstaged: false,
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  return changes;
}

function assertCommitHash(commit: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new GitRepositoryScopeError('Invalid commit identifier');
  }
}

async function ensureCommit(cwd: string, commit: string): Promise<void> {
  assertCommitHash(commit);
  const result = await runGit(cwd, ['cat-file', '-e', `${commit}^{commit}`], {
    allowedExitCodes: [0, 128],
  });
  if (result.code !== 0) {
    throw new GitRepositoryScopeError('Commit not found');
  }
}

async function getCommitChanges(cwd: string, commit: string): Promise<GitChange[]> {
  await ensureCommit(cwd, commit);
  const result = await runGit(cwd, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-status',
    '-r',
    '-z',
    '-M',
    commit,
  ]);
  return parseNameStatus(result.stdout.toString('utf8'));
}

export async function getGitCommitDetails(
  workingDir: string,
  requestedScope: string | undefined,
  commit: string
): Promise<GitCommitDetails> {
  const resolution = await resolveScope(workingDir, requestedScope);
  if (!resolution) throw new GitRepositoryScopeError('Session is not inside a Git repository');
  await ensureCommit(resolution.scope.path, commit);
  const [summaryResult, changes] = await Promise.all([
    runGit(resolution.scope.path, [
      'show',
      '-s',
      '--date=iso-strict',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s',
      commit,
    ]),
    getCommitChanges(resolution.scope.path, commit),
  ]);
  const summary = parseCommitRecord(summaryResult.stdout.toString('utf8'));
  if (!summary) throw new GitRepositoryScopeError('Commit metadata is unavailable');
  return { ...summary, changes };
}

function normalizeRepositoryPath(root: string, filePath: string): string {
  if (!filePath || filePath.includes('\0') || isAbsolute(filePath)) {
    throw new GitRepositoryScopeError('Invalid repository file path');
  }
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const absolute = resolve(root, normalized);
  const fromRoot = relative(resolve(root), absolute);
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new GitRepositoryScopeError('Repository file path is outside the selected worktree');
  }
  return normalized;
}

function bufferLooksBinary(buffer: Buffer): boolean {
  const sniffLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sniffLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function readWorkingTreeFile(root: string, filePath: string): Promise<FileSnapshot> {
  const normalized = normalizeRepositoryPath(root, filePath);
  const absolute = resolve(root, normalized);
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
    const fromRoot = relative(realRoot, realFile);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new GitRepositoryScopeError('Repository file resolves outside the selected worktree');
    }
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) return { exists: false, binary: false, truncated: false, content: null };
    if (stat.size > FILE_PREVIEW_LIMIT) {
      return { exists: true, binary: false, truncated: true, content: null };
    }
    const content = await fs.readFile(realFile);
    const binary = bufferLooksBinary(content);
    return {
      exists: true,
      binary,
      truncated: false,
      content: binary ? null : content.toString('utf8'),
    };
  } catch (err) {
    if (err instanceof GitRepositoryScopeError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, binary: false, truncated: false, content: null };
    }
    throw err;
  }
}

async function readGitBlob(cwd: string, revision: string, filePath: string): Promise<FileSnapshot> {
  const object = `${revision}:${filePath}`;
  const exists = await runGit(cwd, ['cat-file', '-e', object], {
    allowedExitCodes: [0, 128],
  });
  if (exists.code !== 0) return { exists: false, binary: false, truncated: false, content: null };

  const sizeResult = await runGit(cwd, ['cat-file', '-s', object]);
  const size = Number.parseInt(sizeResult.stdout.toString('utf8').trim(), 10);
  if (Number.isFinite(size) && size > FILE_PREVIEW_LIMIT) {
    return { exists: true, binary: false, truncated: true, content: null };
  }
  const contentResult = await runGit(cwd, ['show', '--no-textconv', object], {
    maxBytes: FILE_PREVIEW_LIMIT + 1,
  });
  const binary = bufferLooksBinary(contentResult.stdout);
  return {
    exists: true,
    binary,
    truncated: false,
    content: binary ? null : contentResult.stdout.toString('utf8'),
  };
}

function countPatchChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function synthesizeUntrackedPatch(filePath: string, content: string): string {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  if (lines.length === 0) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${filePath}`,
    ].join('\n');
  }
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join('\n');
}

export async function getGitDiffDetail(
  workingDir: string,
  requestedScope: string | undefined,
  filePath: string,
  commit?: string
): Promise<GitDiffDetail> {
  const resolution = await resolveScope(workingDir, requestedScope);
  if (!resolution) throw new GitRepositoryScopeError('Session is not inside a Git repository');
  const cwd = resolution.scope.path;
  const normalizedPath = normalizeRepositoryPath(cwd, filePath);

  let oldPath: string | undefined;
  let before: FileSnapshot;
  let after: FileSnapshot;
  let patchResult: GitCommandResult;
  let label: string;

  if (commit) {
    await ensureCommit(cwd, commit);
    const changes = await getCommitChanges(cwd, commit);
    const change = changes.find((candidate) => candidate.path === normalizedPath);
    oldPath = change?.oldPath;
    const parentResult = await runGit(cwd, ['rev-parse', '--verify', `${commit}^`], {
      allowedExitCodes: [0, 128],
    });
    const parent = parentResult.code === 0 ? parentResult.stdout.toString('utf8').trim() : null;
    before = parent
      ? await readGitBlob(cwd, parent, oldPath || normalizedPath)
      : { exists: false, binary: false, truncated: false, content: null };
    after = await readGitBlob(cwd, commit, normalizedPath);
    patchResult = await runGit(
      cwd,
      [
        'show',
        '--format=',
        '--no-ext-diff',
        '--no-color',
        '--find-renames',
        '--unified=3',
        commit,
        '--',
        ...(oldPath ? [oldPath] : []),
        normalizedPath,
      ],
      { maxBytes: GIT_DIFF_LIMIT, truncate: true }
    );
    label = `${commit.slice(0, 8)} · ${normalizedPath}`;
  } else {
    const changes = await getChanges(cwd);
    const change = changes.find((candidate) => candidate.path === normalizedPath);
    oldPath = change?.oldPath;
    const repositoryHasHead = await hasHead(cwd);
    before = repositoryHasHead
      ? await readGitBlob(cwd, 'HEAD', oldPath || normalizedPath)
      : { exists: false, binary: false, truncated: false, content: null };
    after = await readWorkingTreeFile(cwd, normalizedPath);
    patchResult = repositoryHasHead
      ? await runGit(
          cwd,
          [
            'diff',
            '--no-ext-diff',
            '--no-color',
            '--find-renames',
            '--unified=3',
            'HEAD',
            '--',
            ...(oldPath ? [oldPath] : []),
            normalizedPath,
          ],
          { maxBytes: GIT_DIFF_LIMIT, truncate: true }
        )
      : { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0, truncated: false };
    if (patchResult.stdout.length === 0 && !before.exists && after.content !== null) {
      patchResult = {
        ...patchResult,
        stdout: Buffer.from(synthesizeUntrackedPatch(normalizedPath, after.content)),
      };
    }
    label = `Working tree · ${normalizedPath}`;
  }

  const patch = patchResult.stdout.toString('utf8');
  const counts = countPatchChanges(patch);
  return {
    path: normalizedPath,
    ...(oldPath ? { oldPath } : {}),
    commit: commit || null,
    label,
    patch,
    beforeContent: before.content,
    afterContent: after.content,
    beforeExists: before.exists,
    afterExists: after.exists,
    binary: before.binary || after.binary || /Binary files|GIT binary patch/.test(patch),
    truncated: patchResult.truncated || before.truncated || after.truncated,
    additions: counts.additions,
    deletions: counts.deletions,
  };
}
