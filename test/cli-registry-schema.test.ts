/**
 * @fileoverview Validates the shipped stock catalog against `CliEntrySchema`, and proves the
 * schema actually rejects the shell-injection shapes it exists to block.
 *
 * Port: N/A (pure functions, no server).
 */

import { describe, expect, it } from 'vitest';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

describe('CliEntrySchema', () => {
  it('accepts every stock entry as shipped', () => {
    for (const entry of STOCK_CLIS) {
      const result = CliEntrySchema.safeParse(entry);
      if (!result.success) {
        throw new Error(`stock entry "${entry.id}" failed validation: ${result.error.message}`);
      }
    }
  });

  it('rejects unknown keys anywhere in the tree (.strict())', () => {
    const claude = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'claude')!;
    const withJunk = { ...claude, capabilities: { ...claude.capabilities, notARealField: true } };
    expect(CliEntrySchema.safeParse(withJunk).success).toBe(false);
  });

  it.each([
    ['semicolon', 'claude; rm -rf /'],
    ['command substitution', 'claude$(rm -rf /)'],
    ['backtick', 'claude`rm -rf /`'],
    ['pipe', 'claude | cat /etc/passwd'],
    ['redirect', 'claude > /etc/passwd'],
    ['ampersand background', 'claude & rm -rf /'],
    ['newline', 'claude\nrm -rf /'],
    ['single quote escape attempt', "claude' ; rm -rf /ETC #"],
    ['double quote escape attempt', 'claude" ; rm -rf /ETC #'],
    ['space (not a shell metachar but still not a bare word)', 'claude session'],
  ])('rejects a literal containing %s', (_label, hostileLit) => {
    const claude = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'claude')!;
    const tampered = {
      ...claude,
      launch: {
        ...claude.launch,
        variants: claude.launch.variants.map((v, i) =>
          i === 0 ? { ...v, args: [{ lit: hostileLit }, ...v.args.slice(1)] } : v
        ),
      },
    };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a flag value fixed literal containing shell metacharacters', () => {
    const codex = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'codex')!;
    const tampered = {
      ...codex,
      launch: {
        ...codex.launch,
        variants: [{ id: 'default', args: [{ lit: 'codex' }, { flag: '--config', value: 'x=$(whoami)' }] }],
      },
    };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a valueFrom referencing an undeclared param', () => {
    const codex = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'codex')!;
    const tampered = {
      ...codex,
      launch: {
        ...codex.launch,
        variants: [{ id: 'default', args: [{ lit: 'codex' }, { flag: '--model', valueFrom: 'nonexistentParam' }] }],
      },
    };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a capabilityGate condition referencing an undeclared gate', () => {
    const claude = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'claude')!;
    const tampered = {
      ...claude,
      launch: {
        ...claude.launch,
        variants: claude.launch.variants.map((v) => ({
          ...v,
          args: [...v.args, { flag: '--bogus', when: { capabilityGate: 'notARealGate' } }],
        })),
      },
    };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a fallback chain whose last variant has a `when` guard', () => {
    const claude = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'claude')!;
    const tampered = {
      ...claude,
      launch: {
        ...claude.launch,
        chain: 'fallback' as const,
        variants: [
          claude.launch.variants[0],
          { ...claude.launch.variants[1], when: { param: 'model', state: 'set' } as const },
        ],
      },
    };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects an overlay referencing an unknown launch variant', () => {
    const opencode = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'opencode')!;
    const tampered = { ...opencode, overlays: { ...opencode.overlays, remote: { variant: 'nonexistent' } } };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects an id that is not lowercase-kebab', () => {
    const claude = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'claude')!;
    expect(CliEntrySchema.safeParse({ ...claude, id: 'Claude Code' }).success).toBe(false);
    expect(CliEntrySchema.safeParse({ ...claude, id: 'CLAUDE' }).success).toBe(false);
    expect(CliEntrySchema.safeParse({ ...claude, id: '1claude' }).success).toBe(false);
  });

  it('rejects an env allowlist prefix that does not end with an underscore', () => {
    const codex = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'codex')!;
    const tampered = { ...codex, env: { ...codex.env, allowedPrefixes: ['CODEX'] } };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a too-short env allowlist prefix (defense against widening to a single-letter prefix)', () => {
    const codex = STOCK_CLIS.find((e) => (e.id as unknown as string) === 'codex')!;
    const tampered = { ...codex, env: { ...codex.env, allowedPrefixes: ['A_'] } };
    expect(CliEntrySchema.safeParse(tampered).success).toBe(false);
  });
});
