#!/usr/bin/env node
/**
 * Standalone smoke-test for pointing each Codeman-supported harness CLI at a
 * custom OpenAI-compatible endpoint — local (llama.cpp, Ollama, vLLM, ...) or
 * cloud (Azure AI Foundry's OpenAI-compatible endpoint, OpenRouter, a
 * self-hosted gateway, ...). Anything that answers GET /v1/models and POST
 * /v1/chat/completions in the standard shape qualifies; --base-url is not
 * assumed to be a LAN address.
 *
 * This is intentionally OUTSIDE the npm test suite and outside Codeman's own
 * session/tmux machinery: it spawns each real CLI binary directly, one-shot,
 * with the env vars / config files that CLI's own docs say redirect it to a
 * custom endpoint, and checks it can answer "hello world".
 *
 * Cloud endpoints often differ from a bare llama.cpp box in two ways this
 * script accounts for: (1) auth may be an `api-key` header (Azure's
 * convention) rather than `Authorization: Bearer` — the baseline check in
 * Step 0 sends both, since an extra header is harmless to servers that
 * ignore it; each CLI's OWN auth convention (set via its env vars/config,
 * not this script) still needs to match what that endpoint expects. (2) a
 * cloud endpoint's "model" may actually be a deployment name distinct from
 * the model family (Azure AI Foundry deployments) — always pass --model
 * explicitly for those rather than relying on GET /v1/models discovery.
 *
 * IMPORTANT CONFIDENCE NOTE: only claude/opencode/codex recipes are verified
 * (Devvyn confirmed them by hand). gemini/pi/grok/deepseek/omp are best
 * guesses from public docs, not verified against this repo or against real
 * binaries. antigravity has no known CLI/env mechanism at all and is always
 * skipped. Read a harness's UNCONFIRMED/FAIL output before trusting it — use
 * --probe-help to read that binary's real --help and fix the guessed flag.
 *
 * Usage:
 *   node scripts/test-local-llm-harnesses.mjs --base-url http://192.168.1.50:8080 [options]
 *   node scripts/test-local-llm-harnesses.mjs --base-url https://<resource>.services.ai.azure.com/openai/v1 --model <deployment-name> --api-key $AZURE_AI_KEY
 *
 * Options:
 *   --base-url <url>       Required. Root URL of the OpenAI-compatible endpoint (local or cloud).
 *   --model <name>         Model/deployment id to request. Default: first from GET /v1/models.
 *   --api-key <key>        API key to send. Default: local-dummy-key (fine for llama.cpp; required for most cloud endpoints).
 *   --auth-style <style>   "bearer" (default, Authorization: Bearer) or "api-key" (the
 *                          `api-key` header some cloud gateways, e.g. Azure, want).
 *                          NEVER send both — live-tested against a real server, doing
 *                          so reliably HANGS the request indefinitely.
 *   --prompt <text>        Prompt to send. Default: "Reply with exactly: hello world".
 *   --only <id,id,...>     Restrict to these harness ids (comma-separated).
 *   --timeout <ms>         Per-harness spawn timeout. Default: 30000.
 *   --probe-help           Instead of testing, resolve each installed binary and print --help.
 *   --keep-temp            Don't delete generated per-harness config dirs afterward.
 *   --list                 Dry run: print the resolved plan per harness, execute nothing.
 *   -h, --help              Show this help.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[test-local-llm-harnesses]';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(SCRIPT_DIR, 'local-llm-test.config.json');
const CONFIG_EXAMPLE_PATH = join(SCRIPT_DIR, 'local-llm-test.config.example.json');

/**
 * Loads scripts/local-llm-test.config.json (gitignored — real IP/model/key,
 * per-machine) if present, so you don't have to retype --base-url every run.
 * See local-llm-test.config.example.json (tracked) for the shape. CLI flags
 * always override whatever this file sets; this only supplies defaults.
 */
function loadConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return {
      baseUrl: raw.baseUrl ?? null,
      model: raw.model ?? null,
      apiKey: raw.apiKey || undefined, // empty string counts as "not set", not a real key
      authStyle: raw.authStyle === 'api-key' ? 'api-key' : undefined, // never 'both'
      prompt: raw.prompt ?? undefined,
      only: Array.isArray(raw.only) && raw.only.length ? raw.only : null,
      timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    };
  } catch (err) {
    console.error(`${TAG} failed to parse ${CONFIG_PATH}: ${err.message} (ignoring it)`);
    return {};
  }
}

