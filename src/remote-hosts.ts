import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteCase, RemoteCommandMode, RemoteHost, SessionMode, SessionRemote } from './types.js';

const REMOTE_HOSTS_FILE = 'remote-hosts.json';
const REMOTE_CASES_FILE = 'remote-cases.json';

export function remoteHostsPath(configDir: string): string {
  return join(configDir, REMOTE_HOSTS_FILE);
}

export function remoteCasesPath(configDir: string): string {
  return join(configDir, REMOTE_CASES_FILE);
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(configDir: string, path: string, value: T[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function readRemoteHosts(configDir: string): Promise<RemoteHost[]> {
  return readJsonArray<RemoteHost>(remoteHostsPath(configDir));
}

export async function writeRemoteHosts(configDir: string, hosts: RemoteHost[]): Promise<void> {
  await writeJsonArray(configDir, remoteHostsPath(configDir), hosts);
}

export async function readRemoteCases(configDir: string): Promise<RemoteCase[]> {
  return readJsonArray<RemoteCase>(remoteCasesPath(configDir));
}

export async function writeRemoteCases(configDir: string, cases: RemoteCase[]): Promise<void> {
  await writeJsonArray(configDir, remoteCasesPath(configDir), cases);
}

export function defaultRemoteCommandForMode(mode: SessionMode): string {
  const commands: Record<RemoteCommandMode, string> = {
    shell: 'exec bash -l',
    claude: 'exec claude',
    opencode: 'exec opencode',
    codex: 'exec codex',
    gemini: 'exec gemini',
  };
  return commands[mode as RemoteCommandMode] || commands.shell;
}

export function remoteSshTarget(host: Pick<RemoteHost, 'username' | 'host'>): string {
  return `${host.username}@${host.host}`;
}

export function remoteDisplayPath(
  remote: Pick<SessionRemote, 'username' | 'host' | 'remotePath'> | { username: string; host: string; path: string }
): string {
  const path = 'remotePath' in remote ? remote.remotePath : remote.path;
  return `${remote.username}@${remote.host}:${path}`;
}

export function toSessionRemote(host: RemoteHost, remoteCase: RemoteCase): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath: remoteCase.remotePath,
    commands: host.commands,
  };
}
