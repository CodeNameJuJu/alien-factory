// itch.io market research — READ ONLY. Fetches browse-feed JSON, parses the
// listing cells, snapshots them and analyses themes/prices for the scout.
// There is deliberately no publishing code anywhere in this repo; the mock
// market remains the only sales target.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_DIR } from './config.js';
import type { ItchAnalysis, ItchItem, ItchMover, ItchSnapshot, ItchTheme } from '../../shared/protocol.js';

type Json = any;

const UA = 'alien-factory-research/0.1 (personal market research)';
const REQ_GAP_MS = 1_500;
const REQ_TIMEOUT_MS = 15_000;
const CACHE_MS = 50 * 60_000; // raw pages reusable for 50 min
const SCAN_FLOOR_MS = 30 * 60_000; // a full scan at most every 30 min
const MANUAL_MIN_MS = 5 * 60_000; // manual scans still need 5 min
const KEEP_SNAPSHOTS = 30;

export const ITCH_DIR = join(FACTORY_DIR, 'market', 'itch');
const RAW_DIR = join(ITCH_DIR, 'raw');
const SNAP_DIR = join(ITCH_DIR, 'snapshots');

export interface ItchFeed {
  feed: string;
  pages: number;
}

export const DEFAULT_ITCH_FEEDS: ItchFeed[] = [
  { feed: 'game-assets/top-sellers/tag-pixel-art', pages: 2 },
  { feed: 'game-assets/new-and-popular/tag-pixel-art', pages: 2 },
  { feed: 'game-assets/newest/tag-pixel-art', pages: 1 },
  { feed: 'game-assets/top-sellers/tag-sprites', pages: 1 },
  { feed: 'game-assets/top-sellers/tag-tileset', pages: 1 },
  { feed: 'game-assets/top-sellers/tag-icons', pages: 1 },
  { feed: 'game-assets/top-sellers/tag-user-interface', pages: 1 },
  { feed: 'game-assets/top-rated/tag-pixel-art', pages: 1 },
];

export const FEED_RE = /^game-assets\/(top-sellers|top-rated|new-and-popular|newest)(\/tag-[a-z0-9-]+)?$/;

/// Validate a config itchFeeds value (string[] of feeds, optional "feed:N"
/// page counts). Falls back to defaults when nothing valid remains.
export function validateFeeds(raw: Json): ItchFeed[] {
  const out: ItchFeed[] = [];
  if (Array.isArray(raw)) {
    for (const f of raw) {
      if (typeof f === 'string') {
        const m = /^(.+?)(?::(\d+))?$/.exec(f);
        if (m && FEED_RE.test(m[1])) out.push({ feed: m[1], pages: Math.min(4, Math.max(1, Number(m[2]) || 1)) });
      } else if (f && typeof f.feed === 'string' && FEED_RE.test(f.feed)) {
        out.push({ feed: f.feed, pages: Math.min(4, Math.max(1, Number(f.pages) || 1)) });
      }
    }
  }
  return out.length ? out : DEFAULT_ITCH_FEEDS;
}

// ---- cell parsing (pure) -----------------------------------------------------

function unesc(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/// Parse the `content` html of an itch browse feed into listing items.
/// Pure string ops — no DOM dependency.
export function parseItchCells(html: string): ItchItem[] {
  // itch reorders attributes between requests (<div class="game_cell …"> vs
  // <div data-game_id=… class="game_cell …">) — split on the class anywhere.
  const starts = [...html.matchAll(/<div\b[^>]*class="game_cell /g)].map((m) => m.index!);
  const cells = starts.map((s, i) => html.slice(s, starts[i + 1]));
  const out: ItchItem[] = [];
  for (const cell of cells) {
    const id = /data-game_id="(\d+)"/.exec(cell)?.[1] ?? '';
    // attribute order varies between feeds — match the anchor by class
    const tm = /<a\b[^>]*class="title game_link"[^>]*>([\s\S]*?)<\/a>/.exec(cell);
    const url = tm && /href="([^"]+)"/.exec(tm[0]);
    if (!tm || !url) continue;
    const blurb =
      /<div\b[^>]*class="game_text"[^>]*>([\s\S]*?)<\/div>/.exec(cell)?.[1] ??
      /<div\b[^>]*class="game_text"[^>]*title="([^"]*)"/.exec(cell)?.[1] ??
      /<div\b[^>]*title="([^"]*)"[^>]*class="game_text"/.exec(cell)?.[1] ??
      '';
    const author = /<div\b[^>]*class="game_author"><a\b[^>]*>([\s\S]*?)<\/a>/.exec(cell)?.[1] ?? '';
    const priceRaw = /class="price_value"[^>]*>([^<]*)</.exec(cell)?.[1]?.trim() ?? null;
    let price: number | null = null;
    let currency: string | null = null;
    if (priceRaw) {
      // "$2.50", "4.97€", "€3.00" — symbol before or after the number
      const pm = /^([^\d\s.,]+)?\s*([\d.,]+)\s*([^\d\s]+)?$/.exec(priceRaw);
      if (pm) {
        currency = pm[1] ?? pm[3] ?? null;
        price = Number(pm[2].replace(',', '.'));
        if (!Number.isFinite(price)) price = null;
      }
    }
    const salePct = /<div class="sale_tag">-(\d+)%<\/div>/.exec(cell)?.[1];
    const thumb = /data-lazy_src="([^"]+)"/.exec(cell)?.[1] ?? /<img[^>]+src="([^"]+)"/.exec(cell)?.[1] ?? '';
    out.push({
      id,
      title: unesc(tm[1]),
      url: unesc(url[1]),
      blurb: unesc(blurb.replace(/<[^>]+>/g, '')),
      author: unesc(author),
      price,
      currency,
      salePct: salePct ? Number(salePct) : null,
      free: !priceRaw,
      thumb,
    });
  }
  return out;
}