function parseArgs(argv, configDefaults) {
  const opts = {
    baseUrl: configDefaults.baseUrl ?? null,
    model: configDefaults.model ?? null,
    apiKey: configDefaults.apiKey ?? 'local-dummy-key',
    authStyle: configDefaults.authStyle ?? 'bearer',
    prompt: configDefaults.prompt ?? 'Reply with exactly: hello world',
    only: configDefaults.only ?? null,
    timeout: configDefaults.timeout ?? 30000,
    probeHelp: false,
    keepTemp: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base-url':
        opts.baseUrl = argv[++i];
        break;
      case '--model':
        opts.model = argv[++i];
        break;
      case '--api-key':
        opts.apiKey = argv[++i];
        break;
      case '--auth-style':
        opts.authStyle = argv[++i];
        if (opts.authStyle !== 'bearer' && opts.authStyle !== 'api-key') {
          console.error(`${TAG} --auth-style must be "bearer" or "api-key"`);
          opts.help = true;
        }
        break;
      case '--prompt':
        opts.prompt = argv[++i];
        break;
      case '--only':
        opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--timeout':
        opts.timeout = Number(argv[++i]);
        break;
      case '--probe-help':
        opts.probeHelp = true;
        break;
      case '--keep-temp':
        opts.keepTemp = true;
        break;
      case '--list':
        opts.list = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        console.error(`${TAG} unknown argument: ${a}`);
        opts.help = true;
    }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/test-local-llm-harnesses.mjs [--base-url <url>] [options]

Reads defaults from scripts/local-llm-test.config.json if it exists (copy
scripts/local-llm-test.config.example.json to create it — gitignored, since
it holds a real IP/model/key). CLI flags always override the config file.
--base-url becomes optional once that file supplies one.

Works against any custom OpenAI-compatible endpoint, local or cloud
(llama.cpp, Ollama, vLLM, Azure AI Foundry, OpenRouter, a self-hosted
gateway, ...) — anything answering GET /v1/models and POST
/v1/chat/completions in the standard shape.

Options:
  --base-url <url>     Required. Root URL of the OpenAI-compatible endpoint.
  --model <name>       Model/deployment id to request. Default: first from GET /v1/models.
  --api-key <key>      API key to send. Default: local-dummy-key (required for most cloud endpoints).
  --auth-style <style> "bearer" (default) or "api-key" (Azure-style). Never both — sending
                       both headers together reliably hangs some real servers.
  --prompt <text>      Prompt to send. Default: "Reply with exactly: hello world".
  --only <id,id,...>   Restrict to these harness ids.
  --timeout <ms>       Per-harness spawn timeout. Default: 30000.
  --probe-help         Print each installed binary's --help instead of testing.
  --keep-temp          Keep generated per-harness config dirs afterward.
  --list               Dry run: print the resolved plan, execute nothing.
  -h, --help            Show this help.

Harness ids: claude, opencode, codex, gemini, pi, grok, deepseek, omp, antigravity

Examples:
  node scripts/test-local-llm-harnesses.mjs --base-url http://192.168.1.50:8080
  node scripts/test-local-llm-harnesses.mjs --base-url https://<resource>.services.ai.azure.com/openai/v1 --model <deployment-name> --api-key $AZURE_AI_KEY`);
}

const HOME = homedir();
const EXTRA_SEARCH_DIRS = [
  join(HOME, '.local', 'bin'),
  join(HOME, '.opencode', 'bin'),
  join(HOME, '.codex', 'bin'),
  join(HOME, '.gemini', 'bin'),
  join(HOME, '.antigravity', 'bin'),
  join(HOME, '.grok', 'bin'),
  join(HOME, '.omp', 'bin'),
  join(HOME, '.bun', 'bin'),
  join(HOME, '.npm-global', 'bin'),
  join(HOME, 'bin'),
  '/usr/local/bin',
];

function pathWithExtraDirs() {
  return [...EXTRA_SEARCH_DIRS, process.env.PATH ?? ''].join(delimiter);
}

/** Resolve a binary by trying `<bin> --version` with extra search dirs prefixed onto PATH. */
function resolveBinary(bin) {
  try {
    execFileSync(bin, ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
      env: { ...process.env, PATH: pathWithExtraDirs() },
    });
    return bin;
  } catch (err) {
    // Some CLIs (e.g. dsh) don't support --version cleanly for identity but
    // still exist on PATH; a non-ENOENT failure still counts as "found".
    if (err && err.code === 'ENOENT') return null;
    return bin;
  }
}

function printHelp(bin) {
  try {
    const out = execFileSync(bin, ['--help'], {
      timeout: 5000,
      stdio: 'pipe',
      env: { ...process.env, PATH: pathWithExtraDirs() },
    });
    console.log(out.toString());
  } catch (err) {
    console.log((err.stdout ?? err.message ?? String(err)).toString());
  }
}

