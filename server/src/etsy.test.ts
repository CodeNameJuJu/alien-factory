// Etsy channel tests — node:test, stubbed fetch, temp dirs only.
// These never touch the real ~/.alien-factory or the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeEtsyAuth,
  deleteEtsyTokens,
  ETSY_LISTING_FEE_USD,
  EtsyClient,
  EtsyLedger,
  etsyConfigured,
  loadEtsyTokens,
  publishEtsyListing,
  redact,
  startEtsyAuth,
  validateEtsySpec,
  type EtsyListingSpec,
  type EtsyTokens,
} from './channels/etsy.js';
import type { FetchLike } from './channels/gumroad.js';
import type { EtsyConfig } from '../../shared/protocol.js';

const KEY = 'testkey123';
const SECRET = 'testsecret456';
const REDIRECT = 'https://relay.example.com/etsy/callback';

const CFG: EtsyConfig = {
  monthlySpendCapUsd: 5,
  maxListingsPerDay: 3,
  autoRenew: false,
  minPriceUsd: 1.5,
  maxPriceUsd: 60,
};

let dir: string;
let savedEnv: Record<string, string | undefined>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'etsy-test-'));
  savedEnv = {
    ETSY_API_KEY: process.env.ETSY_API_KEY,
    ETSY_SHARED_SECRET: process.env.ETSY_SHARED_SECRET,
    ETSY_REDIRECT_URI: process.env.ETSY_REDIRECT_URI,
  };
  process.env.ETSY_API_KEY = KEY;
  process.env.ETSY_SHARED_SECRET = SECRET;
  process.env.ETSY_REDIRECT_URI = REDIRECT;
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let n = 0;
const tmp = (name: string): string => join(dir, `${n++}-${name}`);
const pendingPath = () => tmp('pending.json');
const tokenPath = () => tmp('tokens.json');
const ledgerPath = () => tmp('ledger.jsonl');

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/// Stub fetch: maps url-substring → response (or fn). Records every call.
function stubFetch(routes: Record<string, { status?: number; json?: unknown; headers?: Record<string, string> } | ((call: CapturedCall) => { status?: number; json?: unknown; headers?: Record<string, string> })>): { f: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const f: FetchLike = async (url, init) => {
    const call: CapturedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(call);
    for (const [match, route] of Object.entries(routes)) {
      if (!url.includes(match)) continue;
      const r = typeof route === 'function' ? route(call) : route;
      return {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        json: async () => (r.json ?? {}) as Record<string, unknown>,
        headers: { get: (h: string) => r.headers?.[h] ?? null },
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'unstubbed ' + url }),
      headers: { get: () => null },
    };
  };
  return { f, calls };
}

const writeTokens = (path: string, t: Partial<EtsyTokens> = {}): EtsyTokens => {
  const tokens: EtsyTokens = {
    accessToken: 'acc-tok',
    refreshToken: 'ref-tok',
    expiresAt: Date.now() + 3600_000,
    userId: 7,
    shopId: 42,
    shopName: 'Test Shop',
    ...t,
  };
  writeFileSync(path, JSON.stringify(tokens));
  return tokens;
};

const noSleep = async () => {};

// ---- config -------------------------------------------------------------------

test('etsyConfigured needs all three env vars', () => {
  assert.equal(etsyConfigured(), true);
  delete process.env.ETSY_SHARED_SECRET;
  assert.equal(etsyConfigured(), false);
  process.env.ETSY_SHARED_SECRET = SECRET;
  assert.equal(etsyConfigured(), true);
});

// ---- pkce / startEtsyAuth --------------------------------------------------------

