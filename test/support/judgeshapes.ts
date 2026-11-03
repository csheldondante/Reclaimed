// The collapse judges' test shapes and random caves (round 120; shared by test/gpu/judge-equal.test.ts and, round 120
// JB6, test/gpu/colapply.test.ts): RockWorlds with a cut made and the columns to seed.
import { subtract } from '../../src/game/colbodies';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import type { Interval } from '../../src/world/layout';
import { RockWorld } from './rockworld';

/** the ground's height under every shape */
export const G = 10;

/** a W x W world: stone to G, then `extra`'s runs (of `mat`) above it */
export function world(W: number, extra: (x: number, y: number) => [number, number][], mat: number = MAT.Stone): RockWorld {
  return new RockWorld(W, W, 64, (x, y) => {
    const col: Interval[] = [{ z0: 0, z1: G, mat: MAT.Stone }];
    for (const [z0, z1] of extra(x, y).sort((a, b) => a[0] - b[0])) {
      const last = col[col.length - 1];
      if (last.mat === mat && z0 <= last.z1 + 1e-6) last.z1 = Math.max(last.z1, z1);
      else col.push({ z0: Math.max(z0, last.z1), z1, mat });
    }
    return col;
  });
}

export const box = (x0: number, y0: number, x1: number, y1: number) => {
  const o: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) o.push([x, y]);
  return o;
};

export interface Shape {
  name: string;
  make: () => RockWorld;
  seeds: [number, number][];
  cut?: (w: RockWorld) => void;
}

export const SHAPES: Shape[] = [
  { name: 'arch, one foot cut', make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : [])), seeds: box(10, 15, 25, 18), cut: (w) => box(22, 15, 25, 18).forEach(([x, y]) => w.dig(x, y, G, G + 3)) },
  ...(['foot', 'keystone'] as const).map((cut) => ({
    name: `brick arch, ${cut} cut`,
    make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : []), MAT.Brick),
    seeds: box(10, 15, 25, 18),
    cut: (w: RockWorld) => (cut === 'foot' ? box(22, 15, 25, 18).forEach(([x, y]) => w.dig(x, y, G, G + 3)) : box(16, 15, 19, 18).forEach(([x, y]) => w.dig(x, y, G + 12, G + 15))),
  })),
  { name: 'arch, keystone cut', make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : [])), seeds: box(10, 15, 25, 18), cut: (w) => box(16, 15, 19, 18).forEach(([x, y]) => w.dig(x, y, G + 12, G + 15)) },
  {
    name: 'dome',
    make: () =>
      world(64, (x, y) => {
        const [px, py] = cellPos(x, y);
        const [qx, qy] = cellPos(32, 32);
        const d = Math.hypot(px - qx, py - qy);
        if (d > 9) return [];
        return [[Math.floor(d < 7.5 ? G + Math.sqrt(56.25 - d * d) : G), Math.ceil(G + Math.sqrt(81 - d * d))]];
      }),
    seeds: box(20, 20, 45, 45),
  },
  ...[1, 3].flatMap((t) => [6, 12, 16].map((reach) => ({ name: `shelf ${t} × ${reach}`, make: () => world(64, (x, y) => (y < 20 || y >= 30 ? [] : x < 20 ? [[G, G + 20]] : x < 20 + reach ? [[G + 20 - t, G + 20]] : [])) as RockWorld, seeds: box(18, 20, 20 + reach, 30) }))),
  { name: 'mid-span neck', make: () => world(64, (x, y) => (y < 20 || y >= 30 ? [] : x < 20 ? [[G, G + 20]] : x < 26 ? [[G + 14, G + 20]] : x === 26 ? [[G + 19, G + 20]] : x < 32 ? [[G + 17, G + 20]] : [])), seeds: box(18, 20, 32, 30) },
];

/** a seeded random (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random caves: a hill of stone (to G + 24) with spherical voids carved through it (roofs, ledges, bridges, pillars;
 * some pieces hanging free), then a cut — a void at a random spot — and every column within it seeded and weighed.
 */
export function cave(seed: number, mat: number = MAT.Stone): { w: RockWorld; seeds: [number, number][] } {
  const r = rng(seed);
  const W = 48;
  const voids: [number, number, number, number][] = [];
  for (let i = 0; i < 6 + Math.floor(r() * 6); i++) voids.push([4 + r() * 40, 4 + r() * 36, G + 2 + r() * 16, 2.5 + r() * 6]);
  const hill = (px: number, py: number) => G + 24 - 0.15 * Math.hypot(px - 24, py - 20);
  const w = new RockWorld(W, W, 64, (x, y) => {
    const [px, py] = cellPos(x, y);
    let col: { z0: number; z1: number }[] = [{ z0: 0, z1: Math.max(G, Math.round(hill(px, py))) }];
    for (const [vx, vy, vz, vr] of voids) {
      const d = Math.hypot(px - vx, py - vy);
      if (d >= vr) continue;
      const h = Math.sqrt(vr * vr - d * d);
      col = subtract(col.map((iv) => ({ ...iv, mat: MAT.Stone })), [{ z0: Math.max(G, Math.round(vz - h)), z1: Math.round(vz + h) }]);
    }
    return col.filter((iv) => iv.z1 - iv.z0 > 0.5).map((iv) => ({ z0: iv.z0, z1: iv.z1, mat: iv.z1 <= G ? MAT.Stone : mat }));
  });
  const [cx, cy, cz, cr] = [6 + r() * 36, 6 + r() * 32, G + 1 + r() * 10, 2 + r() * 3];
  const seeds: [number, number][] = [];
  for (const [x, y] of w.near(cx, cy, cr)) {
    const [px, py] = cellPos(x, y);
    const h = Math.sqrt(Math.max(0, cr * cr - (px - cx) ** 2 - (py - cy) ** 2));
    w.dig(x, y, Math.max(G, Math.round(cz - h)), Math.round(cz + h) + 1);
    seeds.push([x, y]);
  }
  return { w, seeds };
}
