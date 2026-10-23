// Loads generated asset sheets + meta.json (+ atlas.json for packs) from the
// server's /files endpoint and draws animated frames at integer scale.
// Falls back to a placeholder checker while loading or when the sheet
// doesn't exist yet.
import type { Asset } from '../../shared/protocol';

export interface MetaPackItem {
  name: string;
  frames: number;
  colors: string[];
  opaqueRatio: number;
  emptyFrames: number;
  identicalFrames: number;
}

export interface AssetMeta {
  w: number;
  h: number;
  frames: number;
  fps: number;
  colors?: string[];
  opaqueRatio?: number;
  emptyFrames?: number;
  identicalFrames?: number;
  /// emitPack assets:
  kind?: string;
  items?: number;
  perItem?: MetaPackItem[];
  emptyItems?: number;
  duplicateItems?: number;
}

export interface AtlasItem {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frames: number;
}

export interface AtlasJson {
  size: number;
  fps: number;
  items: AtlasItem[];
}

interface CacheEntry {
  img: HTMLImageElement | null;
  meta: AssetMeta | null;
  atlas: AtlasJson | null;
  failed: boolean;
}

const cache = new Map<string, CacheEntry>();

/// Demo mode: register a procedurally drawn sheet instead of fetching.
export function registerDemoSheet(sku: string, img: HTMLCanvasElement, meta: AssetMeta): void {
  const e: CacheEntry = { img: img as unknown as HTMLImageElement, meta, atlas: null, failed: false };
  cache.set(sku, e);
}

/// Demo mode: a pack is one atlas image + its atlas.json layout.
export function registerDemoPack(sku: string, img: HTMLCanvasElement, meta: AssetMeta, atlas: AtlasJson): void {
  const e: CacheEntry = { img: img as unknown as HTMLImageElement, meta, atlas, failed: false };
  cache.set(sku, e);
}

function load(sku: string, wantPack: boolean): CacheEntry {
  let e = cache.get(sku);
  if (e) return e;
  e = { img: null, meta: null, atlas: null, failed: false };
  cache.set(sku, e);
  const img = new Image();
  img.onload = () => { e!.img = img; };
  img.onerror = () => { e!.failed = true; };
  img.src = `/files/assets/${sku}/sheet.png`;
  fetch(`/files/assets/${sku}/meta.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => { e!.meta = m; })
    .catch(() => { e!.failed = true; });
  if (wantPack) {
    fetch(`/files/assets/${sku}/atlas.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => { e!.atlas = a; })
      .catch(() => { /* pack without atlas → falls back to sheet frame 0 */ });
  }
  return e;
}

/// Bust the cache for a sku (e.g. after it transitions to listed).
export function invalidate(sku: string): void {
  cache.delete(sku);
}

/// ~1.2s per item when a pack flips through its contents.
const PACK_ITEM_SECONDS = 1.2;

/// Draw the asset's current animation frame at `scale` (integer), top-left
/// at (x,y). Packs cycle through items, playing each item's own frames from
/// the atlas. Draws a dashed placeholder if the sheet isn't there yet.
export function drawAssetFrame(
  ctx: CanvasRenderingContext2D,
  asset: Asset,
  x: number,
  y: number,
  scale: number,
  t: number,
): void {
  const isPack = asset.kind === 'pack';
  const e = load(asset.sku, isPack);
  const w = e.atlas?.size ?? e.meta?.w ?? asset.size;
  const h = e.atlas?.size ?? e.meta?.h ?? asset.size;
  if (e.img) {
    ctx.imageSmoothingEnabled = false;
    if (isPack && e.atlas && e.atlas.items.length) {
      const items = e.atlas.items;
      const it = items[Math.floor(t / PACK_ITEM_SECONDS) % items.length];
      const f = Math.floor(t * Math.max(1, e.atlas.fps)) % Math.max(1, it.frames);
      ctx.drawImage(e.img, it.x + f * it.w, it.y, it.w, it.h, x, y, it.w * scale, it.h * scale);
      return;
    }
    if (e.meta) {
      const frames = Math.max(1, e.meta.frames);
      const fps = Math.max(1, e.meta.fps);
      const f = Math.floor(t * fps) % frames;
      ctx.drawImage(e.img, f * w, 0, w, h, x, y, w * scale, h * scale);
      return;
    }
  }
  // placeholder: pulsing ?-box
  ctx.fillStyle = 'rgba(120,110,150,0.25)';
  ctx.fillRect(x, y, w * scale, h * scale);
  ctx.strokeStyle = '#8a80b0';
  ctx.setLineDash([2, 2]);
  ctx.strokeRect(x + 0.5, y + 0.5, w * scale - 1, h * scale - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = '#b0a8d8';
  ctx.font = `${8 * scale / 2}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('?', x + (w * scale) / 2, y + (h * scale) / 2 + 3);
}

/// Draw one pack item (its own animation) at `scale` — the asset drawer's
/// item grid uses this; crates use drawAssetFrame's flip-through instead.
export function drawAtlasItem(
  ctx: CanvasRenderingContext2D,
  sku: string,
  item: AtlasItem,
  x: number,
  y: number,
  scale: number,
  t: number,
): void {
  const e = load(sku, true);
  ctx.imageSmoothingEnabled = false;
  if (e.img) {
    const fps = Math.max(1, e.atlas?.fps ?? e.meta?.fps ?? 4);
    const f = Math.floor(t * fps) % Math.max(1, item.frames);
    ctx.drawImage(e.img, item.x + f * item.w, item.y, item.w, item.h, x, y, item.w * scale, item.h * scale);
    return;
  }
  ctx.fillStyle = 'rgba(120,110,150,0.25)';
  ctx.fillRect(x, y, item.w * scale, item.h * scale);
}

/// Small `×N` badge under the top-right corner for pack crates/thumbnails.
export function drawPackBadge(
  ctx: CanvasRenderingContext2D,
  items: number,
  x: number,
  y: number,
): void {
  ctx.font = '7px "Courier New", monospace';
  ctx.textAlign = 'right';
  const label = `×${items}`;
  const w = ctx.measureText(label).width + 4;
  ctx.fillStyle = 'rgba(20,16,34,0.85)';
  ctx.fillRect(x - w, y - 9, w, 10);
  ctx.strokeStyle = '#8a80b0';
  ctx.strokeRect(x - w + 0.5, y - 8.5, w - 1, 9);
  ctx.fillStyle = '#ffd76a';
  ctx.fillText(label, x - 2, y - 1.5);
}

export function metaFor(sku: string): AssetMeta | null {
  return cache.get(sku)?.meta ?? null;
}

export function atlasFor(sku: string): AtlasJson | null {
  return cache.get(sku)?.atlas ?? null;
}

/// Fetch full meta (for the asset drawer).
export async function fetchMeta(sku: string): Promise<AssetMeta | null> {
  const e = load(sku, false);
  if (e.meta) return e.meta;
  try {
    const r = await fetch(`/files/assets/${sku}/meta.json`);
    if (!r.ok) return null;
    const m = (await r.json()) as AssetMeta;
    e.meta = m;
    return m;
  } catch {
    return null;
  }
}

/// Fetch the pack atlas layout (for the asset drawer's item grid).
export async function fetchAtlas(sku: string): Promise<AtlasJson | null> {
  const e = load(sku, true);
  if (e.atlas) return e.atlas;
  try {
    const r = await fetch(`/files/assets/${sku}/atlas.json`);
    if (!r.ok) return null;
    const a = (await r.json()) as AtlasJson;
    e.atlas = a;
    return a;
  } catch {
    return null;
  }
}
