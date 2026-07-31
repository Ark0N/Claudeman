/**
 * COD-91 — `refreshStaleCodemanHooks` self-heal.
 *
 * Making the hook-event secret unconditionally required (PR #127) would silently 401 the
 * hook curls baked into cases created before the secret header existed (COD-54). Those
 * curls live in `.claude/settings.local.json` and `writeHooksConfig` only runs at case
 * CREATION, so existing cases never refresh. `refreshStaleCodemanHooks` regenerates the
 * hooks block on session spawn — but ONLY when the case already holds Codeman's own
 * pre-secret hook curls, never clobbering a user's customizations.
 *
 * Pure filesystem logic against a temp dir — no port / server / tmux.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshStaleCodemanHooks } from '../src/hooks-config.js';

const SECRET_HEADER = 'X-Codeman-Hook-Secret';

// A faithful pre-secret Codeman hook curl (what cases created before COD-54 contain):
// targets /api/hook-event, but with NO X-Codeman-Hook-Secret header.
function staleCodemanHooks() {
  return {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command:
              "HOOK_DATA=$(cat 2>/dev/null || echo '{}'); " +
              'printf \'{"event":"stop","sessionId":"%s","data":%s}\' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ' +
              'curl -s -X POST "$CODEMAN_API_URL/api/hook-event" -H \'Content-Type: application/json\' --data @- 2>/dev/null || true',
            timeout: 5,
          },
        ],
      },
    ],
  };
}

describe('refreshStaleCodemanHooks', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-selfheal-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    settingsPath = join(dir, '.claude', 'settings.local.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the secret header to a stale Codeman hooks block and preserves other keys', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { CLAUDE_CODE_FOO: '1' }, model: 'opus', hooks: staleCodemanHooks() }, null, 2)
    );
    await refreshStaleCodemanHooks(dir);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(JSON.stringify(after.hooks)).toContain(SECRET_HEADER);
    expect(JSON.stringify(after.hooks)).toContain('CODEMAN_HOOK_SECRET_FILE');
    // sibling keys untouched
    expect(after.env).toEqual({ CLAUDE_CODE_FOO: '1' });
    expect(after.model).toBe('opus');
  });

  it('leaves a hooks block that already carries the secret unchanged', async () => {
    // Seed with a current block by healing a stale one first, then re-heal: second pass must no-op.
    writeFileSync(settingsPath, JSON.stringify({ hooks: staleCodemanHooks() }, null, 2));
    await refreshStaleCodemanHooks(dir);
    const healed = readFileSync(settingsPath, 'utf-8');
    expect(healed).toContain(SECRET_HEADER);

    await refreshStaleCodemanHooks(dir);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(healed); // byte-identical: no rewrite
  });

  it('does not touch hooks that are not Codeman’s (no /api/hook-event)', async () => {
    const foreign = JSON.stringify(
      { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }] } },
      null,
      2
    );
    writeFileSync(settingsPath, foreign);
    await refreshStaleCodemanHooks(dir);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(foreign);
  });

  it('preserves user handlers and events in a mixed stale configuration', async () => {
    const hooks = staleCodemanHooks();
    hooks.Stop[0].hooks.push({
      type: 'command',
      command: './notify-user.sh',
      timeout: 10,
    });
    const customPostToolUse = {
      matcher: 'Write',
      hooks: [{ type: 'command', command: './format.sh' }],
    };
    const customEvent = [
      {
        hooks: [{ type: 'command', command: './audit.sh' }],
      },
    ];
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            ...hooks,
            PostToolUse: [customPostToolUse],
            CustomEvent: customEvent,
          },
        },
        null,
        2
      )
    );

    await refreshStaleCodemanHooks(dir);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(JSON.stringify(after.hooks)).toContain(SECRET_HEADER);
    expect(JSON.stringify(after.hooks)).toContain('CODEMAN_BACKGROUND_REWAKE_V');
    expect(JSON.stringify(after.hooks.Stop)).toContain('./notify-user.sh');
    expect(after.hooks.PostToolUse).toEqual(expect.arrayContaining([customPostToolUse]));
    expect(after.hooks.CustomEvent).toEqual(customEvent);
  });

  it('is a no-op when settings.local.json is absent (does not create one)', async () => {
    await refreshStaleCodemanHooks(dir);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('leaves a malformed settings file untouched', async () => {
    const garbage = '{ not valid json';
    writeFileSync(settingsPath, garbage);
    await refreshStaleCodemanHooks(dir);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(garbage);
  });
});
