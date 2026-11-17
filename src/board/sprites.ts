// (board, docs/design/BOARD.md) Every sprite of the board, drawn once in code into an offscreen canvas ("baked") and
// blitted after. Flat-shaded isometric shapes under one colour rule: the ground and the buildings muted, the figures
// bright, one red kept for foes (FOE) and one cyan for what you can act on (ACT). A placeholder for real art: the 3D
// engine can later bake its own tiles and sprites into the same slots (BACKLOG BD-2).

/** a tile's half width and half height in world pixels */
export const HW = 32;
export const HH = 16;
/** sprites are baked at this many device pixels per world pixel */
export const BAKE = 2;

/** reserved colours: nothing else on the board uses them */
export const FOE = '#ff3b30';
export const ACT = '#2ee6ff';

export const C = {
  grass: '#66734f',
  grass2: '#6d7a55',
  road: '#a3967a',
  water: '#46697f',
  water2: '#52788e',
  sand: '#ad9f7c',
  rock: '#7a736c',
  rock2: '#6e6862',
  field: '#958655',
  field2: '#837548',
  forest: '#4a5a40',
  ash: '#55524f',
  ash2: '#4a4745',
  lava: '#ff7a1a',
  lavaCrust: '#2f2724',
  flood: '#5f8ea8',
  mud: '#7d6a50',
  lush: '#4d8a3a',
  dry: '#8d7f5c',
  wall: '#c4b597',
  wallL: '#a89a7e',
  wallR: '#8f836b',
  stone: '#a9a49b',
  stoneL: '#8f8a82',
  stoneR: '#7a756e',
  wood: '#8a6c4c',
  woodL: '#735a40',
  woodR: '#5f4a35',
  roof: '#8b5a46',
  roofD: '#6e4637',
  slate: '#5f6672',
  slateD: '#4c525c',
  ink: '#1d1b19',
  crew: '#ffcf3a',
  soldier: '#f4f6ff',
  helm: '#3d5bd6',
  undead: '#b8f08a',
  messenger: '#ffffff',
  cloak: '#a46bff',
  // (townspeople: soft colours, so the player's own pieces — the crews' yellow, the soldiers' white and blue — stand out)
  folk: ['#c79aaa', '#a597c4', '#93b89e', '#9fb2c6', '#bba98f', '#b7a3bf'],
};

export interface Sprite {
  img: HTMLCanvasElement | OffscreenCanvas;
  /** anchor (the ground point) in world pixels from the image's top-left */
  ax: number;
  ay: number;
  w: number;
  h: number;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const canvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.ceil(w * BAKE), Math.ceil(h * BAKE));
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * BAKE);
  c.height = Math.ceil(h * BAKE);
  return c;
};

/** a sprite w×h world pixels with its anchor at (ax, ay); `draw` works in world pixels with the anchor at 0,0 */
export function bake(w: number, h: number, ax: number, ay: number, draw: (g: Ctx) => void): Sprite {
  const img = canvas(w, h);
  const g = img.getContext('2d') as Ctx;
  g.scale(BAKE, BAKE);
  g.translate(ax, ay);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  draw(g);
  return { img, ax, ay, w, h };
}

const poly = (g: Ctx, pts: number[], fill: string, stroke?: string): void => {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = 0.6;
    g.stroke();
  }
};
/** the screen point of a ground point (u along the tile's x, v along its y, in tiles) at height z (pixels) */
const P = (u: number, v: number, z = 0): [number, number] => [(u - v) * HW, (u + v) * HH - z];

