import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickRunSchema, ScheduledRunSchema } from '../src/web/schemas.js';

describe('working directory schemas', () => {
  const unicodeWorkingDir = '/mnt/d/AI/中文项目';

  it('accepts Unicode paths for session creation and run requests', () => {
    expect(CreateSessionSchema.safeParse({ workingDir: unicodeWorkingDir, mode: 'codex' }).success).toBe(true);
    expect(QuickRunSchema.safeParse({ workingDir: unicodeWorkingDir, prompt: 'test' }).success).toBe(true);
    expect(
      ScheduledRunSchema.safeParse({ workingDir: unicodeWorkingDir, prompt: 'test', durationMinutes: 10 }).success
    ).toBe(true);
  });

  it('continues to reject shell metacharacters in Unicode paths', () => {
    const unsafeWorkingDir = `${unicodeWorkingDir};rm -rf /`;

    expect(CreateSessionSchema.safeParse({ workingDir: unsafeWorkingDir, mode: 'codex' }).success).toBe(false);
    expect(QuickRunSchema.safeParse({ workingDir: unsafeWorkingDir, prompt: 'test' }).success).toBe(false);
    expect(
      ScheduledRunSchema.safeParse({ workingDir: unsafeWorkingDir, prompt: 'test', durationMinutes: 10 }).success
    ).toBe(false);
  });
});