test('startEtsyAuth: pkce s256 + all params + no listings_d', () => {
  const pp = pendingPath();
  const { url } = startEtsyAuth({ pendingPath: pp });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), KEY);
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const scope = u.searchParams.get('scope') ?? '';
  for (const s of ['listings_r', 'listings_w', 'shops_r', 'shops_w', 'transactions_r']) {
    assert.ok(scope.split(' ').includes(s), `scope ${s}`);
  }
  assert.ok(!scope.includes('listings_d'));
  const pending = JSON.parse(readFileSync(pp, 'utf8')) as { state: string; verifier: string; createdAt: number };
  assert.equal(u.searchParams.get('state'), pending.state);
  // verifier: base64url charset, 43–128 chars (32 bytes → 43)
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const want = createHash('sha256').update(pending.verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(u.searchParams.get('code_challenge'), want);
  assert.equal(statSync(pp).mode & 0o777, 0o600);
});

// ---- completeEtsyAuth --------------------------------------------------------------

const tokenOk = { access_token: 'new-acc', refresh_token: 'new-ref', expires_in: 3600 };
const authRoutes = {
  '/oauth/token': { json: tokenOk },
  '/users/me': { json: { user_id: 7 } },
  '/users/7/shops': { json: { results: [{ shop_id: 42 }] } },
  '/shops/42': { json: { shop_name: 'Test Shop' } },
};

test('completeEtsyAuth: happy path — exact token form, tokens saved 0600', async () => {
  const pp = pendingPath();
  const tp = tokenPath();
  const { url } = startEtsyAuth({ pendingPath: pp });
  const state = new URL(url).searchParams.get('state')!;
  const { f, calls } = stubFetch(authRoutes);
  const r = await completeEtsyAuth(`${REDIRECT}?code=authcode1&state=${state}`, {
    pendingPath: pp,
    tokenPath: tp,
    fetchImpl: f,
    sleep: noSleep,
  });
  assert.equal(r.userId, 7);
  assert.equal(r.shopId, 42);
  assert.equal(r.shopName, 'Test Shop');
  // token exchange: exact form body + api key header
  const exchange = calls.find((c) => c.url.includes('/oauth/token'))!;
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.headers['x-api-key'], `${KEY}:${SECRET}`);
  assert.equal(exchange.headers['content-type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(String(exchange.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), KEY);
  assert.equal(body.get('redirect_uri'), REDIRECT);
  assert.equal(body.get('code'), 'authcode1');
  assert.ok(body.get('code_verifier')!.length >= 43);
  const t = loadEtsyTokens(tp)!;
  assert.equal(t.accessToken, 'new-acc');
  assert.equal(t.refreshToken, 'new-ref');
  assert.equal(t.shopId, 42);
  assert.equal(t.shopName, 'Test Shop');
  assert.equal(statSync(tp).mode & 0o777, 0o600);
});

test('completeEtsyAuth: state mismatch rejected', async () => {
  const pp = pendingPath();
  startEtsyAuth({ pendingPath: pp });
  await assert.rejects(
    completeEtsyAuth(`${REDIRECT}?code=x&state=WRONG`, { pendingPath: pp, fetchImpl: stubFetch({}).f }),
    /state mismatch/,
  );
});

test('completeEtsyAuth: expired pending rejected', async () => {
  const pp = pendingPath();
  writeFileSync(pp, JSON.stringify({ state: 's', verifier: 'v', createdAt: Date.now() - 16 * 60_000 }));
  await assert.rejects(
    completeEtsyAuth(`${REDIRECT}?code=x&state=s`, { pendingPath: pp, fetchImpl: stubFetch({}).f }),
    /expired/,
  );
});

test('completeEtsyAuth: pending is single-use', async () => {
  const pp = pendingPath();
  const tp = tokenPath();
  const { url } = startEtsyAuth({ pendingPath: pp });
  const state = new URL(url).searchParams.get('state')!;
  const cb = `${REDIRECT}?code=authcode2&state=${state}`;
  const { f } = stubFetch(authRoutes);
  await completeEtsyAuth(cb, { pendingPath: pp, tokenPath: tp, fetchImpl: f, sleep: noSleep });
  await assert.rejects(
    completeEtsyAuth(cb, { pendingPath: pp, tokenPath: tp, fetchImpl: f }),
    /no pending etsy connection/,
  );
});

test('completeEtsyAuth: oauth error param surfaces', async () => {
  const pp = pendingPath();
  const { url } = startEtsyAuth({ pendingPath: pp });
  const state = new URL(url).searchParams.get('state')!;
  await assert.rejects(
    completeEtsyAuth(`${REDIRECT}?error=access_denied&state=${state}`, { pendingPath: pp }),
    /access_denied/,
  );
});

// ---- client ------------------------------------------------------------------------

test('client sends x-api-key + bearer headers', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const { f, calls } = stubFetch({ '/users/me': { json: { user_id: 7 } } });
  const c = new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: noSleep });
  await c.getMe();
  assert.equal(calls[0].headers['x-api-key'], `${KEY}:${SECRET}`);
  assert.equal(calls[0].headers.authorization, 'Bearer acc-tok');
});

