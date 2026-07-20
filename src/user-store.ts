/**
 * @fileoverview Multi-user store: `~/.codeman/users.json` (via `dataPath`, 0600).
 *
 * Mirrors the storage-module pattern of `remote-hosts.ts` / `docker-hosts.ts`, but
 * because it holds password hashes it writes atomically (tmp + rename) at mode
 * 0600 and keeps only a SHORT in-process cache so the CLI (`codeman users …`) can
 * edit the file while the server runs and have changes picked up within the TTL.
 *
 * Pure, IO-free helpers (`isValidUsername`, `hashPassword`, `verifyPasswordHash`,
 * `needsRehash`, `resolveClaudeModeForUser`, the last-admin invariants) are split
 * out so they are unit-testable without a server. Hashing is `scrypt` from
 * `node:crypto` (no new deps), compared via `timingSafeEqual`; parameters are
 * stored per record so cost can be raised later and old records rehashed on their
 * next successful login.
 *
 * See `docs/multi-user-plan.md` sections 4.1, 5, 6.3.
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dataPath, getDataDir } from './config/instance.js';
import { getUserSpacesDir, isMultiUserMode, maxUsers } from './config/multiuser.js';
import type { AuthUser, ClaudeMode, PasswordHash, PublicUser, UserRecord, UserRole, UsersFile } from './types.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const USERS_FILE = 'users.json';
const CACHE_TTL_MS = 1000;
const KEYLEN = 64;
const SALT_BYTES = 32;
/** Generous ceiling so raising N/r later does not trip scrypt's memory guard. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Current hashing parameters. Stored per record; raise these to increase cost. */
export const DEFAULT_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/** Username: lowercase, first char alphanumeric, 2-32 chars total. Becomes a folder name. */
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Typed error whose `.code` maps to an API errorCode at the route layer. */
export class UserStoreError extends Error {
  constructor(
    message: string,
    public readonly code: 'USER_EXISTS' | 'USER_NOT_FOUND' | 'LAST_ADMIN' | 'INVALID_INPUT'
  ) {
    super(message);
    this.name = 'UserStoreError';
  }
}

// ─────────────────────────────── pure helpers ───────────────────────────────

export function normalizeUsername(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(normalizeUsername(name));
}

/** Hash a password with the given (or current) scrypt params + a fresh random salt. */
export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = DEFAULT_SCRYPT_PARAMS
): Promise<PasswordHash> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { ...params, maxmem: SCRYPT_MAXMEM });
  return {
    algo: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('hex'),
    hash: derived.toString('hex'),
  };
}

