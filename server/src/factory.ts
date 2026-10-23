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
  decidePermission,
  extractReport,
  inspectingRecoverySkus,
  JOB_AGENT_KIND,
  parseDecisions,
  parseDemand,
  parseInspection,
  pickSmith,
  opportunitiesToCandidates,
  recordUsage,
  shouldQueueScout,
  urlsAllowed,
} from './parse.js';
import { forgePrompt, inspectPrompt, overlordPrompt, packPrompt, scoutPrompt, scoutPromptItch } from './prompts.js';
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
/// Re-scout when the last trend report is older than this many market ticks.
const SCOUT_STALE_TICKS = 10;

type Json = any;

/// Thrown when a turn's job was requeued/stopped while the prompt was in
/// flight — the pipeline must not continue on its result.
class CancelledError extends Error {}

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
          job.status = 'queued';
          job.assignee = undefined;
          job.note = `retried after: ${msg}`.slice(0, 200);
          agent.currentJobId = null;
        } else {
          this.finishJob(job, false);
          if (job.sku) this.setAssetStatus(job.sku, 'failed', msg);
        }
      }
      this.event(`${agent.name} errored: ${msg}`, agent.id, job?.sku);
    }
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
        const cur = configOption(r?.configOptions, 'model');
        const found = offered.find((v) => v.id === cur?.currentValue);
        if (found) agent.modelName = found.name;
      } else {
        const found = offered.find((v) => v.id === modelOpt.currentValue);
        if (found) agent.modelName = found.name;
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
          return;
        }
      } else {
        this.setAssetStatus(asset.sku, 'failed', checks.issues.join('; '));
        this.finishJob(job, false);
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
      this.finishJob(job, false);
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
      this.finishJob(job, false);
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
          const asset: Asset = {
            sku,
            title: c.title,
            tags: c.tags,
            size: c.size,
            frames: c.frames,
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
    }
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
