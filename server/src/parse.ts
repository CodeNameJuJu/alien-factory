// Pure parsing / decision helpers for the factory pipeline — kept free of IO
// so parse.test.ts can drive them directly.
import { resolve, sep } from 'node:path';
import type { AssetInspection, OrderSpec } from '../../shared/protocol.js';

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
