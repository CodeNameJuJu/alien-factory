// Mangled pixel sprites — Biohazard horror cast, built as shaded primitive
// volumes (ellipsoids + tapered capsules) rasterised by volume.ts and
// quantised onto the biohazard palette. Each role's anatomy is a function
// of (params, pose): params come from the seeded rng (the mangling), pose
// drives the animation frames. Flesh ramps swap per skin; small detail
// grids are only used for eyes/teeth-sized features.
import { Sprite, mulberry32, hashString, type RGB } from './pix';
import type { AgentKind } from '../../shared/protocol';
import { renderVolume, renderAscii, renderEmissive, emissiveCoverage, type Prim, type Mat, RAMPS } from './volume';

type V3 = [number, number, number];
const ell = (c: V3, r: V3, mat: Mat, part: number, surf?: 'speckle' | 'vein' | 'brain' | 'none'): Prim => ({ kind: 'ell', c, r, mat, part, surf });
const cap = (a: V3, b: V3, ra: number, rb: number, mat: Mat, part: number): Prim => ({ kind: 'cap', a, b, ra, rb, mat, part, surf: 'speckle' });

// ---- seeded mangling ---------------------------------------------------------------

interface Params {
  skin: Mat;
  thickL: number; thickR: number;
  hunch: number;
  tumor: [number, number, number] | null;
  eyes: number;
  hornL: boolean; hornR: boolean;
  jaw: 'teeth' | 'stitch';
}
function params(name: string): Params {
  const r = mulberry32(hashString(name));
  const skins: Mat[] = ['bruise', 'sick', 'pale'];
  return {
    skin: skins[Math.floor(r() * skins.length)],
    thickL: 0.8 + r() * 0.45,
    thickR: 0.8 + r() * 0.45,
    hunch: r() * 3,
    tumor: r() < 0.5 ? [6 + r() * 20, 4 + r() * 10, 0.8 + r() * 1.6] : null,
    eyes: 1 + Math.floor(r() * 3), // 1-3 eyes
    hornL: r() < 0.4, hornR: r() < 0.4,
    jaw: r() < 0.6 ? 'teeth' : 'stitch',
  };
}

// ---- worker anatomy: ~36x44, chunky brute -----------------------------------------
// part ids: 1 head, 2 torso, 3 armL, 4 armR, 5 legL, 6 legR, 7 accessory, 8+ gear

interface Geo {
  headW: number; headY: number;   // head radius + height
  torsoW: number; torsoY: number; // torso mass
  armT: number;                   // arm thickness
  legY: number;                   // hip height
  tall: number;                   // vertical stretch (scout)
  wide: number;                   // horizontal stretch (merch)
}
const GEO: Record<string, Geo> = {
  smith:        { headW: 7.5, headY: 9,  torsoW: 10, torsoY: 24, armT: 2.4, legY: 34, tall: 0, wide: 0 },
  scout:        { headW: 6,   headY: 10, torsoW: 7,  torsoY: 26, armT: 1.7, legY: 34, tall: -4, wide: 0 },
  inspector:    { headW: 7,   headY: 9,  torsoW: 9,  torsoY: 24, armT: 1.9, legY: 34, tall: 0, wide: 0 },
  packer:       { headW: 7,   headY: 9,  torsoW: 10, torsoY: 24, armT: 3.0, legY: 34, tall: 0, wide: 0 },
  merchandiser: { headW: 8.5, headY: 10, torsoW: 12, torsoY: 25, armT: 2.4, legY: 35, tall: 0, wide: 3 },
};

