import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyApprovalCap,
  opportunitiesToCandidates,
  shouldQueueScout,
  checkMeta,
  decidePermission,
  extractReport,
  fencedJson,
  parseDecisions,
  parseDemand,
  parseInspection,
  pathsInsideFactory,
  permissionPaths,
  pickSmith,
  rawInputUrls,
  section,
  urlsAllowed,
} from './parse.js';
import {
  analyseSnapshot, getBackoffUntil, nextBackoff, parseItchCells, parseRetryAfter,
  scanAllowed, scanFeeds, setBackoffUntil, validateFeeds, FEED_RE,
} from './itch.js';
import { RateLimiter, passwordMatches, sessionToken, sessionValid, SESSION_COOKIE } from './auth.js';
import { bearerValid, FORWARDABLE, mergeRelayState, parseAssetMsg, parseEnvFile, relayHttpBase, signKitUrl, verifyKitSig } from './link.js';
import type { Asset, GumroadConfig, ItchItem, ItchSnapshot } from '../../shared/protocol.js';
import { canClearGumroad, countClaims, listingConsistency, shipEligibility, unshippableReasons } from '../../shared/shop.js';
import { crc32, decodePng, encodePng } from './png.js';
import { buildKit, drawCover, kitSubtitle, zipFiles, type KitItem, type KitSpec } from './kit.js';
import { applyGumroadProduct, fetchGumroadStore, publishGumroad, shipGumroad, attachGumroadImages, refreshGumroadStatus } from './channels/gumroad.js';
import { encodeGif } from './gif.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const FACTORY = '/factory';

test('section extracts heading body', () => {
  const text = 'blah\n## Decisions\nsome body\nmore\n## Orders\nrest\n';
  assert.equal(section(text, 'Decisions'), 'some body\nmore');
  assert.equal(section(text, 'Orders'), 'rest');
  assert.equal(section(text, 'Missing'), null);
});

test('fencedJson parses fenced and raw json', () => {
  assert.deepEqual(fencedJson('```json\n[1,2]\n```'), [1, 2]);
  assert.deepEqual(fencedJson('[{"a":1}]'), [{ a: 1 }]);
  assert.equal(fencedJson('not json'), null);
  assert.equal(fencedJson(null), null);
});

test('parseDecisions reads fenced json under ## Decisions', () => {
  const text = `Thinking out loud.\n\n## Decisions\n\`\`\`json\n[{"id":"c1","approve":true,"reason":"good","smith":"smith-2","brief":"make it pop"},{"id":"c2","approve":false,"reason":"ugly"}]\n\`\`\`\n`;
  const d = parseDecisions(text);
  assert.equal(d.length, 2);
  assert.equal(d[0].id, 'c1');
  assert.equal(d[0].approve, true);
  assert.equal(d[0].smith, 'smith-2');
  assert.equal(d[0].brief, 'make it pop');
  assert.equal(d[1].approve, false);
  assert.equal(d[1].smith, undefined);
});

test('parseDecisions handles missing block and malformed json', () => {
  assert.deepEqual(parseDecisions('no blocks here'), []);
  assert.deepEqual(parseDecisions('## Decisions\n```json\n{bad json\n```'), []);
});

test('applyApprovalCap flips extra approvals to declined', () => {
  const d = applyApprovalCap(
    [
      { id: 'c1', approve: true, reason: 'a' },
      { id: 'c2', approve: false, reason: 'b' },
      { id: 'c3', approve: true, reason: 'c' },
      { id: 'c4', approve: true, reason: 'd' },
    ],
    2,
  );
  assert.equal(d[0].approve, true);
  assert.equal(d[1].approve, false);
  assert.equal(d[2].approve, true);
  assert.equal(d[3].approve, false);
  assert.match(d[3].reason, /over capacity/);
});

test('pickSmith honours a valid request, else shortest queue', () => {
  const ids = ['smith-1', 'smith-2', 'smith-3'];
  assert.equal(pickSmith('smith-2', ids, { 'smith-2': 5 }), 'smith-2');
  assert.equal(pickSmith('nope', ids, { 'smith-1': 2, 'smith-2': 0, 'smith-3': 1 }), 'smith-2');
  assert.equal(pickSmith(undefined, ids, { 'smith-1': 0, 'smith-2': 0, 'smith-3': 0 }), 'smith-1');
  assert.equal(pickSmith(undefined, [], {}), undefined);
});

test('parseDemand validates and clamps proposals', () => {
  const text = `Report body.\n\n## Demand\n\`\`\`json\n[{"title":"Slime Blue","tags":["slime"],"size":32,"frames":6,"why":"slimes are hot","demand":12,"variantOf":"slime-green"},{"title":"Bad"},{"title":"Cheap","demand":0}]\n\`\`\``;
  const p = parseDemand(text);
  assert.equal(p.length, 3);
  assert.equal(p[0].size, 32);
  assert.equal(p[0].frames, 6);
  assert.equal(p[0].demand, 10); // clamped
  assert.equal(p[0].variantOf, 'slime-green');
  assert.equal(p[1].size, 16);
  assert.equal(p[1].demand, 5); // default
  assert.equal(p[2].demand, 1); // clamped up
  assert.deepEqual(parseDemand('no block'), []);
  assert.deepEqual(parseDemand('## Demand\n```json\n{bad\n```'), []);
});

test('extractReport takes text before ## Demand', () => {
  const text = 'Summary of the market.\nMore lines.\n## Demand\n```json\n[]\n```';
  assert.equal(extractReport(text), 'Summary of the market.\nMore lines.');
  assert.equal(extractReport('## Trend report\n- slime hot'), '- slime hot');
});

test('parseInspection reads verdict/score/notes', () => {
  const text = `Looking at it.\n\n## Inspection\nVerdict: PASS\nScore: 8\nNotes: crisp silhouette, nice bounce\n`;
  const ins = parseInspection(text);
  assert.equal(ins?.verdict, 'PASS');
  assert.equal(ins?.score, 8);
  assert.match(ins!.notes, /crisp/);
  assert.equal(parseInspection('no block'), null);
  assert.equal(parseInspection('## Inspection\nno verdict'), null);
});

test('extractReport falls back to ## Trend report section', () => {
  const r = extractReport('Blah.\n\n## Trend report\n- **slime** — hot\n- **crops** — rising\n');
  assert.match(r, /slime/);
  assert.match(r, /crops/);
});

test('permissionPaths collects locations and rawInput path fields', () => {
  const paths = permissionPaths({
    toolCall: {
      locations: [{ path: '/factory/assets/x/gen.mjs' }],
      rawInput: { file_path: '/factory/STYLE.md', cmd: 'ls', nested: { cwd: '/factory' } },
    },
  });
  assert.ok(paths.includes('/factory/assets/x/gen.mjs'));
  assert.ok(paths.includes('/factory/STYLE.md'));
  assert.ok(paths.includes('/factory'));
  assert.ok(!paths.includes('ls'));
});

test('pathsInsideFactory allows inside, rejects outside and traversal', () => {
  assert.equal(pathsInsideFactory(['/factory/a/b.png'], FACTORY), true);
  assert.equal(pathsInsideFactory(['assets/x/gen.mjs'], FACTORY), true); // relative resolved vs root
  assert.equal(pathsInsideFactory([], FACTORY), true);
  assert.equal(pathsInsideFactory(['/etc/passwd'], FACTORY), false);
  assert.equal(pathsInsideFactory(['/factory/../secrets.txt'], FACTORY), false);
  assert.equal(pathsInsideFactory(['../outside'], FACTORY), false);
  assert.equal(pathsInsideFactory(['/factoryish/not-inside'], FACTORY), false); // prefix trap
  assert.equal(pathsInsideFactory([join(FACTORY, 'sub/../../etc/x')], FACTORY), false);
});

test('decidePermission picks allow_once inside, rejects outside', () => {
  const opts = [
    { optionId: 'allow-1', kind: 'allow_once' },
    { optionId: 'rej-1', kind: 'reject_once' },
  ];
  const inside = decidePermission(
    { options: opts, toolCall: { rawInput: { file_path: '/factory/a.mjs' } } },
    FACTORY,
  );
  assert.equal(inside.allowed, true);
  assert.equal(inside.optionId, 'allow-1');
  const outside = decidePermission(
    { options: opts, toolCall: { rawInput: { file_path: '/etc/passwd' } } },
    FACTORY,
  );
  assert.equal(outside.allowed, false);
  assert.equal(outside.optionId, 'rej-1');
  // shell command with no paths → allowed
  const nop = decidePermission({ options: opts, toolCall: { rawInput: { cmd: 'node gen.mjs' } } }, FACTORY);
  assert.equal(nop.allowed, true);
  // no matching option → null (cancel)
  const none = decidePermission({ options: [], toolCall: {} }, FACTORY);
  assert.equal(none.optionId, null);
});

test('checkMeta validates generated assets', () => {
  const order = { size: 16, frames: 4 };
  assert.equal(
    checkMeta({ w: 16, h: 16, frames: 4, colors: ['#a', '#b'], opaqueRatio: 0.3, emptyFrames: 0, identicalFrames: 1 }, order).passed,
    true,
  );
  const bad = checkMeta({ w: 32, h: 16, frames: 4 }, order);
  assert.equal(bad.passed, false);
  assert.ok(bad.issues.some((i) => i.includes('16x16')));
  assert.equal(checkMeta({ w: 16, h: 16, frames: 9 }, order).passed, false);
  assert.equal(checkMeta({ w: 16, h: 16, frames: 4, colors: Array(17).fill('#x') }, order).passed, false);
  assert.equal(checkMeta({ w: 16, h: 16, frames: 4, opaqueRatio: 0.01 }, order).passed, false);
  assert.equal(checkMeta({ w: 16, h: 16, frames: 4, emptyFrames: 1 }, order).passed, false);
  assert.equal(
    checkMeta({ w: 16, h: 16, frames: 4, identicalFrames: 4, opaqueRatio: 0.3, emptyFrames: 0 }, order).passed,
    false,
  );
  assert.equal(checkMeta(null, order).passed, false);
});

