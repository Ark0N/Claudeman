import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXEC_TIMEOUT_MS } from '../src/config/exec-timeout.js';
import {
  createCliExecutableResolver,
  createProductionCliResolverHost,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from '../src/utils/cli-executable-resolver.js';

const BEGIN_MARKER = '__CODEMAN_CLI_RESOLVE_BEGIN__';
const END_MARKER = '__CODEMAN_CLI_RESOLVE_END__';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function host(overrides: Partial<CliResolverHost> = {}): CliResolverHost {
  return {
    processPath: '/usr/bin:/bin',
    shellPath: '/bin/bash',
    shellArgs: ['-i', '-l'],
    findOnProcessPath: vi.fn(() => null),
    findInLoginShell: vi.fn(() => null),
    exists: vi.fn(() => false),
    ...overrides,
  };
}

describe('createCliExecutableResolver', () => {
  it('prefers the server process PATH over common directories and the login shell', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/process/bin/codex'),
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({ binaryPath: '/process/bin/codex', source: 'process-path' });
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('prefers common directories in order over the login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn((path) => path === '/second/bin/codex' || path === '/shell/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/first/bin', '/second/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({ binaryPath: '/second/bin/codex', source: 'common-directory' });
    expect(h.exists).toHaveBeenNthCalledWith(1, '/first/bin/codex');
    expect(h.exists).toHaveBeenNthCalledWith(2, '/second/bin/codex');
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('finds an executable exposed only by the interactive login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/home/u/.nvm/versions/node/v22/bin/codex'),
      exists: vi.fn((path) => path === '/home/u/.nvm/versions/node/v22/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.nvm/versions/node/v22/bin/codex',
      directory: '/home/u/.nvm/versions/node/v22/bin',
      source: 'login-shell',
    });
  });

  it('continues after a validator rejects an earlier candidate', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/usr/bin/pi'),
      findInLoginShell: vi.fn(() => '/home/u/.npm/bin/pi'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver(
      {
        binary: 'pi',
        searchDirs: [],
        validateCandidate: (path) =>
          path.includes('.npm') ? { accepted: true, metadata: '0.84.1' } : { accepted: false },
      },
      h
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.npm/bin/pi',
      source: 'login-shell',
      metadata: '0.84.1',
    });
  });

  it('caches success but retries failure', () => {
    const findInLoginShell = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue('/new/bin/codex');
    const h = host({ findInLoginShell, exists: vi.fn((path) => path === '/new/bin/codex') });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, h);

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe binary names', () => {
    const h = host();

    expect(() => createCliExecutableResolver({ binary: 'codex;id', searchDirs: [] }, h)).toThrow(
      'Unsafe CLI binary name'
    );
    expect(() => createCliExecutableResolver({ binary: '../codex', searchDirs: [] }, h)).toThrow(
      'Unsafe CLI binary name'
    );
  });

  it('rejects relative and nonexistent candidates', () => {
    const findInLoginShell = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('relative/codex')
      .mockReturnValue('/missing/codex');
    const h = host({ findInLoginShell, exists: vi.fn(() => false) });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, h);

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()).toBeNull();
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.exists).toHaveBeenCalledWith('/missing/codex');
  });
});

describe('formatCliNotFoundMessage', () => {
  it('includes only the base install hint and bounded resolution diagnostics', () => {
    const base = 'Codex CLI not found. Install with: npm install -g @openai/codex';
    const diagnostics = {
      binary: 'codex',
      processPath: '/usr/bin:/bin',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      searchDirs: ['/home/u/.local/bin', '/usr/local/bin'],
      API_KEY: 'super-secret',
    };
    const message = formatCliNotFoundMessage(base, diagnostics);

    expect(message).toContain(base);
    expect(message).toContain('Server PATH: /usr/bin:/bin');
    expect(message).toContain('Login shell: /bin/bash -i -l');
    expect(message).toContain('Checked directories: /home/u/.local/bin, /usr/local/bin');
    expect(message).not.toContain('API_KEY');
    expect(message).not.toContain('super-secret');
  });

  it('marks empty diagnostic values without dumping arbitrary environment data', () => {
    const message = formatCliNotFoundMessage('Missing CLI', {
      binary: 'codex',
      processPath: '',
      shellPath: '',
      shellArgs: [],
      searchDirs: [],
    });

    expect(message).toBe('Missing CLI\nServer PATH: (empty)\nLogin shell: (none)\nChecked directories: (none)');
    expect(message).not.toContain('HOME=');
    expect(message).not.toContain('TOKEN=');
  });

  it('flattens control characters and bounds every diagnostic field', () => {
    const pathological = `first\r\nforged label: value\u0000${'x'.repeat(10_000)}`;
    const message = formatCliNotFoundMessage('Missing CLI', {
      binary: 'codex',
      processPath: pathological,
      shellPath: pathological,
      shellArgs: [pathological],
      searchDirs: [pathological, pathological],
    });
    const lines = message.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^Server PATH: first forged label: value x+…$/);
    expect(lines[2]).toMatch(/^Login shell: first forged label: value x+…$/);
    expect(lines[3]).toMatch(/^Checked directories: first forged label: value x+…$/);
    expect(lines.slice(1).every((line) => line.length <= 1_050)).toBe(true);
  });
});

