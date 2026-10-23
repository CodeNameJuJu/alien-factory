// Pure ship-gate rules for the Gumroad channel — shared by the server
// (which enforces them) and the client (which previews them in the SHOP
// section). No IO, no secrets.
import type { Asset, AssetListing, GumroadConfig } from './protocol';

/// Minimal meta shape the checks need (emit/emitPack meta.json).
export interface ShipMeta {
  w?: number;
  h?: number;
  frames?: number;
  items?: number;
  perItem?: { frames: number }[];
}

/// Every explicit item-count claim in the listing text. Recognises
/// "600 RPG items", "48 icons", "x24", "24-pack", "set of 12".
/// Returns [claimed count, matched phrase] pairs.
/// Numbers describing variation/format — NOT item counts: "4 frames", "4f",
/// "24 fps", "8-dir"/"8 directions"/"4-way", "16px", "16 colours",
/// "6 material variants", "3 palettes".
const NON_COUNT_RE = /\b\d+\s*[-–]?\s*(?:frames?|fps|dirs?|directions?|way|px|colou?rs?|variants?|materials?|palettes?|f)\b/gi;

export function countClaims(text: string): [number, string][] {
  const out: [number, string][] = [];
  // strip NxNx size mentions first ("32x32" would fake an x-count claim),
  // then variation/format numbers so they can't fake item counts
  const t = text
    .replace(/\b\d{1,3}\s*x\s*\d{1,3}\b/gi, ' ')
    .replace(NON_COUNT_RE, ' ');
  const pats = [
    /\bset of (\d+)\b/gi,
    /\b(\d+)\s*[-–]?\s*pack\b/gi,
    /\bx\s*(\d+)\b/gi,
    /\b(\d+)\s+(?:[\w'-]+\s+){0,2}(?:items?|icons?|sprites?|tiles?|assets?|elements?|pieces?)\b/gi,
  ];
  for (const re of pats) {
    for (const m of t.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) out.push([n, m[0]]);
    }
  }
  // the same count written two ways ("set of 12" + "12 sprites") is one claim
  const seen = new Set<number>();
  return out.filter(([n]) => !seen.has(n) && !!seen.add(n));
}

/// Every NxN size mention (e.g. "32x32").
export function sizeClaims(text: string): number[] {
  return [...text.matchAll(/\b(\d{1,3})\s*x\s*\d{1,3}\b/gi)].map((m) => Number(m[1]));
}

/// Frame-count claims — "4 frames", "4-frame", "4f" (not "fps" — that's speed).
export function frameClaims(text: string): [number, string][] {
  return [...text.matchAll(/\b(\d+)\s*[-–]?\s*(?:frames?|f)\b/gi)].map((m) => [Number(m[1]), m[0]]);
}

/// Listing-vs-contents consistency — catches the classic failure where a
/// packer writes "600 RPG items" / "32x32" / "animated" on a listing that
/// doesn't match the actual emitted asset. Returns issue strings.
export function listingConsistency(
  listing: Pick<AssetListing, 'title' | 'description'> | undefined,
  meta: ShipMeta | undefined,
): string[] {
  if (!listing) return ['no listing.json — the packer has not packaged this asset'];
  const issues: string[] = [];
  const text = `${listing.title}\n${listing.description}`;
  const realItems = meta?.items ?? 1;
  const realSize = meta?.w ?? 0;
  for (const [claimed, phrase] of countClaims(text)) {
    if (claimed !== realItems) {
      issues.push(`listing claims "${phrase.trim()}" but the asset has ${realItems} item(s)`);
    }
  }
  for (const s of sizeClaims(text)) {
    if (realSize && s !== realSize) {
      issues.push(`listing says ${s}x${s} but the frames are ${realSize}x${realSize}`);
    }
  }
  // pack meta.frames is the TOTAL across items; a claim is consistent when it
  // is ≤ the per-item max OR equals that total ("54 frames at 6fps")
  const perItemMax = Math.max(0, ...(meta?.perItem ?? []).map((i) => i.frames));
  const realMaxFrames = perItemMax || (meta?.frames ?? 0);
  const totalFrames = meta?.frames ?? 0;
  for (const [claimed, phrase] of frameClaims(text)) {
    if (claimed > realMaxFrames && claimed !== totalFrames) {
      issues.push(`listing claims "${phrase.trim()}" but items have at most ${realMaxFrames || '?'} frames`);
    }
  }
  if (/\banimat/i.test(text)) {
    const animated =
      (meta?.frames ?? 0) > 1 || (meta?.perItem ?? []).some((i) => i.frames > 1);
    if (!animated) issues.push('listing promises animation but every item is a single frame');
  }
  return issues;
}

/// The ship gate. Everything must pass before a real upload happens.
export function shipEligibility(
  asset: Pick<Asset, 'status' | 'kind' | 'inspection' | 'listing' | 'channels'>,
  meta: ShipMeta | undefined,
  cfg: GumroadConfig,
  shippedToday: number,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (asset.channels?.gumroad?.productId) {
    issues.push('already shipped — updating an existing product is out of scope');
  }
  if (asset.status !== 'listed') issues.push(`status is ${asset.status}, needs "listed"`);
  if (cfg.packsOnly && asset.kind !== 'pack') issues.push('shop is packs-only (config)');
  if ((asset.inspection?.score ?? 0) < cfg.minScore) {
    issues.push(`inspection score ${asset.inspection?.score ?? '—'} < ${cfg.minScore}`);
  }
  if (shippedToday >= cfg.maxDraftsPerDay) {
    issues.push(`daily draft limit hit (${cfg.maxDraftsPerDay}/day) — try tomorrow`);
  }
  issues.push(...listingConsistency(asset.listing, meta));
  return { ok: issues.length === 0, issues };
}
