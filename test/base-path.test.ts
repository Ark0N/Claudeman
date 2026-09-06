/**
 * @fileoverview Unit tests for the pure reverse-proxy base-path helpers
 * (src/config/base-path.ts). These back the server ingress strip (rewriteUrl),
 * the egress Location rewrite (onSend), and the frontend route builder, so their
 * correctness is what makes a sub-path mount work end to end.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeBasePath,
  isValidBasePath,
  assertValidBasePath,
  joinBasePath,
  stripBasePath,
} from '../src/config/base-path.js';

describe('normalizeBasePath', () => {
  it('treats root / and empty as no prefix', () => {
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath(null)).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
  });

  it('adds a leading slash and drops trailing slashes', () => {
    expect(normalizeBasePath('codeman')).toBe('/codeman');
    expect(normalizeBasePath('/codeman')).toBe('/codeman');
    expect(normalizeBasePath('/codeman/')).toBe('/codeman');
    expect(normalizeBasePath('codeman///')).toBe('/codeman');
  });

  it('collapses duplicate slashes and keeps nested segments', () => {
    expect(normalizeBasePath('//a//b//')).toBe('/a/b');
    expect(normalizeBasePath('/tools/codeman')).toBe('/tools/codeman');
  });
});

describe('isValidBasePath / assertValidBasePath', () => {
  it('accepts root and well-formed segments', () => {
    expect(isValidBasePath('')).toBe(true);
    expect(isValidBasePath('/codeman')).toBe(true);
    expect(isValidBasePath('/tools/codeman-2')).toBe(true);
    expect(isValidBasePath('/a_b.c~d')).toBe(true);
  });

  it('rejects segments with unsafe characters', () => {
    expect(isValidBasePath('/a b')).toBe(false);
    expect(isValidBasePath('/a?b')).toBe(false);
    expect(isValidBasePath('/a#b')).toBe(false);
    expect(isValidBasePath('/a%2f')).toBe(false);
  });

  it('assertValidBasePath normalizes valid input and throws on bad', () => {
    expect(assertValidBasePath('/codeman/')).toBe('/codeman');
    expect(assertValidBasePath('/')).toBe('');
    expect(() => assertValidBasePath('/a b')).toThrow(/Invalid --base-url/);
    expect(() => assertValidBasePath('?x')).toThrow(/Invalid --base-url/);
  });
});

describe('joinBasePath (frontend/egress route builder)', () => {
  it('is a no-op at root', () => {
    expect(joinBasePath('', '/api/x')).toBe('/api/x');
    expect(joinBasePath('', '/')).toBe('/');
  });

  it('prefixes root-absolute app paths', () => {
    expect(joinBasePath('/codeman', '/api/x')).toBe('/codeman/api/x');
    expect(joinBasePath('/codeman', '/')).toBe('/codeman/');
    expect(joinBasePath('/codeman', '/ws/sessions/1/terminal')).toBe('/codeman/ws/sessions/1/terminal');
  });

  it('leaves absolute, protocol-relative, and relative URLs alone', () => {
    expect(joinBasePath('/codeman', 'https://x/y')).toBe('https://x/y');
    expect(joinBasePath('/codeman', 'ws://x/y')).toBe('ws://x/y');
    expect(joinBasePath('/codeman', '//host/y')).toBe('//host/y');
    expect(joinBasePath('/codeman', 'app.js')).toBe('app.js');
    expect(joinBasePath('/codeman', '#frag')).toBe('#frag');
    expect(joinBasePath('/codeman', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('is idempotent — never double-prefixes', () => {
    expect(joinBasePath('/codeman', '/codeman/api/x')).toBe('/codeman/api/x');
    expect(joinBasePath('/codeman', '/codeman')).toBe('/codeman');
    expect(joinBasePath('/codeman', '/codeman?y=1')).toBe('/codeman?y=1');
  });

  it('does not treat a same-named sibling path as already-prefixed', () => {
    // /codeman-docs must NOT be mistaken for the /codeman mount.
    expect(joinBasePath('/codeman', '/codeman-docs/x')).toBe('/codeman/codeman-docs/x');
  });
});

describe('stripBasePath (server ingress)', () => {
  it('is a no-op at root', () => {
    expect(stripBasePath('', '/api/x')).toBe('/api/x');
  });

  it('strips the prefix from proxied requests', () => {
    expect(stripBasePath('/codeman', '/codeman/api/x')).toBe('/api/x');
    expect(stripBasePath('/codeman', '/codeman')).toBe('/');
    expect(stripBasePath('/codeman', '/codeman/')).toBe('/');
    expect(stripBasePath('/codeman', '/codeman?y=1')).toBe('/?y=1');
  });

  it('leaves un-prefixed requests unchanged (direct-to-port: hooks, health, docker bridge)', () => {
    expect(stripBasePath('/codeman', '/api/x')).toBe('/api/x');
    expect(stripBasePath('/codeman', '/api/hook-event')).toBe('/api/hook-event');
    // A same-named sibling is not the mount.
    expect(stripBasePath('/codeman', '/codeman-docs/x')).toBe('/codeman-docs/x');
  });

  it('round-trips with joinBasePath', () => {
    const base = '/tools/codeman';
    for (const p of ['/', '/api/x', '/ws/y', '/session/abc']) {
      expect(stripBasePath(base, joinBasePath(base, p))).toBe(p);
    }
  });
});
