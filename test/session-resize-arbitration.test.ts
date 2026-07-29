import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

/** Must exceed Session.DESKTOP_CLAIM_IDLE_MS (90s) */
const PAST_IDLE_MS = 91_000;

type ResizeableSessionInternals = {
  ptyProcess: { resize: (cols: number, rows: number) => void };
  _ptyCols: number;
  _ptyRows: number;
};

function attachFakePty(session: Session, cols = 160, rows = 48) {
  const resize = vi.fn();
  const internals = session as unknown as ResizeableSessionInternals;
  internals.ptyProcess = { resize };
  internals._ptyCols = cols;
  internals._ptyRows = rows;
  return resize;
}

function registerActiveDesktop(session: Session, token: symbol, cols = 160, rows = 48): void {
  session.claimDesktopSizing(token);
  session.resize(cols, rows, { viewportType: 'desktop', takeControl: true });
}

describe('Session resize arbitration', () => {
  it('lets a mobile-only session shrink below the spawn default (no desktop connected)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });

    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('lets a mobile-only session shrink rows only', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(160, 28, { viewportType: 'mobile' });

    expect(resize).toHaveBeenCalledWith(160, 28);
  });

  it('lets a mobile-only session re-grow after shrinking', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });
    session.resize(80, 36, { viewportType: 'tablet' });

    expect(resize).toHaveBeenNthCalledWith(1, 48, 28);
    expect(resize).toHaveBeenNthCalledWith(2, 80, 36);
  });

  it('ignores mobile resizes while a desktop connection holds a sizing claim', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    registerActiveDesktop(session, desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    // Grow is ignored too — it would reflow the desktop view just the same.
    session.resize(200, 60, { viewportType: 'tablet' });

    expect(resize).not.toHaveBeenCalled();
  });

  it('lets an explicitly active mobile viewport take control of a fresh desktop claim', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    registerActiveDesktop(session, desktop, 208, 45);
    resize.mockClear();

    session.resize(48, 28, { viewportType: 'mobile', takeControl: true });
    expect(resize).toHaveBeenCalledWith(48, 28);

    session.resize(208, 45, { viewportType: 'desktop', takeControl: true });
    expect(resize).toHaveBeenLastCalledWith(208, 45);
  });

  it('applies passive desktop resizes while no mobile override is active', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.claimDesktopSizing(Symbol('desktop-conn'));
    session.resize(120, 40, { viewportType: 'desktop' });

    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  it('ignores a passive desktop restore while a mobile viewport is active', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    registerActiveDesktop(session, desktop, 208, 45);
    resize.mockClear();

    session.resize(48, 28, { viewportType: 'mobile', takeControl: true });
    session.resize(220, 50, { viewportType: 'desktop' });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(48, 28);

    session.resize(220, 50, { viewportType: 'desktop', takeControl: true });
    expect(resize).toHaveBeenLastCalledWith(220, 50);
  });

  it('preserves an explicit mobile takeover when a desktop connects afterward', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    session.resize(48, 28, { viewportType: 'mobile', takeControl: true });
    session.claimDesktopSizing(desktop);
    session.resize(208, 45, { viewportType: 'desktop' });

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(48, 28);

    session.resize(208, 45, { viewportType: 'desktop', takeControl: true });
    expect(resize).toHaveBeenLastCalledWith(208, 45);
  });

  it('restores mobile control once the desktop claim is released', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    registerActiveDesktop(session, desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).not.toHaveBeenCalled();

    session.releaseDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('keeps ignoring mobile resizes until every desktop claim is released', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktopA = Symbol('desktop-a');
    const desktopB = Symbol('desktop-b');

    session.claimDesktopSizing(desktopA);
    session.claimDesktopSizing(desktopB);
    session.resize(160, 48, { viewportType: 'desktop', takeControl: true });
    session.releaseDesktopSizing(desktopA);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).not.toHaveBeenCalled();

    session.releaseDesktopSizing(desktopB);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('applies untyped (legacy/API) resizes regardless of claims', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.claimDesktopSizing(Symbol('desktop-conn'));
    session.resize(100, 30);

    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it('applies forced resizes even when the dimensions did not change', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 120, 40);

    session.resize(120, 40, { force: true });

    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  describe('idle-desktop override (whoever is active wins)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('lets a mobile client take the pane once the desktop claim goes idle', () => {
      vi.useFakeTimers();
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      registerActiveDesktop(session, Symbol('desktop-conn'));
      session.resize(48, 28, { viewportType: 'mobile' });
      expect(resize).not.toHaveBeenCalled(); // fresh claim → ignored

      vi.advanceTimersByTime(PAST_IDLE_MS);
      session.resize(48, 28, { viewportType: 'mobile' });
      expect(resize).toHaveBeenCalledWith(48, 28); // idle desktop → applied
    });

    it('keeps blocking mobile while the desktop stays active via typed input', () => {
      vi.useFakeTimers();
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      registerActiveDesktop(session, Symbol('desktop-conn'));
      vi.advanceTimersByTime(PAST_IDLE_MS - 10_000);
      session.resize(160, 48, { viewportType: 'desktop', takeControl: true });
      vi.advanceTimersByTime(20_000); // idle since claim, but not since input

      session.resize(48, 28, { viewportType: 'mobile' });
      expect(resize).not.toHaveBeenCalled();
    });

    it('re-asserts the desktop layout on desktop input after a mobile override', () => {
      vi.useFakeTimers();
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      registerActiveDesktop(session, Symbol('desktop-conn'), 208, 45);
      vi.advanceTimersByTime(PAST_IDLE_MS);

      session.resize(48, 28, { viewportType: 'mobile' }); // phone takes over
      expect(resize).toHaveBeenLastCalledWith(48, 28);

      session.resize(208, 45, { viewportType: 'desktop', takeControl: true });
      expect(resize).toHaveBeenLastCalledWith(208, 45); // layout restored
    });

    it('does not re-assert when no mobile override happened', () => {
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      session.resize(208, 45, { viewportType: 'desktop', takeControl: true });
      resize.mockClear();
      session.resize(208, 45, { viewportType: 'desktop', takeControl: true });
      expect(resize).not.toHaveBeenCalled();
    });
  });
});
