// Minimal GIF89a encoder — global colour table (≤256), LZW image data,
// NETSCAPE looping extension, one image descriptor per frame, no
// transparency. Zero deps; used for kit/preview.gif.
export interface GifSpec {
  w: number;
  h: number;
  /// RGB triples, 2–256 entries
  palette: [number, number, number][];
  /// each frame: w*h palette indices, row-major
  frames: Uint8Array[];
  /// hundredths of a second per frame
  delayCs: number;
}

/// GIF LZW compression of palette indices → packed code bytes (the caller
/// chunks them into ≤255-byte sub-blocks).
function lzwEncode(minCodeSize: number, indices: Uint8Array): Buffer {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let dict = new Map<string, number>();
  let next = eoi + 1;
  let codeSize = minCodeSize + 1;
  const out: number[] = [];
  let cur = 0;
  let curBits = 0;
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };
  const reset = () => {
    dict = new Map();
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  reset();
  emit(clear);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = String(indices[i]);
    const pk = prefix + ',' + k;
    if (dict.has(pk)) {
      prefix = pk;
      continue;
    }
    emit(Number(prefix.split(',').length > 1 ? dict.get(prefix)! : prefix));
    dict.set(pk, next++);
    // grow before the next free code would exceed what codeSize bits hold
    if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
    if (next > 4095) {
      emit(clear);
      reset();
    }
    prefix = k;
  }
  emit(Number(prefix.split(',').length > 1 ? dict.get(prefix)! : prefix));
  emit(eoi);
  if (curBits > 0) out.push(cur & 0xff);
  return Buffer.from(out);
}

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];

export function encodeGif(spec: GifSpec): Buffer {
  const { w, h, frames, delayCs } = spec;
  const paletteSize = Math.max(2, 1 << Math.ceil(Math.log2(Math.max(2, spec.palette.length))));
  const gctBits = Math.log2(paletteSize) - 1; // LSD field = log2(N)-1
  const minCodeSize = Math.max(2, Math.ceil(Math.log2(spec.palette.length)));
  const bytes: number[] = [
    // header
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // 'GIF89a'
    ...u16(w), ...u16(h),
    0xf0 | gctBits, // GCT present, 8-bit colour resolution, GCT size
    0, // background colour index
    0, // pixel aspect ratio
  ];
  for (let i = 0; i < paletteSize; i++) {
    const c = spec.palette[i] ?? [0, 0, 0];
    bytes.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff);
  }
  // NETSCAPE2.0 looping extension (0 = loop forever)
  bytes.push(
    0x21, 0xff, 0x0b,
    ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)),
    0x03, 0x01, ...u16(0), 0x00,
  );
  for (const frame of frames) {
    // graphics control extension — delay, no transparency, no disposal
    bytes.push(0x21, 0xf9, 0x04, 0x04, ...u16(delayCs), 0x00, 0x00);
    // image descriptor — full frame at origin, no local palette
    bytes.push(0x2c, ...u16(0), ...u16(0), ...u16(w), ...u16(h), 0x00);
    // image data: LZW min code size + ≤255-byte sub-blocks + terminator
    bytes.push(minCodeSize);
    const data = lzwEncode(minCodeSize, frame);
    for (let off = 0; off < data.length; off += 255) {
      const chunk = data.subarray(off, off + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3b); // trailer
  return Buffer.from(bytes);
}

/// Collect up to `max` unique colours across RGBA frames into a GIF palette
/// (prepending `first`), snapping to a coarser grid when uniques overflow.
export function buildPalette(
  frames: { data: Uint8ClampedArray }[],
  first: [number, number, number][],
  max = 256,
): { palette: [number, number, number][]; indexOf: Map<number, number>; step: number } {
  const snap = (step: number): Map<number, number> => {
    const map = new Map<number, number>();
    const key = (r: number, g: number, b: number) =>
      ((r / step) | 0) << 10 | ((g / step) | 0) << 5 | ((b / step) | 0);
    for (const c of first) map.set(key(c[0], c[1], c[2]), map.size);
    for (const f of frames) {
      for (let i = 0; i < f.data.length; i += 4) {
        if (f.data[i + 3] < 128) continue;
        const k = key(f.data[i], f.data[i + 1], f.data[i + 2]);
        if (!map.has(k) && map.size < max) map.set(k, map.size);
      }
      if (map.size >= max) break;
    }
    return map;
  };
  let indexOf = snap(1);
  let step = 1;
  while (indexOf.size > max && step < 64) {
    step *= 2;
    indexOf = snap(step);
  }
  const palette: [number, number, number][] = [];
  for (const [k, idx] of indexOf) {
    const mid = step >> 1;
    palette[idx] = [Math.min(255, ((k >> 10) & 31) * step + mid), Math.min(255, ((k >> 5) & 31) * step + mid), Math.min(255, (k & 31) * step + mid)];
  }
  return { palette, indexOf, step };
}
