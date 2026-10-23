// Gumroad v2 channel — the ONLY real storefront path (gated, per-asset,
// draft-by-default; see AGENTS.md). `fetch` is injected for tests; the
// access token comes from env and is never logged, stored, or echoed back.
//
// API references (verified 2025):
//   https://gumroad.com/api — files presign/PUT/complete/abort, products,
//     covers (url only) and thumbnails (signed_blob_id or url).
//   https://github.com/antiwork/gumroad/blob/main/app/javascript/components/
//     ApiDocumentation/Endpoints/Covers.tsx — covers take `url` (public URL
//     only; "cannot be a private or pre-signed upload URL").
//   .../Endpoints/Thumbnails.tsx — `signed_blob_id` = ActiveStorage direct
//     upload id, which the public v2 API does NOT expose (it needs Rails'
//     /rails/active_storage/direct_uploads, session-CSRF side). Our files
//     aren't publicly reachable, so covers/thumbnail are a MANUAL step —
//     kit/cover.png + kit/thumbnail.png are uploaded in Gumroad's editor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_DIR } from '../config.js';
import { buildKit, type BuiltKit } from '../kit.js';
import { relayHttpBase, signKitUrl } from '../link.js';
import { shipEligibility, type ShipMeta } from '../../../shared/shop.js';
import type { Asset, GumroadConfig, GumroadShip } from '../../../shared/protocol.js';

export { shipEligibility, listingConsistency } from '../../../shared/shop.js';
export type { ShipMeta };

const API = 'https://api.gumroad.com/v2';
const gumroadToken = (): string => process.env.GUMROAD_ACCESS_TOKEN ?? '';

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<Record<string, unknown>>;
    headers: { get(name: string): string | null };
  }>;
}

const realFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

class GumroadError extends Error {}

interface Presign {
  upload_id: string;
  key: string;
  file_url: string;
  parts: { part_number: number; presigned_url: string }[];
}