describe('createProductionCliResolverHost', () => {
  it('contains no ambient VITEST branch in the production resolver source', () => {
    const source = readFileSync(new URL('../src/utils/cli-executable-resolver.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('process.env.VITEST');
  });

  it("resolves through the injected login-shell runner when VITEST is 'false'", () => {
    const hadVitest = Object.hasOwn(process.env, 'VITEST');
    const previousVitest = process.env.VITEST;
    process.env.VITEST = 'false';
    try {
      const runCommand = vi.fn(() => `${BEGIN_MARKER}\n/home/u/.nvm/bin/codex\n${END_MARKER}`);
      const productionHost = createProductionCliResolverHost({
        processPath: '',
        shellPath: '/bin/bash',
        shellArgs: ['-i', '-l'],
        runCommand,
        isExecutableFile: () => true,
      });
      const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, productionHost);

      expect(resolver.resolve()).toMatchObject({
        binaryPath: '/home/u/.nvm/bin/codex',
        source: 'login-shell',
      });
      expect(runCommand).toHaveBeenCalledTimes(1);
    } finally {
      if (hadVitest) process.env.VITEST = previousVitest;
      else delete process.env.VITEST;
    }
  });

  it('searches the captured process PATH directly in directory order without running a command', () => {
    const runCommand = vi.fn(() => '');
    const isExecutableFile = vi.fn((path: string) => path === '/second/bin/codex');
    const productionHost = createProductionCliResolverHost({
      processPath: '/first/bin:/second/bin:/third/bin',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand,
      isExecutableFile,
    });

    expect(productionHost.findOnProcessPath('codex')).toBe('/second/bin/codex');
    expect(isExecutableFile).toHaveBeenNthCalledWith(1, '/first/bin/codex');
    expect(isExecutableFile).toHaveBeenNthCalledWith(2, '/second/bin/codex');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('accepts only executable regular files with the production predicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeman-cli-resolver-'));
    temporaryDirectories.push(root);
    const executableDirectory = join(root, 'executable');
    const plainDirectory = join(root, 'plain');
    const directoryCandidate = join(root, 'directory');
    mkdirSync(executableDirectory);
    mkdirSync(plainDirectory);
    mkdirSync(directoryCandidate);
    writeFileSync(join(executableDirectory, 'codex'), '#!/bin/sh\n');
    chmodSync(join(executableDirectory, 'codex'), 0o755);
    writeFileSync(join(plainDirectory, 'codex'), '#!/bin/sh\n');
    mkdirSync(join(directoryCandidate, 'codex'));
    const productionHost = createProductionCliResolverHost({
      processPath: [directoryCandidate, plainDirectory, executableDirectory].join(':'),
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
    });

    expect(productionHost.findOnProcessPath('codex')).toBe(join(executableDirectory, 'codex'));
  });

  it('uses the resolved shell, allowlisted args, tagged command, and bounded timeout', () => {
    const runCommand = vi.fn(() =>
      ['/profile/absolute-noise', BEGIN_MARKER, '/home/u/.nvm/bin/codex', END_MARKER, '/exit-trap/absolute-noise'].join(
        '\n'
      )
    );
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/usr/bin/fish',
      shellArgs: ['-i', '-l'],
      runCommand,
      isExecutableFile: () => true,
    });

    expect(productionHost.findInLoginShell('codex')).toBe('/home/u/.nvm/bin/codex');
    expect(runCommand).toHaveBeenCalledWith(
      '/usr/bin/fish',
      ['-i', '-l', '-c', `printf '%s\\n' '${BEGIN_MARKER}'; command -v -- codex; printf '%s\\n' '${END_MARKER}'`],
      {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
  });

  it.each([
    ['mismatched basename', `${BEGIN_MARKER}\n/opt/bin/not-codex\n${END_MARKER}`],
    ['missing begin marker', `/opt/bin/codex\n${END_MARKER}`],
    ['missing end marker', `${BEGIN_MARKER}\n/opt/bin/codex`],
    ['absolute output outside markers', `/profile/codex\n${BEGIN_MARKER}\nrelative/codex\n${END_MARKER}\n/exit/codex`],
  ])('rejects malformed tagged shell output: %s', (_name, output) => {
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand: () => output,
      isExecutableFile: () => true,
    });

    expect(productionHost.findInLoginShell('codex')).toBeNull();
  });

  it('returns null when the shell command throws', () => {
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand: () => {
        throw new Error('exit 1');
      },
      isExecutableFile: () => true,
    });

    expect(productionHost.findInLoginShell('codex')).toBeNull();
  });
});
