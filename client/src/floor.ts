// The factory floor: dark metal tiles, wall pipes, the Overlord's dais,
// worker stations and the output conveyor (inspector drops on the left,
// packer ships into the portal on the right).
import type { Asset, MarketState } from '../../shared/protocol';
import { crateSprite } from './sprites';
import { drawAssetFrame, drawPackBadge } from './assets';

export const W = 480;
export const H = 270;

export const DAIS = { x: 240, y: 140, r: 26 };
export const BELT_Y = 234;
export const PORTAL = { x: 462, y: BELT_Y };
/// QA scanner at the left end of the conveyor — items enter the line here.
export const SCANNER = { x: 44, y: 214 };
/// Packer station at the right end, just before the portal.
export const PACKER = { x: 424, y: 214 };
const ITEM_GAP = 26;

/// Idle anchor for each agent (station floor spot).
export interface Station {
  id: string;
  x: number;
  y: number;
}

export function stations(smithCount: number): Station[] {
  const out: Station[] = [
    { id: 'overlord', x: DAIS.x, y: DAIS.y + 8 },
    { id: 'scout', x: 58, y: 112 },
    { id: 'inspector', x: 60, y: 198 },
    { id: 'packer', x: 424, y: 198 },
  ];
  for (let i = 1; i <= smithCount; i++) {
    out.push({ id: `smith-${i}`, x: 100 + i * 70, y: 74 });
  }
  return out;
}

// ---- floor chrome -----------------------------------------------------------

const FLOOR_A = '#0d1420';
const FLOOR_B = '#111a28';
const WALL = '#0a0f18';
const PIPE = '#1e2a3a';
const PIPE_HI = '#2c3f56';
const METAL = '#232c3c';
const METAL_D = '#171f2b';
const ACCENT = '#5cf2c8';
const MAG = '#ff4fd8';
const AMBER = '#ffb84a';
const BELT = '#1c2430';
const BELT_SLAT = '#2b3a4c';

function tiles(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = FLOOR_A;
  ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 16) {
    for (let x = 0; x < W; x += 16) {
      if (((x + y) / 16) % 2 === 0) {
        ctx.fillStyle = FLOOR_B;
        ctx.fillRect(x, y, 16, 16);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x, y, 16, 1);
      ctx.fillRect(x, y, 1, 16);
    }
  }
  // faintly glowing floor grid — retro-futurist circuit board feel
  ctx.fillStyle = 'rgba(92,242,200,0.05)';
  for (let y = 0; y < H; y += 64) ctx.fillRect(0, y, W, 1);
  for (let x = 0; x < W; x += 64) ctx.fillRect(x, 0, 1, H);
}

function wallsAndPipes(ctx: CanvasRenderingContext2D, t: number): void {
  ctx.fillStyle = WALL;
  ctx.fillRect(0, 0, W, 14);
  ctx.fillRect(0, 0, 8, H);
  ctx.fillRect(W - 8, 0, 8, H);
  for (const py of [4, 9]) {
    ctx.fillStyle = PIPE;
    ctx.fillRect(0, py, W, 3);
    ctx.fillStyle = PIPE_HI;
    ctx.fillRect(0, py, W, 1);
  }
  ctx.fillStyle = PIPE;
  for (let x = 20; x < W; x += 60) ctx.fillRect(x, 2, 4, 12);
  ctx.fillStyle = ACCENT;
  const p = Math.floor(t * 40) % 60;
  for (let x = -p; x < W; x += 60) ctx.fillRect(x + 20, 5, 2, 1);
}

function belt(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, t: number): void {
  ctx.fillStyle = BELT;
  ctx.fillRect(x0, y0 - 4, x1 - x0, 8);
  ctx.fillStyle = BELT_SLAT;
  const off = Math.floor(t * 20) % 8;
  for (let d = -8 + off; d < x1 - x0; d += 8) {
    ctx.fillRect(x0 + d, y0 - 4, 1, 8);
  }
}

