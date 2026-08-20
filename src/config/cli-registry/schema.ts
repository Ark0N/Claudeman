/**
 * @fileoverview Zod validation for CLI registry entries.
 *
 * Every object here is `.strict()`: an unknown key is a hard validation error, not a
 * silently-ignored one. That matters for a security-relevant schema — a typo in a field name
 * must never degrade to "field absent, so the permissive default applies".
 *
 * The load-bearing rule enforced here is `SHELL_TOKEN`: it is what makes it impossible for a
 * `clis.json` entry to smuggle shell metacharacters into the eventual `bash -c "..."` string
 * (see argv.ts's file header for the full model).
 *
 * @module config/cli-registry/schema
 */

import { z } from 'zod';
import { TOKEN_PATTERNS } from './patterns.js';

/** A bare CLI id: lowercase, starts with a letter, at most 24 chars. Also used as a CSS/URL token. */
const cliId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,23}$/, 'id must be lowercase, start with a letter, and be at most 24 chars');

/** An env var name. */
const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'env var name must be UPPER_SNAKE_CASE')
  .max(64);

/**
 * A shell-safe bare word: no space, quote, backtick, `$`, `;`, `&`, `|`, `<`, `>`, parens,
 * braces, newline or backslash. Every LITERAL in the launch spec (base command, flag names,
 * fixed values) must satisfy this — see argv.ts's file header.
 */
const shellToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@=+/,-]+$/, 'must be a plain word with no shell metacharacters');

const flagToken = z.string().regex(/^--?[A-Za-z0-9][A-Za-z0-9-]*$/, 'must look like -x or --long-flag');

const quoteStyle = z.enum(['auto', 'bare', 'double', 'single']);

const condSchema: z.ZodType<import('./types.js').Cond> = z.lazy(() =>
  z.union([
    z.object({ param: z.string(), is: z.union([z.string(), z.boolean()]) }).strict(),
    z.object({ param: z.string(), state: z.enum(['set', 'unset']) }).strict(),
    z.object({ allOf: z.array(condSchema).min(1).max(8) }).strict(),
    z.object({ anyOf: z.array(condSchema).min(1).max(8) }).strict(),
    z.object({ not: condSchema }).strict(),
    z.object({ capabilityGate: z.string() }).strict(),
  ])
);

const paramSpecSchema = z.union([
  z
    .object({ type: z.literal('enum'), values: z.array(z.string()).min(1).max(16), default: z.string().optional() })
    .strict(),
  z.object({ type: z.literal('bool') }).strict(),
  z.object({ type: z.literal('token'), pattern: z.enum(TOKEN_PATTERNS as [string, ...string[]]) }).strict(),
  z
    .object({
      type: z.literal('engine'),
      source: z.enum(['sessionId', 'sessionName', 'muxName', 'effortLevel', 'effortSettingsJson']),
    })
    .strict(),
]);

const argSpecSchema = z.union([
  z.object({ lit: shellToken, when: condSchema.optional() }).strict(),
  z.object({ flag: flagToken, when: condSchema.optional() }).strict(),
  z.object({ flag: flagToken, value: shellToken, quote: quoteStyle.optional(), when: condSchema.optional() }).strict(),
  z
    .object({ flag: flagToken, valueFrom: z.string(), quote: quoteStyle.optional(), when: condSchema.optional() })
    .strict(),
  z.object({ valueFrom: z.string(), quote: quoteStyle.optional(), when: condSchema.optional() }).strict(),
]);

const variantSchema = z
  .object({
    id: z.string().min(1).max(40),
    when: condSchema.optional(),
    // min(0): the `shell` entry declares a variant with no args — tmux-manager resolves the
    // real login shell in code, since it varies per remote user's /etc/passwd entry.
    args: z.array(argSpecSchema).max(32),
  })
  .strict();

const launchSchema = z
  .object({
    params: z.record(z.string(), paramSpecSchema),
    chain: z.enum(['first', 'fallback']).optional(),
    variants: z.array(variantSchema).min(1).max(4),
  })
  .strict()
  .superRefine((launch, ctx) => {
    const paramNames = new Set(Object.keys(launch.params));
    const checkValueFrom = (name: string, path: (string | number)[]) => {
      if (!paramNames.has(name)) {
        ctx.addIssue({ code: 'custom', message: `valueFrom "${name}" is not a declared param`, path });
      }
    };
    launch.variants.forEach((variant, vi) => {
      variant.args.forEach((arg, ai) => {
        if ('valueFrom' in arg) checkValueFrom(arg.valueFrom, ['variants', vi, 'args', ai, 'valueFrom']);
      });
    });
    if (launch.chain === 'fallback') {
      const last = launch.variants.at(-1);
      if (last?.when) {
        ctx.addIssue({
          code: 'custom',
          message: 'the last variant of a fallback chain must have no `when` (it must be the guaranteed terminal case)',
          path: ['variants', launch.variants.length - 1, 'when'],
        });
      }
    }
  });

const versionProbeSchema = z
  .object({
    arg: shellToken,
    regex: z.string().max(200).optional(),
    requireVersionMatch: z.boolean().optional(),
    retryOnTransientFailure: z.boolean().optional(),
  })
  .strict();

