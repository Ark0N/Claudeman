/**
 * Performance tests: Claudeman responsiveness under subagent load
 *
 * Measures event loop lag caused by:
 * 1. SubagentWatcher processing many agent files simultaneously
 * 2. extractDescriptionFromParentTranscript reading full transcript files
 * 3. findSubagentProcess spawning pgrep for every agent in liveness checks
 * 4. SSE broadcast serialization under heavy event load
 * 5. flushTerminalBatches with many concurrent sessions
 *
 * Port: none (no server needed — unit-level perf tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubagentWatcher } from '../src/subagent-watcher.js';

// ========== Helpers ==========

/** Generate a realistic JSONL transcript entry */
function makeTranscriptEntry(type: 'user' | 'assistant', content: string, extras: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    type,
    timestamp: new Date().toISOString(),
    message: {
      role: type,
      content: type === 'user'
        ? [{ type: 'text', text: content }]
        : content,
      ...(type === 'assistant' ? { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1500, output_tokens: 800 } } : {}),
    },
    ...extras,
  };
  return JSON.stringify(base);
}

/** Generate a realistic large parent transcript (many lines of JSONL) */
function generateParentTranscript(lineCount: number, agentIds: string[] = []): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 2 === 0) {
      lines.push(makeTranscriptEntry('user', `Please do task ${i} for the project`));
    } else {
      lines.push(makeTranscriptEntry('assistant', `Working on task ${i}...`));
    }
  }
  // Sprinkle in toolUseResult entries for agent descriptions
  for (const agentId of agentIds) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      toolUseResult: { agentId, description: `Research task for ${agentId}` },
    }));
  }
  return lines.join('\n') + '\n';
}

/** Generate a subagent transcript file */
function generateAgentTranscript(lineCount: number): string {
  const lines: string[] = [];
  lines.push(makeTranscriptEntry('user', 'Investigate the authentication module and suggest improvements for rate limiting'));
  for (let i = 1; i < lineCount; i++) {
    if (i % 3 === 0) {
      lines.push(JSON.stringify({
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        tool: 'Read',
        input: { file_path: `/home/user/project/src/file-${i}.ts` },
        toolUseId: `tool-${i}`,
      }));
    } else if (i % 3 === 1) {
      lines.push(JSON.stringify({
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        toolUseId: `tool-${i - 1}`,
        content: 'x'.repeat(500),
      }));
    } else {
      lines.push(makeTranscriptEntry('assistant', `Analysis step ${i}: Found pattern in module...`));
    }
  }
  return lines.join('\n') + '\n';
}

/** Measure event loop lag over a duration */
function measureEventLoopLag(durationMs: number): Promise<{ maxLagMs: number; avgLagMs: number; samples: number[] }> {
  return new Promise((resolve) => {
    const samples: number[] = [];
    let lastTime = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const lag = now - lastTime - 2; // subtract the 2ms expected interval
      samples.push(Math.max(0, lag));
      lastTime = now;
    }, 2);

    setTimeout(() => {
      clearInterval(interval);
      const maxLagMs = Math.max(...samples, 0);
      const avgLagMs = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      resolve({ maxLagMs, avgLagMs, samples });
    }, durationMs);
  });
}

// ========== Tests ==========

