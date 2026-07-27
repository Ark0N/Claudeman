/**
 * @fileoverview Persistence for web tabs (saved dashboard URLs).
 *
 * Stores `Webview` records in `~/.codeman/webviews.json`, following the same
 * read-array / write-array shape as `src/remote-hosts.ts`. Deliberately dumb: no
 * caching, no watchers. The list is small (bounded by MAX_WEBVIEWS) and is read
 * on demand by the route handlers.
 *
 * The file lives under the instance data dir, so a beta instance started with a
 * distinct CODEMAN_INSTANCE keeps its own dashboards.
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { Webview } from './types.js';

const WEBVIEWS_FILE = 'webviews.json';

export function webviewsPath(configDir: string): string {
  return join(configDir, WEBVIEWS_FILE);
}

export async function readWebviews(configDir: string): Promise<Webview[]> {
  try {
    const raw = await fs.readFile(webviewsPath(configDir), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Webview[]) : [];
  } catch {
    return [];
  }
}

export async function writeWebviews(configDir: string, webviews: Webview[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(webviewsPath(configDir), JSON.stringify(webviews, null, 2));
}
