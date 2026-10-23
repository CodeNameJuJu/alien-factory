// Ship-kit builder: everything a Gumroad product needs, written into
// assets/<sku>/kit/ — a zip of the asset files, README/LICENSE, drawn
// cover.png / thumbnail.png / gallery-1.png and an animated preview.gif.
// Zero deps: the zip writer, PNG codec and GIF89a encoder are hand-rolled
// (png.ts, gif.ts).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32, decodePng, Pix, type RGBA } from './png.js';
import { buildPalette, encodeGif } from './gif.js';

export const KIT_LICENSE = `LICENSE — pixel game assets

You may use these assets in personal and commercial games and projects.
You may modify them freely. No attribution is required (a credit line is
always appreciated but never needed).

You may NOT resell, repackage or redistribute the assets themselves —
not on their own, and not inside another asset pack or bundle.

Made with procedural code written by AI agents and reviewed before release.
`;

// ---- minimal zip ----------------------------------------------------------
//
// Stored-or-deflate zip: local file headers + central directory + EOCD.
// Enough for unzip -t and every storefront uploader.

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function zipFiles(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = deflateRawSync(e.data);
    const useStore = comp.length >= e.data.length;
    const body = useStore ? e.data : comp;
    const method = useStore ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); // mtime
    lh.writeUInt16LE(0, 12); // mdate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    chunks.push(lh, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); // mtime
    cd.writeUInt16LE(0, 14); // mdate
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 30); // comment/disk/attrs
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);
    offset += lh.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---- cover / thumbnail art ------------------------------------------------

const BG: RGBA = [18, 14, 32, 255];
const PANEL: RGBA = [30, 24, 48, 255];
const ACCENT: RGBA = [92, 242, 200, 255];
const DIM: RGBA = [140, 132, 184, 255];

/// Draw a marketing card: dark bg, the asset's contact sheet (preview.png)
/// nearest-scaled to the largest integer factor that fits, centred, with a
/// pixel-font title + subtitle. Falls back to the plain card when the
/// preview can't be decoded.
export function drawCover(opts: {
  w: number;
  h: number;
  title: string;
  subtitle: string;
  preview?: Buffer | null;
  items?: KitItem[];
}): Buffer {
  const c = new Pix(opts.w, opts.h, BG);
  // border frame
  c.rect(0, 0, opts.w, 4, ACCENT);
  c.rect(0, opts.h - 4, opts.w, 4, ACCENT);
  const pad = Math.round(opts.h * 0.08);
  const artH = Math.round(opts.h * 0.62);
  const artW = opts.w - pad * 4;
  let artTop = pad;
  if (opts.items?.length) {
    // grid of every item's first frame — uniform cells, largest integer
    // scale that fits the art box
    const items = opts.items;
    const cell = Math.max(...items.map((i) => Math.max(i.frames[0]?.w ?? 0, i.frames[0]?.h ?? 0)), 1);
    const gap = Math.max(2, Math.round(cell / 4));
    const n = items.length;
    let best = { cols: 1, k: 0, gw: 0, gh: 0 };
    for (let cols = 1; cols <= Math.min(12, n); cols++) {
      const rows = Math.ceil(n / cols);
      const gw = cols * cell + (cols - 1) * gap;
      const gh = rows * cell + (rows - 1) * gap;
      const k = Math.min(Math.floor(artW / gw), Math.floor(artH / gh));
      // same scale → fewest empty cells in the last row, then closest aspect
      const empty = rows * cols - n;
      const bestEmpty = best.k ? Math.ceil(n / best.cols) * best.cols - n : Infinity;
      if (
        k > best.k ||
        (k === best.k &&
          (empty < bestEmpty ||
            (empty === bestEmpty &&
              Math.abs(gw / gh - artW / artH) < Math.abs(best.gw / best.gh - artW / artH))))
      ) {
        best = { cols, k, gw, gh };
      }
    }
    if (best.k >= 1) {
      const { cols, k, gw, gh } = best;
      const bx = Math.round((opts.w - gw * k) / 2);
      const by = Math.max(pad, pad + Math.round((artH - gh * k) / 2));
      c.rect(bx - k, by - k, gw * k + k * 2, gh * k + k * 2, PANEL);
      items.forEach((it, i) => {
        const fr = it.frames[0];
        if (!fr) return;
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = bx + col * (cell + gap) * k + Math.round(((cell - fr.w) * k) / 2);
        const cy = by + row * (cell + gap) * k + Math.round(((cell - fr.h) * k) / 2);
        c.blit(fr, cx, cy, k);
      });
      artTop = by + gh * k + k * 2;
    }
  }
  if (artTop === pad && opts.preview) {
    try {
      let art = decodePng(opts.preview);
      let k = Math.min(Math.floor(artH / art.h), Math.floor(artW / art.w));
      if (k < 1) {
        // art doesn't fit at 1:1 — nearest-neighbour downscale by the
        // smallest integer divisor that fits (every d-th pixel), then k=1
        const d = Math.max(Math.ceil(art.w / artW), Math.ceil(art.h / artH));
        const dw = Math.floor(art.w / d);
        const dh = Math.floor(art.h / d);
        const data = new Uint8ClampedArray(dw * dh * 4);
        for (let sy = 0; sy < dh; sy++) {
          for (let sx = 0; sx < dw; sx++) {
            const si = (sy * d * art.w + sx * d) * 4;
            data.set(art.data.subarray(si, si + 4), (sy * dw + sx) * 4);
          }
        }
        art = { w: dw, h: dh, data };
        k = 1;
      }
      const bw = art.w * k;
      const bh = art.h * k;
      const bx = Math.round((opts.w - bw) / 2);
      const by = Math.max(pad, pad + Math.round((artH - bh) / 2));
      c.rect(bx - k, by - k, bw + k * 2, bh + k * 2, PANEL);
      c.blit(art, bx, by, k);
      artTop = by + bh + k * 2;
    } catch {
      /* un-decodable preview → title-only card */
    }
  }
  const scale = Math.max(2, Math.min(8, Math.floor((opts.w * 0.8) / Math.max(60, c.textWidth(opts.title, 1)))));
  const tw = c.textWidth(opts.title, scale);
  const ss = Math.max(2, Math.round(scale / 2));
  const sw = c.textWidth(opts.subtitle, ss);
  // keep title + subtitle above the bottom accent bar
  let ty = artTop + Math.round((opts.h - artTop - 14 * scale) / 2) + Math.round(4 * scale);
  ty = Math.min(ty, opts.h - 8 - 9 * scale - 7 * ss);
  c.text(Math.round((opts.w - tw) / 2), ty, opts.title, scale, ACCENT);
  c.text(Math.round((opts.w - sw) / 2), ty + 9 * scale, opts.subtitle, ss, DIM);
  return c.png();
}

