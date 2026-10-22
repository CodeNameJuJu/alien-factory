// Mock sprite-asset marketplace. Pure code, seeded — no agents involved.
// One tick = one market hour; ticks only advance while the shift runs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_DIR } from './config.js';
import type { Asset, CompetitorListing, MarketState, MarketTag } from '../../shared/protocol.js';

export const TAGS = [
  'slime',
  'crops',
  'potions',
  'dungeon-tiles',
  'ui-icons',
  'weapons',
  'food',
  'trees',
  'characters',
  'spaceships',
];

const TICK_MS = 30_000;
/// Exponential novelty decay: a listing is "fresh" for ~8 market hours.
const NOVELTY_HALFLIFE_TICKS = 8;

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPETITOR_NAMES: [string, string, number][] = [
  ['Slime Blob Pack x12', 'slime', 4.99],
  ['Pixel Pumpkin Patch', 'crops', 2.49],
  ['Elixir Shelf Vol.1', 'potions', 3.99],
  ['Crypt Floor Tiles 16px', 'dungeon-tiles', 6.99],
  ['HUD Icon Starter 48x', 'ui-icons', 5.49],
  ['Rusty Sword Set', 'weapons', 3.49],
  ['Tavern Snacks', 'food', 1.99],
  ['Whispering Pines', 'trees', 4.49],
  ['Goblin Walk Cycles', 'characters', 7.99],
  ['Scrap Fighter Ships', 'spaceships', 8.99],
  ['Mossy Slime Variants', 'slime', 2.99],
  ['Dungeon Door Pack', 'dungeon-tiles', 3.49],
];

export class Market {
  tick = 0;
  tagDemand = new Map<string, number>();
  prevDemand = new Map<string, number>();
  competitors: CompetitorListing[] = [];
  /// sku → qualityScore for our listings
  quality = new Map<string, number>();
  revenueHistory: number[] = [];
  listedAt = new Map<string, number>(); // sku → tick it was listed
  private spikeTag: string | null = null;
  private spikeTicksLeft = 0;

  restore(s: Record<string, any> | undefined): void {
    if (!s) return;
    this.tick = s.tick ?? 0;
    for (const [k, v] of Object.entries(s.tagDemand ?? {})) this.tagDemand.set(k, Number(v));
    for (const [k, v] of Object.entries(s.prevDemand ?? {})) this.prevDemand.set(k, Number(v));
    if (Array.isArray(s.competitors)) this.competitors = s.competitors;
    for (const [k, v] of Object.entries(s.quality ?? {})) this.quality.set(k, Number(v));
    for (const [k, v] of Object.entries(s.listedAt ?? {})) this.listedAt.set(k, Number(v));
    if (Array.isArray(s.revenueHistory)) this.revenueHistory = s.revenueHistory;
  }

  serialize(): Record<string, unknown> {
    return {
      tick: this.tick,
      tagDemand: Object.fromEntries(this.tagDemand),
      prevDemand: Object.fromEntries(this.prevDemand),
      competitors: this.competitors,
      quality: Object.fromEntries(this.quality),
      listedAt: Object.fromEntries(this.listedAt),
      revenueHistory: this.revenueHistory,
    };
  }

  /// Seed initial demand + competitors deterministically.
  init(): void {
    const rnd = mulberry32(0xfac70);
    for (const t of TAGS) {
      if (!this.tagDemand.has(t)) this.tagDemand.set(t, 0.2 + rnd() * 0.6);
      this.prevDemand.set(t, this.tagDemand.get(t)!);
    }
    if (!this.competitors.length) {
      this.competitors = COMPETITOR_NAMES.map(([title, tag, priceUsd]) => ({
        title,
        tag,
        priceUsd,
        sales: Math.round(20 + rnd() * 300),
      }));
    }
  }

  addListing(asset: Asset, qualityScore: number): void {
    this.quality.set(asset.sku, qualityScore);
    this.listedAt.set(asset.sku, this.tick);
  }