/** Constant-time verify of a password against a stored hash record. Never throws. */
export async function verifyPasswordHash(password: string, record: PasswordHash): Promise<boolean> {
  if (!record || record.algo !== 'scrypt') return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(record.salt, 'hex');
    expected = Buffer.from(record.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N: record.N,
      r: record.r,
      p: record.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash uses weaker params than current and should be rehashed. */
export function needsRehash(record: PasswordHash, params = DEFAULT_SCRYPT_PARAMS): boolean {
  return record.algo !== 'scrypt' || record.N !== params.N || record.r !== params.r || record.p !== params.p;
}

/** URL-safe one-time password (16 chars) for admin create/reset flows. */
export function generateOneTimePassword(): string {
  return randomBytes(12).toString('base64url');
}

export function toPublicUser(u: UserRecord): PublicUser {
  return {
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    mustChangePassword: !!u.mustChangePassword,
    canBypassPermissions: !!u.canBypassPermissions,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function countEnabledAdmins(users: UserRecord[]): number {
  return users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

/**
 * Section 6.3: resolve the effective Claude permission mode for a user. Admins and
 * granted users get the global mode as-is; a non-granted regular user whose mode
 * would be `dangerously-skip-permissions` is silently downgraded to `auto` (all
 * other modes are already <= auto and pass through). Pure.
 */
export function resolveClaudeModeForUser(
  globalMode: ClaudeMode | undefined,
  grant: { role: UserRole; canBypassPermissions?: boolean }
): ClaudeMode {
  const mode: ClaudeMode = globalMode ?? 'dangerously-skip-permissions';
  if (grant.role === 'admin' || grant.canBypassPermissions) return mode;
  return mode === 'dangerously-skip-permissions' ? 'auto' : mode;
}

/**
 * Section 6.3: whether a user may run arbitrary commands as the host account
 * (shell-mode sessions, cron `launchCommand`, other CLIs' bypass flags). Same
 * one-bit grant as bypass. Admins always may.
 */
export function canRunPrivilegedCommands(grant: { role: UserRole; canBypassPermissions?: boolean }): boolean {
  return grant.role === 'admin' || !!grant.canBypassPermissions;
}

// ─────────────────────────────── IO layer ───────────────────────────────

let cache: { users: UserRecord[]; ts: number } | null = null;

/** Drop the in-process cache (called after every write; exported for tests). */
export function invalidateUsersCache(): void {
  cache = null;
}

export async function readUsers(force = false): Promise<UserRecord[]> {
  const now = Date.now();
  if (!force && cache && now - cache.ts < CACHE_TTL_MS) return cache.users;
  try {
    const raw = await fs.readFile(dataPath(USERS_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    cache = { users, ts: now };
    return users;
  } catch {
    cache = { users: [], ts: now };
    return [];
  }
}

async function writeUsers(users: UserRecord[]): Promise<void> {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = dataPath(USERS_FILE);
  const tmpPath = `${finalPath}.tmp`;
  const payload: UsersFile = { version: 1, users };
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => {});
  await fs.rename(tmpPath, finalPath);
  cache = { users, ts: Date.now() };
}

export async function hasUsers(): Promise<boolean> {
  return (await readUsers()).length > 0;
}

export async function findUser(username: string): Promise<UserRecord | undefined> {
  const norm = normalizeUsername(username);
  if (!norm) return undefined;
  const users = await readUsers();
  return users.find((u) => u.username === norm);
}

export interface CreateUserOptions {
  username: string;
  role: UserRole;
  password: string;
  mustChangePassword?: boolean;
  canBypassPermissions?: boolean;
}

export async function createUser(opts: CreateUserOptions): Promise<UserRecord> {
  const username = normalizeUsername(opts.username);
  if (!isValidUsername(username)) {
    throw new UserStoreError(
      'Username must be lowercase, start alphanumeric, 2-32 chars ([a-z0-9_-])',
      'INVALID_INPUT'
    );
  }
  if (opts.role !== 'admin' && opts.role !== 'user') {
    throw new UserStoreError('Role must be "admin" or "user"', 'INVALID_INPUT');
  }
  if (!opts.password || opts.password.length < 8) {
    throw new UserStoreError('Password must be at least 8 characters', 'INVALID_INPUT');
  }
  const users = await readUsers(true);
  if (users.some((u) => u.username === username)) {
    throw new UserStoreError(`User "${username}" already exists`, 'USER_EXISTS');
  }
  if (users.length >= maxUsers()) {
    throw new UserStoreError(`Maximum number of users (${maxUsers()}) reached`, 'INVALID_INPUT');
  }
  const record: UserRecord = {
    username,
    role: opts.role,
    password: await hashPassword(opts.password),
    disabled: false,
    mustChangePassword: !!opts.mustChangePassword,
    canBypassPermissions: !!opts.canBypassPermissions,
    createdAt: Date.now(),
  };
  users.push(record);
  await writeUsers(users);
  return record;
}

/** Set a user's password. `mustChangePassword` is left unchanged unless specified. */
export async function setPassword(
  username: string,
  password: string,
  opts: { mustChangePassword?: boolean } = {}
): Promise<UserRecord> {
  if (!password || password.length < 8) {
    throw new UserStoreError('Password must be at least 8 characters', 'INVALID_INPUT');
  }
  const norm = normalizeUsername(username);
  const users = await readUsers(true);
  const record = users.find((u) => u.username === norm);
  if (!record) throw new UserStoreError(`User "${norm}" not found`, 'USER_NOT_FOUND');
  record.password = await hashPassword(password);
  if (opts.mustChangePassword !== undefined) record.mustChangePassword = opts.mustChangePassword;
  await writeUsers(users);
  return record;
}

export interface UpdateUserPatch {
  role?: UserRole;
  disabled?: boolean;
  canBypassPermissions?: boolean;
  mustChangePassword?: boolean;
}

export async function updateUser(username: string, patch: UpdateUserPatch): Promise<UserRecord> {
  const norm = normalizeUsername(username);
  const users = await readUsers(true);
  const record = users.find((u) => u.username === norm);
  if (!record) throw new UserStoreError(`User "${norm}" not found`, 'USER_NOT_FOUND');

  // Guard the last-enabled-admin invariant against demote/disable.
  const before = countEnabledAdmins(users);
  const projected: UserRecord = {
    ...record,
    role: patch.role ?? record.role,
    disabled: patch.disabled ?? record.disabled,
  };
  const after = countEnabledAdmins(users.map((u) => (u.username === norm ? projected : u)));
  if (before > 0 && after === 0) {
    throw new UserStoreError('Cannot demote or disable the last enabled admin', 'LAST_ADMIN');
  }

  if (patch.role !== undefined) record.role = patch.role;
  if (patch.disabled !== undefined) record.disabled = patch.disabled;
  if (patch.canBypassPermissions !== undefined) record.canBypassPermissions = patch.canBypassPermissions;
  if (patch.mustChangePassword !== undefined) record.mustChangePassword = patch.mustChangePassword;
  await writeUsers(users);
  return record;
}

/** Record a successful login timestamp. Best-effort; failures are swallowed. */
export async function touchLastLogin(username: string): Promise<void> {
  const norm = normalizeUsername(username);
  try {
    const users = await readUsers(true);
    const record = users.find((u) => u.username === norm);
    if (!record) return;
    record.lastLoginAt = Date.now();
    await writeUsers(users);
  } catch {
    /* best-effort */
  }
}

export async function deleteUser(username: string): Promise<void> {
  const norm = normalizeUsername(username);
  const users = await readUsers(true);
  const record = users.find((u) => u.username === norm);
  if (!record) throw new UserStoreError(`User "${norm}" not found`, 'USER_NOT_FOUND');
  const before = countEnabledAdmins(users);
  const remaining = users.filter((u) => u.username !== norm);
  const after = countEnabledAdmins(remaining);
  if (before > 0 && after === 0) {
    throw new UserStoreError('Cannot delete the last enabled admin', 'LAST_ADMIN');
  }
  await writeUsers(remaining);
}

/**
 * First-boot bootstrap: in multi-user mode with no users yet, create the initial
 * admin from `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` if both are set. Returns a
 * status the caller (server start / CLI) uses to decide whether to refuse boot.
 */
export async function bootstrapInitialAdmin(): Promise<{
  status: 'created' | 'exists' | 'missing-env';
  username?: string;
}> {
  if (await hasUsers()) return { status: 'exists' };
  const username = process.env.CODEMAN_USERNAME;
  const password = process.env.CODEMAN_PASSWORD;
  if (!username || !password) return { status: 'missing-env' };
  const created = await createUser({ username, role: 'admin', password });
  return { status: 'created', username: created.username };
}

/**
 * Delete a user's on-disk space (`<USER_SPACES_DIR>/<username>`) with the section 8
 * guard rails: the top-level dir must not be a symlink, and its realpath must
 * resolve strictly inside USER_SPACES_DIR (so a symlinked or `..`-escaping target
 * can never be used to rm an arbitrary tree). No-op if the space does not exist.
 */
export async function deleteUserSpace(username: string): Promise<void> {
  const norm = normalizeUsername(username);
  if (!isValidUsername(norm)) throw new UserStoreError('Invalid username', 'INVALID_INPUT');
  const root = getUserSpacesDir();
  const target = join(root, norm);
  let lst;
  try {
    lst = await fs.lstat(target);
  } catch {
    return; // nothing to delete
  }
  if (lst.isSymbolicLink()) {
    throw new UserStoreError('Refusing to delete a symlinked user space', 'INVALID_INPUT');
  }
  const realRoot = await fs.realpath(root).catch(() => root);
  const realTarget = await fs.realpath(target);
  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UserStoreError('User space escapes USER_SPACES_DIR', 'INVALID_INPUT');
  }
  await fs.rm(realTarget, { recursive: true, force: true });
}

/** The synthetic admin used in single-user mode so downstream has one code path. */
export const SYNTHETIC_ADMIN: AuthUser = { username: 'admin', role: 'admin' };

/**
 * Resolve the effective Claude mode for a username by looking up the grant. In
 * single-user mode (or for an unknown owner) the global mode passes through.
 */
export async function resolveClaudeModeForUsername(
  globalMode: ClaudeMode | undefined,
  username: string | undefined
): Promise<ClaudeMode> {
  const fallback: ClaudeMode = globalMode ?? 'dangerously-skip-permissions';
  if (!isMultiUserMode() || !username) return fallback;
  const user = await findUser(username);
  if (!user) return fallback;
  return resolveClaudeModeForUser(globalMode, user);
}
