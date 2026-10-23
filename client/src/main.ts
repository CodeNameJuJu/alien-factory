import { Net } from './net';
import { Hud } from './hud';
import { Drawers, type Selection } from './drawers';
import { startDemo } from './demo';
import { drawFloor, hitTest, W, H, type FloorView } from './floor';
import { updateAliens, drawAliens, drawOverlord } from './aliens';
import type { Agent, ServerMessage, StateMessage } from '../../shared/protocol';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;

// ---- state ------------------------------------------------------------------

const empty: StateMessage = {
  type: 'state',
  shift: 'stopped',
  agents: [],
  candidates: [],
  assets: [],
  jobs: [],
  decisions: [],
  events: [],
  market: { tick: 0, tags: [], competitors: [], revenueHistory: [], totals: { views: 0, units: 0, revenueUsd: 0 } },
  config: {
    models: { overlord: '', scout: '', smith: '', inspector: '', packer: '' },
    smiths: 3, maxOverlordTurnsPerHour: 6,
    maxApprovalsPerTurn: 4,
    sessionJobLimit: { scout: 1, smith: 1, inspector: 4, packer: 6 },
    rescoutHours: 6, usdToZar: 18.5, prices: {}, dailyTokenCaps: null,
    mode: 'research', marketSource: 'itch', itchScanMinutes: 60, itchFeeds: [],
    gumroad: { minScore: 7, packsOnly: true, maxDraftsPerDay: 3, autoPublish: false },
  },
  channels: { gumroad: { configured: false } },
  acp: { authenticated: false, models: [], modelGroups: [], defaultModel: null, modes: [], alive: false },
  latestTrendReport: null,
  itch: { lastScanAt: null, scanning: false, error: null, backoffUntil: null, analysis: null },
  trendReports: [],
  devinEnabled: true,
  usage: { byRole: {}, byModel: {} },
  tokenCapHit: false,
};

let state = empty;
let selected: Selection | null = null;
let hoverId: string | null = null;

const DEMO = new URLSearchParams(location.search).has('demo');
const net = new Net();
const drawers = new Drawers(net);
const hud = new Hud(net, {
  onSelect: (sel) => {
    if (sel.type === 'asset' && sel.id) select({ type: 'asset', id: sel.id });
    else if (sel.type === 'agent' && sel.id) select({ type: 'agent', id: sel.id });
    else if (sel.type === 'market') select({ type: 'market' });
    else if (sel.type === 'gallery') select({ type: 'gallery' });
    else if (sel.type === 'trends') select({ type: 'trends' });
    else if (sel.type === 'models') select({ type: 'models' });
    else if (sel.type === 'shop') select({ type: 'shop' });
    else select({ type: 'overlord' });
  },
});

function applyState(s: StateMessage): void {
  state = s;
  hud.update(s);
  drawers.setState(s);
}

net.onMessage = (msg: ServerMessage) => {
  if (msg.type === 'state') applyState(msg);
  else if (msg.type === 'error') toast(msg.message);
};

if (DEMO) startDemo(applyState);
else net.connect();

function select(sel: Selection | null): void {
  selected = sel;
  if (sel) drawers.open(sel);
  else drawers.close();
}
drawers.onClose = () => (selected = null);

function toast(text: string): void {
  const el = document.getElementById('toast')!;
  el.textContent = text;
  el.style.display = 'block';
  setTimeout(() => (el.style.display = 'none'), 4000);
}

// ---- DOM nameplates ----------------------------------------------------------

const labelsEl = document.createElement('div');
labelsEl.id = 'labels';
document.body.appendChild(labelsEl);
const labelDivs = new Map<string, HTMLDivElement>();

function stateColor(a: Agent): string {
  if (a.state === 'working') return '#e0a030';
  if (a.state === 'error') return '#e05050';
  if (a.state === 'offline') return '#606070';
  return '#70b070';
}

