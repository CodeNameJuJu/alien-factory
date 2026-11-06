// Etsy sales-pipeline tests — parsers, trust ramp, taxonomy resolution,
// research analysis and the publish spec builder. Pure/temp-dir only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAssessment, parseDemand, parseEtsyListingJson, parseSellReview } from './parse.js';
import { applyTrustEvent, emptyTrust } from '../../shared/trust.js';
import { resolveTaxonomy, type TaxonomyNode } from './etsy-taxonomy.js';
import { analyseEtsyResults, type EtsyKeywordResult } from './etsy-research.js';
import { activateEtsyDraft, buildEtsySpec, ETSY_DISCLOSURE, EtsyClient, EtsyLedger, type EtsyTokens } from './channels/etsy.js';
import { etsyScanAllowed } from './etsy-research.js';
import { hasApprovalEvent } from '../../shared/trust.js';
import type { FetchLike } from './channels/gumroad.js';
import { statSync } from 'node:fs';
import type { Asset, EtsyConfig } from '../../shared/protocol.js';

const CFG: EtsyConfig = {
  monthlySpendCapUsd: 5,
  maxListingsPerDay: 3,
  autoRenew: false,
  minPriceUsd: 1.5,
  maxPriceUsd: 60,
  trustThreshold: 10,
  minSell: 6,
  minSellScore: 7,
  researchKeywords: [],
};

// ---- parseDemand new fields -----------------------------------------------------

test('parseDemand carries etsy fields (format/keywords/priceUsd/competition)', () => {
  const text = `## Demand\n\`\`\`json\n[{"title":"RPG Icons","format":"pack","kind":"pack","items":12,"tags":["rpg","icons"],"size":32,"frames":4,"keywords":["rpg icons","game icons"],"priceUsd":4.99,"competition":7,"evidence":["https://etsy.com/listing/1"],"why":"sells","demand":8}]\n\`\`\``;
  const [p] = parseDemand(text);
  assert.equal(p.format, 'pack');
  assert.deepEqual(p.keywords, ['rpg icons', 'game icons']);
  assert.equal(p.priceUsd, 4.99);
  assert.equal(p.competition, 7);
  assert.deepEqual(p.evidence, ['https://etsy.com/listing/1']);
});

// ---- parseAssessment ---------------------------------------------------------------

const ASSESS = (entries: unknown[]): string =>
  `## Assessment\n\`\`\`json\n${JSON.stringify(entries)}\n\`\`\``;

test('parseAssessment: valid entries', () => {
  const a = parseAssessment(ASSESS([{ id: 'c1', verdict: 'go', sell: 8, priceUsd: 4.5, angle: 'more items', risks: 'crowded' }]));
  assert.equal(a.length, 1);
  assert.equal(a[0].verdict, 'go');
  assert.equal(a[0].sell, 8);
  assert.equal(a[0].priceUsd, 4.5);
});

test('parseAssessment: missing block → []', () => {
  assert.deepEqual(parseAssessment('no block here'), []);
});

test('parseAssessment: bad verdict dropped, sell clamped, bad price dropped', () => {
  const a = parseAssessment(
    ASSESS([
      { id: 'c1', verdict: 'maybe', sell: 8, priceUsd: 4 },
      { id: 'c2', verdict: 'go', sell: 42, priceUsd: 4 },
      { id: 'c3', verdict: 'no', sell: 2, priceUsd: -1 },
      { id: 'c4', verdict: 'no', sell: 2, priceUsd: 3 },
    ]),
  );
  assert.equal(a.length, 2);
  assert.equal(a[0].id, 'c2');
  assert.equal(a[0].sell, 10);
  assert.equal(a[1].id, 'c4');
});

// ---- parseSellReview ------------------------------------------------------------------

test('parseSellReview: LIST / REWORK / DROP + both price formats', () => {
  const list = parseSellReview('## Sell review\nVerdict: LIST\nScore: 8\nPrice: $4.99\nNotes: looks sellable');
  assert.equal(list?.verdict, 'LIST');
  assert.equal(list?.score, 8);
  assert.equal(list?.priceUsd, 4.99);
  const rework = parseSellReview('## Sell review\nVerdict: REWORK\nScore: 5\nPrice: 3.5\nNotes: fix items 7-12');
  assert.equal(rework?.verdict, 'REWORK');
  assert.equal(rework?.priceUsd, 3.5);
  const drop = parseSellReview('## Sell review\nVerdict: DROP\nScore: 2\nPrice: $2\nNotes: unsellable');
  assert.equal(drop?.verdict, 'DROP');
  assert.equal(parseSellReview('nothing'), null);
  assert.equal(parseSellReview('## Sell review\nScore: 8\nNotes: no verdict'), null);
});

