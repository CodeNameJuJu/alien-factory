// Wire protocol shared by the Alien Factory server and client.

export interface ConfigOptionValue {
  id: string;
  name: string;
}

export interface AcpStatus {
  authenticated: boolean;
  models: ConfigOptionValue[];
  modelGroups: { name: string; values: ConfigOptionValue[] }[];
  defaultModel: string | null;
  modes: ConfigOptionValue[];
  alive: boolean;
}

// ---- agents ---------------------------------------------------------------

export type AgentKind = 'overlord' | 'scout' | 'smith' | 'inspector' | 'packer';

/// 'sprite' = one animated sprite (≤8 frames); 'pack' = a multi-sprite pack
/// (4–48 items, each its own animation, emitted via lib/pix.mjs emitPack).
export type AssetKind = 'sprite' | 'pack';

export type AgentState = 'offline' | 'idle' | 'working' | 'error';

export interface TranscriptEntry {
  role: 'user' | 'agent' | 'tool' | 'system';
  text: string;
  at: number;
}

export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  model: string;
  modelName: string;
  sessionId: string | null;
  jobsInSession: number;
  state: AgentState;
  statusLine: string;
  currentJobId: string | null;
  transcript: TranscriptEntry[];
  /// Raw usage_update payload (shape unknown — shown as JSON in the UI).
  lastUsage?: unknown;
  /// configured model wasn't offered by Devin — the session fell back
  modelMismatch?: { want: string; using: string };
}

// ---- candidates -------------------------------------------------------------

/// A market opportunity the scout proposes; the overlord approves (assigning
/// it to a smith) or declines it. Ids are `c<counter>`, globally increasing.
export interface Candidate {
  id: string;
  title: string;
  tags: string[];
  size: 16 | 32;
  frames: number;
  /// absent = 'sprite' (old data); packs carry the requested item count
  kind?: AssetKind;
  items?: number;
  itemNames?: string[];
  /// scout's pitch — why it will sell
  why: string;
  /// scout-estimated demand, 1-10
  demand: number;
  variantOf?: string;
  /// which trends-<n>.md report proposed it
  reportN: number;
  status: 'pending' | 'approved' | 'declined';
  reason?: string;
  /// smith the overlord assigned it to (agent id)
  smith?: string;
  /// the asset it became, once approved
  sku?: string;
  createdAt: number;
  decidedAt?: number;
}

// ---- assets ---------------------------------------------------------------

export type AssetStatus =
  | 'queued'
  | 'forging'
  | 'inspecting'
  | 'on_conveyor'
  | 'packing'
  | 'listed'
  | 'scrapped'
  | 'failed';

export interface AssetChecks {
  passed: boolean;
  issues: string[];
}

export interface AssetInspection {
  verdict: 'PASS' | 'FAIL';
  score: number;
  notes: string;
}

export interface AssetListing {
  title: string;
  description: string;
  tags: string[];
  priceUsd: number;
}

// ---- sales channels (Gumroad) ------------------------------------------------
//
// The ONLY path off the mock market: a gated, per-asset, manual-approval
// ship to a real Gumroad store (draft by default). Runs on the Mac worker —
// the token lives in worker.env and is NEVER sent to clients; the state
// only reports `channels.gumroad.configured`.

export type GumroadShipStatus =
  | 'none'
  | 'building' // kit being written
  | 'uploading' // multipart file upload in flight
  | 'draft' // product created, published:false
  | 'published' // /v2/products/:id/enable accepted
  | 'error';

export interface GumroadShip {
  status: GumroadShipStatus;
  productId?: string;
  editUrl?: string;
  shortUrl?: string;
  at?: number;
  /// last error (NEVER contains the token)
  error?: string;
  /// covers/thumbnail attach result via signed public relay URLs
  images?: { covers: number; thumbnail: boolean; at: number };
  /// non-fatal image-attach problem (e.g. no relay configured)
  imagesError?: string;
  /// dry-run request plan (endpoints + non-secret params), for inspection
  plan?: unknown;
}

export interface GumroadConfig {
  /// minimum inspector score required to ship
  minScore: number;
  /// only multi-sprite packs may ship
  packsOnly: boolean;
  /// product creates per local day (Gumroad rate-limits creation too)
  maxDraftsPerDay: number;
  /// immediately /enable a new draft product
  autoPublish: boolean;
}

export interface AssetSales {
  views: number;
  units: number;
  revenueUsd: number;
}

export interface Asset {
  sku: string;
  title: string;
  tags: string[];
  size: number;
  frames: number;
  variantOf?: string;
  orderBrief: string;
  /// the candidate it was approved from
  candidateId?: string;
  /// the smith (agent id) the overlord assigned it to
  smith?: string;
  status: AssetStatus;
  /// absent = 'sprite' (old data); packs carry the produced item count
  kind?: AssetKind;
  items?: number;
  itemNames?: string[];
  attempts: number;
  checks?: AssetChecks;
  inspection?: AssetInspection;
  listing?: AssetListing;
  /// off-mock-market shipping state (Gumroad draft/publish)
  channels?: { gumroad?: GumroadShip };
  sales: AssetSales;
  assignedTo?: string;
  createdAt: number;
  updatedAt: number;
}

