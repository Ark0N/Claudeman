/**
 * @fileoverview Owner-scoped tab-layout persistence and legacy migration primitives.
 *
 * This module is deliberately independent of routes and runtime managers. Callers
 * provide persisted/live session facts plus saved webviews in server-store order.
 */

import { normalizeTabLayout, type TabLayout, type TabRef, type TabRefMetadata } from './tab-layout.js';

export const SINGLE_USER_LAYOUT_OWNER = '@single';

export interface TabLayoutSessionRecord {
  id: string;
  owner?: string;
  createdAt: number;
  parentSessionId?: string;
}

export interface TabLayoutWebviewRecord {
  id: string;
  owner?: string;
}

export interface TabLayoutMigrationInput {
  owner: string;
  layouts?: Readonly<Record<string, TabLayout>>;
  sessionOrder?: readonly string[];
  persistedSessions: readonly TabLayoutSessionRecord[];
  liveSessions: readonly TabLayoutSessionRecord[];
  /** Saved webviews in authoritative server-store order. */
  webviews: readonly TabLayoutWebviewRecord[];
  /** Required only when creating a layout, making migration deterministic in tests. */
  updatedAt?: string;
}

export interface TabLayoutMigrationResult {
  layout: TabLayout;
  layouts: Record<string, TabLayout>;
  created: boolean;
}

/** Resolve the persistence key without accepting an owner key from a client. */
export function ownerLayoutKey(username?: string): string {
  return username || SINGLE_USER_LAYOUT_OWNER;
}

function recordOwner(record: { owner?: string }): string {
  return record.owner ?? SINGLE_USER_LAYOUT_OWNER;
}

function compareSessions(a: TabLayoutSessionRecord, b: TabLayoutSessionRecord): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function collectSessions(input: TabLayoutMigrationInput): Map<string, TabLayoutSessionRecord> {
  const sessions = new Map<string, TabLayoutSessionRecord>();
  for (const record of input.persistedSessions) sessions.set(record.id, { ...record });
  // A matching live record is authoritative as a whole. In particular, absent
  // optional owner/parent fields mean single-user ownership and root lineage;
  // retaining those fields from a stale persisted copy changes their semantics.
  for (const record of input.liveSessions) sessions.set(record.id, { ...record });
  return sessions;
}

function buildMetadata(
  input: TabLayoutMigrationInput,
  sessions: ReadonlyMap<string, TabLayoutSessionRecord>
): TabRefMetadata[] {
  const ownerSessions = [...sessions.values()]
    .filter((record) => recordOwner(record) === input.owner)
    .sort(compareSessions);
  const sessionOrder = new Map(ownerSessions.map((record, index) => [record.id, index]));
  const metadata: TabRefMetadata[] = [...sessions.values()].map((record) => ({
    kind: 'session',
    id: record.id,
    ownerValid: recordOwner(record) === input.owner,
    visible: true,
    order: sessionOrder.get(record.id) ?? record.createdAt,
    parentSessionId: record.parentSessionId,
  }));
  const webviewOffset = ownerSessions.length;
  input.webviews.forEach((record, index) => {
    metadata.push({
      kind: 'webview',
      id: record.id,
      ownerValid: recordOwner(record) === input.owner,
      visible: true,
      order: webviewOffset + index,
    });
  });
  return metadata;
}

/**
 * Normalize an existing owner layout, or idempotently migrate legacy flat order.
 * Unknown stored refs remain unknown to metadata and are therefore preserved.
 * No input object is mutated; validation/capacity failure is atomic.
 */
export function normalizeOrMigrateOwnerTabLayout(input: TabLayoutMigrationInput): TabLayoutMigrationResult {
  const sessions = collectSessions(input);
  const metadata = buildMetadata(input, sessions);
  const existing = input.layouts && Object.hasOwn(input.layouts, input.owner) ? input.layouts[input.owner] : undefined;
  if (existing) {
    const layout = normalizeTabLayout(existing, metadata);
    return { layout, layouts: { ...(input.layouts ?? {}), [input.owner]: layout }, created: false };
  }

  const ownerSessions = [...sessions.values()].filter((record) => recordOwner(record) === input.owner);
  const ownerSessionById = new Map(ownerSessions.map((record) => [record.id, record]));
  const liveOwnerIds = new Set(
    input.liveSessions.filter((record) => recordOwner(record) === input.owner).map((record) => record.id)
  );
  const seen = new Set<string>();
  const orderedSessions: TabLayoutSessionRecord[] = [];
  for (const id of input.sessionOrder ?? []) {
    const record = ownerSessionById.get(id);
    if (!record || seen.has(id)) continue;
    seen.add(id);
    orderedSessions.push(record);
  }
  for (const record of ownerSessions.filter((item) => !seen.has(item.id)).sort(compareSessions)) {
    seen.add(record.id);
    orderedSessions.push(record);
  }

  const refs: TabRef[] = orderedSessions.map((record) => {
    const manual = record.parentSessionId !== undefined && liveOwnerIds.has(record.parentSessionId);
    return manual ? { kind: 'session', id: record.id, placement: 'manual' } : { kind: 'session', id: record.id };
  });
  for (const webview of input.webviews) {
    if (recordOwner(webview) === input.owner) refs.push({ kind: 'webview', id: webview.id });
  }

  const layout = normalizeTabLayout(
    {
      version: 0,
      groups: [],
      ungrouped: refs,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    },
    metadata
  );
  return { layout, layouts: { ...(input.layouts ?? {}), [input.owner]: layout }, created: true };
}
