/**
 * @fileoverview Tests for types module utility functions
 *
 * Tests the helper functions for creating response objects
 * and initial state structures.
 */

import { describe, it, expect } from 'vitest';
import {
  createErrorResponse,
  createSuccessResponse,
  createInitialInnerLoopState,
  createInitialInnerSessionState,
  createInitialState,
  ErrorMessages,
} from '../src/types.js';

describe('types utility functions', () => {
  describe('createErrorResponse', () => {
    it('should create error response with code only', () => {
      const response = createErrorResponse('NOT_FOUND');

      expect(response.success).toBe(false);
      expect(response.errorCode).toBe('NOT_FOUND');
      expect(response.error).toBe(ErrorMessages.NOT_FOUND);
    });

    it('should create error response with custom details', () => {
      const response = createErrorResponse('INVALID_INPUT', 'Missing required field: name');

      expect(response.success).toBe(false);
      expect(response.errorCode).toBe('INVALID_INPUT');
      expect(response.error).toBe('Missing required field: name');
    });

    it('should handle all error codes', () => {
      const codes = [
        'NOT_FOUND',
        'INVALID_INPUT',
        'SESSION_BUSY',
        'OPERATION_FAILED',
        'ALREADY_EXISTS',
        'INTERNAL_ERROR',
      ] as const;

      for (const code of codes) {
        const response = createErrorResponse(code);
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(code);
        expect(response.error).toBeDefined();
      }
    });
  });

  describe('createSuccessResponse', () => {
    it('should create success response without data', () => {
      const response = createSuccessResponse();

      expect(response.success).toBe(true);
      expect(response.data).toBeUndefined();
    });

    it('should create success response with data', () => {
      const data = { id: '123', name: 'test' };
      const response = createSuccessResponse(data);

      expect(response.success).toBe(true);
      expect(response.data).toEqual(data);
    });
  });

  describe('createInitialInnerLoopState', () => {
    it('should create initial inner loop state', () => {
      const state = createInitialInnerLoopState();

      expect(state.enabled).toBe(false);
      expect(state.active).toBe(false);
      expect(state.cycleCount).toBe(0);
      expect(state.maxIterations).toBeNull();
      expect(state.completionPhrase).toBeNull();
      expect(state.startedAt).toBeNull();
      expect(state.lastActivity).toBeLessThanOrEqual(Date.now());
      expect(state.elapsedHours).toBeNull();
    });
  });

  describe('createInitialInnerSessionState', () => {
    it('should create initial inner session state with session ID', () => {
      const state = createInitialInnerSessionState('session-123');

      expect(state.sessionId).toBe('session-123');
      expect(state.loop).toBeDefined();
      expect(state.loop.enabled).toBe(false);
      expect(state.loop.active).toBe(false);
      expect(state.todos).toEqual([]);
      expect(state.lastUpdated).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('createInitialState', () => {
    it('should create initial app state', () => {
      const state = createInitialState();

      expect(state.sessions).toEqual({});
      expect(state.tasks).toEqual({});
      expect(state.ralphLoop).toBeDefined();
      expect(state.ralphLoop.status).toBe('stopped');
      expect(state.config).toBeDefined();
      expect(state.config.maxConcurrentSessions).toBeGreaterThan(0);
      expect(state.config.pollIntervalMs).toBeGreaterThan(0);
    });

    it('should create state with config from DEFAULT_CONFIG', () => {
      const state = createInitialState();

      // Check that config has required fields
      expect(state.config.maxConcurrentSessions).toBeDefined();
      expect(state.config.pollIntervalMs).toBeDefined();
    });

    it('should have Ralph Loop in stopped state', () => {
      const state = createInitialState();

      expect(state.ralphLoop.status).toBe('stopped');
      expect(state.ralphLoop.startedAt).toBeNull();
      expect(state.ralphLoop.minDurationMs).toBeNull();
      expect(state.ralphLoop.tasksCompleted).toBe(0);
      expect(state.ralphLoop.tasksGenerated).toBe(0);
    });
  });
});
