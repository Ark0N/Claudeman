/**
 * @fileoverview Shared sensitive-path blocklist.
 *
 * A small defense-in-depth blocklist of absolute paths that must never be
 * served to the browser regardless of how the path was obtained (workspace
 * download, cross-workspace attachment registration, raw/preview serving).
 *
 * This is intentionally a BLOCKLIST, not a workspace-confinement check:
 * cross-workspace attachment is a supported feature (codeman-publish skill +
 * the automated review-card loop attaching files under ~/.codeman/), so a
 * strict session-workspace boundary would break legitimate use. The blocklist
 * rejects well-known secret locations (system password files, SSH keys, cloud
 * credentials, dotenv files) while leaving ordinary cross-workspace files
 * attachable.
 *
 * ⚠️ The path picker's `showHidden` option is what makes the dot-prefixed half
 * of this list load-bearing. Before it existed, the picker refused every path
 * with a hidden segment, so `~/.config/gh/hosts.yml` and friends were
 * unreachable by construction and the list only had to cover the few secrets
 * that live in plain sight. Opting into hidden entries removes that accident,
 * so every credential location below has to be named. Adding a new browse
 * surface means re-reading this file, not assuming it already covers you.
 *
 * ⚠️ Deliberately NOT whole-tree blocks: `~/.codeman/` (the publish skill
 * attaches from it) and `~/.claude/` (transcripts and team state are ordinary
 * files worth attaching). Only their secret-bearing members are named.
 *
 * Callers MUST resolve symlinks (realpath) BEFORE calling isSensitivePath so a
 * symlink pointing at a sensitive target is also caught.
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  // System account databases.
  /^\/etc\/shadow$/,
  /^\/etc\/gshadow$/,
  /^\/etc\/master\.passwd$/,

  // SSH and GPG private key material. `.ssh/` is matched at any depth rather
  // than only under homedir(): a per-project or per-deploy key directory holds
  // exactly the same secret, and it drops a homedir() read that is captured at
  // module load and therefore wrong for anything that changes HOME later.
  /\/\.ssh\//,
  /\/\.gnupg\//,

  // Dotenv, in every conventional spelling (.env, .env.local, .env.production).
  /\/\.env$/,
  /\/\.env\./,

  // Generic credential files, plus the per-vendor spellings that do not match it.
  /\/credentials(\.json|\.yml|\.yaml|\.xml|\.toml|\.db)?$/i,
  /\/\.aws\/(credentials|config)$/,
  /\/\.aws\/sso\/cache\//,
  /\/\.gcloud\/credentials\.db$/,
  /\/\.config\/gcloud\//,
  /\/\.azure\//,
  /\/\.docker\/config\.json$/,
  /\/\.kube\/config$/,

  // Package-registry and forge tokens. Each of these is a bearer credential in
  // a plain-text dotfile, which is exactly what a path picker will surface.
  /\/\.npmrc$/,
  /\/\.yarnrc\.yml$/,
  /\/\.git-credentials$/,
  /\/\.config\/gh\//,
  /\/\.config\/hub$/,
  /\/\.netrc$/,
  /\/_netrc$/,
  /\/\.pypirc$/,
  /\/\.gem\/credentials$/,
  /\/\.cargo\/credentials(\.toml)?$/,
  /\/\.terraformrc$/,
  /\/\.terraform\.d\//,

  // Database client credentials.
  /\/\.pgpass$/,
  /\/\.my\.cnf$/,

  // Agent CLI credentials, including Codeman's own hook secret and user table.
  // Named individually so the surrounding trees stay attachable (see above).
  /\/\.claude\/\.credentials\.json$/,
  /\/\.codeman[^/]*\/hook-secret$/,
  /\/\.codeman[^/]*\/users\.json$/,
];

/**
 * Returns true if the given ABSOLUTE, symlink-resolved path matches the
 * sensitive-file blocklist and must not be served to the browser.
 */
export function isSensitivePath(absPath: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(absPath));
}
