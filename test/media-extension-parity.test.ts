/**
 * @fileoverview Media-extension parity — attachment registry ⇄ frontend copies.
 *
 * CLAUDE.md single-sources playable media extensions in
 * `VIDEO_ATTACHMENT_EXTENSIONS`/`AUDIO_ATTACHMENT_EXTENSIONS`
 * (src/attachment-registry.ts): the workspace preview and the out-of-workspace
 * attachment path must agree on what plays. The frontend cannot import that
 * module, so two hand-maintained copies exist and BOTH have drifted:
 *
 *  - `FILE_PREVIEW_EXTENSIONS` (constants.js) decides whether a clicked
 *    terminal/chat path opens the preview overlay or the tail/log viewer. It
 *    was missing `m4v ogv ogg oga m4a aac flac opus`, so an in-workspace
 *    `.m4a` routed to the log viewer and rendered as binary noise while the
 *    same file in /tmp played fine.
 *  - `VIDEO_EXTS`/`AUDIO_EXTS` (panels-ui.js) pick the <video>/<audio> markup
 *    for registered attachments; an entry missing there renders a text dump
 *    instead of a player.
 *
 * Same technique as test/sse-registry-parity.test.ts: the backend sets are
 * imported, the frontend copies are extracted from the shipped source as text
 * (no build-time link exists), and the sets are compared. No port needed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUDIO_ATTACHMENT_EXTENSIONS, VIDEO_ATTACHMENT_EXTENSIONS } from '../src/attachment-registry.js';

const publicFile = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', 'web', 'public', name), 'utf8');

/** `FILE_PREVIEW_EXTENSIONS` is a space-separated string literal in constants.js. */
function filePreviewExtensions(): Set<string> {
  const src = publicFile('constants.js');
  const m = src.match(/const FILE_PREVIEW_EXTENSIONS = new Set\(\s*\('([^']+)'\)\.split\(' '\)\s*\)/);
  expect(m, 'FILE_PREVIEW_EXTENSIONS literal not found in constants.js').not.toBeNull();
  return new Set(m![1].split(' '));
}

/** `VIDEO_EXTS`/`AUDIO_EXTS` are quoted-string array Sets in panels-ui.js. */
function panelsUiSet(name: string): Set<string> {
  const src = publicFile('panels-ui.js');
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`));
  expect(m, `${name} literal not found in panels-ui.js`).not.toBeNull();
  const values = [...m![1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
  return new Set(values);
}

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('media extension parity (attachment registry ⇄ frontend)', () => {
  it('extracts non-trivial sets from every source (guards the parsers)', () => {
    expect(VIDEO_ATTACHMENT_EXTENSIONS.size).toBeGreaterThanOrEqual(5);
    expect(AUDIO_ATTACHMENT_EXTENSIONS.size).toBeGreaterThanOrEqual(8);
    expect(filePreviewExtensions().size).toBeGreaterThan(10);
    expect(panelsUiSet('VIDEO_EXTS').size).toBeGreaterThanOrEqual(5);
    expect(panelsUiSet('AUDIO_EXTS').size).toBeGreaterThanOrEqual(8);
  });

  it('every playable media extension routes to the preview overlay, not the log viewer', () => {
    const preview = filePreviewExtensions();
    const missing = [...VIDEO_ATTACHMENT_EXTENSIONS, ...AUDIO_ATTACHMENT_EXTENSIONS].filter((e) => !preview.has(e));
    expect(
      missing,
      `media extensions in attachment-registry.ts but not constants.js FILE_PREVIEW_EXTENSIONS: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it("panels-ui.js VIDEO_EXTS exactly equals the registry's video set", () => {
    expect(sorted(panelsUiSet('VIDEO_EXTS'))).toEqual(sorted(VIDEO_ATTACHMENT_EXTENSIONS));
  });

  it("panels-ui.js AUDIO_EXTS exactly equals the registry's audio set", () => {
    expect(sorted(panelsUiSet('AUDIO_EXTS'))).toEqual(sorted(AUDIO_ATTACHMENT_EXTENSIONS));
  });
});