/// Prominent face: socket + 3x2 emissive eye + brow, plus a gash mouth with
/// teeth or stitches. Called inside workerPrims for the head mass.
function face(prims: Prim[], hx: number, hy: number, hw: number, kind: AgentKind, p: Params, frame: number): void {
  // eye sockets + glowing cores — asymmetric heights read as mangled
  const spots = p.eyes === 1 ? [[hx, 0]] : p.eyes === 2 ? [[hx - 3, 0], [hx + 3, -0.7]] : [[hx - 4, 0], [hx, -1], [hx + 4, 0.5]];
  for (const [ex, dy] of spots) {
    prims.push(ell([ex, hy - 1 + dy, 8.5], [2.3, 1.9, 1.4], 'socket', 1));
    prims.push(ell([ex, hy - 1 + dy, 9.5], [1.5, 1.2, 1.1], 'acid', 1));
  }
  // mouth: a dark gash, then teeth or stitches
  prims.push(ell([hx, hy + 5.5, 7.5], [hw - 2, 1.6, 1.2], 'socket', 1));
  if (kind === 'packer' || p.jaw === 'stitch') {
    for (let i = 0; i < 5; i++) prims.push(ell([hx - 4 + i * 2, hy + 5.5, 9], [0.45, 1.4, 0.7], 'dark', 1));
  } else {
    for (let i = 0; i < 4; i++) prims.push(ell([hx - 4.5 + i * 3, hy + 5.5, 8.5], [0.9, 1.1, 0.8], kind === 'merchandiser' && i % 2 ? 'brass' : 'bone', 1));
  }
}

