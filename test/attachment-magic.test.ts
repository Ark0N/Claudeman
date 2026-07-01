import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { parseAttachmentMagicLinks, parseTerminalAttachmentRequests } from '../src/attachment-magic.js';
import { isSupportedAttachmentExtension } from '../src/attachment-registry.js';

describe('attachment magic links', () => {
  it('extracts absolute paths from codeman attach magic URLs', () => {
    const links = parseAttachmentMagicLinks(
      'Preview this: codeman://attach?path=%2Fmnt%2Fc%2FDecks%2FBoard%20Update.pptx'
    );

    expect(links).toEqual(['/mnt/c/Decks/Board Update.pptx']);
  });

  it('ignores duplicate links in one terminal chunk', () => {
    const links = parseAttachmentMagicLinks(
      [
        'codeman://attach?path=/tmp/report.pdf',
        'codeman://attach?path=/tmp/report.pdf',
        'codeman://attach?path=/tmp/brief.docx',
      ].join('\n')
    );

    expect(links).toEqual(['/tmp/report.pdf', '/tmp/brief.docx']);
  });

  it('accepts markdown and plain-text magic paths', () => {
    const links = parseAttachmentMagicLinks(
      ['codeman://attach?path=/tmp/notes.md', 'codeman://attach?path=/tmp/run.txt'].join('\n')
    );

    expect(links).toEqual(['/tmp/notes.md', '/tmp/run.txt']);
  });

  it('rejects relative or unsupported magic paths', () => {
    const links = parseAttachmentMagicLinks(
      [
        'codeman://attach?path=relative.pdf',
        'codeman://attach?path=/tmp/archive.zip',
        'codeman://attach?path=/tmp/deck.pptx',
      ].join('\n')
    );

    expect(links).toEqual(['/tmp/deck.pptx']);
  });

  it('emits attachmentRequested from raw terminal output', () => {
    const session = new Session({ id: 'session-attach-test', workingDir: '/tmp', mode: 'codex' });
    const requested: string[] = [];
    session.on('attachmentRequested', (event: { path: string }) => requested.push(event.path));

    (session as unknown as { _handleTerminalOutput(data: string): void })._handleTerminalOutput(
      'codeman://attach?path=%2Ftmp%2Fdeck.pptx'
    );

    expect(requested).toEqual(['/tmp/deck.pptx']);
  });

  it('extracts Codex generated image file URLs from saved-to terminal output', () => {
    const requests = parseTerminalAttachmentRequests(
      'Saved to: file:///Users/aamer/.codex-personal/generated_images/mockup%20one.png'
    );

    expect(requests).toEqual([
      {
        path: '/Users/aamer/.codex-personal/generated_images/mockup one.png',
        source: 'codex-generated',
      },
    ]);
  });

  it('emits generated artifact requests from Codex saved-to output', () => {
    const session = new Session({ id: 'session-generated-artifact-test', workingDir: '/tmp', mode: 'codex' });
    const requested: Array<{ path: string; source?: string }> = [];
    session.on('attachmentRequested', (event: { path: string; source?: string }) => requested.push(event));

    (session as unknown as { _handleTerminalOutput(data: string): void })._handleTerminalOutput(
      'Saved to: file:///Users/aamer/.codex-personal/generated_images/output.png'
    );

    expect(requested).toEqual([
      {
        sessionId: 'session-generated-artifact-test',
        path: '/Users/aamer/.codex-personal/generated_images/output.png',
        source: 'codex-generated',
        timestamp: expect.any(Number),
      },
    ]);
  });

  it('supports generated image attachment extensions beyond png', () => {
    expect(isSupportedAttachmentExtension('jpg')).toBe(true);
    expect(isSupportedAttachmentExtension('jpeg')).toBe(true);
    expect(isSupportedAttachmentExtension('webp')).toBe(true);
  });
});
