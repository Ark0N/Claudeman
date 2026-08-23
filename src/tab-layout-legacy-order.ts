/**
 * @fileoverview Pure compatibility translation between legacy session order and owner tab layouts.
 */

import { mergeSessionOrder, normalizeSessionOrder } from './session-order.js';
import {
  normalizeTabLayout,
  validateTabLayout,
  type TabLayout,
  type TabRef,
  type TabRefMetadata,
} from './tab-layout.js';

export interface OwnerOrderProjection {
  owner: string;
  ownedIds: readonly string[];
  order: readonly string[];
}

export function applyLegacySessionRank(
  input: TabLayout,
  requestedOrder: readonly string[],
  metadata: readonly TabRefMetadata[]
): TabLayout {
  const layout = validateTabLayout(input);
  const requestedRank = new Map(normalizeSessionOrder(requestedOrder).map((id, index) => [id, index]));
  const sessionMetadata = new Map<string, TabRefMetadata>();
  for (const item of metadata) {
    if (item.kind !== 'session' || !item.ownerValid || !item.visible || sessionMetadata.has(item.id)) continue;
    sessionMetadata.set(item.id, item);
  }

  const isRanked = (ref: TabRef): boolean =>
    ref.kind === 'session' && sessionMetadata.has(ref.id) && requestedRank.has(ref.id);
  const prepare = (ref: TabRef): TabRef => {
    if (ref.kind !== 'session') return { ...ref };
    const item = sessionMetadata.get(ref.id);
    const ownerValidParent = item?.parentSessionId && sessionMetadata.has(item.parentSessionId);
    return ownerValidParent ? { ...ref, placement: 'manual' } : { ...ref };
  };
  const rankContainer = (refs: readonly TabRef[]): TabRef[] => {
    const ranked = refs
      .filter(isRanked)
      .map(prepare)
      .sort((a, b) => requestedRank.get(a.id)! - requestedRank.get(b.id)!);
    let rankedIndex = 0;
    return refs.map((ref) => (isRanked(ref) ? ranked[rankedIndex++] : { ...ref }));
  };

  const transformed: TabLayout = {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, refs: rankContainer(group.refs) })),
    ungrouped: rankContainer(layout.ungrouped),
  };
  return normalizeTabLayout(transformed, metadata);
}

export function recomposeGlobalSessionOrder(
  current: readonly string[],
  projections: readonly OwnerOrderProjection[],
  preferred?: readonly string[]
): string[] {
  let result = mergeSessionOrder([...(preferred ?? current)], [...current]);
  for (const projection of projections) {
    const ownedIds = normalizeSessionOrder(projection.ownedIds);
    const owned = new Set(ownedIds);
    const canonical = normalizeSessionOrder(projection.order).filter((id) => owned.has(id));
    const canonicalSet = new Set(canonical);
    for (const id of ownedIds) {
      if (canonicalSet.has(id)) continue;
      canonicalSet.add(id);
      canonical.push(id);
    }

    let canonicalIndex = 0;
    const recomposed = result.map((id) => (owned.has(id) ? canonical[canonicalIndex++] : id));
    recomposed.push(...canonical.slice(canonicalIndex));
    result = normalizeSessionOrder(recomposed);
  }
  return result;
}