// ---- itch.io research ---------------------------------------------------------

test('parseItchCells parses a real itch feed fixture', () => {
  const fix = JSON.parse(
    readFileSync(new URL('./fixtures/itch-top-sellers.json', import.meta.url), 'utf8'),
  );
  const items = parseItchCells(fix.content);
  assert.equal(items.length, 6);
  const first = items[0];
  assert.equal(first.id, '671751');
  assert.equal(first.title, 'Modern Interiors - RPG Tileset [16X16]');
  assert.equal(first.url, 'https://limezu.itch.io/moderninteriors');
  assert.equal(first.author, 'LimeZu');
  assert.equal(first.salePct, 50);
  assert.ok(first.thumb.startsWith('https://img.itch.zone/'));
  assert.match(first.blurb, /tilesets/i);
  // priced items get currency+price; free/PWYW ones get free=true
  const priced = items.find((i) => i.price != null);
  if (priced) {
    assert.ok(priced.price! > 0);
    assert.ok(priced.currency);
    assert.equal(priced.free, false);
  }
  const free = items.find((i) => i.free);
  if (free) assert.equal(free.price, null);
});

const itchItem = (id: string, title: string, rank: number, price: number | null): ItchItem => ({
  id,
  title,
  url: `https://x.itch.io/${id}`,
  blurb: title,
  author: 'a',
  price,
  currency: price ? '$' : null,
  salePct: null,
  free: price == null,
  thumb: '',
  rank,
});

test('analyseSnapshot scores themes and detects movers', () => {
  const prev: ItchSnapshot = {
    at: 1,
    feeds: {
      'game-assets/top-sellers/tag-pixel-art': [
        itchItem('a', 'Forest Tileset Pack', 1, 5),
        itchItem('b', 'Old Weapons Pack', 2, 3),
      ],
      'game-assets/new-and-popular/tag-pixel-art': [itchItem('a', 'Forest Tileset Pack', 1, 5)],
    },
  };
  const curr: ItchSnapshot = {
    at: 2,
    feeds: {
      'game-assets/top-sellers/tag-pixel-art': [
        itchItem('b', 'Old Weapons Pack', 1, 3),
        itchItem('c', 'Dungeon Monster Pack', 2, 4),
      ],
      'game-assets/new-and-popular/tag-pixel-art': [itchItem('d', 'UI Icons Bundle', 1, null)],
    },
  };
  const a = analyseSnapshot(curr, prev);
  const tileset = a.themes.find((t) => t.key === 'tileset');
  assert.equal(tileset, undefined); // no tileset titles in curr
  const weapons = a.themes.find((t) => t.key === 'weapons')!;
  assert.ok(weapons.score > 0);
  assert.ok(weapons.inTopSellers >= 1);
  const dungeon = a.themes.find((t) => t.key === 'dungeon')!;
  assert.ok(dungeon.score > 0);
  assert.equal(dungeon.medianPrice, 4);
  assert.ok(a.movers.some((m) => m.kind === 'new_top_seller' && m.title === 'Dungeon Monster Pack'));
  assert.ok(a.movers.some((m) => m.kind === 'new_popular' && m.title === 'UI Icons Bundle'));
  assert.equal(a.priceStats.count, 3);
  assert.equal(a.priceStats.pctFree, 33);
  assert.equal(a.topSellers.length, 2);
  // delta: weapons existed in prev too
  assert.notEqual(weapons.delta, null);
  // first scan: deltas are null, no movers
  const first = analyseSnapshot(curr, null);
  assert.equal(first.themes.find((t) => t.key === 'weapons')!.delta, null);
  assert.equal(first.movers.length, 0);
});

test('feed validation keeps valid feeds and defaults when empty', () => {
  assert.equal(FEED_RE.test('game-assets/top-sellers/tag-pixel-art'), true);
  assert.equal(FEED_RE.test('game-assets/new-and-popular'), true);
  assert.equal(FEED_RE.test('search?q=x'), false);
  assert.equal(FEED_RE.test('game-assets/../etc'), false);
  const v = validateFeeds(['game-assets/top-sellers/tag-sprites:2', 'bogus', 'game-assets/newest']);
  assert.deepEqual(v, [
    { feed: 'game-assets/top-sellers/tag-sprites', pages: 2 },
    { feed: 'game-assets/newest', pages: 1 },
  ]);
  assert.ok(validateFeeds(['bogus']).length > 0); // defaults
  assert.ok(validateFeeds(null).length > 0);
});

test('urlsAllowed permits itch hosts, rejects everything else', () => {
  const call = (rawInput: unknown) => ({ toolCall: { rawInput } });
  assert.equal(urlsAllowed(call({ url: 'https://itch.io/game-assets' })), true);
  assert.equal(urlsAllowed(call({ url: 'https://limezu.itch.io/pack' })), true);
  assert.equal(urlsAllowed(call({ url: 'https://img.itch.zone/x.png' })), true);
  assert.equal(urlsAllowed(call({ url: 'https://evil.com/steal' })), false);
  assert.equal(urlsAllowed(call({ url: 'https://itch.io.evil.com/x' })), false);
  assert.equal(urlsAllowed(call({ url: 'http://localhost:4790/api' })), false);
  assert.equal(urlsAllowed(call({ cmd: 'node gen.mjs' })), true); // no urls
  assert.equal(
    rawInputUrls(call({ text: 'see https://a.itch.io/x and https://evil.com' })).length,
    2,
  );
});

// ---- auth -------------------------------------------------------------------

test('session token: sign/verify, wrong cookie rejected, password rotation invalidates', () => {
  const t = sessionToken('s3cret');
  assert.ok(/^[0-9a-f]{64}$/.test(t));
  assert.equal(sessionValid(`${SESSION_COOKIE}=${t}`, 's3cret'), true);
  assert.equal(sessionValid(`other=1; ${SESSION_COOKIE}=${t}; x=y`, 's3cret'), true);
  assert.equal(sessionValid(`${SESSION_COOKIE}=bad`, 's3cret'), false);
  assert.equal(sessionValid(undefined, 's3cret'), false);
  assert.equal(sessionValid(`${SESSION_COOKIE}=${t}`, 'rotated'), false); // pw change logs everyone out
});

test('passwordMatches is exact', () => {
  assert.equal(passwordMatches('hunter2', 'hunter2'), true);
  assert.equal(passwordMatches('hunter2', 'hunter3'), false);
  assert.equal(passwordMatches('', 'x'), false);
  assert.equal(passwordMatches('hunter2!', 'hunter2'), false);
});

test('RateLimiter: N per window per key', () => {
  const rl = new RateLimiter(3, 1000);
  const t0 = 1_000_000;
  assert.equal(rl.allow('1.2.3.4', t0), true);
  assert.equal(rl.allow('1.2.3.4', t0 + 1), true);
  assert.equal(rl.allow('1.2.3.4', t0 + 2), true);
  assert.equal(rl.allow('1.2.3.4', t0 + 3), false); // 4th blocked
  assert.equal(rl.allow('5.6.7.8', t0 + 4), true);  // per-key
  assert.equal(rl.allow('1.2.3.4', t0 + 1001), true); // window resets
});

// ---- worker ⇄ relay link ----------------------------------------------------

test('bearerValid: timing-safe bearer match', () => {
  assert.equal(bearerValid('Bearer k1', 'k1'), true);
  assert.equal(bearerValid('Bearer k2', 'k1'), false);
  assert.equal(bearerValid('k1', 'k1'), false);
  assert.equal(bearerValid(undefined, 'k1'), false);
  assert.equal(bearerValid('Bearer k1', ''), false);
});

test('parseAssetMsg: sku/name allowlist, base64, size cap', () => {
  const b64 = Buffer.from('png!').toString('base64');
  assert.deepEqual(
    parseAssetMsg({ type: 'asset', sku: 'slime-1', files: { 'sheet.png': b64 } })?.sku,
    'slime-1',
  );
  assert.equal(parseAssetMsg({ sku: 'BAD SKU!', files: { 'sheet.png': b64 } }), null);
  assert.equal(parseAssetMsg({ sku: 'a', files: { 'evil.sh': b64 } }), null);
  assert.equal(parseAssetMsg({ sku: 'a', files: { 'sheet.png': 'x'.repeat(3 * 1024 * 1024) } }), null);
  assert.equal(parseAssetMsg({ sku: 'a', files: {} }), null);
  assert.equal(parseAssetMsg('nope'), null);
});

const wsStub = () => ({
  shift: 'running', agents: [{ id: 'o' }], candidates: [], assets: [{ sku: 'a1' }],
  jobs: [], decisions: [], events: [], market: { tick: 1, tags: [], competitors: [], revenueHistory: [], totals: { views: 0, units: 0, revenueUsd: 0 } },
  config: { mode: 'research' }, acp: { alive: true, authenticated: true }, latestTrendReport: 'r',
  trendReports: [{ n: 1 }], devinEnabled: true,
}) as unknown as import('../../shared/protocol.js').WorkerStatePayload;

test('mergeRelayState: no worker → null; connected → live; offline → persisted', () => {
  const itch = { lastScanAt: 5, scanning: false, error: null, backoffUntil: null, analysis: null };
  assert.equal(mergeRelayState(null, itch, { connected: false, lastSeenAt: null }), null);
  const live = mergeRelayState(wsStub(), itch, { connected: true, lastSeenAt: 9 })!;
  assert.equal(live.worker?.connected, true);
  assert.equal(live.devinEnabled, true);
  assert.equal(live.itch.lastScanAt, 5);          // relay's itch, not worker's
  assert.equal(live.agents.length, 1);             // worker's agents
  const off = mergeRelayState(wsStub(), itch, { connected: false, lastSeenAt: 9 })!;
  assert.equal(off.devinEnabled, false);
  assert.equal(off.worker?.lastSeenAt, 9);
});

