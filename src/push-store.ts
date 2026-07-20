/**
 * @fileoverview VAPID key auto-generation and push subscription CRUD.
 *
 * Persists VAPID keys to ~/.codeman/push-keys.json and subscriptions
 * to ~/.codeman/push-subscriptions.json. Debounced saves prevent
 * excessive disk I/O during rapid subscription updates.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { VapidKeys, PushSubscriptionRecord, UserRole } from './types.js';
import { Debouncer } from './utils/index.js';
import { getDataDir } from './config/instance.js';

/**
 * A push subscription plus the multi-user owner identity stamped at subscribe time.
 * `username`/`role` are undefined in single-user mode (and for legacy records saved
 * before this field existed). sendPushNotifications uses them to scope a
 * session-notification to its owner's devices (+ admins) instead of fanning out to
 * every user. Kept as a store-local widening of PushSubscriptionRecord so the shared
 * type stays untouched; the extra keys serialize/persist transparently.
 */
export type OwnedPushSubscriptionRecord = PushSubscriptionRecord & {
  username?: string;
  role?: UserRole;
};

const DATA_DIR = getDataDir();
const KEYS_FILE = join(DATA_DIR, 'push-keys.json');
const SUBS_FILE = join(DATA_DIR, 'push-subscriptions.json');
const SAVE_DEBOUNCE_MS = 500;

export class PushSubscriptionStore {
  private vapidKeys: VapidKeys | null = null;
  private subscriptions: Map<string, OwnedPushSubscriptionRecord> = new Map();
  private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
  private _disposed = false;

  constructor() {
    this.loadSubscriptions();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  /** Get or generate VAPID keys */
  getVapidKeys(): VapidKeys {
    if (this.vapidKeys) return this.vapidKeys;

    // Try loading from disk
    if (existsSync(KEYS_FILE)) {
      try {
        const raw = readFileSync(KEYS_FILE, 'utf-8');
        this.vapidKeys = JSON.parse(raw) as VapidKeys;
        return this.vapidKeys;
      } catch {
        // Regenerate on parse error
      }
    }

    // Generate new keys
    const keys = webpush.generateVAPIDKeys();
    this.vapidKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      generatedAt: Date.now(),
    };

    // Persist
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(KEYS_FILE, JSON.stringify(this.vapidKeys, null, 2));
    return this.vapidKeys;
  }

  /** Get the public VAPID key for client subscription */
  getPublicKey(): string {
    return this.getVapidKeys().publicKey;
  }

  /** Register or update a push subscription (deduplicates by endpoint) */
  addSubscription(sub: Omit<OwnedPushSubscriptionRecord, 'lastUsedAt'>): OwnedPushSubscriptionRecord {
    // Check for existing subscription with same endpoint
    for (const [existingId, existing] of this.subscriptions) {
      if (existing.endpoint === sub.endpoint) {
        // Update existing (re-stamp owner identity so it tracks the current caller)
        const updated: OwnedPushSubscriptionRecord = {
          ...existing,
          keys: sub.keys,
          userAgent: sub.userAgent,
          lastUsedAt: Date.now(),
          pushPreferences: sub.pushPreferences,
          username: sub.username,
          role: sub.role,
        };
        this.subscriptions.set(existingId, updated);
        this.scheduleSave();
        return updated;
      }
    }

    // New subscription
    const record: OwnedPushSubscriptionRecord = {
      ...sub,
      lastUsedAt: Date.now(),
    };
    this.subscriptions.set(record.id, record);
    this.scheduleSave();
    return record;
  }

  /** Update push preferences for a subscription */
  updatePreferences(id: string, preferences: Record<string, boolean>): OwnedPushSubscriptionRecord | null {
    const sub = this.subscriptions.get(id);
    if (!sub) return null;
    sub.pushPreferences = preferences;
    sub.lastUsedAt = Date.now();
    this.scheduleSave();
    return sub;
  }

  /** Remove a subscription */
  removeSubscription(id: string): boolean {
    const deleted = this.subscriptions.delete(id);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  /** Remove subscription by endpoint (used for auto-cleanup of expired subs) */
  removeByEndpoint(endpoint: string): void {
    for (const [id, sub] of this.subscriptions) {
      if (sub.endpoint === endpoint) {
        this.subscriptions.delete(id);
        this.scheduleSave();
        return;
      }
    }
  }

  /** Get all subscriptions */
  getAll(): OwnedPushSubscriptionRecord[] {
    return Array.from(this.subscriptions.values());
  }

  /** Get a single subscription by ID */
  get(id: string): OwnedPushSubscriptionRecord | null {
    return this.subscriptions.get(id) ?? null;
  }

  /** Load subscriptions from disk */
  private loadSubscriptions(): void {
    if (!existsSync(SUBS_FILE)) return;
    try {
      const raw = readFileSync(SUBS_FILE, 'utf-8');
      const arr = JSON.parse(raw) as OwnedPushSubscriptionRecord[];
      for (const sub of arr) {
        this.subscriptions.set(sub.id, sub);
      }
    } catch {
      // Start fresh on parse error
    }
  }

  /** Schedule a debounced save */
  private scheduleSave(): void {
    if (this._disposed) return;
    this.saveDeb.schedule(() => this.flushSave());
  }

  /** Immediately persist subscriptions to disk */
  private flushSave(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(SUBS_FILE, JSON.stringify(Array.from(this.subscriptions.values()), null, 2));
    } catch {
      // Ignore write errors
    }
  }

  /** Clean shutdown */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.saveDeb.flush(() => this.flushSave());
  }
}
