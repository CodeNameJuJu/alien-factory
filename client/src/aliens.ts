// Cosmetic alien movement. Positions are purely client-side: idle wander
// near the station, walk to the dais when a job lands, back to work, then
// carry a crate down to the output belt.
import type { Agent } from '../../shared/protocol';
import { DAIS, SCANNER, PORTAL, stations, type Station } from './floor';
import { alienSprite, bubble, crateSprite, overlordSprite } from './sprites';
import { mulberry32, hashString } from './pix';

type Phase = 'idle' | 'toDais' | 'toStation' | 'work' | 'carry';

interface AlienView {
  id: string;
  x: number;
  y: number;
  path: { x: number; y: number }[];
  phase: Phase;
  lastJobId: string | null;
  wanderT: number;
  flip: boolean;
  carry: boolean;
}

const views = new Map<string, AlienView>();
const SPEED = 42;
const DAIS_MEET = { x: DAIS.x, y: DAIS.y + 34 };
/// Walk lane below the work row, above the conveyor.
const AISLE_Y = 190;

/// Where each kind drops its finished crate: smiths carry to the scanner at
/// the conveyor's left end, the inspector drops on the belt start, the
/// packer ships into the portal.
const DROP: Record<string, { x: number; y: number }> = {
  smith: { x: SCANNER.x, y: SCANNER.y - 6 },
  inspector: { x: SCANNER.x + 10, y: 224 },
  packer: { x: PORTAL.x - 14, y: 224 },
};

function routeTo(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  // waypoint route: down to the aisle, across, up to the target
  const path: { x: number; y: number }[] = [];
  if (Math.abs(from.y - to.y) < 12) return [to];
  path.push({ x: from.x, y: AISLE_Y });
  path.push({ x: to.x, y: AISLE_Y });
  path.push(to);
  return path;
}

function step(v: AlienView, dt: number): void {
  const target = v.path[0];
  if (!target) return;
  const dx = target.x - v.x;
  const dy = target.y - v.y;
  const d = Math.hypot(dx, dy);
  if (d < 2) {
    v.x = target.x;
    v.y = target.y;
    v.path.shift();
    return;
  }
  v.flip = dx < -0.5;
  if (Math.abs(dx) > 0.5) v.flip = dx < 0;
  v.x += (dx / d) * SPEED * dt;
  v.y += (dy / d) * SPEED * dt;
}

export function updateAliens(agents: Agent[], dt: number, t: number): Map<string, AlienView> {
  const st = stations(agents.filter((a) => a.kind === 'smith').length || 3);
  const stMap = new Map<string, Station>(st.map((s) => [s.id, s]));
  for (const a of agents) {
    if (a.kind === 'overlord') continue; // drawn on the dais by main
    let v = views.get(a.id);
    const home = stMap.get(a.id) ?? { id: a.id, x: 240, y: 200 };
    if (!v) {
      v = { id: a.id, x: home.x, y: home.y, path: [], phase: 'idle', lastJobId: null, wanderT: 0, flip: false, carry: false };
      views.set(a.id, v);
    }
    if (a.state === 'offline' || a.state === 'error') {
      v.phase = 'idle';
      v.path = [];
      v.lastJobId = a.currentJobId;
      continue;
    }
    if (a.currentJobId && a.currentJobId !== v.lastJobId) {
      // new job: walk to the dais for orders, then home to work
      v.phase = 'toDais';
      v.carry = false;
      v.path = routeTo(v, DAIS_MEET);
    } else if (!a.currentJobId && v.phase === 'work') {
      // job finished: carry the crate to this kind's drop point, then home
      v.phase = 'carry';
      v.carry = true;
      v.path = routeTo(v, DROP[a.kind] ?? home);
    }
    v.lastJobId = a.currentJobId;
    step(v, dt);
    if (v.phase === 'toDais' && !v.path.length) {
      v.phase = 'toStation';
      v.path = routeTo(v, home);
    } else if (v.phase === 'toStation' && !v.path.length) {
      v.phase = 'work';
    } else if (v.phase === 'carry' && !v.path.length) {
      v.carry = false;
      v.phase = 'idle';
      v.path = routeTo(v, home);
      v.phase = 'toStation'; // reuse walk-home
      // when it arrives with no job it stays idle (handled below)
    } else if (v.phase === 'toStation' && !v.path.length && !a.currentJobId) {
      v.phase = 'idle';
    }
    if (v.phase === 'idle' || (v.phase === 'toStation' && !v.path.length && !a.currentJobId)) {
      v.phase = 'idle';
      v.wanderT -= dt;
      if (v.wanderT <= 0 && !v.path.length) {
        const rnd = mulberry32(hashString(a.id + Math.floor(t * 0.5)));
        v.path = [{ x: home.x + (rnd() - 0.5) * 26, y: home.y + (rnd() - 0.5) * 10 }];
        v.wanderT = 1.5 + rnd() * 2.5;
      }
      step(v, dt);
    }
  }
  return views;
}

