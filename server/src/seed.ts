// Seeds ~/.alien-factory/factory with the pixel lib, style guide, three
// EXAMPLE assets (style references, not catalog items) and a reports dir.
// Idempotent: only missing files are written, and an example's gen.mjs only
// runs when its sheet.png is absent. Starters that were seeded into
// assets/ by the old design are moved to examples/ once.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_DIR } from './config.js';

const PIX_LIB = `// lib/pix.mjs — zero-dep pixel canvas + sprite-sheet PNG emitter.
// Every asset generator imports this and calls emit() at the end.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normColor(c) {
  if (typeof c === 'string') {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) throw new Error('bad colour: ' + c);
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c.length > 3 ? c[3] | 0 : 255];
  throw new Error('bad colour: ' + String(c));
}

export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  px(x, y, color) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const c = normColor(color);
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3];
  }
  get(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
  rect(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.px(x, y, color);
  }
  line(x0, y0, x1, y1, color) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // filled circle
  circle(cx, cy, r, color) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d <= r * r) this.px(x, y, color);
      }
    }
  }
  // paint 'color' into transparent pixels 4-adjacent to opaque ones
  outline(color) {
    const marks = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)[3] !== 0) continue;
        if (this.get(x + 1, y)[3] || this.get(x - 1, y)[3] || this.get(x, y + 1)[3] || this.get(x, y - 1)[3]) {
          marks.push([x, y]);
        }
      }
    }
    for (const [x, y] of marks) this.px(x, y, color);
  }
  clone() {
    const c = new Canvas(this.w, this.h);
    c.data.set(this.data);
    return c;
  }
}

// ---- minimal PNG encoder (RGBA 8-bit, filter 0) ---------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(w, h, rgba) {
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
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sheetRgba(frames) {
  const w = frames[0].w, h = frames[0].h;
  const out = new Uint8ClampedArray(w * frames.length * h * 4);
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const di = (y * w * frames.length + f * w + x) * 4;
        out[di] = fr.data[si]; out[di + 1] = fr.data[si + 1];
        out[di + 2] = fr.data[si + 2]; out[di + 3] = fr.data[si + 3];
      }
    }
  }
  return { w: w * frames.length, h, data: out };
}

function scaleRgba(img, k) {
  const out = new Uint8ClampedArray(img.w * k * img.h * k * 4);
  for (let y = 0; y < img.h * k; y++) {
    for (let x = 0; x < img.w * k; x++) {
      const si = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 4;
      const di = (y * img.w * k + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2]; out[di + 3] = img.data[si + 3];
    }
  }
  return { w: img.w * k, h: img.h * k, data: out };
}

function hex(r, g, b) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/// Write sheet.png (frames side by side), preview.png (sheet x4 nearest) and
/// meta.json with the stats the inspector/overlord rely on.
export function emit(outDir, { frames, fps = 4 }) {
  if (!frames.length) throw new Error('emit needs at least one frame');
  mkdirSync(outDir, { recursive: true });
  const sheet = sheetRgba(frames);
  writeFileSync(join(outDir, 'sheet.png'), encodePng(sheet.w, sheet.h, sheet.data));
  const prev = scaleRgba(sheet, 4);
  writeFileSync(join(outDir, 'preview.png'), encodePng(prev.w, prev.h, prev.data));

  const colors = new Set();
  let opaque = 0;
  let emptyFrames = 0;
  let identicalFrames = 0;
  for (const fr of frames) {
    let fo = 0;
    for (let i = 0; i < fr.data.length; i += 4) {
      if (fr.data[i + 3]) {
        fo++;
        colors.add(hex(fr.data[i], fr.data[i + 1], fr.data[i + 2]));
      }
    }
    if (!fo) emptyFrames++;
    if (Buffer.from(fr.data.buffer).equals(Buffer.from(frames[0].data.buffer))) identicalFrames++;
    opaque += fo;
  }
  const meta = {
    w: frames[0].w,
    h: frames[0].h,
    frames: frames.length,
    fps,
    colors: [...colors],
    opaqueRatio: +(opaque / (frames[0].w * frames[0].h * frames.length)).toFixed(3),
    emptyFrames,
    identicalFrames,
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/// Write a multi-sprite PACK: items/<name>.png per item, sheet.png atlas
/// (one row per item, frames left→right), atlas.json, preview.png contact
/// sheet (first frame of each item) and a pack-shaped meta.json.
export function emitPack(outDir, { items, fps = 4 }) {
  if (!items || !items.length) throw new Error('emitPack needs at least one item');
  mkdirSync(outDir, { recursive: true });
  const norm = [];
  const seen = new Set();
  for (const it of items) {
    const name = String(it.name || '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!name) throw new Error('item name must slugify to [a-z0-9-]: ' + it.name);
    if (seen.has(name)) throw new Error('duplicate item name: ' + name);
    seen.add(name);
    if (!it.frames || !it.frames.length) throw new Error('item ' + name + ' has no frames');
    norm.push({ name, frames: it.frames });
  }
  const size = norm[0].frames[0].w;
  for (const it of norm) {
    for (const f of it.frames) {
      if (f.w !== size || f.h !== size) throw new Error('all pack frames must be ' + size + 'x' + size);
    }
  }
  mkdirSync(join(outDir, 'items'), { recursive: true });

  const maxFrames = Math.max(...norm.map((it) => it.frames.length));
  const atlas = new Canvas(size * maxFrames, size * norm.length);
  const atlasItems = [];
  const colors = new Set();
  const perItem = [];
  let emptyItems = 0;
  let duplicateItems = 0;
  const firstFrames = [];
  norm.forEach((it, row) => {
    const strip = sheetRgba(it.frames);
    writeFileSync(join(outDir, 'items', it.name + '.png'), encodePng(strip.w, strip.h, strip.data));
    for (let f = 0; f < it.frames.length; f++) {
      const fr = it.frames[f];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) atlas.px(f * size + x, row * size + y, fr.get(x, y));
    }
    atlasItems.push({ name: it.name, x: 0, y: row * size, w: size, h: size, frames: it.frames.length });
    // per-item stats
    const icolors = new Set();
    let opaque = 0, emptyFrames = 0, identicalFrames = 0, totalPx = 0;
    for (const fr of it.frames) {
      let fo = 0;
      for (let i = 0; i < fr.data.length; i += 4) {
        if (fr.data[i + 3]) {
          fo++;
          icolors.add(hex(fr.data[i], fr.data[i + 1], fr.data[i + 2]));
          colors.add(hex(fr.data[i], fr.data[i + 1], fr.data[i + 2]));
        }
      }
      if (!fo) emptyFrames++;
      if (Buffer.from(fr.data.buffer).equals(Buffer.from(it.frames[0].data.buffer))) identicalFrames++;
      opaque += fo;
      totalPx += size * size;
    }
    perItem.push({
      name: it.name,
      frames: it.frames.length,
      colors: [...icolors],
      opaqueRatio: +(opaque / totalPx).toFixed(3),
      emptyFrames,
      identicalFrames,
    });
    if (!opaque) emptyItems++;
    if (firstFrames.some((ff) => Buffer.from(ff.data.buffer).equals(Buffer.from(it.frames[0].data.buffer)))) {
      duplicateItems++;
    }
    firstFrames.push(it.frames[0]);
  });
  writeFileSync(join(outDir, 'sheet.png'), encodePng(atlas.w, atlas.h, atlas.data));
  writeFileSync(join(outDir, 'atlas.json'), JSON.stringify({ size, fps, items: atlasItems }, null, 2));

  // contact sheet: first frame of each item in a grid
  const cols = Math.min(8, Math.ceil(Math.sqrt(norm.length)));
  const rows = Math.ceil(norm.length / cols);
  const grid = new Canvas(cols * size, rows * size);
  norm.forEach((it, i) => {
    const gx = (i % cols) * size, gy = Math.floor(i / cols) * size;
    const fr = it.frames[0];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) grid.px(gx + x, gy + y, fr.get(x, y));
  });
  const k = cols * size * 4 > 1024 ? 2 : 4;
  const prev = scaleRgba(grid, k);
  writeFileSync(join(outDir, 'preview.png'), encodePng(prev.w, prev.h, prev.data));

  const meta = {
    kind: 'pack',
    w: size,
    h: size,
    items: norm.length,
    frames: norm.reduce((s, it) => s + it.frames.length, 0),
    fps,
    colors: [...colors],
    perItem,
    emptyItems,
    duplicateItems,
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}
`;

