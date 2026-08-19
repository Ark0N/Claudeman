/**
 * @fileoverview Pure file-name/path query matcher for the Files panel search
 * (COD-236). Compiles a user query string into a reusable predicate so the
 * server-side file walk can prune to matching entries instead of streaming the
 * whole tree.
 *
 * Semantics:
 * - Empty / whitespace-only query → `compileFileQuery` returns `null` (the
 *   caller treats this as "no search", falling back to the full tree).
 * - A query containing a glob metachar (`*` or `?`) compiles to an anchored,
 *   case-insensitive RegExp: `*` → `.*`, `?` → `.`, every other regex
 *   metacharacter is escaped so it matches literally.
 * - Otherwise the query is a plain case-insensitive substring.
 * - When the query contains a `/` it matches against the relative path; else it
 *   matches against the bare entry name.
 *
 * No fs / IO — safe to unit-test directly.
 */

export type FileQueryMatcher = (name: string, relativePath: string) => boolean;

// Escape every regex metacharacter. `*` and `?` are handled separately by the
// glob translation below, so they are intentionally NOT escaped here.
function escapeRegexExceptGlob(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a query string into a matcher predicate, or `null` when the query is
 * empty/whitespace (caller treats null as "no search").
 */
export function compileFileQuery(query: string): FileQueryMatcher | null {
  const trimmed = query.trim();
  if (trimmed === '') return null;

  const matchesPath = trimmed.includes('/');
  const isGlob = trimmed.includes('*') || trimmed.includes('?');

  if (isGlob) {
    // Translate the glob to an anchored, case-insensitive RegExp. Escape all
    // regex metacharacters first (except * and ?), then expand the wildcards.
    const pattern = escapeRegexExceptGlob(trimmed).replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    return (name, relativePath) => regex.test(matchesPath ? relativePath : name);
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