test('FORWARDABLE allowlist covers the remote commands', () => {
  for (const t of ['startShift', 'pauseShift', 'stopShift', 'setModels', 'setMode', 'setMarketSource', 'directive', 'cancelAgent']) {
    assert.ok(FORWARDABLE.has(t as never), t);
  }
  assert.equal(FORWARDABLE.has('signIn' as never), false);
  assert.equal(FORWARDABLE.has('scanNow' as never), false);
});

test('parseEnvFile: KEY=VALUE, comments, quotes, bad lines', () => {
  const p = '/tmp/af-envtest.env';
  writeFileSync(p, '# c\nALIEN_FACTORY_WORKER_KEY=abc\nX="q v"\nBAD-KEY=no\n =x\nLOWER_ok=v2\n');
  const env = parseEnvFile(p);
  assert.equal(env.ALIEN_FACTORY_WORKER_KEY, 'abc');
  assert.equal(env.X, 'q v');
  assert.equal(env['BAD-KEY'], undefined);
  assert.equal(env.LOWER_ok, 'v2');
  assert.deepEqual(parseEnvFile('/tmp/does-not-exist.env'), {});
});

// ---- itch 429/5xx backoff ------------------------------------------------------

test('parseRetryAfter: seconds, HTTP dates, junk', () => {
  const now = 1_800_000_000_000;
  assert.equal(parseRetryAfter('120', now), 120_000);
  assert.equal(parseRetryAfter(' 42 ', now), 42_000);
  assert.equal(parseRetryAfter(new Date(now + 60_000).toUTCString(), now), 60_000);
  assert.equal(parseRetryAfter('garbage', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('nextBackoff: exponential ladder, Retry-After wins, 6h cap', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(nextBackoff(0, null, now), { until: now + 30 * 60_000, step: 1 });
  assert.deepEqual(nextBackoff(1, null, now), { until: now + 60 * 60_000, step: 2 });
  assert.deepEqual(nextBackoff(2, null, now), { until: now + 120 * 60_000, step: 3 });
  assert.equal(nextBackoff(10, null, now).until, now + 6 * 60 * 60_000); // capped
  assert.deepEqual(nextBackoff(0, 5_000, now), { until: now + 5_000, step: 1 }); // retry-after wins
  assert.equal(nextBackoff(0, 99 * 60 * 60_000, now).until, now + 6 * 60 * 60_000); // capped too
});

test('scanFeeds: 429 aborts the whole scan and starts the backoff window', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    calls++;
    return new Response('nope', { status: 429, headers: { 'retry-after': '42' } });
  };
  try {
    await assert.rejects(
      () => scanFeeds([{ feed: 'game-assets/newest', pages: 3 }]),
      /itch 429/,
    );
    assert.equal(calls, 1); // aborted after the first failed request
    assert.ok(getBackoffUntil() > Date.now());
    const gate = scanAllowed(true);
    assert.equal(gate.ok, false);
    assert.match(gate.reason!, /rate-limited/);
  } finally {
    globalThis.fetch = orig;
    setBackoffUntil(0, 0);
  }
});

// ---- scout gating + promotion ---------------------------------------------------

test('shouldQueueScout: research dedupes by scanAt, full needs no pending', () => {
  const base = { mode: 'research' as const, analysisAt: 100, hasPendingCandidates: false, hasScoutJob: false, reportScanAts: [] };
  assert.equal(shouldQueueScout(base), true);                       // no report for scan 100
  assert.equal(shouldQueueScout({ ...base, reportScanAts: [50, 100] }), false); // already analysed
  assert.equal(shouldQueueScout({ ...base, analysisAt: null }), false);         // no data
  assert.equal(shouldQueueScout({ ...base, hasScoutJob: true }), false);        // one running
  const full = { ...base, mode: 'full' as const };
  assert.equal(shouldQueueScout(full), true);
  assert.equal(shouldQueueScout({ ...full, hasPendingCandidates: true }), false);
});

test('opportunitiesToCandidates: pending candidates with clamped fields', () => {
  const cs = opportunitiesToCandidates(
    [
      { title: 'Slime King', tags: ['slime'], size: 64, frames: 99, why: 'big', demand: 42, variantOf: 'slime-1' },
      { title: 'UI Pack', tags: ['ui'], size: 16, frames: 1, why: 'needs', demand: 3 },
    ],
    { startCounter: 7, reportN: 3, now: 999 },
  );
  assert.equal(cs.length, 2);
  assert.equal(cs[0].id, 'c8');
  assert.equal(cs[0].size, 32);         // clamped to 16|32
  assert.equal(cs[0].demand, 10);       // clamped to 1-10
  assert.equal(cs[0].frames, 8);        // clamped to 1-8
  assert.equal(cs[0].status, 'pending');
  assert.equal(cs[0].reportN, 3);
  assert.equal(cs[1].id, 'c9');
});

// ---- job → agent kind + load-time recovery -------------------------------------

test('JOB_AGENT_KIND maps every job kind to an agent kind', async () => {
  const { JOB_AGENT_KIND, inspectingRecoverySkus } = await import('./parse.js');
  assert.deepEqual(JOB_AGENT_KIND, { scout: 'scout', forge: 'smith', inspect: 'inspector', pack: 'packer' });
  // the old bug: job.kind === agent.kind — inspect/pack never matched
  const assets = [
    { sku: 'a1', status: 'forging' },
    { sku: 'a2', status: 'forging' },
    { sku: 'a3', status: 'queued' },
  ];
  const jobs = [
    { kind: 'forge' as const, sku: 'a1', status: 'done' },
    { kind: 'inspect' as const, sku: 'a1', status: 'queued' },
    { kind: 'inspect' as const, sku: 'a2', status: 'queued' }, // forge not done
    { kind: 'forge' as const, sku: 'a3', status: 'done' },
    { kind: 'inspect' as const, sku: 'a3', status: 'queued' },
  ];
  assert.deepEqual(inspectingRecoverySkus(assets, jobs), ['a1']);
});

// ---- config migration -----------------------------------------------------------

test('migrateConfig drops the old model keys and merges nested maps', async () => {
  const { migrateConfig, DEFAULT_CONFIG } = await import('./config.js');
  const c = migrateConfig({
    overlordModel: 'old-opus',
    workerModel: 'old-worker',
    workerSessionJobLimit: 9,
    smiths: 5,
    models: { smith: 'custom-smith' },
  });
  assert.equal(c.smiths, 5);
  assert.equal(c.models.overlord, 'claude-sonnet-5-5-medium'); // old value ignored
  assert.equal(c.models.scout, 'claude-haiku-5-5-medium');
  assert.equal(c.models.inspector, 'claude-haiku-5-5-low');
  assert.equal(c.models.packer, 'swe-1-6');
  assert.equal(c.models.smith, 'custom-smith'); // partial map merged
  assert.deepEqual(c.sessionJobLimit, { scout: 1, smith: 1, inspector: 4, packer: 6 });
  assert.equal(c.dailyTokenCaps, null);
  assert.equal('overlordModel' in c, false);
  assert.equal('workerSessionJobLimit' in c, false);
  assert.equal(DEFAULT_CONFIG.rescoutHours, 6);
});

// ---- full-mode rescout window ----------------------------------------------------

test('shouldQueueScout: full mode re-scouts fresh analysis or after the window', async () => {
  const { shouldQueueScout } = await import('./parse.js');
  const now = 1_800_000_000_000;
  const base = {
    mode: 'full' as const,
    analysisAt: 100,
    hasPendingCandidates: false,
    hasScoutJob: false,
    reportScanAts: [100], // current analysis already covered
    now,
    rescoutMs: 6 * 3_600_000,
  };
  // covered by a report → only re-scout when the window elapsed
  assert.equal(shouldQueueScout({ ...base, lastScoutAt: now - 7 * 3_600_000 }), true);
  assert.equal(shouldQueueScout({ ...base, lastScoutAt: now - 1 * 3_600_000 }), false);
  // uncovered analysis → scout regardless of how recent the last run was
  assert.equal(shouldQueueScout({ ...base, reportScanAts: [], lastScoutAt: now - 1000 }), true);
  // pending proposals still gate it
  assert.equal(shouldQueueScout({ ...base, reportScanAts: [], hasPendingCandidates: true }), false);
});

// ---- token usage -----------------------------------------------------------------

test('usageFromUpdate prefers _meta keys, falls back to used', async () => {
  const { usageFromUpdate } = await import('./parse.js');
  assert.deepEqual(
    usageFromUpdate({
      used: 24985,
      _meta: {
        'cognition.ai/inputTokens': 23543,
        'cognition.ai/outputTokens': 1442,
        'cognition.ai/cachedReadTokens': 100,
        'cognition.ai/cachedWriteTokens': 7,
      },
    }),
    { input: 23543, cachedRead: 100, cachedWrite: 7, output: 1442 },
  );
  assert.deepEqual(usageFromUpdate({ used: 900 }), { input: 900, cachedRead: 0, cachedWrite: 0, output: 0 });
  assert.deepEqual(usageFromUpdate({}), { input: 0, cachedRead: 0, cachedWrite: 0, output: 0 });
});

test('recordUsage accumulates by role+model, counts requests, rolls day buckets', async () => {
  const { recordUsage, emptyUsageState, totalTokens } = await import('./parse.js');
  const u = emptyUsageState();
  const upd = { _meta: { 'cognition.ai/inputTokens': 1000, 'cognition.ai/outputTokens': 100 } };
  const day1 = Date.parse('2026-10-22T10:00:00');
  const day2 = Date.parse('2026-10-23T10:00:00');
  recordUsage(u, 'smith', 'm1', upd, day1);
  recordUsage(u, 'smith', 'm1', upd, day1);
  recordUsage(u, 'overlord', 'm2', { _meta: { 'cognition.ai/inputTokens': 500 } }, day1);
  const sm = u.byRole.smith!;
  assert.equal(sm.day.requests, 2);
  assert.equal(totalTokens(sm.day), 2200);
  assert.equal(totalTokens(u.byModel.m1!.day), 2200);
  assert.equal(totalTokens(sm.total), 2200);
  assert.equal(u.byRole.overlord!.day.requests, 1);
  // next local day → day bucket resets, total keeps going
  recordUsage(u, 'smith', 'm1', upd, day2);
  const sm2 = u.byRole.smith!;
  assert.equal(sm2.day.requests, 1);
  assert.equal(totalTokens(sm2.day), 1100);
  assert.equal(totalTokens(sm2.total), 3300);
});

test('capExceeded: overlord cap and summed workers cap', async () => {
  const { recordUsage, emptyUsageState, capExceeded } = await import('./parse.js');
  const u = emptyUsageState();
  const now = Date.parse('2026-10-23T10:00:00');
  const big = { _meta: { 'cognition.ai/inputTokens': 60_000 } };
  recordUsage(u, 'smith', 'm1', big, now);
  recordUsage(u, 'packer', 'm1', big, now);
  recordUsage(u, 'overlord', 'm2', { _meta: { 'cognition.ai/inputTokens': 5_000 } }, now);
  assert.equal(capExceeded(u, { overlord: 10_000 }), false);
  assert.equal(capExceeded(u, { overlord: 4_000 }), true);
  assert.equal(capExceeded(u, { workers: 200_000 }), false);
  assert.equal(capExceeded(u, { workers: 100_000 }), true); // smith+packer = 120k
  assert.equal(capExceeded(u, null), false);
  assert.equal(capExceeded(u, {}), false);
});

test('usageCostUsd prices token buckets, null when unpriced', async () => {
  const { usageCostUsd } = await import('./parse.js');
  const c = { input: 1_000_000, cachedRead: 500_000, cachedWrite: 100_000, output: 250_000, requests: 4 };
  const cost = usageCostUsd(c, { inPerM: 3, cachedReadPerM: 0.3, cachedWritePerM: 3.75, outPerM: 15 });
  assert.ok(Math.abs(cost! - (3 + 0.15 + 0.375 + 3.75)) < 1e-9);
  assert.equal(usageCostUsd(c, undefined), null);
});

test('resolveModel: wanted id wins, else session default flagged as mismatch', async () => {
  const { resolveModel } = await import('./parse.js');
  const offered = [
    { id: 'swe-1-6', name: 'SWE 1.6' },
    { id: 'swe-2-medium-lightning', name: 'Lightning' },
  ];
  assert.deepEqual(resolveModel('swe-2-medium-lightning', offered, 'swe-1-6'), {
    id: 'swe-2-medium-lightning', name: 'Lightning', mismatch: false,
  });
  // stale config id (removed from Devin) → session default + mismatch flag
  assert.deepEqual(resolveModel('swe-1-7-lightning-medium', offered, 'swe-1-6'), {
    id: 'swe-1-6', name: 'SWE 1.6', mismatch: true,
  });
  // fallback id itself unknown → pass through with mismatch
  assert.deepEqual(resolveModel('gone', offered, 'also-gone'), {
    id: 'also-gone', name: 'also-gone', mismatch: true,
  });
});

// ---- multi-sprite packs ----------------------------------------------------------

test('parseDemand reads pack fields and clamps items 4-48', () => {
  const text = `## Demand\n\`\`\`json\n[
    {"title":"RPG Icons Vol.1","kind":"pack","items":600,"itemNames":["sword","shield"],"tags":["icons"],"size":16,"frames":4,"why":"packs sell","demand":9},
    {"title":"One Slime","kind":"pack","items":2,"tags":["slime"],"why":"x","demand":5},
    {"title":"Plain","kind":"mystery","items":20,"tags":["x"],"why":"y","demand":5}
  ]\n\`\`\``;
  const p = parseDemand(text);
  assert.equal(p.length, 3);
  assert.equal(p[0].kind, 'pack');
  assert.equal(p[0].items, 48);          // clamped down
  assert.deepEqual(p[0].itemNames, ['sword', 'shield']);
  assert.equal(p[1].kind, 'pack');
  assert.equal(p[1].items, 4);           // clamped up
  assert.equal(p[2].kind, 'sprite');     // unknown kind → sprite
  assert.equal(p[2].items, undefined);   // sprites carry no item count
});

test('parseDecisions reads pack re-scoping fields', () => {
  const text = `## Decisions\n\`\`\`json\n[
    {"id":"c1","approve":true,"reason":"go","smith":"smith-1","kind":"pack","items":24,"itemNames":["a","b"]},
    {"id":"c2","approve":true,"reason":"ok","kind":"sprite","items":30},
    {"id":"c3","approve":false,"reason":"no"}
  ]\n\`\`\``;
  const d = parseDecisions(text);
  assert.equal(d[0].kind, 'pack');
  assert.equal(d[0].items, 24);
  assert.deepEqual(d[0].itemNames, ['a', 'b']);
  assert.equal(d[1].kind, 'sprite');
  assert.equal(d[1].items, undefined);   // items only meaningful on packs
  assert.equal(d[2].kind, undefined);
});

const packMeta = (n: number, over: Record<string, unknown> = {}, perItem: unknown[] = []) => ({
  kind: 'pack',
  w: 16,
  h: 16,
  items: n,
  frames: n * 4,
  fps: 4,
  colors: ['#111', '#222'],
  perItem: perItem as import('./parse.js').MetaPackItem[],
  emptyItems: 0,
  duplicateItems: 0,
  ...over,
});

const packItem = (name: string, over: Record<string, unknown> = {}) => ({
  name, frames: 4, colors: ['#1'], opaqueRatio: 0.4, emptyFrames: 0, identicalFrames: 1, ...over,
});

test('checkMeta: valid pack passes for a 12-item order', () => {
  const perItem = Array.from({ length: 12 }, (_, i) => packItem(`item-${i}`));
  const r = checkMeta(packMeta(12, { perItem }), { size: 16, frames: 4, kind: 'pack', items: 12 });
  assert.equal(r.passed, true);
  assert.deepEqual(r.issues, []);
});

test('checkMeta: pack with too few items fails naming the window', () => {
  const r = checkMeta(packMeta(3), { size: 16, frames: 4, kind: 'pack', items: 12 });
  assert.equal(r.passed, false);
  assert.ok(r.issues.some((i) => /only 3 items/.test(i)));
});

test('checkMeta: bad items are named (list capped at 5 + …)', () => {
  const perItem = Array.from({ length: 12 }, (_, i) =>
    packItem(`item-${i}`, i < 7 ? { frames: 12 } : {}));
  const r = checkMeta(packMeta(12, { perItem }), { size: 16, frames: 4, kind: 'pack', items: 12 });
  assert.equal(r.passed, false);
  const msg = r.issues.find((i) => /frames out of range/.test(i))!;
  assert.match(msg, /item-0, item-1, item-2, item-3, item-4…/);
  const r2 = checkMeta(
    packMeta(12, { perItem: [packItem('x', { opaqueRatio: 0.01 }), ...perItem.slice(1)] }),
    { size: 16, frames: 4, kind: 'pack', items: 12 },
  );
  assert.ok(r2.issues.some((i) => /opaqueRatio.*x/.test(i)));
});

test('checkMeta: duplicate items, colour cap and non-pack meta fail', () => {
  const r = checkMeta(packMeta(12, { duplicateItems: 2 }), { size: 16, frames: 4, kind: 'pack', items: 12 });
  assert.ok(r.issues.some((i) => /2 duplicate/.test(i)));
  const r2 = checkMeta(packMeta(12, { colors: Array(33).fill('#x') }), { size: 16, frames: 4, kind: 'pack', items: 12 });
  assert.ok(r2.issues.some((i) => /33 colours/.test(i)));
  const r3 = checkMeta(packMeta(12, { kind: undefined }), { size: 16, frames: 4, kind: 'pack', items: 12 });
  assert.ok(r3.issues.some((i) => /kind/.test(i)));
  // packs may carry way more than 8 total frames — that's per item
  const r4 = checkMeta(packMeta(48, { frames: 48 * 8 }), { size: 16, frames: 8, kind: 'pack', items: 48 });
  assert.ok(!r4.issues.some((i) => /out of range 1-8$/.test(i)));
});

test('opportunitiesToCandidates carries pack fields through', () => {
  const cs = opportunitiesToCandidates(
    [
      { title: 'Icon Pack', tags: ['ui'], size: 16, frames: 4, why: 'w', demand: 8, kind: 'pack', items: 500, itemNames: ['a'] },
      { title: 'Single', tags: ['ui'], size: 16, frames: 2, why: 'w', demand: 5 },
    ],
    { startCounter: 0, reportN: 1, now: 1 },
  );
  assert.equal(cs[0].kind, 'pack');
  assert.equal(cs[0].items, 48);
  assert.deepEqual(cs[0].itemNames, ['a']);
  assert.equal(cs[1].kind, 'sprite');
  assert.equal(cs[1].items, undefined);
});

test('writeIfDiffers rewrites lib when content changes, skips identical', async () => {
  const { writeIfDiffers } = await import('./seed.js');
  const p = `/tmp/af-wid-${Date.now()}/lib/pix.mjs`;
  assert.equal(writeIfDiffers(p, 'v1'), true);   // missing → write
  assert.equal(writeIfDiffers(p, 'v1'), false);  // identical → skip
  assert.equal(writeIfDiffers(p, 'v2'), true);   // differs → update
  assert.equal(readFileSync(p, 'utf8'), 'v2');
});

// ---- gumroad shop gate -----------------------------------------------------

const GCFG: GumroadConfig = { minScore: 7, packsOnly: true, maxDraftsPerDay: 3, autoPublish: false };

const shipAsset = (over: Partial<Asset> = {}): Asset =>
  ({
    sku: 'p1',
    title: 'Potion Pack',
    tags: ['potions'],
    size: 16,
    frames: 4,
    kind: 'pack',
    items: 8,
    orderBrief: 'b',
    status: 'listed',
    attempts: 1,
    inspection: { verdict: 'PASS', score: 8, notes: 'ok' },
    listing: { title: '8 Potions 16x16', description: 'eight animated potions', tags: ['potions'], priceUsd: 4.99 },
    sales: { views: 0, units: 0, revenueUsd: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Asset;

const packMeta8 = { w: 16, h: 16, items: 8, frames: 32, perItem: Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, frames: 4 })) };

test('countClaims: recognises the pack phrasings', () => {
  const c = countClaims('set of 12 sprites, a 24-pack, x16 icons, 48 items');
  const ns = c.map(([n]) => n).sort((a, b) => a - b);
  assert.deepEqual(ns, [12, 16, 24, 48]);
  // NxN is a size mention, not a count
  assert.equal(countClaims('32x32 tiles').length, 0);
});

test('listingConsistency: the 600-items-on-a-sprite failure', () => {
  const listing = { title: 'Item Icons 32x32 (600 RPG items)', description: 'huge pack' };
  const issues = listingConsistency(listing, { w: 16, h: 16, frames: 4 });
  assert.ok(issues.some((i) => /600/.test(i) && /1 item/.test(i)));
  assert.ok(issues.some((i) => /32x32.*16x16/.test(i)));
});

test('listingConsistency: size mismatch, static "animated" claim, no listing', () => {
  assert.ok(listingConsistency({ title: 'Icons 16x16', description: '' }, { w: 32, h: 32 }).some((i) => /16x16.*32x32/.test(i)));
  assert.ok(listingConsistency({ title: 'Icons', description: 'animated!' }, { w: 16, h: 16, frames: 1 }).some((i) => /single frame/.test(i)));
  assert.ok(listingConsistency(undefined, { w: 16 }).length > 0);
  // a consistent pack passes clean
  assert.deepEqual(
    listingConsistency({ title: '8 Potions 16x16', description: 'animated' }, packMeta8),
    [],
  );
});

test('listingConsistency: variation numbers are not item counts; frame claims checked', () => {
  // the live false positive: "4 frames" on an 8-item pack must not be an item claim
  assert.deepEqual(
    listingConsistency(
      { title: 'Magic Projectile & Impact FX Pack 16x16', description: '8 items, 4 frames each' },
      packMeta8,
    ),
    [],
  );
  // dirs / variants / colours are variation descriptions, not counts
  assert.deepEqual(
    listingConsistency(
      { title: 'Spell FX 8-dir 16x16', description: '6 material variants, 16 colours, animated' },
      packMeta8,
    ),
    [],
  );
  // but an over-claimed frame count still fails (12 ≠ per-item max, ≠ total)
  assert.ok(
    listingConsistency(
      { title: 'Spell FX 16x16', description: '8 items with 12 frames of animation' },
      packMeta8,
    ).some((i) => /12 frames?.*at most 4 frames/i.test(i)),
  );
  // the live false positive: "54 frames" is the pack TOTAL — allowed
  const climbMeta = {
    w: 16,
    h: 16,
    items: 16,
    frames: 54,
    perItem: [4, 2, 5, 4, 4, 2, 4, 4, 4, 3, 3, 4, 2, 2, 3, 4].map((frames, i) => ({ name: `i${i}`, frames })),
  };
  assert.deepEqual(
    listingConsistency(
      { title: '16 Player Expansion Sprites 16x16', description: '7-color palette, 54 frames at 6fps' },
      climbMeta,
    ),
    [],
  );
});

test('shipEligibility: score, packs-only, daily limit, already shipped, ok path', () => {
  assert.ok(!shipEligibility(shipAsset({ inspection: { verdict: 'PASS', score: 5, notes: '' } }), packMeta8, GCFG, 0).ok);
  assert.ok(shipEligibility(shipAsset({ kind: 'sprite', items: undefined }), packMeta8, GCFG, 0).issues.some((i) => /packs-only/.test(i)));
  assert.ok(shipEligibility(shipAsset(), packMeta8, GCFG, 3).issues.some((i) => /daily/.test(i)));
  assert.ok(
    shipEligibility(shipAsset({ channels: { gumroad: { status: 'draft', productId: 'x' } } }), packMeta8, GCFG, 0).issues.some((i) => /already shipped/.test(i)),
  );
  assert.ok(shipEligibility(shipAsset(), packMeta8, GCFG, 0).ok);
  // a listed sprite is fine when packsOnly is off
  assert.ok(shipEligibility(shipAsset({ kind: 'sprite', items: undefined }), { w: 16, h: 16, frames: 4 }, { ...GCFG, packsOnly: false }, 0).ok);
});

// ---- kit / zip -------------------------------------------------------------

test('crc32: known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('png encode/decode round-trips', () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200; data[i + 1] = 50; data[i + 2] = 90; data[i + 3] = 255;
  }
  const png = encodePng(4, 4, data);
  const d = decodePng(png);
  assert.equal(d.w, 4);
  assert.equal(d.data[0], 200);
});

