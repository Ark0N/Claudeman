/**
 * @fileoverview Unit tests for the anti-DNS-rebinding Host allowlist + cross-site
 * Origin guard helpers in network-auth-policy.ts. Pure functions — no tmux, no
 * ports — safe to run inside a managed session.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAuthorityHostname,
  buildHostPolicy,
  isAllowedRequestHost,
  isAllowedRequestOrigin,
  type HostPolicy,
} from '../src/web/network-auth-policy.js';

const loopback: HostPolicy = { bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null };

describe('parseAuthorityHostname', () => {
  it('strips ports', () => {
    expect(parseAuthorityHostname('localhost:3000')).toBe('localhost');
    expect(parseAuthorityHostname('127.0.0.1:3000')).toBe('127.0.0.1');
    expect(parseAuthorityHostname('evil.example.com')).toBe('evil.example.com');
  });
  it('handles IPv6 in brackets', () => {
    expect(parseAuthorityHostname('[::1]')).toBe('::1');
    expect(parseAuthorityHostname('[::1]:3000')).toBe('::1');
  });
  it('leaves bracketless IPv6 intact (does not treat colons as a port)', () => {
    expect(parseAuthorityHostname('::1')).toBe('::1');
  });
  it('returns null for empty/garbage', () => {
    expect(parseAuthorityHostname(undefined)).toBeNull();
    expect(parseAuthorityHostname('')).toBeNull();
    expect(parseAuthorityHostname('   ')).toBeNull();
  });
  it('lowercases', () => {
    expect(parseAuthorityHostname('EVIL.Example.COM')).toBe('evil.example.com');
  });
});

describe('isAllowedRequestHost — anti-DNS-rebinding', () => {
  it('accepts loopback names and any IP literal', () => {
    expect(isAllowedRequestHost('localhost:3000', loopback)).toBe(true);
    expect(isAllowedRequestHost('127.0.0.1:3000', loopback)).toBe(true);
    expect(isAllowedRequestHost('[::1]:3000', loopback)).toBe(true);
    // LAN / public IP literals can't be rebinding targets, so they're allowed
    expect(isAllowedRequestHost('192.168.1.50:3000', loopback)).toBe(true);
    expect(isAllowedRequestHost('203.0.113.7', loopback)).toBe(true);
  });

  it('REJECTS a rebound custom domain (the core attack)', () => {
    expect(isAllowedRequestHost('attacker.evil.com', loopback)).toBe(false);
    expect(isAllowedRequestHost('attacker.evil.com:3000', loopback)).toBe(false);
  });

  it('rejects a missing/empty Host header', () => {
    expect(isAllowedRequestHost(undefined, loopback)).toBe(false);
    expect(isAllowedRequestHost('', loopback)).toBe(false);
  });

  it('accepts trusted tunnel suffixes (tailscale, cloudflare)', () => {
    expect(isAllowedRequestHost('tnode.tailf80371.ts.net', loopback)).toBe(true);
    expect(isAllowedRequestHost('foo.trycloudflare.com', loopback)).toBe(true);
    expect(isAllowedRequestHost('abc.cfargotunnel.com', loopback)).toBe(true);
    // a lookalike that merely contains the suffix mid-string is rejected
    expect(isAllowedRequestHost('ts.net.evil.com', loopback)).toBe(false);
    expect(isAllowedRequestHost('eviltrycloudflare.com', loopback)).toBe(false);
  });

  it('accepts the docker/podman container-to-host gateway aliases (in-container hooks)', () => {
    expect(isAllowedRequestHost('host.docker.internal:3000', loopback)).toBe(true);
    expect(isAllowedRequestHost('host.containers.internal:3000', loopback)).toBe(true);
    // a lookalike is still rejected (exact match only)
    expect(isAllowedRequestHost('host.docker.internal.evil.com', loopback)).toBe(false);
  });

  it('accepts the configured bind host when it is a hostname', () => {
    const policy: HostPolicy = { bindHost: 'mybox.local', allowedHosts: [], tunnelHost: null };
    expect(isAllowedRequestHost('mybox.local:3000', policy)).toBe(true);
    expect(isAllowedRequestHost('other.local', policy)).toBe(false);
  });

  it('accepts the active managed tunnel host', () => {
    const policy = buildHostPolicy('127.0.0.1', 'https://cool-name.trycloudflare.com');
    expect(isAllowedRequestHost('cool-name.trycloudflare.com', policy)).toBe(true);
  });

  it('honors CODEMAN_ALLOWED_HOSTS exact and .suffix entries', () => {
    const policy: HostPolicy = {
      bindHost: '127.0.0.1',
      allowedHosts: ['codeman.example.com', '.corp.internal'],
      tunnelHost: null,
    };
    expect(isAllowedRequestHost('codeman.example.com', policy)).toBe(true);
    expect(isAllowedRequestHost('host1.corp.internal', policy)).toBe(true);
    expect(isAllowedRequestHost('corp.internal', policy)).toBe(true);
    expect(isAllowedRequestHost('codeman.example.com.evil.com', policy)).toBe(false);
  });
});

describe('isAllowedRequestOrigin — cross-site (CSRF) guard', () => {
  it('allows a MISSING origin (non-browser clients: curl, hooks)', () => {
    expect(isAllowedRequestOrigin(undefined, loopback)).toBe(true);
    expect(isAllowedRequestOrigin('', loopback)).toBe(true);
  });

  it('rejects a cross-site origin', () => {
    expect(isAllowedRequestOrigin('https://evil.com', loopback)).toBe(false);
    expect(isAllowedRequestOrigin('http://evil.com:8080', loopback)).toBe(false);
  });

  it('rejects the opaque "null" origin', () => {
    expect(isAllowedRequestOrigin('null', loopback)).toBe(false);
  });

  it('allows same-site origins (localhost / IP / trusted suffix)', () => {
    expect(isAllowedRequestOrigin('http://localhost:3000', loopback)).toBe(true);
    expect(isAllowedRequestOrigin('http://127.0.0.1:3000', loopback)).toBe(true);
    expect(isAllowedRequestOrigin('https://tnode.tailf80371.ts.net', loopback)).toBe(true);
  });

  it('rejects a malformed origin', () => {
    expect(isAllowedRequestOrigin('not a url', loopback)).toBe(false);
  });
});

describe('buildHostPolicy', () => {
  it('parses CODEMAN_ALLOWED_HOSTS from env', () => {
    const prev = process.env.CODEMAN_ALLOWED_HOSTS;
    process.env.CODEMAN_ALLOWED_HOSTS = ' Foo.Example , .bar.internal ,';
    try {
      const p = buildHostPolicy('127.0.0.1', null);
      expect(p.allowedHosts).toEqual(['foo.example', '.bar.internal']);
    } finally {
      if (prev === undefined) delete process.env.CODEMAN_ALLOWED_HOSTS;
      else process.env.CODEMAN_ALLOWED_HOSTS = prev;
    }
  });

  it('extracts the tunnel hostname from a URL', () => {
    expect(buildHostPolicy('127.0.0.1', 'https://abc.trycloudflare.com/x').tunnelHost).toBe('abc.trycloudflare.com');
    expect(buildHostPolicy('127.0.0.1', null).tunnelHost).toBeNull();
    expect(buildHostPolicy('127.0.0.1', 'garbage').tunnelHost).toBeNull();
  });
});