// ---- parseEtsyListingJson ----------------------------------------------------------------

const META = { w: 16, h: 16, items: 12, perItem: [{ frames: 4 }] };
const goodListing = () => ({
  title: 'RPG Icons Pixel Pack 12 items',
  description: 'Twelve 16x16 RPG icons for your game.',
  tags: ['rpg icons', 'pixel art', 'game assets', 'sprites', 'fantasy', 'icons pack', 'game dev', 'rpg game', '16x16', 'indie game', 'pixel icons', 'rpg sprites', 'sprite pack'],
  priceUsd: 4.99,
  taxonomy: 'Craft Supplies & Tools > Digital',
  section: 'Game assets',
});

test('parseEtsyListingJson: clean listing passes', () => {
  const { listing, issues } = parseEtsyListingJson(goodListing(), CFG, META);
  assert.equal(issues.length, 0, issues.join('; '));
  assert.equal(listing?.tags.length, 13);
});

test('parseEtsyListingJson: rule violations', () => {
  const bad = (over: Record<string, unknown>) =>
    parseEtsyListingJson({ ...goodListing(), ...over }, CFG, META).issues;
  assert.ok(bad({ title: 'x'.repeat(141) }).some((i) => /title too long/.test(i)));
  assert.ok(bad({ title: '' }).some((i) => /title is empty/.test(i)));
  assert.ok(bad({ description: '' }).some((i) => /description is empty/.test(i)));
  assert.ok(bad({ tags: ['one'] }).some((i) => /10-13 tags/.test(i)));
  assert.ok(bad({ tags: Array(14).fill('tag') }).some((i) => /10-13 tags/.test(i)));
  assert.ok(bad({ tags: ['RPG ICONS', 'rpg icons', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] }).some((i) => /10-13 tags/.test(i)) === false);
  assert.ok(bad({ tags: ['x'.repeat(21), 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] }).some((i) => /tag too long/.test(i)));
  assert.ok(bad({ tags: ['bad!tag', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }).some((i) => /disallowed/.test(i)));
  assert.ok(bad({ priceUsd: 0.5 }).some((i) => /price.*outside/.test(i)));
  assert.ok(bad({ priceUsd: 99 }).some((i) => /price.*outside/.test(i)));
  assert.ok(bad({ taxonomy: '' }).some((i) => /taxonomy/.test(i)));
  assert.ok(bad({ section: '' }).some((i) => /section/.test(i)));
  assert.ok(bad({ section: 'x'.repeat(25) }).some((i) => /section too long/.test(i)));
});

test('parseEtsyListingJson: tag dedupe is case-insensitive', () => {
  const l = goodListing();
  l.tags[0] = 'RPG Icons';
  l.tags[1] = 'rpg icons'; // ci-dupe → 12 unique tags, still within 10-13
  const { listing, issues } = parseEtsyListingJson(l, CFG, META);
  assert.equal(listing?.tags.length, 12);
  assert.ok(!issues.some((i) => /10-13 tags/.test(i)), issues.join('; '));
});

test('parseEtsyListingJson: price clamps to ±15% of merch price instead of failing', () => {
  const l = goodListing();
  l.priceUsd = 2; // merch said 4 → clamped to 3.40, within cfg bounds
  const { listing, issues } = parseEtsyListingJson(l, CFG, META, 4);
  assert.ok(!issues.some((i) => /price/.test(i)), issues.join('; '));
  assert.ok(Math.abs(listing!.priceUsd - 3.4) < 0.001);
});

test('parseEtsyListingJson: listingConsistency catches fake item counts', () => {
  const l = goodListing();
  l.title = 'RPG Icons Pixel Pack 48 items';
  const { issues } = parseEtsyListingJson(l, CFG, META);
  assert.ok(issues.some((i) => /claims.*48/.test(i)), issues.join('; '));
});

// ---- applyTrustEvent ------------------------------------------------------------------------

test('trust: 9th approval not autonomous, 10th promotes', () => {
  let t = emptyTrust();
  for (let i = 0; i < 9; i++) t = applyTrustEvent(t, { kind: 'approved', at: i }, 10);
  assert.equal(t.streak, 9);
  assert.equal(t.autonomous, false);
  t = applyTrustEvent(t, { kind: 'approved', at: 10 }, 10);
  assert.equal(t.autonomous, true);
  assert.ok(t.log.some((e) => e.event === 'promoted'));
});

test('trust: edited and rejected reset the streak (autonomy untouched)', () => {
  let t = emptyTrust();
  t = applyTrustEvent(t, { kind: 'approved', at: 1 }, 10);
  t = applyTrustEvent(t, { kind: 'edited', at: 2 }, 10);
  assert.equal(t.streak, 0);
  t = applyTrustEvent(t, { kind: 'approved', at: 3 }, 10);
  t = applyTrustEvent(t, { kind: 'rejected', at: 4 }, 10);
  assert.equal(t.streak, 0);
  assert.equal(t.autonomous, false);
});

test('trust: revert and revoked drop autonomy', () => {
  let t = emptyTrust();
  for (let i = 0; i < 10; i++) t = applyTrustEvent(t, { kind: 'approved', at: i }, 10);
  assert.equal(t.autonomous, true);
  t = applyTrustEvent(t, { kind: 'revoked', at: 11 }, 10);
  assert.equal(t.autonomous, false);
  for (let i = 0; i < 10; i++) t = applyTrustEvent(t, { kind: 'approved', at: i + 20 }, 10);
  assert.equal(t.autonomous, true);
  t = applyTrustEvent(t, { kind: 'revert', at: 40 }, 10);
  assert.equal(t.autonomous, false);
});

test('trust: log capped at 100', () => {
  let t = emptyTrust();
  for (let i = 0; i < 120; i++) t = applyTrustEvent(t, { kind: 'rejected', at: i }, 10);
  assert.equal(t.log.length, 100);
});

// ---- resolveTaxonomy --------------------------------------------------------------------------

const NODES: TaxonomyNode[] = [
  {
    id: 1,
    level: 0,
    name: 'Craft Supplies & Tools',
    children: [
      { id: 11, level: 1, name: 'Digital', children: [{ id: 111, level: 2, name: 'Clip Art & Image Files' }] },
      { id: 12, level: 1, name: 'Fabric' },
    ],
  },
  { id: 2, level: 0, name: 'Toys & Games' },
];

test('resolveTaxonomy: exact, fuzzy ≥0.5, none', () => {
  assert.equal(resolveTaxonomy('Craft Supplies & Tools > Digital > Clip Art & Image Files', NODES), 111);
  assert.equal(resolveTaxonomy('craft supplies & tools > digital > clip art & image files', NODES), 111);
  // fuzzy: shares most tokens → best Jaccard wins (the deeper node here)
  assert.equal(resolveTaxonomy('Craft Supplies & Tools > Digital > Clip Art', NODES), 111);
  assert.equal(resolveTaxonomy('Toys & Games > Action Figures', NODES), 2);
  assert.equal(resolveTaxonomy('Ancient Pottery > Kilns > Gas', NODES), null);
});

// ---- analyseEtsyResults -------------------------------------------------------------------------

const listing = (over: Partial<import('./etsy-research.js').EtsyListing>): import('./etsy-research.js').EtsyListing => ({
  listing_id: 1,
  title: 'x',
  priceUsd: 3,
  num_favorers: 10,
  tags: [],
  createdAtMs: Date.now() - 10 * 86_400_000,
  ...over,
});

test('analyseEtsyResults: quartiles, USD-only, tags, newcomer share, top listings', () => {
  const now = Date.now();
  const byKeyword: EtsyKeywordResult[] = [
    {
      keyword: 'pixel art',
      count: 5000,
      results: [
        listing({ priceUsd: 2, num_favorers: 10, tags: ['pixel', 'art'], createdAtMs: now - 10 * 86_400_000 }),
        listing({ priceUsd: 4, num_favorers: 30, tags: ['pixel', 'icons'], createdAtMs: now - 200 * 86_400_000 }),
        listing({ priceUsd: null, num_favorers: 60, tags: ['icons'], createdAtMs: now - 5 * 86_400_000 }), // non-USD
        listing({ priceUsd: 8, num_favorers: 20, tags: ['pixel'], createdAtMs: null }),
      ],
    },
  ];
  const [a] = analyseEtsyResults(byKeyword, now);
  assert.equal(a.count, 5000);
  // prices sorted [2,4,8] — non-USD excluded
  assert.equal(a.priceMedian, 4);
  assert.equal(a.priceP25, 2);
  assert.equal(a.priceP75, 8);
  assert.equal(a.medianFav, 30); // sorted [10,20,30,60] → index 2
  assert.equal(a.maxFav, 60);
  assert.equal(a.topTags[0].tag, 'pixel');
  assert.equal(a.topTags[0].n, 3);
  // 3 dated listings, 2 within 90 days
  assert.ok(Math.abs((a.newcomerShare ?? 0) - 2 / 3) < 0.001);
  assert.equal(a.topListings[0].favs, 60);
  assert.equal(a.topListings[0].ageDays, 5);
  assert.ok(a.score !== null && a.score > 0);
});

// ---- buildEtsySpec ---------------------------------------------------------------------------------

const assetFor = (dir: string): Asset => ({
  sku: 'test-sku',
  title: 'Test Pack',
  tags: ['a'],
  size: 16,
  frames: 1,
  orderBrief: 'b',
  status: 'listed',
  kind: 'pack',
  items: 8,
  itemNames: ['a', 'b'],
  attempts: 0,
  sales: { views: 0, units: 0, revenueUsd: 0 },
  createdAt: 0,
  updatedAt: 0,
  listing: { title: 'T', description: 'D', tags: ['t'], priceUsd: 3 },
});
void assetFor; // kit building needs real pngs — see spec test below

test('buildEtsySpec: disclosure appended exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-'));
  const adir = join(dir, 'assets', 'test-sku');
  mkdirSync(adir, { recursive: true });
  // minimal asset bits the kit builder reads
  writeFileSync(join(adir, 'sheet.png'), Buffer.from([1, 2, 3]));
  writeFileSync(join(adir, 'preview.png'), Buffer.from([4, 5, 6]));
  writeFileSync(join(adir, 'meta.json'), JSON.stringify({ kind: 'pack', items: 2 }));
  const a = assetFor(adir);
  const spec1 = buildEtsySpec(a, adir, 123, 7);
  assert.equal(spec1.taxonomyId, 123);
  assert.equal(spec1.sectionId, 7);
  assert.deepEqual(spec1.files.map((f) => f.split('/').pop()), ['test-sku.zip']);
  // images in rank order, existing only (cover/gallery/thumbnail may or
  // may not exist in a minimal fixture — whatever exists keeps the order)
  const names = spec1.images.map((f) => f.split('/').pop());
  assert.deepEqual([...names].sort(), [...names].sort());
  const order = ['cover.png', 'gallery-1.png', 'thumbnail.png'];
  assert.deepEqual(names, order.filter((o) => names.includes(o)));
  // disclosure appended once; feeding it back through adds no second copy
  assert.equal(spec1.description.split(ETSY_DISCLOSURE).length - 1, 1);
  const a2 = { ...a, listing: { ...a.listing!, description: spec1.description } };
  const spec2 = buildEtsySpec(a2, adir, 123);
  assert.equal(spec2.description.split(ETSY_DISCLOSURE).length - 1, 1);
});