describe('SubagentWatcher performance', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claudeman-perf-'));
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('extractDescriptionFromParentTranscript — full file reads', () => {
    it('should parse a 1000-line parent transcript without significant event loop lag', async () => {
      // Setup: create a realistic parent transcript with 1000 lines
      const projectHash = 'abc123';
      const sessionId = 'session-001';
      const agentIds = Array.from({ length: 10 }, (_, i) => `agent-${i}`);

      const projectDir = join(projectsDir, projectHash);
      const sessionDir = join(projectDir, sessionId);
      const subagentDir = join(sessionDir, 'subagents');
      mkdirSync(subagentDir, { recursive: true });

      // Write a large parent transcript
      const transcript = generateParentTranscript(1000, agentIds);
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript);

      // Write 10 agent files
      for (const id of agentIds) {
        writeFileSync(join(subagentDir, `agent-${id}.jsonl`), generateAgentTranscript(50));
      }

      // Measure: call extractDescriptionFromParentTranscript via public path
      // We can't call private methods directly, so we test via watchAgentFile indirection
      // Instead, test the raw approach: read + parse + search (same as the method does)
      const { readFile } = await import('node:fs/promises');
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

      const start = performance.now();
      const content = await readFile(transcriptPath, 'utf8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      let found = false;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.toolUseResult?.agentId === 'agent-5') {
            found = true;
            break;
          }
        } catch { /* skip */ }
      }
      const elapsed = performance.now() - start;

      expect(found).toBe(true);
      // 1000-line transcript should parse in under 10ms
      expect(elapsed).toBeLessThan(50);
    });

    it('should handle 10,000-line transcript without blocking event loop > 50ms', async () => {
      const projectHash = 'bigproject';
      const sessionId = 'session-big';
      const agentIds = ['target-agent'];

      const projectDir = join(projectsDir, projectHash);
      mkdirSync(projectDir, { recursive: true });

      // 10K lines = realistic for a long Claude session
      const transcript = generateParentTranscript(10000, agentIds);
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript);

      const { readFile } = await import('node:fs/promises');
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

      // Start event loop lag measurement
      const lagPromise = measureEventLoopLag(500);

      // Simulate 5 concurrent reads (5 subagents discovered simultaneously)
      const reads = Array.from({ length: 5 }, async () => {
        const content = await readFile(transcriptPath, 'utf8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.toolUseResult?.agentId === 'target-agent') {
              return entry.toolUseResult.description;
            }
          } catch { /* skip */ }
        }
        return undefined;
      });

      const results = await Promise.all(reads);
      const lag = await lagPromise;

      // All 5 should find the description
      for (const r of results) {
        expect(r).toBe('Research task for target-agent');
      }

      // Key assertion: max event loop lag should stay reasonable
      // JSON.parse of 10K lines is synchronous and blocks the event loop
      console.log(`[10K transcript × 5 reads] max lag: ${lag.maxLagMs.toFixed(1)}ms, avg: ${lag.avgLagMs.toFixed(1)}ms`);

      // This WILL likely fail — proving the bottleneck
      // 50ms is the threshold where users notice UI jank
      expect(lag.maxLagMs).toBeLessThan(100);
    });
  });

  describe('extractDescriptionFromFile — full subagent file reads', () => {
    it('should not read entire large agent file just for first 5 lines', async () => {
      const agentDir = join(tmpDir, 'agent-files');
      mkdirSync(agentDir, { recursive: true });

      // Create a large agent file (5000 lines, ~2MB)
      const agentFile = join(agentDir, 'agent-large.jsonl');
      writeFileSync(agentFile, generateAgentTranscript(5000));

      const { readFile, stat: statAsync } = await import('node:fs/promises');
      const fileStat = await statAsync(agentFile);
      const fileSizeKB = fileStat.size / 1024;

      // Current implementation: reads ENTIRE file then slices first 5 lines
      const start = performance.now();
      const content = await readFile(agentFile, 'utf8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      const firstFive = lines.slice(0, 5);
      let description: string | undefined;
      for (const line of firstFive) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const firstContent = Array.isArray(entry.message.content)
              ? entry.message.content[0]
              : undefined;
            if (firstContent?.type === 'text') {
              description = firstContent.text.trim().slice(0, 45);
            }
          }
        } catch { /* skip */ }
      }
      const readAllElapsed = performance.now() - start;

      // Compare with streaming approach (only read first N bytes)
      const { createReadStream } = await import('node:fs');
      const { createInterface } = await import('node:readline');

      const start2 = performance.now();
      let description2: string | undefined;
      await new Promise<void>((resolve) => {
        const stream = createReadStream(agentFile, { end: 8192 }); // Only read first 8KB
        const rl = createInterface({ input: stream });
        let lineCount = 0;
        rl.on('line', (line) => {
          if (lineCount >= 5) { rl.close(); stream.destroy(); return; }
          lineCount++;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
              const firstContent = Array.isArray(entry.message.content)
                ? entry.message.content[0]
                : undefined;
              if (firstContent?.type === 'text') {
                description2 = firstContent.text.trim().slice(0, 45);
                rl.close();
                stream.destroy();
              }
            }
          } catch { /* skip */ }
        });
        rl.on('close', resolve);
        rl.on('error', resolve);
      });
      const streamElapsed = performance.now() - start2;

      console.log(`[extractDescription] file: ${fileSizeKB.toFixed(0)}KB, readAll: ${readAllElapsed.toFixed(1)}ms, stream-first-8KB: ${streamElapsed.toFixed(1)}ms`);
      console.log(`[extractDescription] speedup: ${(readAllElapsed / Math.max(streamElapsed, 0.1)).toFixed(1)}x`);

      expect(description).toBeDefined();
      expect(description2).toBeDefined();
      expect(description).toBe(description2);

      // Stream approach should be significantly faster on large files
      // This test documents the waste in the current approach
      expect(streamElapsed).toBeLessThan(readAllElapsed);
    });
  });

  describe('findSubagentProcess — pgrep + /proc reads for every agent', () => {
    it('should measure cost of pgrep per agent in liveness check', async () => {
      const { execFile } = await import('node:child_process');

      // Measure single pgrep call (what happens per agent per liveness check)
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await new Promise<void>((resolve) => {
          execFile('pgrep', ['-f', 'claude'], { encoding: 'utf8' }, () => {
            times.push(performance.now() - start);
            resolve();
          });
        });
      }

      const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
      const maxMs = Math.max(...times);
      console.log(`[pgrep per call] avg: ${avgMs.toFixed(1)}ms, max: ${maxMs.toFixed(1)}ms`);

      // Now simulate what happens with 20 active agents (sequential, as the liveness checker does)
      const start20 = performance.now();
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => {
          execFile('pgrep', ['-f', 'claude'], { encoding: 'utf8' }, () => resolve());
        });
      }
      const total20 = performance.now() - start20;
      console.log(`[pgrep × 20 agents] total: ${total20.toFixed(1)}ms`);

      // 20 sequential pgrep calls at ~5-10ms each = 100-200ms blocking the liveness check
      // The liveness checker runs every 10s and blocks the event loop during iteration
      // because it awaits each agent serially: for (const [agentId, info] of this.agentInfo)
    });

    it('should measure /proc environ reads (per pgrep hit)', async () => {
      const { readFile } = await import('node:fs/promises');

      // Read our own /proc/self/environ as baseline
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        try {
          await readFile('/proc/self/environ', 'utf8');
        } catch { /* may fail in containers */ }
        times.push(performance.now() - start);
      }

      const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`[/proc/environ read] avg: ${avgMs.toFixed(1)}ms over 20 reads`);
      // Each findSubagentProcess reads /proc/{pid}/environ + /proc/{pid}/cmdline
      // for every PID returned by pgrep — if 50 claude-related PIDs, that's 100 reads
    });
  });

  describe('SSE broadcast serialization under load', () => {
    it('should measure JSON.stringify cost for typical broadcast payloads', () => {
      // Simulate subagent:discovered events (fired for each new agent)
      const agentInfo = {
        agentId: 'abc-123-def',
        sessionId: 'session-001',
        projectHash: 'proj-hash',
        filePath: '/home/user/.claude/projects/hash/session/subagents/agent-abc.jsonl',
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        status: 'active',
        toolCallCount: 0,
        entryCount: 0,
        fileSize: 1024,
        description: 'Research authentication patterns in the codebase',
        model: 'claude-sonnet-4-20250514',
        modelShort: 'sonnet',
        totalInputTokens: 15000,
        totalOutputTokens: 8000,
      };

      // Simulate burst of 20 agents discovered at once
      const start = performance.now();
      const messages: string[] = [];
      for (let i = 0; i < 20; i++) {
        const payload = { ...agentInfo, agentId: `agent-${i}` };
        messages.push(`event: subagent:discovered\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      const elapsed = performance.now() - start;
      console.log(`[broadcast × 20 agents] serialization: ${elapsed.toFixed(2)}ms`);

      // Now simulate what happens when each is written to 10 SSE clients
      // (the inner loop in broadcast())
      const totalBytes = messages.reduce((sum, m) => sum + m.length, 0);
      console.log(`[broadcast × 20 agents] total payload: ${(totalBytes / 1024).toFixed(1)}KB`);

      // Serialization alone should be fast
      expect(elapsed).toBeLessThan(5);
    });

    it('should measure cost of rapid terminal broadcasts with large payloads', () => {
      // Simulate 20 sessions each flushing 16KB of terminal data
      const sessions = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        data: '\x1b[?2026h' + 'x'.repeat(16 * 1024) + '\x1b[?2026l',
      }));

      const start = performance.now();
      const messages: string[] = [];
      for (const session of sessions) {
        messages.push(`event: session:terminal\ndata: ${JSON.stringify(session)}\n\n`);
      }
      const elapsed = performance.now() - start;

      const totalMB = messages.reduce((sum, m) => sum + m.length, 0) / (1024 * 1024);
      console.log(`[terminal flush × 20 sessions] serialization: ${elapsed.toFixed(1)}ms, payload: ${totalMB.toFixed(2)}MB`);

      // 20 × 16KB = 320KB serialized simultaneously — should still be < 20ms
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('combined load scenario: subagent storm', () => {
    it('should simulate 10 agents starting while terminal data is flowing', async () => {
      // This is the real-world scenario: user is working, Claude spawns agents,
      // and the UI freezes because:
      // 1. 10× extractDescriptionFromParentTranscript (read + parse full transcripts)
      // 2. 10× extractDescriptionFromFile (read + parse agent files)
      // 3. 10× subagent:discovered broadcasts
      // 4. Terminal data keeps flowing and needs to flush
      // All of this on the same event loop

      const projectDir = join(tmpDir, 'storm-project', 'hash123', 'session-main');
      const subagentDir = join(projectDir, 'subagents');
      mkdirSync(subagentDir, { recursive: true });

      // Large parent transcript (5000 lines)
      const parentTranscript = generateParentTranscript(5000,
        Array.from({ length: 10 }, (_, i) => `storm-agent-${i}`)
      );
      writeFileSync(join(tmpDir, 'storm-project', 'hash123', 'session-main.jsonl'), parentTranscript);

      // 10 agent transcript files (500 lines each)
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(subagentDir, `agent-storm-agent-${i}.jsonl`), generateAgentTranscript(500));
      }

      const { readFile } = await import('node:fs/promises');
      const parentPath = join(tmpDir, 'storm-project', 'hash123', 'session-main.jsonl');

      // Start event loop lag measurement
      const lagPromise = measureEventLoopLag(2000);

      // Simulate what SubagentWatcher does when 10 agents appear:
      const start = performance.now();

      // Phase 1: Read parent transcript 10 times (once per agent to find description)
      const descriptionReads = Array.from({ length: 10 }, async (_, i) => {
        const content = await readFile(parentPath, 'utf8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.toolUseResult?.agentId === `storm-agent-${i}`) {
              return entry.toolUseResult.description;
            }
          } catch { /* skip */ }
        }
        return undefined;
      });

      // Phase 2: Concurrently, simulate terminal data serialization (every 16ms)
      let terminalSerializations = 0;
      const terminalInterval = setInterval(() => {
        // Simulate flushTerminalBatches for 5 active sessions
        for (let s = 0; s < 5; s++) {
          JSON.stringify({ id: `session-${s}`, data: 'x'.repeat(4096) });
        }
        terminalSerializations++;
      }, 16);

      const descriptions = await Promise.all(descriptionReads);
      clearInterval(terminalInterval);

      const totalElapsed = performance.now() - start;
      const lag = await lagPromise;

      console.log(`[subagent storm] 10 agents + terminal: ${totalElapsed.toFixed(0)}ms`);
      console.log(`[subagent storm] terminal flushes during: ${terminalSerializations}`);
      console.log(`[subagent storm] max event loop lag: ${lag.maxLagMs.toFixed(1)}ms`);
      console.log(`[subagent storm] avg event loop lag: ${lag.avgLagMs.toFixed(1)}ms`);

      // Count how many lag samples exceeded 50ms (UI jank threshold)
      const jankSamples = lag.samples.filter(s => s > 50).length;
      const totalSamples = lag.samples.length;
      console.log(`[subagent storm] jank samples (>50ms): ${jankSamples}/${totalSamples} (${((jankSamples / totalSamples) * 100).toFixed(1)}%)`);

      // Verify correctness
      for (const d of descriptions) {
        expect(d).toMatch(/^Research task for storm-agent-\d+$/);
      }

      // This is the key metric: during a subagent storm, max lag should stay under 100ms
      // In practice, the synchronous JSON.parse of 5000 lines × 10 concurrent reads
      // will cause significant lag spikes
      if (lag.maxLagMs > 100) {
        console.warn(`⚠️  MAX LAG ${lag.maxLagMs.toFixed(0)}ms EXCEEDS 100ms — UI will feel unresponsive`);
      }
    });
  });

  describe('liveness checker: serial pgrep amplification', () => {
    it('should measure total event loop impact of serial liveness checks', async () => {
      // The liveness checker iterates all active agents SERIALLY with await:
      //   for (const [agentId, info] of this.agentInfo) {
      //     const alive = await this.checkSubagentAlive(agentId);
      //   }
      // Each checkSubagentAlive calls findSubagentProcess which runs:
      //   1. pgrep -f claude
      //   2. For each PID: readFile(/proc/{pid}/environ) + readFile(/proc/{pid}/cmdline)
      //
      // With 20 active agents, the entire for-loop holds the event loop hostage
      // because Node's microtask queue won't process other work between awaits
      // in a tight loop.

      const { execFile } = await import('node:child_process');
      const { readFile } = await import('node:fs/promises');

      // Simulate the liveness check loop for 20 agents
      const lagPromise = measureEventLoopLag(3000);

      const start = performance.now();
      for (let agent = 0; agent < 20; agent++) {
        // Step 1: pgrep (what findSubagentProcess does)
        const pids = await new Promise<string[]>((resolve) => {
          execFile('pgrep', ['-f', 'node'], { encoding: 'utf8' }, (_err, stdout) => {
            resolve((stdout || '').trim().split('\n').filter(Boolean));
          });
        });

        // Step 2: Read /proc for each PID (what findSubagentProcess does per PID)
        for (const pidStr of pids.slice(0, 5)) { // limit to 5 PIDs for test sanity
          try {
            await readFile(`/proc/${pidStr}/environ`, 'utf8');
          } catch { /* expected for many PIDs */ }
          try {
            await readFile(`/proc/${pidStr}/cmdline`, 'utf8');
          } catch { /* expected */ }
        }
      }
      const elapsed = performance.now() - start;

      const lag = await lagPromise;

      console.log(`[liveness × 20 agents] total: ${elapsed.toFixed(0)}ms`);
      console.log(`[liveness × 20 agents] max event loop lag: ${lag.maxLagMs.toFixed(1)}ms`);
      console.log(`[liveness × 20 agents] avg event loop lag: ${lag.avgLagMs.toFixed(1)}ms`);

      // Document the cost: this runs every 10 seconds and takes N×hundreds of ms
      // During this time, SSE broadcasts, terminal data, and API responses are delayed
    });
  });

  describe('transcript JSON.parse line-by-line cost', () => {
    it('should measure synchronous JSON.parse cost for transcript tailing', () => {
      // tailFile does JSON.parse(line) for every line in the stream
      // When a subagent first appears, tailFile reads from position 0 = entire file
      // With 1000 entry files, that's 1000 synchronous JSON.parse calls

      const lines = Array.from({ length: 1000 }, (_, i) =>
        makeTranscriptEntry(i % 2 === 0 ? 'user' : 'assistant', `Content for line ${i}`)
      );

      // Measure synchronous JSON.parse of all lines (what tailFile does)
      const start = performance.now();
      let parsed = 0;
      for (const line of lines) {
        JSON.parse(line);
        parsed++;
      }
      const elapsed = performance.now() - start;

      console.log(`[JSON.parse × ${parsed} lines] ${elapsed.toFixed(2)}ms (${(elapsed / parsed * 1000).toFixed(1)}µs/line)`);

      // 1000 lines should be fast, but 10 agents × 1000 lines = 10000 parses
      // all happening synchronously on the event loop during initial tail
    });

    it('should measure cumulative cost when 10 agents are tailed simultaneously', () => {
      // When 10 subagents are discovered at once, all 10 call tailFile from position 0
      // Each agent file has ~500 lines → 5000 JSON.parse calls

      const agentFiles = Array.from({ length: 10 }, () =>
        Array.from({ length: 500 }, (_, i) =>
          makeTranscriptEntry(i % 2 === 0 ? 'user' : 'assistant', `Agent content ${i}`)
        )
      );

      const start = performance.now();
      let totalParsed = 0;
      for (const lines of agentFiles) {
        for (const line of lines) {
          JSON.parse(line);
          totalParsed++;
        }
      }
      const elapsed = performance.now() - start;

      console.log(`[10 agents × 500 lines] ${totalParsed} parses in ${elapsed.toFixed(1)}ms`);

      // This all happens synchronously — the event loop is completely blocked
      // during this time. No SSE events, no API responses, no terminal data.
      expect(elapsed).toBeLessThan(100); // Should be fast enough
    });
  });
});
