// Volume renderer quantised to the palette — replaces flat-rect sprites.
// A sprite is a list of shaded primitives (ellipsoids, capsules) with
// z-depth; each pixel picks the front-most surface, shades it against a
// top-left light, quantises onto the material's 4-5 tone ramp with a Bayer
// nudge, then outlines the silhouette and parts.
import { mulberry32, type RGB } from './pix';

export type Mat = 'bruise' | 'sick' | 'pale' | 'steel' | 'acid' | 'blood' | 'bone' | 'brass' | 'socket' | 'milk' | 'dark' | 'spec' | 'teal' | 'bog' | 'magenta' | 'eel';

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
  /// hue-shifted flesh ramps: shadows run to plum, lights to yellow-green/teal
  teal: [[40, 25, 45], [57, 44, 79], [34, 83, 83], [64, 144, 124], [168, 240, 192]],
  bog: [[40, 23, 38], [68, 44, 54], [63, 96, 43], [110, 158, 62], [216, 240, 128]],
  magenta: [[31, 18, 35], [68, 35, 68], [122, 50, 97], [172, 92, 130], [240, 160, 192]],
  eel: [[23, 23, 41], [38, 49, 82], [46, 95, 123], [75, 156, 172], [176, 240, 240]],
  spec: [[240, 240, 224]],
};
const OUT: RGB = [20, 10, 20]; // dark plum, not pure black
/// each flesh gets a partner ramp — ~20% of the surface renders in it
const SECONDARY: Partial<Record<Mat, Mat>> = { teal: 'magenta', bog: 'magenta', magenta: 'teal', eel: 'magenta' };
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
            // meandering gyri: creases at zero-crossings of 2-octave value
            // noise; normals bend toward the crease gradient → winding folds
            const gnoise = (xx: number, yy: number) =>
              Math.abs(Math.sin(xx * 127.1 + yy * 311.7) * 43758.5453) % 1;
            const f2 = (xx: number, yy: number, per: number, o: number) => {
              const gx = xx / per, gy = yy / per;
              const ix = Math.floor(gx), iy = Math.floor(gy);
              const fx = gx - ix, fy = gy - iy;
              const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
              const h2 = (a2: number, b2: number) => {
                const hh = Math.imul(a2 * 374761393 + b2 * 668265263 + o * 1442695041, 0x9e3779b1) ^ 0x85ebca6b;
                return ((hh ^ (hh >>> 13)) >>> 0) / 4294967296;
              };
              const n00 = h2(ix, iy), n10 = h2(ix + 1, iy), n01 = h2(ix, iy + 1), n11 = h2(ix + 1, iy + 1);
              return n00 + (n10 - n00) * sx + (n01 - n00) * sy + (n00 - n10 - n01 + n11) * sx * sy;
            };
            const fld = (xx: number, yy: number) => f2(xx, yy, 10, 5) * 0.6 + f2(xx, yy, 5, 6) * 0.4 - 0.5;
            const nval = fld(x, y);
            const gxv = fld(x + 1, y) - nval, gyv = fld(x, y + 1) - nval;
            const crease = Math.abs(nval) < 0.04 ? 1 : Math.abs(nval) < 0.10 ? 0.4 : 0;
            nxx = Math.max(-1, Math.min(1, nxx + gxv * 6 + crease * 0.3));
            nyy = Math.max(-1, Math.min(1, nyy + gyv * 6 + crease * 0.2));
            nzz = Math.max(-0.5, nzz - crease * 0.45); // creases recess into shadow
            const rl = Math.sqrt(nxx * nxx + nyy * nyy + nzz * nzz) || 1;
            nxx /= rl; nyy /= rl; nzz /= rl;
            void gnoise;
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
const HX = L[0], HY = L[1], HZ = L[2] + 1;
const Hn = Math.sqrt(HX * HX + HY * HY + HZ * HZ);
const Hv: [number, number, number] = [HX / Hn, HY / Hn, HZ / Hn];

