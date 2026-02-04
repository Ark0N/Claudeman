/**
 * @fileoverview Type safety utilities for exhaustive checking.
 *
 * @module utils/type-safety
 */

/**
 * Assert that a value should never occur at runtime.
 * Used in switch/case default blocks to ensure exhaustive handling.
 *
 * If TypeScript sees a code path where `value` is not `never`,
 * it will report a compile-time error, catching missing cases.
 *
 * @param value - The value that should be of type `never`
 * @param message - Optional custom error message
 * @throws Error if called at runtime (indicates unhandled case)
 *
 * @example
 * type Status = 'active' | 'inactive' | 'pending';
 * function handleStatus(status: Status): void {
 *   switch (status) {
 *     case 'active': // handle active
 *       break;
 *     case 'inactive': // handle inactive
 *       break;
 *     case 'pending': // handle pending
 *       break;
 *     default:
 *       assertNever(status); // Compile error if case is missing
 *   }
 * }
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
