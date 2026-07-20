/**
 * @fileoverview Auth port — capabilities for authentication state.
 * Route modules that need access to auth sessions or QR rate limiting depend on this port.
 */

import type { StaleExpirationMap } from '../../utils/index.js';

/** Enhanced session record with device context for audit logging */
export interface AuthSessionRecord {
  ip: string;
  ua: string;
  createdAt: number;
  method: 'qr' | 'basic';
  /**
   * Multi-user identity carried by the cookie (single-user leaves these unset).
   * Snapshotted at mint time. Authorization-relevant admin changes (password reset,
   * disable, delete, role change, bypass-grant change) revoke the user's sessions so
   * a stale snapshot can't outlive the change; additionally the cookie fast-path
   * re-reads role/disabled/mustChangePassword live from the store each request, so an
   * out-of-band CLI mutation also takes effect promptly. See docs/multi-user-plan.md
   * section 5.
   */
  username?: string;
  role?: 'admin' | 'user';
  /** Whether this user must change their password before other actions are allowed. */
  mustChangePassword?: boolean;
}

export interface AuthPort {
  readonly authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  readonly qrAuthFailures: StaleExpirationMap<string, number> | null;
  readonly https: boolean;
}