async function apiPost(
  f: FetchLike,
  path: string,
  params: Record<string, unknown>,
  method = 'POST',
): Promise<Record<string, unknown>> {
  // JSON + Bearer: Rails parses form-encoded indexed keys (parts[0][etag])
  // into a HASH, not an array — Gumroad's `Array(params[:parts])` then 400s
  // ("each part must have scalar part_number and etag values"). JSON bodies
  // carry real arrays for parts/files/tags. Bearer verified on GET /v2/user.
  const res = await f(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${gumroadToken()}`,
    },
    body: JSON.stringify(params),
  });
  const j: Record<string, unknown> = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    throw new GumroadError(`gumroad ${method} ${path}: ${res.status} ${String(j.message ?? j.error ?? '').slice(0, 200)}`);
  }
  return j;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function itemNamesOf(asset: Asset, meta: ShipMeta | undefined): string[] {
  if (asset.itemNames?.length) return asset.itemNames;
  return (
    meta?.perItem
      ?.map((p) => (p as { name?: string }).name)
      .filter((x): x is string => !!x) ?? []
  );
}

function descriptionHtml(asset: Asset, meta: ShipMeta | undefined): string {
  const isPack = asset.kind === 'pack';
  const n = meta?.items ?? asset.items ?? 1;
  const frames = framesForCopy(asset, meta);
  const items = itemNamesOf(asset, meta);
  const lines = [
    `<p>${esc(asset.listing?.description ?? asset.title)}</p>`,
    `<p><b>${n}</b> ${motion(frames)} ${asset.size}×${asset.size}px sprite${n > 1 ? 's' : ''}, transparent PNG${isPack ? ' + atlas.json' : ''}.</p>`,
  ];
  if (items.length) lines.push(`<p>Items: ${esc(items.join(', '))}</p>`);
  lines.push(
    `<p>License: use in personal and commercial games/projects, modify freely, no attribution required. Do not resell or redistribute the assets themselves.</p>`,
    `<p><i>Made with procedural code written by AI agents and reviewed before release.</i></p>`,
  );
  return lines.join('\n');
}

/// max frames across items (pack) or the sprite's frames — drives copy
function framesForCopy(asset: Asset, meta: ShipMeta | undefined): number {
  return asset.kind === 'pack' ? (meta?.perItem?.[0]?.frames ?? asset.frames) : (meta?.frames ?? asset.frames);
}

const motion = (frames: number): string => (frames > 1 ? `${frames}-frame animations` : 'static');

function customSummary(asset: Asset, meta: ShipMeta | undefined): string {
  const n = meta?.items ?? asset.items ?? 1;
  const frames = framesForCopy(asset, meta);
  const atlas = asset.kind === 'pack' ? ' + atlas.json' : '';
  if (frames <= 1) return `${n} static ${asset.size}×${asset.size} sprite${n > 1 ? 's' : ''}, PNG${atlas}`;
  return `${n} ${asset.size}×${asset.size} sprite${n > 1 ? 's' : ''}, ${frames}-frame animation${frames > 1 ? 's' : ''}, PNG${atlas}`;
}

/// Everything shipGumroad needs resolved up front (testable without IO in
/// the callers' tests — factory loads meta + listing itself).
export interface ShipRequest {
  asset: Asset;
  meta: ShipMeta | undefined;
  cfg: GumroadConfig;
  shippedToday: number;
  /// assets/<sku> — injected so tests don't touch FACTORY_DIR
  dir: string;
}

export interface ShipResult {
  ship: GumroadShip;
  kit?: BuiltKit;
  plan?: unknown;
}

function kitSpec(asset: Asset, meta: ShipMeta | undefined): Parameters<typeof buildKit>[1] {
  const isPack = asset.kind === 'pack';
  return {
    sku: asset.sku,
    title: asset.listing?.title ?? asset.title,
    isPack,
    size: asset.size,
    itemNames: itemNamesOf(asset, meta),
    framesPerItem: isPack ? (meta?.perItem?.[0]?.frames ?? asset.frames) : (meta?.frames ?? asset.frames),
    fps: 4,
  };
}

export function loadMeta(sku: string): ShipMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(FACTORY_DIR, 'assets', sku, 'meta.json'), 'utf8')) as ShipMeta;
  } catch {
    return undefined;
  }
}

/// Ship one asset to Gumroad. dryRun returns the exact request plan and
/// never touches the network. Real ships upload the kit zip, create a
/// draft product, and optionally publish it. Never ships the same sku
/// twice. Errors land on ship.error — the token is never in any message.
export async function shipGumroad(
  req: ShipRequest,
  opts: { dryRun?: boolean; fetchImpl?: FetchLike; syncHook?: () => void } = {},
): Promise<ShipResult> {
  const { asset, meta, cfg } = req;
  const prev = asset.channels?.gumroad;
  const elig = shipEligibility(asset, meta, cfg, req.shippedToday);
  if (!elig.ok) {
    // keep an existing draft/publish state + product id — the gate failing
    // must not clobber a real product record
    return {
      ship: {
        ...(prev ?? {}),
        status: prev?.status === 'draft' || prev?.status === 'published' ? prev.status : 'error',
        error: elig.issues.join('; '),
      },
    };
  }
  const kit = buildKit(req.dir, kitSpec(asset, meta));
  const zip = readFileSync(join(kit.dir, kit.zipName));
  const priceCents = Math.round((asset.listing?.priceUsd ?? 2.99) * 100);
  const createBody: Record<string, unknown> = {
    native_type: 'digital',
    name: asset.listing?.title ?? asset.title,
    price: priceCents,
    files: [{ url: '<file_url from upload>' }],
    description: descriptionHtml(asset, meta),
    custom_summary: customSummary(asset, meta),
    published: false,
    tags: (asset.listing?.tags ?? asset.tags).slice(0, 6),
  };
  const plan = {
    steps: [
      { method: 'POST', url: `${API}/files/presign`, body: { filename: kit.zipName, file_size: zip.length } },
      { method: 'PUT', url: '<part presigned_url>', note: `${Math.ceil(zip.length / (100 * 1024 * 1024))} part(s), raw bytes` },
      {
        method: 'POST',
        url: `${API}/files/complete`,
        body: { upload_id: '<id>', key: '<key>', parts: [{ part_number: 1, etag: '"<etag from PUT>"' }] },
      },
      { method: 'POST', url: `${API}/products`, body: createBody },
      ...(cfg.autoPublish ? [{ method: 'PUT', url: `${API}/products/<id>/enable` }] : []),
      {
        method: 'POST',
        url: `${API}/products/<id>/covers`,
        body: { url: '<signed public relay url — preview.gif, then cover.png, gallery-1.png>' },
      },
      { method: 'POST', url: `${API}/products/<id>/thumbnail`, body: { url: '<signed public relay url — thumbnail.png>' } },
      {
        method: 'note',
        url: '',
        note: 'images attach automatically when the worker is linked to the Railway relay (signed /public/kit URLs); without a relay attach kit/*.png by hand in the gumroad editor',
      },
    ],
    kit: { zip: kit.zipName, bytes: zip.length, files: kit.files },
  };
  if (opts.dryRun) {
    // a successful dry run clears any stale error/status — keep a real
    // draft/published record, else back to 'none'
    const status =
      prev?.status === 'draft' || prev?.status === 'published' ? prev.status : ('none' as const);
    return {
      ship: {
        status,
        productId: prev?.productId,
        editUrl: prev?.editUrl,
        shortUrl: prev?.shortUrl,
        at: prev?.at,
        plan,
      },
      kit,
      plan,
    };
  }

  if (!gumroadToken()) {
    return { ship: { status: 'error', error: 'GUMROAD_ACCESS_TOKEN not set — add it to worker.env and restart the worker' }, kit };
  }
  const f = opts.fetchImpl ?? realFetch;
  let uploadId = '';
  let key = '';
  try {
    const presign = (await apiPost(f, '/files/presign', {
      filename: kit.zipName,
      file_size: zip.length,
    })) as unknown as Presign;
    uploadId = String(presign.upload_id);
    key = String(presign.key);
    const etags: { part_number: number; etag: string }[] = [];
    for (const part of presign.parts ?? []) {
      const res = await f(String(part.presigned_url), { method: 'PUT', body: zip });
      if (!res.ok) throw new GumroadError(`part ${part.part_number} upload failed: ${res.status}`);
      const etag = res.headers.get('etag') ?? '';
      if (!etag) throw new GumroadError(`part ${part.part_number} upload returned no ETag`);
      etags.push({ part_number: Number(part.part_number), etag });
    }
    await apiPost(f, '/files/complete', { upload_id: uploadId, key, parts: etags });

    createBody.files = [{ url: String(presign.file_url) }];
    const created = await apiPost(f, '/products', createBody);
    const product = (created.product ?? created) as { id?: string; product_id?: string; edit_url?: string; short_url?: string };
    const productId = String(product.id ?? product.product_id ?? '');
    const ship: GumroadShip = {
      status: 'draft',
      productId,
      editUrl: typeof product.edit_url === 'string' ? product.edit_url : undefined,
      shortUrl: typeof product.short_url === 'string' ? product.short_url : undefined,
      at: Date.now(),
    };
    if (cfg.autoPublish && productId) {
      try {
        await apiPost(f, `/products/${encodeURIComponent(productId)}/enable`, {}, 'PUT');
        ship.status = 'published';
      } catch (err) {
        ship.error = `draft created but auto-publish failed: ${(err as Error).message.slice(0, 200)}`;
      }
    }
    // best-effort: covers + thumbnail via signed public relay URLs — a
    // failure lands in imagesError and never blocks the draft
    const withImages = await attachGumroadImages(
      { asset: { ...asset, channels: { ...(asset.channels ?? {}), gumroad: ship } }, meta, dir: req.dir, kit },
      { fetchImpl: opts.fetchImpl, syncHook: opts.syncHook },
    );
    Object.assign(ship, { images: withImages.images, imagesError: withImages.imagesError });
    return { ship, kit };
  } catch (err) {
    if (uploadId) {
      try {
        await apiPost(f, '/files/abort', { upload_id: uploadId, key });
      } catch {
        /* best effort */
      }
    }
    return { ship: { status: 'error', error: (err as Error).message.slice(0, 300) }, kit };
  }
}

export interface AttachOpts {
  fetchImpl?: FetchLike;
  /// pushes kit files to the relay so the signed URLs go live (worker-link)
  syncHook?: () => void;
  pollMs?: number;
  pollIntervalMs?: number;
}

/// Attach kit images to a product that already exists on Gumroad, via
/// signed public URLs on the relay. Needs ALIEN_FACTORY_RELAY_URL +
/// ALIEN_FACTORY_WORKER_KEY on the worker. Non-fatal: problems land in
/// ship.imagesError and the draft stays a draft.
export async function attachGumroadImages(
  req: { asset: Asset; meta: ShipMeta | undefined; dir: string; kit?: BuiltKit },
  opts: AttachOpts = {},
): Promise<GumroadShip> {
  const cur = req.asset.channels?.gumroad;
  if (!cur?.productId) {
    return { ...(cur ?? { status: 'error' }), imagesError: 'no product to attach images to' } as GumroadShip;
  }
  const relayUrl = process.env.ALIEN_FACTORY_RELAY_URL ?? '';
  const key = process.env.ALIEN_FACTORY_WORKER_KEY ?? '';
  if (!relayUrl || !key) {
    return { ...cur, imagesError: 'images need the Railway relay for public URLs — attach kit/*.png by hand' };
  }
  if (!gumroadToken()) {
    return { ...cur, imagesError: 'GUMROAD_ACCESS_TOKEN not set' };
  }
  const kit = req.kit ?? buildKit(req.dir, kitSpec(req.asset, req.meta));
  const base = relayHttpBase(relayUrl);
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const urlFor = (file: string) => signKitUrl(key, base, req.asset.sku, file, exp);
  const wanted = ['preview.gif', 'cover.png', 'gallery-1.png'];
  const covers = wanted.filter((x) => existsSync(join(kit.dir, x)));
  const f = opts.fetchImpl ?? realFetch;
  try {
    // kit files reach the relay via the normal asset sync — kick it, then
    // wait until the first signed URL is actually reachable
    opts.syncHook?.();
    if (covers.length || existsSync(join(kit.dir, 'thumbnail.png'))) {
      const deadline = Date.now() + (opts.pollMs ?? 30_000);
      const first = urlFor(covers[0] ?? 'thumbnail.png');
      let ok = false;
      while (Date.now() < deadline && !ok) {
        try {
          ok = (await f(first, { method: 'GET' })).ok;
        } catch {
          ok = false;
        }
        if (!ok) await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 2_000));
      }
      if (!ok) return { ...cur, imagesError: `kit images never became reachable at ${base} — is the worker linked?` };
    }
    const errs: string[] = [];
    let done = 0;
    for (const file of covers) {
      try {
        await apiPost(f, `/products/${encodeURIComponent(cur.productId)}/covers`, { url: urlFor(file) });
        done++;
      } catch (err) {
        errs.push(`${file}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    let thumbnail = false;
    if (existsSync(join(kit.dir, 'thumbnail.png'))) {
      try {
        await apiPost(f, `/products/${encodeURIComponent(cur.productId)}/thumbnail`, { url: urlFor('thumbnail.png') });
        thumbnail = true;
      } catch (err) {
        errs.push(`thumbnail: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    const out: GumroadShip = {
      ...cur,
      images: { covers: done, thumbnail, at: Date.now() },
    };
    if (errs.length) out.imagesError = errs.join('; ');
    else delete out.imagesError;
    return out;
  } catch (err) {
    return { ...cur, imagesError: (err as Error).message.slice(0, 200) };
  }
}

/// Publish an existing draft product (PUT /v2/products/:id/enable).
export async function publishGumroad(
  asset: Asset,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<GumroadShip> {
  const cur = asset.channels?.gumroad;
  if (!cur?.productId || cur.status !== 'draft') {
    return { ...cur, status: 'error', error: 'no draft product to publish' } as GumroadShip;
  }
  if (!gumroadToken()) {
    return { ...cur, status: 'error', error: 'GUMROAD_ACCESS_TOKEN not set' } as GumroadShip;
  }
  const f = opts.fetchImpl ?? realFetch;
  try {
    await apiPost(f, `/products/${encodeURIComponent(cur.productId)}/enable`, {}, 'PUT');
    // fresh record — drops any stale error/plan text
    return { status: 'published', productId: cur.productId, editUrl: cur.editUrl, shortUrl: cur.shortUrl, at: Date.now() };
  } catch (err) {
    return { ...cur, status: 'error', error: (err as Error).message.slice(0, 300) };
  }
}

export function assetDirExists(sku: string): boolean {
  return existsSync(join(FACTORY_DIR, 'assets', sku));
}
