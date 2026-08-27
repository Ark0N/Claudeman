/**
 * @fileoverview Main Codex subscription usage for the shared header chip.
 *
 * Codex can return multiple model buckets. The header deliberately follows the
 * backward-compatible `codex` bucket only; model-specific buckets such as Spark
 * are separate limits and are not part of the requested row.
 */

import { describe, expect, it, vi } from 'vitest';
import * as telemetryModule from '../src/usage-telemetry.js';
import * as codexResolverModule from '../src/utils/codex-cli-resolver.js';

const REAL_RESPONSE = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1788306836 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1787750984 },
      secondary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1788337784 },
    },
    codex: {
      limitId: 'codex',
      primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1788306836 },
      secondary: null,
    },
  },
};

type ParseCodexRateLimits = (value: unknown) => {
  fiveHour?: { usedPercentage: number; resetAt: number };
  sevenDay?: { usedPercentage: number; resetAt: number };
} | null;

function parser(): ParseCodexRateLimits {
  const candidate = (telemetryModule as Record<string, unknown>).parseCodexRateLimitsResponse;
  expect(candidate, 'usage telemetry must expose the Codex rate-limit parser').toBeTypeOf('function');
  return candidate as ParseCodexRateLimits;
}

describe('parseCodexRateLimitsResponse', () => {
  it('uses only the main codex bucket and maps its duration-tagged weekly window', () => {
    expect(parser()(REAL_RESPONSE)).toEqual({
      sevenDay: { usedPercentage: 40, resetAt: 1788306836 * 1000 },
    });
  });

  it('maps 5-hour and 7-day windows by duration even when their positions are reversed', () => {
    const result = parser()({
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: 200 },
          secondary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 100 },
        },
      },
    });

    expect(result).toEqual({
      fiveHour: { usedPercentage: 17, resetAt: 100_000 },
      sevenDay: { usedPercentage: 44, resetAt: 200_000 },
    });
  });

  it('falls back to the backward-compatible rateLimits snapshot', () => {
    expect(
      parser()({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 300 },
          secondary: null,
        },
      })
    ).toEqual({ fiveHour: { usedPercentage: 8, resetAt: 300_000 } });
  });

  it('ignores unrelated duration buckets and malformed percentages', () => {
    expect(
      parser()({
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: '40', windowDurationMins: 10080, resetsAt: 200 },
            secondary: { usedPercent: 20, windowDurationMins: 60, resetsAt: 100 },
          },
        },
      })
    ).toBeNull();
  });
});
type CodexRequest = (
  binaryPath: string,
  clientVersion: string,
  request?: (binaryPath: string, clientVersion: string) => Promise<unknown>
) => Promise<ReturnType<ParseCodexRateLimits>>;

describe('readCodexPlanUsage', () => {
  it('queries through the supplied app-server boundary and normalizes the result', async () => {
    const candidate = (codexResolverModule as Record<string, unknown>).readCodexPlanUsage;
    expect(candidate, 'the Codex resolver must expose a read-only usage query').toBeTypeOf('function');
    const request = vi.fn(async () => REAL_RESPONSE);

    await expect((candidate as CodexRequest)('/opt/codex', '1.23.0', request)).resolves.toEqual({
      sevenDay: { usedPercentage: 40, resetAt: 1788306836 * 1000 },
    });
    expect(request).toHaveBeenCalledWith('/opt/codex', '1.23.0');
  });
});
