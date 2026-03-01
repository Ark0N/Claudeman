/**
 * @fileoverview Common/shared type definitions
 */

/**
 * Interface for objects that hold resources requiring explicit cleanup.
 * Implementing classes should release timers, watchers, and other resources in dispose().
 */
export interface Disposable {
  /** Release all held resources. Safe to call multiple times. */
  dispose(): void;
  /** Whether this object has been disposed */
  readonly isDisposed: boolean;
}

/**
 * Configuration for buffer accumulator instances.
 * Used for terminal buffers, text output, and other size-limited string storage.
 */
export interface BufferConfig {
  /** Maximum buffer size in bytes before trimming */
  maxSize: number;
  /** Size to trim to when maxSize is exceeded */
  trimSize: number;
  /** Optional callback invoked when buffer is trimmed */
  onTrim?: (trimmedBytes: number) => void;
}

/**
 * Resource types that can be registered for cleanup.
 */
export type CleanupResourceType = 'timer' | 'interval' | 'watcher' | 'listener' | 'stream';

/**
 * Registration entry for a cleanup resource.
 * Used by CleanupManager to track and dispose resources.
 */
export interface CleanupRegistration {
  /** Unique identifier for this registration */
  id: string;
  /** Type of resource */
  type: CleanupResourceType;
  /** Human-readable description for debugging */
  description: string;
  /** Cleanup function to call on dispose */
  cleanup: () => void;
  /** Timestamp when registered */
  registeredAt: number;
}
