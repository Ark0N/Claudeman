#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Colors (with fallback for no-color environments)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => useColor ? `\x1b[32m${s}\x1b[0m` : s;
const yellow = (s) => useColor ? `\x1b[33m${s}\x1b[0m` : s;
const red = (s) => useColor ? `\x1b[31m${s}\x1b[0m` : s;
const bold = (s) => useColor ? `\x1b[1m${s}\x1b[0m` : s;

console.log(bold('Claudeman postinstall check...'));

let hasWarnings = false;

// 1. Check Node.js version >= 18
const nodeVersion = process.versions.node;
const majorVersion = parseInt(nodeVersion.split('.')[0], 10);

if (majorVersion < 18) {
  console.log(red(`✗ Node.js v${nodeVersion} is too old (requires >=18)`));
  process.exit(1);
} else {
  console.log(green(`✓ Node.js v${nodeVersion}`) + ' (meets >=18 requirement)');
}

// 2. Check if GNU Screen is installed
let screenFound = false;
try {
  execSync('which screen', { stdio: 'pipe' });
  screenFound = true;
  console.log(green('✓ GNU Screen found'));
} catch {
  hasWarnings = true;
  console.log(yellow('⚠ GNU Screen not found'));
  console.log('  Install:');
  console.log('    Ubuntu/Debian: sudo apt install screen');
  console.log('    macOS: brew install screen');
}

// 3. Check if Claude CLI is found
const home = homedir();
const claudePaths = [
  join(home, '.local/bin/claude'),
  join(home, '.claude/local/claude'),
  '/usr/local/bin/claude',
  join(home, '.npm-global/bin/claude'),
  join(home, 'bin/claude'),
];

let claudeFound = false;

// First try `which claude`
try {
  execSync('which claude', { stdio: 'pipe' });
  claudeFound = true;
} catch {
  // Check known paths
  for (const p of claudePaths) {
    if (existsSync(p)) {
      claudeFound = true;
      break;
    }
  }
}

if (claudeFound) {
  console.log(green('✓ Claude CLI found'));
} else {
  hasWarnings = true;
  console.log(yellow('⚠ Claude CLI not found'));
  console.log('  Install: curl -fsSL https://claude.ai/install.sh | bash');
}

// Print next steps
console.log('');
console.log(bold('Next steps:'));
console.log('  npm run build');
console.log('  claudeman web');

if (hasWarnings) {
  console.log('');
  console.log(yellow('Note: Resolve warnings above for full functionality.'));
}
