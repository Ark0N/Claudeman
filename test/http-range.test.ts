/**
 * @fileoverview Byte-range parsing for the raw file-serving routes.
 *
 * The file viewer's video player is only seekable when file-raw answers `Range`
 * requests with 206 (measured before the fix: `video.seekable` was `[0, 0]` and
 * `currentTime = x` silently reverted). What that correctness rests on is this
 * parser, so the cases pinned here are the ones a media element actually emits
 * plus the malformed input a browser never sends but a client can:
 *
 *   - `bytes=0-` — how Chrome opens EVERY media element. Must be 206, not 200.
 *   - `bytes=-N` — the SUFFIX form (last N bytes), not "from N onwards"; mp4
 *     players use it to read a trailing moov atom.
 *   - out of bounds -> 416, malformed -> ignored (200), which are different
 *     answers for what looks like the same "bad range".
 */

import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/web/http-range.js';

describe('parseByteRange', () => {
  it('serves the full file when there is no Range header', () => {
    expect(parseByteRange(undefined, 1000)).toEqual({ kind: 'full' });
    expect(parseByteRange('', 1000)).toEqual({ kind: 'full' });
  });

  it('answers bytes=0- with a partial range (the form Chrome opens media with)', () => {
    expect(parseByteRange('bytes=0-', 1000)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('parses a closed range inclusive of both ends', () => {
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ kind: 'partial', start: 100, end: 199 });
  });

  it('clamps an end past EOF instead of rejecting the range', () => {
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('reads bytes=-N as the LAST N bytes, not as an offset', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('clamps a suffix longer than the file to the whole file', () => {
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('accepts a single-byte range', () => {
    expect(parseByteRange('bytes=0-0', 1000)).toEqual({ kind: 'partial', start: 0, end: 0 });
  });

  it('tolerates whitespace and a capitalised unit', () => {
    expect(parseByteRange('  BYTES = 10-20 ', 1000)).toEqual({ kind: 'partial', start: 10, end: 20 });
  });

  it('reports a start at or past EOF as unsatisfiable (416)', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=1500-1600', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a zero-length suffix as unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports any range against an empty file as unsatisfiable', () => {
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores an inverted range rather than 416-ing it (invalid spec, not unsatisfiable)', () => {
    expect(parseByteRange('bytes=500-100', 1000)).toEqual({ kind: 'full' });
  });

  it('ignores units it does not implement', () => {
    expect(parseByteRange('items=0-10', 1000)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes 0-10', 1000)).toEqual({ kind: 'full' });
  });

  it('ignores multi-range requests instead of answering only the first range', () => {
    // A multipart/byteranges body is the only correct answer to these, and no
    // media element asks for one — serving the whole file is spec-legal.
    expect(parseByteRange('bytes=0-99,200-299', 1000)).toEqual({ kind: 'full' });
  });

  it('ignores malformed specs', () => {
    expect(parseByteRange('bytes=', 1000)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes=-', 1000)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes=abc-def', 1000)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes=1.5-2', 1000)).toEqual({ kind: 'full' });
  });

  it('ignores a duplicated Range header rather than guessing which one won', () => {
    expect(parseByteRange(['bytes=0-10', 'bytes=20-30'], 1000)).toEqual({ kind: 'full' });
  });

  it('bounds an absurdly long offset instead of producing Infinity', () => {
    // A 100-digit first-byte-pos must not reach createReadStream as Infinity.
    const huge = '9'.repeat(100);
    expect(parseByteRange(`bytes=${huge}-`, 1000)).toEqual({ kind: 'unsatisfiable' });
    const range = parseByteRange(`bytes=0-${huge}`, 1000);
    expect(range).toEqual({ kind: 'partial', start: 0, end: 999 });
  });
});
