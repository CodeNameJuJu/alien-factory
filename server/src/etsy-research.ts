// Etsy market research: polite keyword scans of Etsy's own search
// (findAllListingsActive, api-key only), cached raw responses, snapshots,
// a pure per-keyword analysis and the reports/etsy-latest.md the analyst
// reads. Mirrors itch.ts's shape: sequential requests, honest cadence,
// everything cached under factory/market/etsy/.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_DIR } from './config.js';
import { EtsyClient } from './channels/etsy.js';

/// raw keyword responses reusable for 6h
const RAW_CACHE_MS = 6 * 3_600_000;
/// automatic scans at least this far apart
const AUTO_SCAN_MS = 6 * 3_600_000;
/// the manual [ scan etsy ] floor
const MANUAL_SCAN_MS = 30 * 60_000;
/// politeness: keyword queries are at least 1s apart
const KEYWORD_GAP_MS = 1_000;
const PER_KEYWORD = 50;
const SNAPSHOTS_KEPT = 30;

export const ETSY_MARKET_DIR = join(FACTORY_DIR, 'market', 'etsy');
const RAW_DIR = join(ETSY_MARKET_DIR, 'raw');
const SNAP_DIR = join(ETSY_MARKET_DIR, 'snapshots');

let lastScanAt = 0;
let lastAttemptAt = 0;
export function setEtsyLastScanAt(at: number): void {
  if (at > lastScanAt) lastScanAt = at;
}
/// Every scan attempt counts — a failed scan must not loop back into
/// another request straight away.
export function noteEtsyScanAttempt(at = Date.now()): void {
  if (at > lastAttemptAt) lastAttemptAt = at;
}

/// Mirrors scanAllowed: manual scans have a 30-min floor, automatic ones
/// 6h after the last SUCCESS — and every attempt (success or failure) puts
/// a 30-min floor on the next one. Pure: the state is injected so tests
/// don't depend on module timers.
export function etsyScanAllowed(
  manual: boolean,
  now = Date.now(),
  state: { lastScanAt: number | null; lastAttemptAt: number | null } = {
    lastScanAt: lastScanAt || null,
    lastAttemptAt: lastAttemptAt || null,
  },
): { ok: boolean; retryAfterMs: number } {
  const floor = manual ? MANUAL_SCAN_MS : AUTO_SCAN_MS;
  const waitScan = (state.lastScanAt ?? 0) + floor - now;
  const waitAttempt = (state.lastAttemptAt ?? 0) + MANUAL_SCAN_MS - now;
  const wait = Math.max(waitScan, waitAttempt);
  return { ok: wait <= 0, retryAfterMs: Math.max(0, wait) };
}

// ---- listing shape (verified against the OAS ShopListing schema) -----------

export interface EtsyListing {
  listing_id: number;
  title: string;
  url?: string;
  priceUsd: number | null;
  num_favorers: number;
  tags: string[];
  createdAtMs: number | null;
  shop_id?: number;
}

const moneyUsd = (price: unknown): number | null => {
  const p = price as { amount?: number; divisor?: number; currency_code?: string } | undefined;
  if (!p || p.currency_code !== 'USD' || typeof p.amount !== 'number' || !p.divisor) return null;
  return p.amount / p.divisor;
};

function toListing(raw: Record<string, unknown>): EtsyListing | null {
  const id = Number(raw.listing_id);
  if (!Number.isFinite(id) || typeof raw.title !== 'string') return null;
  const created = Number(raw.original_creation_timestamp ?? raw.creation_timestamp);
  return {
    listing_id: id,
    title: raw.title,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    priceUsd: moneyUsd(raw.price),
    num_favorers: Number(raw.num_favorers) || 0,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    createdAtMs: Number.isFinite(created) && created > 0 ? created * 1000 : null,
    shop_id: Number(raw.shop_id) || undefined,
  };
}

export interface EtsyKeywordResult {
  keyword: string;
  count: number;
  results: EtsyListing[];
}

const slug = (kw: string): string => kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/// One keyword's raw response (6h cache under market/etsy/raw/).
async function fetchKeyword(
  client: EtsyClient,
  keyword: string,
): Promise<{ count: number; results: EtsyListing[] }> {
  const path = join(RAW_DIR, `${slug(keyword)}.json`);
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as { at: number; body: Record<string, unknown> };
    if (Date.now() - cached.at < RAW_CACHE_MS) {
      return {
        count: Number(cached.body.count) || 0,
        results: (Array.isArray(cached.body.results) ? cached.body.results : []).map(toListing).filter((l): l is EtsyListing => !!l),
      };
    }
  } catch {
    /* refetch */
  }
  const body = await client.findAllListingsActive({ keywords: keyword, limit: PER_KEYWORD, sort_on: 'score' });
  try {
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ at: Date.now(), body }));
  } catch {
    /* best effort */
  }
  return {
    count: Number(body.count) || 0,
    results: (Array.isArray(body.results) ? body.results : []).map(toListing).filter((l): l is EtsyListing => !!l),
  };
}

