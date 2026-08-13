/**
 * @fileoverview Static registry of downstream tool dependencies probed by
 * `codeman doctor`. Each entry declares per-environment resolvers and the
 * skills that use it. EXTENSION POINT: skill-manifest-driven discovery
 * (COD follow-up) will merge dynamically-found entries into this list.
 *
 * @module config/dependency-registry
 */

import { PI_VERSION_REGEX } from '../utils/pi-cli-resolver.js';

export type ProbeEnvironment = 'linux' | 'darwin' | 'win32' | 'wsl';

/** The valid `--category` filter values; single source of truth for the type, the CLI
 *  help text, and CLI input validation. */
export const TOOL_CATEGORIES = ['core', 'office', 'other'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Resolve a binary on the PATH and read its version. */
export interface PathResolver {
  kind: 'path';
  bins: string[];
  versionArg?: string; // default '--version'
  versionRegex?: RegExp; // default matches first \d+.\d+(.\d+)?
  /**
   * Treat a binary whose version output does not match as NOT INSTALLED, instead of
   * reporting it with an unknown version. Only for tools with a short, generic binary
   * name (`pi`), where a `which` hit is not by itself evidence the right program is
   * there and a false "installed" contradicts the run mode's own resolver.
   */
  requireVersionMatch?: boolean;
}

/** Resolve a Windows-installed app reachable from win32 or WSL. */
export interface WindowsSideResolver {
  kind: 'windows-side';
  appDirs: string[]; // relative to a Program Files root
  exes: string[]; // candidate executables; first found wins
}

export interface ResolverSpec {
  match: ProbeEnvironment[];
  resolver: PathResolver | WindowsSideResolver;
}

export interface ToolDependency {
  id: string;
  label: string;
  category: ToolCategory;
  required: boolean;
  usedBy?: string[];
  minVersion?: string;
  resolvers: ResolverSpec[];
  installHint?: Partial<Record<ProbeEnvironment, string>>;
}

const ALL: ProbeEnvironment[] = ['linux', 'darwin', 'wsl', 'win32'];

export const DEPENDENCY_REGISTRY: ToolDependency[] = [
  {
    id: 'node',
    label: 'Node.js',
    category: 'core',
    required: true,
    minVersion: '22.0.0',
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['node'], versionArg: '--version' } }],
    installHint: { linux: 'https://nodejs.org', darwin: 'brew install node', wsl: 'https://nodejs.org' },
  },
  {
    id: 'claude',
    label: 'Claude CLI',
    category: 'core',
    required: false,
    usedBy: ['Claude Code sessions (default backend)'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['claude'], versionArg: '--version' } }],
    installHint: { linux: 'https://docs.claude.com/claude-code', darwin: 'https://docs.claude.com/claude-code' },
  },
  {
    id: 'tmux',
    label: 'tmux',
    category: 'core',
    required: true,
    resolvers: [{ match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
    installHint: { linux: 'sudo apt install tmux', darwin: 'brew install tmux', wsl: 'sudo apt install tmux' },
  },
  {
    id: 'opencode',
    label: 'OpenCode CLI',
    category: 'core',
    required: false,
    usedBy: ['OpenCode sessions'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['opencode'], versionArg: '--version' } }],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    category: 'core',
    required: false,
    usedBy: ['Codex sessions'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['codex'], versionArg: '--version' } }],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    category: 'core',
    required: false,
    usedBy: ['Gemini sessions'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['gemini'], versionArg: '--version' } }],
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    category: 'core',
    required: false,
    usedBy: ['Antigravity sessions'],
    resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['agy'], versionArg: '--version' } }],
  },
  {
    id: 'pi',
    label: 'Pi CLI',
    category: 'core',
    required: false,
    usedBy: ['Pi sessions'],
    // The only entry that requires a version match, for the same reason
    // pi-cli-resolver.ts probes: `pi` is a short generic name (Raspberry Pi tooling,
    // personal scripts), so a `which pi` hit alone is not the coding agent. Both sides
    // share PI_VERSION_REGEX, so the doctor and the run mode cannot drift into telling
    // the user opposite things about the same binary.
    resolvers: [
      {
        match: ALL,
        resolver: {
          kind: 'path',
          bins: ['pi'],
          versionArg: '--version',
          versionRegex: PI_VERSION_REGEX,
          requireVersionMatch: true,
        },
      },
    ],
  },
  {
    id: 'libreoffice',
    label: 'LibreOffice',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'thumbnails'],
    resolvers: [
      {
        match: ['linux', 'darwin', 'wsl'],
        resolver: { kind: 'path', bins: ['libreoffice', 'soffice'], versionArg: '--version' },
      },
    ],
    installHint: { linux: 'sudo apt install libreoffice', darwin: 'brew install --cask libreoffice' },
  },
  {
    id: 'pdftoppm',
    label: 'pdftoppm',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'PDF/Office first-page thumbnails'],
    // poppler's pdftoppm prints its version to stderr; presence is what matters here.
    resolvers: [
      { match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['pdftoppm'], versionArg: '-v' } },
    ],
    installHint: {
      linux: 'sudo apt install poppler-utils',
      darwin: 'brew install poppler',
      wsl: 'sudo apt install poppler-utils',
    },
  },
  {
    id: 'msoffice',
    label: 'MS Office',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'thumbnails'],
    resolvers: [
      {
        match: ['wsl', 'win32'],
        resolver: {
          kind: 'windows-side',
          appDirs: ['Microsoft Office/root/Office16'],
          exes: ['WINWORD.EXE', 'POWERPNT.EXE', 'EXCEL.EXE'],
        },
      },
    ],
  },
];
