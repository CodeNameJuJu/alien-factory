// Pure parsing / decision helpers for the factory pipeline — kept free of IO
// so parse.test.ts can drive them directly.
import { resolve, sep } from 'node:path';
import type {
  AgentKind,
  AssetInspection,
  Candidate,
  DailyTokenCaps,
  JobKind,
  ModelPrices,
  Opportunity,
  OrderSpec,
  UsageCounts,
  UsageState,
  UsageTotals,
} from '../../shared/protocol.js';

type Json = any;

/// Text after a `## <title>` heading up to the next heading of same/higher
/// level. Null when absent.
export function section(text: string, title: string): string | null {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim().toLowerCase() === title.toLowerCase()) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join('\n').trim();
  return body || null;
}

/// First ``` fenced block inside `body` (any language tag), parsed as JSON.
export function fencedJson(body: string | null): Json | null {
  if (!body) return null;
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(body);
  const raw = m ? m[1] : body;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

export interface OverlordDecision {
  id: string; // candidate id, e.g. "c3"
  approve: boolean;
  reason: string;
  smith?: string;
  brief?: string;
}

export function parseDecisions(text: string): OverlordDecision[] {
  const raw = fencedJson(section(text, 'Decisions'));
  if (!Array.isArray(raw)) return [];
  const out: OverlordDecision[] = [];
  for (const d of raw) {
    if (typeof d?.id !== 'string') continue;
    out.push({
      id: d.id,
      approve: d.approve === true || d.approve === 'true',
      reason: String(d.reason ?? ''),
      smith: typeof d.smith === 'string' && d.smith ? d.smith : undefined,
      brief: typeof d.brief === 'string' && d.brief ? d.brief : undefined,
    });
  }
  return out;
}

/// Approvals beyond `cap` are flipped to declined ("over capacity").
export function applyApprovalCap(decisions: OverlordDecision[], cap: number): OverlordDecision[] {
  let approved = 0;
  return decisions.map((d) => {
    if (!d.approve) return d;
    approved++;
    if (approved <= cap) return d;
    return { ...d, approve: false, reason: `over capacity (>${cap} approvals this turn)` };
  });
}

/// The requested smith if valid, else the smith with the shortest queue
/// (ties → first in list). Empty smithIds → undefined.
export function pickSmith(
  requested: string | undefined,
  smithIds: string[],
  queueLengths: Record<string, number>,
): string | undefined {
  if (requested && smithIds.includes(requested)) return requested;
  let best: string | undefined;
  for (const id of smithIds) {
    if (best === undefined || (queueLengths[id] ?? 0) < (queueLengths[best] ?? 0)) best = id;
  }
  return best;
}

export interface DemandProposal extends OrderSpec {
  why: string;
  demand: number;
  /// itch.io urls the scout cites as evidence (itch market source)
  evidence?: string[];
  priceBand?: string;
}

/// The scout's `## Demand` block: a fenced json array of proposals.
export function parseDemand(text: string): DemandProposal[] {
  const raw = fencedJson(section(text, 'Demand'));
  if (!Array.isArray(raw)) return [];
  const out: DemandProposal[] = [];
  for (const o of raw) {
    if (typeof o?.title !== 'string' || !o.title.trim()) continue;
    out.push({
      title: o.title.trim(),
      tags: Array.isArray(o.tags) ? o.tags.filter((t: Json) => typeof t === 'string') : [],
      size: o.size === 32 ? 32 : 16,
      frames: Math.min(8, Math.max(1, Math.round(Number(o.frames) || 1))),
      variantOf: typeof o.variantOf === 'string' && o.variantOf ? o.variantOf : undefined,
      brief: String(o.brief ?? ''),
      why: String(o.why ?? o.brief ?? ''),
      demand: (() => {
        const n = Number(o.demand);
        return Math.min(10, Math.max(1, Math.round(Number.isFinite(n) ? n : 5)));
      })(),
      evidence: Array.isArray(o.evidence) ? o.evidence.filter((u: Json) => typeof u === 'string').slice(0, 5) : undefined,
      priceBand: typeof o.priceBand === 'string' && o.priceBand ? o.priceBand : undefined,
    });
  }
  return out;
}

/// The scout's report text = everything before `## Demand` (falls back to a
/// `## Trend report` section, then the whole reply).
export function extractReport(text: string): string {
  const i = text.indexOf('## Demand');
  if (i > 0) return text.slice(0, i).trim();
  return section(text, 'Trend report') ?? text.trim();
}

/// "## Inspection / Verdict: PASS / Score: 8 / Notes: ..." — null if absent.
export function parseInspection(text: string): AssetInspection | null {
  const body = section(text, 'Inspection');
  if (!body) return null;
  const vm = /Verdict:\s*(PASS|FAIL)/i.exec(body);
  if (!vm) return null;
  const sm = /Score:\s*(\d+(?:\.\d+)?)/i.exec(body);
  const nm = /Notes:\s*([\s\S]*)$/i.exec(body);
  return {
    verdict: vm[1].toUpperCase() as 'PASS' | 'FAIL',
    score: Math.min(10, Math.max(1, Math.round(Number(sm?.[1] ?? 5)))),
    notes: (nm?.[1] ?? '').trim(),
  };
}

/// The scout's "## Trend report" section, verbatim markdown.
export function parseTrendReport(text: string): string | null {
  return section(text, 'Trend report');
}

// ---- permission path guard -------------------------------------------------

const PATH_FIELDS = new Set(['file_path', 'path', 'cwd', 'workdir', 'filename', 'filepath', 'directory', 'dir']);

/// Collects every filesystem path a tool call touches: toolCall.locations
/// entries plus rawInput fields that look like absolute (or relative) paths.
export function permissionPaths(params: Json): string[] {
  const out = new Set<string>();
  const tc = params?.toolCall ?? {};
  if (Array.isArray(tc.locations)) {
    for (const loc of tc.locations) {
      if (typeof loc?.path === 'string') out.add(loc.path);
    }
  }
  const scan = (v: Json) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && PATH_FIELDS.has(k.toLowerCase()) && val.trim()) {
        out.add(val);
      } else if (val && typeof val === 'object') {
        scan(val);
      }
    }
  };
  scan(tc.rawInput);
  return [...out];
}