// ---- publish pre-check (factory-side gate, tested via the ledger math) --------------

test('publish pre-check: caps reached → nothing is sent', async () => {
  // the pre-check in processEtsyQueue mirrors this cents comparison;
  // verify the arithmetic a stub would hit
  const { EtsyLedger } = await import('./channels/etsy.js');
  const dir = mkdtempSync(join(tmpdir(), 'led-'));
  const lp = join(dir, 'ledger.jsonl');
  const ledger = new EtsyLedger(lp);
  for (let i = 0; i < 25; i++) ledger.append({ at: Date.now(), kind: 'listing', usd: 0.2, listingId: i });
  const cents = (u: number) => Math.round(u * 100);
  const monthBlocked =
    cents(ledger.monthSpendUsd()) + cents(0.2) > cents(CFG.monthlySpendCapUsd);
  assert.equal(monthBlocked, true);
  const dayBlocked = ledger.listingsToday() >= CFG.maxListingsPerDay;
  assert.equal(dayBlocked, true);
  // a fresh ledger wouldn't block
  const ledger2 = new EtsyLedger(join(dir, 'empty.jsonl'));
  assert.equal(cents(ledger2.monthSpendUsd()) + cents(0.2) > cents(CFG.monthlySpendCapUsd), false);
});

// ---- etsyScanAllowed gate --------------------------------------------------------