// --- per-harness definitions -----------------------------------------------

/** kind: 'env' | 'configContentEnv' | 'configDir' | 'unsupported' */
const HARNESSES = {
  claude: {
    binary: 'claude',
    confidence: 'verified',
    buildEnv: (baseUrl, apiKey, model) => ({
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    }),
    // Claude Code's async session-title-generation call also uses
    // ANTHROPIC_DEFAULT_HAIKU_MODEL and validates it against Claude's OWN internal
    // recognized-model list, printing [claude-code:unrecognized_model] to stderr for
    // a local model name. Confirmed live: `--settings '{"autoTitle":false}'` does NOT
    // stop it (still hung the whole run); `--bare` does — the warning still prints,
    // but the actual prompt now runs and returns the real answer. Confirmed against
    // a real llama-swap server.
    buildArgv: (prompt) => ['--dangerously-skip-permissions', '--bare', '-p', prompt],
  },
  opencode: {
    binary: 'opencode',
    confidence: 'verified',
    buildEnv: (baseUrl, apiKey, model) => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          local: {
            options: { baseURL: `${baseUrl}/v1`, apiKey },
            models: { [model]: {} },
          },
        },
        model: `local/${model}`,
      }),
    }),
    buildArgv: (prompt) => ['run', prompt],
  },
  codex: {
    binary: 'codex',
    confidence: 'verified',
    configDir: {
      dirEnvVar: 'CODEX_HOME',
      fileName: 'config.toml',
      // Verified against a real codex binary: `model` must be a top-level STRING
      // (an earlier `[model].default` table was rejected with "invalid type: map,
      // expected a string"). The API key is NEVER a literal TOML field — codex only
      // supports `env_key`, the NAME of an env var it reads the value from, so the
      // real key rides as an extra env var (see extraEnv below), never in the file.
      // ⚠️ `wire_api = "responses"` is the only value codex still accepts (support
      // for "chat" was dropped Feb 2026) — a plain OpenAI Chat-Completions server
      // (llama.cpp, llama-swap) does NOT implement the Responses API, so this may
      // still fail at the PROTOCOL level even with a correctly-shaped file.
      content: (baseUrl, _apiKey, model) =>
        `model = "${model}"\nmodel_provider = "custom"\n\n[model_providers.custom]\nname = "Custom Endpoint"\nbase_url = "${baseUrl}/v1"\nenv_key = "CODEMAN_CUSTOM_MODEL_API_KEY"\nwire_api = "responses"\n`,
      extraEnv: (_baseUrl, apiKey) => ({ CODEMAN_CUSTOM_MODEL_API_KEY: apiKey }),
    },
    buildArgv: (prompt) => ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt],
  },
  gemini: {
    binary: 'gemini',
    confidence: 'researched',
    buildEnv: (baseUrl, apiKey, model) => ({
      GOOGLE_GEMINI_BASE_URL: baseUrl,
      GEMINI_API_KEY: apiKey,
      GEMINI_MODEL: model,
    }),
    buildArgv: (prompt) => ['-p', prompt, '--approval-mode', 'yolo'],
  },
  pi: {
    binary: 'pi',
    confidence: 'researched',
    configDir: {
      dirEnvVar: 'PI_CONFIG_DIR',
      fileName: join('agent', 'models.json'),
      content: (baseUrl, apiKey, model) =>
        JSON.stringify(
          {
            providers: {
              local: {
                baseUrl: `${baseUrl}/v1`,
                apiKey,
                api: 'openai-completions',
                models: { [model]: {} },
              },
            },
          },
          null,
          2
        ),
    },
    buildArgv: (prompt) => ['--approve', '-p', prompt],
  },
  grok: {
    binary: 'grok',
    confidence: 'researched',
    buildEnv: (baseUrl, apiKey, model) => ({
      GROK_BASE_URL: baseUrl,
      XAI_API_KEY: apiKey,
      GROK_MODEL: model,
    }),
    buildArgv: (prompt) => ['--always-approve', '-p', prompt],
  },
  deepseek: {
    binary: 'dsh',
    confidence: 'unknown',
    note: 'dsh is a profile launcher, not a documented one-shot prompt flag. Best-effort only.',
    buildEnv: (baseUrl, apiKey) => ({
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_API_KEY: apiKey,
      DSH_PERMISSION_MODE: 'danger-full-access',
    }),
    buildArgv: (prompt) => ['--profile', 'headless', prompt],
  },
  omp: {
    binary: 'omp',
    confidence: 'researched',
    configDir: {
      dirEnvVar: 'PI_CONFIG_DIR', // omp's ~/.omp tree is relocatable via PI_CONFIG_DIR per CLAUDE.md
      fileName: join('agent', 'models.yml'),
      content: (baseUrl, apiKey, model) =>
        `providers:\n  local:\n    baseUrl: ${baseUrl}/v1\n    apiKey: ${apiKey}\n    models:\n      - ${model}\n`,
    },
    buildArgv: (prompt) => ['-p', prompt],
  },
  antigravity: {
    binary: 'agy',
    confidence: 'unsupported',
    note: 'No known CLI/env/config mechanism for a custom endpoint (GUI-only per public docs). Always skipped.',
    buildEnv: null,
    buildArgv: null,
  },
};

