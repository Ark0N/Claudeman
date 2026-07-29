#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(repoRoot, 'src/web/public');
const prettierBin = resolve(repoRoot, 'node_modules/.bin/prettier');
const checkedExtensions = new Set(['.js', '.css', '.html', '.json']);

export function collectTextAssets(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTextAssets(fullPath));
      continue;
    }
    if (checkedExtensions.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

export function findNullByte(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) return i;
  }
  return -1;
}

function main() {
  const files = collectTextAssets(publicRoot);
  const failures = [];

  for (const file of files) {
    const rel = relative(repoRoot, file);
    const data = readFileSync(file);
    const nullByteIndex = findNullByte(data);
    if (nullByteIndex !== -1) {
      failures.push(`${rel}: contains literal NUL byte at offset ${nullByteIndex}`);
    }

    if (extname(file) === '.js') {
      try {
        execFileSync(process.execPath, ['--check', file], { cwd: repoRoot, stdio: 'pipe' });
      } catch (err) {
        failures.push(`${rel}: JavaScript syntax check failed\n${String(err.stderr || err.message).trim()}`);
      }
    }
  }

  try {
    execFileSync(prettierBin, ['--check', ...files], { cwd: repoRoot, stdio: 'pipe' });
  } catch (err) {
    failures.push(`Prettier public asset check failed\n${String(err.stdout || err.stderr || err.message).trim()}`);
  }

  if (failures.length > 0) {
    console.error(failures.join('\n\n'));
    process.exitCode = 1;
    return;
  }

  console.log(`Public asset checks passed (${files.length} files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