const STYLE_MD = `# STYLE.md — Alien Factory house rules

Every asset is a small sprite sheet produced by code, not by hand-drawing.

## The contract

- Each asset lives in \`assets/<sku>/\` with a \`gen.mjs\` that imports
  \`../../lib/pix.mjs\` and ends with:
  \`emit(new URL('.', import.meta.url).pathname, { frames, fps })\`
- \`emit\` writes \`sheet.png\` (frames side by side), \`preview.png\`
  (sheet scaled x4) and \`meta.json\` (stats). You never write PNGs yourself.
- Multi-sprite PACKS use \`emitPack(outDir, { items: [{ name, frames }], fps })\`
  instead: it writes \`items/<name>.png\` per item, a \`sheet.png\` atlas
  (one row per item), \`atlas.json\`, a \`preview.png\` contact sheet and a
  \`meta.json\` with \`kind: 'pack'\`.

## Look

- Frame size 16x16 or 32x32 (must match the order).
- 1-8 frames, \`fps\` 2-8.
- 16 distinct opaque colours max per SPRITE, 32 across a whole PACK.
- 1px dark outline around the silhouette (\`c.outline('#...')\` last).
- Readable silhouette: it must read at 16x16, not just at x4 zoom.
- Deterministic: seed every random choice with
  \`mulberry32(hashString(<sku>))\` — same code, same sprite.

## Workflow

1. Write \`assets/<sku>/gen.mjs\`.
2. Run \`node assets/<sku>/gen.mjs\` and check \`meta.json\`.
3. Open \`preview.png\` if you can view images; fix and re-run.

\`examples/slime-green\`, \`examples/crop-carrot\` and \`examples/potion-red\`
are complete working generators — study them before writing your own.
\`examples/potion-pack\` is the reference PACK generator (12 potions with a
shared palette and per-item parameters — packs of 4-48 items are written
as loops, not as hand-drawn one-offs).
`;

