// Seller taxonomy lookup for Etsy listings: the copywriter writes a
// category path ("Craft Supplies & Tools > Digital > Clip Art") and we
// resolve it to a taxonomy_id at publish time. getSellerTaxonomyNodes is
// an api-key-only endpoint per the OAS — no oauth needed — and the tree
// is cached on disk for 7 days.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { EtsyClient } from './channels/etsy.js';

const CACHE_MS = 7 * 24 * 3_600_000;
export const taxonomyCachePath = (): string => join(DATA_DIR, 'etsy-taxonomy.json');

export interface TaxonomyNode {
  id: number;
  level: number;
  name: string;
  parent_id?: number | null;
  children?: TaxonomyNode[];
}

interface CacheFile {
  at: number;
  results: TaxonomyNode[];
}

/// Fetch + cache the seller taxonomy tree. `force` skips the 7-day cache.
export async function loadTaxonomy(
  opts: { client?: EtsyClient; cachePath?: string; now?: () => number; force?: boolean } = {},
): Promise<TaxonomyNode[]> {
  const path = opts.cachePath ?? taxonomyCachePath();
  const now = (opts.now ?? Date.now)();
  if (!opts.force && existsSync(path)) {
    try {
      const c = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
      if (now - c.at < CACHE_MS && Array.isArray(c.results)) return c.results;
    } catch {
      /* refetch */
    }
  }
  const client = opts.client ?? new EtsyClient();
  const j = await client.getSellerTaxonomyNodes();
  const results = (Array.isArray(j.results) ? j.results : []) as TaxonomyNode[];
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: now, results } satisfies CacheFile));
  } catch {
    /* best effort */
  }
  return results;
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1),
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/// Flatten the tree to "A > B > C" paths → resolve the copywriter's path
/// to a taxonomy_id. Exact case-insensitive full-path match wins; else the
/// best Jaccard token overlap on full paths, if ≥ 0.5; else null.
export function resolveTaxonomy(path: string, nodes: TaxonomyNode[]): number | null {
  const flat: { full: string; id: number }[] = [];
  const walk = (list: TaxonomyNode[] | undefined, prefix: string): void => {
    for (const n of list ?? []) {
      const full = prefix ? `${prefix} > ${n.name}` : n.name;
      flat.push({ full, id: Number(n.id) });
      walk(n.children, full);
    }
  };
  walk(nodes, '');
  const want = path.trim().toLowerCase();
  const exact = flat.find((f) => f.full.toLowerCase() === want);
  if (exact) return exact.id;
  const wantTok = tokens(path);
  let best: { id: number; score: number } | null = null;
  for (const f of flat) {
    const score = jaccard(wantTok, tokens(f.full));
    if (score >= 0.5 && (!best || score > best.score)) best = { id: f.id, score };
  }
  return best?.id ?? null;
}
