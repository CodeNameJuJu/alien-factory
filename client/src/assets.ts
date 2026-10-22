// Loads generated asset sheets + meta.json from the server's /files endpoint
// and draws animated frames at integer scale. Falls back to a placeholder
// checker while loading or when the sheet doesn't exist yet.
import type { Asset } from '../../shared/protocol';

export interface AssetMeta {
  w: number;
  h: number;
  frames: number;
  fps: number;
  colors?: string[];
  opaqueRatio?: number;
  emptyFrames?: number;
  identicalFrames?: number;
}

interface CacheEntry {
  img: HTMLImageElement | null;
  meta: AssetMeta | null;
  failed: boolean;
}

const cache = new Map<string, CacheEntry>();

/// Demo mode: register a procedurally drawn sheet instead of fetching.
export function registerDemoSheet(sku: string, img: HTMLCanvasElement, meta: AssetMeta): void {
  const e: CacheEntry = { img: img as unknown as HTMLImageElement, meta, failed: false };
  cache.set(sku, e);
}

function load(sku: string): CacheEntry {
  let e = cache.get(sku);
  if (e) return e;
  e = { img: null, meta: null, failed: false };
  cache.set(sku, e);
  const img = new Image();
  img.onload = () => { e!.img = img; };
  img.onerror = () => { e!.failed = true; };
  img.src = `/files/assets/${sku}/sheet.png`;
  fetch(`/files/assets/${sku}/meta.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => { e!.meta = m; })
    .catch(() => { e!.failed = true; });
  return e;
}

/// Bust the cache for a sku (e.g. after it transitions to listed).
export function invalidate(sku: string): void {
  cache.delete(sku);
}

/// Draw the asset's current animation frame at `scale` (integer), top-left
/// at (x,y). Draws a dashed placeholder if the sheet isn't there yet.
export function drawAssetFrame(
  ctx: CanvasRenderingContext2D,
  asset: Asset,
  x: number,
  y: number,
  scale: number,
  t: number,
): void {
  const e = load(asset.sku);
  const w = e.meta?.w ?? asset.size;
  const h = e.meta?.h ?? asset.size;
  const frames = Math.max(1, e.meta?.frames ?? asset.frames);
  const fps = Math.max(1, e.meta?.fps ?? 4);
  if (e.img && e.meta) {
    const f = Math.floor(t * fps) % frames;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(e.img, f * w, 0, w, h, x, y, w * scale, h * scale);
    return;
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

export function metaFor(sku: string): AssetMeta | null {
  return cache.get(sku)?.meta ?? null;
}

/// Fetch full meta (for the asset drawer).
export async function fetchMeta(sku: string): Promise<AssetMeta | null> {
  const e = load(sku);
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