test('client refreshes <5min before expiry and persists rotated refresh token', async () => {
  const tp = tokenPath();
  writeTokens(tp, { expiresAt: Date.now() + 60_000 });
  const { f, calls } = stubFetch({
    '/oauth/token': { json: { access_token: 'fresh-acc', refresh_token: 'fresh-ref', expires_in: 3600 } },
    '/users/me': { json: { user_id: 7 } },
  });
  const c = new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: noSleep });
  await c.getMe();
  assert.equal(calls[0].url.includes('/oauth/token'), true);
  const refreshBody = new URLSearchParams(String(calls[0].body));
  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'ref-tok');
  assert.equal(calls[1].headers.authorization, 'Bearer fresh-acc');
  const saved = loadEtsyTokens(tp)!;
  assert.equal(saved.accessToken, 'fresh-acc');
  assert.equal(saved.refreshToken, 'fresh-ref');
  assert.equal(saved.shopId, 42); // kept
});

test('client retries 429 after retry-after, then succeeds', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  let hits = 0;
  const { f, calls } = stubFetch({
    '/users/me': () => (++hits === 1 ? { status: 429, headers: { 'retry-after': '1' }, json: {} } : { json: { user_id: 7 } }),
  });
  const c = new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: noSleep });
  const j = await c.getMe();
  assert.equal(j.user_id, 7);
  assert.equal(calls.length, 2);
});

test('client gives up after 3 retries on 429', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const { f, calls } = stubFetch({ '/users/me': { status: 429, headers: { 'retry-after': '0' }, json: {} } });
  const c = new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: noSleep });
  await assert.rejects(c.getMe(), /429/);
  assert.equal(calls.length, 4);
});

test('errors are redacted — key, secret and tokens never leak', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const { f } = stubFetch({
    '/users/me': { status: 500, json: { error: `bad key ${KEY} secret ${SECRET} token acc-tok ref-tok` } },
  });
  const c = new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: noSleep });
  await assert.rejects(c.getMe(), (err: Error) => {
    for (const s of [KEY, SECRET, 'acc-tok', 'ref-tok']) assert.ok(!err.message.includes(s), `leaked ${s}`);
    assert.ok(err.message.includes('***'));
    return true;
  });
});

test('redact strips secrets from arbitrary text', () => {
  const t = writeTokens(tmp('t.json'));
  const out = redact(`${KEY} ${SECRET} ${t.accessToken} ${t.refreshToken}`, t);
  for (const s of [KEY, SECRET, t.accessToken, t.refreshToken]) assert.ok(!out.includes(s));
});

// ---- validateEtsySpec -----------------------------------------------------------------

const specOk = (over: Partial<EtsyListingSpec> = {}): EtsyListingSpec => ({
  title: 'Pixel potion pack',
  description: 'Eight potions.',
  tags: ['pixel', 'potion'],
  priceUsd: 4,
  taxonomyId: 123,
  images: ['/tmp/img1.png'],
  files: ['/tmp/pack.zip'],
  ...over,
});