const discoverySchema = z
  .object({
    // min(0): the `shell` entry has no binary of its own (it resolves the login shell in code).
    binaries: z.array(shellToken).max(4),
    searchDirs: z.array(z.string().max(300)).max(16),
    version: versionProbeSchema.optional(),
    install: z
      .object({
        // z.record with an enum key type requires every enum member in Zod v4; the install
        // command legitimately varies by platform and most entries only need one or two, so
        // this is a plain object of optional platform keys instead.
        command: z
          .object({
            linux: z.string().max(500).optional(),
            darwin: z.string().max(500).optional(),
            wsl: z.string().max(500).optional(),
            win32: z.string().max(500).optional(),
          })
          .strict(),
        npmPackage: z.string().max(200).optional(),
        docsUrl: z.url().optional(),
      })
      .strict(),
  })
  .strict();

const envExportSchema = z
  .object({
    name: envName,
    value: z.union([
      shellToken,
      z
        .object({ engine: z.enum(['sessionId', 'sessionName', 'muxName', 'effortLevel', 'effortSettingsJson']) })
        .strict(),
    ]),
    when: condSchema.optional(),
  })
  .strict();

const envSchema = z
  .object({
    exports: z.array(envExportSchema).max(16),
    unset: z.array(envName).max(16),
    tmuxSetenvKeys: z.array(envName).max(32),
    dockerExecEnvNames: z.array(envName).max(32),
    allowedPrefixes: z
      .array(
        z
          .string()
          .min(3)
          .max(32)
          .regex(/^[A-Z][A-Z0-9_]*_$/)
      )
      .max(8),
    allowedKeys: z.array(envName).max(8),
    configContentVar: envName.optional(),
  })
  .strict();

const echoSchema = z
  .object({
    policy: z.enum(['buffer', 'predict', 'off']),
    anchor: z.union([
      z
        .object({ kind: z.literal('glyph'), glyph: z.string().min(1).max(4), offset: z.number().int().min(0).max(16) })
        .strict(),
      z.object({ kind: z.literal('cursor') }).strict(),
      z.object({ kind: z.literal('none') }).strict(),
    ]),
    predictProfile: z.string().max(40).optional(),
  })
  .strict();

const capabilitiesSchema = z
  .object({
    requiresMux: z.boolean(),
    hooks: z.boolean(),
    transcript: z.enum(['claude-jsonl', 'codex-rollout', 'none']),
    altScreen: z.enum(['strip-full', 'strip-mux-only', 'preserve']),
    echo: echoSchema,
    wheelForward: z
      .object({ mode: z.enum(['never', 'version-gated']), minVersion: z.string().max(20).optional() })
      .strict(),
    keyboardAccessory: z.enum(['agent', 'shell']),
    privilegedCommandGate: z.boolean(),
    startMode: z.enum(['interactive', 'shell']),
    stripInkBloat: z.boolean(),
    ralph: z.boolean(),
    respawn: z.boolean(),
    effort: z.boolean(),
    agentSkillInjection: z.boolean(),
    statusLineTelemetry: z.boolean(),
    model: z
      .object({ source: z.enum(['flag', 'claude-settings-file', 'none']), param: z.string().optional() })
      .strict(),
    privilegedParams: z
      .array(z.object({ param: z.string(), clampTo: z.union([z.boolean(), z.string()]) }).strict())
      .max(8),
    gates: z.record(z.string(), z.object({ minVersion: z.string().max(20), failClosed: z.boolean() }).strict()),
    maxFrameBytes: z.number().int().positive().optional(),
  })
  .strict();

const credStoreSchema = z
  .object({
    rel: z.string().min(1).max(100),
    shareDirs: z.array(z.string().max(100)).optional(),
    shareFiles: z.array(z.string().max(100)).optional(),
    seedFiles: z.array(z.string().max(100)).optional(),
    seedWhole: z.boolean().optional(),
  })
  .strict();

const overlayTargetSchema = z.union([
  z.object({ variant: z.string().min(1).max(40) }).strict(),
  z.object({ disabled: z.literal(true) }).strict(),
]);

const overlaysSchema = z
  .object({
    remote: overlayTargetSchema,
    docker: overlayTargetSchema,
    credStore: credStoreSchema.optional(),
  })
  .strict();

export const CliEntrySchema = z
  .object({
    id: cliId,
    label: z.string().min(1).max(60),
    shortBadge: z.string().min(1).max(6),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accent must be a 6-digit hex colour'),
    enabled: z.boolean(),
    stock: z.boolean(),
    order: z.number().int(),
    kind: z.enum(['agent', 'shell']),
    discovery: discoverySchema,
    launch: launchSchema,
    env: envSchema,
    capabilities: capabilitiesSchema,
    overlays: overlaysSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    const variantIds = new Set(entry.launch.variants.map((v) => v.id));
    for (const target of [entry.overlays.remote, entry.overlays.docker]) {
      if ('variant' in target && !variantIds.has(target.variant)) {
        ctx.addIssue({ code: 'custom', message: `overlay references unknown launch variant "${target.variant}"` });
      }
    }
    const gateNames = new Set(Object.keys(entry.capabilities.gates));
    const walkConds = (cond: import('./types.js').Cond | undefined) => {
      if (!cond) return;
      if ('capabilityGate' in cond && !gateNames.has(cond.capabilityGate)) {
        ctx.addIssue({
          code: 'custom',
          message: `capabilityGate "${cond.capabilityGate}" is not declared in capabilities.gates`,
        });
      }
      if ('allOf' in cond) cond.allOf.forEach(walkConds);
      if ('anyOf' in cond) cond.anyOf.forEach(walkConds);
      if ('not' in cond) walkConds(cond.not);
    };
    for (const variant of entry.launch.variants) {
      walkConds(variant.when);
      for (const arg of variant.args) walkConds(arg.when);
    }
  });

export type ValidatedCliEntry = z.infer<typeof CliEntrySchema>;
