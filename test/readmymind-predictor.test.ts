/**
 * @fileoverview Read My Mind predictor output-contract tests
 * (src/readmymind-predictor.ts).
 *
 * Pure `parsePredictionOutput` tests only: the spawn/poll runner is exercised
 * through the stubbed singleton in the route tests, never by really spawning
 * tmux under vitest.
 */
import { describe, it, expect } from 'vitest';
import { parsePredictionOutput } from '../src/readmymind-predictor.js';

const VALID = JSON.stringify({
  suggestions: [
    { prompt: 'run the tests', why: 'the assistant just finished a fix', kind: 'verify' },
    { prompt: 'COM', why: 'changesets are pending', kind: 'continue' },
  ],
});

describe('parsePredictionOutput', () => {
  it('parses the strict contract', () => {
    const suggestions = parsePredictionOutput(VALID);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toEqual({
      prompt: 'run the tests',
      why: 'the assistant just finished a fix',
      kind: 'verify',
    });
  });

  it('tolerates fenced or prosed wrapping around the JSON object', () => {
    expect(parsePredictionOutput('```json\n' + VALID + '\n```')).toHaveLength(2);
    expect(parsePredictionOutput('Here you go:\n' + VALID)).toHaveLength(2);
  });

  it('throws cleanly on garbage', () => {
    expect(() => parsePredictionOutput('no json here at all')).toThrow(/no JSON object/);
    expect(() => parsePredictionOutput('{ "definitely": not json }')).toThrow(/malformed JSON/);
  });

  it('throws on a shape mismatch, never a half-suggestion', () => {
    expect(() => parsePredictionOutput('{"suggestions": []}')).toThrow(/contract/);
    expect(() => parsePredictionOutput('{"ideas": ["x"]}')).toThrow(/contract/);
    expect(() => parsePredictionOutput(JSON.stringify({ suggestions: [{ prompt: 'x', kind: 'guess' }] }))).toThrow(
      /contract/
    );
    const four = { suggestions: Array(4).fill({ prompt: 'x', kind: 'continue' }) };
    expect(() => parsePredictionOutput(JSON.stringify(four))).toThrow(/contract/);
  });

  it('collapses embedded newlines to single-line prompts (multi-line breaks Ink)', () => {
    const out = parsePredictionOutput(
      JSON.stringify({ suggestions: [{ prompt: 'fix the bug\nthen run tests', kind: 'continue' }] })
    );
    expect(out[0].prompt).toBe('fix the bug then run tests');
  });

  it('defaults a missing why and drops empty prompts', () => {
    const out = parsePredictionOutput(JSON.stringify({ suggestions: [{ prompt: 'ok', kind: 'continue' }] }));
    expect(out[0].why).toBe('');

    expect(() =>
      parsePredictionOutput(JSON.stringify({ suggestions: [{ prompt: '  \n ', kind: 'continue' }] }))
    ).toThrow(/empty/);
  });

  it('bounds runaway fields instead of failing them', () => {
    const out = parsePredictionOutput(
      JSON.stringify({ suggestions: [{ prompt: 'p'.repeat(5000), why: 'w'.repeat(5000), kind: 'redirect' }] })
    );
    expect(out[0].prompt.length).toBe(1000);
    expect(out[0].why.length).toBe(300);
  });
});
