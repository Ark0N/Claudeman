/**
 * @fileoverview The shipped stock catalog — one `CliEntry` per CLI Codeman supports out of
 * the box, transcribed to be byte-identical (via the argv engine) to the hand-written
 * builders in tmux-manager.ts that they replace.
 *
 * This is the ONE file allowed to know a CLI's id by name (`test/cli-registry-no-id-branching
 * .test.ts` enforces that nowhere else does). Everything downstream — session.ts,
 * tmux-manager.ts, the routes, the frontend — reads capability flags, never `entry.id ===`.
 *
 * @module config/cli-registry/stock
 */

import type { CliEntry } from './types.js';

const HOME_DIRS = {
  local: '~/.local/bin',
  usrLocal: '/usr/local/bin',
  bunBin: '~/.bun/bin',
  npmGlobal: '~/.npm-global/bin',
  homeBin: '~/bin',
};

const NO_GATES = {};
const NO_PRIVILEGED_PARAMS: CliEntry['capabilities']['privilegedParams'] = [];

/** Shared skeleton for the "agent CLI, no unusual behaviour" case (pi's own shape). */
function agentDefaults(): Pick<
  CliEntry['capabilities'],
  | 'external'
  | 'requiresMux'
  | 'hooks'
  | 'transcript'
  | 'altScreen'
  | 'wheelForward'
  | 'keyboardAccessory'
  | 'privilegedCommandGate'
  | 'startMode'
  | 'stripInkBloat'
  | 'ralph'
  | 'respawn'
  | 'effort'
  | 'agentSkillInjection'
  | 'statusLineTelemetry'
  | 'model'
  | 'privilegedParams'
  | 'gates'
> {
  return {
    external: true,
    requiresMux: true,
    hooks: false,
    transcript: 'none',
    altScreen: 'strip-mux-only',
    wheelForward: { mode: 'never' },
    keyboardAccessory: 'agent',
    privilegedCommandGate: false,
    startMode: 'interactive',
    stripInkBloat: true,
    ralph: false,
    respawn: false,
    effort: false,
    agentSkillInjection: false,
    statusLineTelemetry: false,
    model: { source: 'flag', param: 'model' },
    privilegedParams: NO_PRIVILEGED_PARAMS,
    gates: NO_GATES,
  };
}