/// True iff every path resolves inside `root` (or there are none — e.g. a
/// shell command with no file locations is allowed; see AGENTS.md).
export function pathsInsideFactory(paths: string[], factoryDir: string): boolean {
  const root = resolve(factoryDir);
  for (const p of paths) {
    const r = resolve(root, p); // absolute p wins over the root prefix
    if (r !== root && !r.startsWith(root + sep)) return false;
  }
  return true;
}

/// Pick the option id the auto-approver should send back. Returns
/// `{ optionId }` to select, or `{ optionId: null }` to cancel outright.
export function decidePermission(
  params: Json,
  factoryDir: string,
): { optionId: string | null; allowed: boolean; paths: string[] } {
  const paths = permissionPaths(params);
  const options: { optionId?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : [];
  const inside = pathsInsideFactory(paths, factoryDir);
  const pick = (pred: (o: { kind?: string }) => boolean): string | null => {
    const o = options.find(pred);
    return o && typeof o.optionId === 'string' ? o.optionId : null;
  };
  if (inside) {
    return {
      optionId: pick((o) => o.kind === 'allow_once') ?? pick((o) => (o.kind ?? '').startsWith('allow')),
      allowed: true,
      paths,
    };
  }
  return {
    optionId: pick((o) => (o.kind ?? '').startsWith('reject')),
    allowed: false,
    paths,
  };
}

// ---- URL host guard (research mode) ------------------------------------------
//
// Web-fetch tool calls carry no file paths, so the path guard lets them
// through. In research mode the scout may ONLY fetch itch.io — any other
// host (incl. itch.io lookalikes) gets the request rejected.

/// Every http(s) URL inside rawInput string fields.
export function rawInputUrls(params: Json): string[] {
  const out = new Set<string>();
  const scan = (v: Json) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) out.add(m[0]);
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v)) scan(val);
    }
  };
  scan(params?.toolCall?.rawInput);
  return [...out];
}

