// Shared helpers for the worker ⇄ relay link — pure, testable.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  ClientMessage, StateMessage, ItchState, WorkerStatePayload, WorkerStatus,
} from '../../shared/protocol.js';

export const SKU_RE = /^[a-z0-9-]{1,60}$/;
/// files a worker may push for an asset — nothing else is ever written.
/// `atlas.json` is the pack layout; `items/<slug>.png` are pack strips.
export const ASSET_FILES = new Set([
  'sheet.png', 'preview.png', 'meta.json', 'atlas.json', 'listing.json', 'gen.mjs',
  'kit/cover.png', 'kit/thumbnail.png', // zip stays on the worker — too big
]);
export const ASSET_ITEM_RE = /^items\/[a-z0-9-]{1,40}\.png$/;
export const assetFileOk = (name: string): boolean => ASSET_FILES.has(name) || ASSET_ITEM_RE.test(name);
export const MAX_LINK_MSG = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/// Commands browsers may send through the relay to the worker.
export const FORWARDABLE = new Set<ClientMessage['type']>([
  'startShift', 'pauseShift', 'stopShift', 'setModels', 'setCaps', 'setMode',
  'setMarketSource', 'directive', 'cancelAgent',
  'shipGumroad', 'publishGumroad', 'setGumroadConfig',
]);

/// Timing-safe `Authorization: Bearer <key>` check.
export function bearerValid(header: string | undefined, key: string): boolean {
  if (!header || !key) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${key}`);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/// Validate+decode a worker `asset` message → { sku, files: {name: bytes} }.
/// Returns null (and never throws) on anything malformed.
export function parseAssetMsg(raw: unknown): { sku: string; files: Record<string, Buffer> } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as { sku?: unknown; files?: unknown };
  if (typeof m.sku !== 'string' || !SKU_RE.test(m.sku)) return null;
  if (typeof m.files !== 'object' || m.files === null) return null;
  const files: Record<string, Buffer> = {};
  for (const [name, b64] of Object.entries(m.files as Record<string, unknown>)) {
    if (!assetFileOk(name) || typeof b64 !== 'string') return null;
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return null;
    files[name] = bytes;
  }
  return Object.keys(files).length ? { sku: m.sku, files } : null;
}

export const fileHash = (bytes: Buffer | string): string => createHash('sha1').update(bytes).digest('hex');

/// What the relay shows browsers: the worker's last known factory state,
/// itch research from the relay's own scanner, and the link status.
/// Returns null when there is no worker state at all (scanner-only view).
export function mergeRelayState(
  worker: WorkerStatePayload | null,
  relayItch: ItchState,
  status: WorkerStatus,
): StateMessage | null {
  if (!worker) return null;
  return {
    type: 'state',
    shift: worker.shift,
    agents: worker.agents,
    candidates: worker.candidates,
    assets: worker.assets,
    jobs: worker.jobs,
    decisions: worker.decisions,
    events: worker.events,
    market: worker.market,
    config: worker.config,
    acp: worker.acp,
    latestTrendReport: worker.latestTrendReport,
    itch: relayItch,
    trendReports: worker.trendReports,
    devinEnabled: status.connected && worker.devinEnabled,
    worker: status,
    usage: worker.usage,
    tokenCapHit: worker.tokenCapHit,
    channels: worker.channels ?? { gumroad: { configured: false } },
  };
}

/// Minimal KEY=VALUE parser for ~/.alien-factory/worker.env — no values are
/// ever logged by callers. Ignores blanks/comments, keeps quotes out.
export function parseEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
  }
  return out;
}
