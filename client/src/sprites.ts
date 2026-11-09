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

const FLESH: Mat[] = ['teal', 'bog', 'magenta', 'eel'];
interface Params {
  skin: Mat;
  arch: number;
  thickL: number; thickR: number;
  hunch: number;
  tumor: [number, number, number] | null;
  eyes: number;
  hornL: boolean; hornR: boolean;
  jaw: 'teeth' | 'stitch';
}
function params(name: string): Params {
  const r = mulberry32(hashString(name));
  return {
    skin: FLESH[Math.floor(r() * FLESH.length)],
    arch: Math.floor(r() * 3),
    thickL: 0.8 + r() * 0.45,
    thickR: 0.8 + r() * 0.45,
    hunch: r() * 3,
    tumor: r() < 0.5 ? [6 + r() * 20, 4 + r() * 10, 0.8 + r() * 1.6] : null,
    eyes: 1 + Math.floor(r() * 3), // 1-3 eyes
    hornL: r() < 0.4, hornR: r() < 0.4,
    jaw: r() < 0.6 ? 'teeth' : 'stitch',
  };
}

// ---- creature archetypes (round 8: exact anatomy, wet gloss, bloody hands) -------
// 46x44 box, ground at y≈43. Eyes: socket + iris (skin tone3 or acid) +
// dark pupil + ONE spec pixel top-left — that spec pixel sells the life.

interface AP { skin: Mat; arch: number }
const eye = (P: Prim[], x: number, y: number, r2: number, iris: Mat, part = 1): void => {
  P.push(ell([x, y, 9], [r2 + 0.8, r2 + 0.6, 1.2], 'socket', part)); // lid/socket
  P.push(ell([x, y, 9.8], [r2, r2 * 0.9, 1], iris, part));           // iris
  P.push(ell([x, y + 0.4, 10.6], [Math.max(0.5, r2 * 0.35), r2 * 0.55, 0.9], 'dark', part)); // pupil
  P.push(ell([x - r2 * 0.35, y - r2 * 0.35, 10.8], [0.45, 0.45, 0.5], 'spec', part));        // spec glint
};
/// bloody knuckled hand: dark blood smear + bone tips + forearm streaks
const fist = (P: Prim[], x: number, y: number, part: number, big = 1, skin: Mat = 'teal'): void => {
  P.push(ell([x, y, 8], [1.9 * big, 1.6 * big, 1.4], skin, part));         // skin hand
  P.push(ell([x - 0.6, y - 0.4, 9], [0.7, 0.6, 0.5], 'blood', part));      // knuckle smear 1
  P.push(ell([x + 0.6, y - 0.3, 9], [0.7, 0.5, 0.5], 'blood', part));      // knuckle smear 2
  P.push(ell([x + 0.5, y + 1, 8.5], [1, 0.7, 0.8], 'bone', part));         // worn bone tip
};
const streak = (P: Prim[], x: number, y0: number, y1: number, part: number): void => {
  for (let y = y0; y < y1; y += 2) P.push(ell([x + (y % 3), y, 7], [0.8, 1, 0.8], 'blood', part));
};
const drip = (x: number, y: number, len: number, skin: Mat, part = 9): Prim =>
  cap([x, y, 7], [x + 0.5, y + len, 7], 0.9, 0.35, skin, part);
/// dark mouth interior with bone teeth hanging down (and up where specified)
const maw = (P: Prim[], mx: number, my: number, w: number, part = 1, fangs = 0): void => {
  P.push(ell([mx, my, 8.5], [w / 2, 2.4, 1.6], 'socket', part));
  const n = Math.floor(w / 2.4);
  for (let i = 0; i < n; i++) P.push(ell([mx - w / 2 + 1.5 + i * 2.4, my - 0.6, 9.5], [0.7, 1.3, 0.7], 'bone', part));
  if (fangs) for (let i = 0; i < fangs; i++) P.push(cap([mx - 2 + i * 4, my + 2, 9.5], [mx - 2 + i * 4, my - 1, 9.5], 0.8, 0.2, 'bone', part));
};

