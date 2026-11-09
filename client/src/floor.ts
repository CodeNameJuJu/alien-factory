// The factory floor: dark metal tiles, wall pipes, the Overlord's dais,
// worker stations and the output conveyor (inspector drops on the left,
// packer ships into the portal on the right).
import type { Asset, MarketState } from '../../shared/protocol';
import { crateSprite } from './sprites';
import { renderVolume, type Prim, type Mat } from './volume';
import { drawAssetFrame, drawPackBadge } from './assets';

export const W = 640;
export const H = 360;

export const DAIS = { x: 320, y: 188, r: 38 };
export const BELT_Y = 316;
export const PORTAL = { x: 614, y: BELT_Y };
/// QA scanner at the left end of the conveyor — items enter the line here.
export const SCANNER = { x: 150, y: 288 };
/// Packer station at the right end, just before the portal.
export const PACKER = { x: 560, y: 288 };
const ITEM_GAP = 34;

/// Idle anchor for each agent (station floor spot).
export interface Station {
  id: string;
  x: number;
  y: number;
}

export function stations(smithCount: number): Station[] {
  const out: Station[] = [
    { id: 'overlord', x: DAIS.x, y: DAIS.y + 6 },
    { id: 'scout', x: 78, y: 150 },
    { id: 'inspector', x: 158, y: 262 },
    { id: 'merchandiser', x: 452, y: 262 },
    { id: 'packer', x: 560, y: 262 },
  ];
  for (let i = 1; i <= smithCount; i++) {
    out.push({ id: `smith-${i}`, x: 120 + i * 100, y: 110 });
  }
  return out;
}

// ---- floor chrome -----------------------------------------------------------

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const mulberrySeed = (seed: number) => {
  let x = seed | 0;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---- static prerender: space viewport + hull floor ------------------------

/// 70px space band: seeded starfield, dithered nebula, dying planet.
function prerenderSpace(g: CanvasRenderingContext2D): void {
  const r = mulberrySeed(9021);
  g.fillStyle = '#030207';
  g.fillRect(0, 0, W, 48);
  // dithered nebula blobs — ordered Bayer falloff, never gradients
  const neb = (cx: number, cy: number, rad: number, lo: string, mid: string, hi: string) => {
    for (let y = -rad; y <= rad; y++) {
      for (let x = -rad * 2; x <= rad * 2; x++) {
        const d = Math.sqrt((x / 1.6) ** 2 + y * y) / rad;
        if (d > 1) continue;
        const t = BAYER[(y + cy) & 3][(x + cx) & 3] / 16;
        if (d < 0.18 + t * 0.1) g.fillStyle = hi;
        else if (d < 0.42 + t * 0.18) g.fillStyle = mid;
        else if (d < 0.6 + t * 0.2) g.fillStyle = lo;
        else continue;
        g.fillRect(cx + x, cy + y, 1, 1);
      }
    }
  };
  // one continuous nebula across the full 640px width — wide, low wisps
  // that span strut gaps, not one bright blob per panel
  neb(140, 20, 95, '#2a1530', '#2a1530', '#4a2552');
  neb(330, 30, 80, '#1a5c0a', '#1f2a17', '#3b4f25');
  neb(520, 22, 85, '#1f2a17', '#2a1530', '#4a2552');
  neb(640, 34, 70, '#1a5c0a', '#1f2a17', '#2a1530');
  // dim the band: space reads mostly black, nebula stays a wisp
  g.fillStyle = 'rgba(7,6,10,0.45)';
  g.fillRect(0, 0, W, 48);
  // dying planet ~60px across: shaded sphere + sickly terminator
  const px = 500, py = 24, pr = 20;
  for (let y = -pr; y <= pr; y++) for (let x = -pr; x <= pr; x++) {
    const d = Math.sqrt(x * x + y * y);
    if (d > pr) continue;
    const light = (-x - y) / (pr * 2); // lit top-left
    if (x > pr * 0.4 && d > pr * 0.62) g.fillStyle = '#8dff3a'; // sickly terminator
    else if (light > 0.55) g.fillStyle = '#9a5aa0';
    else if (light > 0.05) g.fillStyle = '#6e3a78'; // dominant lit tone
    else g.fillStyle = '#4a2552';
    if (r() < 0.08) g.fillStyle = '#c4182a'; // surface wounds
    g.fillRect(px + x, py + y, 1, 1);
  }
  // starfield: 1px in 3 brightnesses + a few 2x2 bright ones
  const shades = ['#3d4655', '#6e3a78', '#a69a80', '#d8ffa0'];
  for (let i = 0; i < 160; i++) {
    const x = Math.floor(r() * W), y = Math.floor(r() * 44);
    g.fillStyle = shades[Math.floor(r() * 3)];
    g.fillRect(x, y, 1, 1);
  }
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(r() * (W - 2)), y = Math.floor(r() * 42);
    g.fillStyle = '#d8ffa0';
    g.fillRect(x, y, 2, 2);
  }
  // back-wall machinery silhouettes under the viewport: pipe runs, tanks,
  // vents, cable bundles in hull-steel so the edges aren't empty
  g.fillStyle = '#14181f';
  g.fillRect(0, 48, W, 14);
  for (let x = 8; x < W - 20; x += 64) {
    g.fillStyle = '#1a1f29';
    g.fillRect(x, 50, 40, 12);
    g.fillStyle = '#242b38';
    g.fillRect(x, 50, 40, 2);
    g.fillStyle = '#0d1016';
    g.fillRect(x + 6, 54, 28, 3);
    // cable bundle
    g.strokeStyle = '#0e1117';
    g.lineWidth = 1;
    for (let c = 0; c < 3; c++) {
      g.beginPath();
      g.moveTo(x + 40, 52 + c * 3);
      g.quadraticCurveTo(x + 52, 50 + c * 3, x + 64, 54 + c * 3);
      g.stroke();
    }
  }
  // round tanks + vents as volume-rendered silhouettes
  g.fillStyle = '#1a1f29';
  for (const tx of [150, 470]) {
    g.fillRect(tx, 46, 18, 16);
    g.fillStyle = '#242b38';
    g.fillRect(tx, 46, 18, 2);
    g.fillStyle = '#3d4655';
    g.fillRect(tx + 7, 42, 4, 4);
    g.fillStyle = '#1a1f29';
  }
}