// ---- gallery + animated gif -------------------------------------------------

export interface Img {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}
export interface KitItem {
  name: string;
  frames: Img[];
}

function subImage(img: Img, x: number, y: number, w: number, h: number): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    data.set(img.data.subarray(((y + yy) * img.w + x) * 4, ((y + yy) * img.w + x + w) * 4), yy * w * 4);
  }
  return { w, h, data };
}

/// Item frames straight off sheet.png: atlas.json rects for packs, the
/// horizontal strip for sprites. Returns [] when files can't be decoded.
function loadItems(dir: string, spec: KitSpec): KitItem[] {
  try {
    const sheet = decodePng(readFileSync(join(dir, 'sheet.png')));
    if (spec.isPack) {
      const atlas = JSON.parse(readFileSync(join(dir, 'atlas.json'), 'utf8')) as {
        items: { name: string; x: number; y: number; w: number; h: number; frames: number }[];
      };
      return atlas.items.map((it) => ({
        name: it.name,
        frames: Array.from({ length: it.frames }, (_, f) => subImage(sheet, it.x + f * it.w, it.y, it.w, it.h)),
      }));
    }
    return [
      {
        name: spec.sku,
        frames: Array.from({ length: spec.framesPerItem }, (_, f) => subImage(sheet, f * spec.size, 0, spec.size, spec.size)),
      },
    ];
  } catch {
    return [];
  }
}

