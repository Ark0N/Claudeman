/**
 * @fileoverview Pure HTTP byte-range parsing for the raw file-serving routes.
 *
 * Why this exists: a `<video>`/`<audio>` element is only seekable when the
 * server advertises `Accept-Ranges: bytes` and answers `Range` requests with
 * `206 Partial Content`. Serving the whole file with `200 OK` (what file-raw
 * did) makes Chrome report `video.seekable === [0, 0]`, so the scrub bar is
 * inert and `currentTime = x` is silently ignored; Safari refuses to start the
 * media at all. Parsing lives here, away from the IO, so the edge cases
 * (suffix ranges, open-ended ranges, oversized specs, empty files) are unit
 * testable without touching the filesystem.
 *
 * Deliberately single-range only: multi-range responses require a
 * `multipart/byteranges` body that no media element asks for, and RFC 9110
 * §14.2 lets a server ignore a Range it does not want to honor and answer with
 * the full representation. Same for syntactically invalid specs — those are
 * ignored (200), while a syntactically valid but out-of-bounds spec is the one
 * case that earns a 416.
 */

/** Result of parsing a `Range` header against a known representation size. */
export type ByteRangeRequest =
  /** No range, an unsupported unit, or a malformed spec — serve the whole file with 200. */
  | { kind: 'full' }
  /** A satisfiable single range, inclusive on both ends — serve 206. */
  | { kind: 'partial'; start: number; end: number }
  /** Syntactically valid but outside the representation — serve 416. */
  | { kind: 'unsatisfiable' };

const BYTES_RANGE_SPEC = /^(\d*)-(\d*)$/;

/**
 * Digits → number, bounded. A range spec is arbitrary client input, so a
 * 100-digit first-byte-pos must not become `Infinity` (which would then flow
 * into a `createReadStream` offset). Anything longer than a safe integer is
 * clamped, which the callers then treat as "past the end of the file".
 */
function parseBoundedInt(digits: string): number {
  return digits.length > 15 ? Number.MAX_SAFE_INTEGER : Number(digits);
}

/**
 * Parse a `Range` request header against a file of `size` bytes.
 *
 * @param header - Raw header value (`req.headers.range`). Arrays (a duplicated
 *   header) are ignored rather than guessed at.
 * @param size - Size of the full representation in bytes.
 */
export function parseByteRange(header: string | string[] | undefined, size: number): ByteRangeRequest {
  if (typeof header !== 'string') return { kind: 'full' };

  const trimmed = header.trim();
  const eq = trimmed.indexOf('=');
  if (eq < 0 || trimmed.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'full' };

  const spec = trimmed.slice(eq + 1).trim();
  // Multi-range requests would need a multipart/byteranges body; ignoring the
  // header and serving the full representation is a valid answer.
  if (!spec || spec.includes(',')) return { kind: 'full' };

  const match = BYTES_RANGE_SPEC.exec(spec);
  if (!match) return { kind: 'full' };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { kind: 'full' };

  // Suffix range: `bytes=-N` means the LAST N bytes, not "from N to the end".
  if (!rawStart) {
    const suffix = parseBoundedInt(rawEnd);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = parseBoundedInt(rawStart);
  if (size === 0 || start >= size) return { kind: 'unsatisfiable' };

  // `bytes=N-` — from N to the end of the file. This is the form Chrome opens
  // a media element with (`bytes=0-`), so it must answer 206, not 200.
  if (!rawEnd) return { kind: 'partial', start, end: size - 1 };

  const requestedEnd = parseBoundedInt(rawEnd);
  // last-byte-pos < first-byte-pos is an invalid spec, not an unsatisfiable
  // one: RFC 9110 §14.1.1 says the whole header field is then ignored.
  if (requestedEnd < start) return { kind: 'full' };

  return { kind: 'partial', start, end: Math.min(requestedEnd, size - 1) };
}