/// Hull plates ~64x48: dark seam + highlight seam, corner rivets, grime,
/// hazard stripes near stations and the conveyor.
function prerenderFloor(g: CanvasRenderingContext2D): void {
  const r = mulberrySeed(4242);
  g.fillStyle = '#080a0f';
  g.fillRect(0, 62, W, H - 62); // never overpaint the space viewport/wall
  for (let py = 62; py < H; py += 48) {
    for (let px = 0; px < W; px += 64) {
      const alt = ((px + py) / 32) % 2 === 0;
      g.fillStyle = alt ? '#0b0d13' : '#090b10';
      g.fillRect(px, py, 64, 48);
      // fainter seams — large darker plates
      g.fillStyle = 'rgba(7,6,10,0.7)';
      g.fillRect(px, py, 64, 1);
      g.fillRect(px, py, 1, 48);
      g.fillStyle = 'rgba(42,49,61,0.4)';
      g.fillRect(px, py + 47, 64, 1);
      // grime speckle only
      for (let i = 0; i < 6; i++) {
        g.fillStyle = r() > 0.5 ? 'rgba(26,31,41,0.6)' : 'rgba(58,5,8,0.3)';
        g.fillRect(px + 4 + Math.floor(r() * 56), py + 4 + Math.floor(r() * 40), 1 + Math.floor(r() * 3), 1);
      }
    }
  }
  // raised walkway / grate along the walk aisle (y≈248-272)
  g.fillStyle = '#11141c';
  g.fillRect(0, 246, W, 26);
  g.fillStyle = '#0a0d13';
  for (let x = 0; x < W; x += 10) g.fillRect(x, 246, 4, 26);
  g.fillStyle = 'rgba(42,49,61,0.5)';
  g.fillRect(0, 246, W, 1);
  g.fillRect(0, 271, W, 1);
  // blood: seeded splatter decals around forge row, press and arch — dark
  // red dithered irregular splats (never discs), footprint trail on the
  // walkway, smears on conveyor slats
  const splat = (sx: number, sy: number, sz: number) => {
    for (let i = 0; i < sz * 9; i++) {
      const a = r() * Math.PI * 2, dd = r() * sz;
      const x2 = sx + Math.cos(a) * dd, y2 = sy + Math.sin(a) * dd * 0.5;
      const c2 = r();
      g.fillStyle = c2 < 0.55 ? '#3a0508' : c2 < 0.85 ? '#7a0d14' : '#c4182a';
      g.fillRect(x2, y2, r() < 0.3 ? 2 : 1, 1);
    }
    // a few spatter outliers
    for (let i = 0; i < sz; i++) {
      g.fillStyle = '#3a0508';
      g.fillRect(sx + (r() - 0.5) * sz * 3, sy + (r() - 0.5) * sz * 1.6, 1, 1);
    }
  };
  for (let i = 1; i <= 3; i++) splat(120 + i * 100 - 20, 138 + r() * 10, 6); // forges
  splat(SCANNER.x, SCANNER.y + 24, 6);   // inspection arch
  splat(PACKER.x, PACKER.y + 26, 6);     // press
  splat(DAIS.x - 30, DAIS.y + 40, 5);
  // bloody footprints trailing along the walkway
  for (let i = 0; i < 9; i++) {
    const fx = 90 + i * 52 + r() * 10;
    const fy = 252 + (i % 2) * 10;
    g.fillStyle = i % 3 ? '#3a0508' : '#7a0d14';
    g.fillRect(fx, fy, 4, 2);
    g.fillRect(fx + 1, fy + 2, 3, 1);
  }
  // smears on the conveyor edge
  for (let i = 0; i < 5; i++) {
    const mx = 150 + r() * 420;
    g.fillStyle = '#3a0508';
    for (let k = 0; k < 6; k++) g.fillRect(mx + k * 3, BELT_Y - 4 - r() * 3, 3, 1);
  }
  // hazard stripes ONLY at conveyor edge, throne rim and portal mouth
  const stripe = (x0: number, y0: number, w: number) => {
    for (let d = 0; d < w; d += 10) {
      g.fillStyle = d % 20 === 0 ? '#8a5a24' : '#07060a';
      for (let yy = 0; yy < 4; yy++) g.fillRect(x0 + d + yy * 2, y0 + yy, 6, 1);
    }
  };
  stripe(130, 326, 484);         // conveyor edge
  stripe(DAIS.x - 70, DAIS.y + 34, 140); // throne platform rim
  stripe(PORTAL.x - 30, BELT_Y - 26, 60); // portal mouth
}

// ---- volume-rendered station sprites (cached) --------------------------------

