/**
 * @fileoverview Append-only admin audit log (~/.codeman/admin-audit.jsonl).
 *
 * Every user-management action (create/patch/reset/delete/logout/assign) writes one
 * JSON line: timestamp, acting admin, action, target, request IP. Same idiom as
 * session-lifecycle.jsonl. Best-effort: a write failure never blocks the action.
 */

import fs from 'node:fs/promises';
import { dataPath } from '../config/instance.js';

export interface AdminAuditEntry {
  ts: number;
  admin: string;
  action: string;
  target?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

export async function appendAdminAudit(entry: Omit<AdminAuditEntry, 'ts'>): Promise<void> {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
    await fs.appendFile(dataPath('admin-audit.jsonl'), line, { mode: 0o600 });
  } catch {
    /* best-effort audit; never block the action */
  }
}
