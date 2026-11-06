// The town's base lattice under the traced roads (round 128p, DA-A13 step 0; DEVLOG round 128p: the user, "converting
// into terrain columns might be slower without a GPU resident regular grid"). A square lattice of LATTICE_CELL cells
// in the town's frame, turned to its grid field's angle about its middle: which cell a point is in is `floor` of its
// lattice coordinates (then a look at the 3 × 3 round it, as its vertices move at most MAX_OFFSET of a cell). A road
// claims a cell whose middle its line passes within half a cell of (the whole 4 m cell: DECISIONS round 128p); a vertex
// between a claimed and an open cell moves onto the road's edge on the open side (half a cell from its line), so the cells bend to the
// roads; blocks are the connected unions of open cells. The GPU makes the claims and offsets (roadgen.wgsl rgClaim,
// rgOffsets); these are the same rules on the CPU (the tests' reference) and what the CPU does with them after the
// readback: the blocks, and the lattice as a QuadGrid the town's plan is drawn on (build/quadgrid.ts).
import { LATTICE_CELL, MAX_OFFSET } from './gpu';
import { inside, wetAt, type Road, type RoadGenParams, type V2 } from './roadgen';

export { LATTICE_CELL, MAX_OFFSET };

export function latticeN(p: RoadGenParams): number {
  return 2 * Math.ceil(p.radius / LATTICE_CELL) + 2;
}

/** a lattice point (cell corners at whole u, v; a cell's middle at + 0.5) in the town's frame */
export function latticePoint(p: RoadGenParams, latN: number, u: number, v: number): V2 {
  const half = latN / 2;
  const a = (u - half) * LATTICE_CELL;
  const b = (v - half) * LATTICE_CELL;
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  return [p.centre[0] + c * a - s * b, p.centre[1] + s * a + c * b];
}

/** the lattice cell a point's in, before the offsets (the math expression; the 3 × 3 round it holds it after) */
export function latticeCellAt(p: RoadGenParams, latN: number, x: number, y: number): [number, number] {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  const dx = x - p.centre[0];
  const dy = y - p.centre[1];
  return [Math.floor((c * dx + s * dy) / LATTICE_CELL + latN / 2), Math.floor((-s * dx + c * dy) / LATTICE_CELL + latN / 2)];
}

/** the nearest road line within r of q: distance, the road and the point's index */
function nearestRoad(roads: Road[], q: V2, r: number): { d: number; road: Road; k: number } | null {
  let best: { d: number; road: Road; k: number } | null = null;
  for (const road of roads)
    for (let k = 0; k < road.pts.length; k++) {
      const a = road.pts[k];
      const b = road.pts[Math.min(road.pts.length - 1, k + 1)];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const L2 = ex * ex + ey * ey;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / L2)) : 0;
      const d = Math.hypot(q[0] - a[0] - ex * t, q[1] - a[1] - ey * t);
      if (d < (best?.d ?? r)) best = { d, road, k };
    }
  return best;
}

/** (the GPU's rgClaim, for the tests) per cell 0 open, 1 a major road's, 2 a minor road's, 3 off the town, 4 water */
export function claimsCpu(p: RoadGenParams, roads: Road[], latN: number, wet?: Uint8Array): Uint32Array {
  const out = new Uint32Array(latN * latN);
  for (let j = 0; j < latN; j++)
    for (let i = 0; i < latN; i++) {
      const c = latticePoint(p, latN, i + 0.5, j + 0.5);
      if (!inside(p, c[0], c[1])) out[j * latN + i] = 3;
      else if (wet && wetAt(p, wet, c[0], c[1])) out[j * latN + i] = 4;
      else {
        const n = nearestRoad(roads, c, LATTICE_CELL / 2);
        out[j * latN + i] = n ? 1 + n.road.family : 0;
      }
    }
  return out;
}

export function isRoad(k: number): boolean {
  return k === 1 || k === 2;
}