const stationCache = new Map<string, HTMLCanvasElement>();
function stationSprite(key: string, w: number, h: number, prims: Prim[]): HTMLCanvasElement {
  const hit = stationCache.get(key);
  if (hit) return hit;
  const { data } = renderVolume(w, h, prims, 11);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  img.data.set(data);
  g.putImageData(img, 0, 0);
  stationCache.set(key, c);
  return c;
}
const ell2 = (c: [number, number, number], r: [number, number, number], mat: Mat, part: number, surf?: 'speckle' | 'vein' | 'brain'): Prim =>
  ({ kind: 'ell', c, r, mat, part, surf });
const cap2 = (a: [number, number, number], b: [number, number, number], ra: number, rb: number, mat: Mat, part: number): Prim =>
  ({ kind: 'cap', a, b, ra, rb, mat, part });

/// Dev guard: viewport coverage stats — the lead's check that the nebula
/// and planet actually render. Returns counts in the 70px band.
export function viewportStats(): { nebula: number; planet: number; band: number } {
  const c = staticLayer;
  if (!c) return { nebula: 0, planet: 0, band: 0 };
  const g = c.getContext('2d')!;
  const img = g.getImageData(0, 0, W, 48).data;
  const targets = [[74, 37, 82], [110, 58, 120], [26, 92, 10], [59, 79, 37], [95, 122, 53]];
  let nebula = 0, planet = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = targets.some((t2) => Math.abs(img[i] - t2[0]) < 30 && Math.abs(img[i + 1] - t2[1]) < 30 && Math.abs(img[i + 2] - t2[2]) < 30);
    if (d) {
      nebula++;
      if ((x - 500) ** 2 + (y - 24) ** 2 < 22 * 22) planet++;
    }
  }
  return { nebula, planet, band: W * 48 };
}

let staticLayer: HTMLCanvasElement | null = null;
function staticFloor(ctx: CanvasRenderingContext2D): void {
  if (!staticLayer) {
    staticLayer = document.createElement('canvas');
    staticLayer.width = W;
    staticLayer.height = H;
    const g = staticLayer.getContext('2d')!;
    prerenderSpace(g);
    prerenderFloor(g);
  }
  ctx.drawImage(staticLayer, 0, 0);
}

// ---- animated overlays ----------------------------------------------------

/// Biomass: grows ONLY from walls, corners and pipe joints. Irregular
/// dithered flesh-ramp shapes with short floor tendrils + pulsing pustules.
const BIO: { x: number; y: number; r: number; p: number; dir: -1 | 1 }[] = (() => {
  const r = mulberrySeed(777);
  const out: { x: number; y: number; r: number; p: number; dir: -1 | 1 }[] = [];
  // along the machinery wall below the viewport
  for (let i = 0; i < 7; i++) out.push({ x: 30 + r() * (W - 60), y: 58, r: 6 + r() * 10, p: r() * 6.28, dir: 1 });
  // left and right wall edges
  for (let i = 0; i < 4; i++) out.push({ x: 8, y: 80 + r() * 220, r: 5 + r() * 9, p: r() * 6.28, dir: 1 });
  for (let i = 0; i < 4; i++) out.push({ x: W - 8, y: 80 + r() * 220, r: 5 + r() * 9, p: r() * 6.28, dir: -1 });
  return out;
})();

/// Biomass cluster: 6-15 small shaded ellipsoid nodules hugging a wall
/// point + tendril capsules onto the floor. Seeded shape per cluster.
function biomass(ctx: CanvasRenderingContext2D, t: number): void {
  const r2 = mulberrySeed(31337);
  for (const b of BIO) {
    const n = 6 + Math.floor(r2() * 9);
    for (let i = 0; i < n; i++) {
      // cluster of small nodules anchored at the wall edge
      const nx = b.x + (r2() - 0.5) * b.r * 1.6;
      const ny = b.y + r2() * b.r * 0.9;
      const nr = 2 + r2() * (b.r * 0.45);
      const shade = r2();
      ctx.fillStyle = shade < 0.3 ? '#1f2a17' : shade < 0.7 ? '#3b4f25' : '#5f7a35';
      ctx.beginPath();
      ctx.ellipse(nx, ny, nr, nr * (0.6 + r2() * 0.5), 0, 0, Math.PI * 2);
      ctx.fill();
      // highlight nub
      if (nr > 4) {
        ctx.fillStyle = 'rgba(138,168,74,0.6)';
        ctx.fillRect(nx - nr / 3, ny - nr / 3, Math.max(1, nr / 3), Math.max(1, nr / 4));
      }
    }
    // tendrils onto the floor — short tapered strokes
    for (let i = 0; i < 3; i++) {
      const tx = b.x + (r2() - 0.5) * b.r;
      const len = b.r * (0.7 + r2() * 0.8);
      ctx.strokeStyle = '#3b4f25';
      ctx.lineWidth = 2.5 - i * 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, b.y);
      ctx.quadraticCurveTo(tx + Math.sin(i * 2 + b.p) * 8, b.y + len * 0.5, tx + Math.sin(i * 3 + b.p) * 12, b.y + len);
      ctx.stroke();
    }
    // emissive pustules pulsing (3x3 acid)
    const on = Math.sin(t * 2.4 + b.p) > 0.45;
    ctx.fillStyle = on ? '#8dff3a' : '#1a5c0a';
    for (let i = 0; i < 2 + Math.floor(r2() * 2); i++) {
      ctx.fillRect(Math.floor(b.x + (r2() - 0.5) * b.r * 1.2), Math.floor(b.y + r2() * b.r * 0.6), 3, 3);
    }
  }
}

