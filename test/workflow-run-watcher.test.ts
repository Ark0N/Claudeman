/**
 * Tests for WorkflowRunWatcher — parses wf_<runId>.json run-state into
 * WorkflowRunInfo for the ultracode master-detail view.
 *
 * Drives the real discover→parse path against a synthetic on-disk fixture in a
 * temp projects dir (never the shared singleton, never ~/.claude).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowRunWatcher } from '../src/workflow-run-watcher.js';
import type { WorkflowRunInfo } from '../src/types/workflow-run.js';

const PROJECT_HASH = '-home-arkon-default-claudeman';
const SESSION_UUID = '388113c8-cd01-4e80-93a8-3be66ab1519b';
const RUN_ID = 'wf_test1234-abc';

/**
 * The fixture's epochs are anchored to "now", never pinned, because the recency
 * assertions below compare them against `Date.now()`. A frozen epoch plus a fixed
 * window is a time bomb: the original fixture's newest activity sat at
 * 2026-06-14T20:06:40Z, and `getRecentRunSummaries(100000)` — that argument is
 * MINUTES, i.e. 69.4 days — stopped matching it on 2026-08-23T06:46:40Z, turning
 * CI red on a suite nobody had touched. Offsets from the anchor are preserved
 * verbatim, so every parsed duration and ordering assertion is unchanged.
 */
const RUN_ANCHOR = Date.now() - 601_000;

/** A run JSON shaped like a real (killed) run: all three agent states + the bloat fields. */
function sampleRunJson() {
  return {
    runId: RUN_ID,
    timestamp: new Date(RUN_ANCHOR).toISOString(),
    taskId: 'task_abc',
    // --- bloat fields that MUST be stripped ---
    script: 'export const meta = {};\n'.repeat(5000), // ~110KB
    scriptPath: '/tmp/whatever.js',
    result: { plan: { huge: 'object' } },
    logs: ['line1', 'line2'],
    // --- real fields ---
    agentCount: 3,
    durationMs: 795173,
    summary: 'Deep adversarial review of open PRs',
    workflowName: 'review-open-prs',
    status: 'killed',
    error: 'user stopped the task',
    startTime: RUN_ANCHOR,
    defaultModel: 'claude-opus-4-8[1m]',
    totalTokens: 109703,
    totalToolCalls: 44,
    phases: [
      { title: 'Review', detail: 'one deep reviewer per PR' },
      { title: 'Probe', detail: 'targeted security/correctness probes' },
      { title: 'Verify', detail: 'adversarially verify each finding' },
    ],
    workflowProgress: [
      { type: 'workflow_phase', index: 0, phaseIndex: 1, phaseTitle: 'Review' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'probe:dompurify-config',
        phaseIndex: 2,
        phaseTitle: 'Probe',
        agentId: 'a6c0e282c3f5ac0bf',
        model: 'claude-opus-4-8[1m]',
        state: 'done',
        startedAt: RUN_ANCHOR + 1002,
        queuedAt: RUN_ANCHOR + 962,
        attempt: 1,
        lastToolName: 'StructuredOutput',
        lastToolSummary: 'Does the profile setting make the allowlist dead config',
        promptPreview: 'You are reviewing a pull request...',
        lastProgressAt: RUN_ANCHOR + 525_143,
        tokens: 104703,
        toolCalls: 41,
        durationMs: 524140,
        resultPreview: '{"verdict":"concern"}',
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'review:pr-127',
        phaseIndex: 1,
        phaseTitle: 'Review',
        agentId: 'a1234567890abcdef',
        model: 'claude-opus-4-8[1m]',
        state: 'progress',
        startedAt: RUN_ANCHOR + 11_000,
        queuedAt: RUN_ANCHOR + 970,
        attempt: 1,
        lastToolName: 'Read',
        promptPreview: 'Review PR 127...',
        lastProgressAt: RUN_ANCHOR + 601_000,
        tokens: 5000,
        toolCalls: 3,
      },
      {
        type: 'workflow_agent',
        index: 3,
        label: 'verify:finding-x',
        phaseIndex: 3,
        phaseTitle: 'Verify',
        model: 'claude-opus-4-8[1m]',
        state: 'start',
        queuedAt: RUN_ANCHOR + 980,
        promptPreview: 'Verify finding x...',
        lastProgressAt: RUN_ANCHOR + 980,
      },
    ],
  };
}

