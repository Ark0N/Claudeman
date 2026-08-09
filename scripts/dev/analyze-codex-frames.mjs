#!/usr/bin/env node
/**
 * @fileoverview Replays a codex fixture (recorded by record-codex-frames.mjs)
 * through @xterm/headless and prints the measurements the predictive-echo
 * design doc records: cursor position + composer-row text at every keystroke
 * injection point, and the final screen with cursor + baseY state.
 *
 * Usage: node scripts/dev/analyze-codex-frames.mjs <fixture.jsonl>
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

const file = process.argv[2];
if (!file) throw new Error('usage: analyze-codex-frames.mjs <fixture.jsonl>');
const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const meta = lines.shift();
console.log('meta:', JSON.stringify(meta));

const term = new Terminal({ cols: meta.cols, rows: meta.rows, scrollback: 1000, allowProposedApi: true });
const write = (data) => new Promise((r) => term.write(data, r));

const snap = () => {
  const buf = term.buffer.active;
  const row = buf.getLine(buf.baseY + buf.cursorY);
  return {
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
    baseY: buf.baseY,
    rowText: row ? row.translateToString(true) : null,
    cursorCell: row?.getCell?.(buf.cursorX)?.getChars() ?? null,
  };
};

for (const line of lines) {
  if (line.keyAt) {
    const s = snap();
    console.log(`KEY ${JSON.stringify(line.data)} @ cursor(${s.cursorX},${s.cursorY}) baseY=${s.baseY}`);
    console.log(`    row: ${JSON.stringify(s.rowText)}`);
    console.log(`    cell-at-cursor: ${JSON.stringify(s.cursorCell)}`);
  } else {
    await write(line.data);
  }
}

const final = snap();
console.log('\nFINAL screen (| marks cursor row/col):');
const buf = term.buffer.active;
for (let y = 0; y < meta.rows; y++) {
  const line = buf.getLine(buf.baseY + y);
  let text = line ? line.translateToString(true) : '';
  if (y === final.cursorY) text = text.slice(0, final.cursorX) + '|' + text.slice(final.cursorX);
  if (text.trim()) console.log(String(y).padStart(3), JSON.stringify(text));
}
console.log('cursor:', JSON.stringify(final), 'viewportY:', buf.viewportY);