// ---- jobs -----------------------------------------------------------------

export type JobKind = 'scout' | 'forge' | 'inspect' | 'pack';

export interface Job {
  id: string;
  kind: JobKind;
  sku?: string;
  status: 'queued' | 'active' | 'done' | 'failed';
  assignee?: string;
  /// only this agent may take the job (overlord-assigned smith)
  pinnedTo?: string;
  /** forge jobs carry the smith's re-prompt notes when retries happen */
  note?: string;
  createdAt: number;
  finishedAt?: number;
}

// ---- logs / market --------------------------------------------------------

export interface Decision {
  candidateId: string;
  title: string;
  approved: boolean;
  reason: string;
  smith?: string;
  sku?: string;
  at: number;
}

export interface OrderSpec {
  title: string;
  tags: string[];
  size: number;
  frames: number;
  /// absent = 'sprite'
  kind?: AssetKind;
  /// pack orders only: requested item count (4-48) + optional name list
  items?: number;
  itemNames?: string[];
  variantOf?: string;
  brief: string;
}

export interface FactoryEvent {
  at: number;
  text: string;
  agentId?: string;
  sku?: string;
}

export interface MarketTag {
  tag: string;
  demand: number;
  /// +1 rising, -1 falling, 0 flat — compared to the previous tick.
  trend: number;
}

export interface CompetitorListing {
  title: string;
  tag: string;
  priceUsd: number;
  sales: number;
}

export interface MarketState {
  tick: number;
  tags: MarketTag[];
  competitors: CompetitorListing[];
  revenueHistory: number[];
  totals: { views: number; units: number; revenueUsd: number };
}

// ---- itch.io research --------------------------------------------------------

export interface ItchItem {
  id: string;
  title: string;
  url: string;
  blurb: string;
  author: string;
  price: number | null;
  currency: string | null;
  salePct: number | null;
  free: boolean;
  thumb: string;
  /// position within its feed (1-based)
  rank?: number;
}

export interface ItchSnapshot {
  at: number;
  feeds: Record<string, ItchItem[]>;
}

export interface ItchTheme {
  key: string;
  score: number;
  count: number;
  inTopSellers: number;
  inNewAndPopular: number;
  medianPrice: number | null;
  pctFree: number;
  /// score change vs the previous snapshot (null on first scan)
  delta: number | null;
}

export interface ItchMover {
  title: string;
  url: string;
  kind: 'new_top_seller' | 'climbed' | 'new_popular';
  detail: string;
}

export interface ItchAnalysis {
  at: number;
  themes: ItchTheme[];
  movers: ItchMover[];
  priceStats: {
    median: number | null;
    p25: number | null;
    p75: number | null;
    pctFree: number;
    pctOnSale: number;
    count: number;
  };
  topSellers: ItchItem[];
  newAndPopular: ItchItem[];
}

export interface ItchState {
  lastScanAt: number | null;
  scanning: boolean;
  error: string | null;
  /// when itch.io throttled us: no scans before this timestamp
  backoffUntil: number | null;
  analysis: ItchAnalysis | null;
}

/// An opportunity the scout finds in market research (research mode stores
/// these on the trend report instead of making candidates).
export interface Opportunity {
  title: string;
  tags: string[];
  size: number;
  frames: number;
  why: string;
  demand: number;
  variantOf?: string;
  kind?: AssetKind;
  items?: number;
  itemNames?: string[];
  /// itch.io listing urls cited as evidence
  evidence?: string[];
  priceBand?: string;
}

export interface TrendReport {
  n: number;
  at: number;
  markdown: string;
  opportunities: Opportunity[];
  /// itch scan the report was based on (if any)
  scanAt?: number;
  /// its opportunities were turned into overlord candidates (full mode)
  promoted?: boolean;
}

// ---- token usage meter -----------------------------------------------------

export interface UsageCounts {
  input: number;
  cachedRead: number;
  cachedWrite: number;
  output: number;
  /// one usage_update = one model request (approx — see usage.jsonl)
  requests: number;
}

/// day bucket rolls at local midnight; hour bucket at the top of the hour
export interface UsageTotals {
  day: UsageCounts & { date: string };
  hour: UsageCounts & { hour: string };
  total: UsageCounts;
}

export interface UsageState {
  byRole: Partial<Record<AgentKind, UsageTotals>>;
  byModel: Record<string, UsageTotals>;
}

/// USD per 1M tokens for a model — absent = tokens only, no cost shown
export interface ModelPrices {
  inPerM: number;
  cachedReadPerM: number;
  cachedWritePerM: number;
  outPerM: number;
}