function workerPrims(kind: AgentKind, p: Params, frame: number): Prim[] {
  const skin = p.skin;
  const work = frame >= 2;
  const bob = frame % 2;
  const sw = frame % 4 === 1 ? 2 : frame % 4 === 3 ? -2 : 0;
  const P: Prim[] = [];
  const cx = 23;
  const raise = work ? 9 : 0;

  // ---------- SMITH ----------
  if (kind === 'smith') {
    const a = p.arch % 3;
    if (a === 0) { // brute: head low between massive shoulders, wide stance
      P.push(
        // legs: thick thighs+shins, wide stance, clawed feet (no foot blood)
        cap([cx - 8 + sw, 32, 2], [cx - 10 + sw, 40, 2], 6, 5, skin, 5),
        cap([cx + 8 - sw, 32, 2], [cx + 10 - sw, 40, 2], 6, 5, skin, 6),
        ell([cx - 11 + sw, 42, 3], [4.5, 2, 2.4], skin, 5),
        ell([cx + 11 - sw, 42, 3], [4.5, 2, 2.4], skin, 6),
        ell([cx - 12 + sw, 42.5, 4], [1.2, 0.8, 0.8], 'bone', 5),
        ell([cx - 9 + sw, 42.5, 4], [1.2, 0.8, 0.8], 'bone', 5),
        ell([cx + 9 - sw, 42.5, 4], [1.2, 0.8, 0.8], 'bone', 6),
        ell([cx + 12 - sw, 42.5, 4], [1.2, 0.8, 0.8], 'bone', 6),
        // torso 20x16 + magenta armour plate on the chest
        ell([cx, 24 + bob, 4], [10, 8, 6], skin, 2, 'speckle'),
        ell([cx, 25 + bob, 8], [7, 5.5, 3], 'magenta', 2, 'speckle'),
        // massive shoulders: the widest point (~36px)
        ell([cx - 13, 15 + bob, 3.5], [5.5, 4.5, 4], skin, 2, 'speckle'),
        ell([cx + 13, 15 + bob, 3.5], [5.5, 4.5, 4], skin, 2, 'speckle'),
        // head LOW between the shoulders (top ≈ y6), heavy brow
        ell([cx + 1, 11 + bob, 7], [7, 6, 5], skin, 1, 'speckle'),
        ell([cx + 1, 8 + bob, 8], [7.5, 2.6, 4.5], skin, 1),
      );
      eye(P, cx - 2.5, 10.5 + bob, 1.5, 'acid');
      eye(P, cx + 4.5, 10 + bob, 1.5, 'acid');
      // mouth 8px + 2 bone fangs pointing up
      P.push(ell([cx + 1, 15 + bob, 8.5], [4, 1.8, 1.4], 'socket', 1));
      for (let i = 0; i < 3; i++) P.push(ell([cx - 2 + i * 2.5, 14.4 + bob, 9.5], [0.7, 1, 0.7], 'bone', 1));
      for (const fx of [cx - 2, cx + 3]) P.push(cap([fx, 16.5 + bob, 9.5], [fx, 13.5 + bob, 9.5], 0.9, 0.2, 'bone', 1));
      // horns curving up-out from the head sides
      P.push(cap([cx - 6, 9 + bob, 6], [cx - 11, 4 + bob, 6], 1.7, 0.5, 'bone', 1));
      P.push(cap([cx + 8, 9 + bob, 6], [cx + 13, 4 + bob, 6], 1.7, 0.5, 'bone', 1));
      // arms: upper r5, forearm r6, fist hanging at y≈32
      P.push(cap([cx - 13, 16 + bob, 4], [cx - 16, 25 + bob, 4], 5, 4, skin, 3));
      P.push(cap([cx - 16, 25 + bob, 4], [cx - 15, 31 + bob, 4], 6, 4.5, skin, 3));
      fist(P, cx - 15, 33 + bob, 3, 1.5, skin);
      streak(P, cx - 15, 27 + bob, 31 + bob, 3);
      // hammer arm — work frame raises it overhead
      P.push(cap([cx + 13, 16 + bob, 4], [cx + 16, 24 + bob - raise, 4], 5, 4, skin, 4));
      P.push(cap([cx + 16, 24 + bob - raise, 4], [cx + 16, 31 + bob - raise, 4], 6, 4.5, skin, 4));
      fist(P, cx + 16, 32 + bob - raise, 4, 1.6, skin);
      streak(P, cx + 16, 26 + bob - raise, 30 + bob - raise, 4);
      // hammer: brass haft + steel head
      P.push(cap([cx + 16, 30 + bob - raise, 8], [cx + 17, 22 + bob - raise, 9], 1.1, 1.1, 'brass', 7));
      P.push(ell([cx + 17, 19.5 + bob - raise, 9], [4.5, 3, 3], 'steel', 7));
      P.push(ell([cx + 17, 19.5 + bob - raise, 10.5], [1, 1, 0.9], 'brass', 7));
    } else if (a === 1) { // swamp-thing: tall, hunched, dripping, tongs
      P.push(
        cap([cx - 5 + sw, 34, 2], [cx - 6 + sw, 41, 2], 4, 3.4, skin, 5),
        cap([cx + 6 - sw, 34, 2], [cx + 7 - sw, 41, 2], 4, 3.4, skin, 6),
        ell([cx - 6 + sw, 42, 3], [4, 1.8, 2.2], skin, 5),
        ell([cx + 7 - sw, 42, 3], [4, 1.8, 2.2], skin, 6),
        // tall hunched mass, head forward + low
        ell([cx + 1, 24 + bob, 4], [11, 11, 7], skin, 2, 'vein'),
        ell([cx + 3, 30 + bob, 3], [11, 7, 5], skin, 2, 'speckle'),
        ell([cx + 5, 12 + bob, 6], [6.5, 5, 4.5], skin, 1, 'speckle'),
      );
      // two small glowing eyes deep in a dark face
      eye(P, cx + 3.5, 11 + bob, 1.2, 'acid');
      eye(P, cx + 7.5, 11.5 + bob, 1.1, 'acid');
      maw(P, cx + 5, 15.5 + bob, 7);
      // weeds + slime drips off the head, shoulders, arms
      P.push(drip(cx - 6, 26, 5, skin), drip(cx + 10, 28, 6, skin), drip(cx, 34, 5, skin), drip(cx + 2, 15 + bob, 4, skin), drip(cx - 4, 17 + bob, 3, skin));
      // long dangling arms, tongs in the right
      P.push(cap([cx - 11, 20 + bob, 4], [cx - 14, 33 + bob, 4], 2.6, 2.2, skin, 3));
      fist(P, cx - 14, 35 + bob, 3, 1.2, skin);
      streak(P, cx - 14, 28 + bob, 33 + bob, 3);
      P.push(cap([cx + 12, 20 + bob, 4], [cx + 15 + (work ? 2 : 0), 32 + bob - (work ? 6 : 0), 4], 2.6, 2.2, skin, 4));
      const hx = cx + 15 + (work ? 2 : 0), hy = 34 + bob - (work ? 6 : 0);
      fist(P, hx, hy, 4, 1.2, skin);
      // plasma tongs: two steel jaws + acid tip
      P.push(cap([hx, hy - 2, 8], [hx + 3, hy - 8, 9], 1, 0.7, 'steel', 7));
      P.push(cap([hx + 2, hy - 1, 8], [hx + 6, hy - 7, 9], 1, 0.7, 'steel', 7));
      P.push(ell([hx + 5, hy - 9, 9.5], [1.1, 1, 0.9], 'acid', 7));
      // bandaged wrap on the left forearm
      P.push(ell([cx - 13, 29 + bob, 5], [2.4, 1.7, 1.7], 'bone', 3), ell([cx - 13, 29.5 + bob, 6], [1.6, 0.8, 0.8], 'blood', 3));
    } else { // lizard: side-leaning, long open jaw, spine ridge, digitigrade
      P.push(
        cap([cx - 6 + sw, 34, 2], [cx - 9 + sw, 39, 2], 3.5, 3, skin, 5),      // digitigrade
        cap([cx - 9 + sw, 39, 2], [cx - 7 + sw, 42, 2], 3, 2.4, skin, 5),
        cap([cx + 6 - sw, 34, 2], [cx + 9 - sw, 39, 2], 3.5, 3, skin, 6),
        cap([cx + 9 - sw, 39, 2], [cx + 7 - sw, 42, 2], 3, 2.4, skin, 6),
        ell([cx - 7 + sw, 42.5, 3], [4, 1.5, 2], skin, 5),
        ell([cx + 7 - sw, 42.5, 3], [4, 1.5, 2], skin, 6),
        // side-leaning torso + tail chain
        ell([cx - 1, 25 + bob, 4], [10, 8, 6], skin, 2, 'speckle'),
        cap([cx - 9, 30, 2], [cx - 16, 36 + Math.sin(frame) * 2, 2], 3, 1.2, skin, 2),
        cap([cx - 16, 36 + Math.sin(frame) * 2, 2], [cx - 21, 38 + Math.sin(frame) * 2.5, 2], 1.6, 0.5, skin, 2),
        // head thrust forward + long open jaw ~12px
        ell([cx + 6, 14 + bob, 6], [5.5, 4.5, 4], skin, 1, 'speckle'),
        cap([cx + 8, 13 + bob, 7], [cx + 17, 15 + bob, 7], 2.2, 1.6, skin, 1),
        cap([cx + 8, 17 + bob, 6], [cx + 16, 19 + bob, 6], 1.8, 1.2, skin, 1),
      );
      // teeth rows top + bottom on the open jaw
      for (let i = 0; i < 5; i++) {
        P.push(ell([cx + 11 + i * 1.6, 14.8 + bob, 8], [0.6, 1, 0.6], 'bone', 1));
        P.push(ell([cx + 11 + i * 1.6, 17.2 + bob, 7], [0.6, 1, 0.6], 'bone', 1));
      }
      eye(P, cx + 6, 11 + bob, 1.8, 'acid'); // one big eye
      // spine ridge cones along back + head
      for (let i = 0; i < 7; i++) P.push(cap([cx - 8 + i * 2.5, 20 + bob - Math.abs(i - 3), 4], [cx - 8.5 + i * 2.5, 16.5 + bob - Math.abs(i - 3), 4], 1.2, 0.4, 'bone', 2));
      P.push(cap([cx - 9, 24 + bob, 4], [cx - 12, 33 + bob, 4], 2.2, 1.8, skin, 3));
      fist(P, cx - 12, 35 + bob, 3, 1.1, skin);
      P.push(cap([cx + 7, 24 + bob, 4], [cx + 10 + (work ? 3 : 0), 33 + bob - (work ? 6 : 0), 4], 2.2, 1.8, skin, 4));
      const hx = cx + 10 + (work ? 3 : 0), hy = 35 + bob - (work ? 6 : 0);
      fist(P, hx, hy, 4, 1.1, skin);
      // hammer same kit
      P.push(cap([hx, hy - 2, 8], [hx + 2, hy - 9, 9], 1, 1, 'brass', 7));
      P.push(ell([hx + 2.5, hy - 11, 9], [4, 2.6, 2.6], 'steel', 7));
      P.push(drip(cx + 14, 18 + bob, 4, skin));
    }
  }
  // ---------- SCOUT: eye-stalk slug ----------
  else if (kind === 'scout') {
    P.push(
      // low slug body on the ground, lighter belly
      ell([cx, 33 + bob, 4], [15, 9, 6], skin, 2, 'speckle'),
      ell([cx + 1, 38 + bob, 5], [12, 4.5, 4], p.arch === 1 ? 'magenta' : skin, 2),
      ell([cx - 4, 24 + bob, 5], [7, 5, 4.5], skin, 1, 'speckle'),
      // tail curl at the back
      cap([cx + 13, 36, 2], [cx + 19, 33 + Math.sin(frame) * 2, 2], 3, 1.6, skin, 2),
      cap([cx + 19, 33 + Math.sin(frame) * 2, 2], [cx + 21, 28 + Math.sin(frame) * 2.5, 2], 1.6, 0.5, skin, 2),
      drip(cx - 8, 39, 4, skin), drip(cx + 6, 40, 3, skin), drip(cx + 12, 38, 4, skin),
    );
    // small mouth slit at the front
    P.push(ell([cx - 10, 31 + bob, 9], [3, 1.2, 1], 'socket', 1));
    // 3 stalks curving up 12-16px, 4x4 eyeballs
    const stalkN = p.arch === 2 ? 2 : 3;
    for (let i = 0; i < stalkN; i++) {
      const bx = cx - 6 + i * 5;
      const sway = Math.sin(frame * 1.5 + i * 1.3) * (work ? 4 : 2);
      const tipX = bx + sway + (i - 1) * 3, tipY = 10 - i * 2;
      P.push(cap([bx, 22 + bob, 6], [tipX, tipY + 3, 6], 1, 0.55, skin, 1));
      eye(P, tipX, tipY, 2, i === 1 && work ? 'blood' : 'acid');
    }
    // grafted dish low on the back
    P.push(cap([cx + 8, 26, 4], [cx + 14, 20, 4], 1.4, 1, 'steel', 7), ell([cx + 15, 19, 4], [3, 1.6, 2], 'steel', 7), ell([cx + 15.5, 19, 5], [0.8, 0.6, 0.7], 'acid', 7));
  }
  // ---------- INSPECTOR ----------
  else if (kind === 'inspector') {
    const a = p.arch % 2;
    P.push(
      cap([cx - 4 + sw, 38, 2], [cx - 4 + sw, 42, 2], 2.5, 2, skin, 5),
      cap([cx + 4 - sw, 38, 2], [cx + 4 - sw, 42, 2], 2.5, 2, skin, 6),
      ell([cx - 4 + sw, 42.5, 3], [3, 1.4, 2], skin, 5),
      ell([cx + 4 - sw, 42.5, 3], [3, 1.4, 2], skin, 6),
    );
    if (a === 0) { // anglerfish: head IS the body
      P.push(
        ell([cx, 24 + bob, 4], [13, 11, 7], skin, 1, 'speckle'),
        ell([cx + 1, 27 + bob, 8], [8, 4.5, 3], 'socket', 1), // gaping mouth 16px
      );
      // 8-10 needle teeth top + bottom
      for (let i = 0; i < 5; i++) {
        P.push(cap([cx - 6 + i * 3, 24 + bob, 9.5], [cx - 6 + i * 3, 27.5 + bob, 9.5], 0.7, 0.15, 'bone', 1));
        P.push(cap([cx - 4.5 + i * 3, 30 + bob, 9.5], [cx - 4.5 + i * 3, 27.5 + bob, 9.5], 0.7, 0.15, 'bone', 1));
      }
      eye(P, cx - 4, 16 + bob, 3, 'acid');   // one big 6x6 eye
      eye(P, cx + 6, 18 + bob, 1.7, 'acid'); // smaller second
      // lure stalk arching forward, emissive bulb flickers on work frames
      const flick = work && frame % 2 ? 0.6 : 0;
      P.push(cap([cx + 2, 14 + bob, 6], [cx + 10, 8 + bob, 6], 0.8, 0.5, skin, 1));
      P.push(ell([cx + 10.5, 7.5 + bob, 6.5], [1.7 + flick, 1.5 + flick, 1.2], 'acid', 1));
      // fin below
      P.push(cap([cx - 2, 34, 3], [cx - 6, 38, 3], 2.4, 0.6, skin, 2));
      // stubby arms
      P.push(cap([cx - 11, 26 + bob, 4], [cx - 13, 33 + bob, 4], 2, 1.6, skin, 3));
      fist(P, cx - 13, 35 + bob, 3, 1, skin);
      P.push(cap([cx + 11, 26 + bob, 4], [cx + 13 + (work ? 2 : 0), 33 + bob, 4], 2, 1.6, skin, 4));
      fist(P, cx + 13 + (work ? 2 : 0), 35 + bob, 4, 1, skin);
      P.push(drip(cx - 5, 31 + bob, 3, skin));
    } else { // fin-head: domed head + big side fin, squat body
      P.push(
        ell([cx, 28 + bob, 4], [9, 8, 5.5], skin, 2, 'speckle'), // squat body
        ell([cx + 1, 16 + bob, 6], [6.5, 6, 5], skin, 1, 'speckle'), // domed head
        cap([cx - 3, 12 + bob, 4], [cx - 10, 6 + bob, 4], 3.5, 0.8, skin, 1), // big side fin
      );
      eye(P, cx - 1, 14.5 + bob, 1.7, 'acid');
      eye(P, cx + 4, 15 + bob, 1.3, 'acid');
      maw(P, cx + 1, 20 + bob, 9);
      // long probing fingers held up on work
      for (let i = 0; i < 3; i++) {
        P.push(cap([cx - 9 + i, 27 + bob, 5], [cx - 13 + i * 2, 21 + bob - (work ? i : 0), 5], 0.9, 0.4, skin, 3));
      }
      P.push(cap([cx + 9, 27 + bob, 4], [cx + 11 + (work ? 2 : 0), 35 + bob, 4], 2.2, 1.8, skin, 4));
      fist(P, cx + 12 + (work ? 2 : 0), 37 + bob, 4, 1, skin);
      P.push(drip(cx - 6, 31 + bob, 4, skin));
    }
  }
  // ---------- PACKER ----------
  else if (kind === 'packer') {
    const a = p.arch % 2;
    if (a === 0) { // long-armed hunchback: horizontal torso, knuckle-walk
      P.push(
        cap([cx - 5 + sw, 36, 2], [cx - 5 + sw, 41, 2], 3, 2.5, skin, 5),
        cap([cx + 5 - sw, 36, 2], [cx + 5 - sw, 41, 2], 3, 2.5, skin, 6),
        ell([cx - 5 + sw, 42.5, 3], [3.4, 1.4, 2], skin, 5),
        ell([cx + 5 - sw, 42.5, 3], [3.4, 1.4, 2], skin, 6),
        // horizontal hunched torso + hump
        ell([cx - 2, 24 + bob, 4], [12, 7, 6], skin, 2, 'speckle'),
        ell([cx - 4, 18 + bob, 5], [7, 5, 5], skin, 2, 'speckle'),
        // head forward + low
        ell([cx + 9, 20 + bob, 6], [5.5, 4.5, 4], skin, 1, 'speckle'),
      );
      eye(P, cx + 9, 18.5 + bob, 1.8, 'acid');
      eye(P, cx + 11.5, 21 + bob, 1.1, 'acid');
      // stitched mouth
      P.push(ell([cx + 9, 23 + bob, 8], [3.5, 1.3, 1.1], 'socket', 1));
      for (let i = 0; i < 4; i++) P.push(ell([cx + 6.5 + i * 1.7, 23 + bob, 9], [0.4, 1.2, 0.5], 'dark', 1));
      // 2 long knuckle-walking arms reaching the ground — bandaged bloody hands
      P.push(cap([cx - 12, 22 + bob, 4], [cx - 17, 32 + bob, 4], 2.8, 2.3, skin, 3));
      P.push(cap([cx - 17, 32 + bob, 4], [cx - 18, 39 + bob, 4], 2.3, 1.9, skin, 3));
      fist(P, cx - 18, 40.5 + bob, 3, 1.4, skin);
      P.push(ell([cx - 18, 37 + bob, 5], [2.4, 1.6, 1.6], 'bone', 3), ell([cx - 18, 37.4 + bob, 6], [1.6, 0.8, 0.7], 'blood', 3));
      P.push(cap([cx + 12, 22 + bob, 4], [cx + 16 + (work ? 2 : 0), 32 + bob, 4], 2.8, 2.3, skin, 4));
      P.push(cap([cx + 16 + (work ? 2 : 0), 32 + bob, 4], [cx + 17 + (work ? 2 : 0), 39 + bob, 4], 2.3, 1.9, skin, 4));
      fist(P, cx + 17 + (work ? 2 : 0), 40.5 + bob, 4, 1.4, skin);
      streak(P, cx + 17 + (work ? 2 : 0), 33 + bob, 38 + bob, 4);
      // 2 smaller arms hugging a crate to the chest when working
      if (work) {
        P.push(ell([cx + 5, 28 + bob, 9], [5.5, 4, 3], 'brass', 7));
        P.push(ell([cx + 5, 26.5 + bob, 10.5], [4, 1.2, 0.9], 'steel', 7));
        P.push(cap([cx + 2, 24 + bob, 7], [cx + 5, 29 + bob, 8], 1.4, 1.1, skin, 7));
      }
      P.push(drip(cx - 4, 28 + bob, 4, skin));
    } else { // mushroom-cap: cap on top, face tentacles, crab arms
      P.push(
        cap([cx - 4 + sw, 36, 2], [cx - 5 + sw, 41, 2], 2.8, 2.3, skin, 5),
        cap([cx + 4 - sw, 36, 2], [cx + 5 - sw, 41, 2], 2.8, 2.3, skin, 6),
        ell([cx - 5 + sw, 42.5, 3], [3.2, 1.4, 2], skin, 5),
        ell([cx + 5 - sw, 42.5, 3], [3.2, 1.4, 2], skin, 6),
        ell([cx, 30 + bob, 4], [9, 7, 5.5], skin, 2, 'speckle'),  // stubby body
        ell([cx, 19 + bob, 5], [5, 5.5, 4.5], skin, 1),          // stalk neck
        // big cap 30x12 with spots
        ell([cx, 9 + bob, 6], [15, 6, 5.5], p.arch === 1 ? 'magenta' : skin, 1, 'speckle'),
        ell([cx - 6, 6.5 + bob, 6.5], [1.5, 1.4, 1.2], 'bone', 1),
        ell([cx + 3, 8 + bob, 7], [1.2, 1.1, 1], 'bone', 1),
        ell([cx + 9, 10 + bob, 6.5], [1, 1, 0.9], 'bone', 1),
      );
      // face tentacles hanging under the cap
      for (let i = 0; i < 3; i++) P.push(cap([cx - 3 + i * 3, 14 + bob, 6], [cx - 4 + i * 3.5 + Math.sin(frame + i), 19 + bob, 6], 1.1, 0.5, skin, 1));
      eye(P, cx - 2, 17.5 + bob, 1.3, 'acid');
      eye(P, cx + 3, 17 + bob, 1.1, 'acid');
      P.push(ell([cx, 21 + bob, 8], [3, 1.2, 1], 'socket', 1));
      for (let i = 0; i < 4; i++) P.push(ell([cx - 2.5 + i * 1.6, 21 + bob, 9], [0.4, 1.1, 0.5], 'dark', 1));
      // crab-like arms
      P.push(cap([cx - 9, 29 + bob, 4], [cx - 14, 33 + bob, 4], 2.2, 1.8, skin, 3), cap([cx - 14, 33 + bob, 4], [cx - 12, 37 + bob, 4], 1.6, 1.2, skin, 3));
      fist(P, cx - 12, 39 + bob, 3, 1.2, skin);
      P.push(cap([cx + 9, 29 + bob, 4], [cx + 14 + (work ? 2 : 0), 33 + bob, 4], 2.2, 1.8, skin, 4), cap([cx + 14 + (work ? 2 : 0), 33 + bob, 4], [cx + 12 + (work ? 2 : 0), 37 + bob, 4], 1.6, 1.2, skin, 4));
      fist(P, cx + 12 + (work ? 2 : 0), 39 + bob, 4, 1.2, skin);
      P.push(drip(cx + 5, 31 + bob, 3, skin));
    }
  }
  // ---------- MERCHANDISER ----------
  else if (kind === 'merchandiser') {
    const a = p.arch % 2;
    if (a === 0) { // bloated toad: squat 32x26, huge grin, bulging eyes
      P.push(
        // folded hind legs on the sides
        ell([cx - 13, 34 + bob, 3], [6, 7, 4], skin, 5, 'speckle'),
        ell([cx + 13, 34 + bob, 3], [6, 7, 4], skin, 6, 'speckle'),
        ell([cx - 14 + sw, 42, 3], [5, 1.8, 2.4], skin, 5),
        ell([cx + 14 - sw, 42, 3], [5, 1.8, 2.4], skin, 6),
        // squat body 32x26, head merged into top-front, lighter belly
        ell([cx, 25 + bob, 4], [16, 12, 8], skin, 2, 'speckle'),
        ell([cx + 2, 33 + bob, 6], [11, 6, 4], p.arch === 1 ? 'magenta' : skin, 2),
        ell([cx + 2, 33.5 + bob, 7], [7, 1.4, 1], 'socket', 2), // belly fold
        ell([cx + 2, 30.5 + bob, 7], [7, 1.2, 1], 'socket', 2),
        ell([cx + 3, 14 + bob, 6], [9, 6.5, 5.5], skin, 1, 'speckle'),
        ell([cx + 1, 22 + bob, 7.5], [8, 5, 3.5], skin, 2, 'speckle'), // front muzzle catches light
      );
      // bulging eyes on top: 5x5 with pupil + spec
      eye(P, cx - 1, 10 + bob, 2.5, 'acid');
      eye(P, cx + 7, 10.5 + bob, 2.3, 'acid');
      // HUGE 20px mouth: lower-lip bulge + upper jaw, brass teeth + 2 fangs
      P.push(ell([cx + 3, 20.5 + bob, 8.5], [10, 2.8, 1.8], 'socket', 1));
      P.push(ell([cx + 3, 23 + bob, 8], [9, 2.2, 1.6], skin, 1)); // lower lip bulge
      for (let i = 0; i < 8; i++) P.push(ell([cx - 5 + i * 2.4, 19.8 + bob, 9.5], [0.8, 1.2, 0.8], i % 2 ? 'brass' : 'bone', 1));
      for (const fx of [cx - 4, cx + 8]) P.push(cap([fx, 23 + bob, 9.5], [fx, 19.5 + bob, 9.5], 1, 0.2, 'bone', 1));
      // cheek tag + slime drool + coin in hand
      P.push(cap([cx + 10, 17 + bob, 5], [cx + 14, 21 + bob, 5], 1, 0.7, 'blood', 1), ell([cx + 14.5, 22.5 + bob, 5], [1.9, 2.2, 1.3], 'brass', 7));
      P.push(drip(cx - 1, 22 + bob, 5, skin), drip(cx + 7, 22 + bob, 4, skin));
      // short thick front arms resting on the belly
      P.push(cap([cx - 12, 26 + bob, 5], [cx - 10, 33 + bob, 6], 2.6, 2.2, skin, 3));
      fist(P, cx - 10, 35 + bob, 3, 1.2, skin);
      P.push(cap([cx + 13, 26 + bob, 5], [cx + 11 + (work ? 3 : 0), 33 + bob, 6], 2.6, 2.2, skin, 4));
      fist(P, cx + 11 + (work ? 3 : 0), 35 + bob, 4, 1.2, skin);
      if (work) P.push(ell([cx + 13, 32 + bob, 8], [1.9, 1.9, 1.7], 'brass', 4), ell([cx + 14, 34 + bob, 8], [1.5, 1.5, 1.3], 'brass', 4));
    } else { // shark-frog: head fin, frog body, long tail, toothy smile
      P.push(
        ell([cx - 10, 34 + bob, 3], [5, 6, 4], skin, 5), // folded hind legs
        ell([cx + 10, 34 + bob, 3], [5, 6, 4], skin, 6),
        ell([cx - 11 + sw, 42, 3], [4.5, 1.8, 2.2], skin, 5),
        ell([cx + 11 - sw, 42, 3], [4.5, 1.8, 2.2], skin, 6),
        ell([cx, 26 + bob, 4], [12, 10, 7], skin, 2, 'speckle'), // frog body
        ell([cx + 3, 14 + bob, 6], [7, 5.5, 5], skin, 1, 'speckle'),
        cap([cx, 10 + bob, 5], [cx - 5, 2 + bob, 5], 3, 0.7, skin, 1), // head fin
        cap([cx - 10, 30, 2], [cx - 17, 36 + Math.sin(frame) * 2, 2], 3, 1.2, skin, 2), // long tail
        cap([cx - 17, 36 + Math.sin(frame) * 2, 2], [cx - 21, 38 + Math.sin(frame) * 2.5, 2], 1.5, 0.4, skin, 2),
      );
      eye(P, cx + 1, 11.5 + bob, 2, 'acid');
      eye(P, cx + 6, 12 + bob, 1.6, 'acid');
      // wide toothy smile
      P.push(ell([cx + 4, 17.5 + bob, 8.5], [6.5, 2.4, 1.6], 'socket', 1));
      for (let i = 0; i < 6; i++) P.push(ell([cx - 1 + i * 2.2, 16.8 + bob, 9.5], [0.7, 1.1, 0.7], i % 2 ? 'brass' : 'bone', 1));
      // gill slits
      for (let i = 0; i < 3; i++) P.push(cap([cx - 8 + i * 2, 21 + bob, 5], [cx - 10 + i * 2, 25 + bob, 5], 0.8, 0.4, 'blood', 2));
      P.push(cap([cx - 10, 25 + bob, 4], [cx - 12, 33 + bob, 4], 2.3, 1.9, skin, 3));
      fist(P, cx - 13, 35 + bob, 3, 1, skin);
      P.push(cap([cx + 11, 25 + bob, 4], [cx + 13 + (work ? 2 : 0), 33 + bob - (work ? 4 : 0), 4], 2.3, 1.9, skin, 4));
      fist(P, cx + 14 + (work ? 2 : 0), 35 + bob - (work ? 4 : 0), 4, 1, skin);
      P.push(drip(cx + 5, 31 + bob, 4, skin));
    }
  }
  if (work && frame === 2) P.push(ell([cx - 2, 38, 6], [0.8, 1.2, 0.8], 'blood', 9)); // falling drip
  return P;
}