/// 1280x720 grid: every item's first frame large, name under each.
export function drawGallery(items: KitItem[], title: string): Buffer {
  const W = 1280;
  const H = 720;
  const c = new Pix(W, H, BG);
  c.rect(0, 0, W, 4, ACCENT);
  c.rect(0, H - 4, W, 4, ACCENT);
  const n = Math.max(1, items.length);
  const titleScale = 4;
  const top = 12 + 9 * titleScale;
  // try column counts, keep the one giving the largest integer scale
  let best = { cols: 1, k: 1 };
  for (let cols = 1; cols <= Math.min(12, n); cols++) {
    const rows = Math.ceil(n / cols);
    const cw = Math.floor(W / cols);
    const ch = Math.floor((H - top) / rows);
    const iw = Math.max(...items.map((i) => i.frames[0]?.w ?? 0), 1);
    const ih = Math.max(...items.map((i) => i.frames[0]?.h ?? 0), 1);
    const k = Math.min(Math.floor((cw - 8) / iw), Math.floor((ch - 18) / ih));
    if (k > best.k || (k === best.k && cols < 6)) best = { cols, k };
  }
  const { cols, k } = best;
  const labelH = 9 * Math.max(1, Math.min(3, Math.floor(k / 4))) + 4;
  items.forEach((it, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cw = Math.floor(W / cols);
    const ch = Math.floor((H - top) / Math.ceil(n / cols));
    const bw = it.frames[0].w * k;
    const bh = it.frames[0].h * k;
    const bx = col * cw + Math.round((cw - bw) / 2);
    const by = top + row * ch + Math.round((ch - bh - labelH) / 2);
    c.rect(bx - 2, by - 2, bw + 4, bh + 4, PANEL);
    c.blit(it.frames[0], bx, by, k);
    const ls = Math.max(1, Math.min(3, Math.floor(k / 4)));
    const tw = c.textWidth(it.name.replace(/-/g, ' '), ls);
    c.text(Math.min(col * cw + cw - tw - 2, Math.max(col * cw + 2, bx + Math.round((bw - tw) / 2))), by + bh + 4, it.name.replace(/-/g, ' '), ls, DIM);
  });
  const tw = c.textWidth(title, titleScale);
  c.text(Math.round((W - tw) / 2), 10, title, titleScale, ACCENT);
  return c.png();
}

/// Animated grid of every item with >1 frame — 640x360, pack fps delay.
/// Returns null when nothing animates.
export function makePreviewGif(items: KitItem[], fps: number): Buffer | null {
  const animated = items.filter((i) => i.frames.length > 1);
  if (!animated.length) return null;
  const W = 640;
  const H = 360;
  const n = animated.length;
  let best = { cols: 1, k: 1 };
  for (let cols = 1; cols <= Math.min(10, n); cols++) {
    const rows = Math.ceil(n / cols);
    const cw = Math.floor(W / cols);
    const ch = Math.floor(H / rows);
    const iw = Math.max(...animated.map((i) => i.frames[0]?.w ?? 0), 1);
    const ih = Math.max(...animated.map((i) => i.frames[0]?.h ?? 0), 1);
    const k = Math.min(Math.floor((cw - 6) / iw), Math.floor((ch - 14) / ih));
    if (k > best.k) best = { cols, k };
  }
  const { cols, k } = best;
  const frameCount = Math.min(8, Math.max(...animated.map((i) => i.frames.length)));
  const pixFrames: Pix[] = [];
  for (let f = 0; f < frameCount; f++) {
    const c = new Pix(W, H, BG);
    animated.forEach((it, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cw = Math.floor(W / cols);
      const ch = Math.floor(H / Math.ceil(n / cols));
      const fr = it.frames[f % it.frames.length];
      const bw = fr.w * k;
      const bh = fr.h * k;
      const bx = col * cw + Math.round((cw - bw) / 2);
      const by = row * ch + Math.round((ch - bh) / 2);
      c.rect(bx - 1, by - 1, bw + 2, bh + 2, PANEL);
      c.blit(fr, bx, by, k);
    });
    pixFrames.push(c);
  }
  const rgb = (c: RGBA): [number, number, number] => [c[0], c[1], c[2]];
  const { palette, indexOf, step } = buildPalette(
    pixFrames.map((p) => ({ data: p.data })),
    [BG, PANEL, ACCENT, DIM].map(rgb),
  );
  const key = (r: number, g: number, b: number) => ((r / step) | 0) << 10 | ((g / step) | 0) << 5 | ((b / step) | 0);
  const frames = pixFrames.map((p) => {
    const idx = new Uint8Array(W * H);
    for (let i = 0, px = 0; i < p.data.length; i += 4, px++) {
      idx[px] = indexOf.get(key(p.data[i], p.data[i + 1], p.data[i + 2])) ?? 0;
    }
    return idx;
  });
  return encodeGif({ w: W, h: H, palette, frames, delayCs: Math.max(5, Math.round(100 / Math.max(1, fps))) });
}

// ---- kit builder -----------------------------------------------------------

export interface KitSpec {
  sku: string;
  title: string;
  isPack: boolean;
  size: number;
  /// ordered item slugs (packs) — for README + zip file list
  itemNames: string[];
  framesPerItem: number;
  fps: number;
}

