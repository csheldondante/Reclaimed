// Roots by cellular automaton (round 117; the user: "L systems are great for branches and then cellular autonoma for
// roots").
//
// Why a CA and not another L-system: roots answer to the ground they grow through — they follow water, avoid rock and
// spread where the soil is loose — and a grid automaton reads that from a field directly (a moisture/obstacle
// grid), where an L-system would need it threaded through its turtle. The result is also the right representation
// for its users: cells, which the terrain's columns, erosion (roots hold banks: a higher angle of repose) and
// excavation (roots showing in a cut, a cave ceiling) speak natively.
//
// The grid is small and local (a tree's root ball, cell units at the given resolution), z = 0 the ground, negative
// down. Rule per generation, for each empty soil cell with root neighbours (6-neighbourhood):
//   grow if it has exactly one root neighbour (keeps roots thin and branching, not blobs), with probability
//   p = growth × soil(c) × (down-bias for deeper cells, spread-bias for shallow ones) × (1 − crowding)
// The trunk's base cells seed it. Deterministic from the seed.

import { rng } from './rng';
import type { Segment, V3 } from './lsystem';

export interface RootSpec {
  /** grid half-width (cells of `res`) and depth */
  half: number;
  depth: number;
  /** grid cell size in world cells (e.g. 0.25: quarter cells) */
  res: number;
  generations: number;
  growth: number;
  /** 0..1: how much roots prefer to go down (tap root) vs spread sideways near the surface (birch: shallow) */
  down: number;
  /** most root cells (a budget) */
  maxCells: number;
  /** trunk radius at the base (world cells): the seed ring */
  trunkRadius: number;
}

/** Soil quality 0..1 at a grid cell (moisture, looseness; 0 = rock: no growth). Default: uniform soil. */
export type SoilFn = (x: number, y: number, z: number) => number;

export interface RootGrid {
  spec: RootSpec;
  /** 1 where a root is, (2h+1)² × depth, index ((z × n) + y) × n + x, z 0 = the top layer */
  cells: Uint8Array;
  /** the generation each cell grew in (0 = seed), 255 none */
  age: Uint8Array;
  /** parent cell index (the cell it grew from), −1 for seeds */
  parent: Int32Array;
  n: number;
  count: number;
}

export function growRoots(spec: RootSpec, seed: number, soil: SoilFn = () => 1): RootGrid {
  const r = rng(seed ^ 0x700757);
  const n = spec.half * 2 + 1;
  const N = n * n * spec.depth;
  const cells = new Uint8Array(N);
  const age = new Uint8Array(N).fill(255);
  const parent = new Int32Array(N).fill(-1);
  const at = (x: number, y: number, z: number) => (z * n + y) * n + x;
  let count = 0;
  // seeds: the ring under the trunk, top layer
  const tr = Math.max(1, Math.round(spec.trunkRadius / spec.res));
  for (let y = -tr; y <= tr; y++)
    for (let x = -tr; x <= tr; x++) {
      if (x * x + y * y > tr * tr) continue;
      const i = at(x + spec.half, y + spec.half, 0);
      cells[i] = 1;
      age[i] = 0;
      count++;
    }
  const nb: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (let g = 1; g <= spec.generations && count < spec.maxCells; g++) {
    const born: [number, number][] = [];
    for (let z = 0; z < spec.depth; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = at(x, y, z);
          if (cells[i]) continue;
          let roots = 0;
          let from = -1;
          for (const [dx, dy, dz] of nb) {
            const X = x + dx, Y = y + dy, Z = z + dz;
            if (X < 0 || Y < 0 || Z < 0 || X >= n || Y >= n || Z >= spec.depth) continue;
            const j = at(X, Y, Z);
            // (only last generations' tips grow: an old root's flank doesn't sprout everywhere)
            if (cells[j]) {
              roots++;
              if (age[j] >= g - 2) from = j;
            }
          }
          if (roots !== 1 || from < 0) continue;
          const s = soil(x - spec.half, y - spec.half, -z);
          if (s <= 0) continue;
          // which way it went from its parent: down, or out sideways
          const pz = Math.floor(from / (n * n));
          const goingDown = z > pz;
          const shallow = z <= 1;
          const bias = goingDown ? spec.down : (1 - spec.down) * (shallow ? 1.4 : 0.8);
          if (r() < spec.growth * s * bias) born.push([i, from]);
        }
    for (const [i, from] of born) {
      if (count >= spec.maxCells) break;
      cells[i] = 1;
      age[i] = g;
      parent[i] = from;
      count++;
    }
  }
  return { spec, cells, age, parent, n, count };
}

/** World position (relative to the trunk's foot) of a grid cell's centre. */
export function rootCellPos(g: RootGrid, i: number): V3 {
  const n = g.n;
  const z = Math.floor(i / (n * n));
  const y = Math.floor((i - z * n * n) / n);
  const x = i - z * n * n - y * n;
  const s = g.spec.res;
  return [(x - g.spec.half) * s, (y - g.spec.half) * s, -(z + 0.5) * s];
}

/**
 * The roots as wood segments (each cell joined to its parent). Only the main roots near the surface show — the
 * flare and buttresses a viewer sees — chosen and thickened by the pipe model: a root is as thick as the roots it
 * feeds (its descendants' count), so the many fine ends stay cells (the ground's grip, excavation) and don't cost
 * triangles. `showDepth`: how far down (world cells) a shown root may be; `minFeeds`: the fewest descendants.
 */
export function rootSegments(g: RootGrid, showDepth: number, rootRadius: number, minFeeds = 8): Segment[] {
  const feeds = new Int32Array(g.cells.length);
  // descendants: younger cells first, each adds itself and what it feeds to its parent
  const order: number[] = [];
  for (let i = 0; i < g.cells.length; i++) if (g.cells[i]) order.push(i);
  order.sort((a, b) => g.age[b] - g.age[a]);
  for (const i of order) if (g.parent[i] >= 0) feeds[g.parent[i]] += feeds[i] + 1;
  let most = 1;
  for (const i of order) most = Math.max(most, feeds[i]);
  const out: Segment[] = [];
  for (const i of order) {
    if (g.parent[i] < 0 || feeds[i] < minFeeds) continue;
    const b = rootCellPos(g, i);
    const a = rootCellPos(g, g.parent[i]);
    if (-b[2] > showDepth) continue;
    const r0 = rootRadius * Math.sqrt((feeds[g.parent[i]] + 1) / (most + 1));
    const r1 = rootRadius * Math.sqrt((feeds[i] + 1) / (most + 1));
    // (the surface roots ride up out of the ground a little: a flare)
    // (half buried: the top of a surface root shows, as a flare into the trunk's foot)
    const lift = (p: V3, r: number): V3 => [p[0], p[1], p[2] + g.spec.res * 0.5 + r * 0.1];
    out.push({ a: lift(a, r0), b: lift(b, r1), r0, r1, depth: 9 });
  }
  return out;
}

/** How far the roots reach (world cells, horizontally) and how deep: the plant's grip on its ground. */
export function rootReach(g: RootGrid): { spread: number; depth: number; cells: number } {
  let spread = 0;
  let depth = 0;
  for (let i = 0; i < g.cells.length; i++) {
    if (!g.cells[i]) continue;
    const p = rootCellPos(g, i);
    spread = Math.max(spread, Math.hypot(p[0], p[1]));
    depth = Math.max(depth, -p[2]);
  }
  return { spread, depth, cells: g.count };
}
