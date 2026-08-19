/**
 * @fileoverview Pure file-name/path query matcher for the Files panel search
 * (COD-236). Compiles a user query string into a reusable predicate so the
 * server-side file walk can prune to matching entries instead of streaming the
 * whole tree.
 *
 * Semantics:
 * - Empty / whitespace-only query → `compileFileQuery` returns `null` (the
 *   caller treats this as "no search", falling back to the full tree). A query
 *   longer than `MAX_QUERY_LENGTH` compiles to `null` too: no honest filename
 *   search is that long, and the glob walk below is O(text · pattern).
 * - A query containing a glob metachar (`*` or `?`) matches anchored and
 *   case-insensitively, `*` spanning any run (slashes included) and `?` exactly
 *   one character; every other character matches literally.
 * - Otherwise the query is a plain case-insensitive substring.
 * - When the query contains a `/` it matches against the relative path; else it
 *   matches against the bare entry name.
 *
 * ⚠️ Globs are matched by `globMatch` below, never by compiling the query into
 * a RegExp: `*a*a*a…` translated to `^.*a.*a.*a…$` is a classic backtracking
 * blowup, evaluated synchronously against every walked path — a pathological
 * query could freeze the event loop for the whole server (the same reason
 * `search-service.ts` is regex-free). The two-pointer wildcard walk is
 * O(text · pattern) worst case, with both operands short by construction.
 *
 * No fs / IO — safe to unit-test directly.
 */

export type FileQueryMatcher = (name: string, relativePath: string) => boolean;

// Longer than any honest file search; bounds the O(text · pattern) glob walk.
const MAX_QUERY_LENGTH = 256;

/**
 * Anchored glob match, linear-space two-pointer walk (no RegExp — see the
 * fileoverview). `pattern` must already be lowercased; `text` is lowercased
 * here so one compiled matcher serves many entries.
 */
function globMatch(pattern: string, rawText: string): boolean {
  const text = rawText.toLowerCase();
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = -1;
  while (t < text.length) {
    const pc = p < pattern.length ? pattern[p] : '';
    if (pc === '?' || pc === text[t]) {
      p++;
      t++;
    } else if (pc === '*') {
      // Remember the star; try matching zero characters first, and on a later
      // mismatch re-expand it one character at a time from here.
      starP = p++;
      starT = t;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Compile a query string into a matcher predicate, or `null` when the query is
 * empty/whitespace or overlong (caller treats null as "no search").
 */
export function compileFileQuery(query: string): FileQueryMatcher | null {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed.length > MAX_QUERY_LENGTH) return null;

  const matchesPath = trimmed.includes('/');
  const isGlob = trimmed.includes('*') || trimmed.includes('?');

  if (isGlob) {
    const pattern = trimmed.toLowerCase();
    return (name, relativePath) => globMatch(pattern, matchesPath ? relativePath : name);
  }

  const needle = trimmed.toLowerCase();
  return (name, relativePath) => (matchesPath ? relativePath : name).toLowerCase().includes(needle);
}

/**
 * Convenience: compile the query and apply it in one call. Returns false when
 * the query compiles to null (empty).
 */
export function matchFileQuery(query: string, name: string, relativePath: string): boolean {
  const matcher = compileFileQuery(query);
  return matcher ? matcher(name, relativePath) : false;
}
