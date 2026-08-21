import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { loginShellArgs, resolveLocalShell } from './shell-resolver.js';

const SAFE_BINARY_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const LOGIN_SHELL_BEGIN_MARKER = '__CODEMAN_CLI_RESOLVE_BEGIN__';
const LOGIN_SHELL_END_MARKER = '__CODEMAN_CLI_RESOLVE_END__';
/** Maximum rendered length of each bounded diagnostic field, excluding its label. */
const DIAGNOSTIC_FIELD_MAX_LENGTH = 1024;

export type CliResolutionSource = 'process-path' | 'common-directory' | 'login-shell';

export interface CliResolutionDiagnostics {
  binary: string;
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  searchDirs: string[];
}

export interface CliResolverHost {
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  findOnProcessPath(binary: string): string | null;
  findInLoginShell(binary: string): string | null;
  exists(path: string): boolean;
}

export interface CandidateValidation<T> {
  accepted: boolean;
  metadata?: T;
}

export interface CliResolution<T = undefined> {
  binaryPath: string;
  directory: string;
  source: CliResolutionSource;
  metadata?: T;
}

export interface CliExecutableResolver<T = undefined> {
  resolve(): CliResolution<T> | null;
  diagnostics(): CliResolutionDiagnostics;
}

export interface CliResolverCommandOptions {
  encoding: 'utf8';
  timeout: number;
  stdio: ['ignore', 'pipe', 'ignore'];
}

export type CliResolverCommandRunner = (file: string, args: string[], options: CliResolverCommandOptions) => string;

export interface ProductionCliResolverHostOptions {
  processPath?: string;
  shellPath?: string;
  shellArgs?: string[];
  runCommand?: CliResolverCommandRunner;
  isExecutableFile?: (path: string) => boolean;
}

function isExecutableRegularFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseLoginShellResult(output: string, binary: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.indexOf(LOGIN_SHELL_BEGIN_MARKER);
  if (begin === -1) return null;
  const end = lines.indexOf(LOGIN_SHELL_END_MARKER, begin + 1);
  if (end === -1) return null;

  for (const candidate of lines.slice(begin + 1, end)) {
    if (isAbsolute(candidate) && basename(candidate) === binary) return candidate;
  }
  return null;
}

function loginShellCommand(binary: string): string {
  return [
    `printf '%s\\n' '${LOGIN_SHELL_BEGIN_MARKER}'`,
    `command -v -- ${binary}`,
    `printf '%s\\n' '${LOGIN_SHELL_END_MARKER}'`,
  ].join('; ');
}

export function createProductionCliResolverHost(options: ProductionCliResolverHostOptions = {}): CliResolverHost {
  const shellPath = options.shellPath ?? resolveLocalShell();
  const shellArgs = options.shellArgs ?? loginShellArgs(shellPath).trim().split(/\s+/).filter(Boolean);
  const processPath = options.processPath ?? process.env.PATH ?? '';
  const isExecutableFile = options.isExecutableFile ?? isExecutableRegularFile;
  const runCommand: CliResolverCommandRunner =
    options.runCommand ?? ((file, args, commandOptions) => execFileSync(file, args, commandOptions));
  const run = (file: string, args: string[]): string => {
    try {
      return runCommand(file, args, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };

  return {
    processPath,
    shellPath,
    shellArgs: [...shellArgs],
    findOnProcessPath: (binary) => {
      if (!SAFE_BINARY_NAME.test(binary)) return null;
      for (const directory of processPath.split(delimiter).filter(Boolean)) {
        const candidate = join(directory, binary);
        if (isAbsolute(candidate) && isExecutableFile(candidate)) return candidate;
      }
      return null;
    },
    findInLoginShell: (binary) => {
      if (!SAFE_BINARY_NAME.test(binary)) return null;
      const candidate = parseLoginShellResult(run(shellPath, [...shellArgs, '-c', loginShellCommand(binary)]), binary);
      return candidate && isExecutableFile(candidate) ? candidate : null;
    },
    exists: isExecutableFile,
  };
}

export function createCliExecutableResolver<T = undefined>(
  options: {
    binary: string;
    searchDirs: string[];
    validateCandidate?: (path: string) => CandidateValidation<T>;
  },
  host: CliResolverHost = createProductionCliResolverHost()
): CliExecutableResolver<T> {
  if (!SAFE_BINARY_NAME.test(options.binary)) {
    throw new Error(`Unsafe CLI binary name: ${options.binary}`);
  }

  let cached: CliResolution<T> | null = null;
  const accept = (path: string | null, source: CliResolutionSource): CliResolution<T> | null => {
    if (!path || !isAbsolute(path) || !host.exists(path)) return null;
    const validation = options.validateCandidate?.(path) ?? ({ accepted: true } as CandidateValidation<T>);
    if (!validation.accepted) return null;
    return {
      binaryPath: path,
      directory: dirname(path),
      source,
      metadata: validation.metadata,
    };
  };

  return {
    resolve() {
      if (cached) return cached;

      cached = accept(host.findOnProcessPath(options.binary), 'process-path');
      if (cached) return cached;

      for (const dir of options.searchDirs) {
        cached = accept(join(dir, options.binary), 'common-directory');
        if (cached) return cached;
      }

      cached = accept(host.findInLoginShell(options.binary), 'login-shell');
      return cached;
    },
    diagnostics: () => ({
      binary: options.binary,
      processPath: host.processPath,
      shellPath: host.shellPath,
      shellArgs: [...host.shellArgs],
      searchDirs: [...options.searchDirs],
    }),
  };
}

function sanitizeDiagnosticField(value: string, emptyMarker: string): string {
  const flattened = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl || codePoint === 0x2028 || codePoint === 0x2029 ? ' ' : character;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
  if (!flattened) return emptyMarker;
  if (flattened.length <= DIAGNOSTIC_FIELD_MAX_LENGTH) return flattened;
  return `${flattened.slice(0, DIAGNOSTIC_FIELD_MAX_LENGTH - 1)}…`;
}

export function formatCliNotFoundMessage(base: string, diagnostics: CliResolutionDiagnostics): string {
  const processPath = sanitizeDiagnosticField(diagnostics.processPath, '(empty)');
  const shell = sanitizeDiagnosticField(
    [diagnostics.shellPath, ...diagnostics.shellArgs].filter(Boolean).join(' '),
    '(none)'
  );
  const dirs = sanitizeDiagnosticField(diagnostics.searchDirs.join(', '), '(none)');
  return `${base}\nServer PATH: ${processPath}\nLogin shell: ${shell}\nChecked directories: ${dirs}`;
}
