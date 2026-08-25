/**
 * The background `dsh web` supervisor and the authority boundary in front of it.
 *
 * Two things here are worth pinning and neither is obvious from reading the
 * module:
 *
 * 1. `authority` becomes an argv element of a spawned process (`--trusted-host
 *    <authority>`). The spawn is an argv ARRAY so a shell can never see it, but
 *    the schema is the layer that stops a value which is not a browser
 *    authority at all from reaching the command line, and a regex is easy to
 *    widen by accident.
 * 2. The supervisor tracks at most ONE server. The status accessor is what every
 *    caller reads to decide whether to start another, so "no server" must report
 *    as absent rather than as a half-populated record.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DeepSeekWebStartSchema } from '../src/web/schemas.js';
import { getDeepSeekWebStatus, resetDeepSeekWebForTest, stopDeepSeekWeb } from '../src/deepseek-web-server.js';

describe('DeepSeekWebStartSchema: the authority reaching --trusted-host', () => {
  it('accepts the authority shapes a browser can actually report', () => {
    for (const authority of [
      'localhost:3000',
      '127.0.0.1:5013',
      'tnode.tailf80371.ts.net:8444',
      'codeman.example.com',
      '[::1]:3000',
      'host-with-dashes.local:80',
    ]) {
      expect(DeepSeekWebStartSchema.safeParse({ authority }).success, authority).toBe(true);
    }
  });

  it('rejects values that are not an authority at all', () => {
    for (const authority of [
      '',
      'http://localhost:3000', // a URL, not an authority
      'localhost:3000 --trusted-host evil', // an embedded second argument
      '-oProxyCommand=evil', // leading dash, readable as a flag
      'localhost:3000/../path',
      'local host:3000',
      'user:pass@localhost:3000',
      'a'.repeat(256),
    ]) {
      expect(DeepSeekWebStartSchema.safeParse({ authority }).success, authority).toBe(false);
    }
  });

  it('is strict, so an unexpected field cannot ride along', () => {
    expect(DeepSeekWebStartSchema.safeParse({ authority: 'localhost:3000', port: 1 }).success).toBe(false);
  });

  it('requires the field rather than defaulting it', () => {
    // A guessed default would silently fence dsh's /api against the wrong
    // origin, which presents as a dashboard whose every call 403s.
    expect(DeepSeekWebStartSchema.safeParse({}).success).toBe(false);
  });
});

describe('DeepSeek web supervisor: status', () => {
  beforeEach(() => {
    resetDeepSeekWebForTest();
  });

  it('reports absent as fully null, not a half-filled record', () => {
    expect(getDeepSeekWebStatus()).toEqual({ running: false, port: null, url: null, authority: null });
  });

  it('stopping when nothing runs resolves rather than throwing', async () => {
    await expect(stopDeepSeekWeb()).resolves.toBeUndefined();
    expect(getDeepSeekWebStatus().running).toBe(false);
  });
});
