// Volume renderer quantised to the palette — replaces flat-rect sprites.
// A sprite is a list of shaded primitives (ellipsoids, capsules) with
// z-depth; each pixel picks the front-most surface, shades it against a
// top-left light, quantises onto the material's 4-5 tone ramp with a Bayer
// nudge, then outlines the silhouette and parts.
import { mulberry32, type RGB } from './pix';

export type Mat = 'bruise' | 'sick' | 'pale' | 'steel' | 'acid' | 'blood' | 'bone' | 'brass' | 'socket' | 'milk' | 'dark';

export interface Ellipsoid {
  kind: 'ell';
  c: [number, number, number]; // cx cy cz
  r: [number, number, number]; // rx ry rz
  mat: Mat;
  part: number;
  /// organic detail: 'brain' gets the folded-ridge normal field
  surf?: 'speckle' | 'vein' | 'brain' | 'none';
}
export interface Capsule {
  kind: 'cap';
  a: [number, number, number];
  b: [number, number, number];
  ra: number; // radius at a
  rb: number; // radius at b — taper
  mat: Mat;
  part: number;
  surf?: 'speckle' | 'vein' | 'none';
}
export type Prim = Ellipsoid | Capsule;

export const RAMPS: Record<Mat, RGB[]> = {
  bruise: [[42, 21, 48], [74, 37, 82], [110, 58, 120], [154, 90, 160], [197, 143, 196]],
  sick: [[31, 42, 23], [59, 79, 37], [95, 122, 53], [138, 168, 74]],
  pale: [[52, 42, 44], [86, 66, 72], [122, 96, 104], [160, 132, 140]],
  steel: [[14, 17, 23], [26, 31, 41], [42, 49, 61], [61, 70, 85], [90, 100, 117]],
  acid: [[26, 92, 10], [63, 191, 26], [141, 255, 58], [216, 255, 160]],
  blood: [[58, 5, 8], [122, 13, 20], [196, 24, 42], [255, 59, 74]],
  bone: [[107, 97, 82], [166, 154, 128], [216, 206, 178]],
  brass: [[90, 58, 26], [138, 90, 36], [192, 138, 58]],
  socket: [[12, 7, 14]],
  milk: [[178, 188, 196]],
  dark: [[7, 6, 10]],
};
const OUT: RGB = [7, 6, 10];
const EMISSIVE = new Set<Mat>(['acid']);
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

// ---- raster ---------------------------------------------------------------------

interface Buf {
  depth: Float32Array;
  part: Int16Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  prim: Int16Array;
}

function closestSeg(px: number, py: number, a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return [a[0] + dx * t, a[1] + dy * t];
}