const CLAUDE: CliEntry = {
  id: 'claude' as CliEntry['id'],
  label: 'Claude',
  shortBadge: 'CC',
  accent: '#d97757',
  enabled: true,
  stock: true,
  order: 0,
  kind: 'agent',
  discovery: {
    binaries: ['claude'],
    searchDirs: [HOME_DIRS.local, '~/.claude/local', HOME_DIRS.usrLocal, HOME_DIRS.npmGlobal, HOME_DIRS.homeBin],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)', retryOnTransientFailure: true },
    install: {
      command: {
        linux: 'curl -fsSL https://claude.ai/install.sh | bash',
        darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
        wsl: 'curl -fsSL https://claude.ai/install.sh | bash',
      },
      npmPackage: '@anthropic-ai/claude-code',
      docsUrl: 'https://docs.claude.com/claude-code',
    },
  },
  launch: {
    chain: 'fallback',
    params: {
      claudeMode: {
        type: 'enum',
        values: ['dangerously-skip-permissions', 'auto', 'normal', 'allowedTools'],
        default: 'dangerously-skip-permissions',
      },
      allowedTools: { type: 'token', pattern: 'tool-list' },
      model: { type: 'token', pattern: 'model-claude' },
      resumeId: { type: 'token', pattern: 'uuid' },
      // buildEffortCliArgs carries `ultracode` as a settings JSON blob and every other
      // level as a plain `--effort <level>` flag — two engine values because the two
      // shapes are mutually exclusive and neither is user-typed text (both are produced
      // from the EFFORT_LEVELS allowlist upstream, same as every other engine value).
      effortLevel: { type: 'engine', source: 'effortLevel' },
      effortJson: { type: 'engine', source: 'effortSettingsJson' },
      sessionId: { type: 'engine', source: 'sessionId' },
      sessionName: { type: 'engine', source: 'sessionName' },
    },
    variants: [
      {
        id: 'resume',
        when: { param: 'resumeId', state: 'set' },
        args: [
          { lit: 'claude' },
          { flag: '--dangerously-skip-permissions', when: { param: 'claudeMode', is: 'dangerously-skip-permissions' } },
          { flag: '--permission-mode', value: 'auto', when: { param: 'claudeMode', is: 'auto' } },
          {
            flag: '--allowedTools',
            valueFrom: 'allowedTools',
            quote: 'double',
            when: {
              allOf: [
                { param: 'claudeMode', is: 'allowedTools' },
                { param: 'allowedTools', state: 'set' },
              ],
            },
          },
          { flag: '--resume', valueFrom: 'resumeId', quote: 'double' },
          { flag: '--model', valueFrom: 'model', quote: 'double', when: { param: 'model', state: 'set' } },
          { flag: '--effort', valueFrom: 'effortLevel', quote: 'single', when: { param: 'effortLevel', state: 'set' } },
          { flag: '--settings', valueFrom: 'effortJson', quote: 'single', when: { param: 'effortJson', state: 'set' } },
          { flag: '--name', valueFrom: 'sessionName', quote: 'double', when: { capabilityGate: 'nameFlag' } },
        ],
      },
      {
        id: 'new',
        args: [
          { lit: 'claude' },
          { flag: '--dangerously-skip-permissions', when: { param: 'claudeMode', is: 'dangerously-skip-permissions' } },
          { flag: '--permission-mode', value: 'auto', when: { param: 'claudeMode', is: 'auto' } },
          {
            flag: '--allowedTools',
            valueFrom: 'allowedTools',
            quote: 'double',
            when: {
              allOf: [
                { param: 'claudeMode', is: 'allowedTools' },
                { param: 'allowedTools', state: 'set' },
              ],
            },
          },
          { flag: '--session-id', valueFrom: 'sessionId', quote: 'double' },
          { flag: '--model', valueFrom: 'model', quote: 'double', when: { param: 'model', state: 'set' } },
          { flag: '--effort', valueFrom: 'effortLevel', quote: 'single', when: { param: 'effortLevel', state: 'set' } },
          { flag: '--settings', valueFrom: 'effortJson', quote: 'single', when: { param: 'effortJson', state: 'set' } },
          { flag: '--name', valueFrom: 'sessionName', quote: 'double', when: { capabilityGate: 'nameFlag' } },
        ],
      },
    ],
    // Claude has no `<Mode>Config` object of its own — the bridge synthesizes one from its
    // discrete top-level spawn fields, under their EXISTING field name `resumeSessionId`.
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
  },
  env: {
    exports: [],
    unset: ['CLAUDECODE', 'COLORTERM'],
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['CLAUDE_CODE_'],
    allowedKeys: ['CLAUDE_CONFIG_DIR'],
  },
  capabilities: {
    external: false,
    requiresMux: false,
    hooks: true,
    transcript: 'claude-jsonl',
    altScreen: 'strip-full',
    echo: { policy: 'buffer', anchor: { kind: 'glyph', glyph: '❯', offset: 2 } },
    wheelForward: { mode: 'version-gated', minVersion: '2.1.187' },
    keyboardAccessory: 'agent',
    privilegedCommandGate: false,
    startMode: 'interactive',
    stripInkBloat: true,
    ralph: true,
    respawn: true,
    effort: true,
    agentSkillInjection: true,
    statusLineTelemetry: true,
    model: { source: 'claude-settings-file' },
    privilegedParams: [],
    gates: { nameFlag: { minVersion: '2.1.224', failClosed: true } },
  },
  overlays: {
    remote: { variant: 'new' },
    docker: { variant: 'new' },
    // Claude's docker/remote credential handling has its own dedicated code path
    // (claudeDockerPaneCommand, artifacts at docker-hosts.ts:537-575) — no generic credStore.
  },
};

const SHELL: CliEntry = {
  id: 'shell' as CliEntry['id'],
  label: 'Shell',
  shortBadge: 'SH',
  accent: '#6b7280',
  enabled: true,
  stock: true,
  order: 1,
  kind: 'shell',
  discovery: {
    binaries: [],
    searchDirs: [],
    install: { command: {} },
  },
  launch: {
    params: {},
    variants: [{ id: 'shell', args: [] }], // tmux-manager resolves the real login shell in code
  },
  env: {
    exports: [],
    unset: ['COLORTERM'],
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: [],
    allowedKeys: [],
  },
  capabilities: {
    external: false,
    requiresMux: false,
    hooks: false,
    transcript: 'none',
    altScreen: 'preserve',
    echo: { policy: 'off', anchor: { kind: 'none' } },
    wheelForward: { mode: 'never' },
    keyboardAccessory: 'shell',
    privilegedCommandGate: true,
    startMode: 'shell',
    stripInkBloat: false,
    ralph: false,
    respawn: false,
    effort: false,
    agentSkillInjection: false,
    statusLineTelemetry: false,
    model: { source: 'none' },
    privilegedParams: [],
    gates: {},
  },
  overlays: {
    remote: { variant: 'shell' },
    docker: { disabled: true },
  },
};

