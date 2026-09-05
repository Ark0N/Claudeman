/**
 * @fileoverview Where case (project) folders live.
 *
 * Deliberately NOT instance-scoped, unlike `dataPath()`: `~/codeman-cases` is
 * shared by every Codeman on the machine, the same way `~/codeman-users/<u>`
 * user spaces are, so a beta instance sees the same projects as prod.
 *
 * `CODEMAN_CASES_PATH` overrides the location. Docker Compose deployments set
 * it to a host-absolute bind mount so a Docker case's workspace resolves to the
 * SAME absolute path inside Codeman and on the host daemon that mounts it.
 *
 * ⚠️ **One resolver, every caller.** This started life as three hardcoded
 * `join(homedir(), 'codeman-cases')` copies. When only the web server's copy
 * learned the override, `codeman skill install --case <name>` still looked in
 * the home default and reported "Case not found" on exactly the deployment the
 * override exists for. A new cases-dir consumer imports this; it does not
 * rebuild the path.
 *
 * (`state-store.ts` keeps its own literal on purpose: that one migrates the
 * historical `~/claudeman-cases` directory to `~/codeman-cases` by name, and is
 * about the old default location rather than the active one.)
 *
 * @module config/cases-dir
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute path to the shared cases directory. */
export function getCasesDir(): string {
  return process.env.CODEMAN_CASES_PATH || join(homedir(), 'codeman-cases');
}

/** Absolute path to one case folder inside it. */
export function casePath(name: string): string {
  return join(getCasesDir(), name);
}