function workerPrims(kind: AgentKind, p: Params, frame: number): Prim[] {
  const g = GEO[kind] ?? GEO.smith;
  const bob = frame % 2;
  const walk = frame % 4;
  const sw = walk === 1 ? 2 : walk === 3 ? -2 : 0;
  const work = frame >= 2 ? 1 : 0;
  const h = p.hunch;
  const skin = p.skin;
  const cx = 18;
  const prims: Prim[] = [];
  // legs: thigh + shin + foot, opposite swing
  prims.push(
    cap([cx - 5 + sw, g.legY, 2], [cx - 4 + sw * 1.5, 41, 2], 2.6, 2.0, skin, 5),
    cap([cx + 4 - sw, g.legY, 2], [cx + 3 - sw * 1.5, 41, 2], 2.6, 2.0, skin, 6),
    ell([cx - 4 + sw * 1.5, 42, 3], [3.4, 1.6, 2], 'steel', 5),
    ell([cx + 3 - sw * 1.5, 42, 3], [3.4, 1.6, 2], 'steel', 6),
  );
  // torso barrel + abdomen + shoulders (3/4 hunch: head pushed forward)
  prims.push(
    ell([cx + h * 0.5, g.torsoY + bob * 0.5, 4], [g.torsoW + g.wide * 0.5, 8, 6], skin, 2, 'speckle'),
    ell([cx + h * 0.4, g.torsoY + 6 + bob * 0.5, 3], [g.torsoW - 1 + g.wide, 6, 4.5], skin, 2, 'speckle'),
    ell([cx - g.torsoW - 1 + h * 0.6, g.torsoY - 1 + bob, 3.5], [3.6, 4.2, 3.4], skin, 2, 'speckle'),
    ell([cx + g.torsoW + 1 + h * 0.6, g.torsoY - 1 + bob, 3.5], [3.6, 4.2, 3.4], skin, 2, 'speckle'),
  );
  // elbows-bent arms hanging past the hips (packer holds a crate instead)
  const asw = frame % 2 ? 1.2 : -1.2;
  const elbL: V3 = [cx - g.torsoW - 4 - asw * 0.3, g.torsoY + 7 + bob, 4];
  const elbR: V3 = [cx + g.torsoW + 4 + asw * 0.3, g.torsoY + 7 + bob, 4];
  prims.push(
    cap([cx - g.torsoW - 1 + h * 0.5, g.torsoY - 1 + bob, 4], elbL, g.armT, g.armT * 0.85, skin, 3),
    cap(elbL, [elbL[0] + 2 - asw, g.torsoY + 14 + bob, 4], g.armT * 0.85, g.armT * 0.65, skin, 3),
    ell([elbL[0] + 2.5 - asw, g.torsoY + 15.5 + bob, 4], [2 * p.thickL, 1.8, 1.8], 'bone', 3),
    cap([cx + g.torsoW + 1 + h * 0.5, g.torsoY - 1 + bob, 4], elbR, g.armT * (kind === 'smith' ? 2 : 1), g.armT * 0.85 * (kind === 'smith' ? 1.6 : 1), skin, 4),
    cap(elbR, [elbR[0] - 2 + asw, g.torsoY + 14 + bob, 4], g.armT * 0.85 * (kind === 'smith' ? 1.5 : 1), g.armT * 0.65, skin, 4),
    ell([elbR[0] - 2.5 + asw, g.torsoY + 15.5 + bob, 4], [2 * p.thickR, 1.8, 1.8], 'bone', 4),
  );
  // head — bigger, tilted forward
  const hx = cx + 2 + h * 0.8, hy = g.headY + h * 0.4 + bob * 0.5;
  prims.push(
    ell([hx, hy, 6], [g.headW, g.headW * 0.75, 5], skin, 1, 'speckle'),
    ell([hx + 1, hy - 2.5, 7.5], [g.headW + 0.5, 2.6, 4.5], skin, 1, 'speckle'), // brow
    ell([hx + 1, hy + 4, 5.5], [g.headW - 1.5, 3.2, 4], skin, 1, 'speckle'),   // jaw
  );
  face(prims, hx, hy, g.headW, kind, p, frame);
  if (p.hornL) prims.push(cap([hx - g.headW + 1, hy - 4, 6], [hx - g.headW - 3, hy - 9, 6], 1.6, 0.6, 'bone', 1));
  if (p.hornR) prims.push(cap([hx + g.headW - 1, hy - 4, 6], [hx + g.headW + 3, hy - 9, 6], 1.6, 0.6, 'bone', 1));
  if (p.tumor) prims.push(ell([p.tumor[0], p.tumor[1], 7], [p.tumor[2], p.tumor[2], p.tumor[2]], skin, 1, 'vein'));

  // ---- role silhouettes -----------------------------------------------------------
  if (kind === 'smith') {
    // the hammer: a huge riveted head on the right arm — raised on work frames
    const raise = work ? -9 : 0;
    const hx2 = elbR[0] - 2 + asw, hy2 = g.torsoY + 14 + bob + raise;
    prims.push(
      cap([hx2, hy2, 5], [hx2 + 1, hy2 - 6, 7], 2.6, 2.2, 'steel', 7),
      ell([hx2 + 1.5, hy2 - 8, 7], [4.2, 3, 3], 'steel', 7),
      ell([hx2 + 1.5, hy2 - 8, 8.5], [1, 1, 0.8], 'brass', 7),
      ell([hx2 - 1, hy2 - 8, 8.5], [1, 1, 0.8], 'brass', 7),
      ell([hx2 + 4, hy2 - 8, 8.5], [1, 1, 0.8], 'brass', 7),
      cap([hx + 5, hy - 6, 5], [hx + 10, hy - 12, 5], 1.8, 1.3, 'steel', 7), // exhaust stack
      ell([hx + 10.5, hy - 13, 5], [1.3, 1.1, 1], 'acid', 7),
    );
  } else if (kind === 'scout') {
    // eye stalks rising 10+ px, one bandaged; skull dish
    const stalkXs = [hx - 3, hx, hx + 3];
    stalkXs.forEach((sx, i) => {
      const tip: V3 = [sx + (i - 1) * 2.5 + (frame % 2), hy - 12 - i, 5];
      prims.push(cap([sx, hy - 4, 6], tip, 1, 0.6, skin, 1));
      prims.push(ell(tip, [1.6, 1.4, 1.2], i === 1 ? 'bone' : 'socket', 1));
      if (i !== 1) prims.push(ell([tip[0], tip[1], tip[2] + 1], [0.9, 0.8, 0.8], work && i === 2 ? 'blood' : 'acid', 1));
    });
    prims.push(
      cap([hx + g.headW, hy - 2, 5], [hx + g.headW + 6, hy - 8, 4], 1.6, 1, 'steel', 7),
      ell([hx + g.headW + 7, hy - 9, 4], [3.6, 2, 2.5], 'steel', 7),
      ell([hx + g.headW + 7.5, hy - 9, 5.5], [1, 0.8, 0.8], 'acid', 7),
    );
  } else if (kind === 'inspector') {
    // split head: dark seam + small eye cluster in the gap + big lens
    prims.push(cap([hx, hy - 6, 9.5], [hx, hy + 4, 9.5], 0.7, 0.7, 'socket', 1));
    for (let i = 0; i < 5; i++) {
      prims.push(ell([hx - 1.5 + (i % 3), hy - 4 + Math.floor(i / 3) * 2.5, 10], [0.7, 0.7, 0.6], 'acid', 1));
    }
    prims.push(ell([hx + 4, hy, 10], [2.4, 2.4, 1.6], 'steel', 1));
    prims.push(ell([hx + 4, hy, 11.5], [1.3, 1.3, 1], work ? 'blood' : 'acid', 1));
    // long probing fingers held up on the left
    for (let i = 0; i < 3; i++) {
      prims.push(cap([elbL[0] + 1 - asw + i, g.torsoY + 13 + bob, 5], [elbL[0] - 3 - asw + i * 2, g.torsoY + 9 + bob - (work ? i : 0), 5], 0.9, 0.45, skin, 3));
    }
  } else if (kind === 'packer') {
    // crate held in front by both big arms; vestigial stubs behind
    const crateY = g.torsoY + 10 + bob - (work ? 2 : 0);
    prims.push(
      ell([cx + h * 0.5, crateY, 9], [7, 5, 3.5], 'brass', 7),
      ell([cx + h * 0.5, crateY - 2, 10], [5.5, 1.5, 1], 'steel', 7),
      ell([5, g.torsoY + 4 + bob, 2], [2, 1.6, 1.8], skin, 3),
      ell([cx + g.torsoW + 5, g.torsoY + 4 + bob, 2], [2, 1.6, 1.8], skin, 4),
    );
  } else if (kind === 'merchandiser') {
    // bloated belly already via wide; ear tag + forehead coin + coins in hand
    prims.push(
      cap([hx + g.headW, hy + 2, 5], [hx + g.headW + 4, hy + 8, 5], 1, 0.8, 'blood', 1),
      ell([hx + g.headW + 4.5, hy + 9.5, 5], [1.8, 2, 1.2], 'brass', 7),
      ell([hx + g.headW + 4.5, hy + 9.5, 6.5], [0.6, 0.8, 0.5], 'socket', 7),
      ell([hx, hy - 5, 9.5], [2, 2, 1.3], 'brass', 1),
      ell([hx, hy - 5, 10.5], [0.8, 0.8, 0.6], 'acid', 1),
    );
    if (work) {
      prims.push(ell([elbR[0] - 3 + asw, g.torsoY + 12 + bob, 7], [1.8, 1.8, 1.8], 'brass', 4));
      prims.push(ell([elbR[0] - 1 + asw, g.torsoY + 14 + bob, 7], [1.4, 1.4, 1.4], 'brass', 4));
    }
  }
  // brass joint bolts
  prims.push(
    ell([cx - g.torsoW - 1 + h * 0.5, g.torsoY - 1 + bob, 6.5], [1.1, 1.1, 0.9], 'brass', 3),
    ell([cx + g.torsoW + 1 + h * 0.5, g.torsoY - 1 + bob, 6.5], [1.1, 1.1, 0.9], 'brass', 4),
    ell([cx - 5 + sw, g.legY + 1, 5], [1, 1, 0.9], 'brass', 5),
    ell([cx + 4 - sw, g.legY + 1, 5], [1, 1, 0.9], 'brass', 6),
  );
  return prims;
}