test('zipBytes: real unzip -t validates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-zip-'));
  const p = join(dir, 't.zip');
  writeFileSync(p, zipFiles([
    { name: 'README.txt', data: Buffer.from('hello world') },
    { name: 'a/b.png', data: Buffer.from([1, 2, 3, 4]) },
  ]));
  const out = execSync(`unzip -t "${p}"`).toString();
  assert.match(out, /No errors detected/);
  const list = execSync(`unzip -l "${p}"`).toString();
  assert.match(list, /README\.txt/);
  assert.match(list, /a\/b\.png/);
});

function fakeAssetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'af-kit-'));
  const px = (c: [number, number, number]) => {
    const d = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
    return encodePng(16, 16, d);
  };
  writeFileSync(join(dir, 'sheet.png'), px([220, 90, 90]));
  writeFileSync(join(dir, 'preview.png'), px([220, 90, 90]));
  writeFileSync(join(dir, 'atlas.json'), '{}');
  mkdirSync(join(dir, 'items'));
  writeFileSync(join(dir, 'items', 'p0.png'), px([90, 90, 220]));
  return dir;
}

test('buildKit: zip, readme, license, cover + thumbnail', () => {
  const dir = fakeAssetDir();
  const kit = buildKit(dir, {
    sku: 'test-pack', title: 'Potion Pack Vol 1', isPack: true, size: 16,
    itemNames: ['p0'], framesPerItem: 4, fps: 4,
  });
  const zipPath = join(kit.dir, 'test-pack.zip');
  assert.match(execSync(`unzip -t "${zipPath}"`).toString(), /No errors detected/);
  const list = execSync(`unzip -l "${zipPath}"`).toString();
  for (const f of ['sheet.png', 'preview.png', 'README.txt', 'LICENSE.txt', 'atlas.json', 'items/p0.png']) {
    assert.match(list, new RegExp(f.replace('.', '\\.')));
  }
  const readme = readFileSync(join(kit.dir, 'README.txt'), 'utf8');
  assert.match(readme, /Potion Pack Vol 1/);
  assert.match(readme, /atlas\.json/);
  const lic = readFileSync(join(kit.dir, 'LICENSE.txt'), 'utf8');
  assert.match(lic, /Made with procedural code written by AI agents/);
  assert.match(lic, /may not (?:re)?sell|not resell/i);
  const cover = decodePng(readFileSync(join(kit.dir, 'cover.png')));
  assert.equal(cover.w, 1280);
  assert.equal(cover.h, 720);
  const thumb = decodePng(readFileSync(join(kit.dir, 'thumbnail.png')));
  assert.equal(thumb.w, 600);
});