// ---- overlord: 96x96 cthulhoid god ----------------------------------------------

function overlordPrims(sway: number, thinking: boolean): Prim[] {
  const P: Prim[] = [];
  // tentacles: 10 flesh chains hanging over the throne — NO emissive lines
  for (let i = 0; i < 10; i++) {
    const bx = 28 + i * 4.4;
    let ax = bx, ay = 60, az = 3;
    for (let s2 = 0; s2 < 5; s2++) {
      const nx2 = ax + Math.sin(sway * 2 + i * 1.1 + s2 * 0.5) * 4;
      const ny2 = ay + 6;
      P.push(cap([ax, ay, az], [nx2, ny2, az], 3 - s2 * 0.45, 2.4 - s2 * 0.45, 'magenta', 8 + i));
      P.push(ell([nx2, ny2 + 1, az + 1.5], [0.7, 0.7, 0.6], 'eel', 8 + i)); // sucker dots
      ax = nx2; ay = ny2;
    }
    // at most 2 carry a faint acid tip
    if (i === 2 || i === 7) P.push(ell([ax, ay + 1, az + 1], [1, 0.9, 0.8], 'acid', 8 + i));
  }
  // fleshy magenta body mass (NO saucer)
  P.push(
    ell([48, 52, 3], [26, 11, 8], 'magenta', 9, 'speckle'),
    ell([30, 58, 2], [11, 9, 5], 'magenta', 9, 'vein'),
    ell([66, 58, 2], [11, 9, 5], 'magenta', 9, 'vein'),
    ell([48, 64, 2], [18, 8, 5], 'magenta', 9, 'speckle'),
  );
  // lamprey ring glimpsed between tentacles
  P.push(ell([48, 70, 8.5], [5.5, 4, 2], 'blood', 9));
  P.push(ell([48, 70, 9.5], [3.5, 2.2, 1.8], 'socket', 9));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    P.push(ell([48 + Math.cos(a) * 4, 70 + Math.sin(a) * 2.6, 10], [0.7, 0.6, 0.6], 'bone', 9));
  }
  // THE central eye in FRONT of the face — z well above the cranium fold
  P.push(ell([48, 46, 14], [9.5, 7.5, 4], 'socket', 9));
  P.push(ell([48, 46, 15.5], [7.5, 6, 3.5], 'bone', 9));           // pale sclera
  P.push(ell([48, 46, 17], [4.2, 4, 2.5], 'acid', 9));             // emissive iris ~8px
  P.push(ell([48, 46, 18.5], [1.3, 3.6, 1.4], 'dark', 9));         // slit pupil
  P.push(ell([45.5, 43.5, 19], [1.1, 1.1, 1], 'spec', 9));         // spec glint
  // 4 smaller eyes around it, one milky — all with spec, all in front
  const smallEyes: [number, number, Mat][] = [[30, 48, 'acid'], [37, 40, 'acid'], [60, 40, 'acid'], [67, 48, 'milk']];
  for (const [ex, ey, m] of smallEyes) {
    P.push(ell([ex, ey, 13], [2.8, 2.3, 1.6], 'socket', 9));
    P.push(ell([ex, ey, 14.5], [1.6, 1.4, 1], m, 9));
    P.push(ell([ex, ey + 0.3, 15.5], [0.7, 0.9, 0.7], 'dark', 9));
    P.push(ell([ex - 0.6, ey - 0.6, 15.8], [0.45, 0.45, 0.5], 'spec', 9));
  }
  // cranium merged INTO the face mass — overlapping, no gap, no teeth ring
  P.push(ell([48, 30, 6], [38, 24, 12], 'eel', 10, 'brain'));
  P.push(ell([26, 26, 8], [10, 9, 7], 'magenta', 10, 'brain'));
  P.push(ell([70, 24, 8], [9, 8.5, 7], 'magenta', 10, 'brain'));
  P.push(ell([48, 40, 6], [24, 12, 9], 'magenta', 10, 'speckle')); // overlap fold
  // steel fluid tubes running SIDEWAYS to the throne; a thin acid line
  // pulses along ~30% of each, on alternating sway frames
  for (let i = 0; i < 3; i++) {
    const tx = 20 + i * 28;
    const side = i === 1 ? 1 : -1;
    P.push(cap([tx, 62, 3], [tx + side * 14, 74, 3], 2.2, 1.9, 'steel', 9));
    P.push(cap([tx + side * 14, 74, 3], [tx + side * 18, 88, 3], 1.9, 1.5, 'steel', 9));
    if ((i + Math.floor(sway)) % 3 !== 0) {
      P.push(cap([tx + side * 2, 64, 5], [tx + side * 7, 69, 5], 0.8, 0.7, 'acid', 9));
    }
  }
  if (thinking) {
    // only the cranium veins flare: thin emissive lines along the gyri
    P.push(cap([34, 14, 12], [40, 12, 12], 0.6, 0.5, 'acid', 10));
    P.push(cap([46, 10, 12], [54, 9, 12], 0.6, 0.5, 'acid', 10));
    P.push(cap([58, 14, 12], [64, 12, 12], 0.6, 0.5, 'acid', 10));
    P.push(ell([48, 42, 13], [4.8, 4.5, 2], 'acid', 9)); // iris flare
  }
  return P;
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
    const data = renderEmissive(46, 44, workerPrims(kind, params(name), frame), hashString(name));
    if (import.meta.env?.DEV && emissiveCoverage(data) > 0.15) {
      console.warn(`emissive mask too dense: ${name}/${kind} f${frame} ${Math.round(emissiveCoverage(data) * 100)}%`);
    }
    const c = document.createElement('canvas');
    c.width = 46; c.height = 44;
    const g = c.getContext('2d')!;
    const img = g.createImageData(46, 44);
    img.data.set(data);
    g.putImageData(img, 0, 0);
    return c;
  });
  if (!flip) return base;
  const fk = key + ':flip';
  const fhit = cache.get(fk);
  if (fhit) return fhit;
  const c = document.createElement('canvas');
  c.width = 46; c.height = 44;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.translate(46, 0); g.scale(-1, 1);
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
  const RIM: Record<Mat, RGB> = { sick: RAMPS.sick[3], bruise: RAMPS.bruise[3], pale: RAMPS.pale[3], steel: RAMPS.steel[4], acid: RAMPS.acid[2], blood: RAMPS.blood[3], bone: RAMPS.bone[2], brass: RAMPS.brass[2], socket: RAMPS.bruise[3], milk: RAMPS.milk[0], dark: RAMPS.dark[0], teal: RAMPS.teal[3], bog: RAMPS.bog[3], magenta: RAMPS.magenta[3], eel: RAMPS.eel[3], spec: RAMPS.spec[0] };
  const rim = RIM[params(name).skin];
  const base = cached(key, () => toCanvas(46, 44, workerPrims(kind, params(name), frame), hashString(name), rim));
  if (!flip) return base;
  const fk = key + ':flip';
  const fhit = cache.get(fk);
  if (fhit) return fhit;
  const c = document.createElement('canvas');
  c.width = 46; c.height = 44;
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