/// Thick hull framing around the viewport + struts + warning beacons.
function hullFrame(ctx: CanvasRenderingContext2D, t: number): void {
  // struts drawn ON TOP of the continuous viewport
  ctx.fillStyle = '#1a1f29';
  ctx.fillRect(0, 0, W, 3);
  ctx.fillRect(0, 46, W, 3);
  for (let x = 0; x < W; x += 128) {
    ctx.fillRect(x, 0, 6, 48);
    ctx.fillStyle = '#2a313d';
    ctx.fillRect(x + 1, 3, 2, 43);
    ctx.fillStyle = '#1a1f29';
  }
  // blood-red rotating warning beacons
  for (const bx of [120, 320, 520]) {
    const on = Math.sin(t * 3 + bx) > 0;
    ctx.fillStyle = '#3a0508';
    ctx.fillRect(bx - 4, 40, 8, 6);
    ctx.fillStyle = on ? '#ff3b4a' : '#7a0d14';
    ctx.fillRect(bx - 2, 42, 4, 3);
    if (on) {
      ctx.fillStyle = 'rgba(255,59,74,0.3)';
      ctx.fillRect(bx - 7, 38, 14, 10);
    }
  }
  // twinkle overlay: ~8 stars blink in the viewport
  const tr = mulberrySeed(31);
  for (let i = 0; i < 8; i++) {
    const x = Math.floor(tr() * W), y = Math.floor(tr() * 44);
    if (Math.sin(t * 2 + tr() * 10) > 0.5) {
      ctx.fillStyle = '#d8ffa0';
      ctx.fillRect(x, y, 2, 2);
    }
  }
}

function belt(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, t: number): void {
  ctx.fillStyle = '#1a1f29';
  ctx.fillRect(x0, y0 - 10, x1 - x0, 20);
  ctx.fillStyle = '#07060a';
  ctx.fillRect(x0, y0 - 10, x1 - x0, 2);
  ctx.fillRect(x0, y0 + 8, x1 - x0, 2);
  // ribbed slats — part-organic
  const off = Math.floor(t * 40) % 20;
  ctx.fillStyle = '#2a313d';
  for (let d = -20 + off; d < x1 - x0; d += 20) ctx.fillRect(x0 + d, y0 - 8, 3, 16);
  ctx.fillStyle = '#3b4f25';
  for (let d = -14 + off; d < x1 - x0; d += 60) ctx.fillRect(x0 + d, y0 - 6, 6, 12);
  // edge veins
  ctx.fillStyle = '#1a5c0a';
  ctx.fillRect(x0, y0 - 12, x1 - x0, 2);
}

function dais(ctx: CanvasRenderingContext2D, t: number, thinking: boolean, pending: number): void {
  const { x, y, r } = DAIS;
  // meaty throne: shaded flesh mound rendered once via the volume rasteriser
  const mound = stationSprite('dais', 150, 56, [
    ell2([75, 32, 4], [62, 17, 10], 'bruise', 1, 'speckle'),
    ell2([46, 40, 3], [28, 12, 7], 'bruise', 1, 'speckle'),
    ell2([104, 40, 3], [28, 12, 7], 'bruise', 1, 'speckle'),
    ell2([75, 44, 2], [40, 10, 5], 'bruise', 1, 'vein'),
    ell2([75, 24, 6], [44, 11, 8], 'bruise', 2, 'speckle'),
  ]);
  ctx.drawImage(mound, x - 75, y - 22);
  // cables + tubes running out to the floor edges
  const rnd = mulberrySeed(5);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI + 0.2;
    const x1 = x + Math.cos(a) * r * 1.05, y1 = y + Math.sin(a) * r * 0.5;
    const x2 = x + Math.cos(a) * (r + 44 + rnd() * 30), y2 = y + Math.sin(a) * (r + 22) * 0.55;
    ctx.strokeStyle = i % 3 === 0 ? '#1a5c0a' : i % 3 === 1 ? '#1a1f29' : '#3a0508';
    ctx.lineWidth = 3 + (i % 2);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo((x1 + x2) / 2, y1 + 14, x2, y2);
    ctx.stroke();
    // tube highlight
    if (i % 3 === 0) {
      ctx.strokeStyle = 'rgba(141,255,58,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1 - 1);
      ctx.quadraticCurveTo((x1 + x2) / 2, y1 + 13, x2, y2 - 1);
      ctx.stroke();
    }
  }
  // dashed acid rings
  const pulse = 0.3 + Math.sin(t * 3) * 0.25;
  ctx.strokeStyle = `rgba(141,255,58,${pulse})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 7]);
  ctx.lineDashOffset = -t * 20;
  ctx.beginPath();
  ctx.ellipse(x, y, r + 2, r * 0.5 + 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = `rgba(141,255,58,${pulse * 0.4})`;
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.ellipse(x, y, r - 18, r * 0.5 - 14, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  if (thinking) {
    // holo panel floats to the right of the brain — above it collides with
    // the smith row and the Overlord's nameplate
    const hx = x + 96;
    const hy = y - 44 + Math.sin(t * 2) * 2;
    ctx.fillStyle = 'rgba(26,92,10,0.3)';
    ctx.fillRect(hx - 32, hy, 64, 26);
    ctx.strokeStyle = 'rgba(141,255,58,0.7)';
    ctx.strokeRect(hx - 32.5, hy - 0.5, 65, 27);
    ctx.fillStyle = 'rgba(216,255,160,0.85)';
    for (let i = 0; i < 6; i++) {
      const hgt = 3 + Math.abs(Math.sin(t * 5 + i * 1.7)) * 16;
      ctx.fillRect(hx - 27 + i * 10, hy + 22 - hgt, 5, hgt);
    }
    if (pending > 0) {
      ctx.fillStyle = '#d8ffa0';
      ctx.font = '8px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${pending} proposal${pending === 1 ? '' : 's'}`, hx, hy - 6);
    }
  }
}