const OPENCODE: CliEntry = {
  id: 'opencode' as CliEntry['id'],
  label: 'OpenCode',
  shortBadge: 'OC',
  accent: '#f59e0b',
  enabled: true,
  stock: true,
  order: 10,
  kind: 'agent',
  discovery: {
    binaries: ['opencode'],
    searchDirs: [
      '~/.opencode/bin',
      HOME_DIRS.local,
      HOME_DIRS.usrLocal,
      '~/go/bin',
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: {
        linux: 'curl -fsSL https://opencode.ai/install | bash',
        darwin: 'curl -fsSL https://opencode.ai/install | bash',
      },
      npmPackage: 'opencode-ai',
      docsUrl: 'https://opencode.ai/docs',
    },
  },
  launch: {
    params: {
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id' },
      forkSession: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'opencode' },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--session', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            flag: '--fork',
            when: {
              allOf: [
                { param: 'resumeId', state: 'set' },
                { param: 'forkSession', is: true },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'continueSession' },
  },
  env: {
    exports: [],
    unset: ['COLORTERM'],
    tmuxSetenvKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
    dockerExecEnvNames: [],
    allowedPrefixes: ['OPENCODE_'],
    allowedKeys: [],
    configContentVar: 'OPENCODE_CONFIG_CONTENT',
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'strip-mux-only',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' }, predictProfile: undefined },
  },
  overlays: {
    remote: { variant: 'default' },
    docker: { variant: 'default' },
    credStore: { rel: '.config/opencode', seedWhole: true },
  },
};

const CODEX: CliEntry = {
  id: 'codex' as CliEntry['id'],
  label: 'Codex',
  shortBadge: 'CX',
  accent: '#6b7fd7',
  enabled: true,
  stock: true,
  order: 20,
  kind: 'agent',
  discovery: {
    binaries: ['codex'],
    searchDirs: [
      '~/.codex/bin',
      HOME_DIRS.local,
      HOME_DIRS.usrLocal,
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: { linux: 'npm install -g @openai/codex', darwin: 'npm install -g @openai/codex' },
      npmPackage: '@openai/codex',
      docsUrl: 'https://developers.openai.com/codex/cli',
    },
  },
  launch: {
    params: {
      bypassApprovals: { type: 'bool' },
      animations: { type: 'bool' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'codex' },
          { flag: '--dangerously-bypass-approvals-and-sandbox', when: { param: 'bypassApprovals', is: true } },
          { flag: '--config', value: 'tui.animations=true', when: { param: 'animations', is: true } },
          { flag: '--config', value: 'tui.animations=false', when: { param: 'animations', is: false } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { lit: 'resume', when: { param: 'resumeId', state: 'set' } },
          { valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
        ],
      },
    ],
    legacyConfigAliases: { bypassApprovals: 'dangerouslyBypassApprovals', resumeId: 'resumeSessionId' },
    resumeAppend: { style: 'positional', token: 'resume' },
  },
  env: {
    exports: [
      { name: 'COLORTERM', value: 'truecolor' },
      { name: 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', value: { engine: 'codemanPrefixedSessionId' } },
    ],
    unset: ['NO_COLOR'],
    tmuxSetenvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME'],
    dockerExecEnvNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    allowedPrefixes: ['CODEX_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    transcript: 'codex-rollout',
    altScreen: 'strip-full',
    echo: { policy: 'predict', anchor: { kind: 'cursor' }, predictProfile: 'codex' },
    wheelForward: { mode: 'never' }, // #227: codex ignores SGR wheel reports, never forward
    maxFrameBytes: 32 * 1024,
  },
  overlays: {
    remote: { variant: 'default' },
    docker: { variant: 'default' },
    credStore: {
      rel: '.codex',
      shareDirs: ['sessions'],
      shareFiles: ['history.jsonl'],
      seedFiles: ['auth.json', 'config.toml'],
    },
  },
};

const GEMINI: CliEntry = {
  id: 'gemini' as CliEntry['id'],
  label: 'Gemini',
  shortBadge: 'GM',
  accent: '#4285f4',
  enabled: true,
  stock: true,
  order: 30,
  kind: 'agent',
  discovery: {
    binaries: ['gemini'],
    searchDirs: [
      '~/.gemini/bin',
      HOME_DIRS.local,
      HOME_DIRS.usrLocal,
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: { linux: 'npm install -g @google/gemini-cli', darwin: 'npm install -g @google/gemini-cli' },
      npmPackage: '@google/gemini-cli',
      docsUrl: 'https://github.com/google-gemini/gemini-cli',
    },
  },
  launch: {
    params: {
      approvalMode: { type: 'enum', values: ['default', 'auto_edit', 'yolo', 'plan'], default: 'yolo' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'gemini' },
          { flag: '--skip-trust' },
          { flag: '--approval-mode', valueFrom: 'approvalMode' },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--resume', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSession' },
    resumeAppend: { style: 'flag', flag: '--resume' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    tmuxSetenvKeys: [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_API_KEY',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GENAI_USE_VERTEXAI',
    ],
    dockerExecEnvNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    allowedPrefixes: ['GEMINI_', 'GOOGLE_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'strip-full',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
  },
  overlays: {
    remote: { variant: 'default' },
    docker: { variant: 'default' },
    credStore: { rel: '.gemini', seedWhole: true }, // also covers antigravity — see its own entry
  },
};

const ANTIGRAVITY: CliEntry = {
  id: 'antigravity' as CliEntry['id'],
  label: 'Antigravity',
  shortBadge: 'AG',
  accent: '#8b5cf6',
  enabled: true,
  stock: true,
  order: 40,
  kind: 'agent',
  discovery: {
    // Binary is `agy`, NOT `antigravity` — the mode-name/binary-name split that made
    // probeDockerCliVersion wrong before this registry existed.
    binaries: ['agy'],
    searchDirs: [HOME_DIRS.local, '~/.antigravity/bin', HOME_DIRS.usrLocal, HOME_DIRS.homeBin],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: {
        linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        darwin: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
      docsUrl: 'https://antigravity.google/cli',
    },
  },
  launch: {
    params: {
      dangerouslySkipPermissions: { type: 'bool' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'agy' },
          { flag: '--dangerously-skip-permissions', when: { param: 'dangerouslySkipPermissions', is: true } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--conversation', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeConversationId' },
    resumeAppend: { style: 'flag', flag: '--conversation' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['ANTIGRAVITY_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'strip-mux-only',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
  },
  overlays: {
    remote: { variant: 'default' },
    docker: { variant: 'default' },
    // No credStore of its own: agy nests its whole state under ~/.gemini/antigravity-cli/,
    // which gemini's seedWhole entry already covers.
  },
};

const PI: CliEntry = {
  id: 'pi' as CliEntry['id'],
  label: 'Pi',
  shortBadge: 'PI',
  accent: '#10b981',
  enabled: true,
  stock: true,
  order: 50,
  kind: 'agent',
  discovery: {
    binaries: ['pi'],
    searchDirs: [HOME_DIRS.local, HOME_DIRS.usrLocal, HOME_DIRS.bunBin, HOME_DIRS.npmGlobal, HOME_DIRS.homeBin],
    // pi is a generic binary name (Raspberry Pi tooling, personal scripts), so a `which`
    // hit alone is not evidence of the right program — require the version match.
    version: { arg: '--version', regex: '(?:^|\\s)(\\d+\\.\\d+\\.\\d+)', requireVersionMatch: true },
    install: {
      command: {
        linux: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
        darwin: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
      },
      npmPackage: '@earendil-works/pi-coding-agent',
      docsUrl: 'https://pi.dev',
    },
  },
  launch: {
    params: {
      approveProjectTrust: { type: 'bool' },
      model: { type: 'token', pattern: 'model-pi' },
      provider: { type: 'token', pattern: 'slug' },
      thinking: { type: 'enum', values: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      resumeId: { type: 'token', pattern: 'id-dotted' },
      continueSession: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'pi' },
          { flag: '--approve', when: { param: 'approveProjectTrust', is: true } },
          { flag: '--no-approve', when: { param: 'approveProjectTrust', is: false } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--provider', valueFrom: 'provider', when: { param: 'provider', state: 'set' } },
          { flag: '--thinking', valueFrom: 'thinking', when: { param: 'thinking', state: 'set' } },
          { flag: '--session', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            lit: '-c',
            when: {
              allOf: [
                { param: 'continueSession', is: true },
                { param: 'resumeId', state: 'unset' },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
    resumeAppend: { style: 'flag', flag: '--session' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    // Pi's ~34 provider keys share no common prefix, so they are deliberately NOT
    // allowlisted here — same reasoning as today's PI_ only prefix. Pi users authenticate
    // via `/login` or the server process's own env.
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['PI_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'preserve', // pi's TUI renders into the main screen with terminal-owned scrollback
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
  },
  overlays: {
    remote: { variant: 'default' },
    docker: { variant: 'default' },
    credStore: {
      rel: '.pi/agent',
      seedFiles: ['auth.json', 'settings.json', 'trust.json', 'models.json', 'models-store.json'],
    },
  },
};

/** The full stock catalog, in the order the run menu shows by default. */
export const STOCK_CLIS: CliEntry[] = [CLAUDE, SHELL, OPENCODE, CODEX, GEMINI, ANTIGRAVITY, PI];