// ---- fetching ----------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rawPath(feed: string, page: number): string {
  return join(RAW_DIR, `${feed.replace(/\//g, '_')}-p${page}.json`);
}

/// HTTP-level failure — carries the status + parsed Retry-After so the
/// scanner can back off politely on 429/5xx.
export class ItchHttpError extends Error {
  constructor(
    public status: number,
    public feed: string,
    public page: number,
    public retryAfterMs: number | null,
  ) {
    super(`itch ${status} for ${feed} p${page}`);
  }
}

async function fetchPage(feed: string, page: number): Promise<Json> {
  mkdirSync(RAW_DIR, { recursive: true });
  const p = rawPath(feed, page);
  try {
    const st = Number(JSON.parse(readFileSync(join(p + '.meta'), 'utf8')).at) || 0;
    if (Date.now() - st < CACHE_MS && existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf8'));
    }
  } catch {
    /* stale/absent cache */
  }
  const url = `https://itch.io/${feed}?format=json&page=${page}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) {
      throw new ItchHttpError(res.status, feed, page, parseRetryAfter(res.headers.get('retry-after')));
    }
    const json = await res.json();
    writeFileSync(p, JSON.stringify(json));
    writeFileSync(p + '.meta', JSON.stringify({ at: Date.now(), url }));
    return json;
  } finally {
    clearTimeout(timer);
  }
}

let lastScanAt = 0;

/// Restore the scan clock from persisted state (survives server restarts).
export function setLastScanAt(at: number): void {
  lastScanAt = at;
}

// ---- 429/5xx backoff ----------------------------------------------------------
//
// itch.io throttles bursts. On a 429/5xx we stop the whole scan and stay
// quiet until `backoffUntil`: Retry-After when the server gives one, else
// exponential 30m → 1h → 2h → … capped at 6h. A successful scan resets it.
// Persisted so restarts keep backing off.

const BACKOFF_BASE_MS = 30 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
const BACKOFF_PATH = join(ITCH_DIR, 'backoff.json');
let backoffUntil = 0;
let backoffStep = 0;
let backoffLoaded = false;

/// `Retry-After` can be seconds ("120") or an HTTP date — returns ms or null.
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/// Pure backoff calculation — injectable `now` for tests.
export function nextBackoff(
  step: number,
  retryAfterMs: number | null,
  now = Date.now(),
): { until: number; step: number } {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** step);
  const ms = retryAfterMs != null && retryAfterMs > 0 ? Math.min(BACKOFF_MAX_MS, retryAfterMs) : exp;
  return { until: now + ms, step: step + 1 };
}

function loadBackoff(): void {
  if (backoffLoaded) return;
  backoffLoaded = true;
  try {
    const b = JSON.parse(readFileSync(BACKOFF_PATH, 'utf8')) as { until?: number; step?: number };
    backoffUntil = b.until ?? 0;
    backoffStep = b.step ?? 0;
  } catch { /* none */ }
}

function persistBackoff(): void {
  try {
    mkdirSync(ITCH_DIR, { recursive: true });
    writeFileSync(BACKOFF_PATH, JSON.stringify({ until: backoffUntil, step: backoffStep }));
  } catch { /* best effort */ }
}

/// Restore a persisted/tested backoff (server restart, unit tests).
export function setBackoffUntil(until: number, step = 0): void {
  backoffUntil = until;
  backoffStep = step;
  backoffLoaded = true;
  persistBackoff();
}

export function getBackoffUntil(): number {
  loadBackoff();
  return backoffUntil;
}

/// Human-readable backoff message, e.g. for itch.error / refusals.
export function backoffMessage(now = Date.now()): string | null {
  loadBackoff();
  if (now >= backoffUntil) return null;
  const d = new Date(backoffUntil);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `itch.io rate-limited us — backing off until ${hhmm}`;
}

function noteHttpFailure(err: ItchHttpError): void {
  if (err.status !== 429 && err.status < 500) return;
  const b = nextBackoff(backoffStep, err.retryAfterMs);
  backoffUntil = b.until;
  backoffStep = b.step;
  persistBackoff();
}

/// Rate-limit check. Manual scans still need MANUAL_MIN_MS since the last;
/// EVERY entry point honours the 429/5xx backoff window.
export function scanAllowed(manual: boolean): { ok: boolean; retryAfterMs: number; reason?: string } {
  loadBackoff();
  const msg = backoffMessage();
  if (msg) return { ok: false, retryAfterMs: backoffUntil - Date.now(), reason: msg };
  const floor = manual ? MANUAL_MIN_MS : SCAN_FLOOR_MS;
  const wait = floor - (Date.now() - lastScanAt);
  return { ok: wait <= 0, retryAfterMs: Math.max(0, wait) };
}

/// Run a full polite scan: sequential pages, ≥1.5 s between requests.
/// Returns the snapshot (also written to snapshots/<iso>.json).
export async function scanFeeds(feeds: ItchFeed[]): Promise<{ snapshot: ItchSnapshot; requests: number }> {
  const gate = scanAllowed(false);
  if (!gate.ok) throw new Error(gate.reason ?? 'scan rate-limited');
  lastScanAt = Date.now();
  const out: Record<string, ItchItem[]> = {};
  let requests = 0;
  let first = true;
  try {
    for (const { feed, pages } of feeds) {
      const items: ItchItem[] = [];
      for (let page = 1; page <= pages; page++) {
        if (!first) await sleep(REQ_GAP_MS);
        first = false;
        const json = await fetchPage(feed, page);
        requests++;
        for (const it of parseItchCells(String(json?.content ?? ''))) {
          it.rank = items.length + 1;
          items.push(it);
        }
      }
      out[feed] = items;
    }
  } catch (err) {
    // a 429/5xx ends the scan NOW — no further requests this scan
    if (err instanceof ItchHttpError) noteHttpFailure(err);
    throw err;
  }
  // clean pass → reset the backoff ladder
  if (backoffStep || backoffUntil) {
    backoffUntil = 0;
    backoffStep = 0;
    persistBackoff();
  }
  const snapshot: ItchSnapshot = { at: Date.now(), feeds: out };
  mkdirSync(SNAP_DIR, { recursive: true });
  const name = `${new Date(snapshot.at).toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(SNAP_DIR, name), JSON.stringify(snapshot, null, 2));
  // prune
  const files = readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS))) {
    try {
      rmSync(join(SNAP_DIR, f));
    } catch {
      /* ignore */
    }
  }
  return { snapshot, requests };
}

