/**
 * @fileoverview Unit tests for the Read My Mind intent store (src/intent-store.ts).
 *
 * Pure helpers (key derivation, capturability filter, sanitization, append fold)
 * plus the IO layer against a per-test temp data dir (CODEMAN_DATA_DIR) so
 * nothing touches the real ~/.codeman. No server, no tmux.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendPrompt,
  deriveIntentKey,
  IntentStore,
  isCapturablePrompt,
  MAX_GOALS_CHARS,
  MAX_INTENT_PROFILES,
  MAX_PROMPT_CHARS,
  MAX_RECENT_PROMPTS,
  sanitizePromptText,
} from '../src/intent-store.js';
import type { IntentProfile } from '../src/types/index.js';

let tmpDir: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-intents-'));
  savedDataDir = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = savedDataDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const intentsFile = () => path.join(tmpDir, 'intents.json');

function makeProfile(overrides: Partial<IntentProfile> = {}): IntentProfile {
  return { key: 'k', workingDir: '/w', updatedAt: 0, goals: '', recentPrompts: [], ...overrides };
}

describe('deriveIntentKey', () => {
  it('is stable and 16 lowercase hex chars', () => {
    const a = deriveIntentKey('alice', '/home/alice/proj');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveIntentKey('alice', '/home/alice/proj')).toBe(a);
  });

  it('separates owners and directories', () => {
    expect(deriveIntentKey('alice', '/p')).not.toBe(deriveIntentKey('bob', '/p'));
    expect(deriveIntentKey('alice', '/p')).not.toBe(deriveIntentKey('alice', '/q'));
    expect(deriveIntentKey(undefined, '/p')).not.toBe(deriveIntentKey('alice', '/p'));
  });
});

describe('isCapturablePrompt', () => {
  it('rejects local command echo and system wrappers', () => {
    expect(isCapturablePrompt('<command-name>/model</command-name>')).toBe(false);
    expect(isCapturablePrompt('before <local-command-stdout>out</local-command-stdout>')).toBe(false);
    expect(isCapturablePrompt('<system-reminder>context</system-reminder>')).toBe(false);
    expect(isCapturablePrompt('Caveat: The messages below were generated…')).toBe(false);
    expect(isCapturablePrompt('[Request interrupted by user]')).toBe(false);
  });

  it('accepts a normal prompt', () => {
    expect(isCapturablePrompt('fix the login bug and add a test')).toBe(true);
  });
});

describe('sanitizePromptText', () => {
  it('collapses newlines and strips control chars', () => {
    expect(sanitizePromptText('line one\nline two\r\nthree')).toBe('line one line two three');
    expect(sanitizePromptText('a\x1b[31mred\x1b[0mb end')).toBe('a[31mred[0mb end');
  });

  it('returns null for menu-digit noise', () => {
    expect(sanitizePromptText('1')).toBeNull();
    expect(sanitizePromptText('  \n ')).toBeNull();
  });

  it('truncates to the cap', () => {
    const out = sanitizePromptText('x'.repeat(MAX_PROMPT_CHARS + 100));
    expect(out).toHaveLength(MAX_PROMPT_CHARS);
  });
});

describe('appendPrompt', () => {
  it('collapses consecutive duplicates but keeps non-adjacent ones', () => {
    let p = makeProfile();
    p = appendPrompt(p, { ts: 1, sessionId: 's', text: 'continue' });
    p = appendPrompt(p, { ts: 2, sessionId: 's', text: 'continue' });
    expect(p.recentPrompts).toHaveLength(1);
    expect(p.updatedAt).toBe(2);
    p = appendPrompt(p, { ts: 3, sessionId: 's', text: 'run tests' });
    p = appendPrompt(p, { ts: 4, sessionId: 's', text: 'continue' });
    expect(p.recentPrompts.map((e) => e.text)).toEqual(['continue', 'run tests', 'continue']);
  });

  it('FIFO-caps at MAX_RECENT_PROMPTS, dropping the oldest', () => {
    let p = makeProfile();
    for (let i = 0; i < MAX_RECENT_PROMPTS + 5; i++) {
      p = appendPrompt(p, { ts: i, sessionId: 's', text: `prompt number ${i}` });
    }
    expect(p.recentPrompts).toHaveLength(MAX_RECENT_PROMPTS);
    expect(p.recentPrompts[0].text).toBe('prompt number 5');
  });
});

describe('IntentStore', () => {
  it('records a prompt, persists 0600, and reloads from disk', () => {
    const store = new IntentStore();
    expect(store.recordPrompt('alice', tmpDir, 'sess1', 'ship the release')).toBe(true);
    expect(existsSync(intentsFile())).toBe(true);
    expect(statSync(intentsFile()).mode & 0o777).toBe(0o600);

    const reloaded = new IntentStore();
    const profile = reloaded.getProfile('alice', tmpDir);
    expect(profile.recentPrompts.map((e) => e.text)).toEqual(['ship the release']);
    expect(profile.updatedAt).toBeGreaterThan(0);
  });

  it('getProfile on an absent case returns an empty transient profile without persisting', () => {
    const store = new IntentStore();
    const profile = store.getProfile('alice', tmpDir);
    expect(profile.updatedAt).toBe(0);
    expect(profile.goals).toBe('');
    expect(profile.recentPrompts).toEqual([]);
    expect(existsSync(intentsFile())).toBe(false);
  });

  it('filters uncapturable and too-short prompts', () => {
    const store = new IntentStore();
    expect(store.recordPrompt('a', tmpDir, 's', '<command-name>/clear</command-name>')).toBe(false);
    expect(store.recordPrompt('a', tmpDir, 's', '2')).toBe(false);
    expect(existsSync(intentsFile())).toBe(false);
  });

  it('keys by resolved directory so path spellings converge', () => {
    const store = new IntentStore();
    store.recordPrompt('a', `${tmpDir}${path.sep}.`, 's', 'same case either way');
    const profile = store.getProfile('a', tmpDir);
    expect(profile.recentPrompts).toHaveLength(1);
  });

  it('separates owners of the same directory', () => {
    const store = new IntentStore();
    store.recordPrompt('alice', tmpDir, 's', 'alice private plan');
    expect(store.getProfile('bob', tmpDir).recentPrompts).toEqual([]);
  });

  it('setGoals bounds the text and deleteProfile forgets the case', () => {
    const store = new IntentStore();
    const updated = store.setGoals('a', tmpDir, 'g'.repeat(MAX_GOALS_CHARS + 50));
    expect(updated.goals).toHaveLength(MAX_GOALS_CHARS);

    expect(store.deleteProfile('a', tmpDir)).toBe(true);
    expect(store.deleteProfile('a', tmpDir)).toBe(false);
    expect(store.getProfile('a', tmpDir).goals).toBe('');
  });

  it('evicts the least-recently-updated profile past the cap', () => {
    const store = new IntentStore();
    for (let i = 0; i <= MAX_INTENT_PROFILES; i++) {
      store.setGoals('a', `${tmpDir}/case-${i}`, `goal ${i}`);
    }
    const reloaded = new IntentStore();
    expect(reloaded.getProfile('a', `${tmpDir}/case-0`).goals).toBe('');
    expect(reloaded.getProfile('a', `${tmpDir}/case-${MAX_INTENT_PROFILES}`).goals).toBe(`goal ${MAX_INTENT_PROFILES}`);
  });

  it('starts empty on a corrupted state file', () => {
    const store = new IntentStore();
    store.setGoals('a', tmpDir, 'valid');
    return fs.writeFile(intentsFile(), '{ not json').then(() => {
      const reloaded = new IntentStore();
      expect(reloaded.getProfile('a', tmpDir).goals).toBe('');
      expect(reloaded.recordPrompt('a', tmpDir, 's', 'recover cleanly')).toBe(true);
    });
  });
});
