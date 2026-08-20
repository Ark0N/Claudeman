/**
 * @fileoverview Keystone test for the CLI registry refactor: proves the new argv engine
 * (`renderLaunch` over the stock catalog) produces the SAME command string as the existing
 * hand-written `buildSpawnCommand` in tmux-manager.ts, across a matrix of inputs per mode.
 *
 * This is deliberately written against TODAY's code, before anything downstream is switched
 * over to the registry (Phase 0 of the plan is additive-only). Every later phase that moves
 * tmux-manager.ts onto the engine is then a refactor measured against this fixed baseline,
 * not a "does it look right" read of the diff.
 *
 * Port: N/A (pure functions, no server).
 */

import { describe, expect, it } from 'vitest';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { renderLaunch } from '../src/config/cli-registry/argv.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { ParamValues, EngineValues } from '../src/config/cli-registry/argv.js';
import type {
  AntigravityConfig,
  ClaudeMode,
  CodexConfig,
  EffortLevel,
  GeminiConfig,
  OpenCodeConfig,
  PiConfig,
} from '../src/types/session.js';

function entryFor(id: string) {
  const entry = STOCK_CLIS.find((e) => (e.id as unknown as string) === id);
  if (!entry) throw new Error(`no stock entry for ${id}`);
  return entry;
}

