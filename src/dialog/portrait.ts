// ---- dialog/portrait.ts -------------------------------------------------------------------------------------------
// (dialog2) A character's portrait for the dialog: a small pixel bust drawn from their PortraitSpec (contracts/cast.ts,
// rolled from the creature generator's species presets: its palette, head and girth, fur, and a hat and cloth by
// role). Drawn at 32 x 32 on a 2D canvas and shown scaled up, pixelated. A stand-in until the creature generator can
// render a bust of the real rig (BACKLOG DLG-7): the user, round 125, "Use our existing character generator for now
// and let's work on improving one for the future".

import type { PortraitSpec } from '../api/contracts/cast';
import { rng } from '../runplan/rng';

const N = 32;
const cache = new Map<string, string>();

/** the portrait as an image URL (cached by spec) */
export function portraitUrl(p: PortraitSpec): string {
  const key = JSON.stringify(p);
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  drawPortrait(c.getContext('2d')!, p);
  // (scaled up pixelated so the browser's own smoothing doesn't blur the pixels)
  const big = document.createElement('canvas');
  big.width = big.height = N * 4;
  const g = big.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(c, 0, 0, N * 4, N * 4);
  const url = big.toDataURL();
  cache.set(key, url);
  return url;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function drawPortrait(g: CanvasRenderingContext2D, p: PortraitSpec): void {
  const r = rng(p.seed);
  const pal = p.palette;
  const px = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
  const ell = (cx: number, cy: number, rx: number, ry: number, col: string) => {
    g.fillStyle = col;
    for (let y = -ry; y <= ry; y++) {
      const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))));
      g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
    }
  };
  // background: a warm vignette
  px(0, 0, N, N, '#2a2219');
  ell(16, 14, 15, 14, '#3a2f22');
  const gnoll = p.species === 'gnoll';
  const skel = p.species === 'skeleton';
  // shoulders and cloth
  const sw = 11 + p.girth * 3;
  for (let y = 23; y < N; y++) px(16 - sw + (31 - y) * 0.4, y, (sw - (31 - y) * 0.4) * 2, 1, shade(p.cloth, y === 23 ? 1.2 : 1));
  px(14, 21, 4, 3, shade(pal.belly ?? pal.body, 0.85));
  // fur ruff
  if (p.fur > 0.2) for (let i = 0; i < 9; i++) ell(9 + i * 1.8, 22 + (i % 2), 2, 1 + p.fur, shade(p.fur_colour ?? pal.accent ?? pal.body, 0.9 + r() * 0.2));
  // the head
  const hr = 6.5 * p.head;
  const hy = 13;
  if (gnoll) {
    // pointed ears, a long muzzle
    for (const s of [-1, 1]) for (let i = 0; i < 5; i++) px(16 + s * (hr - 2) - (s < 0 ? i * 0.3 : -i * 0.3) - 1, hy - hr - 3 + i, 3 - i * 0.4, 1, shade(pal.body, 0.8));
    ell(16, hy, hr, hr * 0.95, pal.body);
    ell(16, hy + 3, hr * 0.55, hr * 0.45, pal.belly ?? pal.body);
    px(15, hy + 1, 2, 2, '#1a120a');
    // spots
    for (let i = 0; i < 4; i++) px(16 - hr + 2 + r() * hr * 1.6, hy - hr + 2 + r() * hr, 1, 1, shade(pal.accent ?? pal.body, 1));
  } else {
    ell(16, hy, hr * 0.85, hr, skel ? pal.body : pal.belly ?? pal.body);
    // hair
    if (!skel) {
      const hair = shade(pal.accent ?? '#3a2c24', 0.9 + r() * 0.5);
      ell(16, hy - hr * 0.55, hr * 0.9, hr * 0.5, hair);
      if (r() < 0.4) px(16 - hr * 0.85, hy - 2, 2, 6, hair);
      if (r() < 0.4) px(16 + hr * 0.85 - 2, hy - 2, 2, 6, hair);
      // a beard, sometimes
      if (r() < 0.3) ell(16, hy + hr * 0.6, hr * 0.5, hr * 0.35, hair);
    }
    px(15, hy + 2, 2, 1, shade(pal.belly ?? pal.body, 0.75));
  }
  // eyes
  const ey = hy - (gnoll ? 1 : 0);
  for (const s of [-1, 1]) {
    px(16 + s * 2.5 - 1, ey, 2, 2, skel ? '#0a0a0a' : '#f4ecdc');
    px(16 + s * 2.5 - (s < 0 ? 0 : 1), ey + 0.5, 1, 1, pal.eye ?? '#111111');
  }
  // the hat
  const hc = p.hat_colour;
  const top = hy - hr;
  if (p.hat === 'hood') {
    ell(16, hy - 1, hr + 2, hr + 2, shade(hc, 0.8));
    ell(16, hy + 1, hr * 0.8, hr * 0.85, gnoll ? pal.body : pal.belly ?? pal.body);
    for (const s of [-1, 1]) {
      px(16 + s * 2.5 - 1, ey, 2, 2, '#f4ecdc');
      px(16 + s * 2.5 - (s < 0 ? 0 : 1), ey + 0.5, 1, 1, pal.eye ?? '#111111');
    }
  } else if (p.hat === 'helm') {
    ell(16, top + 3, hr + 1, 4, '#8a8f96');
    px(16 - hr - 1, top + 3, (hr + 1) * 2, 2, '#6a6f76');
    px(15, top + 3, 2, 6, '#6a6f76');
  } else if (p.hat === 'cap') {
    ell(16, top + 2, hr * 0.9, 3, hc);
    px(16 - hr, top + 3, hr * 2 + 2, 1, shade(hc, 0.7));
  } else if (p.hat === 'circlet') {
    px(16 - hr * 0.8, top + 3, hr * 1.6, 1, '#e0b84a');
    px(15, top + 2, 2, 1, '#ff6a5a');
  } else if (p.hat === 'scarf') {
    px(16 - sw * 0.6, 21, sw * 1.2, 3, hc);
    px(16 + 3, 23, 2, 4, shade(hc, 0.8));
  }
}
