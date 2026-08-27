/**
 * @fileoverview Process-wide last-known plan-usage telemetry (account-global).
 *
 * The Claude status-telemetry route and host Codex poll merge their latest
 * values here. The SSE init snapshot (`getLightState`) replays the combined
 * value so the header "Plan Usage Limits" chip shows immediately on a fresh
 * page load / SSE reconnect — before either source emits another sample, and
 * without relying on per-browser localStorage.
 *
 * Null until the first telemetry of the process; cleared naturally on restart.
 *
 * @module plan-usage-latest
 */

let latest: Record<string, unknown> | null = null;

export function setLatestPlanUsage(value: Record<string, unknown>): Record<string, unknown> {
  const codex = latest?.codex;
  latest = { ...value, ...(codex !== undefined ? { codex } : {}) };
  return latest;
}

export function setLatestCodexPlanUsage(value: object | null): Record<string, unknown> {
  latest = { ...(latest ?? {}), codex: value };
  return latest;
}

export function getLatestPlanUsage(): Record<string, unknown> | null {
  return latest;
}
