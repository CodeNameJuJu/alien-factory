// ?demo — a fully client-side fake factory running the new pipeline:
// scout proposes → overlord decides & assigns smiths → forge → inspect →
// conveyor → packer → portal → listed. Starts from an empty conveyor.
import { registerDemoPack, registerDemoSheet } from './assets';
import type { AtlasItem } from './assets';
import { Sprite, mulberry32, hashString } from './pix';
import type { Agent, Asset, Candidate, StateMessage } from '../../shared/protocol';

function demoSheet(sku: string, hue: [number, number, number]): void {
  const rnd = mulberry32(hashString(sku));
  const sheet = document.createElement('canvas');
  sheet.width = 16 * 4;
  sheet.height = 16;
  const sc = sheet.getContext('2d')!;
  for (let f = 0; f < 4; f++) {
    const s = new Sprite(16, 16);
    const [r, g, b] = hue;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = (x - 8) / (6 + (f % 2));
        const dy = (y - 9) / (6 - (f % 2));
        if (dx * dx + dy * dy <= 1) s.px(x, y, [r, g, b]);
      }
    }
    s.px(6, 8, [20, 24, 20]);
    s.px(10, 8, [20, 24, 20]);
    if (rnd() < 0.9) s.rect(5, 13, 6, 1, [r * 0.6, g * 0.6, b * 0.6]);
    sc.drawImage(s.toCanvas(), f * 16, 0);
  }
  registerDemoSheet(sku, sheet, { w: 16, h: 16, frames: 4, fps: 4 });
}

/// A fake 8-item pack: one atlas image (4 frames per item) + atlas.json.
function demoPack(sku: string, count = 8): void {
  const frames = 2;
  const atlasImg = document.createElement('canvas');
  atlasImg.width = 16 * frames;
  atlasImg.height = 16 * count;
  const sc = atlasImg.getContext('2d')!;
  const names: string[] = [];
  const items: AtlasItem[] = [];
  const rnd = mulberry32(hashString(sku));
  for (let i = 0; i < count; i++) {
    const name = `item-${i + 1}`;
    names.push(name);
    const r = 90 + Math.floor(rnd() * 160);
    const g = 60 + Math.floor(rnd() * 160);
    const b = 90 + Math.floor(rnd() * 160);
    for (let f = 0; f < frames; f++) {
      const sp = new Sprite(16, 16);
      const rr = 4 + ((i + f) % 3);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const dx = x - 8, dy = y - 9;
          if (dx * dx + dy * dy <= rr * rr) sp.px(x, y, [r, g, b]);
        }
      }
      sp.rect(7, 1, 2, 4, [200, 190, 160]);
      sc.drawImage(sp.toCanvas(), f * 16, i * 16);
    }
    items.push({ name, x: 0, y: i * 16, w: 16, h: 16, frames });
  }
  registerDemoPack(
    sku,
    atlasImg,
    { kind: 'pack', w: 16, h: 16, items: count, frames: count * frames, fps: 4, perItem: [], emptyItems: 0, duplicateItems: 0 },
    { size: 16, fps: 4, items },
  );
}

function mkAgent(id: string, kind: Agent['kind'], name: string, model: string): Agent {
  return {
    id, kind, name, model, modelName: model, sessionId: 'demo',
    jobsInSession: 2, state: 'idle', statusLine: 'idling', currentJobId: null,
    transcript: [{ role: 'system', text: 'demo agent', at: Date.now() }],
  };
}