describe('WorkflowRunWatcher', () => {
  let projectsDir: string;
  let watcher: WorkflowRunWatcher;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'wfw-test-'));
    const workflowsDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, `${RUN_ID}.json`), JSON.stringify(sampleRunJson()), 'utf-8');
    watcher = new WorkflowRunWatcher(projectsDir);
  });

  afterEach(async () => {
    watcher.stop();
    await rm(projectsDir, { recursive: true, force: true });
  });

  /** Start the watcher and resolve with the first discovered run. */
  function firstRun(): Promise<WorkflowRunInfo> {
    return new Promise<WorkflowRunInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for run_discovered')), 5000);
      watcher.once('run_discovered', (info: WorkflowRunInfo) => {
        clearTimeout(timer);
        resolve(info);
      });
      watcher.start();
    });
  }

  it('discovers and parses a run, deriving session/project from the path', async () => {
    const info = await firstRun();
    expect(info.runId).toBe(RUN_ID);
    expect(info.workflowName).toBe('review-open-prs');
    expect(info.status).toBe('killed');
    expect(info.error).toBe('user stopped the task');
    expect(info.sessionUuid).toBe(SESSION_UUID);
    expect(info.projectHash).toBe(PROJECT_HASH);
    expect(info.totalTokens).toBe(109703);
    expect(info.totalToolCalls).toBe(44);
  });

  it('keeps only workflow_agent entries (drops workflow_phase markers)', async () => {
    const info = await firstRun();
    expect(info.agents).toHaveLength(3);
    expect(info.phases).toHaveLength(3);
  });

  it('STRIPS the heavyweight script/scriptPath/result/logs fields', async () => {
    const info = await firstRun();
    const asAny = info as unknown as Record<string, unknown>;
    expect('script' in asAny).toBe(false);
    expect('scriptPath' in asAny).toBe(false);
    expect('result' in asAny).toBe(false);
    expect('logs' in asAny).toBe(false);
    // The serialized run that reaches a client must be small.
    expect(JSON.stringify(info).length).toBeLessThan(5000);
  });

  it('carries tokens/toolCalls/durationMs on a done agent', async () => {
    const info = await firstRun();
    const done = info.agents.find((a) => a.state === 'done')!;
    expect(done.agentId).toBe('a6c0e282c3f5ac0bf');
    expect(done.tokens).toBe(104703);
    expect(done.toolCalls).toBe(41);
    expect(done.durationMs).toBe(524140);
    expect(done.resultPreview).toBeDefined();
  });

  it('omits agentId/tokens/toolCalls/durationMs on a start (queued) agent', async () => {
    const info = await firstRun();
    const queued = info.agents.find((a) => a.state === 'start')!;
    expect(queued.agentId).toBeUndefined();
    expect(queued.tokens).toBeUndefined();
    expect(queued.toolCalls).toBeUndefined();
    expect(queued.durationMs).toBeUndefined();
    expect(queued.label).toBe('verify:finding-x');
  });

  it('a progress agent has tokens but no durationMs (live discriminator)', async () => {
    const info = await firstRun();
    const running = info.agents.find((a) => a.state === 'progress')!;
    expect(running.tokens).toBe(5000);
    expect(running.toolCalls).toBe(3);
    expect(running.durationMs).toBeUndefined();
  });

  it('phase join: agent.phaseIndex-1 indexes run.phases', async () => {
    const info = await firstRun();
    for (const agent of info.agents) {
      expect(info.phases[agent.phaseIndex - 1].title).toBe(agent.phaseTitle);
    }
  });

  it('exposes the run via getAllRuns/getRun after discovery', async () => {
    await firstRun();
    expect(watcher.getAllRuns()).toHaveLength(1);
    expect(watcher.getRun(RUN_ID)?.runId).toBe(RUN_ID);
    expect(watcher.getStats().agentCount).toBe(3);
  });

  it('getRecentRunSummaries omits agents[] (lightweight snapshot)', async () => {
    await firstRun();
    const summaries = watcher.getRecentRunSummaries(100000);
    expect(summaries).toHaveLength(1);
    expect('agents' in summaries[0]).toBe(false);
    expect(summaries[0].runId).toBe(RUN_ID);
    expect(summaries[0].agentCount).toBe(3);
  });
});

/**
 * In-flight runs: the Workflow runtime writes the completion wf_<id>.json only when
 * a run FINISHES, so while it is live the only on-disk state is its
 * subagents/workflows/wf_<id>/ transcript dir. The watcher synthesizes a minimal
 * ACTIVE run from that dir so the floating window pops DURING the run.
 */