interface StarterAsset {
  sku: string;
  gen: string;
}

const SLIME_GEN = `// slime-green — a bouncy little slime, 4-frame squash & stretch.
import { Canvas, emit, mulberry32, hashString } from '../../lib/pix.mjs';

const rnd = mulberry32(hashString('slime-green'));
const BODY = '#4fc34f';
const DARK = '#2f8f3a';
const LIGHT = '#9ce88a';
const EYE = '#12301a';

// blob wobble: [halfW, halfH, yOffset]
const shapes = [
  [6, 4, 0],   // settle
  [7, 3, 1],   // squash
  [5, 6, -2],  // stretch (jump)
  [6, 5, -1],  // recover
];

const frames = shapes.map(([hw, hh, yo], f) => {
  const c = new Canvas(16, 16);
  const cx = 8, base = 13;
  const cy = base - hh + yo;
  // body: squashed ellipse + soft drip
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = (x - cx) / hw;
      const dy = (y - cy) / hh;
      if (dx * dx + dy * dy <= 1) c.px(x, y, BODY);
    }
  }
  c.circle(cx - hw + 2, base + yo - 1, 1, BODY); // left drip
  // belly shading + top highlight
  for (let x = cx - hw + 1; x < cx + hw; x++) {
    if (c.get(x, base + yo)[3]) c.px(x, base + yo, DARK);
  }
  for (let x = cx - hw + 2; x <= cx - 1; x++) {
    const y = cy - hh + 1;
    if (c.get(x, y)[3] && rnd() < 0.9) c.px(x, y, LIGHT);
  }
  // eyes (they lag the squash a little)
  const ey = cy - 1 + (f === 1 ? 1 : 0);
  const ex = f === 2 ? 4 : 3;
  c.px(cx - ex, ey, EYE); c.px(cx + ex, ey, EYE);
  c.px(cx - ex, ey + 1, EYE); c.px(cx + ex, ey + 1, EYE);
  c.px(cx - ex, ey, '#e8fff0'); c.px(cx + ex, ey, '#e8fff0');
  c.outline('#17361c');
  return c;
});

emit(new URL('.', import.meta.url).pathname, { frames, fps: 5 });
`;

