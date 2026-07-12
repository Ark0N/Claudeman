/**
 * @fileoverview HEIC/HEIF → JPEG conversion core + worker-thread entry.
 *
 * Spawned per conversion by `heic-jpeg-converter.ts` so the CPU-synchronous
 * libheif WASM decode + jpeg-js encode never run on the server's main thread
 * (on the event loop they would freeze every session's SSE/PTY/WS handling
 * for seconds per photo). Input arrives via `workerData`; the result (or
 * error message) is posted back as a single message and the thread exits.
 *
 * The conversion logic lives in this same file (exported, guarded bootstrap)
 * rather than a sibling module: the worker runs from `.ts` source under tsx
 * in dev, where relative `.js` imports don't resolve inside worker threads —
 * only `node:` builtins are imported at top level. Unit tests import
 * `convertHeicBufferToJpeg` directly; the bootstrap only runs when spawned
 * with our `workerData` shape.
 *
 * Decompression-bomb guard: heic-decode's `.all` path exposes the
 * header-declared {width, height} per image WITHOUT decoding pixels, while
 * its plain decode path allocates `width * height * 4` bytes straight from
 * those header values — a <1KB crafted file declaring 30000×30000 would
 * demand a 3.6GB allocation. We reject anything above MAX_HEIC_DECODE_PIXELS
 * before calling `decode()`.
 */

import { parentPort, workerData } from 'node:worker_threads';

/** Max header-declared pixel count we will decode (64MP ≈ 256MB RGBA). */
export const MAX_HEIC_DECODE_PIXELS = 64_000_000;

/** JPEG quality used for converted HEIC uploads (matches heic-convert's default). */
export const HEIC_JPEG_QUALITY = 0.92;

export interface HeicWorkerInput {
  heicInput: Uint8Array;
  quality: number;
}

export type HeicWorkerResult = { ok: true; data: Uint8Array } | { ok: false; error: string };

/**
 * Convert HEIC/HEIF bytes to JPEG bytes. Throws on non-HEIC input, empty
 * containers, over-limit dimensions, and non-JPEG encoder output.
 */
export async function convertHeicBufferToJpeg(input: Uint8Array, quality: number = HEIC_JPEG_QUALITY): Promise<Buffer> {
  const { default: decode } = await import('heic-decode');
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const images = await decode.all({ buffer });
  try {
    if (images.length === 0) throw new Error('no image found in HEIC container');
    const { width, height } = images[0];
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > MAX_HEIC_DECODE_PIXELS
    ) {
      throw new Error(
        `HEIC dimensions ${width}x${height} exceed the ${Math.floor(MAX_HEIC_DECODE_PIXELS / 1_000_000)}MP decode limit`
      );
    }
    const decoded = await images[0].decode();
    const { encode } = await import('jpeg-js');
    // Same output path as heic-convert's JPEG format (jpeg-js at quality*100).
    const jpeg = encode(
      { data: decoded.data, width: decoded.width, height: decoded.height },
      Math.floor(quality * 100)
    ).data;
    const jpegBytes = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg);
    if (jpegBytes.length < 3 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8 || jpegBytes[2] !== 0xff) {
      throw new Error('HEIC conversion did not produce JPEG bytes');
    }
    return jpegBytes;
  } finally {
    images.dispose();
  }
}

// ── Worker bootstrap ──────────────────────────────────────────────────────
// Runs only when spawned by heic-jpeg-converter.ts: requires a parent port
// AND our exact workerData shape, so importing this module from the main
// thread (or a test runner's own worker pool) stays inert.
const request = workerData as HeicWorkerInput | null | undefined;
if (parentPort && request && request.heicInput instanceof Uint8Array && typeof request.quality === 'number') {
  const port = parentPort;
  try {
    const jpegBytes = await convertHeicBufferToJpeg(request.heicInput, request.quality);
    port.postMessage({ ok: true, data: jpegBytes } satisfies HeicWorkerResult);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    port.postMessage({ ok: false, error } satisfies HeicWorkerResult);
  }
}