/** (the GPU's rgOffsets, for the tests) per vertex its offset onto the road's edge, x y */
export function offsetsCpu(p: RoadGenParams, roads: Road[], latN: number, claims: Uint32Array): Float32Array {
  const N1 = latN + 1;
  const out = new Float32Array(N1 * N1 * 2);
  for (let j = 0; j < N1; j++)
    for (let i = 0; i < N1; i++) {
      let road = false;
      const opens: [number, number][] = [];
      for (const [ci, cj] of [
        [i - 1, j - 1],
        [i, j - 1],
        [i - 1, j],
        [i, j],
      ]) {
        if (ci < 0 || cj < 0 || ci >= latN || cj >= latN) continue;
        const k = claims[cj * latN + ci];
        road ||= isRoad(k);
        if (k === 0) opens.push([ci, cj]);
      }
      const open = opens.length > 0;
      const jt = jitterOf(p, i, j);
      out[(j * N1 + i) * 2] = jt[0];
      out[(j * N1 + i) * 2 + 1] = jt[1];
      if (!road || !open) continue;
      const v = latticePoint(p, latN, i, j);
      const n = nearestRoad(roads, v, LATTICE_CELL);
      if (!n) continue;
      const a = n.road.pts[Math.max(0, n.k - 1)];
      const b = n.road.pts[Math.min(n.road.pts.length - 1, n.k + 1)];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nrm: V2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      const q = n.road.pts[n.k];
      const s = (v[0] - q[0]) * nrm[0] + (v[1] - q[1]) * nrm[1];
      // (to the edge on the open cells' side: the block's)
      let side = 0;
      for (const [ci, cj] of opens) {
        const c = latticePoint(p, latN, ci + 0.5, cj + 0.5);
        side += (c[0] - q[0]) * nrm[0] + (c[1] - q[1]) * nrm[1];
      }
      if (side === 0) side = s;
      const target = (side >= 0 ? 1 : -1) * (LATTICE_CELL / 2);
      let ox = nrm[0] * (target - s);
      let oy = nrm[1] * (target - s);
      const len = Math.hypot(ox, oy);
      const max = MAX_OFFSET * LATTICE_CELL;
      if (len > max) ((ox *= max / len), (oy *= max / len));
      out[(j * N1 + i) * 2] = ox;
      out[(j * N1 + i) * 2 + 1] = oy;
    }
  return out;
}

/** (rgOffsets' hash3) the base lattice's irregularity at a vertex (m) */
export function jitterOf(p: RoadGenParams, i: number, j: number): V2 {
  const u = (h: number) => (((h >>> 8) / 16777216) * 2 - 1) * p.jitter * LATTICE_CELL;
  return [u(hash3(i, j, p.seed)), u(hash3(i, j, p.seed + 1))];
}

export function hash3(i: number, j: number, s: number): number {
  let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(s, 83492791)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** the blocks: per cell its block (connected open cells, 4-neighbours; -1 a road's or off the town) and the count */
export function blocksOf(claims: Uint32Array, latN: number): { block: Int32Array; count: number; sizes: number[] } {
  const block = new Int32Array(latN * latN).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let c0 = 0; c0 < claims.length; c0++) {
    if (claims[c0] !== 0 || block[c0] >= 0) continue;
    const b = sizes.length;
    let n = 0;
    block[c0] = b;
    stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const i = c % latN;
      const j = (c - i) / latN;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= latN || jj >= latN) continue;
        const o = jj * latN + ii;
        if (claims[o] === 0 && block[o] < 0) ((block[o] = b), stack.push(o));
      }
    }
    sizes.push(n);
  }
  return { block, count: sizes.length, sizes };
}

/**
 * The lattice as a QuadGrid's mesh in the box's frame (the town's frame is the box's: x columns, y world units): its
 * vertices moved by their offsets, a quad per cell that `keep` asks for (counter-clockwise). `cell` maps a lattice cell
 * to its quad (-1 none).
 */
export function latticeMesh(p: RoadGenParams, latN: number, offsets: Float32Array, keep: (i: number, j: number) => boolean): { verts: Float32Array; quads: number[]; cell: Int32Array } {
  const N1 = latN + 1;
  const verts = new Float32Array(N1 * N1 * 2);
  for (let j = 0; j < N1; j++)
    for (let i = 0; i < N1; i++) {
      const v = latticePoint(p, latN, i, j);
      verts[(j * N1 + i) * 2] = v[0] + offsets[(j * N1 + i) * 2];
      verts[(j * N1 + i) * 2 + 1] = v[1] + offsets[(j * N1 + i) * 2 + 1];
    }
  const quads: number[] = [];
  const cell = new Int32Array(latN * latN).fill(-1);
  for (let j = 0; j < latN; j++)
    for (let i = 0; i < latN; i++) {
      if (!keep(i, j)) continue;
      cell[j * latN + i] = quads.length / 4;
      // (counter-clockwise in x, y for a turn of θ: the lattice keeps its handedness)
      quads.push(j * N1 + i, j * N1 + i + 1, (j + 1) * N1 + i + 1, (j + 1) * N1 + i);
    }
  return { verts, quads, cell };
}