const CARROT_GEN = `// crop-carrot — four growth stages, seedling to harvest-ready.
import { Canvas, emit } from '../../lib/pix.mjs';

const LEAF = '#3fae4a';
const LEAF_L = '#7ad15e';
const ROOT = '#e8873a';
const ROOT_D = '#c96a24';
const SOIL = '#5a4232';

const frames = [];

// stage 1: sprout
{
  const c = new Canvas(16, 16);
  c.rect(6, 12, 4, 3, SOIL);
  c.line(8, 12, 8, 9, LEAF);
  c.line(8, 10, 6, 8, LEAF);
  c.line(8, 10, 10, 8, LEAF_L);
  c.outline('#241a12');
  frames.push(c);
}
// stage 2: bigger sprout
{
  const c = new Canvas(16, 16);
  c.rect(5, 12, 6, 3, SOIL);
  c.line(8, 12, 8, 7, LEAF);
  c.line(8, 9, 5, 6, LEAF);
  c.line(8, 9, 11, 6, LEAF_L);
  c.line(8, 8, 8, 5, LEAF_L);
  c.outline('#241a12');
  frames.push(c);
}
// stage 3: shoulders peeking out of the soil
{
  const c = new Canvas(16, 16);
  c.rect(4, 12, 8, 3, SOIL);
  c.px(7, 11, ROOT); c.px(8, 11, ROOT);
  c.px(6, 12, ROOT); c.px(9, 12, ROOT);
  c.line(8, 11, 8, 5, LEAF);
  c.line(8, 8, 4, 5, LEAF);
  c.line(8, 7, 12, 4, LEAF_L);
  c.line(8, 6, 6, 3, LEAF_L);
  c.line(8, 6, 10, 3, LEAF);
  c.outline('#241a12');
  frames.push(c);
}
// stage 4: pulled up, full carrot
{
  const c = new Canvas(16, 16);
  // lush top
  c.line(8, 6, 8, 2, LEAF);
  c.line(8, 5, 4, 2, LEAF);
  c.line(8, 4, 12, 1, LEAF_L);
  c.line(8, 6, 5, 4, LEAF_L);
  c.line(8, 5, 11, 3, LEAF);
  // tapered root
  const rows = [[6, 10, 6], [7, 9, 7], [7, 9, 8], [7, 9, 9], [7, 9, 10], [8, 8, 11], [8, 8, 12], [8, 8, 13]];
  for (const [x0, x1, y] of rows) c.rect(x0, y, x1 - x0 + 1, 1, ROOT);
  // ridge shading
  c.px(7, 8, ROOT_D); c.px(9, 9, ROOT_D); c.px(7, 10, ROOT_D); c.px(8, 12, ROOT_D);
  c.px(6, 6, ROOT); c.px(9, 6, ROOT);
  c.outline('#241a12');
  frames.push(c);
}

emit(new URL('.', import.meta.url).pathname, { frames, fps: 2 });
`;

