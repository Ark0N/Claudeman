/**
 * @fileoverview Egress policy for the web-tab proxy: which upstream ADDRESSES
 * a saved dashboard URL may never resolve to.
 *
 * Pure (no IO), so the same predicate serves three call sites that see the target
 * at different stages: the Zod schema (a URL being saved), the sync check on a
 * hostname that is already an IP literal (Node's `net.connect` skips DNS for
 * those, so a lookup hook never sees them), and the DNS lookup hook that judges
 * the RESOLVED addresses of a name (`webview-egress.ts`), which is what closes
 * the rebinding hole a hostname-string check alone leaves open.
 *
 * What is blocked, and only this: link-local ranges and the fixed cloud-metadata
 * addresses that live there or beside them. Loopback and RFC1918 are deliberately
 * ALLOWED: a `localhost` Grafana or a LAN Home Assistant is the documented use
 * case for web tabs (`docs/web-tabs.md`), and the proxy's reach into the server's
 * own network is a documented property, not a bug. Nothing a person would
 * embed as a dashboard lives at 169.254.169.254, while an IAM credential does.
 */

import { isIP } from 'node:net';

/**
 * Hostnames that are metadata-service aliases on the clouds that define them.
 * Belt and braces: each also RESOLVES to a blocked address, which the lookup hook
 * catches, but naming them here gives the user a clear refusal at save time
 * instead of a DNS-shaped failure at open time.
 */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal', // GCP
  'metadata', // GCP short alias (resolves on every GCE VM)
  'instance-data', // AWS legacy IMDS alias
]);

/** Fixed single-address metadata endpoints outside the link-local range. */
const BLOCKED_IPV4_HOSTS = new Set([
  '168.63.129.16', // Azure WireServer (IMDS helper, DHCP/heartbeat endpoint)
  '100.100.100.200', // Alibaba Cloud metadata
]);

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
  return nums as [number, number, number, number];
}

function isBlockedIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local, incl. 169.254.169.254 (AWS/Azure/GCP/OpenStack/Oracle/DO)
  return BLOCKED_IPV4_HOSTS.has(octets.join('.'));
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups. Accepts the compressed
 * forms `URL.hostname` and DNS produce (`::1`, `::ffff:7f00:1`, `fd00:ec2::254`)
 * plus a dotted IPv4 tail (`::ffff:127.0.0.1`). Returns null for anything it
 * cannot parse, and the caller treats null as "not blocked" because every caller
 * gates on `isIP()` first, so null only ever means a zone id or a form Node itself
 * would refuse to connect to.
 */
function expandIpv6(raw: string): number[] | null {
  let text = raw.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = halves.length === 2 ? [...head, ...new Array<string>(missing).fill('0'), ...rest] : head;
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

function isBlockedIpv6(host: string): boolean {
  const groups = expandIpv6(host);
  if (!groups) return false;
  // fe80::/10 link-local.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // fd00:ec2::254, the AWS IMDS IPv6 endpoint.
  if (
    groups[0] === 0xfd00 &&
    groups[1] === 0x0ec2 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 0x0254
  ) {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }
  return false;
}

/**
 * True when `address` (an IP literal, bracket-free) is one the proxy must never
 * connect to. Non-IP input is never blocked here: names are judged by
 * `isBlockedWebviewHostname()` at save time and by their resolved addresses at
 * connect time.
 */
export function isBlockedEgressAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isBlockedIpv4(address);
  if (kind === 6) return isBlockedIpv6(address);
  return false;
}

/**
 * Judge a URL hostname as `URL.hostname` hands it over: IPv6 literals arrive in
 * brackets, names may carry a trailing dot, and case is irrelevant.
 *
 * @returns a short human-readable reason when blocked, null when allowed.
 */
export function blockedWebviewHostReason(hostname: string): string | null {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (isBlockedEgressAddress(host)) return `${host} is a link-local or cloud-metadata address`;
  if (BLOCKED_HOSTNAMES.has(host)) return `${host} is a cloud-metadata hostname`;
  return null;
}

/** Schema-friendly boolean form of `blockedWebviewHostReason()` over a raw URL string. */
export function isBlockedWebviewUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false; // not this predicate's job; the URL shape check rejects it
  }
  return blockedWebviewHostReason(url.hostname) !== null;
}