// ---- overlord: 96x96 — brain wider than the body --------------------------------

function overlordPrims(sway: number, thinking: boolean): Prim[] {
  const prims: Prim[] = [];
  const skin: Mat = 'bruise';
  // tentacles: thick capsule chains draping over the dais rim
  for (let i = 0; i < 6; i++) {
    const bx = 20 + i * 11;
    const ph = i * 1.15;
    let ax = bx, ay = 70, az = 2;
    for (let s2 = 0; s2 < 4; s2++) {
      const nx2 = ax + Math.sin(sway * 2 + ph + s2 * 0.7) * 4;
      const ny2 = ay + 5;
      prims.push(cap([ax, ay, az], [nx2, ny2, az], 4 - s2 * 0.7, 3.2 - s2 * 0.7, skin, 8 + i));
      ax = nx2; ay = ny2;
    }
    prims.push(ell([ax, ay + 1, az + 1], [1.4, 1.1, 1], 'blood', 8 + i));
  }
  // sagging body
  prims.push(
    ell([48, 58, 4], [28, 13, 9], skin, 9, 'speckle'),
    ell([32, 65, 3], [13, 10, 6], skin, 9, 'speckle'),
    ell([64, 65, 3], [13, 10, 6], skin, 9, 'speckle'),
    ell([48, 72, 2], [20, 10, 5], skin, 9, 'speckle'),
  );
  // fleshy neck folds connecting brain to body
  prims.push(
    ell([48, 46, 5], [18, 9, 7], skin, 9, 'speckle'),
    ell([48, 42, 6], [14, 7, 6], skin, 9, 'speckle'),
  );
  // cracked cranial rim: a ring of bone shards under the brain
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.15 + (i / 9) * 0.7);
    prims.push(cap([48 + Math.cos(a) * 30, 40 + Math.sin(a) * 4, 8], [48 + Math.cos(a) * 27, 44 + Math.sin(a) * 5, 8], 1.7, 0.9, 'bone', 10));
  }
  // five asymmetric eyes, one milky — 3x3 emissive
  const eyes: [number, number, Mat][] = [[32, 55, 'acid'], [43, 52, 'acid'], [55, 52, 'acid'], [67, 57, 'acid'], [38, 61, 'milk']];
  for (const [ex, ey, m] of eyes) {
    prims.push(ell([ex, ey, 10], [3, 2.6, 1.8], 'socket', 9));
    prims.push(ell([ex, ey, 11.5], [1.7, 1.5, 1.2], m, 9));
  }
  // lamprey mouth ~14px: blood ring → dark ring → black core, 10 teeth inward
  prims.push(ell([48, 72, 10], [7.5, 5.5, 3], 'blood', 9));
  prims.push(ell([48, 72, 11], [5.5, 3.8, 2.5], 'socket', 9));
  prims.push(ell([48, 72, 12], [3, 2, 2], 'dark', 9));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    prims.push(cap([48 + Math.cos(a) * 5.5, 72 + Math.sin(a) * 4, 11], [48 + Math.cos(a) * 3, 72 + Math.sin(a) * 2, 11.5], 0.9, 0.3, 'bone', 9));
  }
  // THE BRAIN — bigger than the body, gyri field, veins
  prims.push(ell([48, 22, 6], [37, 23, 12], thinking ? 'sick' : skin, 10, 'brain'));
  prims.push(ell([28, 18, 8], [10, 8, 8], skin, 10, 'brain'));
  prims.push(ell([68, 16, 8], [9, 7, 7], skin, 10, 'brain'));
  // three emissive acid tubes arcing down to the dais
  for (let i = 0; i < 3; i++) {
    const tx = 26 + i * 22;
    const midx = tx + Math.sin(sway + i * 2) * 5;
    prims.push(cap([tx, 70, 4], [midx, 82, 4], 2.2, 1.8, 'acid', 9));
    prims.push(cap([midx, 82, 4], [tx + 4, 92, 4], 1.8, 1.4, 'acid', 9));
  }
  if (thinking) prims.push(ell([48, 6, 13], [15, 4.5, 4], 'acid', 10));
  return prims;
}

