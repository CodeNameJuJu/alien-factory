// Ship-kit builder: everything a Gumroad product needs, written into
// assets/<sku>/kit/ — a zip of the asset files, README/LICENSE, and drawn
// cover.png / thumbnail.png. Zero deps: the zip writer and PNG codec are
// hand-rolled (png.ts).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32, decodePng, Pix, type RGBA } from './png.js';

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
}): Buffer {
  const c = new Pix(opts.w, opts.h, BG);
  // border frame
  c.rect(0, 0, opts.w, 4, ACCENT);
  c.rect(0, opts.h - 4, opts.w, 4, ACCENT);
  const pad = Math.round(opts.h * 0.08);
  let artTop = pad;
  if (opts.preview) {
    try {
      const art = decodePng(opts.preview);
      const artH = Math.round(opts.h * 0.62);
      const artW = opts.w - pad * 4;
      const k = Math.max(1, Math.min(Math.floor(artH / art.h), Math.floor(artW / art.w)));
      const bw = art.w * k;
      const bh = art.h * k;
      const bx = Math.round((opts.w - bw) / 2);
      const by = pad + Math.round((artH - bh) / 2);
      c.rect(bx - k, by - k, bw + k * 2, bh + k * 2, PANEL);
      c.blit(art, bx, by, k);
      artTop = by + bh + k * 2;
    } catch {
      /* un-decodable preview → title-only card */
    }
  }
  const scale = Math.max(2, Math.min(8, Math.floor((opts.w * 0.8) / Math.max(60, c.textWidth(opts.title, 1)))));
  const tw = c.textWidth(opts.title, scale);
  const ty = artTop + Math.round((opts.h - artTop - 14 * scale) / 2) + Math.round(4 * scale);
  c.text(Math.round((opts.w - tw) / 2), ty, opts.title, scale, ACCENT);
  const ss = Math.max(2, Math.round(scale / 2));
  const sw = c.textWidth(opts.subtitle, ss);
  c.text(Math.round((opts.w - sw) / 2), ty + 9 * scale, opts.subtitle, ss, DIM);
  return c.png();
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
  const subtitle = spec.isPack
    ? `${spec.itemNames.length || '?'} x ${spec.size}px sprites - ${spec.framesPerItem}f animations`
    : `${spec.size}px animated sprite`;
  writeFileSync(
    join(kitDir, 'cover.png'),
    drawCover({ w: 1280, h: 720, title: spec.title, subtitle, preview }),
  );
  writeFileSync(
    join(kitDir, 'thumbnail.png'),
    drawCover({ w: 600, h: 600, title: spec.title, subtitle, preview }),
  );
  return {
    dir: kitDir,
    zipName,
    zipBytes: zip.length,
    files: [zipName, 'README.txt', 'LICENSE.txt', 'cover.png', 'thumbnail.png'],
  };
}
