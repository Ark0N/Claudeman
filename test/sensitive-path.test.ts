/**
 * @fileoverview The shared sensitive-path blocklist (`src/web/sensitive-path.ts`).
 *
 * This list guards every browser-facing file surface: workspace download,
 * cross-workspace attachment registration, raw/preview serving, and the
 * filesystem path picker.
 *
 * It became load-bearing when the picker gained `showHidden` (issue #221).
 * Before that, the picker refused any path with a dot-prefixed segment, so most
 * of the credential locations below were unreachable by construction and the
 * list only had to cover secrets that sit in plain sight. Opting into hidden
 * entries removes that accident, which is why each entry is pinned here: a
 * pattern silently dropped in a refactor would re-expose a real token.
 *
 * The list is a BLOCKLIST by design (cross-workspace attachment is a supported
 * feature), so the "stays attachable" cases matter just as much: over-blocking
 * breaks the publish skill and the review-card loop.
 */
import { describe, expect, it } from 'vitest';
import { isSensitivePath } from '../src/web/sensitive-path.js';

const HOME = '/home/dev';

describe('isSensitivePath', () => {
  describe('blocks', () => {
    const blocked: Array<[string, string]> = [
      ['system shadow file', '/etc/shadow'],
      ['system gshadow file', '/etc/gshadow'],
      ['BSD master password db', '/etc/master.passwd'],

      ['ssh keys in home', `${HOME}/.ssh/id_ed25519`],
      // Not only under homedir(): a deploy key in a project is the same secret,
      // and the old homedir()-anchored pattern was captured at module load.
      ['ssh keys anywhere', '/srv/deploy/.ssh/id_rsa'],
      ['gpg keyring', `${HOME}/.gnupg/private-keys-v1.d/key.key`],

      ['dotenv', '/srv/app/.env'],
      ['suffixed dotenv', '/srv/app/.env.production'],
      // Pre-existing and deliberate: `.env.*` is blocked wholesale, so even a
      // committed `.env.example` is refused rather than risking the one repo
      // whose "example" holds a live key.
      ['a dotenv example', '/srv/app/.env.example'],

      ['generic credentials file', '/srv/app/credentials'],
      ['json credentials', '/srv/app/credentials.json'],
      ['toml credentials', '/srv/app/credentials.toml'],
      ['aws credentials', `${HOME}/.aws/credentials`],
      ['aws config', `${HOME}/.aws/config`],
      ['aws sso cache', `${HOME}/.aws/sso/cache/abc.json`],
      ['legacy gcloud credential db', `${HOME}/.gcloud/credentials.db`],
      ['modern gcloud config tree', `${HOME}/.config/gcloud/application_default_credentials.json`],
      ['azure profile', `${HOME}/.azure/accessTokens.json`],
      ['docker registry auth', `${HOME}/.docker/config.json`],
      ['kubernetes context', `${HOME}/.kube/config`],

      ['npm token', `${HOME}/.npmrc`],
      ['yarn token', `${HOME}/.yarnrc.yml`],
      ['git credential store', `${HOME}/.git-credentials`],
      ['gh cli token', `${HOME}/.config/gh/hosts.yml`],
      ['hub token', `${HOME}/.config/hub`],
      ['netrc', `${HOME}/.netrc`],
      ['windows netrc', `${HOME}/_netrc`],
      ['pypi token', `${HOME}/.pypirc`],
      ['rubygems token', `${HOME}/.gem/credentials`],
      ['cargo token', `${HOME}/.cargo/credentials.toml`],
      ['terraform cli config', `${HOME}/.terraformrc`],
      ['terraform credentials dir', `${HOME}/.terraform.d/credentials.tfrc.json`],

      ['postgres password file', `${HOME}/.pgpass`],
      ['mysql client config', `${HOME}/.my.cnf`],

      ['claude oauth token', `${HOME}/.claude/.credentials.json`],
      ['codeman hook secret', `${HOME}/.codeman/hook-secret`],
      ['codeman user table', `${HOME}/.codeman/users.json`],
      ['codeman hook secret on a named instance', `${HOME}/.codeman-beta/hook-secret`],
    ];

    it.each(blocked)('blocks the %s', (_label, path) => {
      expect(isSensitivePath(path)).toBe(true);
    });
  });

  describe('leaves ordinary files attachable', () => {
    const allowed: Array<[string, string]> = [
      ['a source file', '/srv/app/src/index.ts'],
      ['a dotfile that carries no secret', '/srv/app/.gitignore'],
      ['a hidden CI directory', '/srv/app/.github/workflows/ci.yml'],
      // The publish skill and the review-card loop attach from these trees, so
      // only their named secret members are blocked, never the whole tree.
      ['a codeman screenshot', `${HOME}/.codeman/screenshots/shot.png`],
      ['a claude transcript', `${HOME}/.claude/projects/proj/session.jsonl`],
      ['a claude team inbox', `${HOME}/.claude/teams/alpha/inboxes/bob.json`],
      // isUnderTree-style separator awareness: a sibling name that merely starts
      // with a blocked segment must not be caught.
      ['an unrelated sshd notes file', '/srv/notes/.sshd-setup.md'],
      ['a file named credentials-policy.md', '/srv/app/credentials-policy.md'],
    ];

    it.each(allowed)('allows %s', (_label, path) => {
      expect(isSensitivePath(path)).toBe(false);
    });
  });

  it('matches on the resolved path, so callers must realpath first', () => {
    // The function itself is pure string matching; this pins the contract its
    // docblock states, which every caller depends on.
    expect(isSensitivePath('/srv/app/looks-innocent')).toBe(false);
    expect(isSensitivePath(`${HOME}/.ssh/looks-innocent`)).toBe(true);
  });
});