function renderLabels(pos: Map<string, { x: number; y: number }>): void {
  const r = canvas.getBoundingClientRect();
  const sx = r.width / W;
  const sy = r.height / H;
  const seen = new Set<string>();
  const tiny = sx < 1; // canvas under 1x — only important plates, smaller
  for (const a of state.agents) {
    const p = a.kind === 'overlord' ? { x: 240, y: 106 } : pos.get(a.id);
    if (!p) continue;
    // at tiny scales only working/selected/offline-status plates show —
    // idle names would just overlap and spill
    const selId = selected && 'id' in selected ? selected.id : null;
    if (tiny && a.state !== 'working' && selId !== a.id) continue;
    seen.add(a.id);
    let div = labelDivs.get(a.id);
    if (!div) {
      div = document.createElement('div');
      div.className = 'nameplate';
      div.innerHTML = '<span class="np-dot"></span><span class="np-name"></span>';
      labelsEl.appendChild(div);
      labelDivs.set(a.id, div);
    }
    // clamp inside the canvas so plates never spill past the edges
    const lx = Math.min(Math.max(r.left + p.x * sx, r.left + 34), r.right - 34);
    const ly = Math.min(Math.max(r.top + (p.y - 18) * sy, r.top + 2), r.bottom - 16);
    div.style.left = `${lx}px`;
    div.style.top = `${ly}px`;
    (div.querySelector('.np-dot') as HTMLElement).style.background = stateColor(a);
    (div.querySelector('.np-name') as HTMLElement).textContent = a.name;
    div.classList.toggle('np-hover', hoverId === a.id);
  }
  for (const [id, div] of labelDivs) {
    if (!seen.has(id)) {
      div.remove();
      labelDivs.delete(id);
    }
  }
}

// ---- input --------------------------------------------------------------------

function toCanvas(e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}

let mouse = { x: -1, y: -1 };
canvas.addEventListener('mousemove', (e) => {
  mouse = toCanvas(e);
});
canvas.addEventListener('click', (e) => {
  const p = toCanvas(e);
  // bigger hit areas for fingers: below 2x display scale, pad the radii
  const scale = canvas.getBoundingClientRect().width / W;
  const pad = scale >= 2 ? 1 : Math.min(2.5, 2 / scale);
  const hit = hitTest(p.x, p.y, floorView(), animT, lastPositions, pad);
  if (!hit) {
    select(null);
    return;
  }
  if (hit.type === 'overlord') select({ type: 'overlord' });
  else if (hit.type === 'agent') select({ type: 'agent', id: hit.id });
  else if (hit.type === 'asset') select({ type: 'asset', id: hit.id });
  else if (hit.type === 'portal') select({ type: 'market' });
  else if (hit.type === 'trends') select({ type: 'trends' });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

function fit(): void {
  // reserve space for the compact HUD + ticker on small screens
  const narrow = window.innerWidth < 760;
  const reserve = narrow ? 130 : 0;
  const s = Math.min(window.innerWidth / W, (window.innerHeight - reserve) / H);
  canvas.style.width = `${Math.floor(W * s)}px`;
  canvas.style.height = `${Math.floor(H * s)}px`;
}
window.addEventListener('resize', fit);
fit();

// ---- loop ------------------------------------------------------------------------

let last = 0;
let animT = 0;
let lastDt = 0.016;
let lastPositions = new Map<string, { x: number; y: number }>();

function floorView(): FloorView {
  const working = new Set(state.agents.filter((a) => a.state === 'working').map((a) => a.id));
  const overlord = state.agents.find((a) => a.kind === 'overlord');
  return {
    assets: state.assets,
    market: state.market,
    smithCount: state.agents.filter((a) => a.kind === 'smith').length || state.config.smiths,
    workingAgents: working,
    overlordThinking: overlord?.state === 'working',
    pendingProposals: state.candidates.filter((c) => c.status === 'pending').length,
    scanning: state.itch.scanning,
    dt: lastDt,
  };
}

function loop(t: number): void {
  const dt = Math.min(0.05, (t - last) / 1000 || 0);
  last = t;
  animT += dt;
  lastDt = dt;

  const views = updateAliens(state.agents, dt, animT);
  lastPositions = new Map([...views].map(([k, v]) => [k, { x: v.x, y: v.y }]));
  const fv = floorView();

  // hover
  const hit = mouse.x >= 0 ? hitTest(mouse.x, mouse.y, fv, animT, lastPositions) : null;
  hoverId = hit?.id ?? null;
  canvas.style.cursor = hit ? 'pointer' : 'default';

  ctx.clearRect(0, 0, W, H);
  drawFloor(ctx, animT, fv);
  drawOverlord(ctx, state.agents.find((a) => a.kind === 'overlord'), animT, selected?.type === 'overlord' ? 'overlord' : null);
  drawAliens(ctx, state.agents, views, animT, selected?.type === 'agent' ? selected.id : null);
  drawers.tick(animT);
  hud.tick(animT);
  renderLabels(lastPositions);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