describe('WorkflowRunWatcher — in-flight (live) runs', () => {
  const LIVE_RUN_ID = 'wf_live5678-xyz';
  let projectsDir: string;
  let liveDir: string;
  let watcher: WorkflowRunWatcher;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'wfw-live-'));
    liveDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'subagents', 'workflows', LIVE_RUN_ID);
    await mkdir(liveDir, { recursive: true });
    // Two agents started; one already produced a result (journal `result` line).
    await writeFile(
      join(liveDir, 'agent-aaa111.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent' }),
      'utf-8'
    );
    await writeFile(join(liveDir, 'agent-aaa111.jsonl'), '{"type":"assistant"}\n', 'utf-8');
    await writeFile(
      join(liveDir, 'agent-bbb222.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent' }),
      'utf-8'
    );
    await writeFile(join(liveDir, 'agent-bbb222.jsonl'), '{"type":"assistant"}\n', 'utf-8');
    await writeFile(
      join(liveDir, 'journal.jsonl'),
      '{"type":"started","agentId":"aaa111"}\n{"type":"started","agentId":"bbb222"}\n{"type":"result","agentId":"aaa111","result":{}}\n',
      'utf-8'
    );
    watcher = new WorkflowRunWatcher(projectsDir);
  });

  afterEach(async () => {
    watcher.stop();
    await rm(projectsDir, { recursive: true, force: true });
  });

  function firstRun(): Promise<WorkflowRunInfo> {
    return new Promise<WorkflowRunInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for run_discovered')), 5000);
      watcher.once('run_discovered', (info: WorkflowRunInfo) => {
        clearTimeout(timer);
        resolve(info);
      });
      watcher.start();
    });
  }

  it('synthesizes an ACTIVE run from the transcript dir when no completion file exists', async () => {
    const info = await firstRun();
    expect(info.runId).toBe(LIVE_RUN_ID);
    expect(info.status).toBe('running'); // active → frontend pops a floating window
    expect(info.sessionUuid).toBe(SESSION_UUID);
    expect(info.projectHash).toBe(PROJECT_HASH);
    expect(info.agents).toHaveLength(2);
    expect(info.agentCount).toBe(2);
    expect(info.lastActivityAt).toBeGreaterThan(0);
  });

  it('preserves agentId per slot (so the card→transcript click join still works)', async () => {
    const info = await firstRun();
    const ids = info.agents.map((a) => a.agentId).sort();
    expect(ids).toEqual(['aaa111', 'bbb222']);
  });

  it('marks an agent done/progress from journal result lines', async () => {
    const info = await firstRun();
    expect(info.agents.find((a) => a.agentId === 'aaa111')!.state).toBe('done'); // has a result line
    expect(info.agents.find((a) => a.agentId === 'bbb222')!.state).toBe('progress'); // started, no result yet
  });

  it('counts the live run as running in getStats', async () => {
    await firstRun();
    expect(watcher.getStats().running).toBe(1);
  });

  it('does NOT surface a live dir that has no agent files yet', async () => {
    const empty = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'subagents', 'workflows', 'wf_empty0000-noo');
    await mkdir(empty, { recursive: true });
    await firstRun(); // resolves on the real (populated) live run
    // The empty run id must never enter the cache.
    expect(watcher.getRun('wf_empty0000-noo')).toBeUndefined();
    expect(watcher.getAllRuns().map((r) => r.runId)).toEqual([LIVE_RUN_ID]);
  });

  it('a completion wf_*.json supersedes the live dir for the same runId (real status wins)', async () => {
    const workflowsDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      join(workflowsDir, `${LIVE_RUN_ID}.json`),
      JSON.stringify({ runId: LIVE_RUN_ID, status: 'completed', durationMs: 1234, phases: [], workflowProgress: [] }),
      'utf-8'
    );
    const info = await firstRun();
    expect(info.runId).toBe(LIVE_RUN_ID);
    expect(info.status).toBe('completed'); // real completion file wins, not synthesized 'running'
    expect(info.durationMs).toBe(1234);
    // Only one cached entry for the runId — no live/real duplication.
    expect(watcher.getAllRuns()).toHaveLength(1);
  });
});

/**
 * Live ENRICHMENT: while a run is in-flight the watcher now parses each agent
 * transcript for real tokens/tool-calls/model, maps state→colour from the journal,
 * and derives the run name/summary/phases from the persisted script — so the
 * floating window/panel show real data mid-run instead of "0 tok / agent N".
 */