function cover(buf: Buf, w: number, h: number, prims: Prim[]): void {
  for (let pi = 0; pi < prims.length; pi++) {
    const p = prims[pi];
    if (p.kind === 'ell') {
      const [cx, cy, cz] = p.c, [rx, ry, rz] = p.r;
      for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(h - 1, Math.ceil(cy + ry)); y++) {
        for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(w - 1, Math.ceil(cx + rx)); x++) {
          const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
          const d2 = nx * nx + ny * ny;
          if (d2 > 1) continue;
          const nzN = Math.sqrt(1 - d2);
          const depth = cz + nzN * rz;
          const i = y * w + x;
          if (buf.part[i] >= 0 && buf.depth[i] >= depth) continue;
          buf.part[i] = p.part;
          buf.prim[i] = pi;
          buf.depth[i] = depth;
          // ellipsoid normal (object space → world)
          const gx = nx / rx, gy = ny / ry, gz = nzN / rz;
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
          let nxx = gx / gl, nyy = gy / gl, nzz = gz / gl;
          if (p.surf === 'brain') {
            // folded ridge field — reveals gyri in the shading
            const ridge = Math.abs(Math.sin(x * 0.55 + 2.2 * Math.sin(y * 0.28)) * Math.cos(y * 0.42));
            nxx = Math.max(-1, Math.min(1, nxx + ridge * 0.55));
            nyy = Math.max(-1, Math.min(1, nyy + (ridge - 0.5) * 0.4));
            const rl = Math.sqrt(nxx * nxx + nyy * nyy + nzz * nzz) || 1;
            nxx /= rl; nyy /= rl; nzz /= rl;
          }
          buf.nx[i] = nxx; buf.ny[i] = nyy; buf.nz[i] = nzz;
        }
      }
    } else {
      // capsule: closest point on the 2D segment, interpolated radius
      const [ax, ay, az] = p.a, [bx, by, bz] = p.b;
      const rmax = Math.max(p.ra, p.rb);
      const minx = Math.max(0, Math.floor(Math.min(ax, bx) - rmax)), maxx = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + rmax));
      const miny = Math.max(0, Math.floor(Math.min(ay, by) - rmax)), maxy = Math.min(h - 1, Math.ceil(Math.max(ay, by) + rmax));
      for (let y = miny; y <= maxy; y++) {
        for (let x = minx; x <= maxx; x++) {
          const [qx, qy] = closestSeg(x + 0.5, y + 0.5, [ax, ay], [bx, by]);
          const t = ((x + 0.5 - ax) * (bx - ax) + (y + 0.5 - ay) * (by - ay)) / (((bx - ax) ** 2 + (by - ay) ** 2) || 1);
          const tc = Math.max(0, Math.min(1, t));
          const r = p.ra + (p.rb - p.ra) * tc;
          const dx = x + 0.5 - qx, dy = y + 0.5 - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r * r) continue;
          const nzN = Math.sqrt(1 - d2 / (r * r));
          const z = az + (bz - az) * tc;
          const depth = z + nzN * r;
          const i = y * w + x;
          if (buf.part[i] >= 0 && buf.depth[i] >= depth) continue;
          buf.part[i] = p.part;
          buf.prim[i] = pi;
          buf.depth[i] = depth;
          const gl = Math.sqrt(d2 + nzN * nzN * r * r) || 1;
          buf.nx[i] = dx / (r || 1); buf.ny[i] = dy / (r || 1); buf.nz[i] = nzN;
        }
      }
    }
  }
}

// ---- render ---------------------------------------------------------------------

const LX = -0.55, LY = -0.7, LZ = 0.45;
const Ln = Math.sqrt(LX * LX + LY * LY + LZ * LZ);
const L: [number, number, number] = [LX / Ln, LY / Ln, LZ / Ln];
const Hv: [number, number, number] = [LX / (Ln + LZ), LY / (Ln + LZ), (LZ + 1) / (Ln + LZ)]; // approx half vector
const TONES = [0.30, 0.52, 0.74, 0.90];

