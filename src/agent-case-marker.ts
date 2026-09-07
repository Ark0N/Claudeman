/**
 * @fileoverview The marker file that records a case directory as one Codeman scaffolded
 * FOR an agent-spawned session, so scratch worker workspaces can be told apart from the
 * user's real projects long after the sessions that created them are gone.
 *
 * Why a file in the case directory rather than a central registry in `~/.codeman`:
 * the thing being labelled is a directory on the user's disk, and the label has to
 * survive everything that can happen to Codeman's own state (a wiped data dir, a
 * different instance, a hand-moved case). A registry would also need stale-entry
 * pruning and owner scoping of its own, while a marker is deleted by the same `rm -rf`
 * that deletes the case, and is discoverable by a user who just runs `ls -a`.
 *
 * ⚠️ Written ONLY on the path that CREATES the directory (`POST /api/quick-start`'s
 * `!existsSync` branch). A linked case, a cloned repo, a git worktree or any other
 * pre-existing directory must never be labelled agent-created: the label drives a
 * cleanup affordance, and mislabelling someone's repo there is the one failure mode
 * that costs real work. `POST /api/sessions` takes an existing `workingDir` and so
 * writes no marker at all, by construction.
 *
 * ⚠️ Reading is strict and total: anything that does not parse as a version-1 marker
 * (truncated write, hand-edited junk, a user's unrelated file of the same name) reads
 * as "not agent-created" rather than as a partially-trusted entry. A marker is
 * metadata; deleting the file is the supported way to adopt a scratch case as a real
 * one, which is what the `note` field written into it tells the user.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Marker filename inside the case directory. Dot-prefixed so it stays out of the way. */
export const AGENT_CASE_MARKER_FILE = '.codeman-agent-case.json';

/** Current marker schema version. A marker of any other version reads as absent. */
export const AGENT_CASE_MARKER_VERSION = 1;

/**
 * Origin recorded when a create request carried a resolvable spawning session but no
 * explicit origin of its own (an agent driving the API by hand, or an older copy of
 * the skill). Nothing in the browser UI sets lineage, so this really does mean "another
 * session spawned this", not "a human clicked Run".
 */
export const AGENT_ORIGIN_SPAWNED_BY_SESSION = 'agent-session';

/** Origin the packaged agent skill sends on its shared curl invocation. */
export const AGENT_ORIGIN_CODEMAN_SKILL = 'codeman-skill';

/** Longest accepted origin token (the value is echoed into the UI and the marker). */
const MAX_ORIGIN_LENGTH = 32;

/** Longest accepted free-text field read back out of a marker. */
const MAX_MARKER_FIELD_LENGTH = 200;

/** Lowercase token: what an origin may look like on the wire and on disk. */
const AGENT_ORIGIN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Explains the file to whoever finds it in their case directory. */
const MARKER_NOTE =
  'Created by a Codeman agent worker (see the Manage tab in Add Case). ' +
  'Delete this file to keep the case out of the agent-case cleanup list; ' +
  'deleting the whole directory removes the case.';

/**
 * What a case directory records about the agent spawn that created it.
 * Every field beyond `version`/`createdAt`/`createdBy` is decoration for the cleanup UI.
 */
export interface AgentCaseMarker {
  version: typeof AGENT_CASE_MARKER_VERSION;
  /** ISO timestamp of the spawn that created the directory. */
  createdAt: string;
  /** Who asked: `codeman-skill`, `agent-session`, or another caller's own token. */
  createdBy: string;
  /** Full id of the session that spawned the worker, when one resolved. */
  parentSessionId?: string;
  /** That session's display name at spawn time, so the user recognises it later. */
  parentSessionName?: string;
  /** Run mode the worker was started in (`claude`, `deepseek`, …). */
  mode?: string;
  /** Owner the case was created for, in multi-user mode. */
  owner?: string;
}

/**
 * Validate an origin token coming off the wire (`agentOrigin` body field or the
 * `X-Codeman-Agent-Origin` header). Returns `undefined` for anything that is not a
 * short lowercase token — the value reaches the UI and a JSON file, so it is
 * allowlisted rather than escaped at each use.
 */
export function normalizeAgentOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_ORIGIN_LENGTH) return undefined;
  return AGENT_ORIGIN_PATTERN.test(value) ? value : undefined;
}

/** Trim an optional free-text marker field to something safe to store and render. */
function normalizeField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value ? value.slice(0, MAX_MARKER_FIELD_LENGTH) : undefined;
}

/**
 * Build a marker from a spawn's details. Pure, so the route can hand it straight to
 * the writer and the tests can assert on the shape without touching a disk.
 */
export function buildAgentCaseMarker(input: {
  createdBy: string;
  createdAt?: Date;
  parentSessionId?: string;
  parentSessionName?: string;
  mode?: string;
  owner?: string;
}): AgentCaseMarker {
  const marker: AgentCaseMarker = {
    version: AGENT_CASE_MARKER_VERSION,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    createdBy: normalizeAgentOrigin(input.createdBy) ?? AGENT_ORIGIN_SPAWNED_BY_SESSION,
  };
  const parentSessionId = normalizeField(input.parentSessionId);
  const parentSessionName = normalizeField(input.parentSessionName);
  const mode = normalizeField(input.mode);
  const owner = normalizeField(input.owner);
  if (parentSessionId) marker.parentSessionId = parentSessionId;
  if (parentSessionName) marker.parentSessionName = parentSessionName;
  if (mode) marker.mode = mode;
  if (owner) marker.owner = owner;
  return marker;
}

/**
 * Parse marker JSON. Returns `null` for anything that is not a well-formed version-1
 * marker, including a valid-JSON object of the wrong shape — see the strictness note
 * in the file header.
 */
export function parseAgentCaseMarker(raw: string): AgentCaseMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (record.version !== AGENT_CASE_MARKER_VERSION) return null;

  const createdAt = normalizeField(record.createdAt);
  const createdBy = normalizeAgentOrigin(record.createdBy);
  if (!createdAt || !createdBy || Number.isNaN(Date.parse(createdAt))) return null;

  return buildAgentCaseMarker({
    createdBy,
    createdAt: new Date(createdAt),
    parentSessionId: normalizeField(record.parentSessionId),
    parentSessionName: normalizeField(record.parentSessionName),
    mode: normalizeField(record.mode),
    owner: normalizeField(record.owner),
  });
}

/**
 * Write the marker into `casePath`. Best-effort by design: the marker is metadata for
 * a later cleanup, and a failed write must never fail the worker spawn that is the
 * point of the request. Returns whether it landed.
 */
export async function writeAgentCaseMarker(casePath: string, marker: AgentCaseMarker): Promise<boolean> {
  try {
    const body = JSON.stringify({ ...marker, note: MARKER_NOTE }, null, 2);
    await writeFile(join(casePath, AGENT_CASE_MARKER_FILE), `${body}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Read the marker out of `casePath`, or `null` if there isn't a valid one. */
export async function readAgentCaseMarker(casePath: string): Promise<AgentCaseMarker | null> {
  try {
    return parseAgentCaseMarker(await readFile(join(casePath, AGENT_CASE_MARKER_FILE), 'utf-8'));
  } catch {
    return null;
  }
}