/** a box on the ground: footprint u0..u1 × v0..v1 (tiles, from the anchor), base z0, height h */
export function box(g: Ctx, u0: number, v0: number, u1: number, v1: number, h: number, top: string, left: string, right: string, z0 = 0): void {
  const a = P(u0, v1, z0), b = P(u1, v1, z0), c = P(u1, v0, z0);
  const a2 = P(u0, v1, z0 + h), b2 = P(u1, v1, z0 + h), c2 = P(u1, v0, z0 + h), d2 = P(u0, v0, z0 + h);
  poly(g, [...a, ...b, ...b2, ...a2], left, C.ink + '55');
  poly(g, [...b, ...c, ...c2, ...b2], right, C.ink + '55');
  poly(g, [...a2, ...b2, ...c2, ...d2], top, C.ink + '55');
}
/** a gable roof on a box top (ridge along u) */
export function roof(g: Ctx, u0: number, v0: number, u1: number, v1: number, z: number, rise: number, col: string, dark: string): void {
  const vm = (v0 + v1) / 2;
  const r0 = P(u0, vm, z + rise), r1 = P(u1, vm, z + rise);
  // back slope, then the gable end, then the front slope
  poly(g, [...P(u0, v0, z), ...P(u1, v0, z), ...r1, ...r0], dark, C.ink + '66');
  poly(g, [...P(u1, v0, z), ...P(u1, v1, z), ...r1], dark, C.ink + '66');
  poly(g, [...P(u0, v1, z), ...P(u1, v1, z), ...r1, ...r0], col, C.ink + '66');
}
/** a pyramid roof */
function spire(g: Ctx, u0: number, v0: number, u1: number, v1: number, z: number, rise: number, col: string, dark: string): void {
  const t = P((u0 + u1) / 2, (v0 + v1) / 2, z + rise);
  poly(g, [...P(u0, v1, z), ...P(u1, v1, z), ...t], col, C.ink + '66');
  poly(g, [...P(u1, v1, z), ...P(u1, v0, z), ...t], dark, C.ink + '66');
}
const house = (g: Ctx, u: number, v: number, s = 0.3, h = 12, rc = C.roof, rd = C.roofD): void => {
  box(g, u - s, v - s * 0.8, u + s, v + s * 0.8, h, C.wall, C.wallL, C.wallR);
  roof(g, u - s, v - s * 0.8, u + s, v + s * 0.8, h, 9, rc, rd);
};
const tree = (g: Ctx, u: number, v: number, s = 1): void => {
  const [x, y] = P(u, v);
  g.fillStyle = C.woodR;
  g.fillRect(x - 1, y - 6 * s, 2, 6 * s);
  g.beginPath();
  g.moveTo(x, y - 22 * s);
  g.lineTo(x + 7 * s, y - 5 * s);
  g.lineTo(x - 7 * s, y - 5 * s);
  g.closePath();
  g.fillStyle = C.forest;
  g.fill();
  g.strokeStyle = C.ink + '55';
  g.lineWidth = 0.6;
  g.stroke();
};
const flag = (g: Ctx, u: number, v: number, h: number, col: string): void => {
  const [x, y] = P(u, v);
  g.strokeStyle = C.ink;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y - h);
  g.stroke();
  poly(g, [x, y - h, x + 9, y - h + 3, x, y - h + 6], col);
};