test('drawCover: oversized preview is downscaled, accent bars survive', () => {
  const big = new Uint8ClampedArray(700 * 700 * 4);
  for (let i = 0; i < big.length; i += 4) {
    big[i] = 220; big[i + 1] = 90; big[i + 2] = 90; big[i + 3] = 255;
  }
  const out = decodePng(drawCover({
    w: 600, h: 600, title: 'Oversized Art', subtitle: 'x',
    preview: encodePng(700, 700, big),
  }));
  assert.equal(out.w, 600);
  assert.equal(out.h, 600);
  accentRowsIntact(out);
});

const solidItem = (rgb: [number, number, number], size = 32): KitItem => {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { name: 'it', frames: [{ w: size, h: size, data }] };
};

const accentRowsIntact = (out: { w: number; h: number; data: Uint8ClampedArray }) => {
  const ACCENT = [92, 242, 200];
  for (const yRange of [[0, 4], [out.h - 4, out.h]]) {
    for (let y = yRange[0]; y < yRange[1]; y++) {
      for (let x = 0; x < out.w; x++) {
        const i = (y * out.w + x) * 4;
        assert.deepEqual([out.data[i], out.data[i + 1], out.data[i + 2]], ACCENT, `pixel ${x},${y}`);
      }
    }
  }
};

