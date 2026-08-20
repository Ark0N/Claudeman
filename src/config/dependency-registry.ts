/**
 * @fileoverview Static registry of downstream tool dependencies probed by
 * `codeman doctor`. Each entry declares per-environment resolvers and the
 * skills that use it. EXTENSION POINT: skill-manifest-driven discovery
 * (COD follow-up) will merge dynamically-found entries into this list.
 *
 * @module config/dependency-registry
 */

import { listClis } from './cli-registry/registry.js';

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

/**
 * Build a `codeman doctor` entry for one CLI registry entry, so its binary names, search
 * behaviour, version probe and install hints are declared exactly ONCE — in the CLI
 * registry's stock catalog — rather than duplicated here. `pi`'s `requireVersionMatch` and
 * shared `PI_VERSION_REGEX` come along automatically, which is what keeps the doctor and the
 * run mode from ever disagreeing about what counts as an installed `pi` (see pi-cli-resolver.ts).
 *
 * Only entries actually present in the registry are turned into doctor rows — a CLI a user
 * has fully removed from `clis.json` doesn't get an orphaned dependency row either.
 */
function cliDependencyEntry(id: string, usedBy: string): ToolDependency | null {
  const cli = listClis().find((e) => (e.id as unknown as string) === id);
  if (!cli || cli.discovery.binaries.length === 0) return null; // e.g. `shell`, which has no binary
  const version = cli.discovery.version;
  const installHint: ToolDependency['installHint'] = {};
  for (const [platform, command] of Object.entries(cli.discovery.install.command)) {
    if (command) installHint[platform as ProbeEnvironment] = command;
  }
  return {
    id,
    label: `${cli.label} CLI`,
    category: 'core',
    required: false,
    usedBy: [usedBy],
    resolvers: [
      {
        match: ALL,
        resolver: {
          kind: 'path',
          bins: cli.discovery.binaries,
          versionArg: version?.arg ?? '--version',
          versionRegex: version?.regex ? new RegExp(version.regex) : undefined,
          requireVersionMatch: version?.requireVersionMatch,
        },
      },
    ],
    installHint: Object.keys(installHint).length > 0 ? installHint : undefined,
  };
}

/** `usedBy` text for each CLI's doctor row, matching the historical copy per id. */
const CLI_USED_BY: Record<string, string> = {
  claude: 'Claude Code sessions (default backend)',
  opencode: 'OpenCode sessions',
  codex: 'Codex sessions',
  gemini: 'Gemini sessions',
  antigravity: 'Antigravity sessions',
  pi: 'Pi sessions',
};

const CLI_DEPENDENCY_ENTRIES: ToolDependency[] = Object.entries(CLI_USED_BY)
  .map(([id, usedBy]) => cliDependencyEntry(id, usedBy))
  .filter((entry): entry is ToolDependency => entry !== null);

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
    id: 'tmux',
    label: 'tmux',
    category: 'core',
    required: true,
    resolvers: [{ match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
    installHint: { linux: 'sudo apt install tmux', darwin: 'brew install tmux', wsl: 'sudo apt install tmux' },
  },
  ...CLI_DEPENDENCY_ENTRIES,
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