const statFor = (sizes: Record<string, number>) => (p: string) =>
  p in sizes ? { size: sizes[p] } : null;

const OK_STAT = statFor({ '/tmp/img1.png': 100, '/tmp/pack.zip': 1000, '/tmp/img2.png': 100, '/tmp/big.zip': 21 * 1024 * 1024 });

test('validateEtsySpec: clean spec passes', () => {
  assert.deepEqual(validateEtsySpec(specOk(), CFG, OK_STAT), []);
});

test('validateEtsySpec: title >140 rejected', () => {
  const issues = validateEtsySpec(specOk({ title: 'x'.repeat(141) }), CFG, OK_STAT);
  assert.ok(issues.some((i) => /title too long/.test(i)));
});

test('validateEtsySpec: >13 tags rejected', () => {
  const issues = validateEtsySpec(specOk({ tags: Array.from({ length: 14 }, (_, i) => `t${i}`) }), CFG, OK_STAT);
  assert.ok(issues.some((i) => /too many tags/.test(i)));
});

test('validateEtsySpec: tag >20 chars rejected', () => {
  const issues = validateEtsySpec(specOk({ tags: ['x'.repeat(21)] }), CFG, OK_STAT);
  assert.ok(issues.some((i) => /tag too long/.test(i)));
});

test('validateEtsySpec: tag with bad characters rejected', () => {
  const issues = validateEtsySpec(specOk({ tags: ['bad!tag'] }), CFG, OK_STAT);
  assert.ok(issues.some((i) => /disallowed characters/.test(i)));
});

test('validateEtsySpec: price bounds enforced', () => {
  assert.ok(validateEtsySpec(specOk({ priceUsd: 1.49 }), CFG, OK_STAT).some((i) => /price/.test(i)));
  assert.ok(validateEtsySpec(specOk({ priceUsd: 60.01 }), CFG, OK_STAT).some((i) => /price/.test(i)));
  assert.deepEqual(validateEtsySpec(specOk({ priceUsd: 1.5 }), CFG, OK_STAT), []);
});

test('validateEtsySpec: needs 1–10 existing images', () => {
  assert.ok(validateEtsySpec(specOk({ images: [] }), CFG, OK_STAT).some((i) => /at least 1 image/.test(i)));
  assert.ok(
    validateEtsySpec(specOk({ images: Array(11).fill('/tmp/img1.png') }), CFG, OK_STAT).some((i) => /too many images/.test(i)),
  );
  assert.ok(validateEtsySpec(specOk({ images: ['/tmp/nope.png'] }), CFG, OK_STAT).some((i) => /image missing/.test(i)));
});

test('validateEtsySpec: needs 1–5 files, ≤20 MB, existing', () => {
  assert.ok(validateEtsySpec(specOk({ files: Array(6).fill('/tmp/pack.zip') }), CFG, OK_STAT).some((i) => /too many files/.test(i)));
  assert.ok(validateEtsySpec(specOk({ files: ['/tmp/big.zip'] }), CFG, OK_STAT).some((i) => /too big/.test(i)));
  assert.ok(validateEtsySpec(specOk({ files: ['/tmp/nope.zip'] }), CFG, OK_STAT).some((i) => /file missing/.test(i)));
});

// ---- ledger -----------------------------------------------------------------------------

test('ledger: month sum ignores other months, today count is daily', () => {
  const lp = ledgerPath();
  const now = new Date(2026, 5, 15, 12).getTime();
  const l = new EtsyLedger(lp, () => now);
  l.append({ at: now, kind: 'listing', usd: ETSY_LISTING_FEE_USD, listingId: 1 });
  l.append({ at: now - 2 * 3600_000, kind: 'listing', usd: ETSY_LISTING_FEE_USD, listingId: 2 });
  // last month — same year edge safe (June → May)
  l.append({ at: new Date(2026, 4, 31, 23).getTime(), kind: 'listing', usd: ETSY_LISTING_FEE_USD, listingId: 3 });
  // yesterday — counts for the month, not for today
  l.append({ at: new Date(2026, 5, 14, 12).getTime(), kind: 'listing', usd: ETSY_LISTING_FEE_USD, listingId: 4 });
  assert.ok(Math.abs(l.monthSpendUsd(now) - 0.6) < 1e-9);
  assert.equal(l.listingsToday(now), 2);
});