function dais(ctx: CanvasRenderingContext2D, t: number, thinking: boolean, pending: number): void {
  const { x, y, r } = DAIS;
  ctx.fillStyle = METAL_D;
  ctx.beginPath();
  ctx.ellipse(x, y + 4, r + 3, r * 0.55 + 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = METAL;
  ctx.beginPath();
  ctx.ellipse(x, y, r + 3, r * 0.55 + 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // neon edge + magenta energy rings around the Overlord
  ctx.strokeStyle = 'rgba(92,242,200,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, y, r + 3, r * 0.55 + 3, 0, 0, Math.PI * 2);
  ctx.stroke();
  const pulse = 0.4 + Math.sin(t * 3) * 0.25;
  ctx.strokeStyle = `rgba(255,79,216,${pulse})`;
  ctx.setLineDash([4, 3]);
  ctx.lineDashOffset = -t * 8;
  ctx.beginPath();
  ctx.ellipse(x, y, r - 3, r * 0.55 - 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,79,216,${pulse * 0.45})`;
  ctx.beginPath();
  ctx.ellipse(x, y, r - 8, r * 0.55 - 6, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  if (thinking) {
    const hy = y - 44 + Math.sin(t * 2) * 1.5;
    ctx.fillStyle = 'rgba(80,200,220,0.16)';
    ctx.fillRect(x - 24, hy, 48, 22);
    ctx.strokeStyle = 'rgba(120,230,250,0.8)';
    ctx.strokeRect(x - 24.5, hy - 0.5, 49, 23);
    ctx.fillStyle = 'rgba(160,240,255,0.9)';
    for (let i = 0; i < 5; i++) {
      const hgt = 3 + Math.abs(Math.sin(t * 5 + i * 1.7)) * 12;
      ctx.fillRect(x - 20 + i * 9, hy + 18 - hgt, 5, hgt);
    }
    if (pending > 0) {
      ctx.fillStyle = '#ffe8a0';
      ctx.font = '8px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${pending} proposal${pending === 1 ? '' : 's'}`, x, hy - 3);
    }
  }
}

function radar(ctx: CanvasRenderingContext2D, t: number, scanning: boolean): void {
  const x = 56, y = 92;
  ctx.fillStyle = METAL;
  ctx.fillRect(x - 12, y, 24, 10);
  ctx.fillStyle = METAL_D;
  ctx.fillRect(x - 12, y + 8, 24, 2);
  const a = t * (scanning ? 6 : 1.4);
  ctx.strokeStyle = '#8a80b0';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(a) * 10, y - 8 + Math.sin(a) * 4);
  ctx.stroke();
  ctx.fillStyle = '#b0a8d8';
  ctx.beginPath();
  ctx.ellipse(x + Math.cos(a) * 10, y - 9 + Math.sin(a) * 4, 6, 3, a * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x - 10, y + 2, 3, 2);
  if (scanning) {
    const blink = Math.floor(t * 3) % 2 === 0;
    if (blink) {
      ctx.fillStyle = 'rgba(92,242,200,0.9)';
      ctx.font = '7px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SCANNING', x, y - 14);
    }
  }
}

function assembler(ctx: CanvasRenderingContext2D, x: number, t: number, working: boolean): void {
  ctx.fillStyle = METAL;
  ctx.fillRect(x - 14, 30, 28, 26);
  ctx.fillStyle = METAL_D;
  ctx.fillRect(x - 14, 30, 28, 4);
  ctx.fillStyle = '#2c3f56';
  ctx.fillRect(x - 10, 38, 20, 14);
  ctx.fillStyle = 'rgba(92,242,200,0.7)'; // neon top edge
  ctx.fillRect(x - 14, 30, 28, 1);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x - 12, 34, 3, 2);
  if (working) {
    ctx.fillStyle = AMBER;
    for (let i = 0; i < 4; i++) {
      const sx = x - 8 + ((t * 37 + i * 7) % 16);
      const sy = 40 + ((t * 23 + i * 5) % 10);
      ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1);
    }
    ctx.fillStyle = '#ff9840';
    ctx.fillRect(x - 4, 44, 8, 3);
  }
}

/// QA scanner at the conveyor's left end.
function scanner(ctx: CanvasRenderingContext2D, t: number, working: boolean): void {
  const { x, y } = SCANNER;
  ctx.fillStyle = METAL;
  ctx.fillRect(x - 14, y - 14, 28, 8);
  ctx.fillRect(x - 14, y + 6, 28, 8);
  ctx.fillStyle = METAL_D;
  ctx.fillRect(x - 12, y - 6, 4, 12);
  ctx.fillRect(x + 8, y - 6, 4, 12);
  ctx.fillStyle = 'rgba(92,242,200,0.55)'; // neon scanner jaws
  ctx.fillRect(x - 14, y - 14, 28, 1);
  ctx.fillRect(x - 14, y + 13, 28, 1);
  if (working) {
    const sy = y - 6 + ((t * 30) % 12);
    ctx.fillStyle = 'rgba(120,230,250,0.35)';
    ctx.fillRect(x - 8, sy, 16, 2);
    ctx.fillStyle = 'rgba(160,240,255,0.8)';
    ctx.fillRect(x - 8, sy, 16, 1);
  }
}

