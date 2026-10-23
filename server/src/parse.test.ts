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
import { bearerValid, FORWARDABLE, mergeRelayState, parseAssetMsg, parseEnvFile } from './link.js';
import type { ItchItem, ItchSnapshot } from '../../shared/protocol.js';

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
  assert.equal(c.models.packer, 'swe-1-6-fast');
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