const POTION_GEN = `// potion-red — a little flask of red potion, 4-frame shimmer.
import { Canvas, emit, mulberry32, hashString } from '../../lib/pix.mjs';

const rnd = mulberry32(hashString('potion-red'));
const GLASS = '#9fc8d8';
const LIQ = '#d8344a';
const LIQ_D = '#a02038';
const LIQ_L = '#ff7a8a';
const CORK = '#b08454';
const SHINE = '#fff0f0';

const frames = [0, 1, 2, 3].map((f) => {
  const c = new Canvas(16, 16);
  // flask: neck + round belly
  c.rect(7, 2, 2, 4, GLASS);            // neck
  c.circle(8, 10, 5, GLASS);            // belly
  // cork
  c.rect(6, 1, 4, 2, CORK);
  // liquid inside the belly (level wobbles a pixel)
  const top = 9 + (f === 1 || f === 2 ? 0 : -1);
  for (let y = top; y < 15; y++) {
    for (let x = 0; x < 16; x++) {
      if (c.get(x, y)[3] && (x - 8) * (x - 8) + (y - 10) * (y - 10) <= 16) {
        c.px(x, y, y === top ? LIQ_L : LIQ);
      }
    }
  }
  c.rect(6, 13, 5, 1, LIQ_D);           // sediment at the bottom
  // bubbles rising inside the liquid
  const by = 12 - (f % 3);
  c.px(7, by, LIQ_L); c.px(9, by - 2, LIQ_L);
  // glass shine
  c.px(5, 8, SHINE); c.px(5, 9, SHINE);
  c.px(8, 3, SHINE);
  // sparkle drifts around the flask
  const spots = [[12, 4], [3, 6], [13, 11], [4, 13]];
  const [sx, sy] = spots[f];
  c.px(sx, sy, SHINE);
  c.px(sx - 1, sy, SHINE); c.px(sx + 1, sy, SHINE);
  c.px(sx, sy - 1, SHINE); c.px(sx, sy + 1, SHINE);
  c.outline('#1c2530');
  return c;
});

emit(new URL('.', import.meta.url).pathname, { frames, fps: 4 });
void rnd;
`;

