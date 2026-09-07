/**
 * @fileoverview Reverse-proxy base-path support — the single source of truth for
 * the URL prefix Codeman is mounted under.
 *
 * When Codeman runs behind a reverse proxy at a sub-path (e.g. `/codeman/`), the
 * proxy forwards the FULL request path INCLUDING that prefix (it does not strip
 * it). Every URL the server emits to the browser (the HTML shell, redirects,
 * the manifest/service-worker) and every URL the browser builds (fetch/SSE/WS)
 * must therefore carry the prefix too.
 *
 * This module normalizes the operator-supplied value (`--base-url` / the
 * `CODEMAN_BASE_URL` env var) into ONE canonical form used everywhere:
 *   - `''`      — mounted at the origin root (the default, `/`)
 *   - `/foo`    — mounted at a sub-path (leading slash, NO trailing slash)
 *
 * Keeping the normalized form free of a trailing slash means `basePath + '/api/x'`
 * and `basePath + '/'` both compose cleanly, and `''` degrades to the historical
 * root behavior with no special-casing at the call sites.
 *
 * @module config/base-path
 */

/**
 * A normalized base path is either empty (root) or one-or-more `/segment`
 * groups, where a segment is a conservative, proxy-safe subset of path
 * characters. This deliberately excludes anything that could change routing
 * meaning (`?`, `#`, `:`, whitespace, `%`) so the prefix is a plain path.
 */
const VALID_BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;

/**
 * Normalize an operator-supplied base path into the canonical form.
 *
 * Accepts loose input (`codeman`, `/codeman`, `/codeman/`, `//codeman//`) and
 * returns `''` for root or `/codeman` otherwise. Does NOT validate the character
 * set — call {@link assertValidBasePath} (or {@link isValidBasePath}) for that.
 */
export function normalizeBasePath(input: string | undefined | null): string {
  if (input === undefined || input === null) return '';
  let p = String(input).trim();
  if (p === '' || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/'); // collapse duplicate slashes
  p = p.replace(/\/+$/, ''); // drop trailing slash(es)
  return p;
}

/** True if `normalized` is a legal canonical base path (`''` or `/seg[/seg...]`). */
export function isValidBasePath(normalized: string): boolean {
  return normalized === '' || VALID_BASE_PATH.test(normalized);
}

/**
 * Normalize AND validate, throwing a human-readable error on bad input. Used by
 * the CLI so a typo (`--base-url /a b`, `--base-url ?x`) fails loudly at startup
 * instead of silently producing broken URLs.
 */
export function assertValidBasePath(input: string | undefined | null): string {
  const normalized = normalizeBasePath(input);
  if (!isValidBasePath(normalized)) {
    throw new Error(
      `Invalid --base-url ${JSON.stringify(input)}: use a plain path like "/codeman" ` +
        `(letters, digits, and ._~- in each segment).`
    );
  }
  return normalized;
}

/**
 * Join the base path onto a root-absolute application path (`/api/x` → `/base/api/x`).
 *
 * Leaves alone anything that is not a root-absolute app path: empty strings,
 * protocol-relative (`//host`) and absolute URLs (`http://`, `ws://`, `data:`),
 * fragments/queries, and paths already carrying the prefix. This is the one
 * function the whole codebase routes URL construction through.
 */
export function joinBasePath(basePath: string, path: string): string {
  if (!basePath) return path;
  if (typeof path !== 'string' || path.length === 0) return path;
  if (!path.startsWith('/')) return path; // relative / fragment / query — resolved against <base>
  if (path.startsWith('//')) return path; // protocol-relative
  if (path === basePath || path.startsWith(basePath + '/') || path.startsWith(basePath + '?')) {
    return path; // already prefixed
  }
  return basePath + path;
}

/**
 * Strip the base path off an INCOMING request URL so internal routing stays
 * prefix-agnostic. Requests that arrive WITHOUT the prefix (health checks,
 * hooks, the docker bridge — all of which hit the raw port, bypassing the proxy)
 * are returned unchanged, so the server answers at both `/api/x` and
 * `/base/api/x`.
 */
export function stripBasePath(basePath: string, url: string): string {
  if (!basePath) return url;
  if (url === basePath) return '/';
  if (url.startsWith(basePath + '/')) return url.slice(basePath.length);
  if (url.startsWith(basePath + '?')) return '/' + url.slice(basePath.length);
  return url;
}