/// Long-range scanner array by the viewport: capsule mast + ellipsoid dish.
function radar(ctx: CanvasRenderingContext2D, t: number, scanning: boolean): void {
  const x = 78, y = 150;
  const a = t * (scanning ? 6 : 1.4);
  const dx = Math.cos(a) * 10, dy = Math.sin(a) * 4;
  const array = stationSprite('radar', 80, 60, [
    cap2([40, 58, 3], [40, 22, 3], 5, 3.5, 'steel', 1),
    ell2([40, 20, 5], [16, 9, 5], 'steel', 2),
    ell2([40, 20, 8], [8, 4, 3], 'bruise', 2),
    ell2([40, 20, 11], [2.5, 2, 1.5], 'acid', 2),
    ell2([40, 56, 4], [14, 5, 3], 'steel', 1),
    ell2([26, 54, 5], [2, 2, 1.5], 'acid', 1),
  ]);
  ctx.save();
  ctx.translate(x - 40 + dx, y - 58 + dy);
  ctx.drawImage(array, 0, 0);
  ctx.restore();
  if (scanning && Math.floor(t * 3) % 2 === 0) {
    ctx.fillStyle = 'rgba(141,255,58,0.9)';
    ctx.font = '12px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SCANNING', x, y - 56);
  }
}

/// Forge: volume-rendered crucible vat on legs + steel console, the
/// emissive acid liquid surface + drips animate on top.
function assembler(ctx: CanvasRenderingContext2D, x: number, t: number, working: boolean): void {
  const forge = stationSprite('forge', 80, 70, [
    cap2([18, 44, 2], [14, 66, 2], 4, 3, 'steel', 1),
    cap2([62, 44, 2], [66, 66, 2], 4, 3, 'steel', 2),
    ell2([40, 30, 4], [26, 18, 9], 'steel', 3, 'speckle'),
    ell2([40, 22, 6], [20, 10, 7], 'socket', 3),
    ell2([40, 20, 7], [16, 7, 5], 'acid', 3),
    cap2([66, 18, 2], [72, 4, 2], 3, 2.4, 'steel', 4), // console mast
    ell2([72, 6, 4], [6, 4, 3], 'steel', 4),
    ell2([72, 6, 7], [3, 2, 1.5], 'acid', 4),
  ]);
  ctx.drawImage(forge, x - 40, 60);
  const g = 0.5 + Math.sin(t * 4) * 0.3;
  ctx.fillStyle = `rgba(141,255,58,${0.3 + g * 0.4})`;
  ctx.fillRect(x - 14, 82, 28, 6);
  // drips over the vat lip
  ctx.fillStyle = `rgba(141,255,58,${0.5 + g * 0.4})`;
  for (let i = 0; i < 3; i++) {
    const dy = (t * 30 + i * 17) % 14;
    ctx.fillRect(x - 16 + i * 14, 96 + dy, 2, 3);
  }
  if (working) {
    ctx.fillStyle = '#c08a3a';
    for (let i = 0; i < 6; i++) {
      const sx = x - 16 + ((t * 74 + i * 14) % 32);
      const sy = 76 + ((t * 46 + i * 10) % 26);
      ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
    }
  }
}

/// QA scanning arch over the conveyor mouth: capsule pillars + top beam.
function scanner(ctx: CanvasRenderingContext2D, t: number, working: boolean): void {
  const { x, y } = SCANNER;
  const arch = stationSprite('scanner', 80, 70, [
    cap2([14, 10, 3], [14, 66, 3], 7, 5, 'steel', 1),
    cap2([66, 10, 3], [66, 66, 3], 7, 5, 'steel', 2),
    cap2([10, 8, 4], [70, 8, 4], 6, 6, 'steel', 3),
    ell2([14, 62, 4], [8, 6, 4], 'steel', 1),
    ell2([66, 62, 4], [8, 6, 4], 'steel', 2),
    ell2([40, 6, 7], [10, 3, 2], 'brass', 3),
    ell2([20, 8, 8], [1.6, 1.6, 1], 'acid', 3),
    ell2([60, 8, 8], [1.6, 1.6, 1], 'acid', 3),
  ]);
  ctx.drawImage(arch, x - 40, y - 36);
  if (working) {
    const sy = y - 14 + ((t * 60) % 26);
    ctx.fillStyle = 'rgba(141,255,58,0.4)';
    ctx.fillRect(x - 18, sy, 36, 5);
    ctx.fillStyle = 'rgba(216,255,160,0.8)';
    ctx.fillRect(x - 18, sy, 36, 2);
  }
}

