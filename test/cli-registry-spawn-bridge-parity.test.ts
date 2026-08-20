/**
 * @fileoverview Proves `buildSpawnCommandFromRegistry()` — the bridge that will replace
 * `buildSpawnCommand`'s per-mode if-chain in tmux-manager.ts — renders BYTE-IDENTICAL output
 * to the legacy builder from the EXACT SAME options object, across the same permutation
 * matrix as `test/cli-registry-argv-parity.test.ts`. That file proves the argv engine itself
 * is correct; this one proves the legacy-config-to-params WIRING (legacyConfigAliases, the
 * claude synthetic config, the effort/gate plumbing) is correct end to end.
 *
 * Port: N/A (pure functions, no server).
 */

import { describe, expect, it } from 'vitest';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { buildSpawnCommandFromRegistry, type SpawnBridgeOptions } from '../src/session-cli-registry-bridge.js';
import { getCli } from '../src/config/cli-registry/registry.js';

function entryFor(id: string) {
  const entry = getCli(id);
  if (!entry) throw new Error(`no stock entry for ${id}`);
  return entry;
}

function bothRender(options: SpawnBridgeOptions): { legacy: string; bridged: string | undefined } {
  return {
    legacy: buildSpawnCommand(options as Parameters<typeof buildSpawnCommand>[0]),
    bridged: buildSpawnCommandFromRegistry(entryFor(options.mode), options),
  };
}

describe('buildSpawnCommandFromRegistry parity with buildSpawnCommand', () => {
  it('shell returns undefined (caller falls back to local login-shell resolution)', () => {
    expect(buildSpawnCommandFromRegistry(entryFor('shell'), { mode: 'shell', sessionId: 'x' })).toBeUndefined();
  });

  describe('claude', () => {
    it.each<Partial<SpawnBridgeOptions>>([
      {},
      { claudeMode: 'auto' },
      { claudeMode: 'allowedTools', allowedTools: 'Bash(git:*), Read' },
      { model: 'opus' },
      { model: '[opus-4]' },
      { resumeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890' },
      { effort: 'high' },
      { effort: 'ultracode' },
      { sessionName: 'w1-testcase', claudeCliVersion: '2.1.300' },
      { sessionName: 'w1-testcase', claudeCliVersion: '2.1.100' },
      { sessionName: 'w1-testcase', claudeCliVersion: null },
      {
        claudeMode: 'auto',
        model: 'sonnet',
        resumeSessionId: '11111111-1111-1111-1111-111111111111',
        effort: 'xhigh',
        sessionName: 'w2-full',
        claudeCliVersion: '2.1.300',
      },
    ])('%#', (overrides) => {
      const { legacy, bridged } = bothRender({ mode: 'claude', sessionId: 'session-uuid-fixture', ...overrides });
      expect(bridged).toBe(legacy);
    });
  });

  describe('opencode', () => {
    it.each<Partial<SpawnBridgeOptions>>([
      {},
      { openCodeConfig: { model: 'anthropic/claude-sonnet-4-5' } },
      { openCodeConfig: { continueSession: 'sess-123' } },
      { openCodeConfig: { continueSession: 'sess-123', forkSession: true } },
      { openCodeConfig: { model: 'bad model!' } },
    ])('%#', (overrides) => {
      const { legacy, bridged } = bothRender({ mode: 'opencode', sessionId: 'x', ...overrides });
      expect(bridged).toBe(legacy);
    });
  });

  describe('codex', () => {
    it.each<Partial<SpawnBridgeOptions>>([
      {},
      { codexConfig: { dangerouslyBypassApprovals: true } },
      { codexConfig: { animations: true } },
      { codexConfig: { animations: false } },
      { codexConfig: { model: 'gpt-5' } },
      { codexConfig: { resumeSessionId: 'abc-123' } },
      {
        codexConfig: {
          dangerouslyBypassApprovals: true,
          animations: false,
          model: 'o4-mini',
          resumeSessionId: 'sess-1',
        },
      },
    ])('%#', (overrides) => {
      const { legacy, bridged } = bothRender({ mode: 'codex', sessionId: 'x', ...overrides });
      expect(bridged).toBe(legacy);
    });
  });

  describe('gemini', () => {
    it.each<Partial<SpawnBridgeOptions>>([
      {},
      { geminiConfig: { approvalMode: 'plan' } },
      { geminiConfig: { model: 'gemini-2.5-pro' } },
      { geminiConfig: { resumeSession: 'latest' } },
      { geminiConfig: { approvalMode: 'auto_edit', model: 'gemini-2.5-flash', resumeSession: 'sess.1' } },
    ])('%#', (overrides) => {
      const { legacy, bridged } = bothRender({ mode: 'gemini', sessionId: 'x', ...overrides });
      expect(bridged).toBe(legacy);
    });
  });

  describe('antigravity', () => {
    it.each<Partial<SpawnBridgeOptions>>([
      {},
      { antigravityConfig: { dangerouslySkipPermissions: true } },
      { antigravityConfig: { model: 'gemini-3-pro' } },
      { antigravityConfig: { resumeConversationId: 'conv.1' } },
      {
        antigravityConfig: {
          dangerouslySkipPermissions: true,
          model: 'gemini-3-flash',
          resumeConversationId: 'conv.2',
        },
      },
    ])('%#', (overrides) => {
      const { legacy, bridged } = bothRender({ mode: 'antigravity', sessionId: 'x', ...overrides });
      expect(bridged).toBe(legacy);
    });
  });

  describe('pi', () => {
    it.each<Partial<SpawnBridgeOptions>>([
      {},
      { piConfig: { approveProjectTrust: true } },
      { piConfig: { approveProjectTrust: false } },
      { piConfig: { model: 'sonnet:high' } },
      { piConfig: { model: 'openai/gpt-4o' } },
      { piConfig: { provider: 'anthropic' } },
      { piConfig: { thinking: 'xhigh' } },
      { piConfig: { continueSession: true } },
      { piConfig: { continueSession: true, resumeSessionId: 'sess.1' } },
      { piConfig: { resumeSessionId: 'sess.1' } },
      {
        piConfig: {
          approveProjectTrust: true,
          model: 'sonnet:high',
          provider: 'anthropic',
          thinking: 'high',
          continueSession: true,
        },
      },
    ])('%#', (overrides) => {
      const { legacy, bridged } = bothRender({ mode: 'pi', sessionId: 'x', ...overrides });
      expect(bridged).toBe(legacy);
    });
  });
});
