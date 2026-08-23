/** @fileoverview Trusted owner routing metadata for tab-layout invalidations. */
import type { SseRoutingHint } from './sse-stream-manager.js';

export function deriveTabLayoutSseHint(data: unknown): SseRoutingHint {
  return { username: (data as { owner?: string }).owner, sessionScoped: true };
}
