/**
 * @fileoverview Tests for the Custom Model Endpoint Profiles pure builder.
 * Uses the real CLI registry entries (getCli) rather than hand-rolled
 * fixtures, so a change to a real entry's customModelInjection declaration
 * is exercised here automatically instead of silently diverging.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { getCli } from '../src/config/cli-registry/index.js';
import { buildCustomModelInjection, withV1Suffix, type CustomModelEndpoint } from '../src/custom-model-injection.js';

const endpoint: CustomModelEndpoint = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'my-key',
};

function entryOrThrow(id: string) {
  const entry = getCli(id);
  if (!entry) throw new Error(`missing CLI registry entry: ${id}`);
  return entry;
}

describe('withV1Suffix', () => {
  it('appends /v1 when missing', () => {
    expect(withV1Suffix('http://host:8080')).toBe('http://host:8080/v1');
  });

  it('is idempotent when already present', () => {
    expect(withV1Suffix('http://host:8080/v1')).toBe('http://host:8080/v1');
    expect(withV1Suffix('http://host:8080/v1/')).toBe('http://host:8080/v1');
  });

  it('strips a trailing slash with no /v1', () => {
    expect(withV1Suffix('http://host:8080/')).toBe('http://host:8080/v1');
  });
});

describe('buildCustomModelInjection', () => {
  it('claude: env kind sets base URL, api key, and all three tier model vars', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3');
    expect(result.kind).toBe('env');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides).toEqual({
      ANTHROPIC_BASE_URL: 'http://192.168.1.50:8080',
      ANTHROPIC_API_KEY: 'my-key',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3',
    });
  });

  it('claude: falls back to a dummy key when the endpoint has none', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), { ...endpoint, apiKey: undefined }, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides.ANTHROPIC_API_KEY).toBe('local-dummy-key');
  });

  it('opencode: configContentEnv carries a JSON blob in OPENCODE_CONFIG_CONTENT', () => {
    const result = buildCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3');
    expect(result.kind).toBe('env');
    if (result.kind !== 'env') throw new Error('unreachable');
    const parsed = JSON.parse(result.envOverrides.OPENCODE_CONFIG_CONTENT);
    expect(parsed.model).toBe('custom/qwen3');
    expect(parsed.provider.custom.options.baseURL).toBe('http://192.168.1.50:8080/v1');
    expect(parsed.provider.custom.options.apiKey).toBe('my-key');
    expect(parsed.provider.custom.models.qwen3).toEqual({});
  });

  it('codex: configDir writes an isolated config.toml with model/base_url, and the key rides as extraEnv (never a literal TOML field)', () => {
    const result = buildCustomModelInjection(entryOrThrow('codex'), endpoint, 'qwen3');
    expect(result.kind).toBe('configDir');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('CODEX_HOME');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe('config.toml');
    expect(result.files[0].content).toContain('model = "qwen3"');
    expect(result.files[0].content).toContain('base_url = "http://192.168.1.50:8080/v1"');
    expect(result.files[0].content).toContain('wire_api = "responses"');
    expect(result.files[0].content).not.toContain('api_key ='); // never a literal TOML field
    expect(result.files[0].content).toContain('env_key = "CODEMAN_CUSTOM_MODEL_API_KEY"');
    expect(result.extraEnv).toEqual({ CODEMAN_CUSTOM_MODEL_API_KEY: 'my-key' });
  });

  it('codex: escapes a quote in the model id so it cannot break out of the TOML string', () => {
    const result = buildCustomModelInjection(entryOrThrow('codex'), endpoint, 'weird"model');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.files[0].content).toContain('model = "weird\\"model"');
  });

  it('pi: configDir writes models.json under agent/', () => {
    const result = buildCustomModelInjection(entryOrThrow('pi'), endpoint, 'qwen3');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('PI_CONFIG_DIR');
    expect(result.files[0].relPath).toBe('agent/models.json');
    const parsed = JSON.parse(result.files[0].content);
    expect(parsed.providers.custom.baseUrl).toBe('http://192.168.1.50:8080/v1');
  });

  it('omp: configDir writes models.yml under agent/, redirected via PI_CONFIG_DIR', () => {
    const result = buildCustomModelInjection(entryOrThrow('omp'), endpoint, 'qwen3');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('PI_CONFIG_DIR');
    expect(result.files[0].relPath).toBe('agent/models.yml');
    expect(result.files[0].content).toContain('baseUrl: "http://192.168.1.50:8080/v1"');
  });

  it('gemini: env kind sets GOOGLE_GEMINI_BASE_URL/GEMINI_API_KEY/GEMINI_MODEL', () => {
    const result = buildCustomModelInjection(entryOrThrow('gemini'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides).toEqual({
      GOOGLE_GEMINI_BASE_URL: 'http://192.168.1.50:8080',
      GEMINI_API_KEY: 'my-key',
      GEMINI_MODEL: 'qwen3',
    });
  });

  it('grok: env kind sets GROK_BASE_URL/XAI_API_KEY/GROK_MODEL', () => {
    const result = buildCustomModelInjection(entryOrThrow('grok'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides).toEqual({
      GROK_BASE_URL: 'http://192.168.1.50:8080',
      XAI_API_KEY: 'my-key',
      GROK_MODEL: 'qwen3',
    });
  });

  it('deepseek: env kind sets base URL/key only, no model var', () => {
    const result = buildCustomModelInjection(entryOrThrow('deepseek'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides).toEqual({
      DEEPSEEK_BASE_URL: 'http://192.168.1.50:8080',
      DEEPSEEK_API_KEY: 'my-key',
    });
  });

  it('antigravity: unsupported', () => {
    const result = buildCustomModelInjection(entryOrThrow('antigravity'), endpoint, 'qwen3');
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('shell: unsupported', () => {
    const result = buildCustomModelInjection(entryOrThrow('shell'), endpoint, 'qwen3');
    expect(result).toEqual({ kind: 'unsupported' });
  });
});
