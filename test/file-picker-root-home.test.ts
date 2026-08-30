/**
 * @fileoverview The picker must offer a root when Codeman runs as root.
 *
 * `/root` is a DEFAULT blocked tree in the attachment guard, and Codeman running
 * as root — containers, plenty of servers — makes `homedir()` exactly `/root`.
 * The picker's own allowlisted Home root was therefore blocked by the guard,
 * every other candidate lives under it or does not exist, and the endpoint
 * answered 403 "No filesystem browse roots are available" with nothing the user
 * could open. The fix drops only the trees that would swallow a configured root
 * whole; `isSensitivePath` still guards what is inside.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isBlockedAttachmentPath, isUnderTree } from '../src/config/attachment-guard.js';

const TREES = ['/root', '/etc'];

/** Mirror of pickerBlockedTrees in file-routes.ts. */
const narrow = (trees: readonly string[], roots: readonly string[]) =>
  roots.length === 0 ? trees : trees.filter((t) => !roots.some((r) => isUnderTree(r, t)));

describe('file picker roots when the server runs as root', () => {
  it('drops the tree that would swallow the configured Home root', () => {
    expect(narrow(TREES, ['/root'])).toEqual(['/etc']);
  });

  it('keeps trees that hold no configured root', () => {
    expect(narrow(TREES, ['/home/alice'])).toEqual(['/root', '/etc']);
    expect(narrow(TREES, [])).toEqual(['/root', '/etc']);
  });

  it('also frees a root nested under the blocked tree', () => {
    // ~/codeman-cases is /root/codeman-cases when running as root.
    expect(narrow(TREES, ['/root/codeman-cases'])).toEqual(['/etc']);
  });

  it('still refuses secrets inside the freed tree', () => {
    const trees = narrow(TREES, ['/root']);
    for (const p of ['/root/.ssh/id_rsa', '/root/.aws/credentials', '/root/app/.env']) {
      expect(isBlockedAttachmentPath(p, trees)).toBe(true);
    }
    // …while ordinary files under it become reachable, which is the point.
    expect(isBlockedAttachmentPath('/root/projects/readme.md', trees)).toBe(false);
  });

  it('navigation reuses the same narrowed list the roots were chosen with', () => {
    // Handing the raw trees to navigation would admit a root and then refuse
    // every path inside it — a picker that opens and then does nothing.
    const src = readFileSync(new URL('../src/web/routes/file-routes.ts', import.meta.url), 'utf8');
    expect(src.match(/pickerBlockedTrees\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/blockedTrees:\s*guard\.blockedTrees/);
  });
});