// --- baseline server check ---------------------------------------------------

async function baselineCheck(baseUrl, apiKey, authStyle, model, prompt, timeoutMs) {
  console.log(`\n=== Step 0: baseline check against ${baseUrl} (auth: ${authStyle}) ===`);

  // Exactly ONE header, never both. An earlier version sent both auth conventions
  // (Bearer + api-key) on the theory that an unused header is harmless — live-
  // tested against a real llama-swap server, sending both reliably HUNG the
  // request indefinitely (reproduced 3x: Bearer alone ~500ms, api-key alone
  // ~600ms, both together no response inside a 15s timeout). Use --auth-style
  // api-key for endpoints that specifically want that header (e.g. Azure AI
  // Foundry); default 'bearer' covers everything else.
  const authHeaders = authStyle === 'api-key' ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };

  let discoveredModel = model;
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ids = (body.data ?? []).map((m) => m.id);
    console.log(`GET /v1/models -> ${ids.length ? ids.join(', ') : '(empty list)'}`);
    if (!discoveredModel && ids.length) discoveredModel = ids[0];
  } catch (err) {
    console.error(`${TAG} GET /v1/models failed: ${err.message}`);
    console.error(`${TAG} Is the server actually running at ${baseUrl}? Aborting.`);
    process.exit(1);
  }

  if (!discoveredModel) {
    console.error(`${TAG} No --model given and none discovered from /v1/models. Aborting.`);
    process.exit(1);
  }

  // Live-tested against a real llama-swap server: a POST issued right after a GET on
  // the same Node process reliably HANGS indefinitely (reproduced repeatedly — GET
  // alone ~30ms, POST alone ~1-2s, GET-then-immediate-POST times out completely; a
  // 2s pause between them fixed it every time). This looks like Node's fetch (undici)
  // reusing a pooled keep-alive connection the server doesn't handle cleanly for a
  // second request right behind a first. A short pause is the simplest portable fix
  // (no extra deps, no need for undici's Agent/dispatcher API).
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        model: discoveredModel,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const reply = body.choices?.[0]?.message?.content ?? '';
    if (!reply.trim()) throw new Error('empty reply');
    console.log(`POST /v1/chat/completions -> "${reply.trim().slice(0, 200)}"`);
    console.log('Server baseline: PASS\n');
  } catch (err) {
    console.error(`${TAG} POST /v1/chat/completions failed: ${err.message}`);
    console.error(`${TAG} Server responded to /v1/models but not to a chat request. Aborting.`);
    process.exit(1);
  }

  return discoveredModel;
}

// --- per-harness run ----------------------------------------------------------

function makeTempConfigDir(id) {
  const dir = mkdtempSync(join(tmpdir(), `codeman-local-llm-test-${id}-`));
  return dir;
}