test('drawCover: item grid scales up and keeps the accent bars', () => {
  // 16 distinct-coloured 32x32 items — the grid should upscale ~4x on 1280x720
  const items = Array.from({ length: 16 }, (_, i) =>
    solidItem([(i * 37) % 256, 40 + ((i * 61) % 200), (i * 91) % 256]));
  const cover = decodePng(drawCover({
    w: 1280, h: 720, title: 'Icon Pack', subtitle: 'x', items,
  }));
  assert.equal(cover.w, 1280);
  assert.equal(cover.h, 720);
  accentRowsIntact(cover);
  // k>=3 proof: some row contains ≥96 consecutive pixels of item 0's colour
  const [r, g, b] = [0, 40, 0];
  let bestRun = 0;
  for (let y = 0; y < cover.h; y++) {
    let run = 0;
    for (let x = 0; x < cover.w; x++) {
      const i = (y * cover.w + x) * 4;
      run = cover.data[i] === r && cover.data[i + 1] === g && cover.data[i + 2] === b ? run + 1 : 0;
      bestRun = Math.max(bestRun, run);
    }
  }
  assert.ok(bestRun >= 96, `longest item-colour run was ${bestRun}, want >= 96 (k>=3)`);
  // thumbnail: grid must also fit without clipping the accent bars
  const thumb = decodePng(drawCover({ w: 600, h: 600, title: 'Icon Pack', subtitle: 'x', items }));
  assert.equal(thumb.w, 600);
  accentRowsIntact(thumb);
});

const subSpec = (over: Partial<KitSpec>): KitSpec => ({
  sku: 'x', title: 'T', isPack: true, size: 32,
  itemNames: ['a', 'b'], framesPerItem: 4, fps: 4, ...over,
});

test('kitSubtitle: static packs say "sprites", never "animations"', () => {
  const s = kitSubtitle(subSpec({ framesPerItem: 1 }));
  assert.ok(!/animation/i.test(s));
  assert.equal(s, '2 sprites - 32x32px - png + atlas');
  assert.equal(
    kitSubtitle(subSpec({ framesPerItem: 4 })),
    '2 sprites - 32x32px - 4-frame animations',
  );
  // single sprites
  assert.equal(
    kitSubtitle(subSpec({ isPack: false, framesPerItem: 4 })),
    '32x32px - 4-frame animation',
  );
  assert.equal(
    kitSubtitle(subSpec({ isPack: false, framesPerItem: 1 })),
    '32x32px sprite',
  );
});

// ---- gumroad api flow (stubbed fetch — no network) --------------------------

interface StubCall { url: string; method: string; body?: string; headers?: Record<string, string> }

function stubFetch(calls: StubCall[], etag = '"ETAG-abc"') {
  return (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined, headers: init.headers });
    if (url.endsWith('/files/presign')) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: () => Promise.resolve({ success: true, upload_id: 'u1', key: 'k1', file_url: 'https://files.example/x.zip', parts: [{ part_number: 1, presigned_url: 'https://put.example/p1' }] }),
      });
    }
    if (url === 'https://put.example/p1') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: (n: string) => (n === 'etag' ? etag : null) }, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/files/complete')) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
    if (url.endsWith('/products') && method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true, product: { id: 'prod123', edit_url: 'https://gumroad.com/products/prod123/edit', short_url: 'https://gum.co/x', files: [{ id: 'file-1', name: 'x.zip' }] } }) });
    }
    if (/\/products\/[^/]+$/.test(url) && method === 'PUT') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
    }
    if (url.includes('/enable')) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
    if (url.endsWith('/files/abort')) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
    return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: () => Promise.resolve({ success: false, message: 'nope' }) });
  };
}

test('gumroad ship: presign → PUT(etag) → complete → create draft, no token leaks', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    { fetchImpl: stubFetch(calls) as never },
  );
  assert.equal(res.ship.status, 'draft');
  assert.equal(res.ship.productId, 'prod123');
  const seq = calls.map((c) => `${c.method} ${c.url}`);
  assert.match(seq[0], /POST .*files\/presign/);
  assert.equal(seq[1], 'PUT https://put.example/p1');
  assert.match(seq[2], /POST .*files\/complete/);
  assert.match(seq[3], /POST .*\/products$/);
  assert.match(seq[4], /PUT .*\/products\/prod123$/); // rich_content content page
  assert.equal(calls.length, 5, 'no enable call when autoPublish is off');
  // JSON bodies carry real arrays (form-encoded parts[i][k] 400s on Rails)
  const completeBody = JSON.parse(calls[2].body!);
  assert.deepEqual(completeBody.parts, [{ part_number: 1, etag: '"ETAG-abc"' }]);
  assert.equal(completeBody.upload_id, 'u1');
  const createBody = JSON.parse(calls[3].body!);
  assert.deepEqual(createBody.files, [{ url: 'https://files.example/x.zip' }]);
  assert.equal(createBody.price, 499);
  assert.equal(createBody.native_type, 'digital');
  assert.deepEqual(createBody.tags, ['potions']);
  // Bearer header auth — token rides in headers, never in bodies/state/errors
  assert.equal(calls[0].headers?.authorization, 'Bearer TESTTOKEN-should-never-leak');
  assert.ok(!JSON.stringify(res.ship).includes('TESTTOKEN'));
  assert.ok(calls.every((c) => !c.url.includes('TESTTOKEN') && !(c.body ?? '').includes('TESTTOKEN')));
});

test('gumroad ship: autoPublish enables; gate failure preserves prior draft', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: { ...GCFG, autoPublish: true }, shippedToday: 0, dir: fakeAssetDir() },
    { fetchImpl: stubFetch(calls) as never },
  );
  assert.equal(res.ship.status, 'published');
  assert.ok(calls.some((c) => c.url.endsWith('/products/prod123/enable') && c.method === 'PUT'));
  // already-shipped → refused, and the draft record survives
  const again = await shipGumroad(
    {
      asset: shipAsset({ channels: { gumroad: { status: 'draft', productId: 'prod123', shortUrl: 'https://gum.co/x' } } }),
      meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir(),
    },
    { fetchImpl: stubFetch([]) as never },
  );
  assert.equal(again.ship.status, 'draft');
  assert.equal(again.ship.productId, 'prod123');
  assert.match(again.ship.error!, /already shipped/);
});

test('gumroad content page: PUT embeds the create-response file id, no GET', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    { fetchImpl: stubFetch(calls) as never },
  );
  assert.equal(res.ship.status, 'draft');
  assert.equal(res.ship.error, undefined);
  const put = calls.find((c) => c.method === 'PUT' && /\/products\/prod123$/.test(c.url))!;
  assert.ok(put, 'PUT /products/prod123 was made');
  const rich = (JSON.parse(put.body!) as { rich_content: { title: string; description: { content: { type: string; attrs?: { id: string; uid: string } }[] } }[] }).rich_content;
  assert.equal(rich[0].title, 'Download');
  const embed = rich[0].description.content.find((b) => b.type === 'fileEmbed')!;
  assert.equal(embed.attrs!.id, 'file-1'); // from the create response files[0]
  assert.match(embed.attrs!.uid, /^[0-9a-f-]{36}$/);
  // no GET of the product — the create response already carried files
  assert.ok(!calls.some((c) => c.method === 'GET' && c.url.includes('/products/')));
});

test('gumroad content page: no files on create → GET product for the file id', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const f = (url: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.endsWith('/files/presign')) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: () => Promise.resolve({ success: true, upload_id: 'u1', key: 'k1', file_url: 'https://files.example/x.zip', parts: [{ part_number: 1, presigned_url: 'https://put.example/p1' }] }),
      });
    }
    if (url === 'https://put.example/p1') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => '"e1"' }, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/products') && method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true, product: { id: 'prod7' } }) }); // no files
    }
    if (/\/products\/prod7$/.test(url) && method === 'GET') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true, product: { id: 'prod7', files: [{ id: 'fid-from-get' }] } }) });
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
  };
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    { fetchImpl: f as never },
  );
  assert.equal(res.ship.error, undefined);
  const seq = calls.map((c) => `${c.method} ${c.url}`);
  const getIdx = seq.findIndex((s) => s === 'GET https://api.gumroad.com/v2/products/prod7');
  const putIdx = seq.findIndex((s) => s === 'PUT https://api.gumroad.com/v2/products/prod7');
  assert.ok(getIdx >= 0 && putIdx > getIdx, 'GET precedes the rich_content PUT');
  const rich = (JSON.parse(calls[putIdx].body!) as { rich_content: { description: { content: { type: string; attrs?: { id: string } }[] } }[] }).rich_content;
  const embed = rich[0].description.content.find((b) => b.type === 'fileEmbed')!;
  assert.equal(embed.attrs!.id, 'fid-from-get');
});

test('gumroad content page: PUT failure keeps the draft and skips auto-publish', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const f = (url: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.endsWith('/files/presign')) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: () => Promise.resolve({ success: true, upload_id: 'u1', key: 'k1', file_url: 'https://files.example/x.zip', parts: [{ part_number: 1, presigned_url: 'https://put.example/p1' }] }),
      });
    }
    if (url === 'https://put.example/p1') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => '"e1"' }, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/products') && method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true, product: { id: 'prod9', files: [{ id: 'fid-9' }] } }) });
    }
    if (/\/products\/prod9$/.test(url) && method === 'PUT') {
      return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: () => Promise.resolve({ success: false, message: 'nope' }) });
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
  };
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: { ...GCFG, autoPublish: true }, shippedToday: 0, dir: fakeAssetDir() },
    { fetchImpl: f as never },
  );
  assert.equal(res.ship.status, 'draft');
  assert.match(res.ship.error!, /content page failed/);
  assert.match(res.ship.error!, /add the file in the gumroad Content tab/);
  assert.ok(!calls.some((c) => c.url.includes('/enable')), 'a failed content page never publishes');
});

