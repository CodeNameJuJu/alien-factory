// FactoryManager — the alien crew, the job pipeline and the overlord's
// decision loop, all driven by Devin ACP sessions sandboxed to FACTORY_DIR.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpClient, configOption, configValues, DEVIN_DISABLED, RpcError } from './acp.js';
import { FACTORY_DIR, STATE_PATH, DATA_DIR, LOG_DIR, saveConfig } from './config.js';
import { Market, TICK_MS } from './market.js';
import {
  applyApprovalCap,
  capExceeded,
  checkMeta,
  clampPackItems,
  decidePermission,
  extractReport,
  inspectingRecoverySkus,
  JOB_AGENT_KIND,
  localDayKey,
  parseDecisions,
  parseDemand,
  parseInspection,
  pickSmith,
  opportunitiesToCandidates,
  recordUsage,
  resolveModel,
  shouldQueueScout,
  urlsAllowed,
} from './parse.js';
import { forgePrompt, inspectPrompt, overlordPrompt, packPrompt, scoutPrompt, scoutPromptItch } from './prompts.js';
import { applyGumroadProduct, attachGumroadImages as gumroadAttach, fetchGumroadStore, loadMeta as loadShipMeta, publishGumroad as gumroadPublish, shipGumroad as gumroadShip } from './channels/gumroad.js';
import { canClearGumroad, shipEligibility, unshippableReasons } from '../../shared/shop.js';
import {
  analyseSnapshot,
  getBackoffUntil,
  latestSnapshot,
  scanAllowed,
  scanFeeds,
  setLastScanAt,
  validateFeeds,
  writeItchReport,
} from './itch.js';
import type {
  Agent,
  AgentKind,
  Asset,
  Candidate,
  ClientMessage,
  Decision,
  FactoryConfig,
  FactoryEvent,
  GumroadStats,
  ItchAnalysis,
  ItchState,
  Job,
  JobKind,
  Opportunity,
  OrderSpec,
  ShiftState,
  TranscriptEntry,
  TrendReport,
  UsageState,
} from '../../shared/protocol.js';

const TRANSCRIPT_CAP = 300;
const ENTRY_CAP = 4000;
const EVENTS_CAP = 100;
const SAVE_DEBOUNCE_MS = 400;
const DISPATCH_MS = 2_000;
const HOUR_MS = 3_600_000;
/// live Gumroad store stats — polled once at boot, then every 15 min
const GUMROAD_REFRESH_MS = 15 * 60_000;
/// Re-scout when the last trend report is older than this many market ticks.
const SCOUT_STALE_TICKS = 10;

type Json = any;

/// Thrown when a turn's job was requeued/stopped while the prompt was in
/// flight — the pipeline must not continue on its result.
class CancelledError extends Error {}

/// Move assets/<sku> aside to archive/<sku> (suffixing the target if it
/// exists) and write archived.json inside it. Returns the archive dir, or
/// null when the source dir wasn't there — state cleanup is the caller's.
export function moveToArchive(factoryDir: string, sku: string, record: Record<string, unknown>): string | null {
  const src = join(factoryDir, 'assets', sku);
  if (!existsSync(src)) return null;
  const arch = join(factoryDir, 'archive');
  mkdirSync(arch, { recursive: true });
  let dst = join(arch, sku);
  if (existsSync(dst)) dst = join(arch, `${sku}-${Date.now()}`);
  renameSync(src, dst);
  writeFileSync(join(dst, 'archived.json'), JSON.stringify(record, null, 2));
  return dst;
}

/// Assets mid-pipeline whose driving job vanished (the old no-verdict /
/// invalid-listing holes) — returns the job kind each status implies.
/// Pure (testable); queued/active jobs count as live, done/failed don't.
export function findOrphans(
  assets: { sku: string; status: Asset['status'] }[],
  jobs: Pick<Job, 'sku' | 'status'>[],
): { sku: string; kind: 'forge' | 'inspect' | 'pack' }[] {
  const implies: Record<string, 'forge' | 'inspect' | 'pack'> = {
    forging: 'forge',
    inspecting: 'inspect',
    packing: 'pack',
    on_conveyor: 'pack',
  };
  const live = new Set(
    jobs.filter((j) => j.status === 'queued' || j.status === 'active').map((j) => j.sku),
  );
  const out: { sku: string; kind: 'forge' | 'inspect' | 'pack' }[] = [];
  for (const a of assets) {
    const kind = implies[a.status];
    if (kind && !live.has(a.sku)) out.push({ sku: a.sku, kind });
  }
  return out;
}

const ALIEN_SYL_A = ['Zor', 'Bli', 'Kre', 'Vex', 'Nur', 'Oo', 'Spl', 'Woz', 'Gli', 'Tha', 'Mur', 'Plo'];
const ALIEN_SYL_B = ['p', 'x', 'll', 'gg', 'ma', 'na', 'qi', 'zz', 'rk', 'b', 'sh', 't'];
const ALIEN_SYL_C = ['', '', '', 'a', 'ex', 'or', 'ix', 'un', 'el', 'ok'];

function alienName(seed: string): string {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const pick = (arr: string[]) => arr[(h = Math.imul(h ^ (h >>> 13), 0x5bd1e995), (h >>> 0) % arr.length)];
  return pick(ALIEN_SYL_A) + pick(ALIEN_SYL_B) + pick(ALIEN_SYL_C);
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'asset'
  );
}

const STATE_VERSION = 3;

interface PersistedState {
  stateVersion?: number;
  agents?: Agent[];
  candidates?: Candidate[];
  candidateCounter?: number;
  assets?: Asset[];
  jobs?: Job[];
  decisions?: Decision[];
  events?: FactoryEvent[];
  shift?: ShiftState;
  overlordTurnTimes?: number[];
  turnCount?: number;
  latestTrendReport?: string | null;
  lastScoutTick?: number;
  market?: Record<string, Json>;
  trendReports?: TrendReport[];
  itch?: { lastScanAt?: number | null; analysis?: ItchState['analysis'] };
  usage?: UsageState;
  lastScoutAt?: number;
  gumroadStats?: GumroadStats | null;
}

export class FactoryManager extends EventEmitter {
  agents: Agent[] = [];
  candidates: Candidate[] = [];
  candidateCounter = 0;
  assets: Asset[] = [];
  jobs: Job[] = [];
  decisions: Decision[] = [];
  events: FactoryEvent[] = [];
  shift: ShiftState = 'stopped';
  overlordTurnTimes: number[] = [];
  pendingDirectives: string[] = [];
  latestTrendReport: string | null = null;
  turnCount = 0;
  lastScoutTick = -999;
  trendReports: TrendReport[] = [];
  itch: ItchState = { lastScanAt: null, scanning: false, error: null, backoffUntil: null, analysis: null };
  usage: UsageState = { byRole: {}, byModel: {} };
  /// when the last scout job finished (full-mode rescout window)
  lastScoutAt = 0;
  /// shift auto-paused by a daily token cap
  tokenCapHit = false;
  /// live Gumroad store totals from the last refresh (null until one lands)
  gumroadStats: GumroadStats | null = null;

  /// Set by main.ts when a relay link is configured — true while the worker
  /// is linked (or was within the last 2h). A linked worker never scans
  /// itch.io itself; it uses relay-pushed analysis.
  relayAvailable: () => boolean = () => false;
  market = new Market();
  acp: AcpClient;

  private config: FactoryConfig;
  private saveTimer: NodeJS.Timeout | null = null;
  private dispatchTimer: NodeJS.Timeout | null = null;
  private marketTimer: NodeJS.Timeout | null = null;
  private gumroadTimer: NodeJS.Timeout | null = null;
  private gumroadRefreshing = false;
  private overlordBusy = false;
  private overlordNudged = false;

  constructor(config: FactoryConfig) {
    super();
    this.config = config;
    this.acp = new AcpClient();
    this.acp.on('update', (sid: string, u: Json) => this.onUpdate(sid, u));
    this.acp.on('permission', (sid: string, id: Json, p: Json) => this.onPermission(sid, id, p));
    this.acp.on('dead', () => {
      for (const a of this.agents) {
        if (a.state === 'working') {
          a.state = 'error';
          a.statusLine = 'Devin process stopped';
          a.sessionId = null;
        }
      }
      for (const j of this.jobs) {
        if (j.status === 'active') {
          j.status = 'queued';
          j.assignee = undefined;
        }
      }
      this.event('Devin process stopped — active jobs requeued');
      this.changed();
    });
    this.market.init();
    this.loadState();
    this.ensureRoster();
    this.dispatchTimer = setInterval(() => this.dispatch(), DISPATCH_MS);
    this.marketTimer = setInterval(() => this.marketTick(), TICK_MS);
    if (process.env.GUMROAD_ACCESS_TOKEN) {
      setTimeout(() => void this.refreshGumroad({ silent: true }), 5_000);
      this.gumroadTimer = setInterval(() => void this.refreshGumroad({ silent: true }), GUMROAD_REFRESH_MS);
    }
  }

