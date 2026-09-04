/**
 * @fileoverview Unit tests for the Docker Compose self-update path.
 *
 * Covers the PURE half of the container environment gate: which release changes
 * can be applied by the container restarting itself, and which must go back to
 * the host. The IO half (`evaluateEnvironmentGate`) shells out to git and docker
 * and is exercised by hand — see docs/docker-self-update.md.
 */

import { describe, it, expect } from 'vitest';
import {
  canSelfUpdateInPlace,
  computeEnvironmentBlockers,
  diffRequiredEnvKeys,
  isAutoRestartPolicy,
  parseEnvKeys,
  type EnvironmentGateInput,
} from '../src/web/self-update.js';

/** A gate input where nothing has changed — each test perturbs one field. */
const CLEAN: EnvironmentGateInput = {
  appliedDockerfileHash: 'aaa',
  targetDockerfileHash: 'aaa',
  appliedComposeHash: 'bbb',
  targetComposeHash: 'bbb',
  missingEnvKeys: [],
  restartPolicy: 'unless-stopped',
};

describe('canSelfUpdateInPlace', () => {
  it('accepts git and docker-compose, rejects npm and unknown', () => {
    expect(canSelfUpdateInPlace('git')).toBe(true);
    expect(canSelfUpdateInPlace('docker-compose')).toBe(true);
    expect(canSelfUpdateInPlace('npm')).toBe(false);
    // A container with no repo mounted: a pull would land in the writable layer.
    expect(canSelfUpdateInPlace('unknown')).toBe(false);
  });
});

describe('parseEnvKeys', () => {
  it('reads set keys and ignores blanks, comments and values', () => {
    expect(parseEnvKeys('A=1\n\nB=two words\n')).toEqual(['A', 'B']);
  });

  it('does NOT treat a commented-out key as set', () => {
    // .env.example documents optional overrides as `# PUID=1000`. Counting those
    // as required would block every update on settings the user should not set.
    expect(parseEnvKeys('# PUID=1000\nCODEMAN_PORT=3000')).toEqual(['CODEMAN_PORT']);
  });

  it('handles `export` prefixes and repeated keys', () => {
    expect(parseEnvKeys('export A=1\nA=2\n')).toEqual(['A']);
  });

  it('ignores lines that are not assignments', () => {
    expect(parseEnvKeys('just a line\n=novalue\n1BAD=x\nOK=y')).toEqual(['OK']);
  });
});

describe('diffRequiredEnvKeys', () => {
  it('reports keys the release added that the user has no value for', () => {
    expect(diffRequiredEnvKeys('A=\nB=\nC=', 'A=1\nC=3')).toEqual(['B']);
  });

  it('ignores keys the user set that the release dropped', () => {
    expect(diffRequiredEnvKeys('A=', 'A=1\nOBSOLETE=2')).toEqual([]);
  });

  it('counts a key the user set to an EMPTY value as present', () => {
    // `GEMINI_API_KEY=` is a deliberate opt-out, not a missing setting.
    expect(diffRequiredEnvKeys('GEMINI_API_KEY=', 'GEMINI_API_KEY=')).toEqual([]);
  });
});

describe('isAutoRestartPolicy', () => {
  it('accepts the policies that relaunch the container after the server exits', () => {
    expect(isAutoRestartPolicy('unless-stopped')).toBe(true);
    expect(isAutoRestartPolicy('always')).toBe(true);
    expect(isAutoRestartPolicy('on-failure')).toBe(true);
  });

  it('rejects "no" and unknown values', () => {
    expect(isAutoRestartPolicy('no')).toBe(false);
    expect(isAutoRestartPolicy('')).toBe(false);
    expect(isAutoRestartPolicy(null)).toBe(false);
  });
});

describe('computeEnvironmentBlockers', () => {
  it('allows a code-only release', () => {
    expect(computeEnvironmentBlockers(CLEAN)).toEqual([]);
  });

  it('blocks a release that changes the Dockerfile', () => {
    const blockers = computeEnvironmentBlockers({ ...CLEAN, targetDockerfileHash: 'zzz' });
    expect(blockers.map((b) => b.kind)).toEqual(['dockerfile-changed']);
  });

  it('blocks a release that changes the compose file', () => {
    const blockers = computeEnvironmentBlockers({ ...CLEAN, targetComposeHash: 'zzz' });
    expect(blockers.map((b) => b.kind)).toEqual(['compose-changed']);
  });

  it('blocks and NAMES missing env keys', () => {
    const blockers = computeEnvironmentBlockers({ ...CLEAN, missingEnvKeys: ['CODEMAN_NEW_THING'] });
    expect(blockers[0].kind).toBe('env-keys-missing');
    expect(blockers[0].details).toEqual(['CODEMAN_NEW_THING']);
  });

  it('blocks when the container would not come back', () => {
    const blockers = computeEnvironmentBlockers({ ...CLEAN, restartPolicy: 'no' });
    expect(blockers.map((b) => b.kind)).toEqual(['no-auto-restart']);
    // The message says which policy, so the fix is obvious from the UI alone.
    expect(blockers[0].message).toContain('"no"');
  });

  it('reports every blocker at once rather than stopping at the first', () => {
    const blockers = computeEnvironmentBlockers({
      ...CLEAN,
      targetDockerfileHash: 'zzz',
      targetComposeHash: 'yyy',
      missingEnvKeys: ['A'],
      restartPolicy: 'no',
    });
    expect(blockers.map((b) => b.kind)).toEqual([
      'dockerfile-changed',
      'compose-changed',
      'env-keys-missing',
      'no-auto-restart',
    ]);
  });

  // ⚠️ Regression guards for the fail-OPEN decisions. An unknown baseline is not
  // evidence of a change, and failing closed there would permanently block every
  // container created before the fingerprint file existed.
  it('does not block when the applied baseline is unknown', () => {
    expect(computeEnvironmentBlockers({ ...CLEAN, appliedDockerfileHash: null, appliedComposeHash: null })).toEqual([]);
  });

  it('does not block when the target files cannot be read', () => {
    expect(computeEnvironmentBlockers({ ...CLEAN, targetDockerfileHash: null, targetComposeHash: null })).toEqual([]);
  });

  it('does not block when the restart policy is unknown', () => {
    // The probe needs the Docker socket, which a user may not have mounted.
    expect(computeEnvironmentBlockers({ ...CLEAN, restartPolicy: null })).toEqual([]);
  });
});