/// Render primitives into a fresh RGBA buffer (w×h). `seed` drives speckle
/// + vein detail deterministically.
export function renderVolume(w: number, h: number, prims: Prim[], seed = 1, rim?: RGB): { data: Uint8ClampedArray; buf: Buf } {
  const buf: Buf = {
    depth: new Float32Array(w * h),
    part: new Int16Array(w * h).fill(-1),
    nx: new Float32Array(w * h),
    ny: new Float32Array(w * h),
    nz: new Float32Array(w * h),
    prim: new Int16Array(w * h).fill(-1),
  };
  cover(buf, w, h, prims);
  const rnd = mulberry32(seed * 2654435761);
  const data = new Uint8ClampedArray(w * h * 4);
  const px = (x: number, y: number, c: RGB, a = 255): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = a;
  };
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : buf.part[y * w + x]);

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (buf.part[i] < 0) continue;
    const p = prims[buf.prim[i]];
    const ramp = RAMPS[p.mat];
    if (EMISSIVE.has(p.mat)) {
      px(x, y, ramp[2]);
      continue;
    }
    const nl = buf.nx[i] * L[0] + buf.ny[i] * L[1] + buf.nz[i] * L[2];
    let v = 0.15 + 0.85 * Math.max(0, nl);
    // Bayer nudge so band edges dither
    v += ((BAYER[y & 3][x & 3] / 16) - 0.5) * 0.08;
    // specular on steel/glow-ish materials
    const nh = buf.nx[i] * Hv[0] + buf.ny[i] * Hv[1] + buf.nz[i] * Hv[2];
    let tone = 0;
    for (const t of TONES) if (v > t) tone++;
    tone = Math.min(ramp.length - 1, tone);
    if (nh > 0.96 && (p.mat === 'steel' || p.mat === 'brass')) tone = ramp.length - 1;
    let c = ramp[Math.max(0, tone)];
    // organic detail: seeded speckle ±1 tone, vein walk
    if (p.surf === 'speckle' || p.surf === 'vein' || p.surf === 'brain') {
      const s = Math.abs(Math.sin((x * 127.1 + y * 311.7 + seed * 17.3)) * 43758.5) % 1;
      if (s < 0.02) c = ramp[Math.min(ramp.length - 1, Math.max(0, tone + (s < 0.01 ? 1 : -1)))];
      if ((p.surf === 'vein' || p.surf === 'brain') && s > 0.97) c = ramp[1];
    }
    px(x, y, c);
  }
  // internal outlines: a part edge with a depth step > 2 gets the outline
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (buf.part[i] < 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = (y + dy) * w + x + dx;
      const ni = at(x + dx, y + dy);
      if (ni < 0) {
        // silhouette — handle below
      } else if (buf.part[j] !== buf.part[i] && buf.depth[i] + 2 < buf.depth[j]) {
        px(x, y, OUT);
        break;
      }
    }
  }
  // silhouette outline: empty neighbour of any filled pixel → outline
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (buf.part[i] >= 0) continue;
    if (at(x + 1, y) >= 0 || at(x - 1, y) >= 0 || at(x, y + 1) >= 0 || at(x, y - 1) >= 0) px(x, y, OUT);
  }
  // rim light: silhouette pixels whose UP or LEFT neighbour is empty get a
  // 1px light edge — keeps the dark creatures readable on the dark floor
  if (rim) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (buf.part[i] < 0) continue;
      const nl = buf.nx[i] * L[0] + buf.ny[i] * L[1] + buf.nz[i] * L[2];
      // back-rim only: silhouette edge where the surface faces away-ish
      if ((at(x, y - 1) < 0 || at(x - 1, y) < 0) && nl < 0.55) px(x, y, rim);
    }
  }
  // emissive halo: 1-2px alpha ring around acid pixels
  const halo: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (buf.part[i] >= 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = buf.part[(y + dy) * w + x + dx];
      const p = n >= 0 ? prims[buf.prim[(y + dy) * w + x + dx]] : null;
      if (p && EMISSIVE.has(p.mat)) { halo.push([x, y]); break; }
    }
  }
  for (const [x, y] of halo) px(x, y, RAMPS.acid[2], 90);
  return { data, buf };
}

/// Emissive-only pass: returns RGBA pixels for emissive materials + halo —
/// drawn AFTER the darkness layer so glows read on top.
export function renderEmissive(w: number, h: number, prims: Prim[], seed = 1): Uint8ClampedArray {
  const { buf } = renderVolume(w, h, prims, seed);
  const out = new Uint8ClampedArray(w * h * 4);
  const px = (x: number, y: number, c: RGB, a = 255): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = a;
  };
  // collect the emissive cores first — the halo MUST decay from this fixed
  // set; letting newly written halo pixels count cascades it across the
  // whole sprite
  const cores: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (buf.part[i] < 0) continue;
    const p = prims[buf.prim[i]];
    if (EMISSIVE.has(p.mat)) {
      px(x, y, RAMPS.acid[2]);
      cores.push([x, y]);
    }
  }
  // halo: distance-decayed alpha from the core set only
  const best = new Map<number, number>();
  for (const [ex, ey] of cores) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (dist === 0 || dist > 2) continue;
      const a = dist === 1 ? 90 : 45;
      const key = (ey + dy) * w + (ex + dx);
      if ((best.get(key) ?? 0) < a) best.set(key, a);
    }
  }
  for (const [key, a] of best) {
    const x = key % w, y = Math.floor(key / w);
    const i = (y * w + x) * 4;
    if (out[i + 3] === 0) px(x, y, RAMPS.acid[2], a);
  }
  return out;
}

/// Dev check: an emissive mask must be mostly transparent (≤15% filled),
/// or the draw ends up a green box over the sprite.
export function emissiveCoverage(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n / (data.length / 4);
}

// ---- ascii debug ----------------------------------------------------------------

const CHARS = ' .:;+*#%@';

/// Dump a rendered buffer as text — one char per pixel, ramp-position
/// mapped, so shapes are reviewable without an image viewer.
export function renderAscii(w: number, h: number, prims: Prim[], seed = 1): string {
  const { data } = renderVolume(w, h, prims, seed);
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) { row += ' '; continue; }
      const lum = (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) / 255;
      row += CHARS[Math.min(CHARS.length - 1, Math.floor(lum * CHARS.length))];
    }
    lines.push(row);
  }
  return lines.join('\n');
}