test('unshippableReasons: permanent gate issues only', () => {
  // listed pack scoring below the gate → the score issue is permanent
  assert.deepEqual(
    unshippableReasons(shipAsset({ inspection: { verdict: 'FAIL', score: 6, notes: '' } }), packMeta8, GCFG),
    ['inspection score 6 < 7'],
  );
  // a listed sprite under packsOnly is permanently out
  assert.ok(
    unshippableReasons(shipAsset({ kind: 'sprite', items: undefined }), { w: 16, h: 16, frames: 4 }, GCFG)
      .some((i) => /packs-only/.test(i)),
  );
  // the daily limit is transient — no permanent reasons for an eligible asset
  assert.deepEqual(unshippableReasons(shipAsset(), packMeta8, GCFG), []);
  // 'already shipped' is transient too — an existing product has no
  // permanent reasons (and archive refuses it anyway via productId)
  assert.deepEqual(
    unshippableReasons(
      shipAsset({ channels: { gumroad: { status: 'draft', productId: 'x' } } }),
      packMeta8, GCFG,
    ),
    [],
  );
});

test('moveToArchive: moves the dir, writes archived.json, null when missing', async () => {
  const { moveToArchive } = await import('./factory.js');
  const dir = mkdtempSync(join(tmpdir(), 'af-arch-'));
  const sku = 'old-pack-1';
  mkdirSync(join(dir, 'assets', sku), { recursive: true });
  writeFileSync(join(dir, 'assets', sku, 'meta.json'), '{}');
  const rec = { sku, title: 'Old Pack', status: 'failed', score: 5, reason: 'failed', at: 1 };
  const dst = moveToArchive(dir, sku, rec)!;
  assert.equal(dst, join(dir, 'archive', sku));
  assert.equal(existsSync(join(dir, 'assets', sku)), false);
  assert.equal(existsSync(join(dst, 'meta.json')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dst, 'archived.json'), 'utf8')), rec);
  // existing target → timestamped suffix; missing source → null
  const again = moveToArchive(dir, sku, rec);
  assert.equal(again, null);
  mkdirSync(join(dir, 'assets', 'dup'), { recursive: true });
  mkdirSync(join(dir, 'archive', 'dup'), { recursive: true });
  const dup = moveToArchive(dir, 'dup', rec)!;
  assert.match(dup, /archive\/dup-\d+$/);
});

test('findOrphans: mid-pipeline assets with no live job get requeued kind', async () => {
  const { findOrphans } = await import('./factory.js');
  const a = (sku: string, status: string) => ({ sku, status: status as import('../../shared/protocol.js').Asset['status'] });
  const j = (sku: string, status: string) => ({ sku, status: status as import('../../shared/protocol.js').Job['status'] });
  // the reported bug: 'inspecting' asset whose only inspect job failed
  assert.deepEqual(
    findOrphans([a('x1', 'inspecting')], [j('x1', 'failed')]),
    [{ sku: 'x1', kind: 'inspect' }],
  );
  // a queued inspect counts as live — not an orphan
  assert.deepEqual(findOrphans([a('x1', 'inspecting')], [j('x1', 'queued')]), []);
  // listed assets are never orphans
  assert.deepEqual(findOrphans([a('x2', 'listed')], []), []);
  // on_conveyor with no job → pack; forging with a done forge → forge
  assert.deepEqual(findOrphans([a('x3', 'on_conveyor')], []), [{ sku: 'x3', kind: 'pack' }]);
  assert.deepEqual(
    findOrphans([a('x4', 'forging')], [j('x4', 'done')]),
    [{ sku: 'x4', kind: 'forge' }],
  );
});

test('canClearGumroad: only failed records without a productId', () => {
  assert.equal(canClearGumroad(shipAsset({ channels: { gumroad: { status: 'error' } } })), true);
  assert.equal(
    canClearGumroad(shipAsset({ channels: { gumroad: { status: 'draft', productId: 'p1' } } })),
    false,
  );
  assert.equal(canClearGumroad(shipAsset()), false); // no gumroad record
});

test('refreshGumroadStatus: published/draft/deleted/404/no-productId', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const get = (body: Record<string, unknown>, status = 200) =>
    ((url: string, init: { method?: string } = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      return Promise.resolve({
        ok: status < 400, status, headers: { get: () => null },
        json: () => Promise.resolve(body),
      });
    }) as never;
  let calls: string[] = [];

  // published:true → 'published', stale error cleared
  const base = { status: 'draft' as const, productId: 'prod1', error: 'stale' };
  const pub = await refreshGumroadStatus(base, { fetchImpl: get({ success: true, product: { published: true, short_url: 'https://gum.co/new' } }) });
  assert.equal(pub.status, 'published');
  assert.equal(pub.shortUrl, 'https://gum.co/new');
  assert.equal(pub.error, undefined);

  // published:false → 'draft'
  const dr = await refreshGumroadStatus(
    { status: 'published', productId: 'prod1' },
    { fetchImpl: get({ success: true, product: { published: false } }) },
  );
  assert.equal(dr.status, 'draft');

  // deleted:true → 'not found' error, status + productId kept
  const del = await refreshGumroadStatus(
    { status: 'draft', productId: 'prod1' },
    { fetchImpl: get({ success: true, product: { deleted: true } }) },
  );
  assert.match(del.error!, /not found/);
  assert.equal(del.status, 'draft');
  assert.equal(del.productId, 'prod1');

  // GET 404 → same 'not found'
  const nf = await refreshGumroadStatus(
    { status: 'draft', productId: 'prod1' },
    { fetchImpl: get({ success: false, message: 'nope' }, 404) },
  );
  assert.match(nf.error!, /not found/);
  assert.equal(nf.productId, 'prod1');

  // no productId → unchanged, zero fetch calls
  calls = [];
  const same = { status: 'error' as const, error: 'x' };
  const untouched = await refreshGumroadStatus(same, { fetchImpl: get({}) });
  assert.equal(untouched, same);
  assert.equal(calls.length, 0);

  // other errors → 'refresh failed: …'
  const boom = await refreshGumroadStatus(
    { status: 'draft', productId: 'prod1' },
    { fetchImpl: get({ success: false, message: 'rate limited' }, 429) },
  );
  assert.match(boom.error!, /refresh failed: .*429.*rate limited/);
  assert.equal(boom.status, 'draft');
});

test('fetchGumroadStore: store totals, skips deleted, numeric strings, hidden sales', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const get = (body: Record<string, unknown>, status = 200) =>
    (() => Promise.resolve({
      ok: status < 400, status, headers: { get: () => null },
      json: () => Promise.resolve(body),
    })) as never;

  // sums count/cents across non-deleted products; numeric strings parse
  const r1 = await fetchGumroadStore({
    fetchImpl: get({
      success: true,
      products: [
        { id: 'p1', published: true, price: 299, sales_count: 3, sales_usd_cents: 897 },
        { id: 'p2', published: false, price: '499', sales_count: '2', sales_usd_cents: '998' },
        { id: 'p3', published: true, deleted: true, sales_count: 99, sales_usd_cents: 9900 },
      ],
    }),
  });
  assert.equal(r1.stats.products, 2);
  assert.equal(r1.stats.published, 1);
  assert.equal(r1.stats.salesCount, 5);
  assert.equal(r1.stats.revenueUsdCents, 1895);
  assert.equal(r1.products.length, 3); // raw list keeps deleted for callers

  // any product missing sales fields → totals are null, never 0
  const r2 = await fetchGumroadStore({
    fetchImpl: get({ success: true, products: [{ id: 'p1', published: true, price: 299 }] }),
  });
  assert.equal(r2.stats.salesCount, null);
  assert.equal(r2.stats.revenueUsdCents, null);

  // success:false → throws
  await assert.rejects(
    () => fetchGumroadStore({ fetchImpl: get({ success: false, message: 'nope' }) }),
    /gumroad GET \/products/,
  );
});

test('applyGumroadProduct: status, price, sales, clears error', () => {
  const ship = applyGumroadProduct(
    { status: 'draft', productId: 'p1', error: 'stale' },
    { published: true, price: 299, formatted_price: '$2.99', sales_count: 4, sales_usd_cents: '1196', short_url: 'https://gum.co/x' },
  );
  assert.equal(ship.status, 'published');
  assert.equal(ship.priceCents, 299);
  assert.equal(ship.formattedPrice, '$2.99');
  assert.equal(ship.salesCount, 4);
  assert.equal(ship.salesUsdCents, 1196);
  assert.equal(ship.shortUrl, 'https://gum.co/x');
  assert.equal(ship.error, undefined);
  // absent sales fields (no view_sales) → undefined, never 0
  const hidden = applyGumroadProduct({ status: 'published', productId: 'p1', salesCount: 9 }, { published: false, price: 'nope' });
  assert.equal(hidden.status, 'draft');
  assert.equal(hidden.salesCount, undefined);
  assert.equal(hidden.salesUsdCents, undefined);
  assert.equal(hidden.priceCents, undefined);
});

test('gumroad dry-run: plan includes the rich_content PUT step', async () => {
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: { ...GCFG, autoPublish: true }, shippedToday: 0, dir: fakeAssetDir() },
    { dryRun: true, fetchImpl: stubFetch([]) as never },
  );
  const plan = res.ship.plan as { steps: { method: string; url: string; note?: string }[] };
  const prodIdx = plan.steps.findIndex((s) => s.method === 'POST' && s.url.endsWith('/products'));
  const putIdx = plan.steps.findIndex((s) => s.method === 'PUT' && s.url.endsWith('/products/<id>'));
  const enableIdx = plan.steps.findIndex((s) => s.url.includes('/enable'));
  assert.ok(putIdx > prodIdx, 'rich_content PUT follows POST /products');
  assert.ok(enableIdx > putIdx, 'enable follows the content page PUT');
});