// ---- sprite plumbing --------------------------------------------------------------

const cache = new Map<string, HTMLCanvasElement>();

function toCanvas(w: number, h: number, prims: Prim[], seed: number, rim?: RGB): HTMLCanvasElement {
  const { data } = renderVolume(w, h, prims, seed, rim);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return c;
}

function cached(key: string, build: () => HTMLCanvasElement): HTMLCanvasElement {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = build();
  cache.set(key, c);
  return c;
}

/// Emissive-only canvas for a worker frame — drawn over the darkness so
/// the eyes glow. Same cache key space as alienSprite.
export function alienEmissive(name: string, kind: AgentKind, frame: number, flip = false): HTMLCanvasElement {
  const key = `em:${name}:${kind}:${frame}`;
  const base = cached(key, () => {
    const data = renderEmissive(36, 44, workerPrims(kind, params(name), frame), hashString(name));
    if (import.meta.env?.DEV && emissiveCoverage(data) > 0.15) {
      console.warn(`emissive mask too dense: ${name}/${kind} f${frame} ${Math.round(emissiveCoverage(data) * 100)}%`);
    }
    const c = document.createElement('canvas');
    c.width = 36; c.height = 44;
    const g = c.getContext('2d')!;
    const img = g.createImageData(36, 44);
    img.data.set(data);
    g.putImageData(img, 0, 0);
    return c;
  });
  if (!flip) return base;
  const fk = key + ':flip';
  const fhit = cache.get(fk);
  if (fhit) return fhit;
  const c = document.createElement('canvas');
  c.width = 36; c.height = 44;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.translate(36, 0); g.scale(-1, 1);
  g.drawImage(base, 0, 0);
  cache.set(fk, c);
  return c;
}