/// Market oracle: steel pedestal + floating holo-cone + brass ticker.
function merchandiserStation(ctx: CanvasRenderingContext2D, t: number, working: boolean): void {
  const x = 452, y = 296;
  const oracle = stationSprite('oracle', 80, 80, [
    cap2([40, 76, 3], [40, 50, 3], 9, 6, 'steel', 1),
    ell2([40, 48, 4], [16, 6, 5], 'steel', 1),
    ell2([40, 74, 5], [12, 4, 3], 'brass', 1),
  ]);
  ctx.drawImage(oracle, x - 40, y - 76);
  // floating holo cone — translucent so it never fights the dais
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#3fbf1a';
  ctx.beginPath();
  ctx.moveTo(x - 10, y - 40);
  ctx.lineTo(x + 10, y - 40);
  ctx.lineTo(x + 3, y - 68);
  ctx.lineTo(x - 3, y - 68);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8dff3a';
  ctx.fillRect(x - 3, y - 72, 6, 5);
  ctx.globalAlpha = 1;
  // brass ticker in a bezel under the cone
  ctx.fillStyle = '#07060a';
  ctx.fillRect(x - 26, y - 30, 52, 16);
  ctx.fillStyle = 'rgba(192,138,58,0.6)';
  ctx.fillRect(x - 26, y - 30, 52, 2);
  ctx.fillRect(x - 26, y - 16, 52, 2);
  const px = '3.50 4.99 2.25 6.40 3.00 5.75 4.20 3.99 ';
  ctx.fillStyle = '#c08a3a';
  ctx.font = '11px "Courier New", monospace';
  ctx.textAlign = 'left';
  const off = Math.floor(t * 30) % (px.length * 7);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 26, y - 30, 52, 16);
  ctx.clip();
  ctx.fillText(px + px, x - 26 - off, y - 18);
  ctx.restore();
  if (working) {
    ctx.fillStyle = 'rgba(141,255,58,0.3)';
    ctx.fillRect(x - 40, y - 76, 80, 60);
  }
}

/// Packing press: steel block + piston capsule beside the warp portal.
function packStation(ctx: CanvasRenderingContext2D, working: boolean): void {
  const { x, y } = PACKER;
  const press = stationSprite('press', 70, 50, [
    cap2([12, 24, 3], [58, 24, 3], 12, 12, 'steel', 1),
    cap2([35, 4, 4], [35, 20, 4], 5, 4, 'steel', 2), // piston
    ell2([35, 24, 6], [8, 5, 3], 'socket', 2),
    ell2([35, 24, 8], [5, 3, 2], 'brass', 2),
  ]);
  ctx.drawImage(press, x - 35, y - 26);
  if (working) {
    ctx.drawImage(crateSprite(), x - 14, y - 46);
    ctx.fillStyle = '#c08a3a';
    ctx.fillRect(x - 26, y - 28, 6, 4);
  }
}

/// Swirling acid-green warp portal.
function portal(ctx: CanvasRenderingContext2D, t: number): void {
  const { x, y } = PORTAL;
  const g = 0.6 + Math.sin(t * 4) * 0.4;
  ctx.fillStyle = `rgba(63,191,26,${0.14 + g * 0.12})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 30, 48, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(141,255,58,${0.38 + g * 0.3})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 20, 36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(216,255,160,${0.5 + g * 0.4})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 10, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  const a = t * 2.5;
  ctx.strokeStyle = `rgba(141,255,58,${0.3 + g * 0.3})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(x, y, 26, 44, a * 0.2, a, a + 1.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x, y, 26, 44, a * 0.2, a + 2.4, a + 3.8);
  ctx.stroke();
  ctx.fillStyle = '#3d4655';
  ctx.fillRect(x - 28, y - 46, 56, 8);
  ctx.fillStyle = '#8dff3a';
  ctx.fillRect(x - 28, y - 44, (Math.floor(t * 16) % 14) * 4, 4);
}

// ---- lighting ------------------------------------------------------------------

/// Pre-rendered quantised light discs (radius, colour) — Bayer-dithered
/// hard bands, no gradients. Cache by key.
const discCache = new Map<string, HTMLCanvasElement>();
function lightDisc(radius: number, color: string): HTMLCanvasElement {
  const key = `${radius}:${color}`;
  const hit = discCache.get(key);
  if (hit) return hit;
  const d = radius * 2;
  const c = document.createElement('canvas');
  c.width = d; c.height = d;
  const g = c.getContext('2d')!;
  const img = g.createImageData(d, d);
  // hard bands + a ~6px Bayer-dithered transition at each edge — no rings
  const edges = [1, 0.72, 0.45, 0.22];
  const alphas = [0.6, 0.4, 0.22, 0.1];
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    const px = Math.sqrt((x - radius) ** 2 + (y - radius) ** 2);
    if (px > radius) continue;
    const dist = px / radius;
    let bi = edges.findIndex((e) => dist < e);
    if (bi < 0) continue;
    // dither the choice near the band edge (~6px zone)
    const nearEdge = bi > 0 && dist > edges[bi] - 6 / radius && dist < edges[bi - 1];
    if (nearEdge && bi < alphas.length - 1) {
      if (BAYER[y & 3][x & 3] / 16 < (dist - (edges[bi] - 6 / radius)) / (6 / radius) * 2) bi++;
    }
    const i = (y * d + x) * 4;
    img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = Math.round(alphas[Math.min(bi, alphas.length - 1)] * 255);
  }
  g.putImageData(img, 0, 0);
  discCache.set(key, c);
  return c;
}
const tintCache = new Map<string, HTMLCanvasElement>();
function tintDisc(radius: number, rgb: [number, number, number]): HTMLCanvasElement {
  const key = `${radius}:t`;
  const hit = tintCache.get(key);
  if (hit) return hit;
  const d = radius * 2;
  const c = document.createElement('canvas');
  c.width = d; c.height = d;
  const g = c.getContext('2d')!;
  const img = g.createImageData(d, d);
  // colour cast only — ~0.12 alpha at the core, gone by 40% of the radius
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    const px = Math.sqrt((x - radius) ** 2 + (y - radius) ** 2);
    const dist = px / radius;
    if (dist > 0.4) continue;
    const t2 = BAYER[y & 3][x & 3] / 16;
    const a = dist < 0.2 ? 0.14 : dist < 0.4 - t2 * 0.08 ? 0.07 : 0;
    if (!a) continue;
    const i = (y * d + x) * 4;
    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  tintCache.set(key, c);
  return c;
}