/// Packing bench at the conveyor's right end.
function packStation(ctx: CanvasRenderingContext2D, working: boolean): void {
  const { x, y } = PACKER;
  ctx.fillStyle = METAL;
  ctx.fillRect(x - 14, y - 10, 28, 12);
  ctx.fillStyle = '#2c3f56';
  ctx.fillRect(x - 12, y - 8, 24, 3);
  ctx.fillStyle = 'rgba(255,184,74,0.5)'; // amber edge — shipping side
  ctx.fillRect(x - 14, y - 10, 28, 1);
  if (working) {
    ctx.drawImage(crateSprite(), x - 7, y - 24);
    ctx.fillStyle = AMBER;
    ctx.fillRect(x - 12, y - 12, 3, 2);
  }
}

function portal(ctx: CanvasRenderingContext2D, t: number): void {
  const { x, y } = PORTAL;
  const g = 0.6 + Math.sin(t * 4) * 0.4;
  ctx.fillStyle = `rgba(255,79,216,${0.14 + g * 0.12})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 13, 21, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255,79,216,${0.38 + g * 0.3})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 9, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255,220,250,${0.5 + g * 0.4})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 4, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8a80b0';
  ctx.fillRect(x - 12, y - 20, 24, 4);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x - 12, y - 19, (Math.floor(t * 8) % 6) * 4, 2);
}

// ---- conveyor items (tweened) -------------------------------------------------

export interface BeltItem {
  sku: string;
  x: number;
  y: number;
  alpha: number;
}

interface ConvEntry {
  x: number;
  target: number;
}
/// Live x positions, tweened each frame toward their queue slot.
const conv = new Map<string, ConvEntry>();
/// Recently-listed items sliding into the portal: sku → {x, at (animT)}.
const departing = new Map<string, { x: number; at: number }>();
/// Status seen last frame, to detect the conveyor→listed transition.
const prevStatus = new Map<string, string>();

/// Assets on the output line, FIFO: oldest closest to the packer.
function lineItems(assets: Asset[]): Asset[] {
  return assets
    .filter((a) => a.status === 'on_conveyor' || a.status === 'packing')
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/// Advance the tween state; returns drawable items (including departures).
export function conveyorItems(assets: Asset[], dt: number, t: number): BeltItem[] {
  const line = lineItems(assets);
  const n = line.length;
  line.forEach((a, i) => {
    const target = a.status === 'packing' ? PACKER.x : PACKER.x - (n - 1 - i) * ITEM_GAP;
    let e = conv.get(a.sku);
    if (!e) {
      e = { x: SCANNER.x, target };
      conv.set(a.sku, e);
    }
    e.target = target;
    e.x += (e.target - e.x) * Math.min(1, dt * 4);
  });
  // transitions out of the line
  for (const a of assets) {
    const was = prevStatus.get(a.sku);
    if ((was === 'on_conveyor' || was === 'packing') && a.status === 'listed' && conv.has(a.sku)) {
      departing.set(a.sku, { x: conv.get(a.sku)!.x, at: t });
    }
    prevStatus.set(a.sku, a.status);
  }
  for (const sku of [...conv.keys()]) {
    if (!line.some((a) => a.sku === sku)) conv.delete(sku);
  }
  const out: BeltItem[] = line.map((a) => ({ sku: a.sku, x: conv.get(a.sku)!.x, y: 230, alpha: 1 }));
  for (const [sku, d] of departing) {
    const p = (t - d.at) / 0.7;
    if (p >= 1.8) {
      departing.delete(sku);
      continue;
    }
    const x = d.x + (PORTAL.x - 2 - d.x) * Math.min(1, p);
    const alpha = p < 1 ? 1 : Math.max(0, 1 - (p - 1) / 0.8);
    out.push({ sku, x, y: 230, alpha });
  }
  return out;
}

/// Crate + asset sprite; sprite scale 1 for in-progress, 2 on the conveyor.
function drawCrate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  sku: string | null,
  assets: Asset[],
  t: number,
  scale = 2,
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(crateSprite(), Math.round(x - 7), Math.round(y - 11));
  if (sku) {
    const a = assets.find((v) => v.sku === sku);
    if (a) {
      const w = a.size * scale;
      drawAssetFrame(ctx, a, Math.round(x - w / 2), Math.round(y - 11 - w + 4), scale, t);
      if (a.kind === 'pack') drawPackBadge(ctx, a.items ?? 1, Math.round(x + w / 2 + 4), Math.round(y - 11));
    }
  }
  ctx.restore();
}

/// In-progress crates parked at their station (forge bench / scanner mouth).
export function workCrates(assets: Asset[]): { sku: string; x: number; y: number }[] {
  const out: { sku: string; x: number; y: number }[] = [];
  for (const a of assets) {
    if (a.status === 'inspecting') {
      out.push({ sku: a.sku, x: SCANNER.x, y: SCANNER.y + 4 });
    } else if (a.status === 'forging' && a.assignedTo?.startsWith('smith-')) {
      const n = Number(a.assignedTo.slice(6)) || 1;
      out.push({ sku: a.sku, x: 100 + n * 70 - 7, y: 62 });
    }
  }
  return out;
}

// ---- main draw ---------------------------------------------------------------

export interface FloorView {
  assets: Asset[];
  market: MarketState;
  smithCount: number;
  workingAgents: Set<string>;
  overlordThinking: boolean;
  pendingProposals: number;
  scanning: boolean;
  dt: number;
}

export function drawFloor(ctx: CanvasRenderingContext2D, t: number, v: FloorView): void {
  tiles(ctx);
  wallsAndPipes(ctx, t);
  belt(ctx, 8, BELT_Y, PORTAL.x, t);
  dais(ctx, t, v.overlordThinking, v.pendingProposals);
  radar(ctx, t, v.scanning);
  for (let i = 1; i <= v.smithCount; i++) {
    assembler(ctx, 100 + i * 70, t, v.workingAgents.has(`smith-${i}`));
  }
  scanner(ctx, t, v.workingAgents.has('inspector'));
  packStation(ctx, v.workingAgents.has('packer'));
  portal(ctx, t);
  for (const c of workCrates(v.assets)) drawCrate(ctx, c.x, c.y, c.sku, v.assets, t, 1);
  for (const it of conveyorItems(v.assets, v.dt, t)) {
    drawCrate(ctx, it.x, it.y, it.sku, v.assets, t, 2, it.alpha);
  }
}

// ---- hit testing --------------------------------------------------------------

export interface Hit {
  type: 'agent' | 'overlord' | 'asset' | 'portal' | 'trends';
  id: string;
}

/// pad multiplies every hit radius — touch taps get pad>1 when the canvas
/// is displayed below 2x so alien/item targets stay tappable.
export function hitTest(
  mx: number,
  my: number,
  v: FloorView,
  t: number,
  alienPos: Map<string, { x: number; y: number }>,
  pad = 1,
): Hit | null {
  for (const it of conveyorItems(v.assets, 0, t)) {
    if (Math.abs(mx - it.x) < 12 * pad && Math.abs(my - (it.y - 12)) < 16 * pad) return { type: 'asset', id: it.sku };
  }
  for (const c of workCrates(v.assets)) {
    if (Math.abs(mx - c.x) < 10 * pad && Math.abs(my - (c.y - 8)) < 14 * pad) return { type: 'asset', id: c.sku };
  }
  if (Math.hypot(mx - PORTAL.x, my - PORTAL.y) < 16 * pad) return { type: 'portal', id: 'portal' };
  if (Math.hypot(mx - DAIS.x, my - DAIS.y) < (DAIS.r + 8) * pad) return { type: 'overlord', id: 'overlord' };
  for (const [id, p] of alienPos) {
    if (Math.abs(mx - p.x) < 9 * pad && my > p.y - 16 * pad && my < p.y + 4 * pad) {
      return { type: id === 'overlord' ? 'overlord' : 'agent', id };
    }
  }
  // the scout's radar dish → trends drawer (aliens take precedence above)
  const rx = 16 * pad;
  if (mx > 56 - rx && mx < 56 + rx && my > 88 - rx && my < 88 + rx) return { type: 'trends', id: 'trends' };
  return null;
}
