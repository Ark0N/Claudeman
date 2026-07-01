declare module 'heic-convert' {
  export interface ConvertOptions {
    buffer: Buffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }

  export default function convert(options: ConvertOptions): Promise<Buffer | Uint8Array | ArrayBuffer>;
}
