/**
 * @fileoverview Read My Mind collectors tests (src/readmymind-collectors.ts).
 *
 * `parseTranscriptSignals` runs on JSONL fixtures; `readTranscriptSignals`
 * and `collectWorkspaceSignals` run against real temp files/repos under this
 * test file's temp HOME (no tmux, no network).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTranscriptSignals,
  readTranscriptSignals,
  collectWorkspaceSignals,
} from '../src/readmymind-collectors.js';

function assistantLine(blocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
}

function userToolResultLine(toolUseId: string, isError: boolean): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] },
  });
}

describe('parseTranscriptSignals', () => {
  it('keeps the FULL last assistant text, not a snippet', () => {
    const long = 'x'.repeat(4000) + ' THE_END';
    const lines = [
      assistantLine([{ type: 'text', text: 'earlier reply' }]),
      assistantLine([{ type: 'text', text: long }]),
    ];
    const signals = parseTranscriptSignals(lines);
    expect(signals.lastAssistantText).toContain('THE_END');
    expect(signals.lastAssistantText!.length).toBeGreaterThan(3000);
  });

  it('extracts recent tool calls with argument summaries and failure marks', () => {
    const lines = [
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/foo.ts' } }]),
      assistantLine([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
      userToolResultLine('t2', true),
    ];
    const signals = parseTranscriptSignals(lines);
    expect(signals.recentTools).toEqual([
      { name: 'Edit', detail: 'src/foo.ts', failed: undefined },
      { name: 'Bash', detail: 'npm test', failed: true },
    ]);
  });

  it('caps retained tools to the most recent N', () => {
    const lines = Array.from({ length: 15 }, (_, i) =>
      assistantLine([{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `f${i}` } }])
    );
    const signals = parseTranscriptSignals(lines);
    expect(signals.recentTools).toHaveLength(10);
    expect(signals.recentTools[0].detail).toBe('f5');
    expect(signals.recentTools[9].detail).toBe('f14');
  });

  it('skips malformed lines and tool_result-only user entries without text', () => {
    const lines = ['{"type": "assistant", TRUNCATED', '', userToolResultLine('nope', false)];
    const signals = parseTranscriptSignals(lines);
    expect(signals.lastAssistantText).toBeNull();
    expect(signals.recentTools).toEqual([]);
  });
});

describe('readTranscriptSignals', () => {
  it('reads a real transcript file and returns null for a missing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rmm-transcript-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [assistantLine([{ type: 'text', text: 'tail reply' }]), ''].join('\n'));

    const signals = await readTranscriptSignals(file);
    expect(signals?.lastAssistantText).toBe('tail reply');

    expect(await readTranscriptSignals(join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('collectWorkspaceSignals', () => {
  it('returns null for a non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rmm-nogit-'));
    expect(await collectWorkspaceSignals(dir)).toBeNull();
    expect(await collectWorkspaceSignals(join(dir, 'does-not-exist'))).toBeNull();
  });

  it('collects branch, status, commits, and changeset presence from a real repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rmm-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'hello');
    git('add', 'a.txt');
    git('commit', '-m', 'first commit');
    writeFileSync(join(dir, 'b.txt'), 'dirty');
    mkdirSync(join(dir, '.changeset'));
    writeFileSync(join(dir, '.changeset', 'README.md'), 'not a changeset');
    writeFileSync(join(dir, '.changeset', 'blue-cats-run.md'), '---\n"pkg": patch\n---\n');

    const signals = await collectWorkspaceSignals(dir);
    expect(signals?.branch).toBe('main');
    expect(signals?.statusShort).toContain('b.txt');
    expect(signals?.recentCommits).toContain('first commit');
    expect(signals?.hasChangesets).toBe(true);
  });
});