// ---- publishEtsyListing -----------------------------------------------------------------

const listingRoutes = {
  '/files': { json: { listing_file_id: 55 } },
  '/images': { json: { listing_image_id: 66 } },
};
const publishRoutes = (onCall?: (c: CapturedCall) => { status?: number; json?: unknown } | undefined) => ({
  '/oauth/token': { json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
  '/listings': (c: CapturedCall) => {
    const r = onCall?.(c);
    if (r) return r;
    return { json: { listing_id: 123, url: 'https://etsy.com/listing/123' } };
  },
  ...listingRoutes,
});

const realFile = (name: string, bytes = 10): string => {
  const p = tmp(name);
  writeFileSync(p, Buffer.alloc(bytes));
  return p;
};

const publishSpec = (): EtsyListingSpec => ({
  title: 'Pixel potion pack',
  description: 'Eight potions.',
  tags: ['pixel', 'potion'],
  priceUsd: 4,
  taxonomyId: 123,
  images: [realFile('img1.png'), realFile('img2.png')],
  files: [realFile('pack.zip', 100)],
});

const clientFor = (f: FetchLike, tp: string): EtsyClient =>
  new EtsyClient({ fetchImpl: f, tokenPath: tp, sleep: noSleep });

test('publishEtsyListing: dryRun makes zero fetch calls and returns the ordered plan', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const { f, calls } = stubFetch(publishRoutes());
  const ship = await publishEtsyListing(publishSpec(), {
    client: clientFor(f, tp),
    cfg: CFG,
    ledger: new EtsyLedger(ledgerPath()),
    activate: true,
    dryRun: true,
  });
  assert.equal(ship.status, 'none');
  assert.equal(calls.length, 0);
  const steps = (ship.plan as { steps: { method: string; url: string }[] }).steps;
  assert.equal(steps[0].method, 'POST');
  assert.ok(steps[0].url.endsWith('/listings'));
  assert.ok(steps[1].url.includes('/images'));
  assert.ok(steps[3].url.includes('/files'));
  assert.equal(steps.at(-1)!.method, 'PATCH');
});

test('publishEtsyListing: real run calls in order — draft → images → files → PATCH', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const lp = ledgerPath();
  const { f, calls } = stubFetch(publishRoutes());
  const ship = await publishEtsyListing(publishSpec(), {
    client: clientFor(f, tp),
    cfg: CFG,
    ledger: new EtsyLedger(lp),
    activate: true,
  });
  assert.equal(ship.status, 'active');
  assert.equal(ship.listingId, 123);
  assert.equal(ship.url, 'https://etsy.com/listing/123');
  const seq = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.equal(seq[0], 'POST /v3/application/shops/42/listings');
  assert.equal(seq[1], 'POST /v3/application/shops/42/listings/123/images');
  assert.equal(seq[2], 'POST /v3/application/shops/42/listings/123/images');
  assert.equal(seq[3], 'POST /v3/application/shops/42/listings/123/files');
  assert.equal(seq[4], 'PATCH /v3/application/shops/42/listings/123');
  const draft = new URLSearchParams(String(calls[0].body));
  assert.equal(draft.get('type'), 'download');
  assert.equal(draft.get('who_made'), 'i_did');
  assert.equal(draft.get('is_supply'), 'false');
  assert.equal(draft.get('quantity'), '999');
  assert.equal(draft.get('should_auto_renew'), 'false');
  assert.equal(draft.get('when_made'), 'made_to_order');
  assert.equal(draft.get('price'), '4');
  assert.equal(draft.get('taxonomy_id'), '123');
  assert.deepEqual(draft.getAll('tags'), ['pixel', 'potion']);
  const patch = new URLSearchParams(String(calls[4].body));
  assert.equal(patch.get('state'), 'active');
  // ledger entry after a successful activation
  const entries = new EtsyLedger(lp).entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].usd, ETSY_LISTING_FEE_USD);
  assert.equal(entries[0].listingId, 123);
});

