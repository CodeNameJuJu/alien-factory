// Procedural pixel sprites for the factory floor: small worker aliens seeded
// by name, the big Overlord, bubbles, crates. All Courier New / no smoothing.
import { Sprite, mulberry32, hashString, type RGB } from './pix';
import type { AgentKind } from '../../shared/protocol';

type C = RGB;
const px = (s: Sprite, x: number, y: number, c: C, a = 255) => s.px(x, y, c, a);

const SKIN_HUES: C[] = [
  [96, 200, 110], // green
  [80, 190, 180], // teal
  [160, 110, 210], // purple
];

function outline(s: Sprite, c: C): void {
  const marks: [number, number][] = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 4;
      if (s.data[i + 3] !== 0) continue;
      const nb = (x2: number, y2: number) => {
        if (x2 < 0 || y2 < 0 || x2 >= s.w || y2 >= s.h) return 0;
        return s.data[(y2 * s.w + x2) * 4 + 3];
      };
      if (nb(x + 1, y) || nb(x - 1, y) || nb(x, y + 1) || nb(x, y - 1)) marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) px(s, x, y, c);
}

const cache = new Map<string, HTMLCanvasElement>();

/// A ~12x14 alien worker. frame: 0/1 walk bounce. flip: face left.
export function alienSprite(name: string, kind: AgentKind, frame: number, flip = false): HTMLCanvasElement {
  const key = `${name}:${kind}:${frame}:${flip}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rnd = mulberry32(hashString(name));
  const skin = SKIN_HUES[Math.floor(rnd() * SKIN_HUES.length)];
  const skinD: C = [skin[0] * 0.55, skin[1] * 0.55, skin[2] * 0.55];
  const skinL: C = [Math.min(255, skin[0] + 60), Math.min(255, skin[1] + 60), Math.min(255, skin[2] + 60)];
  const eye: C = [18, 22, 28];
  const dark: C = [14, 16, 22];

  const s = new Sprite(12, 14);
  const bob = frame;
  // antennae
  const a1 = 4 + (rnd() * 2) | 0;
  const a2 = 7 - ((rnd() * 2) | 0);
  s.line(a1, 3 + bob, a1 - 1, 0 + bob, skinD);
  s.line(a2, 3 + bob, a2 + 1, 0 + bob, skinD);
  px(s, a1 - 1, 0 + bob, skinL);
  px(s, a2 + 1, 0 + bob, skinL);
  // head
  s.rect(3, 2 + bob, 6, 5, skin);
  px(s, 2, 4 + bob, skin); px(s, 9, 4 + bob, skin);
  // eyes: two big ones
  s.rect(4, 4 + bob, 1, 2, eye);
  s.rect(7, 4 + bob, 1, 2, eye);
  // body
  s.rect(4, 7 + bob, 4, 4, skinD);
  // legs: alternate with frame
  if (frame === 0) {
    px(s, 4, 11, skinD); px(s, 7, 11, skinD);
    px(s, 4, 12, dark); px(s, 7, 12, dark);
  } else {
    px(s, 3, 11, skinD); px(s, 8, 11, skinD);
    px(s, 3, 12, dark); px(s, 8, 12, dark);
  }
  // kind accessory
  if (kind === 'scout') {
    s.rect(3, 3 + bob, 6, 1, [200, 160, 60]); // goggle strap
    s.rect(3, 4 + bob, 2, 2, [240, 210, 90]);
    s.rect(7, 4 + bob, 2, 2, [240, 210, 90]);
  } else if (kind === 'smith') {
    s.rect(3, 2 + bob, 6, 3, [70, 78, 96]); // welding visor
    s.rect(4, 3 + bob, 4, 1, [140, 200, 230]);
  } else if (kind === 'inspector') {
    s.rect(6, 3 + bob, 3, 3, [230, 210, 120]); // monocle
    s.rect(7, 4 + bob, 1, 1, [60, 60, 80]);
  } else if (kind === 'packer') {
    s.rect(9, 8 + bob, 3, 3, [160, 120, 70]); // little box
    px(s, 10, 8 + bob, [190, 150, 90]);
  }
  outline(s, dark);
  const c = s.toCanvas();
  if (flip) {
    const f = document.createElement('canvas');
    f.width = c.width; f.height = c.height;
    const fc = f.getContext('2d')!;
    fc.imageSmoothingEnabled = false;
    fc.translate(12, 0);
    fc.scale(-1, 1);
    fc.drawImage(c, 0, 0);
    cache.set(key, f);
    return f;
  }
  cache.set(key, c);
  return c;
}

/// The Overlord — ~30x30, brain dome, glowing eyes, swaying tentacles.
/// sway is a time value; thinking adds a pulsing dome glow.
export function overlordSprite(sway: number, thinking: boolean): HTMLCanvasElement {
  const s = new Sprite(30, 30);
  const dark: C = [14, 16, 22];
  const skin: C = [110, 200, 160];
  const skinD: C = [60, 130, 105];
  const dome: C = thinking ? [180, 140, 230] : [140, 110, 200];
  const domeL: C = thinking ? [235, 210, 255] : [200, 170, 240];
  const eye: C = thinking ? [255, 240, 120] : [240, 200, 80];

  // tentacles along the bottom — sway left/right
  for (let i = 0; i < 6; i++) {
    const bx = 5 + i * 4;
    const sw = Math.sin(sway * 2 + i * 1.1) * 2;
    s.line(bx, 24, bx + Math.round(sw), 28 + (i % 2), i % 2 ? skin : skinD);
  }
  // mantle/body
  s.rect(6, 14, 18, 10, skin);
  s.rect(4, 16, 3, 6, skinD);
  s.rect(23, 16, 3, 6, skinD);
  // brain dome
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 30; x++) {
      const dx = (x - 15) / 11;
      const dy = (y - 9) / 8;
      if (dx * dx + dy * dy <= 1) px(s, x, y + 5, dome);
    }
  }
  // dome ridges + pulse highlight
  for (let x = 8; x <= 22; x += 4) s.line(x, 6, x, 12, domeL);
  if (thinking) {
    const p = Math.floor((Math.sin(sway * 6) + 1) * 2);
    s.rect(13, 3, 4, 1, p > 1 ? [255, 255, 255] : domeL);
  }
  // eyes: three glowing slits
  s.rect(9, 17, 3, 2, eye);
  s.rect(14, 17, 3, 2, eye);
  s.rect(19, 17, 3, 2, eye);
  // mouth
  s.rect(13, 21, 5, 1, dark);
  outline(s, dark);
  return s.toCanvas();
}

/// Status bubble: '!' red error, 'z' grey offline, '✓'/'✗' decision flashes.
export function bubble(kind: '!' | 'z' | 'ok' | 'no' | 'work'): HTMLCanvasElement {
  const key = `b:${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = new Sprite(9, 9);
  const bg: C = kind === '!' ? [200, 60, 60] : kind === 'ok' ? [80, 190, 90] : kind === 'no' ? [210, 80, 80] : kind === 'work' ? [220, 170, 60] : [110, 110, 130];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const dx = x - 4, dy = y - 4;
    if (dx * dx + dy * dy <= 16) px(s, x, y, bg);
  }
  const w: C = [250, 245, 235];
  if (kind === '!') {
    s.rect(4, 2, 1, 4, w); px(s, 4, 7, w);
  } else if (kind === 'z') {
    s.rect(3, 2, 4, 1, w); s.line(6, 3, 3, 6, w); s.rect(3, 7, 4, 1, w);
  } else if (kind === 'ok') {
    s.line(2, 5, 4, 7, w); s.line(4, 7, 7, 2, w);
  } else if (kind === 'no') {
    s.line(3, 3, 6, 6, w); s.line(6, 3, 3, 6, w);
  } else {
    s.rect(3, 3, 3, 3, w); px(s, 6, 5, w); px(s, 6, 6, w);
  }
  const c = s.toCanvas();
  cache.set(key, c);
  return c;
}

/// A wooden shipping crate ~14x11.
export function crateSprite(): HTMLCanvasElement {
  const key = 'crate';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = new Sprite(14, 11);
  const wood: C = [150, 112, 62];
  const woodD: C = [104, 74, 40];
  const woodL: C = [188, 148, 90];
  s.rect(0, 0, 14, 11, wood);
  s.rect(0, 0, 14, 1, woodL);
  s.rect(0, 10, 14, 1, woodD);
  s.rect(0, 0, 1, 11, woodL);
  s.rect(13, 0, 1, 11, woodD);
  s.line(1, 1, 12, 9, woodD);
  s.line(12, 1, 1, 9, woodD);
  s.rect(0, 5, 14, 1, woodD);
  const c = s.toCanvas();
  cache.set(key, c);
  return c;
}