export interface BuiltKit {
  dir: string;
  zipName: string;
  zipBytes: number;
  files: string[]; // relative paths inside kit/
}

/// Cover/thumbnail tagline under the title (ASCII only — the 5x7 font).
export function kitSubtitle(spec: KitSpec): string {
  const dims = `${spec.size}x${spec.size}px`;
  const n = spec.itemNames.length || '?';
  if (spec.isPack) {
    return spec.framesPerItem > 1
      ? `${n} sprites - ${dims} - ${spec.framesPerItem}-frame animations`
      : `${n} sprites - ${dims} - png + atlas`;
  }
  return spec.framesPerItem > 1
    ? `${dims} - ${spec.framesPerItem}-frame animation`
    : `${dims} sprite`;
}

/// Write assets/<sku>/kit/ next to the emitted asset. `dir` is the asset
/// directory itself (testable). Idempotent — overwrites the whole kit dir.
export function buildKit(dir: string, spec: KitSpec): BuiltKit {
  const kitDir = join(dir, 'kit');
  mkdirSync(kitDir, { recursive: true });

  const entries: ZipEntry[] = [];
  const grab = (rel: string, arcName = rel) => {
    const p = join(dir, rel);
    if (existsSync(p)) entries.push({ name: arcName, data: readFileSync(p) });
  };
  grab('sheet.png');
  grab('preview.png');
  grab('meta.json');
  if (spec.isPack) {
    grab('atlas.json');
    try {
      for (const n of readdirSync(join(dir, 'items')).sort()) {
        if (/^[a-z0-9-]{1,40}\.png$/.test(n)) grab(`items/${n}`);
      }
    } catch {
      /* no items dir */
    }
  }
  const contents = spec.isPack
    ? `items/*.png — ${spec.itemNames.length || '?'} sprites (${spec.itemNames.join(', ') || 'see atlas.json'})
sheet.png — atlas: one row per item, frames left-to-right
atlas.json — { size, fps, items: [{ name, x, y, w, h, frames }] }`
    : `sheet.png — ${spec.framesPerItem} frame(s) side by side`;
  const readme = `${spec.title}
${'='.repeat(Math.min(60, spec.title.length))}

Pixel game asset${spec.isPack ? ' pack' : ''} — ${spec.size}x${spec.size} frames${spec.isPack ? `, ${spec.itemNames.length || '?'} items, ${spec.framesPerItem} frame(s) each` : `, ${spec.framesPerItem} frame(s)`}, ${spec.fps} fps. Transparent PNG.

CONTENTS
${contents}
preview.png — contact sheet / scaled preview
meta.json — generator stats

USING THE ATLAS
Each item occupies one row of sheet.png; frame N is at
x = ${spec.isPack ? `N * ${spec.size}, y = row * ${spec.size}` : `N * ${spec.size}, y = 0`}.
See atlas.json for exact coordinates.

Made with procedural code written by AI agents and reviewed before release.
`;
  entries.push({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
  entries.push({ name: 'LICENSE.txt', data: Buffer.from(KIT_LICENSE, 'utf8') });

  const zip = zipFiles(entries);
  const zipName = `${spec.sku}.zip`;
  writeFileSync(join(kitDir, zipName), zip);
  writeFileSync(join(kitDir, 'README.txt'), readme);
  writeFileSync(join(kitDir, 'LICENSE.txt'), KIT_LICENSE);

  let preview: Buffer | null = null;
  try {
    preview = readFileSync(join(dir, 'preview.png'));
  } catch {
    /* draw card without art */
  }
  const subtitle = kitSubtitle(spec);
  const items = loadItems(dir, spec);
  writeFileSync(
    join(kitDir, 'cover.png'),
    drawCover({ w: 1280, h: 720, title: spec.title, subtitle, preview, items }),
  );
  writeFileSync(
    join(kitDir, 'thumbnail.png'),
    drawCover({ w: 600, h: 600, title: spec.title, subtitle, preview, items }),
  );

  // store images for the public covers/thumbnail route
  const files = [zipName, 'README.txt', 'LICENSE.txt', 'cover.png', 'thumbnail.png'];
  if (items.length) {
    writeFileSync(join(kitDir, 'gallery-1.png'), drawGallery(items, spec.title));
    files.push('gallery-1.png');
    const gif = makePreviewGif(items, spec.fps);
    if (gif) {
      writeFileSync(join(kitDir, 'preview.gif'), gif);
      files.push('preview.gif');
    }
  }
  return {
    dir: kitDir,
    zipName,
    zipBytes: zip.length,
    files,
  };
}
