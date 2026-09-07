import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

describe('frontend public asset tooling', () => {
  it('exposes a public asset check script', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['check:public-assets']).toContain('scripts/check-public-assets.mjs');
  });

  it('keeps app.js free of literal NUL bytes', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'));

    expect(appJs.includes(0)).toBe(false);
  });

  it('uses the same message wrapper for brief and full response views', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'), 'utf8');

    expect(appJs).toContain("body.appendChild(this._buildResponseViewerMessage(lastResponse, 'assistant'");
    expect(appJs).toContain(
      'body.appendChild(this._buildResponseViewerMessage(msg.text, msg.role, agentLabel, { ...msg, continuation }));'
    );
    // ⚠️ A numeric `turn` gates continuation rendering. Only the Claude reader
    // emits turns; Codex, the external-CLI pane parser and an older server emit
    // adjacent same-role messages with none, and must keep one badge per card.
    expect(appJs).toContain(
      "!!previous && previous.role === msg.role && typeof msg.turn === 'number' && previous.turn === msg.turn"
    );
    expect(appJs).toContain("div.className = 'rv-message ' + (isUser ? 'rv-msg-user' : 'rv-msg-assistant');");
    expect(appJs).toContain("renderedText.className = 'rv-text';");
  });

  it('runs the public asset check script', () => {
    expect(() => {
      execFileSync('npm', ['run', 'check:public-assets', '--silent'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});
