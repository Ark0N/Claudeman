/**
 * COD-51: stop() landing DURING a cycle step's write must not revive the machine.
 *
 * Each cycle step (kickstart, update, /clear, /init) guards on `stopped` before
 * `await session.writeViaMux(...)`, then emits `stepSent` and calls
 * `setState('waiting_*')` after it. `stop()` is asynchronous with respect to
 * that await: a stop that lands while the write is in flight passed the guard
 * that already ran, so the post-await `setState()` puts a stopped controller
 * back into a waiting state, re-arming its timers against a session the user
 * asked to stop.
 *
 * The race is driven deterministically here by stopping from inside the mocked
 * write itself — that is exactly the interleaving, without leaning on timing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn((_cmd: string, cb?: (e: Error | null, o: string) => void) => cb?.(null, '')) };
});

import { RespawnController } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { MockSession } from './mocks/index.js';

describe('COD-51 respawn stop() race', () => {
  let session: MockSession;
  let controller: RespawnController;

  beforeEach(() => {
    session = new MockSession();
    controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 100,
      interStepDelayMs: 10,
      completionConfirmMs: 10,
      noOutputTimeoutMs: 500,
      aiIdleCheckEnabled: false,
      // sendKickstart dereferences this before it reaches the write.
      kickstartPrompt: 'continue',
    });
  });

  afterEach(() => controller.stop());

  /**
   * Run `step`, stopping the controller from inside the write it awaits.
   *
   * The step methods are SYNCHRONOUS: they set `sending_*` and schedule a
   * `step-delay` timer, and the write happens inside that callback. So the race
   * only exists once the timer has fired — hence the settle below rather than a
   * bare `await step()`, which returns before anything interesting happens.
   */
  async function stopDuringWrite(step: () => void) {
    const stepSent = vi.fn();
    controller.on('stepSent', stepSent);
    const wrote = new Promise<void>((resolve) => {
      vi.spyOn(session, 'writeViaMux').mockImplementation(async () => {
        controller.stop();
        resolve();
        return true;
      });
    });
    step();
    await wrote;
    // Let the continuation after the await run before asserting on it.
    await new Promise((r) => setTimeout(r, 20));
    return stepSent;
  }

  it.each([
    ['update', () => (controller as never as { sendUpdateDocs(): void }).sendUpdateDocs()],
    ['clear', () => (controller as never as { sendClear(): void }).sendClear()],
    ['init', () => (controller as never as { sendInit(): void }).sendInit()],
    ['kickstart', () => (controller as never as { sendKickstart(): void }).sendKickstart()],
  ])('a stop during the %s write leaves the controller stopped', async (_label, step) => {
    (controller as never as { _state: string })._state = 'watching';

    const stepSent = await stopDuringWrite(step);

    // The observable damage is a revived state machine: `waiting_*` re-arms the
    // step timers, so the cycle keeps driving a session the user stopped.
    expect(controller.state).toBe('stopped');
    expect(controller.isRunning).toBe(false);
    expect(stepSent).not.toHaveBeenCalled();
  });
});