function mkAsset(sku: string, status: Asset['status'], tag: string, smith?: string, packItems = 0): Asset {
  return {
    sku, title: sku, tags: [tag], size: 16, frames: 4,
    ...(packItems ? { kind: 'pack' as const, items: packItems, itemNames: Array.from({ length: packItems }, (_, i) => `item-${i + 1}`) } : {}),
    orderBrief: `A ${tag} sprite.`,
    candidateId: 'c1', smith,
    status, attempts: 1,
    checks: { passed: true, issues: [] },
    inspection: status === 'listed' ? { verdict: 'PASS', score: 8, notes: 'reads well at 16px' } : undefined,
    listing: status === 'listed' ? { title: sku, description: 'demo listing', tags: [tag], priceUsd: 2.99 } : undefined,
    sales: { views: 0, units: 0, revenueUsd: 0 },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function mkCandidate(id: string, title: string, tag: string, demand: number, status: Candidate['status'] = 'pending'): Candidate {
  return { id, title, tags: [tag], size: 16, frames: 4, why: `${tag} trending`, demand, reportN: 1, status, createdAt: Date.now() };
}

export function startDemo(apply: (s: StateMessage) => void): void {
  demoSheet('slime-blue', [80, 140, 230]);
  demoSheet('sword-iron', [190, 190, 210]);
  demoSheet('slime-red', [220, 70, 70]);
  demoSheet('potion-purple', [160, 90, 220]);
  demoSheet('tile-moss', [90, 160, 90]);
  demoPack('potion-shelf-8', 8);

  const ev = (text: string, sku?: string) => state.events.push({ at: Date.now(), text, sku });
  const agent = (id: string) => state.agents.find((a) => a.id === id)!;
  const job = (id: string, kind: 'scout' | 'forge' | 'inspect' | 'pack', assignee: string, sku?: string) => {
    state.jobs.push({ id, kind, sku, status: 'active', assignee, createdAt: Date.now() });
    const a = agent(assignee);
    a.state = 'working';
    a.currentJobId = id;
    a.statusLine = `${kind} ${sku ?? ''}`;
  };
  const doneJob = (id: string) => {
    const j = state.jobs.find((x) => x.id === id);
    if (!j) return;
    j.status = 'done';
    j.finishedAt = Date.now();
    const a = agent(j.assignee!);
    a.state = 'idle';
    a.currentJobId = null;
    a.statusLine = 'idle';
  };
  const push = (a: Asset) => state.assets.push(a);

  const state: StateMessage = {
    type: 'state',
    shift: 'running',
    agents: [
      mkAgent('overlord', 'overlord', 'Zorblat', 'claude-sonnet-5-5-medium'),
      mkAgent('scout', 'scout', 'Blix', 'claude-haiku-5-5-medium'),
      mkAgent('smith-1', 'smith', 'Krell', 'swe-2-medium-lightning'),
      mkAgent('smith-2', 'smith', 'Vexa', 'swe-2-medium-lightning'),
      mkAgent('smith-3', 'smith', 'Ooma', 'swe-2-medium-lightning'),
      mkAgent('inspector', 'inspector', 'Nurgg', 'claude-haiku-5-5-low'),
      mkAgent('packer', 'packer', 'Spliq', 'swe-1-6'),
    ],
    candidates: [],
    assets: [],
    jobs: [],
    decisions: [],
    events: [{ at: Date.now(), text: 'shift started — the factory hums to life' }],
    market: {
      tick: 41,
      tags: [
        { tag: 'slime', demand: 0.86, trend: 1 },
        { tag: 'crops', demand: 0.62, trend: 0 },
        { tag: 'potions', demand: 0.55, trend: -1 },
        { tag: 'weapons', demand: 0.44, trend: 1 },
        { tag: 'dungeon-tiles', demand: 0.38, trend: 0 },
        { tag: 'ui-icons', demand: 0.31, trend: -1 },
        { tag: 'spaceships', demand: 0.2, trend: 0 },
        { tag: 'trees', demand: 0.18, trend: -1 },
        { tag: 'food', demand: 0.14, trend: 0 },
        { tag: 'characters', demand: 0.1, trend: 1 },
      ],
      competitors: [
        { title: 'Slime Blob Pack x12', tag: 'slime', priceUsd: 4.99, sales: 210 },
        { title: 'Crypt Floor Tiles', tag: 'dungeon-tiles', priceUsd: 6.99, sales: 150 },
        { title: 'Elixir Shelf Vol.1', tag: 'potions', priceUsd: 3.99, sales: 98 },
      ],
      revenueHistory: Array.from({ length: 40 }, (_, i) => +(Math.sin(i / 6) * 3 + 5).toFixed(2)),
      totals: { views: 0, units: 0, revenueUsd: 0 },
    },
    config: {
      models: {
        overlord: 'claude-sonnet-5-5-medium',
        scout: 'claude-haiku-5-5-medium',
        smith: 'swe-2-medium-lightning',
        inspector: 'claude-haiku-5-5-low',
        packer: 'swe-1-6',
      },
      smiths: 3,
      maxOverlordTurnsPerHour: 6,
      maxApprovalsPerTurn: 4,
      sessionJobLimit: { scout: 1, smith: 1, inspector: 4, packer: 6 },
      rescoutHours: 6,
      usdToZar: 18.5,
      prices: {},
      dailyTokenCaps: null,
      mode: 'full',
      marketSource: 'itch',
      itchScanMinutes: 60,
      itchFeeds: [],
    },
    acp: { authenticated: true, models: [], modelGroups: [{ name: 'demo', values: [{ id: 'claude-opus-5-5-high', name: 'Opus' }, { id: 'swe-2-medium-lightning', name: 'Lightning' }] }], defaultModel: null, modes: [], alive: true },
    latestTrendReport: null,
    devinEnabled: true,
    itch: {
      lastScanAt: Date.now() - 600_000,
      scanning: false,
      error: null,
      backoffUntil: null,
      analysis: {
        at: Date.now() - 600_000,
        themes: [
          { key: 'tileset', score: 18.4, count: 12, inTopSellers: 7, inNewAndPopular: 5, medianPrice: 4.99, pctFree: 8, delta: 2.1 },
          { key: 'character', score: 14.2, count: 10, inTopSellers: 5, inNewAndPopular: 4, medianPrice: 5.99, pctFree: 0, delta: 0.4 },
          { key: 'ui', score: 9.8, count: 7, inTopSellers: 3, inNewAndPopular: 3, medianPrice: 3.49, pctFree: 14, delta: -1.2 },
          { key: 'monster', score: 8.1, count: 6, inTopSellers: 2, inNewAndPopular: 3, medianPrice: 4.49, pctFree: 17, delta: null },
          { key: '16x16', score: 7.6, count: 8, inTopSellers: 4, inNewAndPopular: 2, medianPrice: 3.99, pctFree: 12, delta: 0.9 },
        ],
        movers: [{ title: 'Pixel Dungeon Doors', url: 'https://itch.io', kind: 'new_top_seller', detail: '#9' }],
        priceStats: { median: 4.99, p25: 2.5, p75: 9.99, pctFree: 11, pctOnSale: 23, count: 320 },
        topSellers: [
          { id: '1', title: 'Modern Interiors - RPG Tileset', url: 'https://itch.io', blurb: '16x16 tilesets', author: 'LimeZu', price: 2.5, currency: '$', salePct: 50, free: false, thumb: '', rank: 1 },
          { id: '2', title: 'Tiny Dungeon Sprites', url: 'https://itch.io', blurb: 'monsters', author: 'demo', price: null, currency: null, salePct: null, free: true, thumb: '', rank: 2 },
        ],
        newAndPopular: [
          { id: '3', title: 'Cozy Farm Icons', url: 'https://itch.io', blurb: 'crops', author: 'demo', price: 3.99, currency: '$', salePct: null, free: false, thumb: '', rank: 1 },
        ],
      },
    },
    trendReports: [
      {
        n: 1,
        at: Date.now() - 300_000,
        markdown: '- **tilesets** dominate top sellers · cozy/farming rising · 16x16 sweet spot at $2.50-5\n- gap: cheap animated slimes sell steadily',
        opportunities: [
          { title: 'Slime Blue', tags: ['slime'], size: 16, frames: 4, why: 'slimes convert, low saturation', demand: 8, priceBand: '$2-4', evidence: ['https://itch.io/game-assets/tag-slime'] },
        ],
        scanAt: Date.now() - 600_000,
      },
    ],
    usage: {
      byRole: {
        overlord: {
          day: { date: 'demo', input: 82000, cachedRead: 140000, cachedWrite: 3000, output: 4100, requests: 3 },
          hour: { hour: 'demo 12', input: 40000, cachedRead: 70000, cachedWrite: 1500, output: 2000, requests: 2 },
          total: { input: 310000, cachedRead: 520000, cachedWrite: 12000, output: 15000, requests: 11 },
        },
        smith: {
          day: { date: 'demo', input: 240000, cachedRead: 880000, cachedWrite: 22000, output: 31000, requests: 9 },
          hour: { hour: 'demo 12', input: 90000, cachedRead: 300000, cachedWrite: 8000, output: 12000, requests: 4 },
          total: { input: 1200000, cachedRead: 4100000, cachedWrite: 90000, output: 180000, requests: 42 },
        },
      },
      byModel: {},
    },
    tokenCapHit: false,
  };

  apply(state);

  // scripted pipeline
  const script: (() => void)[] = [
    () => {
      job('j-scout', 'scout', 'scout'); ev('scout dispatched to read the market');
      // a pack already riding the belt → shows the ×N badge + flip-through
      push(mkAsset('potion-shelf-8', 'on_conveyor', 'potions', 'smith-1', 8));
    },
    () => {
      doneJob('j-scout');
      state.latestTrendReport = '- **slime** — still trending; variants sell\n- **weapons** — rising\n- **potions** — steady';
      for (const c of [
        mkCandidate('c1', 'Slime Blue', 'slime', 8),
        mkCandidate('c2', 'Iron Sword', 'weapons', 7),
        mkCandidate('c3', 'Mossy Tile', 'dungeon-tiles', 4),
      ]) {
        state.candidates.push(c);
        ev(`Scout proposes: ${c.title} (demand ${c.demand})`);
      }
    },
    () => { agent('overlord').state = 'working'; agent('overlord').statusLine = 'thinking'; ev('the Overlord ponders (turn 1)'); },
    () => {
      agent('overlord').state = 'idle';
      const decide = (id: string, ok: boolean, smith?: string, sku?: string, reason = '') => {
        const c = state.candidates.find((x) => x.id === id)!;
        c.status = ok ? 'approved' : 'declined';
        c.reason = reason;
        c.smith = smith;
        c.sku = sku;
        c.decidedAt = Date.now();
        state.decisions.push({ candidateId: id, title: c.title, approved: ok, reason, smith, sku, at: Date.now() });
      };
      decide('c1', true, 'smith-1', 'slime-blue', 'ride the slime spike');
      decide('c2', true, 'smith-2', 'sword-iron', 'weapons rising');
      decide('c3', false, undefined, undefined, 'tiles oversaturated');
      ev('Overlord ✓ Slime Blue → smith-1');
      ev('Overlord ✓ Iron Sword → smith-2');
      ev('Overlord ✗ Mossy Tile: tiles oversaturated');
      push(mkAsset('slime-blue', 'queued', 'slime', 'smith-1'));
      push(mkAsset('sword-iron', 'queued', 'weapons', 'smith-2'));
    },
    () => {
      state.assets.find((a) => a.sku === 'slime-blue')!.status = 'forging';
      state.assets.find((a) => a.sku === 'sword-iron')!.status = 'forging';
      job('j-f1', 'forge', 'smith-1', 'slime-blue');
      job('j-f2', 'forge', 'smith-2', 'sword-iron');
    },
    () => {
      doneJob('j-f1');
      const a = state.assets.find((x) => x.sku === 'slime-blue')!;
      a.status = 'inspecting';
      job('j-i1', 'inspect', 'inspector', 'slime-blue');
      ev('Krell hands slime-blue to the inspector', 'slime-blue');
    },
    () => {
      doneJob('j-i1');
      const a = state.assets.find((x) => x.sku === 'slime-blue')!;
      a.status = 'on_conveyor';
      a.inspection = { verdict: 'PASS', score: 8, notes: 'crisp' };
      a.updatedAt = Date.now();
      job('j-p1', 'pack', 'packer', 'slime-blue');
      ev('Inspector ✓ slime-blue (8/10) — onto the conveyor', 'slime-blue');
    },
    () => {
      doneJob('j-f2');
      const a = state.assets.find((x) => x.sku === 'sword-iron')!;
      a.status = 'inspecting';
      job('j-i2', 'inspect', 'inspector', 'sword-iron');
      ev('Vexa hands sword-iron to the inspector', 'sword-iron');
    },
    () => {
      doneJob('j-p1');
      const a = state.assets.find((x) => x.sku === 'slime-blue')!;
      a.status = 'listed';
      a.listing = { title: 'Slime Blue', description: 'demo', tags: ['slime'], priceUsd: 2.99 };
      a.updatedAt = Date.now();
      ev('slime-blue shipped to the marketplace — $2.99', 'slime-blue');
    },
    () => {
      doneJob('j-i2');
      const a = state.assets.find((x) => x.sku === 'sword-iron')!;
      a.status = 'on_conveyor';
      a.inspection = { verdict: 'PASS', score: 7, notes: 'solid edge' };
      a.updatedAt = Date.now();
      job('j-p2', 'pack', 'packer', 'sword-iron');
      ev('Inspector ✓ sword-iron (7/10) — onto the conveyor', 'sword-iron');
    },
    () => {
      doneJob('j-p2');
      const a = state.assets.find((x) => x.sku === 'sword-iron')!;
      a.status = 'listed';
      a.listing = { title: 'Iron Sword', description: 'demo', tags: ['weapons'], priceUsd: 3.49 };
      a.updatedAt = Date.now();
      ev('sword-iron shipped to the marketplace — $3.49', 'sword-iron');
      // a second wave keeps the floor busy
      job('j-s2', 'scout', 'scout');
    },
    () => {
      doneJob('j-s2');
      for (const c of [mkCandidate('c4', 'Slime Red', 'slime', 8), mkCandidate('c5', 'Potion Purple', 'potions', 6)]) {
        state.candidates.push(c);
        ev(`Scout proposes: ${c.title} (demand ${c.demand})`);
      }
    },
    () => {
      const decide = (id: string, smith: string, sku: string) => {
        const c = state.candidates.find((x) => x.id === id)!;
        c.status = 'approved';
        c.smith = smith;
        c.sku = sku;
        c.decidedAt = Date.now();
        state.decisions.push({ candidateId: id, title: c.title, approved: true, reason: 'keep momentum', smith, sku, at: Date.now() });
        ev(`Overlord ✓ ${c.title} → ${smith}`);
      };
      decide('c4', 'smith-3', 'slime-red');
      decide('c5', 'smith-1', 'potion-purple');
      push(mkAsset('slime-red', 'queued', 'slime', 'smith-3'));
      push(mkAsset('potion-purple', 'queued', 'potions', 'smith-1'));
    },
    () => {
      state.assets.find((a) => a.sku === 'slime-red')!.status = 'forging';
      job('j-f3', 'forge', 'smith-3', 'slime-red');
    },
    () => {
      doneJob('j-f3');
      state.assets.find((a) => a.sku === 'slime-red')!.status = 'inspecting';
      job('j-i3', 'inspect', 'inspector', 'slime-red');
      ev('Ooma hands slime-red to the inspector', 'slime-red');
    },
    () => {
      doneJob('j-i3');
      const a = state.assets.find((x) => x.sku === 'slime-red')!;
      a.status = 'on_conveyor';
      a.inspection = { verdict: 'PASS', score: 7, notes: 'angry little guy' };
      a.updatedAt = Date.now();
      ev('Inspector ✓ slime-red (7/10) — onto the conveyor', 'slime-red');
    },
  ];

  let step = 0;
  setInterval(() => {
    if (step < script.length) {
      script[step++]();
    } else {
      // steady state: sales trickle + occasional new conveyor items
      for (const a of state.assets) {
        if (a.status === 'listed') {
          a.sales.views += 3 + (step % 5);
          if (step % 4 === 0) {
            a.sales.units += 1;
            a.sales.revenueUsd = +(a.sales.revenueUsd + (a.listing?.priceUsd ?? 2.99));
            state.market.totals.units++;
            state.market.totals.revenueUsd = +(state.market.totals.revenueUsd + (a.listing?.priceUsd ?? 2.99));
          }
        }
      }
      step++;
    }
    state.market.revenueHistory.push(+(Math.sin(step / 6) * 3 + 5).toFixed(2));
    state.market.tick++;
    if (state.events.length > 30) state.events.splice(0, state.events.length - 30);
    apply(state);
  }, 1600);
}
