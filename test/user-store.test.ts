/**
 * @fileoverview Unit tests for the multi-user store (src/user-store.ts).
 *
 * Pure helpers (hashing/verify/params-upgrade/username validation/6.3 resolvers)
 * plus the IO layer against a per-test temp data dir (CODEMAN_DATA_DIR) so nothing
 * touches the real ~/.codeman. No server, no tmux.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapInitialAdmin,
  canRunPrivilegedCommands,
  countEnabledAdmins,
  createUser,
  DEFAULT_SCRYPT_PARAMS,
  deleteUser,
  deleteUserSpace,
  findUser,
  generateOneTimePassword,
  hashPassword,
  hasUsers,
  invalidateUsersCache,
  isValidUsername,
  needsRehash,
  normalizeUsername,
  readUsers,
  resolveClaudeModeForUser,
  setPassword,
  toPublicUser,
  touchLastLogin,
  updateUser,
  UserStoreError,
  verifyPasswordHash,
} from '../src/user-store.js';

let tmpDir: string;
let spacesDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-users-'));
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-spaces-'));
  for (const k of [
    'CODEMAN_DATA_DIR',
    'CODEMAN_USER_SPACES_DIR',
    'CODEMAN_MULTIUSER',
    'CODEMAN_MAX_USERS',
    'CODEMAN_USERNAME',
    'CODEMAN_PASSWORD',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.CODEMAN_DATA_DIR = tmpDir;
  process.env.CODEMAN_USER_SPACES_DIR = spacesDir;
  delete process.env.CODEMAN_MAX_USERS;
  invalidateUsersCache();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
});

describe('username validation', () => {
  it('accepts valid slugs', () => {
    for (const n of ['alice', 'bob99', 'a1', 'x_y-z', 'user-name_1']) {
      expect(isValidUsername(n)).toBe(true);
    }
  });
  it('rejects invalid slugs', () => {
    for (const n of [
      '',
      'a',
      'A',
      '1',
      '_leading',
      '-leading',
      'has space',
      'has.dot',
      'a/b',
      '..',
      'toolongxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ]) {
      expect(isValidUsername(n)).toBe(false);
    }
  });
  it('accepts mixed-case input by normalizing (case-insensitive usernames)', () => {
    expect(isValidUsername('Alice')).toBe(true);
    expect(normalizeUsername('  ALICE ')).toBe('alice');
  });
});

describe('password hashing', () => {
  it('round-trips a correct password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse');
    expect(h.algo).toBe('scrypt');
    expect(h.salt).toMatch(/^[0-9a-f]+$/);
    expect(await verifyPasswordHash('correct horse', h)).toBe(true);
    expect(await verifyPasswordHash('wrong password', h)).toBe(false);
  });
  it('produces a distinct salt each time', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
  it('never throws on a malformed record', async () => {
    expect(await verifyPasswordHash('x', { algo: 'scrypt', N: 1, r: 1, p: 1, salt: 'zz', hash: '' })).toBe(false);
    // @ts-expect-error deliberately malformed
    expect(await verifyPasswordHash('x', { algo: 'bogus' })).toBe(false);
  });
  it('needsRehash detects weaker params', async () => {
    const h = await hashPassword('pw', DEFAULT_SCRYPT_PARAMS);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash({ ...h, N: 1024 })).toBe(true);
    expect(needsRehash({ ...h, algo: 'md5' as unknown as 'scrypt' })).toBe(true);
  });
  it('generateOneTimePassword returns a >=8 char url-safe string', () => {
    const pw = generateOneTimePassword();
    expect(pw.length).toBeGreaterThanOrEqual(8);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('resolveClaudeModeForUser (section 6.3)', () => {
  it('admins are unrestricted', () => {
    expect(resolveClaudeModeForUser('dangerously-skip-permissions', { role: 'admin' })).toBe(
      'dangerously-skip-permissions'
    );
  });
  it('granted regular users keep bypass', () => {
    expect(resolveClaudeModeForUser('dangerously-skip-permissions', { role: 'user', canBypassPermissions: true })).toBe(
      'dangerously-skip-permissions'
    );
  });
  it('non-granted regular users downgrade skip -> auto', () => {
    expect(resolveClaudeModeForUser('dangerously-skip-permissions', { role: 'user' })).toBe('auto');
    expect(resolveClaudeModeForUser(undefined, { role: 'user' })).toBe('auto');
  });
  it('non-granted regular users pass through modes already <= auto', () => {
    expect(resolveClaudeModeForUser('auto', { role: 'user' })).toBe('auto');
    expect(resolveClaudeModeForUser('normal', { role: 'user' })).toBe('normal');
    expect(resolveClaudeModeForUser('allowedTools', { role: 'user' })).toBe('allowedTools');
  });
  it('canRunPrivilegedCommands follows the same grant', () => {
    expect(canRunPrivilegedCommands({ role: 'admin' })).toBe(true);
    expect(canRunPrivilegedCommands({ role: 'user', canBypassPermissions: true })).toBe(true);
    expect(canRunPrivilegedCommands({ role: 'user' })).toBe(false);
  });
});

describe('user store IO', () => {
  it('creates, reads back, and writes users.json at mode 0600 atomically', async () => {
    expect(await hasUsers()).toBe(false);
    const u = await createUser({ username: 'Alice', role: 'admin', password: 'password1' });
    expect(u.username).toBe('alice');
    expect(u.role).toBe('admin');
    expect(await hasUsers()).toBe(true);

    const file = path.join(tmpDir, 'users.json');
    expect(existsSync(file)).toBe(true);
    // 0600 on POSIX
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    // no leftover tmp file
    expect(existsSync(file + '.tmp')).toBe(false);

    const found = await findUser('ALICE');
    expect(found?.username).toBe('alice');
    expect(toPublicUser(found!)).not.toHaveProperty('password');
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    await createUser({ username: 'bob', role: 'user', password: 'password1' });
    await expect(createUser({ username: 'BOB', role: 'user', password: 'password2' })).rejects.toMatchObject({
      code: 'USER_EXISTS',
    });
  });

  it('rejects invalid username and short password', async () => {
    await expect(createUser({ username: 'Bad Name', role: 'user', password: 'password1' })).rejects.toBeInstanceOf(
      UserStoreError
    );
    await expect(createUser({ username: 'good', role: 'user', password: 'short' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('enforces MAX_USERS', async () => {
    process.env.CODEMAN_MAX_USERS = '2';
    await createUser({ username: 'a1', role: 'admin', password: 'password1' });
    await createUser({ username: 'a2', role: 'user', password: 'password1' });
    await expect(createUser({ username: 'a3', role: 'user', password: 'password1' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('setPassword changes the hash and can clear mustChangePassword', async () => {
    await createUser({ username: 'carol', role: 'user', password: 'password1', mustChangePassword: true });
    const before = await findUser('carol');
    expect(before?.mustChangePassword).toBe(true);
    await setPassword('carol', 'password2', { mustChangePassword: false });
    const after = await findUser('carol');
    expect(after?.mustChangePassword).toBe(false);
    expect(await verifyPasswordHash('password2', after!.password)).toBe(true);
    expect(await verifyPasswordHash('password1', after!.password)).toBe(false);
  });

  it('touchLastLogin records a timestamp', async () => {
    await createUser({ username: 'dave', role: 'user', password: 'password1' });
    expect((await findUser('dave'))?.lastLoginAt).toBeUndefined();
    await touchLastLogin('dave');
    expect((await findUser('dave'))?.lastLoginAt).toBeTypeOf('number');
  });
});

describe('last-admin invariants', () => {
  it('cannot demote the last enabled admin', async () => {
    await createUser({ username: 'root', role: 'admin', password: 'password1' });
    await createUser({ username: 'joe', role: 'user', password: 'password1' });
    expect(countEnabledAdmins(await readUsers(true))).toBe(1);
    await expect(updateUser('root', { role: 'user' })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(updateUser('root', { disabled: true })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('cannot delete the last enabled admin', async () => {
    await createUser({ username: 'root', role: 'admin', password: 'password1' });
    await expect(deleteUser('root')).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('allows demote/delete when another admin remains', async () => {
    await createUser({ username: 'root', role: 'admin', password: 'password1' });
    await createUser({ username: 'root2', role: 'admin', password: 'password1' });
    await expect(updateUser('root', { role: 'user' })).resolves.toMatchObject({ role: 'user' });
    await createUser({ username: 'root3', role: 'admin', password: 'password1' });
    await expect(deleteUser('root2')).resolves.toBeUndefined();
  });

  it('updateUser toggles canBypassPermissions', async () => {
    await createUser({ username: 'grantee', role: 'user', password: 'password1' });
    const updated = await updateUser('grantee', { canBypassPermissions: true });
    expect(updated.canBypassPermissions).toBe(true);
  });
});

describe('deleteUserSpace guards (section 8)', () => {
  it('deletes a real space dir inside USER_SPACES_DIR', async () => {
    const dir = path.join(spacesDir, 'ed', 'cases', 'proj');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(spacesDir, 'ed', 'cases', 'proj', 'f.txt'), 'x');
    expect(existsSync(path.join(spacesDir, 'ed'))).toBe(true);
    await deleteUserSpace('ed');
    expect(existsSync(path.join(spacesDir, 'ed'))).toBe(false);
  });

  it('is a no-op when the space does not exist', async () => {
    await expect(deleteUserSpace('ghost')).resolves.toBeUndefined();
  });

  it('refuses to delete a symlinked user space', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-outside-'));
    await fs.symlink(outside, path.join(spacesDir, 'evil'));
    await expect(deleteUserSpace('evil')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // the symlink target still exists (was not followed + removed)
    expect(existsSync(outside)).toBe(true);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('bootstrapInitialAdmin', () => {
  it('creates the initial admin from env when no users exist', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    process.env.CODEMAN_USERNAME = 'boss';
    process.env.CODEMAN_PASSWORD = 'password1';
    const r = await bootstrapInitialAdmin();
    expect(r).toMatchObject({ status: 'created', username: 'boss' });
    expect((await findUser('boss'))?.role).toBe('admin');
  });

  it('reports missing-env when no users and no credentials', async () => {
    delete process.env.CODEMAN_USERNAME;
    delete process.env.CODEMAN_PASSWORD;
    expect(await bootstrapInitialAdmin()).toMatchObject({ status: 'missing-env' });
  });

  it('reports exists when users already present', async () => {
    await createUser({ username: 'someone', role: 'admin', password: 'password1' });
    expect(await bootstrapInitialAdmin()).toMatchObject({ status: 'exists' });
  });
});