test('gumroad ship: failed part upload aborts the multipart with JSON', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    {
      fetchImpl: ((url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined, headers: init.headers });
        if (url.endsWith('/files/presign')) {
          return Promise.resolve({
            ok: true, status: 200, headers: { get: () => null },
            json: () => Promise.resolve({ success: true, upload_id: 'u9', key: 'k9', file_url: 'https://files.example/x.zip', parts: [{ part_number: 1, presigned_url: 'https://put.example/p1' }] }),
          });
        }
        if (url === 'https://put.example/p1') {
          return Promise.resolve({ ok: false, status: 503, headers: { get: () => null }, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
      }) as never,
    },
  );
  assert.equal(res.ship.status, 'error');
  assert.equal(res.ship.productId, undefined, 'no productId → a retry is allowed');
  const abort = calls.find((c) => c.url.endsWith('/files/abort'));
  assert.ok(abort, 'abort was called');
  assert.deepEqual(JSON.parse(abort!.body!), { upload_id: 'u9', key: 'k9' });
  assert.ok(!JSON.stringify(res.ship).includes('TESTTOKEN'));
});

test('gumroad dry-run: exact request plan, zero fetch', async () => {
  const calls: StubCall[] = [];
  const res = await shipGumroad(
    { asset: shipAsset(), meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    { dryRun: true, fetchImpl: stubFetch(calls) as never },
  );
  assert.equal(calls.length, 0);
  assert.ok(res.plan);
  const plan = res.ship.plan as { steps: { method: string; url: string }[]; kit: { bytes: number } };
  assert.equal(plan.steps[0].method, 'POST');
  assert.match(plan.steps[0].url, /files\/presign/);
  assert.ok(plan.steps.some((s) => s.url.includes('/products')));
  assert.ok(plan.kit.bytes > 0);
});

test('gumroad: successful dry run clears stale error; error status never blocks a ship', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  // asset carries a stale error from a previous failed attempt
  const stale = shipAsset({ channels: { gumroad: { status: 'error', error: 'gumroad POST /files/presign: 500 nope' } } });
  const dry = await shipGumroad(
    { asset: stale, meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    { dryRun: true, fetchImpl: stubFetch([]) as never },
  );
  assert.equal(dry.ship.status, 'none');
  assert.equal(dry.ship.error, undefined);
  assert.ok(dry.ship.plan);
  // …and the stale error does not block a real ship afterwards
  const calls: StubCall[] = [];
  const res = await shipGumroad(
    { asset: stale, meta: packMeta8, cfg: GCFG, shippedToday: 0, dir: fakeAssetDir() },
    { fetchImpl: stubFetch(calls) as never },
  );
  assert.equal(res.ship.status, 'draft');
  assert.equal(res.ship.productId, 'prod123');
  assert.equal(res.ship.error, undefined);
});

test('publishGumroad: enable + refuse without a draft', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  const calls: StubCall[] = [];
  const asset = shipAsset({ channels: { gumroad: { status: 'draft', productId: 'prod9' } } });
  const ship = await publishGumroad(asset, { fetchImpl: stubFetch(calls) as never });
  assert.equal(ship.status, 'published');
  assert.match(calls[0].url, /products\/prod9\/enable/);
  const noDraft = await publishGumroad(shipAsset(), { fetchImpl: stubFetch(calls) as never });
  assert.equal(noDraft.status, 'error');
  assert.match(noDraft.error!, /no draft/);
});

// ---- signed public kit urls --------------------------------------------------

test('signKitUrl/verifyKitSig: valid, tampered, expired, wrong file, >48h', () => {
  const key = 'k-test';
  const now = Date.now();
  const exp = Math.floor(now / 1000) + 3600;
  const url = signKitUrl(key, 'https://relay.example', 'potion-pack-1', 'cover.png', exp);
  const u = new URL(url);
  assert.equal(u.pathname, '/public/kit/potion-pack-1/cover.png');
  assert.ok(verifyKitSig(key, 'potion-pack-1', 'cover.png', exp, u.searchParams.get('sig')!, now));
  // tampered sig, tampered file, expired, beyond the 48h cap, bad file
  assert.ok(!verifyKitSig(key, 'potion-pack-1', 'cover.png', exp, 'aa'.repeat(32), now));
  assert.ok(!verifyKitSig(key, 'potion-pack-1', 'thumbnail.png', exp, u.searchParams.get('sig')!, now));
  assert.ok(!verifyKitSig(key, 'potion-pack-1', 'cover.png', Math.floor(now / 1000) - 10, kitSigFor(key, 'potion-pack-1', 'cover.png', Math.floor(now / 1000) - 10), now));
  const far = Math.floor(now / 1000) + 49 * 3600;
  assert.ok(!verifyKitSig(key, 's', 'cover.png', far, kitSigFor(key, 's', 'cover.png', far), now));
  assert.ok(!verifyKitSig(key, 's', 'gen.mjs', exp, kitSigFor(key, 's', 'gen.mjs', exp), now));
  assert.equal(relayHttpBase('wss://relay.example/worker'), 'https://relay.example');
  assert.equal(relayHttpBase('ws://localhost:4850/worker'), 'http://localhost:4850');
});

import { createHmac } from 'node:crypto';
function kitSigFor(key: string, sku: string, file: string, exp: number): string {
  return createHmac('sha256', key).update(`kit:${sku}:${file}:${exp}`).digest('hex');
}

// ---- gif encoder ---------------------------------------------------------------

test('encodeGif: GIF89a header, NETSCAPE loop, per-frame image data, trailer', () => {
  const mk = (v: number) => new Uint8Array(16).fill(v);
  const gif = encodeGif({
    w: 4, h: 4,
    palette: [[10, 20, 30], [200, 210, 220]],
    frames: [mk(0), mk(1), mk(0)],
    delayCs: 25,
  });
  assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3b);
  assert.match(gif.toString('latin1'), /NETSCAPE2\.0/);
  // 3 image descriptors (0x2C preceded by a block terminator 0x00)
  let descriptors = 0;
  for (let i = 1; i < gif.length; i++) if (gif[i] === 0x2c && gif[i - 1] === 0x00) descriptors++;
  assert.equal(descriptors, 3);
  // global palette has the two colours
  assert.equal(gif[10] & 0x07, 0); // GCT size field → 2 entries
});

// ---- gumroad image attach ------------------------------------------------------

function animAssetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'af-kit-anim-'));
  // sheet 64x32: two items, one row each, 4 frames of 16x16
  const d = new Uint8ClampedArray(64 * 32 * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = 90; d[i + 1] = 160; d[i + 2] = 220; d[i + 3] = 255; }
  writeFileSync(join(dir, 'sheet.png'), encodePng(64, 32, d));
  const p = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < p.length; i += 4) { p[i] = 200; p[i + 1] = 80; p[i + 2] = 80; p[i + 3] = 255; }
  writeFileSync(join(dir, 'preview.png'), encodePng(16, 16, p));
  writeFileSync(join(dir, 'atlas.json'), JSON.stringify({
    size: 16, fps: 4,
    items: [
      { name: 'p0', x: 0, y: 0, w: 16, h: 16, frames: 4 },
      { name: 'p1', x: 0, y: 16, w: 16, h: 16, frames: 4 },
    ],
  }));
  return dir;
}

test('attachGumroadImages: poll → covers order → thumbnail; missing relay skips', async () => {
  process.env.GUMROAD_ACCESS_TOKEN = 'TESTTOKEN-should-never-leak';
  process.env.ALIEN_FACTORY_RELAY_URL = 'wss://relay.example/worker';
  process.env.ALIEN_FACTORY_WORKER_KEY = 'k-test';
  try {
    const calls: StubCall[] = [];
    let synced = 0;
    const f = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined, headers: init.headers });
      if (url.startsWith('https://relay.example/public/kit/')) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) });
      }
      if (url.includes('/covers') || url.includes('/thumbnail')) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: () => Promise.resolve({ success: false }) });
    };
    const asset = shipAsset({ channels: { gumroad: { status: 'draft', productId: 'p9' } } });
    const ship = await attachGumroadImages(
      { asset, meta: packMeta8, dir: animAssetDir() },
      { fetchImpl: f as never, syncHook: () => { synced++; }, pollIntervalMs: 1 },
    );
    assert.equal(synced, 1);
    assert.equal(ship.images!.covers, 3);
    assert.equal(ship.images!.thumbnail, true);
    const coverCalls = calls.filter((c) => c.url.includes('/covers'));
    const files = coverCalls.map((c) => JSON.parse(c.body!).url as string);
    assert.match(files[0], /preview\.gif\?exp=/);
    assert.match(files[1], /cover\.png\?exp=/);
    assert.match(files[2], /gallery-1\.png\?exp=/);
    assert.ok(files.every((u) => u.startsWith('https://relay.example/public/kit/p1/')));
    const thumbCall = calls.find((c) => c.url.includes('/thumbnail'));
    assert.match(JSON.parse(thumbCall!.body!).url, /thumbnail\.png\?exp=/);
    // poll hit the signed url first
    assert.ok(calls[0].url.startsWith('https://relay.example/public/kit/'));

    // no relay configured → clear, non-fatal skip
    delete process.env.ALIEN_FACTORY_RELAY_URL;
    delete process.env.ALIEN_FACTORY_WORKER_KEY;
    const skip = await attachGumroadImages({ asset, meta: packMeta8, dir: animAssetDir() }, { fetchImpl: f as never });
    assert.match(skip.imagesError!, /relay/);
    assert.equal(skip.status, 'draft');
    assert.equal(skip.productId, 'p9');
  } finally {
    delete process.env.ALIEN_FACTORY_RELAY_URL;
    delete process.env.ALIEN_FACTORY_WORKER_KEY;
  }
});