  // ---- infra ---------------------------------------------------------------

  changed(): void {
    this.emit('change');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), SAVE_DEBOUNCE_MS);
  }

  private persist(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_PATH + '.tmp';
      const state: PersistedState = {
        stateVersion: STATE_VERSION,
        agents: this.agents,
        candidates: this.candidates,
        candidateCounter: this.candidateCounter,
        assets: this.assets,
        jobs: this.jobs,
        decisions: this.decisions,
        events: this.events,
        shift: this.shift,
        overlordTurnTimes: this.overlordTurnTimes,
        turnCount: this.turnCount,
        latestTrendReport: this.latestTrendReport,
        lastScoutTick: this.lastScoutTick,
        trendReports: this.trendReports,
        itch: { lastScanAt: this.itch.lastScanAt, analysis: this.itch.analysis },
        usage: this.usage,
        lastScoutAt: this.lastScoutAt,
        gumroadStats: this.gumroadStats,
        market: this.market.serialize(),
      };
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, STATE_PATH);
    } catch {
      /* best effort */
    }
  }

  private loadState(): void {
    let raw: PersistedState = {};
    try {
      raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    } catch {
      return;
    }
    if (raw.stateVersion !== STATE_VERSION) {
      // old pipeline design — keep only agent names, drop mock pipeline data
      for (const a of raw.agents ?? []) {
        a.sessionId = null;
        a.jobsInSession = 0;
        a.state = 'offline';
        a.currentJobId = null;
        this.agents.push(a);
      }
      return;
    }
    this.candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
    this.candidateCounter = raw.candidateCounter ?? this.candidates.length;
    this.assets = Array.isArray(raw.assets) ? raw.assets : [];
    this.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    this.decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
    this.events = Array.isArray(raw.events) ? raw.events : [];
    this.overlordTurnTimes = Array.isArray(raw.overlordTurnTimes) ? raw.overlordTurnTimes : [];
    this.turnCount = raw.turnCount ?? 0;
    this.latestTrendReport = raw.latestTrendReport ?? null;
    this.lastScoutTick = raw.lastScoutTick ?? -999;
    this.trendReports = Array.isArray(raw.trendReports) ? raw.trendReports.slice(0, 20) : [];
    this.itch.lastScanAt = raw.itch?.lastScanAt ?? null;
    this.itch.analysis = raw.itch?.analysis ?? null;
    if (this.itch.lastScanAt) setLastScanAt(this.itch.lastScanAt);
    if (raw.usage?.byRole && raw.usage?.byModel) this.usage = raw.usage;
    this.lastScoutAt = raw.lastScoutAt ?? 0;
    this.gumroadStats = raw.gumroadStats ?? null;
    this.market.restore(raw.market);
    // no session/load on restart — drop sessions, requeue active jobs
    this.shift = 'stopped';
    for (const a of raw.agents ?? []) {
      a.sessionId = null;
      a.jobsInSession = 0;
      if (a.state === 'working') a.state = 'idle';
      a.currentJobId = null;
      this.agents.push(a);
    }
    for (const j of this.jobs) {
      if (j.status === 'active') {
        j.status = 'queued';
        j.assignee = undefined;
      }
    }
    // recovery for the assignable() fix: assets whose forge finished and
    // whose inspect job is queued were stuck on 'forging' — they're
    // actually waiting at the inspector's desk
    for (const sku of inspectingRecoverySkus(this.assets, this.jobs)) {
      const a = this.asset(sku);
      if (a) a.status = 'inspecting';
    }
    this.healOrphans();
  }

  private ensureRoster(): void {
    const mk = (id: string, kind: AgentKind, model: string): Agent => ({
      id,
      kind,
      name: alienName(id),
      model,
      modelName: model,
      sessionId: null,
      jobsInSession: 0,
      state: 'offline',
      statusLine: 'waiting for shift',
      currentJobId: null,
      transcript: [],
    });
    const want: [string, AgentKind, string][] = [
      ['overlord', 'overlord', this.config.models.overlord],
      ['scout', 'scout', this.config.models.scout],
      ['inspector', 'inspector', this.config.models.inspector],
      ['packer', 'packer', this.config.models.packer],
    ];
    for (let i = 1; i <= this.config.smiths; i++) {
      want.push([`smith-${i}`, 'smith', this.config.models.smith]);
    }
    for (const [id, kind, model] of want) {
      if (!this.agents.some((a) => a.id === id)) this.agents.push(mk(id, kind, model));
    }
  }

  private agent(id: string): Agent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  private asset(sku: string): Asset | undefined {
    return this.assets.find((a) => a.sku === sku);
  }

  private push(a: Agent, role: TranscriptEntry['role'], text: string): void {
    a.transcript.push({ role, text: text.slice(0, ENTRY_CAP), at: Date.now() });
    if (a.transcript.length > TRANSCRIPT_CAP) a.transcript.splice(0, a.transcript.length - TRANSCRIPT_CAP);
  }

  event(text: string, agentId?: string, sku?: string): void {
    this.events.push({ at: Date.now(), text, agentId, sku });
    if (this.events.length > EVENTS_CAP) this.events.splice(0, this.events.length - EVENTS_CAP);
  }

  private setAssetStatus(sku: string, status: Asset['status'], note?: string): void {
    const a = this.asset(sku);
    if (!a || a.status === status) return;
    a.status = status;
    a.updatedAt = Date.now();
    this.event(`${sku}: ${status}${note ? ` — ${note}` : ''}`, undefined, sku);
  }

  // ---- jobs ----------------------------------------------------------------

  private queueJob(kind: JobKind, sku?: string, note?: string, pinnedTo?: string): Job {
    const j: Job = { id: randomUUID().slice(0, 8), kind, sku, status: 'queued', note, pinnedTo, createdAt: Date.now() };
    this.jobs.push(j);
    return j;
  }

  /// Re-enqueue mid-pipeline assets whose job vanished. Runs on load and
  /// shift start — statuses match the normal flow (a queued forge waits
  /// at 'queued'; queued inspect/pack keep 'inspecting'/'on_conveyor'
  /// until dispatch marks them working).
  private healOrphans(): void {
    const orphans = findOrphans(this.assets, this.jobs);
    for (const { sku, kind } of orphans) {
      const a = this.asset(sku);
      if (kind === 'forge') {
        this.setAssetStatus(sku, 'queued', 'healed orphan');
        this.queueJob('forge', sku, 'healed orphan', a?.smith);
      } else {
        this.queueJob(kind, sku, 'healed orphan');
      }
    }
    if (orphans.length) {
      this.event(`requeued ${orphans.length} orphaned asset(s)`);
      this.changed();
    }
  }

  private assignable(agent: Agent, job: Job): boolean {
    if (agent.state === 'error' || agent.state === 'working') return false;
    if (agent.currentJobId) return false;
    if (job.pinnedTo) return agent.id === job.pinnedTo;
    return agent.kind === JOB_AGENT_KIND[job.kind];
  }

  /// A scout is wanted only when there are no pending proposals and the last
  /// report is stale — keeps new candidates flowing into overlord turns.
  /// (Full mode only; research mode scouts after each itch scan instead.)
  private maybeScout(): void {
    if (this.config.mode === 'research') return;
    const hasPending = this.candidates.some((c) => c.status === 'pending');
    const hasScoutJob = this.jobs.some((j) => j.kind === 'scout' && j.status !== 'done' && j.status !== 'failed');
    if (!hasPending && !hasScoutJob && this.market.tick - this.lastScoutTick >= SCOUT_STALE_TICKS) {
      this.queueJob('scout');
      this.event('scout dispatched to read the market');
    }
  }

  private dispatch(): void {
    if (this.shift !== 'running') return;
    // research mode: rescan + rescout on the itchScanMinutes cadence
    if (
      this.config.mode === 'research' &&
      !this.relayAvailable() && // linked worker: the relay scans, not us
      !this.itch.scanning &&
      Date.now() - (this.itch.lastScanAt ?? 0) >= this.config.itchScanMinutes * 60_000
    ) {
      void this.scanThenScout(false);
    }
    this.maybeScout();
    for (const j of this.jobs) {
      if (j.status !== 'queued') continue;
      if (DEVIN_DISABLED) break; // no agent can ever run — jobs just pile up
      const agent = this.agents.find((a) => this.assignable(a, j));
      if (!agent) continue;
      j.status = 'active';
      j.assignee = agent.id;
      agent.currentJobId = j.id;
      agent.state = 'working';
      agent.statusLine = `${j.kind} ${j.sku ?? ''}`.trim();
      const asset = j.sku ? this.asset(j.sku) : undefined;
      if (asset) asset.assignedTo = agent.id;
      if (j.kind === 'forge' && asset) this.setAssetStatus(asset.sku, 'forging', agent.name);
      if (j.kind === 'inspect' && asset) this.setAssetStatus(asset.sku, 'inspecting', agent.name);
      if (j.kind === 'pack' && asset) this.setAssetStatus(asset.sku, 'packing', agent.name);
      void this.runJob(agent, j);
    }
    if (this.config.mode === 'full') this.maybeOverlordTurn();
    this.changed();
  }

  private finishJob(job: Job, ok: boolean): void {
    job.status = ok ? 'done' : 'failed';
    job.finishedAt = Date.now();
    const agent = job.assignee ? this.agent(job.assignee) : undefined;
    if (agent) {
      agent.currentJobId = null;
      if (agent.state !== 'error') agent.state = 'idle';
      agent.jobsInSession++;
      // cheap models get small contexts — recycle the session regularly
      if (agent.kind !== 'overlord' && agent.jobsInSession >= this.config.sessionJobLimit[agent.kind]) {
        agent.sessionId = null;
        agent.jobsInSession = 0;
      }
    }
    if (job.kind === 'scout') this.lastScoutAt = job.finishedAt;
    this.changed();
  }

  private async runJob(agent: Agent, job: Job): Promise<void> {
    try {
      switch (job.kind) {
        case 'scout':
          await this.jobScout(agent, job);
          break;
        case 'forge':
          await this.jobForge(agent, job);
          break;
        case 'inspect':
          await this.jobInspect(agent, job);
          break;
        case 'pack':
          await this.jobPack(agent, job);
          break;
      }
    } catch (err) {
      if (err instanceof CancelledError) return; // job was requeued/stopped mid-turn
      this.onTurnError(agent, job, err);
      return;
    }
  }

  /// True while this job still belongs to this agent's in-flight run.
  private jobIsActive(job: Job, agent: Agent): boolean {
    return job.status === 'active' && job.assignee === agent.id;
  }

  private onTurnError(agent: Agent, job: Job | null, err: unknown): void {
    const e = err as RpcError;
    const msg = e.kind === 'resource_exhausted' ? 'quota exhausted' : e.message;
    agent.state = 'error';
    agent.statusLine = msg;
    this.push(agent, 'system', `error: ${msg}`);
    if (e.kind === 'resource_exhausted') {
      this.event(`${agent.name}: quota exhausted — shift paused`, agent.id, job?.sku);
      this.shift = 'paused';
      if (job) {
        job.status = 'queued';
        job.assignee = undefined;
        agent.currentJobId = null;
      }
    } else {
      // non-quota error: drop the session and recover to idle — the
      // one-retry-then-failed job logic bounds the loop
      agent.sessionId = null;
      agent.state = 'idle';
      agent.statusLine = `recovered after error: ${msg}`;
      if (job) {
        if (!job.note?.startsWith('retried')) {
          this.requeueJob(job, agent, `retried after: ${msg}`);
        } else {
          this.finishJob(job, false);
          if (job.sku) {
            this.setAssetStatus(job.sku, 'failed', msg);
            this.maybeArchiveFailed(job.sku, 'failed');
          }
        }
      }
      this.event(`${agent.name} errored: ${msg}`, agent.id, job?.sku);
    }
    this.changed();
  }

  /// Put a job back on the queue with a fresh agent context — same
  /// shape as the onTurnError retry (queued, unassigned, 'retried' note,
  /// agent idle with a dropped session). Callers check the 'retried'
  /// note first so the loop stays one retry deep.
  private requeueJob(job: Job, agent: Agent, note: string): void {
    job.status = 'queued';
    job.assignee = undefined;
    job.note = note.slice(0, 200);
    agent.currentJobId = null;
    agent.sessionId = null;
    if (agent.state !== 'error') agent.state = 'idle';
    this.changed();
  }

  // ---- agent session plumbing ------------------------------------------------

  private async ensureSession(agent: Agent): Promise<void> {
    if (agent.sessionId) return;
    agent.statusLine = 'starting session';
    this.changed();
    const { sessionId, configOptions } = await this.acp.newSession(FACTORY_DIR);
    agent.sessionId = sessionId;
    agent.jobsInSession = 0;
    await this.configureSession(agent, configOptions);
  }

  /// Sets the agent's model if offered, and never leaves the mode on `ask`.
  private async configureSession(agent: Agent, configOptions: Json): Promise<void> {
    const sessionId = agent.sessionId!;
    const wantModel = this.config.models[agent.kind];
    const modelOpt = configOption(configOptions, 'model');
    if (modelOpt) {
      const offered = configValues(modelOpt);
      const want = offered.find((v) => v.id === wantModel);
      if (want) {
        const r = await this.acp.setConfig(sessionId, modelOpt.id ?? 'model', want.id);
        agent.modelName = want.name;
        agent.modelMismatch = undefined;
        const cur = configOption(r?.configOptions, 'model');
        const found = offered.find((v) => v.id === cur?.currentValue);
        if (found) agent.modelName = found.name;
      } else {
        // configured model isn't offered by this Devin build — flag it
        const fb = resolveModel(wantModel, offered, modelOpt.currentValue ?? wantModel);
        agent.modelName = fb.name;
        agent.modelMismatch = { want: wantModel, using: fb.name };
        this.push(agent, 'system', `model ${wantModel} not offered — using ${fb.name}`);
        this.event(`model ${wantModel} not offered by Devin — ${agent.name} is using ${fb.name}`, agent.id);
      }
      agent.model = want?.id ?? modelOpt.currentValue ?? wantModel;
    }
    const modeOpt = configOption(configOptions, 'mode');
    if (modeOpt?.id && modeOpt.currentValue === 'ask') {
      const nonAsk = configValues(modeOpt).filter((v) => v.id !== 'ask');
      const prefer = nonAsk.find((v) => v.id === 'accept-edits') ?? nonAsk[0];
      if (prefer) await this.acp.setConfig(sessionId, modeOpt.id, prefer.id);
    }
  }

  /// One prompt turn. Returns the last agent message text FROM THIS TURN
  /// (the pushed user entry guarantees a fresh agent entry in onUpdate).
  /// If `job` is given and was requeued/stopped mid-turn, throws
  /// CancelledError so callers abandon the result.
  private async turn(agent: Agent, text: string, job?: Job): Promise<string> {
    await this.ensureSession(agent);
    this.push(agent, 'user', text);
    agent.state = 'working';
    this.changed();
    const startedAt = Date.now();
    const res = await this.acp.prompt(agent.sessionId!, text);
    if (job && !this.jobIsActive(job, agent)) throw new CancelledError('job requeued mid-turn');
    const last = [...agent.transcript].reverse().find((t) => t.role === 'agent' && t.at >= startedAt);
    this.push(agent, 'system', `turn finished: ${res?.stopReason ?? 'unknown'}`);
    return last?.text ?? '';
  }

  // ---- job implementations ---------------------------------------------------

  private catalogSummary(): string {
    return this.assets
      .map(
        (a) =>
          `${a.sku} | ${a.tags.join(',')} | ${a.status} | ${a.sales.units} | $${a.sales.revenueUsd.toFixed(2)}`,
      )
      .join('\n');
  }

  private async jobScout(agent: Agent, job: Job): Promise<void> {
    agent.statusLine = 'reading the market report';
    const useItch = this.config.mode === 'research' || this.config.marketSource === 'itch';
    let text = await this.turn(agent, useItch ? scoutPromptItch(this.catalogSummary()) : scoutPrompt(this.catalogSummary()), job);
    let proposals = parseDemand(text);
    if (!proposals.length) {
      this.push(agent, 'system', 'no "## Demand" block — nudging');
      text = await this.turn(
        agent,
        'End your reply with `## Demand` followed by a ```json fenced array of 3-6 proposals: {"title","tags","size","frames","why","demand","variantOf?"}.',
        job,
      );
      proposals = parseDemand(text);
    }
    if (!proposals.length) {
      this.event(`${agent.name}'s report had no demand block`, agent.id);
      this.finishJob(job, false);
      return;
    }
    this.latestTrendReport = extractReport(text);
    this.lastScoutTick = this.market.tick;
    // report history (research mode keeps opportunities here instead of
    // candidates — nothing is produced without a mode switch)
    const opportunities: Opportunity[] = proposals.map((p) => ({
      title: p.title,
      tags: p.tags,
      size: p.size,
      frames: p.frames,
      why: p.why,
      demand: p.demand,
      variantOf: p.variantOf,
      kind: p.kind,
      items: p.items,
      itemNames: p.itemNames,
      evidence: p.evidence,
      priceBand: p.priceBand,
    }));
    const n = (this.trendReports[0]?.n ?? 0) + 1;
    this.trendReports.unshift({
      n,
      at: Date.now(),
      markdown: this.latestTrendReport,
      opportunities,
      scanAt: this.itch.lastScanAt ?? undefined,
    });
    if (this.trendReports.length > 20) this.trendReports.length = 20;
    if (this.config.mode !== 'research') {
      for (const p of proposals) {
        const c: Candidate = {
          id: `c${++this.candidateCounter}`,
          title: p.title,
          tags: p.tags,
          size: p.size === 32 ? 32 : 16,
          frames: p.frames,
          why: p.why,
          demand: p.demand,
          variantOf: p.variantOf,
          kind: p.kind ?? 'sprite',
          items: p.kind === 'pack' ? clampPackItems(p.items) : undefined,
          itemNames: p.itemNames,
          reportN: this.market.tick,
          status: 'pending',
          createdAt: Date.now(),
        };
        this.candidates.push(c);
        this.event(`Scout proposes: ${c.title} (demand ${c.demand})`, agent.id);
      }
    } else {
      this.event(`${agent.name} filed trend report #${n} (${proposals.length} opportunities)`, agent.id);
    }
    this.finishJob(job, true);
  }

  /// Server-side: run the generator and check meta.json against the order.
  private runChecks(sku: string, order: OrderLike): Promise<{ passed: boolean; issues: string[] }> {
    return new Promise((resolveP) => {
      execFile(
        process.execPath,
        [join(FACTORY_DIR, 'assets', sku, 'gen.mjs')],
        { cwd: FACTORY_DIR, timeout: 20_000 },
        (err) => {
          if (err) {
            resolveP({ passed: false, issues: [`gen.mjs failed: ${(err as Error).message.slice(0, 300)}`] });
            return;
          }
          let meta = null;
          try {
            meta = JSON.parse(readFileSync(join(FACTORY_DIR, 'assets', sku, 'meta.json'), 'utf8'));
          } catch {
            /* handled by checkMeta */
          }
          resolveP(checkMeta(meta, order));
        },
      );
    });
  }

  private async jobForge(agent: Agent, job: Job): Promise<void> {
    const asset = job.sku ? this.asset(job.sku) : undefined;
    if (!asset) return this.finishJob(job, false);
    const order: OrderSpec = {
      title: asset.title,
      tags: asset.tags,
      size: asset.size,
      frames: asset.frames,
      kind: asset.kind ?? 'sprite',
      items: asset.items,
      itemNames: asset.itemNames,
      variantOf: asset.variantOf,
      brief: asset.orderBrief,
    };
    const variantPath = asset.variantOf ? `assets/${asset.variantOf}/gen.mjs` : undefined;
    const text = await this.turn(
      agent,
      forgePrompt({
        sku: asset.sku,
        order,
        variantSourcePath: variantPath && existsSync(join(FACTORY_DIR, variantPath)) ? variantPath : undefined,
        issues: job.note?.startsWith('checks:') ? JSON.parse(job.note.slice(7)) : undefined,
        inspectNotes: job.note?.startsWith('inspect:') ? job.note.slice(8) : undefined,
      }),
      job,
    );
    void text;
    agent.statusLine = 'running checks';
    this.changed();
    const checks = await this.runChecks(asset.sku, order);
    if (!this.jobIsActive(job, agent)) throw new CancelledError('job requeued during checks');
    asset.checks = checks;
    if (!checks.passed) {
      asset.attempts++;
      if (asset.attempts < 2) {
        this.event(`${asset.sku}: checks failed — re-forging`, agent.id, asset.sku);
        const retry = await this.turn(
          agent,
          forgePrompt({ sku: asset.sku, order, issues: checks.issues }),
          job,
        );
        void retry;
        const again = await this.runChecks(asset.sku, order);
        if (!this.jobIsActive(job, agent)) throw new CancelledError('job requeued during checks');
        asset.checks = again;
        if (!again.passed) {
          this.setAssetStatus(asset.sku, 'failed', again.issues.join('; '));
          this.finishJob(job, false);
          this.maybeArchiveFailed(asset.sku, 'failed');
          return;
        }
      } else {
        this.setAssetStatus(asset.sku, 'failed', checks.issues.join('; '));
        this.finishJob(job, false);
        this.maybeArchiveFailed(asset.sku, 'failed');
        return;
      }
    }
    // checks passed — the asset is waiting at the inspector's desk NOW,
    // not still "forging" until an inspector picks the job up
    this.setAssetStatus(asset.sku, 'inspecting');
    this.queueJob('inspect', asset.sku);
    this.event(`${agent.name} hands ${asset.sku} to the inspector`, agent.id, asset.sku);
    this.finishJob(job, true);
  }

  private async jobInspect(agent: Agent, job: Job): Promise<void> {
    const asset = job.sku ? this.asset(job.sku) : undefined;
    if (!asset) return this.finishJob(job, false);
    const text = await this.turn(agent, inspectPrompt(asset), job);
    const ins = parseInspection(text);
    if (!ins) {
      this.event(`inspection of ${asset.sku} had no verdict`, agent.id, asset.sku);
      // a missed verdict used to orphan the asset at 'inspecting' forever —
      // retry once with a fresh session, then fail like a real FAIL
      if (!job.note?.startsWith('retried')) {
        this.requeueJob(job, agent, 'retried after: no verdict');
      } else {
        this.finishJob(job, false);
        this.setAssetStatus(asset.sku, 'failed', 'inspection had no verdict twice');
        this.maybeArchiveFailed(asset.sku, 'failed: no inspection verdict');
      }
      return;
    }
    asset.inspection = ins;
    if (ins.verdict === 'PASS') {
      this.setAssetStatus(asset.sku, 'on_conveyor');
      this.queueJob('pack', asset.sku);
      this.event(`Inspector ✓ ${asset.sku} (${ins.score}/10) — onto the conveyor`, agent.id, asset.sku);
    } else if (asset.attempts < 2) {
      asset.attempts++;
      this.setAssetStatus(asset.sku, 'queued', `inspector FAIL (${ins.score}/10)`);
      this.queueJob('forge', asset.sku, `inspect:${ins.notes.slice(0, 300)}`, asset.smith);
      this.event(`Inspector ✗ ${asset.sku} — back to ${asset.smith ?? 'the forge'}`, agent.id, asset.sku);
    } else {
      this.setAssetStatus(asset.sku, 'scrapped', `inspector FAIL (${ins.score}/10)`);
      this.event(`Inspector ✗ ${asset.sku} — scrapped`, agent.id, asset.sku);
    }
    this.finishJob(job, true);
    if (asset.status === 'scrapped') {
      this.maybeArchiveFailed(asset.sku, `scrapped: ${ins.notes.slice(0, 80)}`);
    }
  }

  private async jobPack(agent: Agent, job: Job): Promise<void> {
    const asset = job.sku ? this.asset(job.sku) : undefined;
    if (!asset) return this.finishJob(job, false);
    await this.turn(agent, packPrompt(asset), job);
    let listing: Asset['listing'] | undefined;
    try {
      const raw = JSON.parse(readFileSync(join(FACTORY_DIR, 'assets', asset.sku, 'listing.json'), 'utf8'));
      if (
        typeof raw?.title === 'string' &&
        typeof raw?.description === 'string' &&
        raw.description.length <= 400 &&
        Array.isArray(raw.tags) &&
        typeof raw.priceUsd === 'number'
      ) {
        listing = {
          title: raw.title,
          description: raw.description,
          tags: raw.tags.filter((t: Json) => typeof t === 'string').slice(0, 6),
          priceUsd: Math.min(14.99, Math.max(0.99, raw.priceUsd)),
        };
      }
    } catch {
      /* invalid */
    }
    if (!listing) {
      this.event(`${asset.sku}: listing.json invalid`, agent.id, asset.sku);
      // same orphan hole as a missed inspection verdict — one retry, then fail
      if (!job.note?.startsWith('retried')) {
        this.requeueJob(job, agent, 'retried after: invalid listing.json');
      } else {
        this.finishJob(job, false);
        this.setAssetStatus(asset.sku, 'failed', 'listing.json invalid twice');
        this.maybeArchiveFailed(asset.sku, 'failed: invalid listing.json');
      }
      return;
    }
    asset.listing = listing;
    asset.status = 'listed';
    asset.updatedAt = Date.now();
    this.market.addListing(asset, asset.inspection?.score ?? 5);
    this.event(`${asset.sku} shipped to the mock market — $${listing.priceUsd.toFixed(2)}`, agent.id, asset.sku);
    this.finishJob(job, true);
  }

  // ---- the overlord ----------------------------------------------------------

  private overlordTurnsThisHour(): number {
    const cutoff = Date.now() - HOUR_MS;
    this.overlordTurnTimes = this.overlordTurnTimes.filter((t) => t > cutoff);
    return this.overlordTurnTimes.length;
  }

  private maybeOverlordTurn(): void {
    if (this.overlordBusy) return;
    const overlord = this.agent('overlord');
    if (!overlord || overlord.state === 'working' || overlord.state === 'error') return;
    const want =
      this.candidates.some((c) => c.status === 'pending') || this.pendingDirectives.length > 0;
    if (!want) return;
    if (this.overlordTurnsThisHour() >= this.config.maxOverlordTurnsPerHour) return;
    void this.runOverlordTurn(overlord);
  }

  private async runOverlordTurn(overlord: Agent): Promise<void> {
    this.overlordBusy = true;
    this.overlordTurnTimes.push(Date.now());
    this.turnCount++;
    const turn = this.turnCount;
    overlord.state = 'working';
    overlord.statusLine = 'thinking';
    this.event(`the Overlord ponders (turn ${turn})`, overlord.id);
    this.changed();
    try {
      const directives = this.pendingDirectives.splice(0);
      const smithIds = this.agents.filter((a) => a.kind === 'smith').map((a) => a.id);
      const smithQueues = smithIds.map((id) => ({
        id,
        queue: this.jobs.filter(
          (j) => j.kind === 'forge' && j.pinnedTo === id && j.status !== 'done' && j.status !== 'failed',
        ).length,
      }));
      const promptText = overlordPrompt({
        trendReport: this.latestTrendReport ?? '',
        catalog: this.catalogSummary(),
        candidates: this.candidates.filter((c) => c.status === 'pending'),
        smithQueues,
        pendingDirectives: directives,
        maxApprovals: this.config.maxApprovalsPerTurn,
        // everything already approved/forging/on the line/listed — the
        // overlord must decline duplicates of these
        inProgress: this.assets
          .filter((a) => a.status !== 'failed' && a.status !== 'scrapped')
          .map((a) => a.title),
      });
      let text = await this.turn(overlord, promptText);
      let decisions = parseDecisions(text);
      if (!decisions.length && !this.overlordNudged) {
        this.overlordNudged = true;
        text = await this.turn(
          overlord,
          'Your reply was missing the structured block. End with `## Decisions` containing a ```json fenced array: [{"id","approve","reason","smith","brief"}] — one entry per pending proposal.',
        );
        decisions = parseDecisions(text);
      }
      this.overlordNudged = false;

      decisions = applyApprovalCap(decisions, this.config.maxApprovalsPerTurn);
      for (const d of decisions) {
        const c = this.candidates.find((x) => x.id === d.id);
        if (!c || c.status !== 'pending') continue;
        c.decidedAt = Date.now();
        c.reason = d.reason;
        if (d.approve) {
          const queueLengths = Object.fromEntries(smithQueues.map((s) => [s.id, s.queue]));
          const smithId = pickSmith(d.smith, smithIds, queueLengths);
          const sku = this.uniqueSku(slugify(c.title));
          // the overlord may re-scope kind/items/itemNames on approval
          const kind = d.kind ?? c.kind ?? 'sprite';
          const items = kind === 'pack' ? clampPackItems(d.items ?? c.items) : undefined;
          const itemNames = kind === 'pack' ? d.itemNames ?? c.itemNames : undefined;
          c.kind = kind;
          c.items = items;
          c.itemNames = itemNames;
          const asset: Asset = {
            sku,
            title: c.title,
            tags: c.tags,
            size: c.size,
            frames: c.frames,
            kind,
            items,
            itemNames,
            variantOf: c.variantOf && this.asset(c.variantOf) ? c.variantOf : undefined,
            orderBrief: d.brief || c.why,
            candidateId: c.id,
            smith: smithId,
            status: 'queued',
            attempts: 0,
            sales: { views: 0, units: 0, revenueUsd: 0 },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.assets.push(asset);
          c.status = 'approved';
          c.smith = smithId;
          c.sku = sku;
          this.queueJob('forge', sku, undefined, smithId);
          if (smithId) {
            const sq = smithQueues.find((s) => s.id === smithId);
            if (sq) sq.queue++;
          }
          this.decisions.push({ candidateId: c.id, title: c.title, approved: true, reason: d.reason, smith: smithId, sku, at: Date.now() });
          this.event(`Overlord ✓ ${c.title} → ${smithId ?? 'unassigned'} (${d.reason})`, overlord.id, sku);
        } else {
          c.status = 'declined';
          this.decisions.push({ candidateId: c.id, title: c.title, approved: false, reason: d.reason, at: Date.now() });
          this.event(`Overlord ✗ ${c.title}: ${d.reason}`, overlord.id);
        }
      }
      if (!decisions.length) {
        this.event('Overlord turn produced no decisions — giving up', overlord.id);
      }
      overlord.state = 'idle';
      overlord.statusLine = 'idle';
    } catch (err) {
      this.onTurnError(overlord, null, err);
    } finally {
      this.overlordBusy = false;
      this.changed();
    }
  }

  private uniqueSku(base: string): string {
    let sku = base;
    let n = 2;
    while (this.asset(sku)) sku = `${base}-${n++}`;
    return sku;
  }

  // ---- market + shift ---------------------------------------------------------

  private marketTick(): void {
    if (this.shift !== 'running' || this.config.mode === 'research') return;
    this.market.step(this.assets);
    this.changed();
  }

  // ---- itch.io research --------------------------------------------------------

  /// Rate-limit gate the client shows on [ scan now ].
  scanCooldown(manual: boolean): number {
    return scanAllowed(manual).retryAfterMs;
  }

  /// Autoscan / deployments without Devin: scan + analyse + report only,
  /// never queue a scout job (there's nothing to run it).
  async scanOnly(): Promise<void> {
    return this.scanThenScout(false, true);
  }

  /// Fetch → snapshot → analyse → report → queue a scout job. Manual scans
  /// (the [ scan now ] button) still respect a 5-minute floor.
  async scanThenScout(manual: boolean, scoutless = false): Promise<void> {
    if (this.itch.scanning) return;
    const gate = scanAllowed(manual);
    if (!gate.ok) {
      const d = new Date(Date.now() + gate.retryAfterMs);
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      this.itch.error = gate.reason ?? `next scan allowed at ${hhmm}`;
      this.event(`itch scan refused: ${this.itch.error}`);
      // a refusal doesn't stall the line — use whatever data we already hold
      if (!scoutless) this.maybeQueueScout();
      this.changed();
      return;
    }
    this.itch.scanning = true;
    this.itch.error = null;
    this.event('scanning itch.io game-assets feeds…');
    this.changed();
    try {
      const { snapshot, requests } = await scanFeeds(validateFeeds(this.config.itchFeeds));
      const prev = latestSnapshot(snapshot.at);
      this.itch.analysis = analyseSnapshot(snapshot, prev);
      writeItchReport(this.itch.analysis);
      this.itch.lastScanAt = snapshot.at;
      setLastScanAt(snapshot.at);
      this.event(`itch scan done — ${this.itch.analysis.priceStats.count} items (${requests} requests)`);
    } catch (err) {
      this.itch.error = (err as Error).message;
      this.event(`itch scan failed: ${this.itch.error}`);
    } finally {
      this.itch.scanning = false;
      // success OR refusal — if we hold analysable data the scout should run
      if (!scoutless) this.maybeQueueScout();
      this.changed();
    }
  }

  /// Queue the scout when we hold fresh data it hasn't analysed yet —
  /// independent of whether a scan just ran (linked workers get their data
  /// pushed from the relay, and a refused scan shouldn't stall the line).
  private maybeQueueScout(): void {
    if (DEVIN_DISABLED) return;
    if (
      shouldQueueScout({
        mode: this.config.mode,
        analysisAt: this.itch.lastScanAt,
        hasPendingCandidates: this.candidates.some((c) => c.status === 'pending'),
        hasScoutJob: this.jobs.some((j) => j.kind === 'scout' && j.status !== 'done' && j.status !== 'failed'),
        reportScanAts: this.trendReports.map((t) => t.scanAt),
        lastScoutAt: this.lastScoutAt,
        rescoutMs: this.config.rescoutHours * HOUR_MS,
      })
    ) {
      this.queueJob('scout');
      this.event('scout dispatched to read the itch report');
    }
  }

  /// Research → Full handoff: the newest trend report's opportunities become
  /// pending overlord candidates (once per report).
  private promoteOpportunities(): void {
    if (this.config.mode !== 'full') return;
    const report = this.trendReports.find((t) => !t.promoted && t.opportunities.length > 0);
    if (!report) return;
    report.promoted = true;
    const news = opportunitiesToCandidates(report.opportunities, {
      startCounter: this.candidateCounter,
      reportN: report.n,
      now: Date.now(),
    });
    this.candidateCounter += news.length;
    this.candidates.push(...news);
    for (const c of news) this.event(`research opportunity promoted: ${c.title} (demand ${c.demand})`);
    this.changed();
  }

  /// The full browser-visible payload — shared by local /ws broadcasts and
  /// the worker→relay state stream.
  statePayload() {
    return {
      shift: this.shift,
      agents: this.agents,
      candidates: this.candidates,
      assets: this.assets,
      jobs: this.jobs,
      decisions: this.decisions,
      events: this.events,
      market: this.market.state(this.assets),
      config: this.config,
      acp: {
        authenticated: this.acp.authenticated,
        models: this.acp.models,
        modelGroups: this.acp.modelGroups,
        defaultModel: this.acp.defaultModel,
        modes: this.acp.modes,
        alive: this.acp.alive,
      },
      latestTrendReport: this.latestTrendReport,
      itch: { ...this.itch, backoffUntil: getBackoffUntil() || null },
      trendReports: this.trendReports,
      devinEnabled: !DEVIN_DISABLED,
      usage: this.usage,
      tokenCapHit: this.tokenCapHit,
      // the token never leaves the process — clients only get a boolean
      channels: {
        gumroad: {
          configured: !!process.env.GUMROAD_ACCESS_TOKEN,
          bulkRunning: this.gumroadBulkRunning,
          stats: this.gumroadStats,
        },
      },
    };
  }

  /// Fresh itch research pushed down from the relay — adopt it exactly like
  /// our own scan result (report on disk + state + scout dispatch).
  applyRelayItch(analysis: ItchAnalysis | null, reportMarkdown: string, lastScanAt: number): void {
    try {
      mkdirSync(join(FACTORY_DIR, 'reports'), { recursive: true });
      writeFileSync(join(FACTORY_DIR, 'reports', 'itch-latest.md'), reportMarkdown);
    } catch { /* best effort */ }
    this.itch.analysis = analysis;
    this.itch.lastScanAt = lastScanAt;
    this.itch.error = null;
    this.itch.scanning = false;
    setLastScanAt(lastScanAt);
    this.event(`relay pushed itch research (${analysis?.priceStats.count ?? 0} items)`);
    if (this.config.mode === 'research' && this.shift === 'running') this.maybeQueueScout();
    this.changed();
  }

  async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'startShift':
        return this.startShift();
      case 'pauseShift':
        this.pauseShift();
        return;
      case 'stopShift':
        this.stopShift();
        return;
      case 'setModels':
        this.setModels(msg.role, msg.model);
        return;
      case 'setCaps':
        this.setCaps(msg.caps);
        return;
      case 'directive':
        this.directive(msg.text);
        return;
      case 'cancelAgent':
        this.cancelAgent(msg.agentId);
        return;
      case 'signIn':
        await this.acp.authenticate();
        await this.acp.listModels().catch(() => undefined);
        return;
      case 'setMode':
        this.setMode(msg.mode);
        return;
      case 'setMarketSource':
        this.setMarketSource(msg.source);
        return;
      case 'scanNow':
        await this.scanThenScout(true);
        return;
      case 'shipGumroad':
        await this.shipGumroad(msg.sku, msg.dryRun === true);
        return;
      case 'publishGumroad':
        await this.publishGumroad(msg.sku);
        return;
      case 'attachGumroadImages':
        await this.attachGumroadImages(msg.sku);
        return;
      case 'clearGumroad':
        this.clearGumroad(msg.sku);
        return;
      case 'refreshGumroad':
        await this.refreshGumroad();
        return;
      case 'archiveAsset':
        this.archiveAsset(msg.sku, 'archived by hand');
        return;
      case 'archiveUnshippable':
        this.archiveUnshippable();
        return;
      case 'shipAllGumroad':
        await this.shipAllGumroad(msg.publish === true);
        return;
      case 'publishAllGumroad':
        await this.publishAllGumroad();
        return;
      case 'setGumroadConfig':
        this.setGumroadConfig(msg.config);
        return;
    }
  }

  // ---- gumroad channel --------------------------------------------------------

  /// products drafted/published/uploading today (the daily gate counts them)
  private gumroadShippedToday(): number {
    const today = localDayKey(Date.now());
    return this.assets.filter((a) => {
      const g = a.channels?.gumroad;
      return (
        g?.at &&
        localDayKey(g.at) === today &&
        g.status !== 'error' &&
        g.status !== 'none'
      );
    }).length;
  }

  /// What the asset drawer's SHOP section shows — same gate the ship uses.
  gumroadEligibility(sku: string): { ok: boolean; issues: string[] } {
    const asset = this.asset(sku);
    if (!asset) return { ok: false, issues: ['unknown sku'] };
    return shipEligibility(asset, loadShipMeta(sku), this.config.gumroad, this.gumroadShippedToday());
  }

  private async shipGumroad(sku: string, dryRun: boolean): Promise<void> {
    const asset = this.asset(sku);
    if (!asset) {
      this.event(`gumroad ship: unknown sku ${sku}`);
      return;
    }
    asset.channels = { ...(asset.channels ?? {}) };
    if (!dryRun) {
      asset.channels.gumroad = { ...(asset.channels.gumroad ?? {}), status: 'building' };
      this.changed();
    }
    const meta = loadShipMeta(sku);
    if (!dryRun) {
      asset.channels.gumroad = { ...(asset.channels.gumroad ?? {}), status: 'uploading' };
      this.changed();
    }
    const res = await gumroadShip(
      { asset, meta, cfg: this.config.gumroad, shippedToday: this.gumroadShippedToday(), dir: join(FACTORY_DIR, 'assets', sku) },
      { dryRun, syncHook: this.assetSyncHook ?? undefined },
    );
    asset.channels.gumroad = res.ship;
    if (dryRun) {
      this.event(`gumroad dry-run for ${sku} — request plan stored (nothing sent)`, undefined, sku);
    } else if (res.ship.status === 'draft' || res.ship.status === 'published') {
      this.event(`${sku} shipped to Gumroad — ${res.ship.status} ${res.ship.productId ?? ''}`, undefined, sku);
    } else {
      this.event(`gumroad ship failed for ${sku}: ${res.ship.error ?? 'unknown'}`, undefined, sku);
    }
    this.changed();
  }

  private async publishGumroad(sku: string): Promise<void> {
    const asset = this.asset(sku);
    if (!asset) return;
    const ship = await gumroadPublish(asset);
    asset.channels = { ...(asset.channels ?? {}), gumroad: ship };
    if (ship.status === 'published') this.event(`${sku} published on Gumroad`, undefined, sku);
    else this.event(`gumroad publish failed for ${sku}: ${ship.error ?? 'unknown'}`, undefined, sku);
    this.changed();
  }

  /// set by main.ts to the worker-link's syncAssets — kit files ride the
  /// normal asset push so their signed public URLs go live
  assetSyncHook: (() => void) | null = null;

  private async attachGumroadImages(sku: string): Promise<void> {
    const asset = this.asset(sku);
    if (!asset) return;
    const ship = await gumroadAttach(
      { asset, meta: loadShipMeta(sku), dir: join(FACTORY_DIR, 'assets', sku) },
      { syncHook: this.assetSyncHook ?? undefined },
    );
    asset.channels = { ...(asset.channels ?? {}), gumroad: ship };
    if (ship.imagesError) this.event(`gumroad images failed for ${sku}: ${ship.imagesError}`, undefined, sku);
    else this.event(`gumroad images attached for ${sku} — ${ship.images?.covers ?? 0} covers${ship.images?.thumbnail ? ' + thumbnail' : ''}`, undefined, sku);
    this.changed();
  }

  /// Drop a failed local record — never touches Gumroad itself. Records
  /// with a productId are real products and are refused.
  private clearGumroad(sku: string): void {
    const asset = this.asset(sku);
    if (!asset?.channels?.gumroad) return;
    if (!canClearGumroad(asset)) {
      this.event(`gumroad record for ${sku} is a real product — not cleared`, undefined, sku);
      return;
    }
    delete asset.channels.gumroad;
    if (!Object.keys(asset.channels).length) delete asset.channels;
    this.event(`gumroad record cleared for ${sku}`, undefined, sku);
    this.changed();
  }

  /// One GET /v2/products → refresh store stats + every shipped product's
  /// live status/price/sales in a single call. `silent` (the periodic run)
  /// skips the summary event unless something failed or the sales moved.
  private async refreshGumroad(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.gumroadRefreshing) return;
    this.gumroadRefreshing = true;
    try {
      const { stats, products } = await fetchGumroadStore();
      const prev = this.gumroadStats;
      this.gumroadStats = stats;
      const byId = new Map<string, Record<string, unknown>>();
      for (const p of products) {
        const id = p.id == null ? '' : String(p.id);
        if (id) byId.set(id, p);
      }
      let published = 0;
      let draft = 0;
      let shipped = 0;
      for (const a of this.assets) {
        const ship = a.channels?.gumroad;
        if (!ship?.productId) continue;
        shipped++;
        const p = byId.get(ship.productId);
        if (!p || p.deleted === true) {
          a.channels!.gumroad = { ...ship, error: 'product not found on gumroad — deleted there?' };
          continue;
        }
        const next = applyGumroadProduct(ship, p);
        a.channels!.gumroad = next;
        if (next.status === 'published') published++;
        else if (next.status === 'draft') draft++;
      }
      const salesChanged =
        stats.salesCount !== (prev?.salesCount ?? null) ||
        stats.revenueUsdCents !== (prev?.revenueUsdCents ?? null);
      if (!opts.silent || salesChanged) {
        const rev = stats.revenueUsdCents;
        this.event(
          `gumroad refreshed: ${shipped} product(s) — ${published} published, ${draft} draft` +
            (rev != null ? ` · $${(rev / 100).toFixed(2)} total` : ''),
        );
      }
      this.changed();
    } catch (err) {
      const msg = (err as Error).message.slice(0, 200);
      // keep the last good numbers, flag the refresh problem on them
      this.gumroadStats = this.gumroadStats
        ? { ...this.gumroadStats, error: msg }
        : { at: Date.now(), products: 0, published: 0, salesCount: null, revenueUsdCents: null, error: msg };
      this.event(`gumroad refresh failed: ${msg}`);
      this.changed();
    } finally {
      this.gumroadRefreshing = false;
    }
  }

  /// One bulk ship/publish at a time — exposed to the client as
  /// channels.gumroad.bulkRunning so the buttons disable themselves.
  private gumroadBulkRunning = false;

  /// Ship every asset that passes the full per-asset gate, sequentially.
  /// Eligibility is re-evaluated before EACH ship because gumroadShippedToday
  /// moves as drafts are created — the run stops at the daily cap.
  /// publish=true immediately /enables drafts — but a ship that ended with
  /// an error (e.g. content page failed) stays a draft.
  private async shipAllGumroad(publish: boolean): Promise<void> {
    if (this.gumroadBulkRunning) {
      this.event('gumroad bulk already running');
      return;
    }
    this.gumroadBulkRunning = true;
    this.changed();
    try {
      let shipped = 0;
      let published = 0;
      let failed = 0;
      let stoppedAtCap = false;
      for (const sku of this.assets.map((a) => a.sku)) {
        const elig = this.gumroadEligibility(sku);
        if (!elig.ok) {
          if (elig.issues.some((i) => i.startsWith('daily draft limit'))) {
            stoppedAtCap = true;
            break;
          }
          continue;
        }
        await this.shipGumroad(sku, false);
        const ship = this.asset(sku)?.channels?.gumroad;
        if (ship?.status === 'draft' || ship?.status === 'published') {
          shipped++;
          if (publish && ship.status === 'draft' && ship.productId && !ship.error) {
            await this.publishGumroad(sku);
            if (this.asset(sku)?.channels?.gumroad?.status === 'published') published++;
          }
        } else {
          failed++;
        }
      }
      this.event(
        `gumroad bulk: ${shipped} shipped, ${published} published, ${failed} failed` +
          (stoppedAtCap ? `, stopped at daily limit (${this.config.gumroad.maxDraftsPerDay}/day)` : ''),
      );
    } finally {
      this.gumroadBulkRunning = false;
      this.changed();
    }
  }

  /// Publish every clean draft — drafts carrying an error stay drafts.
  private async publishAllGumroad(): Promise<void> {
    if (this.gumroadBulkRunning) {
      this.event('gumroad bulk already running');
      return;
    }
    this.gumroadBulkRunning = true;
    this.changed();
    try {
      let published = 0;
      let failed = 0;
      for (const a of [...this.assets]) {
        const g = a.channels?.gumroad;
        if (g?.status !== 'draft' || !g.productId || g.error) continue;
        await this.publishGumroad(a.sku);
        if (this.asset(a.sku)?.channels?.gumroad?.status === 'published') published++;
        else failed++;
      }
      this.event(`gumroad bulk publish: ${published} published, ${failed} failed`);
    } finally {
      this.gumroadBulkRunning = false;
      this.changed();
    }
  }

  /// Move an asset out of the pipeline: its folder goes to archive/ and
  /// every live sku reference is dropped. Never touches Gumroad — a
  /// productId means a real product exists and the archive is refused.
  /// Active jobs also refuse (an agent is mid-work); merely QUEUED jobs
  /// for the sku are removed instead.
  private archiveAsset(sku: string, reason: string): boolean {
    const asset = this.asset(sku);
    if (!asset) return false;
    if (asset.channels?.gumroad?.productId) {
      this.event(`archive refused: ${sku} is a real gumroad product`, undefined, sku);
      return false;
    }
    if (this.jobs.some((j) => j.sku === sku && j.status === 'active')) {
      this.event(`archive refused: ${sku} has an agent working on it`, undefined, sku);
      return false;
    }
    this.jobs = this.jobs.filter((j) => !(j.sku === sku && j.status === 'queued'));
    try {
      moveToArchive(FACTORY_DIR, sku, {
        sku,
        title: asset.title,
        status: asset.status,
        score: asset.inspection?.score,
        reason,
        at: Date.now(),
      });
    } catch {
      /* fs hiccup — drop the state anyway */
    }
    // live sku-keyed state only — market revenue history/totals stay
    this.market.quality.delete(sku);
    this.market.listedAt.delete(sku);
    this.assets = this.assets.filter((a) => a.sku !== sku);
    this.event(`archived ${sku}: ${reason}`, undefined, sku);
    this.changed();
    return true;
  }

  /// Auto-archive after the job that produced the verdict is done —
  /// archiving earlier would hit the active-job refusal.
  private maybeArchiveFailed(sku: string, reason: string): void {
    if (this.config.autoArchiveFailed) this.archiveAsset(sku, reason);
  }

  /// Archive every failed/scrapped asset plus listed ones with a
  /// PERMANENT ship-gate issue. In-pipeline and real-product assets are
  /// never touched.
  private archiveUnshippable(): void {
    let n = 0;
    for (const a of [...this.assets]) {
      if (a.channels?.gumroad?.productId) continue;
      if (a.status === 'failed' || a.status === 'scrapped') {
        if (this.archiveAsset(a.sku, `unshippable: ${a.status}`)) n++;
        continue;
      }
      if (a.status === 'listed') {
        const reasons = unshippableReasons(a, loadShipMeta(a.sku), this.config.gumroad);
        if (reasons.length && this.archiveAsset(a.sku, `unshippable: ${reasons[0].slice(0, 80)}`)) n++;
      }
    }
    this.event(`archived ${n} unshippable asset(s)`);
    this.changed();
  }

  private setGumroadConfig(raw: Record<string, unknown>): void {
    const g = { ...this.config.gumroad };
    if (typeof raw.minScore === 'number') g.minScore = Math.min(10, Math.max(1, Math.round(raw.minScore)));
    if (typeof raw.maxDraftsPerDay === 'number') g.maxDraftsPerDay = Math.min(20, Math.max(1, Math.round(raw.maxDraftsPerDay)));
    if (typeof raw.packsOnly === 'boolean') g.packsOnly = raw.packsOnly;
    if (typeof raw.autoPublish === 'boolean') g.autoPublish = raw.autoPublish;
    this.config.gumroad = g;
    saveConfig(this.config);
    this.event(`gumroad config updated (score≥${g.minScore}${g.packsOnly ? ', packs only' : ''}, ${g.maxDraftsPerDay}/day${g.autoPublish ? ', auto-publish' : ''})`);
    this.changed();
  }

  private startShift(): void {
    if (this.shift === 'running') return;
    if (capExceeded(this.usage, this.config.dailyTokenCaps)) {
      this.tokenCapHit = true;
      this.event('daily token cap hit — paused until midnight or raise the cap');
      this.changed();
      return;
    }
    this.tokenCapHit = false;
    this.shift = 'running';
    this.healOrphans();
    this.event('shift started — the factory hums to life');
    for (const a of this.agents) {
      if (a.state === 'offline' || a.state === 'error') a.state = 'idle';
    }
    if (this.config.mode === 'research') {
      // research-only: scan itch.io, then the scout analyses the report.
      // No production, no mock-market sales. A LINKED worker never scans
      // locally — it works from relay-pushed analysis.
      if (this.relayAvailable()) this.maybeQueueScout();
      else void this.scanThenScout(true);
    } else {
      this.market.writeReport(this.assets);
      this.promoteOpportunities();
      this.maybeQueueScout();
      this.maybeScout();
    }
    this.changed();
  }

  private setMode(mode: 'research' | 'full'): void {
    if (mode !== 'research' && mode !== 'full') return;
    if (this.config.mode === mode) return;
    this.config.mode = mode;
    saveConfig(this.config);
    this.event(`mode: ${mode === 'research' ? 'RESEARCH (itch.io, read-only)' : 'FULL (mock market pipeline)'}`);
    if (mode === 'full') {
      this.promoteOpportunities();
      this.maybeQueueScout();
    } else {
      this.maybeQueueScout();
    }
    this.changed();
  }

  private setMarketSource(source: 'itch' | 'mock'): void {
    if (source !== 'itch' && source !== 'mock') return;
    if (this.config.marketSource === source) return;
    this.config.marketSource = source;
    saveConfig(this.config);
    this.event(`market source: ${source}`);
    this.changed();
  }

  private pauseShift(): void {
    if (this.shift !== 'running') return;
    this.shift = 'paused';
    this.event('shift paused — running turns finish');
    this.changed();
  }

  private stopShift(): void {
    this.shift = 'stopped';
    for (const a of this.agents) {
      if (a.sessionId && a.state === 'working') this.acp.cancel(a.sessionId);
      if (a.state === 'working') a.state = 'idle';
      a.currentJobId = null;
    }
    for (const j of this.jobs) {
      if (j.status === 'active') {
        j.status = 'queued';
        j.assignee = undefined;
      }
    }
    this.event('shift stopped — jobs requeued');
    this.changed();
  }

  private setModels(role: AgentKind, model: string): void {
    if (!(role in this.config.models) || !model) return;
    this.config.models[role] = model;
    saveConfig(this.config);
    for (const a of this.agents) {
      if (a.kind !== role) continue;
      a.model = model;
      a.modelName = model;
      a.modelMismatch = undefined;
      // applies to new sessions: reset idle ones so their next job reconfigures
      if (a.state === 'idle' || a.state === 'offline') {
        a.sessionId = null;
        a.jobsInSession = 0;
      }
    }
    this.event(`${role} model: ${model}`);
    this.changed();
  }

  private setCaps(caps: { overlord?: number | null; workers?: number | null }): void {
    const next: NonNullable<FactoryConfig['dailyTokenCaps']> = { ...(this.config.dailyTokenCaps ?? {}) };
    for (const k of ['overlord', 'workers'] as const) {
      const v = caps?.[k];
      if (v === null) delete next[k];
      else if (typeof v === 'number' && Number.isFinite(v) && v > 0) next[k] = Math.floor(v);
    }
    this.config.dailyTokenCaps = Object.keys(next).length ? next : null;
    saveConfig(this.config);
    this.tokenCapHit = capExceeded(this.usage, this.config.dailyTokenCaps);
    this.event(
      this.config.dailyTokenCaps
        ? `token caps: overlord ${next.overlord ?? '—'} · workers ${next.workers ?? '—'} /day`
        : 'token caps off',
    );
    this.changed();
  }

  private directive(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.pendingDirectives.push(t);
    this.event(`directive received: ${t.slice(0, 80)}`);
    this.changed();
  }

  private cancelAgent(agentId: string): void {
    const a = this.agent(agentId);
    if (!a) return;
    if (a.sessionId) this.acp.cancel(a.sessionId);
    if (a.currentJobId) {
      const j = this.jobs.find((x) => x.id === a.currentJobId);
      if (j) {
        j.status = 'queued';
        j.assignee = undefined;
      }
      a.currentJobId = null;
    }
    if (a.state === 'working') a.state = 'idle';
    this.push(a, 'system', 'turn cancelled');
    this.changed();
  }

  // ---- acp event wiring -------------------------------------------------------

  private onUpdate(sessionId: string, update: Json): void {
    const agent = this.agents.find((a) => a.sessionId === sessionId);
    if (!agent) return;
    const kind = update?.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = update?.content?.text ?? '';
      const last = agent.transcript[agent.transcript.length - 1];
      if (last?.role === 'agent' && last.text.length < ENTRY_CAP) last.text = (last.text + text).slice(0, ENTRY_CAP);
      else this.push(agent, 'agent', text);
    } else if (kind === 'agent_thought_chunk') {
      const text = (update?.content?.text ?? '').trim();
      if (text) agent.statusLine = `thinking: ${text.split('\n')[0].slice(0, 80)}`;
    } else if (kind === 'tool_call') {
      const title = update?.title ?? 'tool call';
      agent.statusLine = title;
      this.push(agent, 'tool', `${title} [${update?.kind ?? 'other'}]`);
    } else if (kind === 'tool_call_update') {
      if (update?.title) agent.statusLine = update.title;
    } else if (kind === 'usage_update') {
      agent.lastUsage = update;
      this.onUsage(agent, update);
    }
    this.changed();
  }

  // ---- token usage ------------------------------------------------------------

  /// raw event → logs/usage.jsonl (rotated at 20 MB) + accumulated buckets.
  /// One usage_update = one model request — APPROX, the log lets us check.
  private onUsage(agent: Agent, update: Json): void {
    const entry = { at: Date.now(), agentId: agent.id, role: agent.kind, model: agent.model, update };
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      const p = join(LOG_DIR, 'usage.jsonl');
      if (existsSync(p) && statSync(p).size > 20 * 1024 * 1024) {
        renameSync(p, join(LOG_DIR, 'usage.jsonl.1'));
      }
      appendFileSync(p, JSON.stringify(entry) + '\n');
    } catch {
      /* metering must never break a job */
    }
    recordUsage(this.usage, agent.kind, agent.model, update, Date.now());
    if (capExceeded(this.usage, this.config.dailyTokenCaps)) {
      this.tokenCapHit = true;
      if (this.shift === 'running') {
        this.shift = 'paused';
        this.event('daily token cap hit — paused until midnight or raise the cap');
      }
    } else if (this.tokenCapHit) {
      // midnight rolled (buckets reset) or caps were raised
      this.tokenCapHit = false;
    }
  }

  private onPermission(sessionId: string, requestId: Json, params: Json): void {
    const agent = this.agents.find((a) => a.sessionId === sessionId);
    let decision = decidePermission(params, FACTORY_DIR);
    // research mode: web fetches are itch.io ONLY — reject any other host
    let urlRefused = false;
    if (decision.allowed && this.config.mode === 'research' && !urlsAllowed(params)) {
      const opts: { optionId?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : [];
      const rej = opts.find((o) => (o.kind ?? '').startsWith('reject'));
      decision = { optionId: typeof rej?.optionId === 'string' ? rej.optionId : null, allowed: false, paths: decision.paths };
      urlRefused = true;
    }
    if (decision.optionId === null) {
      // nothing we could pick — cancel outright
      this.acp.answerPermission(requestId, null);
      if (agent) this.push(agent, 'system', `permission auto-cancelled (${decision.allowed ? 'no allow option' : 'refused: outside factory'})`);
      return;
    }
    this.acp.answerPermission(requestId, decision.optionId);
    if (agent) {
      const title = params?.toolCall?.title ?? 'tool call';
      this.push(
        agent,
        'system',
        decision.allowed
          ? `permission auto-approved: ${title}`
          : `permission refused: ${urlRefused ? 'non-itch.io URL' : 'outside factory'} — ${title} (${decision.paths.join(', ')})`,
      );
      agent.statusLine = title;
      this.changed();
    }
  }
}

interface OrderLike {
  size: number;
  frames: number;
}