/// daily caps counted across ALL tokens incl. cached; null field = uncapped
export interface DailyTokenCaps {
  overlord?: number;
  workers?: number;
}

export interface FactoryConfig {
  /// ACP model id per agent role
  models: Record<AgentKind, string>;
  smiths: number;
  maxOverlordTurnsPerHour: number;
  maxApprovalsPerTurn: number;
  /// fresh session after N jobs per worker role (overlord keeps its session)
  sessionJobLimit: Record<'scout' | 'smith' | 'inspector' | 'packer', number>;
  /// full-mode rescout cadence when the current analysis is already covered
  rescoutHours: number;
  usdToZar: number;
  /// USD/1M tokens per model id — empty = show tokens only
  prices: Record<string, ModelPrices>;
  /// daily total-token caps (incl. cached); null = off
  dailyTokenCaps: DailyTokenCaps | null;
  /// research = scout analyses itch.io only; full = produce+sell on the mock market
  mode: 'research' | 'full';
  /// which market data the scout reads (mock stays the only sales target)
  marketSource: 'itch' | 'mock';
  /// Gumroad channel gates (token itself is env-only, never here)
  gumroad: GumroadConfig;
  itchScanMinutes: number;
  /// e.g. "game-assets/top-sellers/tag-pixel-art" (+ optional ":N" pages)
  itchFeeds: (string | { feed: string; pages: number })[];
}

export type ShiftState = 'stopped' | 'running' | 'paused';

// ---- messages --------------------------------------------------------------

export interface StateMessage {
  type: 'state';
  shift: ShiftState;
  agents: Agent[];
  candidates: Candidate[];
  assets: Asset[];
  jobs: Job[];
  decisions: Decision[];
  events: FactoryEvent[];
  market: MarketState;
  config: FactoryConfig;
  acp: AcpStatus;
  latestTrendReport: string | null;
  itch: ItchState;
  trendReports: TrendReport[];
  /// false on deployments where `devin acp` can't run (no Desktop) — the
  /// client disables all agent controls then.
  devinEnabled: boolean;
  /// relay deployments only: is the agent-running worker linked right now
  worker?: WorkerStatus;
  /// token meter (approx — raw events also in logs/usage.jsonl)
  usage: UsageState;
  /// shift was auto-paused because a daily token cap was exceeded
  tokenCapHit: boolean;
  /// sales channels — only booleans, no secrets
  channels: { gumroad: { configured: boolean } };
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage = StateMessage | ErrorMessage;

/// Whether the factory worker (the Mac running `devin acp` agents) is
/// currently linked to this relay. Present only on relay deployments.
export interface WorkerStatus {
  connected: boolean;
  lastSeenAt: number | null;
}

/// The worker's own state as sent over the link — the whole browser state
/// payload minus `type`/`worker` (the relay adds `worker` itself).
export type WorkerStatePayload = Omit<StateMessage, 'type' | 'worker'>;

// ---- worker ⇄ relay link ----------------------------------------------------
//
// The Mac worker opens an OUTBOUND ws to <relay>/worker with a bearer key;
// browsers never use this endpoint. `protocol` versions the handshake.

export const LINK_PROTOCOL = 1;

export type WorkerToRelay =
  | { type: 'hello'; protocol: number; version: string }
  | { type: 'state'; state: WorkerStatePayload }
  | { type: 'asset'; sku: string; files: Record<string, string> }
  /// worker's UI asked for a rescan — the relay performs it
  | { type: 'scanRequest' };

export type RelayToWorker =
  | { type: 'welcome'; assetHashes: Record<string, Record<string, string>> }
  | { type: 'command'; msg: ClientMessage }
  | { type: 'itch'; analysis: ItchAnalysis | null; reportMarkdown: string; lastScanAt: number };

export type ClientMessage =
  | { type: 'startShift' }
  | { type: 'pauseShift' }
  | { type: 'stopShift' }
  | { type: 'setModels'; role: AgentKind; model: string }
  | { type: 'setCaps'; caps: { overlord?: number | null; workers?: number | null } }
  | { type: 'directive'; text: string }
  | { type: 'cancelAgent'; agentId: string }
  | { type: 'signIn' }
  | { type: 'setMode'; mode: 'research' | 'full' }
  | { type: 'setMarketSource'; source: 'itch' | 'mock' }
  | { type: 'scanNow' }
  /// Gumroad channel — dryRun returns the request plan without uploading
  | { type: 'shipGumroad'; sku: string; dryRun?: boolean }
  | { type: 'publishGumroad'; sku: string }
  /// attach kit cover/thumbnail/gallery/gif to an existing product
  | { type: 'attachGumroadImages'; sku: string }
  /// drop a failed gumroad record (LOCAL state only — refuses productIds)
  | { type: 'clearGumroad'; sku: string }
  /// re-poll live draft/published status for every shipped product
  | { type: 'refreshGumroad' }
  | { type: 'setGumroadConfig'; config: Partial<GumroadConfig> };
