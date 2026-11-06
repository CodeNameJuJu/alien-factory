// Etsy v3 channel — gated OAuth connection + digital-listing publish
// primitive. `fetch` is injected for tests; the api key, shared secret and
// oauth tokens are never logged, stored in state, or echoed to clients —
// every thrown error passes through redact() first.
//
// Verified against the official Etsy OpenAPI spec
// (https://www.etsy.com/openapi/generated/oas/3.0.0.json, fetched Nov 2026):
//   - every call needs header `x-api-key: <keystring>:<shared_secret>`
//   - oauth: auth code + PKCE S256. GET https://www.etsy.com/oauth/connect
//     (response_type=code, client_id=keystring, redirect_uri, scope
//     space-separated, state, code_challenge, code_challenge_method=S256).
//     token exchange is NOT in the OAS — per Etsy's auth docs it is
//     POST https://api.etsy.com/v3/public/oauth/token form-urlencoded.
//     access tokens live 3600s; refresh tokens rotate on every refresh.
//   - GET /v3/application/users/me (scope shops_r) returns user_id only —
//     the shop is found via GET /v3/application/users/{user_id}/shops.
//   - draft listing = POST /v3/application/shops/{shop_id}/listings
//     (form-urlencoded, scope listings_w): price is a number in shop
//     currency (USD here, not cents); when_made enum includes
//     'made_to_order'; type 'download' = digital.
//   - activate = PATCH /v3/application/shops/{shop_id}/listings/{id}
//     state=active (enum only allows active|inactive).
//   - uploads are multipart: images field `image`, files fields
//     `file`+`name`+`rank`.
//   - 429s carry `retry-after` (seconds).
//   - publish fee: $0.20 per listing activation (Etsy seller docs).
// NEVER request listings_d — this channel never deletes listings.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import type { Asset, EtsyConfig, EtsyShip } from '../../../shared/protocol.js';
import type { FetchLike } from './gumroad.js';
import { buildKit } from '../kit.js';

const API = 'https://api.etsy.com/v3/application';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const CONNECT_URL = 'https://www.etsy.com/oauth/connect';
/// listing activation fee — a ledger entry only exists when one is charged
export const ETSY_LISTING_FEE_USD = 0.2;
/// a pending oauth handshake lives 15 minutes, then must be restarted
const PENDING_TTL_MS = 15 * 60_000;
/// refresh the access token when less than this remains
const REFRESH_SLACK_MS = 5 * 60_000;
/// min spacing between api requests
const THROTTLE_MS = 120;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/// scopes requested at connect time. getMe needs shops_r per the OAS;
/// listings_d is deliberately absent (we never delete listings).
const SCOPES = 'listings_r listings_w shops_r shops_w transactions_r';

const apiKey = (): string => process.env.ETSY_API_KEY ?? '';
const sharedSecret = (): string => process.env.ETSY_SHARED_SECRET ?? '';
const redirectUri = (): string => process.env.ETSY_REDIRECT_URI ?? '';
export const etsyConfigured = (): boolean => !!(apiKey() && sharedSecret() && redirectUri());

const realFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

// ---- secrets on disk ---------------------------------------------------------

export interface EtsyTokens {
  accessToken: string;
  refreshToken: string;
  /// epoch ms when accessToken expires
  expiresAt: number;
  userId?: number;
  shopId?: number;
  shopName?: string;
  scopes?: string;
}

interface PendingAuth {
  state: string;
  verifier: string;
  createdAt: number;
}

export const etsyTokenPath = (): string => join(DATA_DIR, 'etsy-tokens.json');
export const etsyPendingPath = (): string => join(DATA_DIR, 'etsy-pending.json');
export const etsyLedgerPath = (): string => join(DATA_DIR, 'etsy-ledger.jsonl');

/// Atomic tmp+rename write, mode 0600 — token files are never world-readable.
function writeSecretJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadEtsyTokens(path = etsyTokenPath()): EtsyTokens | null {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8')) as EtsyTokens;
    return t && typeof t.accessToken === 'string' && typeof t.refreshToken === 'string' ? t : null;
  } catch {
    return null;
  }
}