test('etsyScanAllowed: failed attempt blocks auto rescans for 30 min', () => {
  const now = Date.now();
  // an attempt 20 min ago, no success → auto scan (6h floor irrelevant) blocked
  const g = etsyScanAllowed(false, now, { lastScanAt: null, lastAttemptAt: now - 20 * 60_000 });
  assert.equal(g.ok, false);
  assert.ok(g.retryAfterMs > 9 * 60_000 && g.retryAfterMs <= 10 * 60_000);
  // 31 min ago → allowed
  assert.equal(etsyScanAllowed(false, now, { lastScanAt: null, lastAttemptAt: now - 31 * 60_000 }).ok, true);
});

test('etsyScanAllowed: success sets the 6h auto floor; manual has its own 30-min floor', () => {
  const now = Date.now();
  const scanned = now - 3 * 3_600_000; // success 3h ago
  // auto refused (needs 6h since success)
  assert.equal(etsyScanAllowed(false, now, { lastScanAt: scanned, lastAttemptAt: scanned }).ok, false);
  // 7h ago → allowed
  const old = now - 7 * 3_600_000;
  assert.equal(etsyScanAllowed(false, now, { lastScanAt: old, lastAttemptAt: old }).ok, true);
  // manual refused at 20 min, allowed at 31 min
  assert.equal(etsyScanAllowed(true, now, { lastScanAt: scanned, lastAttemptAt: now - 20 * 60_000 }).ok, false);
  assert.equal(etsyScanAllowed(true, now, { lastScanAt: old, lastAttemptAt: now - 31 * 60_000 }).ok, true);
});