/** the buildings and features, by look name */
const BUILD: Record<string, () => Sprite> = {
  'keep-yard': () => bake(96, 80, 48, 64, (g) => {
    box(g, -0.5, -0.4, 0.4, 0.4, 16, C.stone, C.stoneL, C.stoneR);
    roof(g, -0.5, -0.4, 0.4, 0.4, 16, 10, C.slate, C.slateD);
  }),
  keep: () => bake(128, 140, 64, 116, (g) => {
    box(g, -0.8, -0.8, 0.8, 0.8, 22, C.stone, C.stoneL, C.stoneR);
    box(g, -0.45, -0.45, 0.45, 0.45, 40, C.stone, C.stoneL, C.stoneR, 22);
    spire(g, -0.45, -0.45, 0.45, 0.45, 62, 22, C.slate, C.slateD);
    flag(g, 0, 0, 98, '#d9c48a');
  }),
  'houses-few': () => bake(96, 80, 48, 60, (g) => {
    house(g, -0.25, -0.2);
    house(g, 0.25, 0.25, 0.28, 10);
  }),
  houses: () => bake(110, 90, 55, 66, (g) => {
    house(g, -0.35, -0.3, 0.28, 14);
    house(g, 0.3, -0.3, 0.25, 12, C.slate, C.slateD);
    house(g, -0.3, 0.3, 0.25, 11);
    house(g, 0.3, 0.3, 0.28, 15);
  }),
  plot: () => bake(64, 56, 32, 42, (g) => house(g, 0, 0, 0.3, 11)),
  plot2: () => bake(64, 56, 32, 42, (g) => house(g, 0, 0, 0.26, 13, C.slate, C.slateD)),
  'forge-shed': () => bake(96, 80, 48, 60, (g) => {
    box(g, -0.4, -0.3, 0.4, 0.3, 10, C.wood, C.woodL, C.woodR);
    roof(g, -0.4, -0.3, 0.4, 0.3, 10, 6, C.slate, C.slateD);
  }),
  forge: () => bake(110, 100, 55, 78, (g) => {
    box(g, -0.5, -0.4, 0.5, 0.4, 16, C.stone, C.stoneL, C.stoneR);
    roof(g, -0.5, -0.4, 0.5, 0.4, 16, 8, C.slate, C.slateD);
    box(g, 0.2, -0.3, 0.4, -0.1, 34, C.stoneR, C.stoneL, C.stoneR);
  }),
  carts: () => bake(80, 50, 40, 34, (g) => {
    box(g, -0.3, -0.15, 0.0, 0.1, 6, C.wood, C.woodL, C.woodR);
    box(g, 0.1, 0.1, 0.4, 0.35, 6, C.wood, C.woodL, C.woodR);
  }),
  market: () => bake(110, 80, 55, 54, (g) => {
    box(g, -0.6, -0.6, 0.6, 0.6, 1, C.road, C.road, C.road);
    for (const [u, v, c] of [[-0.3, -0.3, '#a36b5a'], [0.3, -0.3, '#7b8a6a'], [-0.3, 0.3, '#8a7a9a'], [0.3, 0.3, '#a38a5a']] as [number, number, string][]) {
      box(g, u - 0.16, v - 0.16, u + 0.16, v + 0.16, 8, C.wood, C.woodL, C.woodR);
      roof(g, u - 0.2, v - 0.2, u + 0.2, v + 0.2, 8, 5, c, c);
    }
  }),
  'gate-posts': () => bake(80, 70, 40, 54, (g) => {
    box(g, -0.4, -0.1, -0.25, 0.05, 20, C.wood, C.woodL, C.woodR);
    box(g, 0.25, -0.1, 0.4, 0.05, 20, C.wood, C.woodL, C.woodR);
  }),
  gate: () => bake(110, 100, 55, 78, (g) => {
    box(g, -0.6, -0.25, -0.2, 0.25, 30, C.stone, C.stoneL, C.stoneR);
    box(g, 0.2, -0.25, 0.6, 0.25, 30, C.stone, C.stoneL, C.stoneR);
    box(g, -0.6, -0.25, 0.6, 0.25, 8, C.stone, C.stoneL, C.stoneR, 30);
    spire(g, -0.6, -0.25, -0.2, 0.25, 30, 10, C.slate, C.slateD);
    spire(g, 0.2, -0.25, 0.6, 0.25, 30, 10, C.slate, C.slateD);
  }),
  'tower-old': () => bake(80, 120, 40, 102, (g) => {
    box(g, -0.25, -0.25, 0.25, 0.25, 56, C.stone, C.stoneL, C.stoneR);
    box(g, -0.3, -0.3, 0.3, 0.3, 6, C.stone, C.stoneL, C.stoneR, 56);
  }),
  dam: () => bake(110, 70, 55, 44, (g) => box(g, -0.7, -0.2, 0.7, 0.2, 12, C.stone, C.stoneL, C.stoneR)),
  'shrine-stone': () => bake(80, 80, 40, 62, (g) => {
    box(g, -0.3, -0.3, 0.3, 0.3, 4, C.stone, C.stoneL, C.stoneR);
    box(g, -0.08, -0.08, 0.08, 0.08, 26, '#c9c2d9', '#a9a2b9', '#8f88a0', 4);
  }),
  shrine: () => bake(100, 100, 50, 78, (g) => {
    box(g, -0.4, -0.4, 0.4, 0.4, 4, C.stone, C.stoneL, C.stoneR);
    box(g, -0.28, -0.28, 0.28, 0.28, 18, '#d6cfe4', '#b5aec6', '#9a93ab', 4);
    spire(g, -0.32, -0.32, 0.32, 0.32, 22, 20, '#7d6aa0', '#62537f');
  }),
  mill: () => bake(100, 110, 50, 86, (g) => {
    box(g, -0.35, -0.3, 0.35, 0.3, 22, C.wall, C.wallL, C.wallR);
    roof(g, -0.35, -0.3, 0.35, 0.3, 22, 10, C.roof, C.roofD);
    const [x, y] = P(0.35, 0, 22);
    g.strokeStyle = C.woodR;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x - 14, y - 14);
    g.lineTo(x + 14, y + 14);
    g.moveTo(x + 14, y - 14);
    g.lineTo(x - 14, y + 14);
    g.stroke();
  }),
  hut: () => bake(70, 60, 35, 46, (g) => {
    box(g, -0.2, -0.2, 0.2, 0.2, 9, C.wood, C.woodL, C.woodR);
    roof(g, -0.2, -0.2, 0.2, 0.2, 9, 6, C.roof, C.roofD);
  }),
  jetty: () => bake(80, 50, 40, 30, (g) => box(g, -0.1, -0.2, 0.15, 0.7, 3, C.wood, C.woodL, C.woodR)),
  quay: () => bake(110, 80, 55, 50, (g) => {
    box(g, -0.6, -0.3, 0.6, 0.6, 5, C.stone, C.stoneL, C.stoneR);
    box(g, -0.4, -0.3, 0.0, 0.0, 12, C.wood, C.woodL, C.woodR, 5);
    roof(g, -0.4, -0.3, 0.0, 0.0, 17, 6, C.roof, C.roofD);
  }),
  'quarry-rock': () => bake(90, 70, 45, 50, (g) => {
    box(g, -0.4, -0.3, 0.2, 0.3, 14, C.rock, C.rock2, C.ink + '88');
    box(g, 0.0, -0.1, 0.4, 0.3, 8, C.rock, C.rock2, C.ink + '88');
  }),
  quarry: () => bake(100, 90, 50, 64, (g) => {
    box(g, -0.5, -0.4, 0.1, 0.1, 18, C.rock, C.rock2, C.ink + '88');
    for (const [u, v] of [[0.2, 0.2], [0.35, 0.0], [0.05, 0.35]]) box(g, u - 0.1, v - 0.1, u + 0.1, v + 0.1, 6, C.stone, C.stoneL, C.stoneR);
    const [x, y] = P(0.25, -0.25, 0);
    g.strokeStyle = C.woodR;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - 32);
    g.lineTo(x - 16, y - 20);
    g.stroke();
  }),
  trees: () => bake(96, 70, 48, 54, (g) => {
    tree(g, -0.3, -0.2);
    tree(g, 0.2, -0.3, 1.2);
    tree(g, 0.1, 0.25, 0.9);
    tree(g, -0.25, 0.3, 1.1);
  }),
  lumber: () => bake(100, 70, 50, 50, (g) => {
    tree(g, -0.35, -0.3, 1.1);
    box(g, -0.1, 0.0, 0.4, 0.25, 7, C.wood, C.woodL, C.woodR);
    for (let i = 0; i < 3; i++) box(g, -0.4 + i * 0.12, 0.2, -0.3 + i * 0.12, 0.5, 4, '#b08a5c', C.woodL, C.woodR, i % 2 ? 4 : 0);
  }),
  milestone: () => bake(40, 40, 20, 30, (g) => box(g, -0.06, -0.06, 0.06, 0.06, 10, C.stone, C.stoneL, C.stoneR)),
  waystation: () => bake(100, 80, 50, 56, (g) => {
    box(g, -0.4, -0.3, 0.3, 0.3, 14, C.wall, C.wallL, C.wallR);
    roof(g, -0.4, -0.3, 0.3, 0.3, 14, 8, C.roof, C.roofD);
    flag(g, 0.45, 0.2, 30, '#d9c48a');
  }),
  'ore-heap': () => bake(80, 50, 40, 32, (g) => {
    poly(g, [...P(-0.3, 0.2), ...P(0.3, 0.2), ...P(0, 0, 14)], '#6a5f58', C.ink + '66');
    poly(g, [...P(0.3, 0.2), ...P(0.3, -0.2), ...P(0, 0, 14)], '#544b45', C.ink + '66');
  }),
  wagons: () => bake(90, 50, 45, 34, (g) => {
    box(g, -0.4, -0.2, -0.05, 0.05, 8, C.wood, C.woodL, C.woodR);
    box(g, 0.05, 0.0, 0.4, 0.25, 8, C.wood, C.woodL, C.woodR);
  }),
  graves: () => bake(90, 50, 45, 34, (g) => {
    for (const [u, v] of [[-0.3, -0.2], [0, -0.25], [0.3, -0.1], [-0.2, 0.2], [0.15, 0.2]]) box(g, u - 0.05, v - 0.02, u + 0.05, v + 0.02, 8, C.stone, C.stoneL, C.stoneR);
  }),
  barn: () => bake(90, 70, 45, 52, (g) => {
    box(g, -0.3, -0.25, 0.3, 0.25, 12, '#9a5a44', '#83493a', '#6e3d31');
    roof(g, -0.3, -0.25, 0.3, 0.25, 12, 8, C.slate, C.slateD);
  }),
  // (the works' things)
  mine: () => bake(100, 100, 50, 80, (g) => {
    box(g, -0.4, -0.4, 0.4, 0.4, 3, C.rock2, C.rock2, C.rock2);
    const [x, y] = P(0, 0, 3);
    g.strokeStyle = C.woodR;
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(x - 14, y);
    g.lineTo(x, y - 40);
    g.lineTo(x + 14, y);
    g.moveTo(x - 8, y - 20);
    g.lineTo(x + 8, y - 20);
    g.stroke();
    g.beginPath();
    g.arc(x, y - 40, 5, 0, Math.PI * 2);
    g.stroke();
  }),
  stalls: () => bake(100, 70, 50, 48, (g) => {
    for (const [u, c] of [[-0.3, '#b56a4a'], [0.05, '#5a8a9a'], [0.4, '#b5a04a']] as [number, string][]) {
      box(g, u - 0.13, -0.15, u + 0.13, 0.15, 7, C.wood, C.woodL, C.woodR);
      roof(g, u - 0.16, -0.18, u + 0.16, 0.18, 9, 5, c, c);
    }
  }),
  foundry: () => bake(110, 110, 55, 90, (g) => {
    box(g, -0.5, -0.4, 0.4, 0.4, 18, C.stoneR, C.stoneL, C.stoneR);
    roof(g, -0.5, -0.4, 0.4, 0.4, 18, 7, C.slateD, C.slateD);
    box(g, 0.15, -0.35, 0.35, -0.15, 44, '#8a5040', '#743f33', '#5e3329');
  }),
  muster: () => bake(100, 80, 50, 56, (g) => {
    box(g, -0.6, -0.5, 0.6, 0.5, 1, C.road, C.road, C.road);
    flag(g, -0.3, -0.3, 34, C.helm);
    for (const [u, v] of [[0.3, 0.0], [0.1, 0.3]]) box(g, u - 0.12, v - 0.04, u + 0.12, v + 0.04, 7, C.wood, C.woodL, C.woodR);
  }),
  granary: () => bake(90, 100, 45, 80, (g) => {
    const [x, y] = P(0, 0);
    g.fillStyle = C.wallL;
    g.fillRect(x - 13, y - 30, 26, 30);
    g.fillStyle = C.wall;
    g.fillRect(x - 13, y - 30, 13, 30);
    g.beginPath();
    g.ellipse(x, y, 13, 6, 0, 0, Math.PI);
    g.fill();
    poly(g, [x - 16, y - 30, x + 16, y - 30, x, y - 52], C.roof, C.ink + '66');
  }),
  watchtower: () => bake(80, 140, 40, 124, (g) => {
    const [x, y] = P(0, 0);
    g.strokeStyle = C.woodR;
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(x - 10, y);
    g.lineTo(x - 7, y - 60);
    g.moveTo(x + 10, y);
    g.lineTo(x + 7, y - 60);
    g.moveTo(x - 9, y - 30);
    g.lineTo(x + 9, y - 30);
    g.stroke();
    box(g, -0.22, -0.22, 0.22, 0.22, 10, C.wood, C.woodL, C.woodR, 60);
    spire(g, -0.26, -0.26, 0.26, 0.26, 70, 16, C.roof, C.roofD);
  }),
  'wall-walk': () => bake(130, 90, 65, 62, (g) => {
    box(g, -0.9, -0.15, 0.9, 0.15, 22, C.stone, C.stoneL, C.stoneR);
    for (let i = 0; i < 5; i++) box(g, -0.85 + i * 0.4, -0.15, -0.7 + i * 0.4, 0.15, 5, C.stone, C.stoneL, C.stoneR, 22);
  }),
  hall: () => bake(110, 100, 55, 76, (g) => {
    box(g, -0.5, -0.35, 0.5, 0.35, 18, C.wall, C.wallL, C.wallR);
    roof(g, -0.5, -0.35, 0.5, 0.35, 18, 14, '#7a6a8a', '#615470');
  }),
  'policy-flag': () => bake(40, 60, 12, 50, (g) => flag(g, 0, 0, 40, '#d9c48a')),
  rubble: () => bake(100, 60, 50, 40, (g) => {
    box(g, -0.45, -0.3, -0.1, 0.0, 9, C.stoneL, C.stoneL, C.stoneR);
    box(g, 0.0, -0.2, 0.35, 0.05, 5, C.stoneL, C.stoneL, C.stoneR);
    box(g, -0.2, 0.15, 0.25, 0.35, 3, C.stoneR, C.stoneR, C.stoneR);
  }),
  'rubble-burned': () => bake(100, 60, 50, 40, (g) => {
    box(g, -0.45, -0.3, -0.1, 0.0, 9, '#3d3936', '#2f2b29', '#262321');
    box(g, 0.0, -0.2, 0.35, 0.05, 5, '#3d3936', '#2f2b29', '#262321');
    box(g, -0.2, 0.15, 0.25, 0.35, 3, '#2f2b29', '#262321', '#262321');
  }),
  'wall-ring': () => bake(64, 50, 32, 34, (g) => box(g, -0.5, -0.12, 0.5, 0.12, 14, C.stone, C.stoneL, C.stoneR)),
  'wall-ring-v': () => bake(64, 50, 32, 34, (g) => box(g, -0.12, -0.5, 0.12, 0.5, 14, C.stone, C.stoneL, C.stoneR)),
  boat: () => bake(60, 40, 30, 26, (g) => {
    poly(g, [...P(-0.3, -0.08), ...P(0.3, -0.08), ...P(0.38, 0), ...P(0.3, 0.08), ...P(-0.3, 0.08)], C.woodL, C.ink + '88');
  }),
  tent: () => bake(60, 50, 30, 36, (g) => {
    poly(g, [...P(-0.25, 0.2), ...P(0.25, 0.2), ...P(0, 0, 18)], '#8a6a4a', C.ink + '88');
    poly(g, [...P(0.25, 0.2), ...P(0.25, -0.2), ...P(0, 0, 18)], '#6a5038', C.ink + '88');
  }),
};