export function deleteEtsyTokens(path = etsyTokenPath()): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}

// ---- oauth (PKCE S256) ---------------------------------------------------------

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/// Start the oauth handshake: writes the pending-auth file (state +
/// verifier, 15 min ttl, single-use) and returns the /oauth/connect url
/// the user must open. Throws when the channel isn't configured.
export function startEtsyAuth(opts: { pendingPath?: string; now?: () => number } = {}): { url: string } {
  if (!etsyConfigured()) {
    throw new Error('etsy not configured — set ETSY_API_KEY, ETSY_SHARED_SECRET and ETSY_REDIRECT_URI in worker.env');
  }
  const now = (opts.now ?? Date.now)();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const pending: PendingAuth = { state, verifier, createdAt: now };
  writeSecretJson(opts.pendingPath ?? etsyPendingPath(), pending);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: apiKey(),
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${CONNECT_URL}?${q.toString()}` };
}

export interface EtsyAuthResult {
  userId: number;
  shopId?: number;
  shopName?: string;
}

/// Finish the handshake from the full redirected url the user pastes
/// (the callback page can't POST it back — the verifier lives here).
/// Validates state + pending ttl, exchanges the code, then resolves
/// user/shop and saves the token file. Pending is deleted once validated
/// — a failed exchange means starting over.
export async function completeEtsyAuth(
  callbackUrl: string,
  opts: {
    pendingPath?: string;
    tokenPath?: string;
    fetchImpl?: FetchLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<EtsyAuthResult> {
  if (!etsyConfigured()) {
    throw new Error('etsy not configured — set ETSY_API_KEY, ETSY_SHARED_SECRET and ETSY_REDIRECT_URI in worker.env');
  }
  const now = (opts.now ?? Date.now)();
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new Error('paste the full redirected url (the whole address bar)');
  }
  const errParam = url.searchParams.get('error');
  if (errParam) {
    throw new Error(`etsy refused the connection: ${errParam}${url.searchParams.get('error_description') ? ` — ${url.searchParams.get('error_description')}` : ''}`);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('the url has no code/state — paste the url etsy redirected to');
  const pendingPath = opts.pendingPath ?? etsyPendingPath();
  let pending: PendingAuth | null = null;
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingAuth;
  } catch {
    throw new Error('no pending etsy connection — click [ connect ] first');
  }
  if (now - pending.createdAt > PENDING_TTL_MS) {
    try {
      rmSync(pendingPath);
    } catch { /* best effort */ }
    throw new Error('the etsy connection expired (15 min) — click [ connect ] again');
  }
  if (state !== pending.state) throw new Error('state mismatch — click [ connect ] again and paste the new url');
  // single-use from here on: a failed exchange requires a fresh connect
  try {
    rmSync(pendingPath);
  } catch { /* best effort */ }

  const f = opts.fetchImpl ?? realFetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: apiKey(),
    redirect_uri: redirectUri(),
    code,
    code_verifier: pending.verifier,
  });
  const res = await f(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-api-key': `${apiKey()}:${sharedSecret()}`,
    },
    body: body.toString(),
  });
  const j: Record<string, unknown> = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(redact(`etsy token exchange failed: ${res.status} ${String(j.error ?? j.error_description ?? '').slice(0, 200)}`, null));
  }
  const accessToken = String(j.access_token ?? '');
  const refreshToken = String(j.refresh_token ?? '');
  const expiresIn = Number(j.expires_in ?? 3600);
  if (!accessToken || !refreshToken) throw new Error('etsy token exchange returned no tokens');

  const tokens: EtsyTokens = { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, scopes: SCOPES };
  const client = new EtsyClient({
    fetchImpl: f,
    sleep: opts.sleep,
    tokens,
    tokenPath: opts.tokenPath,
  });
  return client.syncShopInfo();
}

// ---- redaction ----------------------------------------------------------------

/// Strip every secret we might hold from an error string — api key,
/// shared secret and both oauth tokens — so errors are safe to log,
/// persist on assets and broadcast to clients.
export function redact(msg: string, tokens: EtsyTokens | null): string {
  let out = msg;
  for (const s of [apiKey(), sharedSecret(), tokens?.accessToken, tokens?.refreshToken]) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

class EtsyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// ---- api client ----------------------------------------------------------------

interface FormBody {
  [key: string]: string | number | boolean | (string | number)[] | undefined;
}

function formEncode(fields: FormBody): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) p.append(k, String(item));
    else p.append(k, String(v));
  }
  return p.toString();
}

export interface EtsyClientOpts {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /// token file to read/persist — injectable so tests use a temp dir
  tokenPath?: string;
  now?: () => number;
  /// preloaded tokens (completeEtsyAuth passes fresh ones in)
  tokens?: EtsyTokens;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/// Etsy api client: api key + bearer headers, lazy token refresh (<5 min
/// left → refresh, persist the rotated refresh token), ≥120 ms between
/// requests, 429 → wait `retry-after` (default 2 s) and retry up to 3x.
export class EtsyClient {
  private f: FetchLike;
  private sleep: (ms: number) => Promise<void>;
  private tokenPath: string;
  private now: () => number;
  private tokens: EtsyTokens | null;
  private lastReq = 0;

  constructor(opts: EtsyClientOpts = {}) {
    this.f = opts.fetchImpl ?? realFetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.tokenPath = opts.tokenPath ?? etsyTokenPath();
    this.now = opts.now ?? Date.now;
    this.tokens = opts.tokens ?? null;
  }

  /// token summary for statePayload — never the tokens themselves
  static info(path = etsyTokenPath()): { connected: boolean; shopId?: number; shopName?: string } {
    const t = loadEtsyTokens(path);
    if (!t) return { connected: false };
    return { connected: true, shopId: t.shopId, shopName: t.shopName };
  }

  get shopId(): number | undefined {
    if (!this.tokens) this.tokens = loadEtsyTokens(this.tokenPath);
    return this.tokens?.shopId;
  }

  private ensureTokens(): EtsyTokens {
    if (!this.tokens) this.tokens = loadEtsyTokens(this.tokenPath);
    if (!this.tokens) throw new EtsyError('etsy not connected — complete the oauth handshake first');
    return this.tokens;
  }

  private persistTokens(): void {
    if (this.tokens) writeSecretJson(this.tokenPath, this.tokens);
  }

  /// Refresh the access token (grant_type=refresh_token) and persist the
  /// rotated refresh token. One attempt; failures surface to the caller.
  private async refresh(): Promise<void> {
    const t = this.ensureTokens();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: apiKey(),
      refresh_token: t.refreshToken,
    });
    const res = await this.f(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-api-key': `${apiKey()}:${sharedSecret()}`,
      },
      body: body.toString(),
    });
    const j: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new EtsyError(redact(`etsy token refresh failed: ${res.status} ${String(j.error ?? j.error_description ?? '').slice(0, 200)}`, t), res.status);
    }
    const accessToken = String(j.access_token ?? '');
    const refreshToken = String(j.refresh_token ?? '');
    const expiresIn = Number(j.expires_in ?? 3600);
    if (!accessToken || !refreshToken) throw new EtsyError('etsy token refresh returned no tokens');
    this.tokens = { ...t, accessToken, refreshToken, expiresAt: this.now() + expiresIn * 1000 };
    this.persistTokens();
  }

  private async throttle(): Promise<void> {
    const wait = this.lastReq + THROTTLE_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastReq = this.now();
  }

  /// One api call (auto-refresh + throttle + 429 retries). `path` is
  /// absolute or relative to /v3/application. Every error is redacted.
  /// `auth:false` sends only the api key — for endpoints the OAS marks
  /// with no oauth security (search, taxonomy): no token file needed.
  private async request(
    method: string,
    path: string,
    opts: {
      form?: FormBody;
      json?: unknown;
      multipart?: FormData;
      query?: Record<string, unknown>;
      auth?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    const auth = opts.auth !== false;
    let t: EtsyTokens | null = null;
    if (auth) {
      if (this.now() > this.ensureTokens().expiresAt - REFRESH_SLACK_MS) await this.refresh();
      t = this.ensureTokens();
    }
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      'x-api-key': `${apiKey()}:${sharedSecret()}`,
    };
    if (t) headers.authorization = `Bearer ${t.accessToken}`;
    let body: unknown;
    if (opts.multipart) {
      body = opts.multipart;
    } else if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = formEncode(opts.form);
    }
    const attempts = 4; // first try + up to 3 retries on 429
    for (let i = 0; i < attempts; i++) {
      await this.throttle();
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.f(url.toString(), { method, headers, body });
      } catch (err) {
        throw new EtsyError(redact(`etsy ${method} ${url.pathname}: ${(err as Error).message.slice(0, 200)}`, t));
      }
      if (res.status === 429 && i < attempts - 1) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000);
        continue;
      }
      const j: Record<string, unknown> = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = String(j.error ?? j.error_description ?? j.message ?? '').slice(0, 200);
        throw new EtsyError(redact(`etsy ${method} ${url.pathname}: ${res.status} ${detail}`, t), res.status);
      }
      return j;
    }
    throw new EtsyError(`etsy ${method} ${url.pathname}: gave up after retries`);
  }

  // ---- operations (names = Etsy operationIds, camelCase) -----------------------

  /// GET /v3/application/users/me — scope shops_r
  getMe(): Promise<Record<string, unknown>> {
    return this.request('GET', '/users/me');
  }

  /// GET /v3/application/users/{user_id}/shops
  getShopByOwnerUserId(userId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/users/${userId}/shops`);
  }

  /// GET /v3/application/shops/{shop_id}
  getShop(shopId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/shops/${shopId}`);
  }

  /// getMe → users/{id}/shops → getShop; resolves userId/shopId/shopName
  /// into the token store and persists it. Used by the oauth handshake
  /// and the [ refresh ] button.
  async syncShopInfo(): Promise<EtsyAuthResult> {
    const t = this.ensureTokens();
    const me = await this.getMe();
    t.userId = Number(me.user_id ?? 0) || undefined;
    if (t.userId) {
      const shops = await this.getShopByOwnerUserId(t.userId);
      const shop = (Array.isArray(shops.results) ? shops.results[0] : shops) as Record<string, unknown> | undefined;
      t.shopId = Number(shop?.shop_id ?? 0) || undefined;
      if (t.shopId) {
        const full = await this.getShop(t.shopId);
        t.shopName = typeof full.shop_name === 'string' ? full.shop_name : t.shopName;
      }
    }
    this.persistTokens();
    return { userId: t.userId ?? 0, shopId: t.shopId, shopName: t.shopName };
  }

  /// PUT /v3/application/shops/{shop_id} — scopes shops_r + shops_w
  updateShop(shopId: number, patch: FormBody): Promise<Record<string, unknown>> {
    return this.request('PUT', `/shops/${shopId}`, { form: patch });
  }

  /// GET /v3/application/listings/active — api-key only (no oauth scope
  /// in the OAS), used by the market researcher without a token file.
  findAllListingsActive(params: {
    keywords?: string;
    limit?: number;
    offset?: number;
    sort_on?: string;
    sort_order?: string;
  } = {}): Promise<Record<string, unknown>> {
    return this.request('GET', '/listings/active', { query: { ...params }, auth: false });
  }

  /// GET /v3/application/seller-taxonomy/nodes — api-key only per the OAS.
  getSellerTaxonomyNodes(): Promise<Record<string, unknown>> {
    return this.request('GET', '/seller-taxonomy/nodes', { auth: false });
  }

  /// GET /v3/application/shops/{shop_id}/sections — no oauth scope in the
  /// OAS; sent with the bearer anyway (harmless, and the seller's own shop).
  getShopSections(shopId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/shops/${shopId}/sections`);
  }

  /// GET /v3/application/shops/{shop_id}/listings/active
  findAllActiveListingsByShop(shopId: number, params: { limit?: number; offset?: number } = {}): Promise<Record<string, unknown>> {
    return this.request('GET', `/shops/${shopId}/listings/active`, { query: { ...params } });
  }

  /// GET /v3/application/shops/{shop_id}/listings — scope listings_r
  getListingsByShop(
    shopId: number,
    params: { state?: string; limit?: number; offset?: number; sort_on?: string; sort_order?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request('GET', `/shops/${shopId}/listings`, { query: { ...params } });
  }

  /// POST /v3/application/shops/{shop_id}/listings — scope listings_w.
  /// Creates a DRAFT listing (form-urlencoded; price is USD, not cents).
  createDraftListing(shopId: number, fields: FormBody): Promise<Record<string, unknown>> {
    return this.request('POST', `/shops/${shopId}/listings`, { form: fields });
  }

  /// PATCH /v3/application/shops/{shop_id}/listings/{listing_id}
  /// — scope listings_w. state enum is only active|inactive.
  updateListing(shopId: number, listingId: number, patch: FormBody): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/shops/${shopId}/listings/${listingId}`, { form: patch });
  }

  /// POST .../listings/{id}/images — multipart field `image` + rank.
  uploadListingImage(
    shopId: number,
    listingId: number,
    bytes: Uint8Array,
    name: string,
    rank?: number,
  ): Promise<Record<string, unknown>> {
    const fd = new FormData();
    fd.append('image', new Blob([new Uint8Array(bytes)]), name);
    if (rank !== undefined) fd.append('rank', String(rank));
    return this.request('POST', `/shops/${shopId}/listings/${listingId}/images`, { multipart: fd });
  }

  /// POST .../listings/{id}/files — multipart fields `file`+`name`+`rank`.
  uploadListingFile(
    shopId: number,
    listingId: number,
    bytes: Uint8Array,
    name: string,
    rank?: number,
  ): Promise<Record<string, unknown>> {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(bytes)]), name);
    fd.append('name', name);
    if (rank !== undefined) fd.append('rank', String(rank));
    return this.request('POST', `/shops/${shopId}/listings/${listingId}/files`, { multipart: fd });
  }

  /// GET /v3/application/shops/{shop_id}/receipts — scope transactions_r
  getShopReceipts(shopId: number, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request('GET', `/shops/${shopId}/receipts`, { query: params });
  }

  /// GET /v3/application/shops/{shop_id}/reviews
  getReviewsByShop(shopId: number, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request('GET', `/shops/${shopId}/reviews`, { query: params });
  }

  /// POST /v3/application/shops/{shop_id}/sections — scope shops_w
  createShopSection(shopId: number, title: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/shops/${shopId}/sections`, { form: { title } });
  }

  /// GET /v3/application/listings/{listing_id}/inventory — scope listings_r
  getListingInventory(listingId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/listings/${listingId}/inventory`);
  }

  /// PUT /v3/application/listings/{listing_id}/inventory — scope
  /// listings_w; body is JSON and `products` is required.
  updateListingInventory(
    listingId: number,
    body: Record<string, unknown>,
    query: { max_variations_supported?: string; enable_scale_validation?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/listings/${listingId}/inventory`, { json: body, query: { ...query } });
  }
}

