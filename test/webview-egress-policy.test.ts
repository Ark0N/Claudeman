/**
 * Egress policy for the web-tab proxy (src/web/webview-egress-policy.ts).
 *
 * The proxy reaches whatever the server can reach ON PURPOSE (a localhost
 * Grafana is the documented use case), so this policy blocks only the ranges no
 * dashboard lives in and a cloud credential does: link-local and the fixed
 * metadata endpoints. Both halves are pinned: what is refused, and what must
 * stay allowed so the feature keeps working.
 */

import { describe, it, expect } from 'vitest';
import {
  blockedWebviewHostReason,
  isBlockedEgressAddress,
  isBlockedWebviewUrl,
} from '../src/web/webview-egress-policy.js';

describe('isBlockedEgressAddress', () => {
  it('blocks the IPv4 link-local range, which every major cloud puts IMDS in', () => {
    expect(isBlockedEgressAddress('169.254.169.254')).toBe(true);
    expect(isBlockedEgressAddress('169.254.0.23')).toBe(true); // Tencent metadata
    expect(isBlockedEgressAddress('169.254.255.255')).toBe(true);
  });

  it('blocks the fixed metadata endpoints outside link-local', () => {
    expect(isBlockedEgressAddress('168.63.129.16')).toBe(true); // Azure WireServer
    expect(isBlockedEgressAddress('100.100.100.200')).toBe(true); // Alibaba Cloud
  });

  it('blocks IPv6 link-local and the AWS IMDS IPv6 endpoint in every spelling', () => {
    expect(isBlockedEgressAddress('fe80::1')).toBe(true);
    expect(isBlockedEgressAddress('FE80::1%eth0')).toBe(true);
    expect(isBlockedEgressAddress('febf:ffff::1')).toBe(true);
    expect(isBlockedEgressAddress('fd00:ec2::254')).toBe(true);
    expect(isBlockedEgressAddress('fd00:0ec2:0000:0000:0000:0000:0000:0254')).toBe(true);
  });

  it('judges the embedded IPv4 of a mapped address, dotted or hex', () => {
    expect(isBlockedEgressAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedEgressAddress('::ffff:a9fe:a9fe')).toBe(true); // URL.hostname's form
    expect(isBlockedEgressAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isBlockedEgressAddress('::ffff:7f00:1')).toBe(false);
  });

  it('ALLOWS loopback and private ranges: localhost dashboards are the feature', () => {
    expect(isBlockedEgressAddress('127.0.0.1')).toBe(false);
    expect(isBlockedEgressAddress('::1')).toBe(false);
    expect(isBlockedEgressAddress('10.0.0.5')).toBe(false);
    expect(isBlockedEgressAddress('192.168.1.20')).toBe(false);
    expect(isBlockedEgressAddress('172.16.0.9')).toBe(false);
    expect(isBlockedEgressAddress('100.64.0.1')).toBe(false); // tailnet CGNAT range
    expect(isBlockedEgressAddress('fd7a:115c:a1e0::1')).toBe(false); // tailnet ULA
    expect(isBlockedEgressAddress('fd00:ec2::255')).toBe(false); // neighbour of the AWS address
  });

  it('never blocks a name: names are judged by what they resolve to', () => {
    expect(isBlockedEgressAddress('metadata.google.internal')).toBe(false);
    expect(isBlockedEgressAddress('')).toBe(false);
  });
});

describe('blockedWebviewHostReason', () => {
  it('accepts URL.hostname forms: bracketed IPv6, trailing dot, mixed case', () => {
    expect(blockedWebviewHostReason('[fe80::1]')).toMatch(/link-local/);
    expect(blockedWebviewHostReason('[::ffff:a9fe:a9fe]')).toMatch(/link-local/);
    expect(blockedWebviewHostReason('METADATA.GOOGLE.INTERNAL.')).toMatch(/metadata hostname/);
    expect(blockedWebviewHostReason('[::1]')).toBeNull();
  });

  it('names the cloud metadata aliases even though they would also fail resolution', () => {
    expect(blockedWebviewHostReason('metadata')).not.toBeNull();
    expect(blockedWebviewHostReason('instance-data')).not.toBeNull();
    expect(blockedWebviewHostReason('metadata.example.com')).toBeNull();
    expect(blockedWebviewHostReason('grafana.internal')).toBeNull();
  });
});

describe('isBlockedWebviewUrl (schema refine)', () => {
  it('sees through the URL normalisations an attacker would lean on', () => {
    // Decimal and hex hosts normalise to dotted quads inside `new URL`.
    expect(isBlockedWebviewUrl('http://2852039166/latest/meta-data/')).toBe(true); // 169.254.169.254
    expect(isBlockedWebviewUrl('http://0xa9fea9fe/')).toBe(true);
    expect(isBlockedWebviewUrl('http://169.254.169.254:80/')).toBe(true);
    expect(isBlockedWebviewUrl('http://[fd00:ec2::254]/')).toBe(true);
    expect(isBlockedWebviewUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(true);
  });

  it('leaves every documented dashboard shape alone', () => {
    expect(isBlockedWebviewUrl('http://127.0.0.1:4000/grafana/')).toBe(false);
    expect(isBlockedWebviewUrl('http://localhost:3080/')).toBe(false);
    expect(isBlockedWebviewUrl('https://homeassistant.tailf80371.ts.net/')).toBe(false);
    expect(isBlockedWebviewUrl('http://192.168.1.20:9000/')).toBe(false);
  });

  it("is not the URL-shape check: garbage is someone else's refusal", () => {
    expect(isBlockedWebviewUrl('not a url')).toBe(false);
  });
});