describe('CLI registry argv parity with buildSpawnCommand', () => {
  describe('claude', () => {
    const claude = entryFor('claude');

    it.each<{
      name: string;
      claudeMode?: ClaudeMode;
      allowedTools?: string;
      model?: string;
      resumeSessionId?: string;
      effort?: EffortLevel;
      sessionName?: string;
      cliVersion?: string | null;
    }>([
      { name: 'defaults, new session' },
      { name: 'skip-permissions explicit', claudeMode: 'dangerously-skip-permissions' },
      { name: 'auto mode', claudeMode: 'auto' },
      { name: 'allowedTools valid', claudeMode: 'allowedTools', allowedTools: 'Bash(git:*), Read' },
      {
        name: 'allowedTools with dangerous chars falls back',
        claudeMode: 'allowedTools',
        allowedTools: 'Bash(git:*); rm -rf /',
      },
      { name: 'normal mode', claudeMode: 'normal' },
      { name: 'with model', model: 'sonnet' },
      { name: 'with bracketed model alias', model: '[opus-4]' },
      { name: 'invalid model dropped', model: 'sonnet; rm -rf /' },
      { name: 'resume', resumeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890' },
      { name: 'invalid resume id dropped (falls to new)', resumeSessionId: 'not a uuid!' },
      { name: 'with effort level', effort: 'high' },
      { name: 'with ultracode effort', effort: 'ultracode' },
      { name: 'with session name, version below gate', sessionName: 'w1-testcase', cliVersion: '2.1.100' },
      { name: 'with session name, version at gate', sessionName: 'w1-testcase', cliVersion: '2.1.224' },
      { name: 'with session name, unknown version (fail-closed)', sessionName: 'w1-testcase', cliVersion: null },
      {
        name: 'everything at once, resume path',
        claudeMode: 'auto',
        model: 'opus',
        resumeSessionId: '11111111-1111-1111-1111-111111111111',
        effort: 'xhigh',
        sessionName: 'w2-full',
        cliVersion: '2.1.300',
      },
    ])('$name', (c) => {
      const sessionId = 'session-uuid-fixture';
      const legacy = buildSpawnCommand({
        mode: 'claude',
        sessionId,
        claudeMode: c.claudeMode,
        allowedTools: c.allowedTools,
        model: c.model,
        resumeSessionId: c.resumeSessionId,
        effort: c.effort,
        sessionName: c.sessionName,
        claudeCliVersion: c.cliVersion,
      });

      const params: ParamValues = {
        claudeMode: c.claudeMode,
        allowedTools: c.allowedTools,
        model: c.model,
        resumeId: c.resumeSessionId,
      };
      const engineValues: EngineValues = {
        sessionId,
        sessionName: c.sessionName,
      };
      // Mirror buildEffortCliArgs exactly: ultracode carries a fixed settings blob,
      // every other level rides a plain --effort <level> flag. The two are
      // mutually exclusive, matching the entry's two distinct engine values.
      if (c.effort === 'ultracode') {
        engineValues.effortSettingsJson = '{"ultracode":true}';
      } else if (c.effort) {
        engineValues.effortLevel = c.effort;
      }
      const gatesPassed = new Set<string>();
      if (c.cliVersion && c.cliVersion >= '2.1.224') gatesPassed.add('nameFlag');

      const rendered = renderLaunch(claude.launch, params, engineValues, gatesPassed);
      expect(rendered).toBe(legacy);
    });
  });

  describe('opencode', () => {
    const opencode = entryFor('opencode');

    it.each<{ name: string; config?: OpenCodeConfig }>([
      { name: 'no config' },
      { name: 'model only', config: { model: 'anthropic/claude-sonnet-4-5' } },
      { name: 'invalid model dropped', config: { model: 'bad model!' } },
      { name: 'session id', config: { continueSession: 'sess-123' } },
      { name: 'session id + fork', config: { continueSession: 'sess-123', forkSession: true } },
      { name: 'fork without session id is a no-op', config: { forkSession: true } },
      { name: 'invalid session id dropped', config: { continueSession: 'bad id!' } },
    ])('$name', ({ config }) => {
      const legacy = buildSpawnCommand({ mode: 'opencode', sessionId: 'x', openCodeConfig: config });
      const params: ParamValues = {
        model: config?.model,
        resumeId: config?.continueSession,
        forkSession: config?.forkSession,
      };
      const rendered = renderLaunch(opencode.launch, params, {});
      expect(rendered).toBe(legacy);
    });
  });

  describe('codex', () => {
    const codex = entryFor('codex');

    it.each<{ name: string; config?: CodexConfig }>([
      { name: 'no config' },
      { name: 'bypass approvals', config: { dangerouslyBypassApprovals: true } },
      { name: 'animations on', config: { animations: true } },
      { name: 'animations off', config: { animations: false } },
      { name: 'model', config: { model: 'gpt-5' } },
      { name: 'resume', config: { resumeSessionId: 'abc-123' } },
      { name: 'invalid resume dropped', config: { resumeSessionId: 'bad id!' } },
      {
        name: 'everything',
        config: { dangerouslyBypassApprovals: true, animations: false, model: 'o4-mini', resumeSessionId: 'sess-1' },
      },
    ])('$name', ({ config }) => {
      const legacy = buildSpawnCommand({ mode: 'codex', sessionId: 'x', codexConfig: config });
      const params: ParamValues = {
        bypassApprovals: config?.dangerouslyBypassApprovals,
        animations: config?.animations,
        model: config?.model,
        resumeId: config?.resumeSessionId,
      };
      const rendered = renderLaunch(codex.launch, params, {});
      expect(rendered).toBe(legacy);
    });
  });

  describe('gemini', () => {
    const gemini = entryFor('gemini');

    it.each<{ name: string; config?: GeminiConfig }>([
      { name: 'defaults (yolo)' },
      { name: 'explicit approval mode', config: { approvalMode: 'plan' } },
      { name: 'model', config: { model: 'gemini-2.5-pro' } },
      { name: 'resume', config: { resumeSession: 'latest' } },
      { name: 'everything', config: { approvalMode: 'auto_edit', model: 'gemini-2.5-flash', resumeSession: 'sess.1' } },
    ])('$name', ({ config }) => {
      const legacy = buildSpawnCommand({ mode: 'gemini', sessionId: 'x', geminiConfig: config });
      const params: ParamValues = {
        approvalMode: config?.approvalMode,
        model: config?.model,
        resumeId: config?.resumeSession,
      };
      const rendered = renderLaunch(gemini.launch, params, {});
      expect(rendered).toBe(legacy);
    });
  });

  describe('antigravity', () => {
    const antigravity = entryFor('antigravity');

    it.each<{ name: string; config?: AntigravityConfig }>([
      { name: 'no config (prompting default)' },
      { name: 'skip permissions', config: { dangerouslySkipPermissions: true } },
      { name: 'model', config: { model: 'gemini-3-pro' } },
      { name: 'resume', config: { resumeConversationId: 'conv.1' } },
      {
        name: 'everything',
        config: { dangerouslySkipPermissions: true, model: 'gemini-3-flash', resumeConversationId: 'conv.2' },
      },
    ])('$name', ({ config }) => {
      const legacy = buildSpawnCommand({ mode: 'antigravity', sessionId: 'x', antigravityConfig: config });
      const params: ParamValues = {
        dangerouslySkipPermissions: config?.dangerouslySkipPermissions,
        model: config?.model,
        resumeId: config?.resumeConversationId,
      };
      const rendered = renderLaunch(antigravity.launch, params, {});
      expect(rendered).toBe(legacy);
    });
  });

  describe('pi', () => {
    const pi = entryFor('pi');

    it.each<{ name: string; config?: PiConfig }>([
      { name: 'no config' },
      { name: 'approve', config: { approveProjectTrust: true } },
      { name: 'no-approve', config: { approveProjectTrust: false } },
      { name: 'model with thinking suffix', config: { model: 'sonnet:high' } },
      { name: 'model provider/id', config: { model: 'openai/gpt-4o' } },
      { name: 'provider', config: { provider: 'anthropic' } },
      { name: 'thinking level', config: { thinking: 'xhigh' } },
      { name: 'continue session', config: { continueSession: true } },
      { name: 'resume session wins over continue', config: { continueSession: true, resumeSessionId: 'sess.1' } },
      { name: 'resume session alone', config: { resumeSessionId: 'sess.1' } },
      {
        name: 'everything, no resume',
        config: {
          approveProjectTrust: true,
          model: 'sonnet:high',
          provider: 'anthropic',
          thinking: 'high',
          continueSession: true,
        },
      },
    ])('$name', ({ config }) => {
      const legacy = buildSpawnCommand({ mode: 'pi', sessionId: 'x', piConfig: config });
      const params: ParamValues = {
        approveProjectTrust: config?.approveProjectTrust,
        model: config?.model,
        provider: config?.provider,
        thinking: config?.thinking,
        resumeId: config?.resumeSessionId,
        continueSession: config?.continueSession,
      };
      const rendered = renderLaunch(pi.launch, params, {});
      expect(rendered).toBe(legacy);
    });
  });
});