// ---- listing spec + validation ---------------------------------------------------

/// One digital listing to publish: absolute local paths for images/files.
export interface EtsyListingSpec {
  title: string;
  description: string;
  tags: string[];
  priceUsd: number;
  taxonomyId: number;
  /// 1–10 absolute png/jpg paths (rank order = array order)
  images: string[];
  /// 1–5 absolute file paths buyers download (≤20 MB each)
  files: string[];
  sectionId?: number;
}

export type StatLike = (path: string) => { size: number } | null;

const realStat: StatLike = (path) => {
  try {
    return { size: statSync(path).size };
  } catch {
    return null;
  }
};

/// tags: letters/numbers, whitespace, - ' ™ © ® — per the OAS listing
/// regex /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u (underscores and periods are NOT
/// allowed, whatever seller folklore says). Shared with parse.ts.
export const ETSY_TAG_RE = /^[\p{L}\p{Nd}\p{Zs}\-'™©®]+$/u;

/// Pure validation — returns every problem found (empty = publishable).
/// Sizes come from the injectable stat so tests never touch real paths.
export function validateEtsySpec(spec: EtsyListingSpec, cfg: EtsyConfig, stat: StatLike = realStat): string[] {
  const issues: string[] = [];
  const title = spec.title ?? '';
  if (!title.trim()) issues.push('title is empty');
  else if (title.length > 140) issues.push(`title too long (${title.length} > 140 chars)`);
  if (!spec.description?.trim()) issues.push('description is empty');
  const tags = spec.tags ?? [];
  if (tags.length > 13) issues.push(`too many tags (${tags.length} > 13)`);
  for (const t of tags) {
    if (!t.trim()) issues.push('empty tag');
    else if (t.length > 20) issues.push(`tag too long (${t.length} > 20 chars): "${t.slice(0, 24)}"`);
    else if (!ETSY_TAG_RE.test(t)) issues.push(`tag has disallowed characters: "${t}"`);
  }
  if (!(spec.priceUsd >= cfg.minPriceUsd && spec.priceUsd <= cfg.maxPriceUsd)) {
    issues.push(`price $${spec.priceUsd} outside $${cfg.minPriceUsd}–$${cfg.maxPriceUsd}`);
  }
  if (!Number.isFinite(spec.taxonomyId) || spec.taxonomyId < 1) issues.push('taxonomyId missing');
  const images = spec.images ?? [];
  if (images.length < 1) issues.push('needs at least 1 image');
  if (images.length > 10) issues.push(`too many images (${images.length} > 10)`);
  for (const p of images) if (stat(p) === null) issues.push(`image missing: ${p}`);
  const files = spec.files ?? [];
  if (files.length < 1) issues.push('needs at least 1 file');
  if (files.length > 5) issues.push(`too many files (${files.length} > 5)`);
  for (const p of files) {
    const st = stat(p);
    if (st === null) issues.push(`file missing: ${p}`);
    else if (st.size > MAX_FILE_BYTES) issues.push(`file too big (${Math.ceil(st.size / 1024 / 1024)} MB > 20 MB): ${p}`);
  }
  return issues;
}

// ---- spend ledger -----------------------------------------------------------------

export interface LedgerEntry {
  at: number;
  kind: 'listing';
  usd: number;
  listingId?: number;
}

/// Append-only jsonl ledger of real money spent on Etsy — one entry per
/// successful listing activation ($0.20). Injectable path for tests.
export class EtsyLedger {
  constructor(
    private path: string = etsyLedgerPath(),
    private now: () => number = Date.now,
  ) {}

  append(entry: LedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }

  entries(): LedgerEntry[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  /// spend in the current LOCAL calendar month
  monthSpendUsd(now = this.now()): number {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = d.getMonth();
    return this.entries()
      .filter((e) => {
        const ed = new Date(e.at);
        return ed.getFullYear() === y && ed.getMonth() === m;
      })
      .reduce((sum, e) => sum + e.usd, 0);
  }

  /// activations on the current LOCAL calendar day
  listingsToday(now = this.now()): number {
    const day = new Date(now).toDateString();
    return this.entries().filter((e) => new Date(e.at).toDateString() === day).length;
  }
}

// ---- publish -----------------------------------------------------------------

export interface PublishEtsyOpts {
  client: EtsyClient;
  cfg: EtsyConfig;
  ledger: EtsyLedger;
  /// true → PATCH state=active (costs $0.20, gated by the ledger)
  activate: boolean;
  dryRun?: boolean;
  stat?: StatLike;
}

/// Publish one digital listing. Always creates a DRAFT first; activation
/// is a separate PATCH gated by the monthly spend cap and the per-day
/// listing limit — the ledger entry is written only after a successful
/// activation. Failures after the draft exists return status 'draft' with
/// the listingId — nothing on Etsy is ever deleted.
export async function publishEtsyListing(spec: EtsyListingSpec, opts: PublishEtsyOpts): Promise<EtsyShip> {
  const { client, cfg, ledger } = opts;
  const stat = opts.stat ?? realStat;
  const issues = validateEtsySpec(spec, cfg, stat);
  if (issues.length) return { status: 'none', error: issues.join('; ') };

  const shopId = client.shopId;
  if (!shopId && !opts.dryRun) return { status: 'error', error: 'etsy connected but no shop found' };
  const draftFields: FormBody = {
    quantity: 999,
    title: spec.title,
    description: spec.description,
    price: spec.priceUsd,
    who_made: 'i_did',
    when_made: 'made_to_order',
    is_supply: false,
    should_auto_renew: cfg.autoRenew,
    type: 'download',
    taxonomy_id: spec.taxonomyId,
    tags: spec.tags,
    shop_section_id: spec.sectionId,
  };
  const plan = {
    steps: [
      { method: 'POST', url: `${API}/shops/<shop>/listings`, body: draftFields, note: 'creates a DRAFT (free)' },
      ...spec.images.map((p, i) => ({
        method: 'POST',
        url: `${API}/shops/<shop>/listings/<id>/images`,
        body: { image: p, rank: i + 1 },
      })),
      ...spec.files.map((p, i) => ({
        method: 'POST',
        url: `${API}/shops/<shop>/listings/<id>/files`,
        body: { file: p, name: p.split('/').pop(), rank: i + 1 },
      })),
      ...(opts.activate
        ? [
            {
              method: 'PATCH',
              url: `${API}/shops/<shop>/listings/<id>`,
              body: { state: 'active' },
              note: `charges $${ETSY_LISTING_FEE_USD.toFixed(2)} — gated by spend cap + daily limit`,
            },
          ]
        : [{ method: 'note', url: '', note: 'stays a draft — activate:false' }]),
    ],
  };
  if (opts.dryRun) return { status: 'none', plan };

  let listingId: number | undefined;
  try {
    const draft = await client.createDraftListing(shopId!, draftFields);
    listingId = Number(draft.listing_id ?? 0) || undefined;
    if (!listingId) throw new EtsyError('createDraftListing returned no listing_id');
    const ship: EtsyShip = { status: 'draft', listingId, priceUsd: spec.priceUsd, at: Date.now() };
    const url = typeof draft.url === 'string' ? draft.url : undefined;
    if (url) ship.url = url;
    // images rank 1..n in array order — Etsy needs ≥1 to activate
    for (let i = 0; i < spec.images.length; i++) {
      await client.uploadListingImage(shopId!, listingId, readFileSync(spec.images[i]), spec.images[i].split('/').pop() ?? `image-${i + 1}.png`, i + 1);
    }
    for (let i = 0; i < spec.files.length; i++) {
      await client.uploadListingFile(shopId!, listingId, readFileSync(spec.files[i]), spec.files[i].split('/').pop() ?? `file-${i + 1}`, i + 1);
    }
    if (opts.activate) {
      // compare in cents — 25 × 0.2 in floats is 5.000000000000001 > 5
      const cents = (usd: number): number => Math.round(usd * 100);
      if (cents(ledger.monthSpendUsd()) + cents(ETSY_LISTING_FEE_USD) > cents(cfg.monthlySpendCapUsd)) {
        ship.error = `activation refused — monthly spend cap ($${ledger.monthSpendUsd().toFixed(2)} + $${ETSY_LISTING_FEE_USD.toFixed(2)} > $${cfg.monthlySpendCapUsd.toFixed(2)})`;
        return ship;
      }
      if (ledger.listingsToday() >= cfg.maxListingsPerDay) {
        ship.error = `activation refused — daily listing limit reached (${cfg.maxListingsPerDay}/day)`;
        return ship;
      }
      await client.updateListing(shopId!, listingId, { state: 'active' });
      ledger.append({ at: Date.now(), kind: 'listing', usd: ETSY_LISTING_FEE_USD, listingId });
      ship.status = 'active';
    }
    return ship;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    if (listingId) return { status: 'draft', listingId, priceUsd: spec.priceUsd, at: Date.now(), error: msg };
    return { status: 'error', error: msg };
  }
}

// ---- publish spec builder ------------------------------------------------------

/// Appended once to every Etsy description — Etsy's seller policy wants
/// AI-produced content disclosed. buildEtsySpec dedupes on a re-run.
export const ETSY_DISCLOSURE =
  'About this listing: designed by our shop with our own code-based generators. AI tools helped write the generator code and this description, and every item was reviewed before release.';

/// Turn a listed asset into a publishable EtsyListingSpec: builds the kit
/// (zip + cover/thumbnail/gallery), images in Etsy-rank order, the zip as
/// the sole download file, disclosure appended exactly once.
export function buildEtsySpec(asset: Asset, dir: string, taxonomyId: number, sectionId?: number): EtsyListingSpec {
  const isPack = asset.kind === 'pack';
  const itemNames =
    asset.itemNames?.length
      ? asset.itemNames
      : [];
  const kit = buildKit(dir, {
    sku: asset.sku,
    title: asset.listing?.title ?? asset.title,
    isPack,
    size: asset.size,
    itemNames,
    framesPerItem: isPack ? asset.frames : asset.frames,
    fps: 4,
  });
  const images = ['cover.png', 'gallery-1.png', 'thumbnail.png']
    .map((f) => join(kit.dir, f))
    .filter((p) => existsSync(p));
  const base = asset.listing?.description ?? asset.title;
  const description = base.includes(ETSY_DISCLOSURE) ? base : `${base}\n\n${ETSY_DISCLOSURE}`;
  return {
    title: asset.listing?.title ?? asset.title,
    description,
    tags: asset.listing?.tags ?? asset.tags,
    priceUsd: asset.listing?.priceUsd ?? 2.99,
    taxonomyId,
    images,
    files: [join(kit.dir, kit.zipName)],
    sectionId,
  };
}

/// Activate an EXISTING draft listing — the only path once a listing_id
/// exists; creating a second draft for the same sku is never allowed.
/// Same cap/day checks as publishEtsyListing; the ledger entry is written
/// only after a successful PATCH.
export async function activateEtsyDraft(
  listingId: number,
  opts: { client: EtsyClient; cfg: EtsyConfig; ledger: EtsyLedger },
): Promise<EtsyShip> {
  const { client, cfg, ledger } = opts;
  const shopId = client.shopId;
  const ship: EtsyShip = { status: 'draft', listingId, at: Date.now() };
  if (!shopId) {
    ship.error = 'etsy connected but no shop found';
    return ship;
  }
  const cents = (usd: number): number => Math.round(usd * 100);
  if (cents(ledger.monthSpendUsd()) + cents(ETSY_LISTING_FEE_USD) > cents(cfg.monthlySpendCapUsd)) {
    ship.error = `activation refused — monthly spend cap ($${ledger.monthSpendUsd().toFixed(2)} + $${ETSY_LISTING_FEE_USD.toFixed(2)} > $${cfg.monthlySpendCapUsd.toFixed(2)})`;
    return ship;
  }
  if (ledger.listingsToday() >= cfg.maxListingsPerDay) {
    ship.error = `activation refused — daily listing limit reached (${cfg.maxListingsPerDay}/day)`;
    return ship;
  }
  try {
    await client.updateListing(shopId, listingId, { state: 'active' });
    ledger.append({ at: Date.now(), kind: 'listing', usd: ETSY_LISTING_FEE_USD, listingId });
    ship.status = 'active';
    return ship;
  } catch (err) {
    ship.error = (err as Error).message.slice(0, 300);
    return ship;
  }
}