describe('WorkflowRunWatcher — live enrichment (tokens/state/name)', () => {
  const RUN = 'wf_enrich01-abc';
  let projectsDir: string;
  let watcher: WorkflowRunWatcher;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'wfw-enrich-'));
    const sessionDir = join(projectsDir, PROJECT_HASH, SESSION_UUID);
    const liveDir = join(sessionDir, 'subagents', 'workflows', RUN);
    await mkdir(liveDir, { recursive: true });
    const scriptsDir = join(sessionDir, 'workflows', 'scripts');
    await mkdir(scriptsDir, { recursive: true });

    // Agent aaa: a user prompt + two assistant turns with usage + two tool_use blocks.
    await writeFile(
      join(liveDir, 'agent-aaa.jsonl'),
      [
        '{"type":"user","message":{"role":"user","content":"Audit the docs"}}',
        '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":40},"content":[{"type":"tool_use","name":"Bash"}]}}',
        '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":2000,"cache_read_input_tokens":500,"output_tokens":80},"content":[{"type":"tool_use","name":"Edit"},{"type":"text","text":"done"}]}}',
      ].join('\n') + '\n',
      'utf-8'
    );
    await writeFile(join(liveDir, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }), 'utf-8');
    // Agent bbb: started, no result yet, minimal transcript (no usage).
    await writeFile(join(liveDir, 'agent-bbb.jsonl'), '{"type":"assistant","message":{"content":[]}}\n', 'utf-8');
    // bbb starts BEFORE aaa, so journal launch order ['bbb','aaa'] differs from the
    // old alphabetical sort ['aaa','bbb'] — the ordering assertion below is adversarial.
    await writeFile(
      join(liveDir, 'journal.jsonl'),
      '{"type":"started","agentId":"bbb"}\n{"type":"started","agentId":"aaa"}\n{"type":"result","agentId":"aaa","result":{}}\n',
      'utf-8'
    );
    // Persisted script — name from filename, summary/phases from the meta literal.
    await writeFile(
      join(scriptsDir, `my-cool-workflow-${RUN}.js`),
      "export const meta = {\n  name: 'my-cool-workflow',\n  description: 'Audit and update the docs',\n  phases: [ { title: 'Plan', detail: 'plan it' }, { title: 'Do', detail: 'do it' } ],\n}\n",
      'utf-8'
    );
    watcher = new WorkflowRunWatcher(projectsDir);
  });

  afterEach(async () => {
    watcher.stop();
    await rm(projectsDir, { recursive: true, force: true });
  });

  function firstRun(): Promise<WorkflowRunInfo> {
    return new Promise<WorkflowRunInfo>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out')), 5000);
      watcher.once('run_discovered', (info: WorkflowRunInfo) => {
        clearTimeout(t);
        resolve(info);
      });
      watcher.start();
    });
  }

  it('derives workflowName/summary/phases from the live script file', async () => {
    const info = await firstRun();
    expect(info.workflowName).toBe('my-cool-workflow');
    expect(info.summary).toBe('Audit and update the docs');
    expect(info.phases.map((p) => p.title)).toEqual(['Plan', 'Do']);
  });

  it('parses per-agent tokens (last usage-bearing message) + tool-call counts from the transcript', async () => {
    const info = await firstRun();
    const aaa = info.agents.find((a) => a.agentId === 'aaa')!;
    expect(aaa.tokens).toBe(2580); // last turn: 2000 in + 500 cache + 80 out
    expect(aaa.toolCalls).toBe(2); // Bash + Edit
    expect(aaa.model).toBe('claude-opus-4-8');
    expect(aaa.promptPreview).toBe('Audit the docs');
  });

  it('maps state to done (→green) / progress (→yellow) from the journal', async () => {
    const info = await firstRun();
    expect(info.agents.find((a) => a.agentId === 'aaa')!.state).toBe('done');
    expect(info.agents.find((a) => a.agentId === 'bbb')!.state).toBe('progress');
  });

  it('orders agents by journal launch order (NOT alphabetical) and sums run-level totals', async () => {
    const info = await firstRun();
    // bbb started first in the journal though it sorts after aaa — launch order wins.
    expect(info.agents.map((a) => a.agentId)).toEqual(['bbb', 'aaa']);
    expect(info.agents[0].label).toBe('agent 1'); // = bbb, the first-launched
    expect(info.totalToolCalls).toBe(2);
    expect(info.totalTokens).toBe(2580);
  });
});