const POTION_PACK_GEN = `// potion-pack — the reference PACK generator: 12 potion sprites sharing
// one palette, driven by per-item parameters (shape × liquid × stopper)
// in a loop. 4-frame shimmer per item. This is how big packs stay
// manageable: parameters + a loop, never 12 hand-drawn one-offs.
import { Canvas, emitPack, mulberry32, hashString } from '../../lib/pix.mjs';

const rnd = mulberry32(hashString('potion-pack'));

const LIQUIDS = [
  { name: 'red',    liq: '#d8344a', dark: '#a02038', lite: '#ff9aa8' },
  { name: 'blue',   liq: '#3a78d8', dark: '#24508f', lite: '#7ab0ff' },
  { name: 'green',  liq: '#3ad87a', dark: '#20905a', lite: '#8affba' },
  { name: 'purple', liq: '#9a5ae0', dark: '#6a38a0', lite: '#c99aff' },
];
const SHAPES = ['flask', 'square', 'vial'];
const STOPPERS = [
  { name: 'cork', col: '#b08454', w: 4 },
  { name: 'cap',  col: '#d8b84a', w: 5 },
  { name: 'wax',  col: '#8a2a3a', w: 5 },
];
const GLASS = '#9fc8d8';
const SHINE = '#fff0f0';
const OUTLINE = '#1c2530';

function body(c, shape) {
  if (shape === 'flask') { c.rect(7, 2, 2, 4, GLASS); c.circle(8, 10, 5, GLASS); }
  else if (shape === 'square') { c.rect(6, 3, 4, 2, GLASS); c.rect(4, 5, 8, 9, GLASS); }
  else { c.rect(6, 2, 4, 12, GLASS); } // vial
}

function potion(shape, liquid, stopper, f) {
  const c = new Canvas(16, 16);
  body(c, shape);
  // stopper: cork / metal cap / wax seal (wax drips a pixel)
  const sw = stopper.w;
  c.rect(8 - Math.floor(sw / 2), 0, sw, 2, stopper.col);
  if (stopper.name === 'wax') c.rect(8 - Math.floor(sw / 2), 2, 1, 2, stopper.col);
  if (stopper.name === 'cap') c.px(8 - Math.floor(sw / 2), 0, SHINE);
  // liquid fill: everything inside the glass below the (wobbling) level
  const base = { flask: 9, square: 9, vial: 7 }[shape];
  const level = base + (f % 2);
  for (let y = level; y < 15; y++) {
    for (let x = 0; x < 16; x++) {
      if (c.get(x, y)[3]) c.px(x, y, y === level ? liquid.lite : liquid.liq);
    }
  }
  // sediment at the bottom of the glass
  c.rect(6, 13, 4, 1, liquid.dark);
  // rising bubbles
  const by = 12 - (f % 3);
  c.px(7, by, liquid.lite);
  c.px(9, by - 2, liquid.lite);
  // glass shine
  c.px(5, 8, SHINE); c.px(5, 9, SHINE);
  if (shape === 'vial') c.px(6, 3, SHINE);
  // sparkle drifts around the bottle
  const spots = [[12, 4], [3, 6], [13, 11], [4, 13]];
  const [sx, sy] = spots[f % 4];
  c.px(sx, sy, SHINE); c.px(sx - 1, sy, SHINE); c.px(sx + 1, sy, SHINE);
  c.px(sx, sy - 1, SHINE); c.px(sx, sy + 1, SHINE);
  c.outline(OUTLINE);
  return c;
}

// 12 items: 4 liquids × 3 shapes, stopper cycles per item
const items = [];
let i = 0;
for (const liquid of LIQUIDS) {
  for (const shape of SHAPES) {
    const stopper = STOPPERS[i % STOPPERS.length];
    const name = shape + '-' + liquid.name;
    const frames = [0, 1, 2, 3].map((f) => potion(shape, liquid, stopper, f));
    items.push({ name, frames });
    i++;
  }
}

emitPack(new URL('.', import.meta.url).pathname, { items, fps: 4 });
void rnd;
`;

const STARTERS: StarterAsset[] = [
  { sku: 'slime-green', gen: SLIME_GEN },
  { sku: 'crop-carrot', gen: CARROT_GEN },
  { sku: 'potion-red', gen: POTION_GEN },
  { sku: 'potion-pack', gen: POTION_PACK_GEN },
];

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/// Write when absent OR content differs — used for lib/pix.mjs so library
/// updates (e.g. emitPack) reach existing factory dirs. Returns true when
/// it wrote.
export function writeIfDiffers(path: string, content: string): boolean {
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  } catch {
    /* unreadable → rewrite */
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/// Creates the factory tree. Examples are style references only — the
/// catalog and the conveyor start empty.
export function seedFactory(): void {
  mkdirSync(FACTORY_DIR, { recursive: true });
  writeIfDiffers(join(FACTORY_DIR, 'lib/pix.mjs'), PIX_LIB);
  writeIfMissing(join(FACTORY_DIR, 'STYLE.md'), STYLE_MD);
  mkdirSync(join(FACTORY_DIR, 'reports'), { recursive: true });

  for (const s of STARTERS) {
    const oldDir = join(FACTORY_DIR, 'assets', s.sku);
    const dir = join(FACTORY_DIR, 'examples', s.sku);
    // migrate the previous seed's catalog items into examples/, once
    if (existsSync(oldDir)) {
      if (!existsSync(dir)) {
        mkdirSync(join(FACTORY_DIR, 'examples'), { recursive: true });
        renameSync(oldDir, dir);
      } else {
        rmSync(oldDir, { recursive: true, force: true });
      }
    }
    writeIfMissing(join(dir, 'gen.mjs'), s.gen);
    if (!existsSync(join(dir, 'sheet.png'))) {
      execFileSync(process.execPath, [join(dir, 'gen.mjs')], { cwd: FACTORY_DIR, timeout: 20_000 });
    }
  }
}