/// Latest snapshot on disk (for delta computation), excluding `at`.
export function latestSnapshot(excludeAt?: number): ItchSnapshot | null {
  try {
    const files = readdirSync(SNAP_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files) {
      const s = JSON.parse(readFileSync(join(SNAP_DIR, f), 'utf8')) as ItchSnapshot;
      if (s.at && s.at !== excludeAt) return s;
    }
  } catch {
    /* none */
  }
  return null;
}

// ---- analysis (pure) -----------------------------------------------------------

/// feed kind → weight (top-sellers rank > new-and-popular > newest)
function feedWeight(feed: string): number {
  if (feed.includes('top-sellers')) return 1.0;
  if (feed.includes('top-rated')) return 0.8;
  if (feed.includes('new-and-popular')) return 0.6;
  return 0.4;
}

const THEMES: [string, RegExp][] = [
  ['tileset', /tile ?sets?|tiles\b/i],
  ['character', /characters?|protagonist|hero\b|npc\b|sprite ?sheet/i],
  ['monster', /monsters?|enem(?:y|ies)|boss\b|creatures?|slimes?/i],
  ['ui', /\bui\b|\bgui\b|hud|interface|menus?|buttons?|cursor/i],
  ['icons', /icons?/i],
  ['weapons', /weapons?|swords?|guns?|bows?|axes?/i],
  ['items', /\bitems?\b|props|objects|loot/i],
  ['farming', /farm(?:ing)?|crops?|harvest/i],
  ['dungeon', /dungeon|caves?|crypt|castle/i],
  ['scifi', /sci-?fi|space|aliens?|cyber|spaceships?/i],
  ['platformer', /platform(?:er|ing)?s?/i],
  ['topdown', /top[- ]?down/i],
  ['rpg', /\b(?:j?rpg)\b|fantasy/i],
  ['horror', /horror|spooky|zombies?/i],
  ['cozy', /cozy|cosy|cute|kawaii|pastel/i],
  ['fx', /\b(?:v?fx)\b|particles?|effects?|explosions?/i],
  ['food', /food|fruits?|kitchen/i],
  ['nature', /trees?|nature|plants?|forest|foliage/i],
  ['vehicles', /vehicles?|cars?|trucks?|boats?\b/i],
  ['portraits', /portraits?|avatars?|faces?\b/i],
  ['cards', /\bcards?\b|deck/i],
  ['1-bit', /\b1[- ]?bits?\b|monochrome/i],
  ['isometric', /isometric|isometry/i],
  ['pixel-art', /pixel ?art/i],
  ['low-res', /low[- ]?res/i],
  ['8x8', /(?<![\d])8x8(?![\d])/i],
  ['16x16', /(?<![\d])16x16(?![\d])/i],
  ['32x32', /(?<![\d])32x32(?![\d])/i],
  ['48x48', /(?<![\d])48x48(?![\d])/i],
  ['64x64', /(?<![\d])64x64(?![\d])/i],
];

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pct(nums: number[], q: number): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/// Compare the current snapshot with the previous one: theme scores,
/// movers, price stats. Pure — drives the report + the trends drawer.
export function analyseSnapshot(curr: ItchSnapshot, prev?: ItchSnapshot | null): ItchAnalysis {
  interface Acc {
    score: number;
    count: number;
    top: number;
    nap: number;
    prices: number[];
    free: number;
  }
  const themes = new Map<string, Acc>();
  const bump = (key: string, item: ItchItem, feed: string, w: number) => {
    let a = themes.get(key);
    if (!a) themes.set(key, (a = { score: 0, count: 0, top: 0, nap: 0, prices: [], free: 0 }));
    a.score += w;
    a.count++;
    if (feed.includes('top-sellers')) a.top++;
    if (feed.includes('new-and-popular')) a.nap++;
    if (item.price != null) a.prices.push(item.price);
    if (item.free) a.free++;
  };

  const prevScores = new Map<string, number>();
  if (prev) {
    const prevAcc = new Map<string, number>();
    for (const [feed, items] of Object.entries(prev.feeds)) {
      const fw = feedWeight(feed);
      for (const it of items) {
        const w = fw * (1 - (it.rank ?? 20) / 40);
        const text = `${it.title} ${it.blurb}`;
        for (const [key, re] of THEMES) {
          if (re.test(text)) prevAcc.set(key, (prevAcc.get(key) ?? 0) + w);
        }
      }
    }
    for (const [k, v] of prevAcc) prevScores.set(k, +v.toFixed(2));
  }

  const allPrices: number[] = [];
  let allCount = 0;
  let allFree = 0;
  let allSale = 0;
  for (const [feed, items] of Object.entries(curr.feeds)) {
    const fw = feedWeight(feed);
    for (const it of items) {
      allCount++;
      if (it.price != null) allPrices.push(it.price);
      if (it.free) allFree++;
      if (it.salePct != null) allSale++;
      const w = fw * (1 - (it.rank ?? 20) / 40);
      const text = `${it.title} ${it.blurb}`;
      for (const [key, re] of THEMES) {
        if (re.test(text)) bump(key, it, feed, w);
      }
    }
  }

  const themeList: ItchTheme[] = [...themes.entries()]
    .map(([key, a]) => {
      const score = +a.score.toFixed(2);
      const before = prevScores.get(key);
      return {
        key,
        score,
        count: a.count,
        inTopSellers: a.top,
        inNewAndPopular: a.nap,
        medianPrice: a.prices.length ? median(a.prices) : null,
        pctFree: +((a.free / a.count) * 100).toFixed(0),
        delta: before === undefined ? null : +(score - before).toFixed(2),
      };
    })
    .sort((a, b) => b.score - a.score);

  // movers: top-seller newcomers, big rank climbs, n&p newcomers
  const movers: ItchMover[] = [];
  const topFeed = 'game-assets/top-sellers/tag-pixel-art';
  const napFeed = 'game-assets/new-and-popular/tag-pixel-art';
  const prevTop = new Map((prev?.feeds[topFeed] ?? []).map((i) => [i.id, i.rank ?? 0]));
  for (const it of curr.feeds[topFeed] ?? []) {
    const before = prevTop.get(it.id);
    if (prev && before === undefined) {
      movers.push({ title: it.title, url: it.url, kind: 'new_top_seller', detail: `#${it.rank}` });
    } else if (before !== undefined && before - (it.rank ?? 0) >= 10) {
      movers.push({ title: it.title, url: it.url, kind: 'climbed', detail: `#${before} → #${it.rank}` });
    }
  }
  const prevNap = new Set((prev?.feeds[napFeed] ?? []).map((i) => i.id));
  if (prev) {
    for (const it of (curr.feeds[napFeed] ?? []).slice(0, 15)) {
      if (!prevNap.has(it.id)) movers.push({ title: it.title, url: it.url, kind: 'new_popular', detail: `#${it.rank}` });
    }
  }

  return {
    at: curr.at,
    themes: themeList,
    movers,
    priceStats: {
      median: median(allPrices),
      p25: pct(allPrices, 0.25),
      p75: pct(allPrices, 0.75),
      pctFree: allCount ? +((allFree / allCount) * 100).toFixed(0) : 0,
      pctOnSale: allCount ? +((allSale / allCount) * 100).toFixed(0) : 0,
      count: allCount,
    },
    topSellers: (curr.feeds[topFeed] ?? []).slice(0, 20),
    newAndPopular: (curr.feeds[napFeed] ?? []).slice(0, 15),
  };
}