/// Dev-only: force a specific archetype+ramp for the contact sheet.
export function archSprite(kind: AgentKind, arch: number, skin: Mat, frame: number): HTMLCanvasElement {
  const p = { ...params('x'), skin, arch };
  return cached(`arch:${kind}:${arch}:${skin}:${frame}`, () => toCanvas(46, 44, workerPrims(kind, p, frame), 7, RAMPS[skin][3]));
}

/// Dev: flesh-tone histogram per archetype — tone4 <=10%, t2+t3 >=50%, t0+t1 >=20%.
export function hists(): string {
  const out: string[] = [];
  const arches: Record<string, number[]> = { smith: [0, 1, 2], scout: [0], inspector: [0, 1], packer: [0, 1], merchandiser: [0, 1] };
  const skins: Mat[] = ['teal', 'bog', 'magenta', 'eel'];
  for (const [kind, aa] of Object.entries(arches)) {
    for (const a of aa) for (const sk of skins) {
      const p = { ...params('x'), skin: sk, arch: a };
      const hist = [0, 0, 0, 0, 0];
      renderVolume(46, 44, workerPrims(kind as AgentKind, p, 0), 7, undefined, hist);
      const t = hist.reduce((x, y) => x + y, 0) || 1;
      const pct = hist.map((h) => Math.round((h / t) * 100));
      const ok = pct[4] <= 10 && pct[2] + pct[3] >= 50 && pct[0] + pct[1] >= 20;
      out.push(`${kind} a${a} ${sk}: t0-4=${pct.join('/')} ${ok ? 'PASS' : 'FAIL'}`);
    }
  }
  { const hist = [0,0,0,0,0]; renderVolume(96, 96, overlordPrims(0, false), 7, undefined, hist);
    const t = hist.reduce((x,y)=>x+y,0)||1; const pct = hist.map(h=>Math.round(h/t*100));
    out.push(`overlord: t0-4=${pct.join('/')} ${pct[4]<=10&&pct[2]+pct[3]>=50&&pct[0]+pct[1]>=20?'PASS':'FAIL'}`); }
  return out.join(String.fromCharCode(10));
}

/// Dev assert: the overlord's central emissive iris must render >20 px.
export function overlordEyeCheck(): string {
  const data = renderEmissive(96, 96, overlordPrims(0, false), 7);
  let iris = 0;
  for (let y = 38; y < 54; y++) for (let x = 40; x < 56; x++) {
    if (data[(y * 96 + x) * 4 + 3] > 0) iris++;
  }
  return `overlord eye iris px: ${iris} ${iris > 20 ? 'PASS' : 'FAIL'}`;
}