/// True iff every URL's host is itch.io / *.itch.io / img.itch.zone.
/// `itch.io.evil.com` and `evil.itch.io.evil.com` fail the suffix check.
export function urlsAllowed(params: Json): boolean {
  for (const u of rawInputUrls(params)) {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (!(host === 'itch.io' || host === 'img.itch.zone' || host.endsWith('.itch.io'))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---- generated-asset checks -------------------------------------------------

export interface MetaJson {
  w?: number;
  h?: number;
  frames?: number;
  colors?: string[];
  opaqueRatio?: number;
  emptyFrames?: number;
  identicalFrames?: number;
}

export interface OrderLike {
  size: number;
  frames: number;
}

/// Pure check of a generated asset's meta.json against the order.
export function checkMeta(meta: MetaJson | null, order: OrderLike): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!meta) return { passed: false, issues: ['no meta.json — did gen.mjs call emit()?'] };
  if (meta.w !== order.size || meta.h !== order.size) {
    issues.push(`frame size ${meta.w}x${meta.h} — expected ${order.size}x${order.size}`);
  }
  if (meta.w !== 16 && meta.w !== 32) issues.push(`frame width ${meta.w} must be 16 or 32`);
  if (typeof meta.frames !== 'number' || meta.frames < 1 || meta.frames > 8) {
    issues.push(`frames ${meta.frames} out of range 1-8`);
  }
  if (Array.isArray(meta.colors) && meta.colors.length > 16) {
    issues.push(`${meta.colors.length} colours — limit is 16`);
  }
  const or = meta.opaqueRatio;
  if (typeof or !== 'number' || or < 0.08 || or > 0.9) {
    issues.push(`opaqueRatio ${or} outside 0.08-0.9`);
  }
  if (meta.emptyFrames) issues.push(`${meta.emptyFrames} empty frame(s)`);
  if ((meta.frames ?? 0) > 1 && meta.identicalFrames === meta.frames) {
    issues.push('all frames are identical — animate it');
  }
  return { passed: issues.length === 0, issues };
}

// ---- job → agent kind ---------------------------------------------------------

/// Which agent role takes which job kind — job kinds are verbs
/// (forge/inspect/pack), agent kinds are nouns (smith/inspector/packer).
export const JOB_AGENT_KIND: Record<JobKind, AgentKind> = {
  scout: 'scout',
  forge: 'smith',
  inspect: 'inspector',
  pack: 'packer',
};

/// Skus whose forge job is done and whose inspect job is queued but whose
/// asset status never moved past 'forging' (leftover from the old
/// assignable() bug — inspect jobs could never be picked up, so the handoff
/// status was never set). Used by loadState recovery.
export function inspectingRecoverySkus(
  assets: { sku: string; status: string }[],
  jobs: { kind: JobKind; sku?: string; status: string }[],
): string[] {
  const doneForge = new Set(jobs.filter((j) => j.kind === 'forge' && j.status === 'done').map((j) => j.sku));
  const queuedInspect = new Set(jobs.filter((j) => j.kind === 'inspect' && j.status === 'queued').map((j) => j.sku));
  return assets.filter((a) => a.status === 'forging' && doneForge.has(a.sku) && queuedInspect.has(a.sku)).map((a) => a.sku);
}

// ---- scout gating + research→full promotion (pure) ----------------------------

/// "Do we have fresh data for the scout to analyse?" — separate from "did a
/// scan just succeed". Returns true when a scout job should be queued:
/// - FULL: itch analysis exists, nothing pending for the overlord, no scout
///   job, AND (the current analysis isn't covered by any trend report OR the
///   last scout run finished more than `rescoutMs` ago)
/// - RESEARCH: itch analysis exists and no trend report covers that scan yet
export function shouldQueueScout(args: {
  mode: 'research' | 'full';
  /// itch.lastScanAt — null = no data yet
  analysisAt: number | null;
  hasPendingCandidates: boolean;
  hasScoutJob: boolean;
  /// scanAt of every existing trend report
  reportScanAts: (number | undefined)[];
  /// when the last scout job finished (any outcome) — full-mode rescout window
  lastScoutAt?: number | null;
  now?: number;
  rescoutMs?: number;
}): boolean {
  if (args.analysisAt == null) return false;
  if (args.hasScoutJob) return false;
  if (args.mode === 'research') return !args.reportScanAts.includes(args.analysisAt);
  if (args.hasPendingCandidates) return false;
  // fresh analysis never analysed → always scout
  if (!args.reportScanAts.includes(args.analysisAt)) return true;
  // covered already → only re-scout after the window
  const last = args.lastScoutAt ?? 0;
  return (args.now ?? Date.now()) - last >= (args.rescoutMs ?? 6 * 3_600_000);
}

/// Turn a research-mode trend report's opportunities into pending candidates
/// for the overlord. Pure — the caller assigns the id counter + timestamps.
export function opportunitiesToCandidates(
  opps: Opportunity[],
  opts: { startCounter: number; reportN: number; now: number },
): Candidate[] {
  return opps.map((o, i) => ({
    id: `c${opts.startCounter + i + 1}`,
    title: o.title,
    tags: o.tags,
    size: o.size >= 32 ? 32 : 16,
    frames: Math.min(8, Math.max(1, o.frames | 0)),
    why: o.why,
    demand: Math.min(10, Math.max(1, o.demand | 0)),
    variantOf: o.variantOf,
    reportN: opts.reportN,
    status: 'pending' as const,
    createdAt: opts.now,
  }));
}

// ---- token usage meter ---------------------------------------------------------

export interface TokenCounts {
  input: number;
  cachedRead: number;
  cachedWrite: number;
  output: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/// Pull per-request token counts out of a usage_update payload. Prefers the
/// cognition.ai `_meta` keys; when absent, `used` (= input+output of that
/// request) lands in `input` so the total still counts. APPROXIMATE — the
/// raw event is logged to usage.jsonl so the assumption can be validated.
export function usageFromUpdate(update: Json): TokenCounts {
  const m = update?._meta ?? {};
  const c: TokenCounts = {
    input: num(m['cognition.ai/inputTokens']),
    cachedRead: num(m['cognition.ai/cachedReadTokens']),
    cachedWrite: num(m['cognition.ai/cachedWriteTokens']),
    output: num(m['cognition.ai/outputTokens']),
  };
  if (!c.input && !c.output && !c.cachedRead && !c.cachedWrite) c.input = num(update?.used);
  return c;
}

export const localDayKey = (now: number): string => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const localHourKey = (now: number): string =>
  `${localDayKey(now)} ${String(new Date(now).getHours()).padStart(2, '0')}`;

const zeroCounts = (): UsageCounts => ({ input: 0, cachedRead: 0, cachedWrite: 0, output: 0, requests: 0 });

export function emptyUsageTotals(now: number): UsageTotals {
  return {
    day: { ...zeroCounts(), date: localDayKey(now) },
    hour: { ...zeroCounts(), hour: localHourKey(now) },
    total: zeroCounts(),
  };
}

/// Add one request's counts into a UsageTotals — day/hour buckets roll over
/// when their key differs from `now`.
export function addUsageTo(t: UsageTotals, c: TokenCounts, now: number): void {
  const dk = localDayKey(now);
  if (t.day.date !== dk) t.day = { ...zeroCounts(), date: dk };
  const hk = localHourKey(now);
  if (t.hour.hour !== hk) t.hour = { ...zeroCounts(), hour: hk };
  for (const b of [t.day, t.hour, t.total]) {
    b.input += c.input;
    b.cachedRead += c.cachedRead;
    b.cachedWrite += c.cachedWrite;
    b.output += c.output;
    b.requests += 1;
  }
}

export const emptyUsageState = (): UsageState => ({ byRole: {}, byModel: {} });

/// Record a usage_update under both the agent's role and its model id.
export function recordUsage(state: UsageState, role: AgentKind, model: string, update: Json, now: number): void {
  const c = usageFromUpdate(update);
  const rt = (state.byRole[role] ??= emptyUsageTotals(now));
  addUsageTo(rt, c, now);
  const mt = (state.byModel[model] ??= emptyUsageTotals(now));
  addUsageTo(mt, c, now);
}

export const totalTokens = (c: UsageCounts): number => c.input + c.cachedRead + c.cachedWrite + c.output;

/// Sum of today's tokens for every non-overlord role.
export function workersDayTokens(state: UsageState): number {
  let n = 0;
  for (const [role, t] of Object.entries(state.byRole)) {
    if (role !== 'overlord') n += totalTokens(t.day);
  }
  return n;
}

/// True when a configured daily cap is exceeded (total tokens incl. cached).
export function capExceeded(state: UsageState, caps: DailyTokenCaps | null | undefined): boolean {
  if (!caps) return false;
  if (typeof caps.overlord === 'number' && totalTokens(state.byRole.overlord?.day ?? zeroCounts()) > caps.overlord) {
    return true;
  }
  if (typeof caps.workers === 'number' && workersDayTokens(state) > caps.workers) return true;
  return false;
}

/// USD cost of a token bucket at the model's prices — null when unpriced.
/// Approx: cached tokens priced at their own rates, everything else in/out.
export function usageCostUsd(c: UsageCounts, prices: ModelPrices | undefined): number | null {
  if (!prices) return null;
  return (
    (c.input * prices.inPerM + c.cachedRead * prices.cachedReadPerM +
     c.cachedWrite * prices.cachedWritePerM + c.output * prices.outPerM) / 1e6
  );
}