/// Sequential keyword scan — ≥1s between requests. Writes a snapshot and
/// trims old ones. Returns per-keyword results.
export async function scanEtsyKeywords(
  keywords: string[],
  opts: { client?: EtsyClient; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ byKeyword: EtsyKeywordResult[]; at: number }> {
  const client = opts.client ?? new EtsyClient();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const byKeyword: EtsyKeywordResult[] = [];
  for (const kw of keywords) {
    if (byKeyword.length) await sleep(KEYWORD_GAP_MS);
    const r = await fetchKeyword(client, kw);
    byKeyword.push({ keyword: kw, count: r.count, results: r.results });
  }
  const at = Date.now();
  try {
    mkdirSync(SNAP_DIR, { recursive: true });
    const name = `${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(join(SNAP_DIR, name), JSON.stringify({ at, byKeyword }, null, 2));
    const snaps = readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of snaps.slice(0, Math.max(0, snaps.length - SNAPSHOTS_KEPT))) {
      try {
        rmSync(join(SNAP_DIR, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best effort */
  }
  return { byKeyword, at };
}

// ---- analysis (pure) -----------------------------------------------------------

export interface EtsyKeywordAnalysis {
  keyword: string;
  count: number;
  priceMedian: number | null;
  priceP25: number | null;
  priceP75: number | null;
  medianFav: number | null;
  maxFav: number;
  topTags: { tag: string; n: number }[];
  /// share of sampled listings created in the last 90 days
  newcomerShare: number | null;
  topListings: { title: string; priceUsd: number | null; favs: number; url?: string; ageDays: number | null }[];
  /// demand heuristic: medianFav * medianPrice / log10(count + 10)
  score: number | null;
}

const quantile = (sorted: number[], q: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;

/// Pure per-keyword stats. USD listings only for prices; newcomer share
/// uses the listing creation timestamps; top 15 tags / top 8 listings.
export function analyseEtsyResults(byKeyword: EtsyKeywordResult[], now = Date.now()): EtsyKeywordAnalysis[] {
  const NEW_MS = 90 * 24 * 3_600_000;
  return byKeyword.map(({ keyword, count, results }) => {
    const prices = results.map((l) => l.priceUsd).filter((p): p is number => p !== null && p > 0).sort((a, b) => a - b);
    const favs = results.map((l) => l.num_favorers).sort((a, b) => a - b);
    const tagCount = new Map<string, number>();
    for (const l of results) for (const t of l.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const topTags = [...tagCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 15)
      .map(([tag, n]) => ({ tag, n }));
    const dated = results.filter((l) => l.createdAtMs !== null);
    const fresh = dated.filter((l) => now - l.createdAtMs! <= NEW_MS).length;
    const topListings = [...results]
      .sort((a, b) => b.num_favorers - a.num_favorers)
      .slice(0, 8)
      .map((l) => ({
        title: l.title,
        priceUsd: l.priceUsd,
        favs: l.num_favorers,
        url: l.url,
        ageDays: l.createdAtMs !== null ? Math.floor((now - l.createdAtMs) / 86_400_000) : null,
      }));
    const medianFav = quantile(favs, 0.5);
    const priceMedian = quantile(prices, 0.5);
    const score =
      medianFav !== null && priceMedian !== null && count > 0
        ? (medianFav * priceMedian) / Math.log10(count + 10)
        : null;
    return {
      keyword,
      count,
      priceMedian,
      priceP25: quantile(prices, 0.25),
      priceP75: quantile(prices, 0.75),
      medianFav,
      maxFav: favs.length ? favs[favs.length - 1] : 0,
      topTags,
      newcomerShare: dated.length ? fresh / dated.length : null,
      topListings,
      score,
    };
  });
}

// ---- report -----------------------------------------------------------------

const usd = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);
const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/// reports/etsy-latest.md — the analyst's brief: per keyword the market
/// size, price spread, demand signals, common tags and top listings.
export function writeEtsyReport(analysis: EtsyKeywordAnalysis[], at: number): string {
  const lines: string[] = [];
  lines.push(`# Etsy market research — ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');
  lines.push('Active-listing search per keyword (api findAllListingsActive, limit 50, sort score).');
  lines.push('Score = medianFav × medianPrice / log10(count+10) — a demand heuristic, not a sales figure.');
  lines.push('');
  for (const k of [...analysis].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    lines.push(`## ${k.keyword} — ${k.count.toLocaleString()} active listings · score ${k.score === null ? '—' : k.score.toFixed(2)}`);
    lines.push(
      `price median ${usd(k.priceMedian)} (p25 ${usd(k.priceP25)} / p75 ${usd(k.priceP75)}) · ` +
        `favourites median ${k.medianFav ?? '—'}, max ${k.maxFav} · newcomers (<90d) ${pct(k.newcomerShare)}`,
    );
    if (k.topTags.length) lines.push(`common tags: ${k.topTags.map((t) => `${t.tag} (${t.n})`).join(', ')}`);
    if (k.topListings.length) {
      lines.push('top listings by favourites:');
      for (const l of k.topListings) {
        lines.push(
          `- ${l.title} — ${usd(l.priceUsd)} · ${l.favs} favs${l.ageDays !== null ? ` · ${l.ageDays}d old` : ''}${l.url ? ` · ${l.url}` : ''}`,
        );
      }
    }
    lines.push('');
  }
  const md = lines.join('\n');
  try {
    mkdirSync(join(FACTORY_DIR, 'reports'), { recursive: true });
    writeFileSync(join(FACTORY_DIR, 'reports', 'etsy-latest.md'), md);
  } catch {
    /* best effort */
  }
  return md;
}
