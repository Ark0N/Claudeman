/**
 * @fileoverview Static parity check between docker/docker-compose.yaml and
 * docker/.env.example.
 *
 * This is the MERGE GATE for the container environment. A feature that needs a
 * new setting must add it to BOTH files; forgetting one is what produces the
 * failure the in-app updater cannot defend against, because Compose resolves an
 * unset `${VAR}` to the EMPTY STRING and starts anyway — the container comes up
 * with a silently blank setting and misbehaves later, far from the cause.
 *
 * Failing here costs a line in a PR. Failing in production costs a debugging
 * session on someone else's server. Related: docs/docker-self-update.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvKeys } from '../src/web/self-update.js';

const DOCKER_DIR = join(process.cwd(), 'docker');
const compose = readFileSync(join(DOCKER_DIR, 'docker-compose.yaml'), 'utf-8');
const example = readFileSync(join(DOCKER_DIR, '.env.example'), 'utf-8');

/**
 * Every `${VAR}` / `${VAR:-default}` the compose file interpolates. Compose's
 * own built-ins are excluded — they are supplied by Compose, not by .env.
 */
function composeVariables(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::?-[^}]*)?\}/g)) found.add(m[1]);
  return [...found].sort();
}

/** Keys .env.example mentions at all, including the commented-out optional ones. */
function documentedKeys(text: string): Set<string> {
  const keys = new Set(parseEnvKeys(text));
  for (const m of text.matchAll(/^#\s*([A-Z_][A-Z0-9_]*)=/gm)) keys.add(m[1]);
  return keys;
}

/**
 * Variables Compose or the start script provides, which therefore need no entry
 * in .env.example. Keep this list SHORT and justified — every addition is a
 * setting the parity check stops guarding.
 */
const PROVIDED_ELSEWHERE = new Set([
  // Derived by docker/Start-Codeman.sh from the appdata dir and socket owner.
  'PUID',
  'PGID',
  'DOCKER_SOCKET_GID',
]);

/**
 * Keys .env.example sets for an OVERRIDE documented in docker/README.md (the
 * macvlan networking example), which the base compose file deliberately does not
 * read. They are settings for a file that is not this one, not dead entries.
 */
const EXAMPLE_ONLY_KEYS = new Set([
  'CODEMAN_MACVLAN_NETWORK',
  'CODEMAN_IPV4_ADDRESS',
  'CODEMAN_MAC_ADDRESS',
  'CODEMAN_MACVLAN_PARENT',
  'CODEMAN_MACVLAN_SUBNET',
  'CODEMAN_MACVLAN_GATEWAY',
]);

describe('docker compose ↔ .env.example parity', () => {
  it('every variable the compose file reads is documented in .env.example', () => {
    const documented = documentedKeys(example);
    const undocumented = composeVariables(compose).filter((v) => !documented.has(v) && !PROVIDED_ELSEWHERE.has(v));
    expect(undocumented, `add these to docker/.env.example: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('every key .env.example SETS is actually read by the compose file', () => {
    // Commented-out entries are exempt: they document optional overrides and
    // example-only values (the macvlan block) that the base file never reads.
    const used = new Set(composeVariables(compose));
    const unused = parseEnvKeys(example).filter((k) => !used.has(k) && !EXAMPLE_ONLY_KEYS.has(k));
    expect(unused, `these are set in .env.example but unused: ${unused.join(', ')}`).toEqual([]);
  });
});
