/**
 * @fileoverview Main-thread wrapper for HEIC/HEIF → JPEG conversion.
 *
 * The actual decode/encode (`heic-jpeg-worker.ts`) is CPU-synchronous WASM + JS,
 * so it runs in a dedicated `worker_threads` Worker per conversion — never on
 * the event loop that serves every session's SSE/PTY/WS traffic. On top of
 * the worker isolation this wrapper enforces:
 *  - the global converter concurrency cap (`runWithConversionLimit`, shared
 *    with the pdftoppm/soffice document converters) so N simultaneous uploads
 *    can't pin N cores / N × 256MB decode buffers at once;
 *  - a hard timeout that terminates the worker (a wedged WASM decode can't be
 *    cancelled cooperatively);
 *  - the paste-image size cap on the *output* — jpeg-js is a far less
 *    efficient encoder than HEVC, so a within-limit HEIC can inflate past
 *    MAX_PASTE_IMAGE_BYTES.
 */

import { Worker } from 'node:worker_threads';
import { runWithConversionLimit } from '../document-conversion-limiter.js';
import { MAX_PASTE_IMAGE_BYTES } from '../config/buffer-limits.js';
import { HEIC_JPEG_QUALITY, type HeicWorkerInput, type HeicWorkerResult } from './heic-jpeg-worker.js';

/** Hard cap on a single conversion; the worker is terminated when it fires. */
export const HEIC_CONVERSION_TIMEOUT_MS = 30_000;

// V8-heap guardrails for the conversion worker — defense in depth only: large
// TypedArray/WASM backing stores are external to the V8 heap, so the real
// memory bound is the 64MP dimension pre-check in heic-jpeg-worker.ts.
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 128, stackSizeMb: 8 };

function workerUrl(): URL {
  // Compiled installs run the tsc-emitted .js sibling in dist/; dev under tsx
  // runs the .ts source directly (tsx's loader propagates to worker threads).
  const file = import.meta.url.endsWith('.ts') ? './heic-jpeg-worker.ts' : './heic-jpeg-worker.js';
  return new URL(file, import.meta.url);
}

/**
 * Convert HEIC/HEIF bytes to JPEG bytes off-thread. Rejects on invalid input,
 * over-limit dimensions, oversized output, timeout, or worker failure.
 */
export async function convertHeicToJpeg(imageBytes: Buffer): Promise<Buffer> {
  return runWithConversionLimit(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const worker = new Worker(workerUrl(), {
          workerData: { heicInput: imageBytes, quality: HEIC_JPEG_QUALITY } satisfies HeicWorkerInput,
          resourceLimits: WORKER_RESOURCE_LIMITS,
        });
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
          void worker.terminate();
        };
        const timer = setTimeout(() => {
          settle(() => reject(new Error(`HEIC conversion timed out after ${HEIC_CONVERSION_TIMEOUT_MS}ms`)));
        }, HEIC_CONVERSION_TIMEOUT_MS);
        worker.on('message', (msg: HeicWorkerResult) => {
          settle(() => {
            if (!msg.ok) {
              reject(new Error(msg.error));
              return;
            }
            const out = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
            if (out.length > MAX_PASTE_IMAGE_BYTES) {
              const maxMb = Math.round(MAX_PASTE_IMAGE_BYTES / (1024 * 1024));
              reject(new Error(`converted JPEG (${out.length} bytes) exceeds the ${maxMb}MB upload limit`));
              return;
            }
            resolve(out);
          });
        });
        worker.on('error', (err) => settle(() => reject(err)));
        worker.on('exit', (code) => {
          settle(() => reject(new Error(`HEIC conversion worker exited unexpectedly (code ${code})`)));
        });
      })
  );
}