/// Render primitives into a fresh RGBA buffer (w×h). `seed` drives speckle
/// + vein detail deterministically.
export function renderVolume(w: number, h: number, prims: Prim[], seed = 1, rim?: RGB, hist?: number[]): { data: Uint8ClampedArray; buf: Buf } {
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
  /// seeded value noise, bilinear, period `per` px — for mottling + hue patches
  const latt = (ix: number, iy: number, o: number) => {
    const h2 = Math.imul(ix * 374761393 + iy * 668265263 + o * 1442695041, 0x9e3779b1) ^ 0x85ebca6b;
    return ((h2 ^ (h2 >>> 13)) >>> 0) / 4294967296;
  };
  const vnoise = (x: number, y: number, per: number, o: number) => {
    const gx = x / per, gy = y / per;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = latt(ix, iy, o), b = latt(ix + 1, iy, o), c2 = latt(ix, iy + 1, o), d2 = latt(ix + 1, iy + 1, o);
    return a + (b - a) * sx + (c2 - a) * sy + (a - b - c2 + d2) * sx * sy;
  };
  const mottle = (x: number, y: number) => vnoise(x, y, 4.5, 1) * 0.65 + vnoise(x, y, 8, 2) * 0.35;
  const huef = (x: number, y: number) => vnoise(x, y, 4, 3) * 0.65 + vnoise(x, y, 8, 4) * 0.35;
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
    // ambient occlusion: darker toward the bottom and where covered
    const bottomness = Math.pow(y / h, 1.5);
    let occl = 0;
    for (const [dx, dy] of [[2,0],[-2,0],[0,2],[0,-2],[2,2],[-2,2],[2,-2],[-2,-2]]) {
      const j = (y + dy) * w + x + dx;
      if (x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h || buf.part[j] < 0) continue;
      if (buf.depth[j] > buf.depth[i] + 0.5 || buf.part[j] !== buf.part[i]) occl++;
    }
    const ao = Math.max(0, 1 - 0.10 * bottomness - 0.18 * (occl / 8));
    let v = Math.max(0, nl) * ao;
    v += ((BAYER[y & 3][x & 3] / 16) - 0.5) * 0.06;
    const nh = buf.nx[i] * Hv[0] + buf.ny[i] * Hv[1] + buf.nz[i] * Hv[2];
    const isFlesh = ['bruise','sick','pale','teal','bog','magenta','eel','blood'].includes(p.mat);
    // 5-tone map: light only on top-left; tone4 is SPECULAR ONLY
    let tone = v < 0.10 ? 0 : v < 0.24 ? 1 : v < 0.50 ? 2 : v < 0.62 ? 3 : 3;
    // crevice: outline-adjacent pixels on the shadow side → tone0
    if (nl < 0.3 && at(x + 1, y) < 0 && at(x, y + 1) < 0) tone = 0;
    if (nh > 0.96) tone = ramp.length - 1;           // wet gloss
    else if (nh > 0.96 && (p.mat === 'steel' || p.mat === 'brass')) tone = ramp.length - 1;
    if (isFlesh && p.surf === 'speckle' && nh > 0.88) {
      const sd = Math.abs(Math.sin((x * 39.3 + y * 61.7 + seed * 11.1)) * 24634.63) % 1;
      if (sd < 0.022) tone = ramp.length - 1;
    }
    // mottling: subtle grime — -1 tone within the same ramp on ~12%
    if (isFlesh && tone > 0 && tone < ramp.length - 1 && mottle(x, y) < 0.12) tone--;
    // light-driven hue shift: shadow tones read plum/magenta, mids/highs
    // stay the body ramp; ≤6% small blotches use the partner ramp midtones
    let ramp2 = ramp;
    if (isFlesh && SECONDARY[p.mat]) {
      if (tone <= 1) ramp2 = RAMPS[SECONDARY[p.mat]!];
      else if (huef(x, y) > 0.94) ramp2 = RAMPS[SECONDARY[p.mat]!];
    }
    let c = ramp2[Math.min(ramp2.length - 1, Math.max(0, tone))];
    if (hist && isFlesh) hist[Math.min(4, Math.max(0, tone))]++;
    // organic detail: seeded speckle ±1 tone, vein walk
    if (p.surf === 'speckle' || p.surf === 'vein' || p.surf === 'brain') {
      const s = Math.abs(Math.sin((x * 127.1 + y * 311.7 + seed * 17.3)) * 43758.5) % 1;
      if (s < 0.02) c = ramp2[Math.min(ramp2.length - 1, Math.max(0, tone + (s < 0.01 ? 1 : -1)))];
      if ((p.surf === 'vein' || p.surf === 'brain') && s > 0.97) c = ramp2[1];
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
