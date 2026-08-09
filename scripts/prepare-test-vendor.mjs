#!/usr/bin/env node
/**
 * Populate `src/web/public/vendor/` with the browser bundles the mobile tests need.
 *
 * The mobile suite (test/mobile/**) drives a real browser against a WebServer
 * started from TypeScript source, so fastify-static serves
 * `join(__dirname, 'public')` = `src/web/public` — NOT `dist/web/public`, where
 * `npm run build` puts the vendor bundles. Every `/vendor/xterm*` request 404s,
 * so `Terminal` is never defined, `initTerminal()` never runs, and every test
 * touching `app.terminal` dies with `Cannot read properties of null`.
 *
 * That stayed invisible because config/vitest.ci.config.ts excludes
 * `test/mobile/**`, so CI never ran the suite.
 *
 * Mirrors the vendor steps in scripts/build.mjs, targeting the source tree.
 * Same inputs and output names, so the page markup needs no test-only branch.
 * `src/web/public/vendor/` is gitignored, so these stay build artifacts.
 *
 * Idempotent: skips outputs already newer than their source.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'web', 'public', 'vendor');
const NM = join(ROOT, 'node_modules');

/**
 * Every `vendor/` asset index.html requests, minus the two already committed
 * (dompurify, marked). Kept in sync with scripts/build.mjs steps 3-4 — a missing
 * entry here is a 404 that silently disables the terminal in tests.
 *
 * mode: 'copy' | 'minify' | 'bundle'
 */
const ASSETS = [
  { src: join(NM, '@xterm/xterm/css/xterm.css'), out: 'xterm.css', mode: 'copy' },
  { src: join(NM, '@xterm/xterm/lib/xterm.js'), out: 'xterm.min.js', mode: 'minify' },
  { src: join(NM, '@xterm/addon-fit/lib/addon-fit.js'), out: 'xterm-addon-fit.min.js', mode: 'minify' },
  {
    src: join(NM, '@xterm/addon-serialize/lib/addon-serialize.js'),
    out: 'xterm-addon-serialize.min.js',
    mode: 'minify',
  },
  {
    src: join(NM, '@xterm/addon-unicode11/lib/addon-unicode11.js'),
    out: 'xterm-addon-unicode11.min.js',
    mode: 'minify',
  },
  { src: join(NM, '@xterm/addon-webgl/lib/addon-webgl.js'), out: 'xterm-addon-webgl.min.js', mode: 'copy' },
  {
    src: join(ROOT, 'packages/xterm-zerolag-input/src/zerolag-input-addon.ts'),
    out: 'xterm-zerolag-input.js',
    mode: 'bundle',
    globalName: 'XtermZerolagInput',
  },
];

function isFresh(src, dest) {
  if (!existsSync(dest)) return false;
  try {
    return statSync(dest).mtimeMs >= statSync(src).mtimeMs;
  } catch {
    return false;
  }
}

mkdirSync(OUT, { recursive: true });

let built = 0;
let skipped = 0;
for (const asset of ASSETS) {
  const dest = join(OUT, asset.out);
  if (!existsSync(asset.src)) {
    console.error(`[test-vendor] missing input: ${asset.src}\n  run \`npm install\` first`);
    process.exit(1);
  }
  if (isFresh(asset.src, dest)) {
    skipped += 1;
    continue;
  }
  if (asset.mode === 'copy') {
    copyFileSync(asset.src, dest);
  } else if (asset.mode === 'minify') {
    execFileSync('npx', ['esbuild', asset.src, '--minify', `--outfile=${dest}`], { stdio: 'inherit' });
  } else {
    execFileSync(
      'npx',
      [
        'esbuild',
        asset.src,
        '--bundle',
        '--minify',
        '--format=iife',
        `--global-name=${asset.globalName}`,
        `--outfile=${dest}`,
      ],
      { stdio: 'inherit' }
    );
  }
  built += 1;
}

console.log(`[test-vendor] ${built} built, ${skipped} up to date -> src/web/public/vendor/`);