test('publishEtsyListing: monthly spend cap refuses activation — draft kept, no PATCH', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const lp = ledgerPath();
  const ledger = new EtsyLedger(lp);
  // $5.00 cap — already spent $5.00 this month
  for (let i = 0; i < 25; i++) ledger.append({ at: Date.now(), kind: 'listing', usd: 0.2, listingId: i });
  const { f, calls } = stubFetch(publishRoutes());
  const ship = await publishEtsyListing(publishSpec(), {
    client: clientFor(f, tp),
    cfg: CFG,
    ledger,
    activate: true,
  });
  assert.equal(ship.status, 'draft');
  assert.equal(ship.listingId, 123);
  assert.match(ship.error ?? '', /monthly spend cap/);
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

test('publishEtsyListing: daily listing limit refuses activation', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const lp = ledgerPath();
  const ledger = new EtsyLedger(lp);
  for (let i = 0; i < 3; i++) ledger.append({ at: Date.now(), kind: 'listing', usd: 0.2, listingId: i });
  const { f, calls } = stubFetch(publishRoutes());
  const ship = await publishEtsyListing(publishSpec(), {
    client: clientFor(f, tp),
    cfg: { ...CFG, monthlySpendCapUsd: 50 },
    ledger,
    activate: true,
  });
  assert.equal(ship.status, 'draft');
  assert.match(ship.error ?? '', /daily listing limit/);
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

test('publishEtsyListing: failed PATCH leaves a draft and writes no ledger entry', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const lp = ledgerPath();
  const { f } = stubFetch(publishRoutes((c) => (c.method === 'PATCH' ? { status: 500, json: { error: 'boom' } } : undefined)));
  const ship = await publishEtsyListing(publishSpec(), {
    client: clientFor(f, tp),
    cfg: CFG,
    ledger: new EtsyLedger(lp),
    activate: true,
  });
  assert.equal(ship.status, 'draft');
  assert.equal(ship.listingId, 123);
  assert.ok(ship.error);
  assert.equal(new EtsyLedger(lp).entries().length, 0);
});

test('publishEtsyListing: upload failure → draft with listingId + error, never a delete', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const { f, calls } = stubFetch(publishRoutes((c) =>
    c.url.includes('/files') ? { status: 500, json: { error: 'upload exploded' } } : undefined,
  ));
  const ship = await publishEtsyListing(publishSpec(), {
    client: clientFor(f, tp),
    cfg: CFG,
    ledger: new EtsyLedger(ledgerPath()),
    activate: true,
  });
  assert.equal(ship.status, 'draft');
  assert.equal(ship.listingId, 123);
  assert.match(ship.error ?? '', /upload exploded/);
  assert.ok(!calls.some((c) => c.method === 'DELETE' || c.method === 'delete'));
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

test('publishEtsyListing: invalid spec → status none, zero calls', async () => {
  const tp = tokenPath();
  writeTokens(tp);
  const { f, calls } = stubFetch(publishRoutes());
  const ship = await publishEtsyListing(specOk({ title: '' }), {
    client: clientFor(f, tp),
    cfg: CFG,
    ledger: new EtsyLedger(ledgerPath()),
    activate: true,
  });
  assert.equal(ship.status, 'none');
  assert.ok(ship.error);
  assert.equal(calls.length, 0);
});

test('deleteEtsyTokens removes only the local file', () => {
  const tp = tokenPath();
  writeTokens(tp);
  deleteEtsyTokens(tp);
  assert.equal(loadEtsyTokens(tp), null);
  deleteEtsyTokens(tp); // idempotent
});
