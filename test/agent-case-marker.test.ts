/**
 * @fileoverview The agent-case marker: the label that tells a scratch worker workspace
 * apart from the user's real projects.
 *
 * The rules under test are the ones that keep a cleanup affordance safe: reading is
 * total (anything that is not a well-formed version-1 marker reads as "not
 * agent-created", never as a half-trusted entry), the origin token is allowlisted
 * rather than escaped at each use, and writing never throws — a failed marker must not
 * fail the worker spawn it decorates.
 *
 * Port: N/A (pure + a temp dir).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_CASE_MARKER_FILE,
  AGENT_ORIGIN_CODEMAN_SKILL,
  AGENT_ORIGIN_SPAWNED_BY_SESSION,
  buildAgentCaseMarker,
  normalizeAgentOrigin,
  parseAgentCaseMarker,
  readAgentCaseMarker,
  writeAgentCaseMarker,
} from '../src/agent-case-marker.js';

describe('normalizeAgentOrigin', () => {
  it('accepts a short lowercase token', () => {
    expect(normalizeAgentOrigin('codeman-skill')).toBe('codeman-skill');
    expect(normalizeAgentOrigin('  Codeman-Skill  ')).toBe('codeman-skill');
    expect(normalizeAgentOrigin('agent.v2_1')).toBe('agent.v2_1');
  });

  it('drops anything that is not one', () => {
    // The value reaches a JSON file and the case-manage UI, so it is allowlisted at
    // the boundary instead of escaped at every use site.
    expect(normalizeAgentOrigin('<script>')).toBeUndefined();
    expect(normalizeAgentOrigin('has space')).toBeUndefined();
    expect(normalizeAgentOrigin('-leading-dash')).toBeUndefined();
    expect(normalizeAgentOrigin('x'.repeat(33))).toBeUndefined();
    expect(normalizeAgentOrigin('')).toBeUndefined();
    expect(normalizeAgentOrigin(undefined)).toBeUndefined();
    expect(normalizeAgentOrigin(42)).toBeUndefined();
  });
});

describe('buildAgentCaseMarker', () => {
  it('keeps only the fields that were supplied', () => {
    const marker = buildAgentCaseMarker({ createdBy: AGENT_ORIGIN_CODEMAN_SKILL });
    expect(marker.version).toBe(1);
    expect(marker.createdBy).toBe(AGENT_ORIGIN_CODEMAN_SKILL);
    expect(Date.parse(marker.createdAt)).not.toBeNaN();
    expect('parentSessionId' in marker).toBe(false);
    expect('mode' in marker).toBe(false);
  });

  it('falls back to the spawned-by-session origin rather than storing junk', () => {
    expect(buildAgentCaseMarker({ createdBy: 'not a token' }).createdBy).toBe(AGENT_ORIGIN_SPAWNED_BY_SESSION);
  });
});

describe('parseAgentCaseMarker', () => {
  const valid = JSON.stringify({
    version: 1,
    createdAt: '2026-09-07T10:00:00.000Z',
    createdBy: 'codeman-skill',
    parentSessionId: 'sess-1',
    parentSessionName: 'w1-claudeman',
    mode: 'claude',
    note: 'ignored',
  });

  it('round-trips a well-formed marker and drops unknown fields', () => {
    const marker = parseAgentCaseMarker(valid);
    expect(marker).toEqual({
      version: 1,
      createdAt: '2026-09-07T10:00:00.000Z',
      createdBy: 'codeman-skill',
      parentSessionId: 'sess-1',
      parentSessionName: 'w1-claudeman',
      mode: 'claude',
    });
  });

  it('reads anything malformed as absent', () => {
    // Each of these must mean "not an agent case", because the answer drives a
    // recursive-delete affordance in the UI.
    expect(parseAgentCaseMarker('not json')).toBeNull();
    expect(parseAgentCaseMarker('[]')).toBeNull();
    expect(parseAgentCaseMarker('null')).toBeNull();
    expect(parseAgentCaseMarker(JSON.stringify({ version: 2, createdAt: '2026-09-07', createdBy: 'x' }))).toBeNull();
    expect(parseAgentCaseMarker(JSON.stringify({ version: 1, createdBy: 'x' }))).toBeNull();
    expect(parseAgentCaseMarker(JSON.stringify({ version: 1, createdAt: 'whenever', createdBy: 'x' }))).toBeNull();
    expect(
      parseAgentCaseMarker(JSON.stringify({ version: 1, createdAt: '2026-09-07T10:00:00Z', createdBy: 'bad token' }))
    ).toBeNull();
  });
});

describe('writeAgentCaseMarker / readAgentCaseMarker', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await mkdtemp(join(tmpdir(), 'codeman-agent-case-'));
  });

  afterEach(async () => {
    await rm(caseDir, { recursive: true, force: true });
  });

  it('round-trips through the case directory', async () => {
    const marker = buildAgentCaseMarker({
      createdBy: AGENT_ORIGIN_CODEMAN_SKILL,
      parentSessionId: 'sess-1',
      mode: 'claude',
    });
    expect(await writeAgentCaseMarker(caseDir, marker)).toBe(true);
    expect(await readAgentCaseMarker(caseDir)).toEqual(marker);
  });

  it('writes a note explaining the file to whoever finds it', async () => {
    await writeAgentCaseMarker(caseDir, buildAgentCaseMarker({ createdBy: AGENT_ORIGIN_CODEMAN_SKILL }));
    const raw = JSON.parse(await readFile(join(caseDir, AGENT_CASE_MARKER_FILE), 'utf-8'));
    expect(raw.note).toContain('Delete this file');
  });

  it('reports failure instead of throwing when the directory is missing', async () => {
    // Best-effort by design: a marker that cannot be written must not fail the spawn.
    const written = await writeAgentCaseMarker(join(caseDir, 'nope'), buildAgentCaseMarker({ createdBy: 'x-agent' }));
    expect(written).toBe(false);
  });

  it('reads an absent or corrupt marker as not-agent-created', async () => {
    expect(await readAgentCaseMarker(caseDir)).toBeNull();
    await writeFile(join(caseDir, AGENT_CASE_MARKER_FILE), '{ truncated', 'utf-8');
    expect(await readAgentCaseMarker(caseDir)).toBeNull();
  });
});
