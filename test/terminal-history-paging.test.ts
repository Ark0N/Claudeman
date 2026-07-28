import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('client terminal history paging', () => {
  const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const constantsSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');

  it('uses a bounded history page for cold selection instead of full history', () => {
    const start = appSource.indexOf('async selectSession(sessionId');
    const body = appSource.slice(start, start + 18_000);

    expect(body).toContain('historyPage=1');
    expect(body).toContain('TERMINAL_HISTORY_PAGE_LINES');
    expect(body).not.toContain('terminal?full=1');
    expect(constantsSource).toContain('const TERMINAL_HISTORY_PAGE_LINES = 400;');
  });

  it('loads older pages from terminal scroll events and keeps a bounded client window', () => {
    expect(terminalSource).toContain('_maybeLoadTerminalHistoryPage');
    expect(terminalSource).toContain('_loadTerminalHistoryPage');
    expect(terminalSource).toContain('TERMINAL_HISTORY_WINDOW_PAGES');
    expect(terminalSource).toContain('historyPage=1');
    expect(terminalSource).toContain('const threshold = rows * 3;');
    expect(terminalSource).toContain('state.invalidated = true');
    expect(terminalSource).not.toContain('state.start = 0;\n        state.end = state.total;');
  });

  it('reconciles live output against the latest-frame cursor after a page rebuild', () => {
    const start = terminalSource.indexOf('async _loadTerminalHistoryPage');
    const body = terminalSource.slice(start, start + 10_000);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('_beginBufferLoad');
    expect(body).toContain('snapshotCursor: latest.cursor');
    expect(body).toContain('flushQueued: true');
  });

  it('uses a bounded tail and discards page coordinates when latest-frame composition fails', () => {
    const start = appSource.indexOf('if (data.historyPage && !latestFrame?.terminalBuffer)');
    const body = appSource.slice(start, start + 1_800);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('tail=${TERMINAL_TAIL_SIZE}');
    expect(body).toContain('this._terminalHistoryPaging.delete(sessionId)');
  });
});