export interface Light { x: number; y: number; r: number; rgb: [number, number, number]; flicker?: number }

/// The factory's light sources for this frame.
export function lightSources(t: number, v: { overlordThinking: boolean; scanning: boolean; smithCount: number; workingAgents: Set<string> }): Light[] {
  const out: Light[] = [];
  // forges flicker acid
  for (let i = 1; i <= v.smithCount; i++) {
    out.push({ x: 120 + i * 100 - 20, y: 96, r: 60, rgb: [63, 191, 26], flicker: 0.08 * Math.sin(t * 9 + i * 3) });
  }
  // throne: violet, acid pulse when thinking
  out.push({ x: DAIS.x, y: DAIS.y - 10, r: 105, rgb: v.overlordThinking ? [63, 191, 26] : [110, 58, 120], flicker: 0.05 * Math.sin(t * 2) });
  // portal
  out.push({ x: PORTAL.x, y: PORTAL.y, r: 80, rgb: [63, 191, 26], flicker: 0.1 * Math.sin(t * 3) });
  // oracle holo
  out.push({ x: 452, y: 250, r: 48, rgb: [63, 191, 26] });
  // scanner arch sweeps
  out.push({ x: SCANNER.x, y: SCANNER.y, r: 44, rgb: [63, 191, 26], flicker: v.scanning ? 0.15 * Math.sin(t * 8) : 0 });
  // beacons: small blood pulses at the lamps, never big discs
  for (const bx of [120, 320, 520]) {
    if (Math.sin(t * 3 + bx) > 0.3) out.push({ x: bx, y: 46, r: 24, rgb: [196, 24, 42] });
  }
  // viewport cool violet wash
  out.push({ x: 320, y: 60, r: 240, rgb: [60, 40, 90] });
  return out;
}

/// Wear layer: fresh splats appear near finished-job stations, density
/// grows with jobs done this shift, capped ~60 then the oldest fade.
export function wearDecals(ctx: CanvasRenderingContext2D, jobsDone: number, t: number): void {
  const r = mulberrySeed(777);
  const n = Math.min(60, jobsDone);
  for (let i = 0; i < n; i++) {
    const station = [140, 240, 340, SCANNER.x, PACKER.x, DAIS.x][i % 6];
    const sx = station + (r() - 0.5) * 40;
    const sy = 130 + r() * 170;
    const age = jobsDone - i; // older splats fade
    const a = Math.min(0.8, Math.max(0.15, 1 - age / 60));
    ctx.fillStyle = age < 8 ? `rgba(196,24,42,${a})` : `rgba(122,13,20,${a})`;
    for (let k = 0; k < 4; k++) ctx.fillRect(sx + k * 2, sy + ((r() * 4) | 0), 2, 1);
    void t;
  }
}

let darkLayer: HTMLCanvasElement | null = null;
/// Darkness + tinted light + emissive pass. Called AFTER the world is drawn.
export function applyLighting(ctx: CanvasRenderingContext2D, t: number, lights: Light[], dim?: { x: number; y: number }[]): void {
  if (!darkLayer) {
    darkLayer = document.createElement('canvas');
    darkLayer.width = W; darkLayer.height = H;
  }
  const d = darkLayer.getContext('2d')!;
  d.globalCompositeOperation = 'source-over';
  d.fillStyle = 'rgba(7,6,10,0.70)';
  d.fillRect(0, 49, W, H - 49); // the viewport band is NEVER darkened — space lights the room
  // weak global ambient cut so the floor stays faintly readable
  d.globalCompositeOperation = 'destination-out';
  d.fillStyle = 'rgba(255,255,255,0.15)';
  d.fillRect(0, 49, W, H - 49);
  // cut light holes out of the darkness
  for (const l of lights) {
    const r = Math.max(8, l.r * (1 + (l.flicker ?? 0)));
    d.drawImage(lightDisc(Math.round(r), '#fff'), l.x - r, l.y - r, r * 2, r * 2);
  }
  // per-alien ambient: NEUTRAL, dim cut ~35%, r22
  d.globalAlpha = 0.4;
  for (const a of dim ?? []) d.drawImage(lightDisc(22, '#fff'), a.x - 22, a.y - 22, 44, 44);
  d.globalAlpha = 1;
  ctx.drawImage(darkLayer, 0, 0);
  // coloured tint pass — additive, low alpha
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const l of lights) {
    const r = Math.max(8, l.r * 0.7 * (1 + (l.flicker ?? 0)));
    ctx.drawImage(tintDisc(Math.round(r), l.rgb), l.x - r, l.y - r, r * 2, r * 2);
  }
  ctx.restore();
}

