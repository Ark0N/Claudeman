#!/usr/bin/env node
/**
 * Build the Codeman agent base image locally (decision: "build locally on first
 * use", see docs/docker-cases-plan.md). No registry account required.
 *
 * Usage:
 *   node scripts/build-agent-image.mjs [--engine docker|podman] [--image <ref>] [--no-cache]
 *
 * Defaults: engine=docker (falls back to podman if docker is absent),
 *           image=codeman/agent:base
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DOCKERFILE = join(REPO_ROOT, 'docker', 'agent.Dockerfile');
const DEFAULT_IMAGE = 'codeman/agent:base';

function parseArgs(argv) {
  const args = { image: DEFAULT_IMAGE, engine: undefined, noCache: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--image') args.image = argv[++i];
    else if (a === '--engine') args.engine = argv[++i];
    else if (a === '--no-cache') args.noCache = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function engineAvailable(engine) {
  const r = spawnSync(engine, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function resolveEngine(preferred) {
  if (preferred) {
    if (!engineAvailable(preferred)) {
      console.error(`[build-agent-image] engine "${preferred}" not found on PATH`);
      process.exit(1);
    }
    return preferred;
  }
  if (engineAvailable('docker')) return 'docker';
  if (engineAvailable('podman')) return 'podman';
  console.error('[build-agent-image] neither docker nor podman found on PATH. Install one and retry.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node scripts/build-agent-image.mjs [--engine docker|podman] [--image <ref>] [--no-cache]');
  process.exit(0);
}

// The stock catalog's install-command shape, mirroring config/clis.stock.json
// (see docs/cli-registry.md) — read directly rather than via tsx/ts-node so this
// script has no extra runtime dependency. A registry entry with a plain
// `npm install -g <pkg>` install command joins the shared npm-install ARG
// automatically; anything else (a curl installer, --ignore-scripts, no npm
// package at all) stays a documented Dockerfile special case, same as
// Antigravity and Pi today.
function cliNpmPackages() {
  const stockPath = join(REPO_ROOT, 'config', 'clis.stock.json');
  let entries;
  try {
    entries = JSON.parse(readFileSync(stockPath, 'utf8'));
  } catch (err) {
    console.warn(`[build-agent-image] could not read ${stockPath} (${err.message}); using the Dockerfile's built-in defaults`);
    return null;
  }
  const packages = entries
    .filter((e) => e.id !== 'pi') // pi needs --ignore-scripts, handled by its own ARG below
    .map((e) => e.discovery?.install?.npmPackage)
    .filter((pkg) => typeof pkg === 'string' && pkg.length > 0);
  const pi = entries.find((e) => e.id === 'pi')?.discovery?.install?.npmPackage;
  return { packages, pi };
}

const engine = resolveEngine(args.engine);
const buildArgs = ['build', '-f', DOCKERFILE, '-t', args.image];
if (args.noCache) buildArgs.push('--no-cache');

const cliPkgs = cliNpmPackages();
if (cliPkgs && cliPkgs.packages.length > 0) {
  buildArgs.push('--build-arg', `CLI_NPM_PACKAGES=${cliPkgs.packages.join(' ')}`);
}
if (cliPkgs && cliPkgs.pi) {
  buildArgs.push('--build-arg', `CLI_PI_NPM_PACKAGE=${cliPkgs.pi}`);
}

buildArgs.push(REPO_ROOT);

console.log(`[build-agent-image] ${engine} ${buildArgs.join(' ')}`);
const child = spawn(engine, buildArgs, { stdio: 'inherit' });
child.on('exit', (code) => {
  if (code === 0) {
    console.log(`\n[build-agent-image] built ${args.image}. Docker cases can now launch.`);
  } else {
    console.error(`\n[build-agent-image] build failed (exit ${code}).`);
  }
  process.exit(code ?? 1);
});
