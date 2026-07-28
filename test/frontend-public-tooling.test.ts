import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('exposes self-contained asset discovery and NUL checks', async () => {
    const checker = (await import(pathToFileURL(resolve(repoRoot, 'scripts/check-public-assets.mjs')).href)) as {
      collectTextAssets: (directory: string) => string[];
      findNullByte: (data: Buffer) => number;
    };
    const files = checker
      .collectTextAssets(resolve(repoRoot, 'src/web/public'))
      .map((file) => relative(repoRoot, file));

    expect(files).toContain('src/web/public/terminal-input-state.js');
    expect(checker.findNullByte(Buffer.from('valid source'))).toBe(-1);
    expect(checker.findNullByte(Buffer.from([0x61, 0, 0x62]))).toBe(1);
  });
});
