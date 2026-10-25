// Landforms (round 78, branch `places`): the atlas's macro height designed,
// not left to each region's noise. A low-frequency noise over the torus says
// how high the land wants to be; each land region takes a tier from it at its
// centre (lowland, upland, plateau, massif); adjacent regions of one tier are
// one landform — a mesa or a mountain massif many regions across, its edge the
// regions' own borders. Each landform gets one level (and a massif its peak);
// compose.wgsl blends the heights across the borders by the tiers that meet
// (a plateau's edge a cliff, a massif rising from its edge to its peaks by
// the distance into it, jump-flooded from the landforms' borders).

import { rng } from '../world/noise';
import type { RegionStat } from './regions';

export const TIER = { low: 0, upland: 1, plateau: 2, massif: 3 } as const;
export const TIER_NAMES = ['lowland', 'upland', 'plateau', 'massif'];

/** a landform: its tier, its level (cells above the region's own base), a massif's peak and how far in it peaks */
export interface Landform {
  tier: number;
  level: number;
  peak: number;
  rise: number;
  regions: number;
}

/** the share of the land each tier takes, lowest first (the rest: plateaus and massifs) */
const LOW_SHARE = 0.45;
const UPLAND_SHARE = 0.3;

/** a periodic value noise on the torus (u, v in turns), `per` lattice cells a turn; about [-1, 1] */
function pnoise(u: number, v: number, per: number, seed: number): number {
  const x = u * per;
  const y = v * per;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const h = (a: number, b: number) => {
    const ai = ((a % per) + per) % per;
    const bj = ((b % per) + per) % per;
    let k = (ai * 374761393 + bj * 668265263 + seed * 2246822519) >>> 0;
    k = Math.imul(k ^ (k >>> 13), 1274126177) >>> 0;
    return ((k ^ (k >>> 16)) >>> 0) / 4294967295;
  };
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(i, j) + (h(i + 1, j) - h(i, j)) * sx;
  const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * sx;
  return (a + (b - a) * sy) * 2 - 1;
}

function pfbm(u: number, v: number, per: number, oct: number, seed: number): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * pnoise(u, v, per << o, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
  }
  return s / norm;
}

/**
 * The elevation noise (round 78, the user's suggestion: a 3D fractal sampled at z = a 2D noise of x and y,
 * x and y scaled by z, "or warping the domain in other ways"). Scaling x and y by z would break the torus's
 * wrap, so: the domain warped by a periodic noise, and z blending between the noise at its size and at half
 * its size — big smooth shapes in some places, broken finer ground in others.
 */
export function elevation(u: number, v: number, per: number, seed: number): number {
  const wu = u + 0.12 * pfbm(u, v, per * 2, 3, seed * 3 + 101) / per;
  const wv = v + 0.12 * pfbm(u, v, per * 2, 3, seed * 3 + 202) / per;
  const z = 0.5 + 0.5 * pfbm(u, v, per, 2, seed * 3 + 303);
  return pfbm(wu, wv, per, 4, seed * 7 + 11) * (1 - z) + pfbm(wu, wv, per * 2, 4, seed * 7 + 12) * z;
}

/**
 * Each region's tier: water none (−1); a fault's strip a massif (a range) or a rift (lowland); the rest by
 * the elevation noise's rank among the land's regions (so the shares hold whatever the noise's spread),
 * the highest split into plateaus and massifs by a second noise (plateaus where it's dry).
 */
export function tiersOf(stats: RegionStat[], seed: number, dryness: (cy: number) => number, per: number): { tier: Int8Array; rift: Uint8Array } {
  const tier = new Int8Array(stats.length).fill(-1);
  const rift = new Uint8Array(stats.length);
  const land: [number, number][] = [];
  stats.forEach((st, i) => {
    if (!st.land) return;
    if (st.fault) {
      const range = rng(seed * 31 + st.prov * 7 + 3)() < 0.68;
      tier[i] = range ? TIER.massif : TIER.low;
      rift[i] = range ? 0 : 1;
      return;
    }
    land.push([i, elevation(st.cx, st.cy, Math.max(1, Math.round(per)), seed)]);
  });
  land.sort((a, b) => a[1] - b[1]);
  land.forEach(([i], k) => {
    const q = k / Math.max(1, land.length - 1);
    const st = stats[i];
    let t: number = q < LOW_SHARE ? TIER.low : q < LOW_SHARE + UPLAND_SHARE ? TIER.upland : TIER.massif;
    if (t === TIER.massif && pfbm(st.cx, st.cy, Math.max(2, Math.round(per * 1.5)), 3, seed * 13 + 5) + (dryness(st.cy) - 0.5) * 0.6 > 0) t = TIER.plateau;
    // (a rock in the sea isn't a massif or a mesa)
    if (st.contArea < 400 && t > TIER.upland) t = TIER.upland;
    tier[i] = t;
  });
  return { tier, rift };
}

/**
 * Landforms: the components of adjacent land regions of one tier (`adjacency`: "a,b" keys as a·R + b,
 * Atlas.adjacency), each with its level, peak and rise. Water regions are none (−1).
 */
export function landformsOf(tier: Int8Array, adjacency: Map<number, number>, seed: number): { of: Int32Array; forms: Landform[] } {
  const R = tier.length;
  const parent = Array.from({ length: R }, (_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (const k of adjacency.keys()) {
    const a = Math.floor(k / R);
    const b = k % R;
    if (tier[a] < 0 || tier[a] !== tier[b]) continue;
    parent[find(a)] = find(b);
  }
  const of = new Int32Array(R).fill(-1);
  const forms: Landform[] = [];
  const id = new Map<number, number>();
  for (let i = 0; i < R; i++) {
    if (tier[i] < 0) continue;
    const root = find(i);
    let f = id.get(root);
    if (f === undefined) {
      f = forms.length;
      id.set(root, f);
      const r = rng(seed * 4099 + root * 7 + 1);
      const t = tier[i];
      const lerp = (a: number, b: number) => a + (b - a) * r();
      forms.push({
        tier: t,
        level: t === TIER.low ? 0 : t === TIER.upland ? lerp(14, 26) : t === TIER.plateau ? 90 + 200 * r() ** 2 : lerp(24, 40),
        peak: t === TIER.massif ? lerp(120, 240) : 0,
        rise: t === TIER.massif ? lerp(250, 450) : 0,
        regions: 0,
      });
    }
    of[i] = f;
    forms[f].regions++;
  }
  return { of, forms };
}
