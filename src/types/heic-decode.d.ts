declare module 'heic-decode' {
  export interface DecodedHeicImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  /** Handle exposing header-declared dimensions WITHOUT decoding pixels. */
  export interface HeicImageHandle {
    width: number;
    height: number;
    decode(): Promise<DecodedHeicImage>;
  }

  export type HeicImageHandles = HeicImageHandle[] & { dispose(): void };

  interface HeicDecode {
    (input: { buffer: Buffer | Uint8Array }): Promise<DecodedHeicImage>;
    all(input: { buffer: Buffer | Uint8Array }): Promise<HeicImageHandles>;
  }

  const decode: HeicDecode;
  export default decode;
}
