// Server-side PNG codec + pixel buffer + tiny 5x7 bitmap font, used by the
// kit builder for covers/thumbnails. encodePng is the same filter-0 RGBA
// encoder embedded in lib/pix.mjs; decodePng only reads files our own
// encoder produced (8-bit RGBA, one filter-0 scanline each) — that's all
// the factory ever writes.
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array | Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/// Decode a PNG our own encodePng wrote (RGBA8, filter 0). Throws on
/// anything else — callers fall back to a plain cover then.
export function decodePng(png: Buffer): { w: number; h: number; data: Uint8ClampedArray } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8;
  let w = 0, h = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('unsupported png format');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4 + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * stride] !== 0) throw new Error('unsupported png filter');
    out.set(raw.subarray(y * stride + 1, y * stride + stride), y * w * 4);
  }
  return { w, h, data: out };
}

// ---- pixel buffer --------------------------------------------------------

export type RGBA = [number, number, number, number];

export class Pix {
  readonly data: Uint8ClampedArray;
  constructor(readonly w: number, readonly h: number, bg?: RGBA) {
    this.data = new Uint8ClampedArray(w * h * 4);
    if (bg) this.rect(0, 0, w, h, bg);
  }
  px(x: number, y: number, c: RGBA): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3];
  }
  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.px(xx, yy, c);
  }
  /// nearest-neighbour blit of src at integer scale k, top-left at (x,y)
  blit(src: { w: number; h: number; data: Uint8ClampedArray }, x: number, y: number, k: number): void {
    for (let sy = 0; sy < src.h; sy++) {
      for (let sx = 0; sx < src.w; sx++) {
        const si = (sy * src.w + sx) * 4;
        const a = src.data[si + 3];
        if (!a) continue;
        this.rect(x + sx * k, y + sy * k, k, k, [src.data[si], src.data[si + 1], src.data[si + 2], a]);
      }
    }
  }
  text(x: number, y: number, str: string, scale: number, c: RGBA): void {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch] ?? FONT[' '];
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (g[gy] & (1 << (4 - gx))) this.rect(cx + gx * scale, y + gy * scale, scale, scale, c);
        }
      }
      cx += 6 * scale;
    }
  }
  textWidth(str: string, scale: number): number {
    return str.length * 6 * scale;
  }
  png(): Buffer {
    return encodePng(this.w, this.h, this.data);
  }
}

// ---- 5x7 bitmap font (rows = 5-bit values, msb = left pixel) --------------

const G = (rows: number[]) => rows;
const FONT: Record<string, number[]> = {
  ' ': G([0, 0, 0, 0, 0, 0, 0]),
  A: G([0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001]),
  B: G([0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110]),
  C: G([0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111]),
  D: G([0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100]),
  E: G([0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111]),
  F: G([0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000]),
  G: G([0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110]),
  H: G([0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001]),
  I: G([0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111]),
  J: G([0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100]),
  K: G([0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001]),
  L: G([0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111]),
  M: G([0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001]),
  N: G([0b10001, 0b11001, 0b11001, 0b10101, 0b10011, 0b10011, 0b10001]),
  O: G([0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110]),
  P: G([0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000]),
  Q: G([0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101]),
  R: G([0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001]),
  S: G([0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110]),
  T: G([0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100]),
  U: G([0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110]),
  V: G([0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100]),
  W: G([0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001]),
  X: G([0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001]),
  Y: G([0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100]),
  Z: G([0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111]),
  '0': G([0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110]),
  '1': G([0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110]),
  '2': G([0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111]),
  '3': G([0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110]),
  '4': G([0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010]),
  '5': G([0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110]),
  '6': G([0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110]),
  '7': G([0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000]),
  '8': G([0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110]),
  '9': G([0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110]),
  '-': G([0, 0, 0, 0b11111, 0, 0, 0]),
  '.': G([0, 0, 0, 0, 0, 0b01100, 0b01100]),
  '!': G([0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100]),
  ':': G([0, 0b00100, 0, 0, 0b00100, 0, 0]),
  '/': G([0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000]),
  '(': G([0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010]),
  ')': G([0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000]),
  '+': G([0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0]),
  '_': G([0, 0, 0, 0, 0, 0, 0b11111]),
  "'": G([0b00100, 0b00100, 0, 0, 0, 0, 0]),
  '×': G([0, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0]),
};