export function drawAliens(
  ctx: CanvasRenderingContext2D,
  agents: Agent[],
  views: Map<string, AlienView>,
  t: number,
  selected: string | null,
): void {
  for (const a of agents) {
    if (a.kind === 'overlord') continue;
    const v = views.get(a.id);
    if (!v) continue;
    const moving = v.path.length > 0;
    const frame = moving ? Math.floor(t * 8) % 2 : 0;
    const bob = a.state === 'working' && !moving ? Math.floor(t * 6) % 2 : frame;
    // shadow
    ctx.fillStyle = 'rgba(10,8,16,0.4)';
    ctx.beginPath();
    ctx.ellipse(v.x, v.y + 1, 6, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(alienSprite(a.name, a.kind, bob, v.flip), Math.round(v.x) - 6, Math.round(v.y) - 13);
    if (v.carry) ctx.drawImage(crateSprite(), Math.round(v.x) - 7, Math.round(v.y) - 24);
    if (a.state === 'error') ctx.drawImage(bubble('!'), Math.round(v.x) + 5, Math.round(v.y) - 22);
    else if (a.state === 'offline') ctx.drawImage(bubble('z'), Math.round(v.x) + 5, Math.round(v.y) - 22);
    else if (a.state === 'working') ctx.drawImage(bubble('work'), Math.round(v.x) + 5, Math.round(v.y) - 22);
    if (selected === a.id) selectionRing(ctx, v.x, v.y, t);
  }
}

export function drawOverlord(
  ctx: CanvasRenderingContext2D,
  overlord: Agent | undefined,
  t: number,
  selected: string | null,
): void {
  const thinking = overlord?.state === 'working';
  const sway = t;
  ctx.fillStyle = 'rgba(10,8,16,0.4)';
  ctx.beginPath();
  ctx.ellipse(DAIS.x, DAIS.y + 2, 18, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(overlordSprite(sway, thinking), DAIS.x - 15, DAIS.y - 26);
  if (overlord?.state === 'error') ctx.drawImage(bubble('!'), DAIS.x + 14, DAIS.y - 30);
  else if (overlord?.state === 'offline') ctx.drawImage(bubble('z'), DAIS.x + 14, DAIS.y - 30);
  if (selected === 'overlord') selectionRing(ctx, DAIS.x, DAIS.y, t, 24);
}

/// Pulsing RTS selection brackets.
export function selectionRing(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, r = 10): void {
  const p = 1 + Math.sin(t * 6) * 0.5;
  const rr = r + p;
  ctx.strokeStyle = '#e8d060';
  ctx.lineWidth = 1;
  const c = rr * 0.5;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + sx * rr, y + sy * rr - sy * c);
    ctx.lineTo(x + sx * rr, y + sy * rr);
    ctx.lineTo(x + sx * rr - sx * c, y + sy * rr);
    ctx.stroke();
  }
}
