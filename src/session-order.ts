/**
 * @fileoverview Pure helpers for the global session tab-order (COD-131).
 *
 * Tab order (drag-and-drop reorder + Ctrl+Shift+{/}) is persisted server-side
 * so it follows the user across devices. The server is authoritative; the
 * browser's localStorage (`codeman-session-order`) is the offline fallback.
 *
 * These helpers are pure (no IO) so they can be unit-tested in isolation and
 * reused by both the PUT /api/session-order route and the StateStore accessor.
 *
 * - `normalizeSessionOrder` coerces arbitrary input into a clean string[]
 *   (non-empty strings only, deduped with first occurrence winning).
 * - `mergeSessionOrder` lets the pushing device's order win, while preserving
 *   any server-only ids the pushing device didn't know about — they fall to the
 *   END in their existing relative order, never dropped.
 */

/**
 * Coerce arbitrary input into a clean ordered list of session ids:
 * keep only non-empty strings and dedup (first occurrence wins).
 *
 * @param order - unknown input (expected to be a string[], but defensive)
 * @returns a normalized string[] (empty array for non-array / all-junk input)
 */
export function normalizeSessionOrder(order: unknown): string[] {
  if (!Array.isArray(order)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of order) {
    if (typeof entry !== 'string' || entry.length === 0) {
      continue;
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Merge an incoming order from a pushing device with the existing server order.
 *
 * The incoming order wins; any ids present in `existing` but NOT in `incoming`
 * are appended at the END, preserving their relative order. This is the
 * "server-only ids the pushing device didn't know about fall to the end, never
 * dropped" rule.
 *
 * Both arguments are normalized first, so callers may pass raw input safely.
 *
 * @param incoming - the order the pushing device wants
 * @param existing - the current server-side order
 * @returns the merged, normalized order
 */
export function mergeSessionOrder(incoming: string[], existing: string[]): string[] {
  const normalizedIncoming = normalizeSessionOrder(incoming);
  const incomingSet = new Set(normalizedIncoming);
  const merged = [...normalizedIncoming];
  for (const id of normalizeSessionOrder(existing)) {
    if (!incomingSet.has(id)) {
      merged.push(id);
    }
  }
  return merged;
}
