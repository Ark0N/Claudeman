import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptWatcher, TranscriptState } from '../src/transcript-watcher.js';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TranscriptWatcher', () => {
  let watcher: TranscriptWatcher;
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    watcher = new TranscriptWatcher();
    testDir = join(tmpdir(), `transcript-test-${Date.now()}`);
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testFile = join(testDir, 'test-transcript.jsonl');
  });

  afterEach(() => {
    watcher.stop();
    // Clean up test file
    try {
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should start in stopped state', () => {
      expect(watcher.isRunning()).toBe(false);
    });

    it('should have initial state with defaults', () => {
      const state = watcher.getState();
      expect(state.isComplete).toBe(false);
      expect(state.toolExecuting).toBe(false);
      expect(state.currentTool).toBeNull();
      expect(state.hasError).toBe(false);
      expect(state.planModeDetected).toBe(false);
      expect(state.entryCount).toBe(0);
    });
  });

  describe('File Watching', () => {
    it('should start watching an existing file', () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);
      expect(watcher.isRunning()).toBe(true);
    });

    it('should handle non-existent file by polling', () => {
      const nonExistent = join(testDir, 'nonexistent.jsonl');
      watcher.start(nonExistent);
      expect(watcher.isRunning()).toBe(true);
    });

    it('should stop watching on stop()', () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);
      expect(watcher.isRunning()).toBe(true);
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should update path with updatePath()', () => {
      const file1 = join(testDir, 'file1.jsonl');
      const file2 = join(testDir, 'file2.jsonl');
      writeFileSync(file1, '');
      writeFileSync(file2, '');

      watcher.start(file1);
      expect(watcher.isRunning()).toBe(true);

      watcher.updatePath(file2);
      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe('Entry Processing', () => {
    it('should process user entry and reset state', async () => {
      // Start with some state
      writeFileSync(testFile, '');
      watcher.start(testFile);

      // Add user entry
      const userEntry = { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'test' } };
      appendFileSync(testFile, JSON.stringify(userEntry) + '\n');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      const state = watcher.getState();
      expect(state.entryCount).toBeGreaterThanOrEqual(1);
    });

    it('should emit transcript:complete on result entry', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      const completeHandler = vi.fn();
      watcher.on('transcript:complete', completeHandler);

      // Add result entry
      const resultEntry = { type: 'result', timestamp: new Date().toISOString() };
      appendFileSync(testFile, JSON.stringify(resultEntry) + '\n');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(completeHandler).toHaveBeenCalled();
      const state = watcher.getState();
      expect(state.isComplete).toBe(true);
    });

    it('should track tool execution', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      const toolStartHandler = vi.fn();
      watcher.on('transcript:tool_start', toolStartHandler);

      // Add assistant entry with tool_use
      const assistantEntry = {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/test.txt' } }
          ]
        }
      };
      appendFileSync(testFile, JSON.stringify(assistantEntry) + '\n');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(toolStartHandler).toHaveBeenCalledWith('Read');
      const state = watcher.getState();
      expect(state.toolExecuting).toBe(true);
      expect(state.currentTool).toBe('Read');
    });

    it('should detect plan mode from AskUserQuestion tool', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      const planModeHandler = vi.fn();
      watcher.on('transcript:plan_mode', planModeHandler);

      // Add assistant entry with AskUserQuestion
      const assistantEntry = {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'AskUserQuestion', input: { question: 'test?' } }
          ]
        }
      };
      appendFileSync(testFile, JSON.stringify(assistantEntry) + '\n');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(planModeHandler).toHaveBeenCalled();
      const state = watcher.getState();
      expect(state.planModeDetected).toBe(true);
    });

    it('should detect errors in result entry', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      // Add result entry with error
      const resultEntry = {
        type: 'result',
        timestamp: new Date().toISOString(),
        error: { type: 'api_error', message: 'Rate limited' }
      };
      appendFileSync(testFile, JSON.stringify(resultEntry) + '\n');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      const state = watcher.getState();
      expect(state.hasError).toBe(true);
      expect(state.errorMessage).toContain('Rate limited');
    });
  });

  describe('State Management', () => {
    it('should return a copy of state', () => {
      const state1 = watcher.getState();
      const state2 = watcher.getState();
      expect(state1).not.toBe(state2); // Different objects
      expect(state1).toEqual(state2); // Same content
    });

    it('should reset state on stop()', () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);
      watcher.stop();
      const state = watcher.getState();
      expect(state.entryCount).toBe(0);
    });
  });
});
