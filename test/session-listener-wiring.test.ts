import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { createSessionListeners } from '../src/web/session-listener-wiring.js';

describe('session listener wiring', () => {
  it('forwards the attachment request source through registerAttachment', async () => {
    const session = new Session({ id: 'wiring-attach-source-test', workingDir: '/tmp', mode: 'codex' });
    const registerAttachment = vi.fn(async () => undefined);
    const deps = { registerAttachment } as unknown as Parameters<typeof createSessionListeners>[1];

    const refs = createSessionListeners(session, deps);
    refs.attachmentRequested({ path: '/tmp/mockup.png', source: 'codex-generated' });
    refs.attachmentRequested({ path: '/tmp/report.pdf', source: 'external' });

    expect(registerAttachment).toHaveBeenNthCalledWith(
      1,
      'wiring-attach-source-test',
      '/tmp/mockup.png',
      'codex-generated'
    );
    expect(registerAttachment).toHaveBeenNthCalledWith(2, 'wiring-attach-source-test', '/tmp/report.pdf', 'external');
  });
});
