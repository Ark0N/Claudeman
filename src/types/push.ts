/**
 * @fileoverview Web Push notification type definitions
 */

/** A registered push subscription */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string;
  createdAt: number;
  lastUsedAt: number;
  pushPreferences: Record<string, boolean>;
}

/** VAPID key pair for Web Push */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  generatedAt: number;
}