  /// Advance one market hour. Mutates each listed asset's sales.
  step(assets: Asset[]): void {
    this.tick++;
    const rnd = mulberry32(0xfac70 + this.tick * 7919);
    for (const t of TAGS) {
      this.prevDemand.set(t, this.tagDemand.get(t) ?? 0.5);
    }
    // random walk + occasional spike
    if (this.spikeTicksLeft > 0 && --this.spikeTicksLeft === 0) this.spikeTag = null;
    if (rnd() < 0.06) {
      this.spikeTag = TAGS[Math.floor(rnd() * TAGS.length)];
      this.spikeTicksLeft = 3 + Math.floor(rnd() * 4);
    }
    for (const t of TAGS) {
      let d = (this.tagDemand.get(t) ?? 0.5) + (rnd() - 0.5) * 0.14;
      if (t === this.spikeTag) d += 0.08;
      this.tagDemand.set(t, Math.min(1, Math.max(0.02, d)));
    }
    for (const c of this.competitors) {
      const d = this.tagDemand.get(c.tag) ?? 0.3;
      c.sales += Math.round(d * (1 + rnd() * 2));
    }
    let tickRevenue = 0;
    for (const a of assets) {
      if (a.status !== 'listed') continue;
      const demand = a.tags.reduce((s, t) => s + (this.tagDemand.get(t) ?? 0.2), 0);
      const age = Math.max(0, this.tick - (this.listedAt.get(a.sku) ?? this.tick));
      const novelty = Math.pow(0.5, age / NOVELTY_HALFLIFE_TICKS) * 0.8 + 0.2;
      const views = Math.round(demand * 40 * novelty * (0.5 + rnd()));
      const q = this.quality.get(a.sku) ?? 5;
      const price = a.listing?.priceUsd ?? 4.99;
      // cheap + high quality converts; expensive + low quality doesn't
      const conv = Math.min(0.3, Math.max(0.005, (q / 10) * 0.12 * (6 / Math.max(1, price))));
      const units = Math.round(views * conv * (0.6 + rnd() * 0.8));
      const revenue = +(units * price).toFixed(2);
      a.sales.views += views;
      a.sales.units += units;
      a.sales.revenueUsd = +(a.sales.revenueUsd + revenue);
      tickRevenue += revenue;
      a.updatedAt = Date.now();
    }
    this.revenueHistory.push(+tickRevenue.toFixed(2));
    if (this.revenueHistory.length > 200) this.revenueHistory.shift();
  }

  state(assets: Asset[]): MarketState {
    const tags: MarketTag[] = TAGS.map((t) => {
      const d = this.tagDemand.get(t) ?? 0;
      const p = this.prevDemand.get(t) ?? d;
      return { tag: t, demand: +d.toFixed(3), trend: d > p + 0.005 ? 1 : d < p - 0.005 ? -1 : 0 };
    }).sort((a, b) => b.demand - a.demand);
    const totals = { views: 0, units: 0, revenueUsd: 0 };
    for (const a of assets) {
      totals.views += a.sales.views;
      totals.units += a.sales.units;
      totals.revenueUsd += a.sales.revenueUsd;
    }
    totals.revenueUsd = +totals.revenueUsd.toFixed(2);
    return {
      tick: this.tick,
      tags,
      competitors: [...this.competitors].sort((a, b) => b.sales - a.sales),
      revenueHistory: [...this.revenueHistory],
      totals,
    };
  }

  /// reports/market-latest.md — the scout's input.
  writeReport(assets: Asset[]): string {
    const st = this.state(assets);
    const arrow = (t: number) => (t > 0 ? '↑' : t < 0 ? '↓' : '→');
    const lines: string[] = [
      `# Market report — tick ${st.tick}`,
      '',
      '## Tag demand',
      '',
      ...st.tags.map((t) => `- ${arrow(t.trend)} **${t.tag}** — demand ${t.demand.toFixed(2)}`),
      '',
      '## Competitor listings',
      '',
      ...st.competitors
        .slice(0, 8)
        .map((c) => `- ${c.title} — ${c.tag} — $${c.priceUsd.toFixed(2)} — ${c.sales} sales`),
      '',
      '## Our listings',
      '',
      ...(assets.filter((a) => a.status === 'listed').map(
        (a) =>
          `- ${a.sku} (${a.listing?.title ?? a.title}) — tags ${a.tags.join(', ')} — ` +
          `$${(a.listing?.priceUsd ?? 0).toFixed(2)} — ${a.sales.views} views, ` +
          `${a.sales.units} units, $${a.sales.revenueUsd.toFixed(2)}`,
      ) as string[]),
    ];
    if (!assets.some((a) => a.status === 'listed')) lines.push('- (nothing listed yet)');
    const text = lines.join('\n') + '\n';
    try {
      mkdirSync(join(FACTORY_DIR, 'reports'), { recursive: true });
      writeFileSync(join(FACTORY_DIR, 'reports/market-latest.md'), text);
    } catch {
      /* best effort */
    }
    return text;
  }
}

export { TICK_MS };