function runChild(bin, argv, env, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, argv, {
      env: { ...process.env, ...env, PATH: pathWithExtraDirs() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

async function runHarness(id, def, opts, model) {
  const result = { id, confidence: def.confidence, status: 'SKIP', detail: '' };

  if (def.confidence === 'unsupported') {
    result.status = 'SKIP';
    result.detail = def.note ?? 'no known mechanism';
    return result;
  }

  const resolved = resolveBinary(def.binary);
  if (!resolved) {
    result.status = 'SKIP';
    result.detail = `binary "${def.binary}" not found on PATH or search dirs`;
    return result;
  }

  let env = def.buildEnv ? def.buildEnv(opts.baseUrl, opts.apiKey, model) : {};
  let tempDir = null;

  if (def.configDir) {
    tempDir = makeTempConfigDir(id);
    const filePath = join(tempDir, def.configDir.fileName);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, def.configDir.content(opts.baseUrl, opts.apiKey, model), 'utf8');
    const extraEnv = def.configDir.extraEnv ? def.configDir.extraEnv(opts.baseUrl, opts.apiKey, model) : {};
    env = { ...env, [def.configDir.dirEnvVar]: tempDir, ...extraEnv };
  }

  const argv = def.buildArgv(opts.prompt);

  if (opts.list) {
    result.status = 'LIST';
    result.detail = `${def.binary} ${argv.join(' ')} | env: ${Object.keys(env).join(', ')}${
      tempDir ? ` | configDir: ${tempDir}` : ''
    }`;
    if (tempDir && !opts.keepTemp) rmSync(tempDir, { recursive: true, force: true });
    return result;
  }

  const { code, stdout, stderr, timedOut } = await runChild(def.binary, argv, env, opts.timeout);

  if (tempDir && !opts.keepTemp) rmSync(tempDir, { recursive: true, force: true });
  else if (tempDir) result.detail += ` [config kept at ${tempDir}]`;

  if (timedOut) {
    result.status = 'FAIL';
    result.detail = `timed out after ${opts.timeout}ms. stderr: ${stderr.slice(-300)}`;
    return result;
  }

  const reply = stdout.trim();
  const matched = /hello/i.test(reply) && /world/i.test(reply);

  if (code !== 0) {
    result.status = def.confidence === 'verified' ? 'FAIL' : 'UNCONFIRMED';
    result.detail = `exit ${code}. stderr: ${stderr.trim().slice(-300) || '(empty)'}`;
    return result;
  }

  if (!reply) {
    result.status = def.confidence === 'verified' ? 'FAIL' : 'UNCONFIRMED';
    result.detail = 'exit 0 but empty stdout';
    return result;
  }

  if (matched) {
    result.status = 'PASS';
    result.detail = reply.slice(0, 200);
  } else {
    result.status = 'UNCONFIRMED';
    result.detail = `reply didn't match heuristic, judge by eye: "${reply.slice(0, 300)}"`;
  }
  return result;
}

// --- main ---------------------------------------------------------------------

async function main() {
  const configDefaults = loadConfigFile();
  const opts = parseArgs(process.argv.slice(2), configDefaults);
  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const ids = opts.only ?? Object.keys(HARNESSES);
  const unknownIds = ids.filter((id) => !HARNESSES[id]);
  if (unknownIds.length) {
    console.error(`${TAG} unknown harness id(s): ${unknownIds.join(', ')}`);
    console.error(`${TAG} known ids: ${Object.keys(HARNESSES).join(', ')}`);
    process.exit(1);
  }

  // --probe-help never touches the network — no --base-url needed for it.
  if (opts.probeHelp) {
    for (const id of ids) {
      const def = HARNESSES[id];
      const resolved = resolveBinary(def.binary);
      console.log(`\n=== ${id} (${def.binary}) ===`);
      if (!resolved) {
        console.log('(not found on PATH or search dirs)');
        continue;
      }
      printHelp(def.binary);
    }
    process.exit(0);
  }

  if (!opts.baseUrl) {
    console.error(`${TAG} --base-url is required (pass it, or set "baseUrl" in ${CONFIG_PATH}).`);
    console.error(`${TAG} See ${CONFIG_EXAMPLE_PATH} for the config file shape.\n`);
    printUsage();
    process.exit(1);
  }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');

  // --list is a pure dry run: never touch the network, even if --model was given.
  let model = opts.model;
  if (opts.list) {
    model = opts.model ?? 'local-model';
    console.log(`\n=== Step 0 skipped (--list never hits the network; using placeholder "${model}") ===\n`);
  } else {
    model = await baselineCheck(opts.baseUrl, opts.apiKey, opts.authStyle, opts.model, opts.prompt, opts.timeout);
  }

  console.log(`=== Testing ${ids.length} harness(es) ===`);
  const results = [];
  for (const id of ids) {
    process.stdout.write(`\n--- ${id} ---\n`);
    const result = await runHarness(id, HARNESSES[id], opts, model);
    results.push(result);
    console.log(`${result.status}: ${result.detail}`);
  }

  console.log('\n=== Summary ===');
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  for (const r of results) {
    console.log(`${r.id.padEnd(width)} [${r.confidence.padEnd(11)}] ${r.status.padEnd(11)} ${r.detail.slice(0, 100)}`);
  }

  const hardFail = results.some((r) => r.status === 'FAIL' && r.confidence === 'verified');
  if (hardFail) {
    console.error(`\n${TAG} at least one VERIFIED harness FAILed — that's a real regression, not just an unconfirmed guess.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TAG} unexpected error:`, err);
  process.exit(1);
});
