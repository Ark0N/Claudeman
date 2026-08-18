// Port: none (pure function over a real temp filesystem).
//
// `validateSessionFilePath` is the shared confinement gate for the file-serving
// and file-writing routes: it answers "does this path resolve to somewhere
// inside the session workspace". It realpath-resolves the CANDIDATE so a
// symlink cannot smuggle a path out of the workspace — but the workspace it
// compares against must be canonical too, or the two sides are expressed in
// different namespaces and `relative()` reports a spurious `../`.
//
// That is not exotic: a symlinked workspace is the norm on macOS, where
// `/tmp` is a symlink to `/private/tmp` and `os.tmpdir()` hands back the
// symlinked form, and it also covers symlinked project dirs and bind-mounted
// case paths. The effect is a workspace whose own files are all judged to be
// outside it, so every read and write in that session is refused.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { validateSessionFilePath } from '../src/web/route-helpers.js';

// realpath the root itself so the fixture controls which side is symlinked,
// rather than inheriting whatever os.tmpdir() happens to be on this platform.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-confinement-')));
const realWorkspace = join(root, 'real-workspace');
const linkedWorkspace = join(root, 'linked-workspace');

mkdirSync(join(realWorkspace, 'nested'), { recursive: true });
writeFileSync(join(realWorkspace, 'notes.md'), '# notes\n');
writeFileSync(join(realWorkspace, 'nested', 'deep.txt'), 'deep\n');
symlinkSync(realWorkspace, linkedWorkspace, 'dir');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('validateSessionFilePath', () => {
  it('accepts a file inside a workspace reached through a symlink', () => {
    // The regression: the candidate is realpath'd to /…/real-workspace/notes.md
    // while the base stays /…/linked-workspace, so a naive relative() yields
    // '../real-workspace/notes.md' and the file is refused as an escape.
    const result = validateSessionFilePath(linkedWorkspace, 'notes.md');

    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe('notes.md');
    expect(result!.resolvedPath).toBe(join(realWorkspace, 'notes.md'));
  });

  it('keeps the relative path usable for nested files under a symlinked workspace', () => {
    // relativePath is what callers hand back to the client and re-join later,
    // so an absolute or ../-prefixed value is a bug even when non-null.
    const result = validateSessionFilePath(linkedWorkspace, 'nested/deep.txt');

    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe(join('nested', 'deep.txt'));
  });

  it('accepts the same file through the canonical workspace path', () => {
    const result = validateSessionFilePath(realWorkspace, 'notes.md');

    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe('notes.md');
  });

  it('still refuses a traversal escape from a symlinked workspace', () => {
    // The point of canonicalizing the base is to make the comparison honest,
    // NOT to loosen it: an escape must stay refused on both spellings.
    writeFileSync(join(root, 'outside.txt'), 'outside\n');

    expect(validateSessionFilePath(linkedWorkspace, '../outside.txt')).toBeNull();
    expect(validateSessionFilePath(realWorkspace, '../outside.txt')).toBeNull();
  });

  it('still refuses a symlink that points out of the workspace', () => {
    // The candidate-side realpath must keep doing its job.
    writeFileSync(join(root, 'secret.txt'), 'secret\n');
    symlinkSync(join(root, 'secret.txt'), join(realWorkspace, 'escape.txt'));

    expect(validateSessionFilePath(linkedWorkspace, 'escape.txt')).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    expect(validateSessionFilePath(linkedWorkspace, 'nope.md')).toBeNull();
  });
});