/// Emissive hotspots redrawn OVER the lighting layer — vat liquid, scan
/// beam, pustules, beacon lamps, portal core, oracle holo.
export function floorEmissives(ctx: CanvasRenderingContext2D, t: number, v: { scanning: boolean; smithCount: number; workingAgents: Set<string> }): void {
  for (let i = 1; i <= v.smithCount; i++) {
    const x = 120 + i * 100 - 20;
    ctx.fillStyle = 'rgba(141,255,58,0.8)';
    ctx.fillRect(x - 12, 78, 24, 4);
    ctx.fillStyle = 'rgba(216,255,160,0.9)';
    ctx.fillRect(x - 8, 80, 16, 3);
  }
  if (v.scanning) {
    const sy = SCANNER.y - 14 + ((t * 60) % 26);
    ctx.fillStyle = 'rgba(216,255,160,0.9)';
    ctx.fillRect(SCANNER.x - 18, sy, 36, 2);
  }
  // pustules
  const r2 = mulberrySeed(31337);
  for (const b of BIO) {
    void r2;
    if (Math.sin(t * 2.4 + b.p) > 0.45) {
      ctx.fillStyle = '#8dff3a';
      ctx.fillRect(Math.floor(b.x), Math.floor(b.y + b.r * 0.3), 3, 3);
    }
  }
  // beacon lamps
  for (const bx of [120, 320, 520]) {
    if (Math.sin(t * 3 + bx) > 0.3) {
      ctx.fillStyle = '#ff3b4a';
      ctx.fillRect(bx - 2, 42, 4, 3);
    }
  }
  // portal core
  const g = 0.6 + Math.sin(t * 4) * 0.4;
  ctx.fillStyle = `rgba(216,255,160,${0.5 + g * 0.4})`;
  ctx.beginPath();
  ctx.ellipse(PORTAL.x, PORTAL.y, 8, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  // oracle holo tip
  ctx.fillStyle = 'rgba(141,255,58,0.8)';
  ctx.fillRect(449, 340 - 78, 6, 4);
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
  const out: BeltItem[] = line.map((a) => ({ sku: a.sku, x: conv.get(a.sku)!.x, y: 308, alpha: 1 }));
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
  ctx.drawImage(crateSprite(), Math.round(x - 12), Math.round(y - 18));
  if (sku) {
    const a = assets.find((v) => v.sku === sku);
    if (a) {
      const w = a.size * scale;
      drawAssetFrame(ctx, a, Math.round(x - w / 2), Math.round(y - 18 - w + 6), scale, t);
      if (a.kind === 'pack') drawPackBadge(ctx, a.items ?? 1, Math.round(x + w / 2 + 6), Math.round(y - 18));
    }
  }
  ctx.restore();
}

/// In-progress crates parked at their station (forge bench / scanner mouth).
export function workCrates(assets: Asset[]): { sku: string; x: number; y: number }[] {
  const out: { sku: string; x: number; y: number }[] = [];
  for (const a of assets) {
    if (a.status === 'inspecting') {
      out.push({ sku: a.sku, x: SCANNER.x, y: SCANNER.y + 6 });
    } else if (a.status === 'forging' && a.assignedTo?.startsWith('smith-')) {
      const n = Number(a.assignedTo.slice(6)) || 1;
      out.push({ sku: a.sku, x: 120 + n * 100 - 10, y: 106 });
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
  staticFloor(ctx);
  hullFrame(ctx, t);
  biomass(ctx, t);
  // floor pipes/cables physically linking every station to the line + throne
  ctx.strokeStyle = '#14181f';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(78, 164); ctx.lineTo(78, 246); ctx.stroke();        // scout → aisle
  ctx.beginPath(); ctx.moveTo(120, 130); ctx.lineTo(120, 246); ctx.stroke();      // forge row → aisle
  ctx.beginPath(); ctx.moveTo(220, 130); ctx.lineTo(220, 246); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(320, 130); ctx.lineTo(320, 246); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(DAIS.x, DAIS.y + 40); ctx.lineTo(DAIS.x, BELT_Y - 8); ctx.stroke(); // throne → conveyor
  ctx.strokeStyle = '#1a5c0a';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(452, 300); ctx.lineTo(452, BELT_Y - 8); ctx.stroke(); // oracle feed
  ctx.strokeStyle = '#14181f'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(560, 296); ctx.lineTo(560, BELT_Y - 8); ctx.stroke(); // press feed
  belt(ctx, 16, BELT_Y, PORTAL.x, t);
  dais(ctx, t, v.overlordThinking, v.pendingProposals);
  radar(ctx, t, v.scanning);
  for (let i = 1; i <= v.smithCount; i++) {
    assembler(ctx, 200 + i * 140, t, v.workingAgents.has(`smith-${i}`));
  }
  scanner(ctx, t, v.workingAgents.has('inspector'));
  merchandiserStation(ctx, t, v.workingAgents.has('merchandiser'));
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
    if (Math.abs(mx - it.x) < 16 * pad && Math.abs(my - (it.y - 16)) < 22 * pad) return { type: 'asset', id: it.sku };
  }
  for (const c of workCrates(v.assets)) {
    if (Math.abs(mx - c.x) < 14 * pad && Math.abs(my - (c.y - 10)) < 18 * pad) return { type: 'asset', id: c.sku };
  }
  if (Math.hypot(mx - PORTAL.x, my - PORTAL.y) < 22 * pad) return { type: 'portal', id: 'portal' };
  if (Math.hypot(mx - DAIS.x, my - DAIS.y) < (DAIS.r + 8) * pad) return { type: 'overlord', id: 'overlord' };
  for (const [id, p] of alienPos) {
    if (Math.abs(mx - p.x) < 12 * pad && my > p.y - 22 * pad && my < p.y + 6 * pad) {
      return { type: id === 'overlord' ? 'overlord' : 'agent', id };
    }
  }
  // the scout's radar dish → trends drawer (aliens take precedence above)
  const rx = 22 * pad;
  if (mx > 78 - rx && mx < 78 + rx && my > 128 - rx && my < 128 + rx) return { type: 'trends', id: 'trends' };
  return null;
}
