import { describe, expect, it } from 'vitest';
import { resolveMuxAttachCwd, Session } from '../src/session.js';
import type { SessionAttachmentHistoryItem } from '../src/types/session.js';
import {
  ATTACHMENT_HISTORY_LIMIT,
  buildDetectedAttachmentHistoryItem,
  buildExternalAttachmentHistoryItem,
  upsertAttachmentHistory,
} from '../src/session-attachment-history.js';

describe('session attachment history', () => {
  it('dedupes explicit external attachments by source path and moves latest to top', () => {
    const first = buildExternalAttachmentHistoryItem({
      sessionId: 's1',
      externalPath: '/mnt/c/docs/brief.docx',
      fileName: 'brief.docx',
      extension: 'docx',
      size: 100,
      mtimeMs: 1,
      timestamp: 10,
    });
    const second = { ...first, size: 200, mtimeMs: 2, timestamp: 20 };

    const result = upsertAttachmentHistory(upsertAttachmentHistory([], first), second);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      size: 200,
      mtimeMs: 2,
      timestamp: 20,
      externalPath: '/mnt/c/docs/brief.docx',
    });
  });

  it('dedupes detected workspace attachments by relative path', () => {
    const first = buildDetectedAttachmentHistoryItem({
      sessionId: 's1',
      filePath: 'report.pdf',
      relativePath: 'out/report.pdf',
      fileName: 'report.pdf',
      extension: 'pdf',
      attachmentType: 'pdf',
      size: 100,
      timestamp: 10,
    });
    const second = { ...first, size: 150, timestamp: 20 };

    const result = upsertAttachmentHistory(upsertAttachmentHistory([], first), second);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ relativePath: 'out/report.pdf', size: 150, timestamp: 20 });
  });

  it('caps history to newest 100 items', () => {
    let history: SessionAttachmentHistoryItem[] = [];
    for (let i = 0; i < ATTACHMENT_HISTORY_LIMIT + 5; i++) {
      history = upsertAttachmentHistory(
        history,
        buildDetectedAttachmentHistoryItem({
          sessionId: 's1',
          filePath: `${i}.png`,
          relativePath: `out/${i}.png`,
          fileName: `${i}.png`,
          extension: 'png',
          attachmentType: 'image',
          size: i,
          timestamp: i,
        })
      );
    }

    expect(history).toHaveLength(ATTACHMENT_HISTORY_LIMIT);
    expect(history[0].fileName).toBe('104.png');
    expect(history.at(-1)?.fileName).toBe('5.png');
  });

  it('includes attachment history in session state', () => {
    const session = new Session({ workingDir: '/tmp' });
    session.upsertAttachmentHistory({
      id: 'detected:file.png',
      sessionId: session.id,
      fileName: 'file.png',
      extension: 'png',
      attachmentType: 'image',
      size: 12,
      mtimeMs: 0,
      timestamp: 100,
      source: 'detected',
      relativePath: 'file.png',
    });

    expect(session.toState().attachmentHistory).toHaveLength(1);
    expect(session.toState().attachmentHistory?.[0].fileName).toBe('file.png');
  });

  it('sanitizes external attachment paths from public session state', () => {
    const session = new Session({ workingDir: '/tmp' });
    session.upsertAttachmentHistory(
      buildExternalAttachmentHistoryItem({
        sessionId: session.id,
        externalPath: '/mnt/c/private/board-update.pdf',
        fileName: 'board-update.pdf',
        extension: 'pdf',
        size: 100,
        timestamp: 100,
      })
    );

    const publicState = session.toState();
    const persistedHistory = session.getAttachmentHistoryForPersist();

    expect(JSON.stringify(publicState.attachmentHistory)).not.toContain('/mnt/c/private/board-update.pdf');
    expect(publicState.attachmentHistory?.[0].id).not.toContain('/mnt/c/private/board-update.pdf');
    expect(persistedHistory?.[0].externalPath).toBe('/mnt/c/private/board-update.pdf');
  });

  it('round-trips persisted history (incl. externalPath) through constructor restore', () => {
    const a = new Session({ workingDir: '/tmp' });
    a.upsertAttachmentHistory(
      buildExternalAttachmentHistoryItem({
        sessionId: a.id,
        externalPath: '/mnt/c/docs/deck.docx',
        fileName: 'deck.docx',
        extension: 'docx',
        size: 10,
        timestamp: 5,
      })
    );
    const persisted = a.getAttachmentHistoryForPersist();

    const b = new Session({ workingDir: '/tmp', attachmentHistory: persisted });
    // Private copy keeps externalPath (needed to re-register/serve the file)...
    expect(b.getAttachmentHistoryForPersist()?.[0].externalPath).toBe('/mnt/c/docs/deck.docx');
    // ...but the public copy stays sanitized after restore.
    expect(JSON.stringify(b.toState().attachmentHistory)).not.toContain('/mnt/c/docs/deck.docx');
  });

  it('ignores malformed saved history items during restore instead of throwing', () => {
    const valid: SessionAttachmentHistoryItem = {
      id: 'detected:ok.png',
      sessionId: 's',
      fileName: 'ok.png',
      extension: 'png',
      attachmentType: 'image',
      size: 1,
      mtimeMs: 0,
      timestamp: 1,
      source: 'detected',
      relativePath: 'ok.png',
    };
    // null, a non-object, and an item missing required fields must be skipped —
    // historyKey() would otherwise throw inside the constructor and abort recovery.
    const malformed = [null, 'nope', { partial: true }, valid] as unknown as SessionAttachmentHistoryItem[];

    let session!: Session;
    expect(() => {
      session = new Session({ workingDir: '/tmp', attachmentHistory: malformed });
    }).not.toThrow();

    const persisted = session.getAttachmentHistoryForPersist();
    expect(persisted).toHaveLength(1);
    expect(persisted?.[0].fileName).toBe('ok.png');
  });

  it('attaches remote mux sessions from a local cwd', () => {
    expect(
      resolveMuxAttachCwd('/Users/remote/project', {
        hostId: 'mac-mini',
        label: 'Mac Mini',
        host: '192.168.21.109',
        username: 'saqebakhter',
        remotePath: '/Users/remote/project',
      })
    ).toBe('/tmp');
    expect(resolveMuxAttachCwd('/opt/projects/Codeman')).toBe('/opt/projects/Codeman');
  });

  it('round-trips remote metadata through the Session constructor (restart-recovery contract)', () => {
    // restoreMuxSessions() reconstructs recovered sessions via
    // `new Session({ ..., remote: muxSession.remote ?? savedState.remote })`. If that
    // remote does not survive toState(), the next persistSessionState() erases it from
    // state.json AND the attach cwd falls back to the (nonexistent-locally) remote path.
    const remote = {
      hostId: 'gpu-box',
      label: 'GPU Box',
      host: '10.0.0.42',
      username: 'ubuntu',
      remotePath: '/home/ubuntu/work',
      commands: { claude: 'exec claude --dangerously-skip-permissions' },
    };
    const restored = new Session({ workingDir: '/home/ubuntu/work', remote });
    const state = restored.toState();
    expect(state.remote).toEqual(remote);
    // Recovered attach cwd must be a LOCAL path, never the remote-only workingDir.
    expect(resolveMuxAttachCwd(state.workingDir, state.remote)).toBe('/tmp');
  });
});
