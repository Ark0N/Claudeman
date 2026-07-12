/**
 * @fileoverview Tests for the HEIC → JPEG conversion core (heic-jpeg-worker.ts).
 *
 * Exercises the REAL heic-decode WASM parse path (no mocks) for the
 * decompression-bomb guard: a crafted <300-byte HEIC can declare arbitrary
 * dimensions in its `ispe` box, and heic-decode's plain decode path allocates
 * `width * height * 4` bytes straight from those header values (30000×30000 →
 * a 3.6GB allocation). The guard must reject via the allocation-free `.all`
 * dimension read BEFORE decode().
 *
 * Port: N/A (pure module test, no server).
 */

import { describe, it, expect, vi } from 'vitest';
import { convertHeicBufferToJpeg, MAX_HEIC_DECODE_PIXELS } from '../src/web/heic-jpeg-worker.js';

// ── Minimal ISOBMFF/HEIF builder — just enough boxes (ftyp/meta/hdlr/pitm/
// iloc/iinf/iprp[hvcC+ispe]/mdat) for libheif to parse the image handle and
// report the ispe-declared dimensions. There is no real HEVC bitstream, so
// pixel decode of these files always fails — which is the point: the guard
// must fire before any decode is attempted.

function box(type: string, ...payloads: (Buffer | string)[]): Buffer {
  const payload = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function fullbox(type: string, version: number, flags: number, ...payloads: (Buffer | string)[]): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE((version << 24) | flags, 0);
  return box(type, vf, ...payloads);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** Craft a HEIC container whose header declares `width`×`height`. */
function craftHeic(width: number, height: number): Buffer {
  const ftyp = box('ftyp', 'heic', u32(0), 'mif1heic');
  const hdlr = fullbox('hdlr', 0, 0, u32(0), 'pict', u32(0), u32(0), u32(0), Buffer.from([0]));
  const pitm = fullbox('pitm', 0, 0, u16(1));
  const infe = fullbox('infe', 2, 0, u16(1), u16(0), 'hvc1', Buffer.from([0]));
  const iinf = fullbox('iinf', 0, 0, u16(1), infe);
  const ispe = fullbox('ispe', 0, 0, u32(width), u32(height));
  // Minimal HEVCDecoderConfigurationRecord (23 bytes, zero parameter-set arrays).
  const hvcC = box(
    'hvcC',
    Buffer.from([
      0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d, 0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0x00,
      0x00, 0x03, 0x00,
    ]),
    Buffer.from([0x00])
  );
  const ipco = box('ipco', hvcC, ispe);
  const ipma = fullbox('ipma', 0, 0, u32(1), u16(1), Buffer.from([2]), Buffer.from([0x81, 0x02]));
  const iprp = box('iprp', ipco, ipma);
  // iloc v0: offset_size=4, length_size=4, base_offset_size=0; one extent in mdat.
  const ilocItem = Buffer.concat([u16(1), u16(0), u16(1), u32(0), u32(16)]);
  const iloc = fullbox('iloc', 0, 0, Buffer.from([0x44, 0x00]), u16(1), ilocItem);
  const meta = fullbox('meta', 0, 0, hdlr, pitm, iloc, iinf, iprp);
  const mdat = box('mdat', Buffer.alloc(16));
  return Buffer.concat([ftyp, meta, mdat]);
}

describe('heic-jpeg-core', () => {
  it('rejects a crafted bomb header (30000×30000 declared, 3.6GB decode) before decoding', async () => {
    const bomb = craftHeic(30000, 30000);
    expect(bomb.length).toBeLessThan(1024); // tiny input, huge declared output
    await expect(convertHeicBufferToJpeg(bomb)).rejects.toThrow(/30000x30000 exceed the 64MP decode limit/);
  });

  it('rejects dimensions just over the cap', async () => {
    // 8000×8001 = 64,008,000 px — barely over MAX_HEIC_DECODE_PIXELS (64MP).
    expect(8000 * 8001).toBeGreaterThan(MAX_HEIC_DECODE_PIXELS);
    await expect(convertHeicBufferToJpeg(craftHeic(8000, 8001))).rejects.toThrow(/decode limit/);
  });

  it('lets dimensions under the cap through the guard (failure, if any, comes from pixel decode)', async () => {
    // The crafted file has no real HEVC bitstream, so decode fails — but NOT
    // with the dimension-limit error, proving the guard ran and passed.
    await expect(convertHeicBufferToJpeg(craftHeic(100, 100))).rejects.toThrow(/^(?!.*decode limit).*$/);
  });

  it('rejects non-HEIC bytes', async () => {
    await expect(convertHeicBufferToJpeg(Buffer.from('this is definitely not a HEIC image'))).rejects.toThrow(
      /not a HEIC image/i
    );
  });

  it('encodes decoded RGBA into JPEG bytes with valid magic (heic-decode mocked, real jpeg-js)', async () => {
    const dispose = vi.fn();
    const handle = {
      width: 2,
      height: 2,
      decode: async () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) }),
    };
    vi.doMock('heic-decode', () => {
      const decode = Object.assign(async () => handle.decode(), {
        all: async () => Object.assign([handle], { dispose }),
      });
      return { default: decode };
    });
    try {
      const jpeg = await convertHeicBufferToJpeg(Buffer.from('mock input'));
      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
      expect(jpeg[2]).toBe(0xff);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('heic-decode');
    }
  });
});