/// Overlord emissive mask (eyes, tubes, thinking crown).
export function overlordEmissive(sway: number, thinking: boolean): HTMLCanvasElement {
  const f = Math.abs(Math.floor(sway * 3)) % 8;
  return cached(`olem:${thinking}:${f}`, () => {
    const data = renderEmissive(96, 96, overlordPrims(f * 0.6, thinking), 7);
    if (import.meta.env?.DEV && emissiveCoverage(data) > 0.15) {
      console.warn(`overlord emissive mask too dense: ${Math.round(emissiveCoverage(data) * 100)}%`);
    }
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const g = c.getContext('2d')!;
    const img = g.createImageData(96, 96);
    img.data.set(data);
    g.putImageData(img, 0, 0);
    return c;
  });
}

/// ~36x44 worker. frame 0/1 = breathing; 2/3 = work loop; walk uses the
/// same phase for a leg swing. flip: face left.
export function alienSprite(name: string, kind: AgentKind, frame: number, flip = false): HTMLCanvasElement {
  const key = `${name}:${kind}:${frame}`;
  const RIM: Record<Mat, RGB> = { sick: RAMPS.sick[3], bruise: RAMPS.bruise[3], pale: RAMPS.pale[3], steel: RAMPS.steel[4], acid: RAMPS.acid[2], blood: RAMPS.blood[3], bone: RAMPS.bone[2], brass: RAMPS.brass[2], socket: RAMPS.bruise[3], milk: RAMPS.milk[0], dark: RAMPS.dark[0] };
  const rim = RIM[params(name).skin];
  const base = cached(key, () => toCanvas(36, 44, workerPrims(kind, params(name), frame), hashString(name), rim));
  if (!flip) return base;
  const fk = key + ':flip';
  const fhit = cache.get(fk);
  if (fhit) return fhit;
  const c = document.createElement('canvas');
  c.width = 36; c.height = 44;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(36, 0); ctx.scale(-1, 1);
  ctx.drawImage(base, 0, 0);
  cache.set(fk, c);
  return c;
}