const cache = new Map<string, Sprite>();
export function sprite(name: string): Sprite {
  let s = cache.get(name);
  if (!s) {
    const f = BUILD[name] ?? FIG[name];
    if (!f) throw new Error(`board: no sprite ${name}`);
    s = f();
    cache.set(name, s);
  }
  return s;
}
export const spriteCount = (): number => cache.size;

// ---- figures: bright, outlined, two frames each (step / work) -------------------------------------------------------

function person(g: Ctx, body: string, head: string, frame: number, extra?: (g: Ctx) => void, ring = false): void {
  if (ring) {
    // (the player's pieces stand on a dark disc: they read against any ground)
    g.fillStyle = 'rgba(10,10,12,0.55)';
    g.beginPath();
    g.ellipse(0, 0, 8, 3.5, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = C.ink;
  g.lineWidth = 1.4;
  // legs
  const s = frame ? 2.5 : 0.8;
  g.beginPath();
  g.moveTo(-1.5, -7);
  g.lineTo(-1.5 - s, 0);
  g.moveTo(1.5, -7);
  g.lineTo(1.5 + s, 0);
  g.stroke();
  // body
  g.beginPath();
  g.moveTo(-4.5, -7);
  g.lineTo(4.5, -7);
  g.lineTo(3.5, -17);
  g.lineTo(-3.5, -17);
  g.closePath();
  g.fillStyle = body;
  g.fill();
  g.lineWidth = 1.1;
  g.stroke();
  // head
  g.beginPath();
  g.arc(0, -20.5, 3.4, 0, Math.PI * 2);
  g.fillStyle = head;
  g.fill();
  g.stroke();
  extra?.(g);
}
const SKIN = '#f0c9a0';
const fig = (draw: (g: Ctx) => void): (() => Sprite) => () => bake(28, 34, 14, 31, draw);

const FIG: Record<string, () => Sprite> = {};
for (const f of [0, 1]) {
  FIG[`crew${f}`] = fig((g) => person(g, C.crew, SKIN, f, undefined, true));
  // (a crew at work: the hammer up, then down)
  FIG[`crewwork${f}`] = fig((g) =>
    person(g, C.crew, SKIN, 0, (g) => {
      g.strokeStyle = C.ink;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(3.5, -15);
      if (f) g.lineTo(9, -24);
      else g.lineTo(10, -9);
      g.stroke();
      g.fillStyle = '#555';
      g.fillRect(f ? 7 : 8.5, f ? -27 : -10.5, 4, 3);
    }, true),
  );
  FIG[`soldier${f}`] = fig((g) =>
    person(g, C.soldier, SKIN, f, (g) => {
      g.beginPath();
      g.arc(0, -21.5, 3.6, Math.PI, 0);
      g.fillStyle = C.helm;
      g.fill();
      g.strokeStyle = C.ink;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(6, -2);
      g.lineTo(6, -30);
      g.stroke();
      g.fillStyle = C.helm;
      g.fillRect(-7, -16, 4, 7);
    }, true),
  );
  FIG[`raider${f}`] = fig((g) =>
    person(g, FOE, '#e0b090', f, (g) => {
      g.strokeStyle = C.ink;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(4, -14);
      g.lineTo(f ? 9 : 7, f ? -24 : -26);
      g.stroke();
      g.fillStyle = '#ccc';
      g.fillRect(f ? 7 : 5, f ? -26 : -28, 4, 4);
    }),
  );
  // (the dead are foes: the foes' red, with a pale head)
  FIG[`undead${f}`] = fig((g) => person(g, FOE, C.undead, f));
  FIG[`thief${f}`] = fig((g) => person(g, '#3a3540', '#3a3540', f));
  FIG[`messenger${f}`] = fig((g) =>
    person(g, C.cloak, SKIN, f, (g) => {
      g.fillStyle = '#fff3c4';
      g.fillRect(4, -16, 4, 6);
    }),
  );
  for (let k = 0; k < C.folk.length; k++) FIG[`folk${k}_${f}`] = fig((g) => person(g, C.folk[k], SKIN, f));
  FIG[`horse${f}`] = () =>
    bake(44, 40, 22, 36, (g) => {
      g.strokeStyle = C.ink;
      g.lineWidth = 1.2;
      const l = f ? 3 : 0;
      g.beginPath();
      g.moveTo(-8, -9);
      g.lineTo(-9 - l, 0);
      g.moveTo(-4, -9);
      g.lineTo(-4 + l, 0);
      g.moveTo(5, -9);
      g.lineTo(4 - l, 0);
      g.moveTo(9, -9);
      g.lineTo(10 + l, 0);
      g.stroke();
      g.fillStyle = '#8a5a3a';
      g.beginPath();
      g.ellipse(0, -12, 12, 5, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(9, -14);
      g.lineTo(15, -22);
      g.lineTo(18, -19);
      g.lineTo(12, -11);
      g.fill();
      g.stroke();
      g.translate(-1, -13);
      person(g, C.cloak, SKIN, 0);
    });
  FIG[`cart${f}`] = () =>
    bake(56, 40, 28, 34, (g) => {
      g.strokeStyle = C.ink;
      g.lineWidth = 1.2;
      g.fillStyle = C.wood;
      g.fillRect(-20, -14, 22, 9);
      g.strokeRect(-20, -14, 22, 9);
      g.fillStyle = '#d9c48a';
      g.fillRect(-18, -19, 18, 5);
      for (const x of [-15, -3]) {
        g.beginPath();
        g.arc(x, -4, 4, 0, Math.PI * 2);
        g.fillStyle = C.woodR;
        g.fill();
        g.stroke();
      }
      g.fillStyle = '#8a5a3a';
      g.beginPath();
      g.ellipse(13, -11, 8, 4, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(10, -9);
      g.lineTo(9 + (f ? 2 : 0), 0);
      g.moveTo(17, -9);
      g.lineTo(18 - (f ? 2 : 0), 0);
      g.stroke();
    });
  FIG[`ship${f}`] = () =>
    bake(60, 56, 30, 46, (g) => {
      g.strokeStyle = C.ink;
      g.lineWidth = 1.2;
      g.fillStyle = C.woodL;
      g.beginPath();
      g.moveTo(-22, -8);
      g.lineTo(22, -8);
      g.lineTo(15, 0 + f);
      g.lineTo(-16, 0 + f);
      g.closePath();
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(0, -8);
      g.lineTo(0, -40);
      g.stroke();
      g.fillStyle = '#efe6cf';
      g.beginPath();
      g.moveTo(1, -38);
      g.lineTo(16, -14);
      g.lineTo(1, -12);
      g.closePath();
      g.fill();
      g.stroke();
    });
}

/** a ground tile diamond, baked; `kind` a colour pair (and a pattern) */
export function tileSprite(name: string, top: string, alt: string, pattern?: 'furrows' | 'waves' | 'cracks' | 'dots'): Sprite {
  const key = `tile:${name}`;
  let s = cache.get(key);
  if (s) return s;
  s = bake(HW * 2, HH * 2 + 1, HW, HH, (g) => {
    poly(g, [0, -HH, HW, 0, 0, HH, -HW, 0], top);
    g.save();
    g.beginPath();
    g.moveTo(0, -HH);
    g.lineTo(HW, 0);
    g.lineTo(0, HH);
    g.lineTo(-HW, 0);
    g.closePath();
    g.clip();
    g.strokeStyle = alt;
    g.fillStyle = alt;
    g.lineWidth = 2;
    if (pattern === 'furrows') for (let i = -3; i <= 3; i++) {
      g.beginPath();
      g.moveTo(-HW + 8 * (i + 3) - 24, -HH);
      g.lineTo(-HW + 8 * (i + 3) + 8, HH);
      g.stroke();
    }
    if (pattern === 'waves') for (let i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(-14 + i * 10, i * 6);
      g.quadraticCurveTo(-7 + i * 10, i * 6 - 3, i * 10, i * 6);
      g.stroke();
    }
    if (pattern === 'cracks') {
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(-20, 0);
      g.lineTo(-6, -4);
      g.lineTo(4, 3);
      g.lineTo(18, -2);
      g.moveTo(-4, -4);
      g.lineTo(-2, -12);
      g.moveTo(4, 3);
      g.lineTo(2, 11);
      g.stroke();
    }
    if (pattern === 'dots') for (const [x, y] of [[-12, -2], [6, -6], [10, 5], [-3, 6], [-18, 3]]) g.fillRect(x, y, 2.5, 2.5);
    g.restore();
    // (a faint edge so the grid reads)
    poly(g, [0, -HH, HW, 0, 0, HH, -HW, 0], 'transparent', C.ink + '22');
  });
  cache.set(key, s);
  return s;
}