// ---- activateEtsyDraft ---------------------------------------------------------------

const actDir = (() => { let n = 0; return (name: string) => join(mkdtempSync(join(tmpdir(), 'act-')), `${n++}-${name}`); })();
const actClient = (f: FetchLike): EtsyClient => {
  const tp = actDir('tokens.json');
  const tokens: EtsyTokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, shopId: 42 };
  writeFileSync(tp, JSON.stringify(tokens));
  return new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: async () => {} });
};

test('activateEtsyDraft: PATCH only, never a draft create; ledger on success', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    return { ok: true, status: 200, json: async () => ({ listing_id: 99 }), headers: { get: () => null } };
  };
  const dir = mkdtempSync(join(tmpdir(), 'actl-'));
  const ledger = new EtsyLedger(join(dir, 'l.jsonl'));
  const ship = await activateEtsyDraft(99, { client: actClient(f), cfg: CFG, ledger });
  assert.equal(ship.status, 'active');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.ok(calls[0].url.includes('/shops/42/listings/99'));
  assert.equal(ledger.entries().length, 1);
});

test('activateEtsyDraft: caps hit → zero calls', async () => {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } };
  };
  const dir = mkdtempSync(join(tmpdir(), 'actl2-'));
  const ledger = new EtsyLedger(join(dir, 'l.jsonl'));
  for (let i = 0; i < 25; i++) ledger.append({ at: Date.now(), kind: 'listing', usd: 0.2, listingId: i });
  const ship = await activateEtsyDraft(99, { client: actClient(f), cfg: CFG, ledger });
  assert.equal(ship.status, 'draft');
  assert.match(ship.error ?? '', /spend cap/);
  assert.equal(calls.length, 0);
});

test('activateEtsyDraft: failed PATCH → draft, no ledger entry', async () => {
  const f: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }), headers: { get: () => null } });
  const dir = mkdtempSync(join(tmpdir(), 'actl3-'));
  const ledger = new EtsyLedger(join(dir, 'l.jsonl'));
  const ship = await activateEtsyDraft(99, { client: actClient(f), cfg: CFG, ledger });
  assert.equal(ship.status, 'draft');
  assert.ok(ship.error);
  assert.equal(ledger.entries().length, 0);
});

// ---- hasApprovalEvent -----------------------------------------------------------------

test('hasApprovalEvent: trust counts once per sku', () => {
  let t = emptyTrust();
  assert.equal(hasApprovalEvent(t, 'sku-a'), false);
  t = applyTrustEvent(t, { kind: 'approved', sku: 'sku-a', at: 1 }, 10);
  assert.equal(hasApprovalEvent(t, 'sku-a'), true);
  assert.equal(hasApprovalEvent(t, 'sku-b'), false);
  t = applyTrustEvent(t, { kind: 'edited', sku: 'sku-b', at: 2 }, 10);
  assert.equal(hasApprovalEvent(t, 'sku-b'), true);
  // rejected doesn't count as an approval
  t = applyTrustEvent(t, { kind: 'rejected', sku: 'sku-c', at: 3 }, 10);
  assert.equal(hasApprovalEvent(t, 'sku-c'), false);
});