// ---- report ----------------------------------------------------------------

const money = (n: number | null, cur = '$') => (n == null ? 'free' : `${cur}${n.toFixed(2)}`);

/// Deterministic markdown report the scout reads — reports/itch-latest.md.
export function writeItchReport(analysis: ItchAnalysis): string {
  const L: string[] = [];
  L.push('# itch.io game-assets — market research');
  L.push(`scan: ${new Date(analysis.at).toISOString()} · items: ${analysis.priceStats.count}`);
  L.push('');
  L.push('## Themes (weighted score across feeds; top-sellers rank weighs most)');
  L.push('| theme | score | Δ | items | top-sellers | median price | % free |');
  L.push('|---|---|---|---|---|---|---|');
  for (const t of analysis.themes.slice(0, 25)) {
    L.push(
      `| ${t.key} | ${t.score} | ${t.delta == null ? '—' : (t.delta > 0 ? '+' : '') + t.delta} | ${t.count} | ${t.inTopSellers} | ${money(t.medianPrice)} | ${t.pctFree}% |`,
    );
  }
  L.push('');
  L.push('## Movers');
  if (!analysis.movers.length) L.push('(first scan — no baseline yet)');
  for (const m of analysis.movers.slice(0, 15)) {
    L.push(`- ${m.kind === 'new_top_seller' ? 'NEW top-seller' : m.kind === 'climbed' ? 'climbing' : 'new & popular'}: [${m.title}](${m.url}) ${m.detail}`);
  }
  L.push('');
  L.push('## Prices');
  const p = analysis.priceStats;
  L.push(`median ${money(p.median)} · p25 ${money(p.p25)} · p75 ${money(p.p75)} · ${p.pctFree}% free/PWYW · ${p.pctOnSale}% on sale`);
  L.push('');
  L.push('## Top sellers (pixel art)');
  for (const it of analysis.topSellers) {
    L.push(`- #${it.rank} [${it.title}](${it.url}) — ${it.author} · ${money(it.price, it.currency ?? '$')}${it.salePct ? ` (−${it.salePct}%)` : ''} — ${it.blurb}`);
  }
  L.push('');
  L.push('## New & popular (pixel art)');
  for (const it of analysis.newAndPopular) {
    L.push(`- #${it.rank} [${it.title}](${it.url}) — ${money(it.price, it.currency ?? '$')} — ${it.blurb}`);
  }
  const md = L.join('\n') + '\n';
  mkdirSync(join(FACTORY_DIR, 'reports'), { recursive: true });
  writeFileSync(join(FACTORY_DIR, 'reports', 'itch-latest.md'), md);
  return md;
}