/// The Overlord ~96x96, prerendered sway frames.
export function overlordSprite(sway: number, thinking: boolean): HTMLCanvasElement {
  const f = Math.abs(Math.floor(sway * 3)) % 8;
  return cached(`ol:${thinking}:${f}`, () => toCanvas(96, 96, overlordPrims(f * 0.6, thinking), 7, RAMPS.bruise[3]));
}

/// Status bubble ~18x18.
export function bubble(kind: '!' | 'z' | 'ok' | 'no' | 'work'): HTMLCanvasElement {
  return cached(`b:${kind}`, () => {
    const s = new Sprite(18, 18);
    const bg: RGB = kind === '!' ? RAMPS.blood[2] : kind === 'ok' ? RAMPS.acid[1] : kind === 'no' ? RAMPS.blood[3] : kind === 'work' ? RAMPS.brass[1] : RAMPS.steel[2];
    for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) {
      const dx = x - 9, dy = y - 9;
      if (dx * dx + dy * dy <= 64) s.px(x, y, bg);
    }
    const w: RGB = [240, 245, 230];
    if (kind === '!') { s.rect(8, 4, 2, 8, w); s.px(8, 14, w); s.px(9, 14, w); }
    else if (kind === 'z') { s.rect(6, 4, 7, 2, w); s.line(11, 6, 6, 12, w); s.rect(6, 13, 7, 2, w); }
    else if (kind === 'ok') { s.line(5, 10, 8, 13, w); s.line(9, 13, 14, 5, w); }
    else if (kind === 'no') { s.line(6, 6, 12, 12, w); s.line(12, 6, 6, 12, w); }
    else { s.rect(6, 6, 6, 6, w); s.px(12, 10, w); s.px(12, 11, w); }
    return s.toCanvas();
  });
}

/// Rusted biohazard crate ~28x22 (kept procedural — small + flat).
export function crateSprite(): HTMLCanvasElement {
  return cached('crate', () => {
    const s = new Sprite(28, 22);
    const H = RAMPS.steel;
    s.rect(0, 0, 28, 22, H[2]);
    s.rect(0, 0, 28, 2, H[3]); s.rect(0, 20, 28, 2, H[0]);
    s.rect(0, 0, 2, 22, H[3]); s.rect(26, 0, 2, 22, H[1]);
    s.line(2, 2, 25, 19, H[1]); s.line(25, 2, 2, 19, H[1]);
    s.rect(0, 10, 28, 2, H[1]);
    for (const [rx, ry] of [[4, 4], [20, 15], [23, 5], [8, 16]]) { s.px(rx, ry, RAMPS.brass[0]); s.px(rx + 1, ry + 1, RAMPS.brass[1]); }
    s.rect(12, 6, 4, 2, RAMPS.acid[2]); s.line(12, 6, 10, 10, RAMPS.acid[2]); s.line(16, 6, 18, 10, RAMPS.acid[2]); s.rect(11, 12, 6, 2, RAMPS.acid[2]); s.px(14, 10, RAMPS.acid[1]);
    return s.toCanvas();
  });
}

/// Ascii dump of every base sprite for review (dev tooling).
export function grids(): string {
  const out: string[] = [];
  for (const kind of ['smith', 'scout', 'inspector', 'packer', 'merchandiser'] as AgentKind[]) {
    out.push(`=== ${kind} ===`);
    out.push(renderAscii(36, 44, workerPrims(kind, params(`demo-${kind}`), 0), 1));
  }
  out.push('=== overlord ===');
  out.push(renderAscii(96, 96, overlordPrims(0, false), 7));
  return out.join('\n');
}
