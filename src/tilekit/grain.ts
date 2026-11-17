// (tilekit step 3, docs/design/TILEKIT.md §20–§23) The irregular grid built on the CPU with a district grain and
// traced roads: archgen's triangle lattice (GRID_S, the position nudge, the two hashed pairing rounds and Townscaper's
// split, ported from arch.wgsl so that with no grain it is the same grid), except that
//   - inside the district every triangle has a grain family g (0, 1, 2: the lattice's edge directions 0°, 60°, 120°)
//     and pairs with its neighbour across its family-g edge: the rhombi tile regularly, every lattice point inside a
//     grain region is 4-valent (6 edges, two merged);
//   - traced roads and alleys are lattice polylines; a block (the district's triangles between them) takes a grain not
//     among its bounding roads' families, so each road is a grid line on both sides; seams between grains run along
//     the roads, and irregular vertices only appear where seams meet or end (junctions, bends that keep their angle,
//     plaza corners) — placed by the road plan, not scattered;
//   - plazas are lattice polygons paired by the hashed rule among themselves (irregular paving, on purpose);
//   - the rest of the window keeps the hashed pairing (the town grid as it is).
// Then relaxed (Townscaper's squaring, the whole window at once, its rim pinned) with road fairing (each road line's
// vertices pulled towards their neighbours along it), and each cell's lot found as the GPU does (the nearest lattice
// point's deepest parcel). Pure: no GPU.

import { finish, type GridMesh } from './grid';

export const GRID_S = 5.4;
const SQ3 = Math.sqrt(3);
const NONE = 0xffffffff;

// ---- arch.wgsl's hashes, bit for bit (u32 arithmetic) ----
export function hashU(x: number): number {
  let h = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> (((h >>> 28) + 4) & 31)) ^ h) >>> 0, 277803737) >>> 0;
  return ((h >>> 22) ^ h) >>> 0;
}
const triId = (a: number, b: number, t: number) => ((Math.imul(a + 32768, 65599) ^ Math.imul(b + 32768, 2654435761 | 0)) ^ (t * 97)) >>> 0;
const edgeH = (i0: number, i1: number) => hashU((Math.imul(Math.min(i0, i1), 31) + hashU(Math.max(i0, i1))) >>> 0);

export type V2 = [number, number];
export const latP = (a: number, b: number): V2 => [(a + 0.5 * b) * GRID_S, b * SQ3 * 0.5 * GRID_S];
/** the lattice coordinates (fractional) of a world point */
export const latOf = (p: V2): V2 => {
  const bf = p[1] / (GRID_S * SQ3 * 0.5);
  return [p[0] / GRID_S - 0.5 * bf, bf];
};
/** a point nudged by a hash of where it is (arch.wgsl `nudge`; WGSL rounds half to even, JS half up: only exact halves
 *  differ) */
export function nudge(p: V2): V2 {
  const kx = Math.round(p[0] * 8);
  const ky = Math.round(p[1] * 8);
  const h = hashU((Math.imul(kx + 100000, 73856093) ^ Math.imul(ky + 100000, 19349663)) >>> 0);
  const a = ((h & 0xffff) / 65535) * 6.28318;
  const r = ((h >>> 16) & 0xffff) / 65535;
  return [p[0] + Math.cos(a) * r * GRID_S * 0.09, p[1] + Math.sin(a) * r * GRID_S * 0.09];
}

/** a triangle's corner k in lattice coordinates (up t = 0: (a,b) (a+1,b) (a,b+1); down t = 1: (a+1,b) (a+1,b+1)
 *  (a,b+1)), counter-clockwise */
export function triV(a: number, b: number, t: number, k: number): V2 {
  if (t === 0) return k === 0 ? [a, b] : k === 1 ? [a + 1, b] : [a, b + 1];
  return k === 0 ? [a + 1, b] : k === 1 ? [a + 1, b + 1] : [a, b + 1];
}
/** the triangle across edge k (corner k → k + 1) */
export function triN(a: number, b: number, t: number, k: number): [number, number, number] {
  if (t === 0) return k === 0 ? [a, b - 1, 1] : k === 1 ? [a, b, 1] : [a - 1, b, 1];
  return k === 0 ? [a + 1, b, 0] : k === 1 ? [a, b + 1, 0] : [a, b, 0];
}
/** the family of a triangle's edge k: 0 along (1, 0) (0°), 1 along (0, 1) (60°), 2 along (−1, 1) (120°) */
export const FAM = [
  [0, 2, 1],
  [1, 0, 2],
];
/** the family of a unit lattice step (da, db) */
export function famOf(da: number, db: number): number {
  if (db === 0) return 0;
  if (da === 0) return 1;
  if (da === -db) return 2;
  throw new Error(`tilekit: (${da}, ${db}) is not a lattice step`);
}
/** a lattice family's world direction (radians) */
export const famAngle = (f: number) => (f * Math.PI) / 3;

/** a lattice point's key */
const lk = (a: number, b: number) => (a + 4096) * 8192 + (b + 4096);
/** an undirected lattice edge's key */
export const ek = (p: V2, q: V2) => {
  const x = lk(p[0], p[1]);
  const y = lk(q[0], q[1]);
  return x < y ? x * 67108864 + y : y * 67108864 + x;
};

// ---- lots: arch.wgsl's lotAt (the nearest lattice point's owner: the parcel it lies deepest in, or within 3 m) ----

export interface Lots {
  /** parcel corners a lot, x y × 4 (CCW) */
  par: Float32Array;
  n: number;
}
/** lots from citygen's lot records (24 words a lot, the parcel first) */
export function lotsOf(words: Uint32Array, stride = 24): Lots {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const n = Math.floor(words.length / stride);
  const par = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) for (let j = 0; j < 8; j++) par[i * 8 + j] = f[i * stride + j];
  return { par, n };
}
export function makeOwner(L: Lots) {
  const memo = new Map<number, number>();
  return (a: number, b: number): number => {
    const key = lk(a, b);
    const m = memo.get(key);
    if (m !== undefined) return m;
    const p = latP(a, b);
    let best = NONE;
    let bestKey = Infinity;
    for (let i = 0; i < L.n; i++) {
      let d = -1e9;
      for (let k = 0; k < 4; k++) {
        const ax = L.par[i * 8 + k * 2];
        const ay = L.par[i * 8 + k * 2 + 1];
        const bx = L.par[i * 8 + ((k + 1) % 4) * 2];
        const by = L.par[i * 8 + ((k + 1) % 4) * 2 + 1];
        const l = Math.hypot(bx - ax, by - ay) || 1;
        d = Math.max(d, (p[0] - ax) * ((by - ay) / l) + (p[1] - ay) * (-(bx - ax) / l));
      }
      if (d >= 3) continue;
      // (the GPU's atomicMax of the inverted key: the smallest quantised depth, then the smallest lot)
      const q = Math.floor(Math.min(63, Math.max(0, d + 60)) * 256) * 4096 + (i & 0xfff);
      if (q < bestKey) {
        bestKey = q;
        best = i;
      }
    }
    memo.set(key, best);
    return best;
  };
}
export function nearestLat(p: V2): V2 {
  const [af, bf] = latOf(p);
  let bd = Infinity;
  let r: V2 = [0, 0];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const la = Math.floor(af) + i;
      const lb = Math.floor(bf) + j;
      const q = latP(la, lb);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        r = [la, lb];
      }
    }
  }
  return r;
}

// ---- the road plan (lattice coordinates) ----

/** a road (open ground both sides, two cells wide), an alley (one cell, on its `side`), or a seam (no open ground: a
 *  line where the grain changes, which is how a singularity is placed away from a road — §21) */
export type RoadKind = 'road' | 'alley' | 'seam';
export interface Road {
  /** lattice points; consecutive ones on one lattice line (any number of steps) */
  pts: V2[];
  kind: RoadKind;
  /** an alley is one cell wide: the side its cells are on (+1 left of the walking direction, −1 right) */
  side?: 1 | -1;
  name?: string;
}
export interface Plaza {
  /** a lattice polygon (CCW); the triangles whose centre is inside are the plaza */
  poly: V2[];
  name?: string;
}
export interface RoadPlan {
  roads: Road[];
  plazas: Plaza[];
}

/** a road's unit lattice edges in walking order */
export function roadSteps(r: Road): [V2, V2][] {
  const out: [V2, V2][] = [];
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const [a0, b0] = r.pts[i];
    const [a1, b1] = r.pts[i + 1];
    const n = Math.max(Math.abs(a1 - a0), Math.abs(b1 - b0));
    if (!n) continue;
    const da = (a1 - a0) / n;
    const db = (b1 - b0) / n;
    famOf(da, db); // (throws if the segment is not on a lattice line)
    if (!Number.isInteger(da) || !Number.isInteger(db)) throw new Error('tilekit: a road segment is not on a lattice line');
    for (let s = 0; s < n; s++) out.push([[a0 + da * s, b0 + db * s], [a0 + da * (s + 1), b0 + db * (s + 1)]]);
  }
  return out;
}

// ---- the grid ----

export interface GrainOpts {
  /** the lattice window: cells a ∈ [a0, a1), b ∈ [b0, b1) */
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  /** the district: triangles whose centre is within `radius` of `anchor` and whose corners all have a lot */
  anchor: V2;
  radius: number;
  /** false: no grain anywhere (the hashed pairing everywhere: the GPU grid) */
  grain: boolean;
  plan: RoadPlan;
  /** a direction field for blocks without a road (radians): the grain whose axes lie closest to it */
  field?: (p: V2) => number;
  /** relaxation steps (the GPU: 20, chunk-local) and road fairing weight a step (0 off) */
  relax: number;
  fair: number;
  /** hold the plazas' cells as the lattice made them (default true) */
  holdPlazas?: boolean;
}

/** what the grain construction did, for the plan view, the notes and the tests */
export interface GrainInfo {
  /** per triangle (index tri(a, b, t)): its grain (-1 none), its partner (-1 lone), in the district, a plaza, block */
  grain: Int8Array;
  partner: Int32Array;
  district: Uint8Array;
  plaza: Uint8Array;
  block: Int32Array;
  /** per block: its grain and its bounding road families (edge counts) */
  blocks: { grain: number; fams: [number, number, number]; tris: number }[];
  /** per cell: 0 open ground of the town, 1 a road, 2 a plaza, 3 an alley; and in the district (its triangle) */
  open: Uint8Array;
  inDistrict: Uint8Array;
  /** per cell the lattice triangle it lies in (a merged piece's corner cells on the shared edge: the one its next edge
   *  belongs to) */
  cellTri: Int32Array;
  /** road line vertex chains (mesh vertex ids), one a road */
  chains: number[][];
  /** each chain's kind */
  kinds: RoadKind[];
  /** the lattice window, for tri() */
  W: number;
  a0: number;
  b0: number;
  nt: number;
}

export interface GrainGrid {
  mesh: GridMesh;
  info: GrainInfo;
}

/** the triangle index of (a, b, t) in a window */
const triIdx = (o: { a0: number; b0: number; W: number; H: number }, a: number, b: number, t: number) =>
  a < o.a0 || b < o.b0 || a >= o.a0 + o.W || b >= o.b0 + o.H ? -1 : ((b - o.b0) * o.W + (a - o.a0)) * 2 + t;

/** the triangle holding a lattice-coordinate point */
export function triAt(p: V2): [number, number, number] {
  const a = Math.floor(p[0]);
  const b = Math.floor(p[1]);
  const fa = p[0] - a;
  const fb = p[1] - b;
  return [a, b, fa + fb > 1 ? 1 : 0];
}

function inPoly(poly: V2[], p: V2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** the grid of a lattice window with the district grain, roads and plazas (see the header) */
export function grainGrid(L: Lots, o: GrainOpts): GrainGrid {
  const W = o.a1 - o.a0;
  const H = o.b1 - o.b0;
  const win = { a0: o.a0, b0: o.b0, W, H };
  const nt = W * H * 2;
  const owner = makeOwner(L);
  const tri = (a: number, b: number, t: number) => triIdx(win, a, b, t);
  const triOf = (i: number): [number, number, number] => [o.a0 + ((i >> 1) % W), o.b0 + Math.floor((i >> 1) / W), i & 1];
  const latC = (i: number): V2 => {
    const [a, b, t] = triOf(i);
    const p = [0, 1, 2].map((k) => triV(a, b, t, k));
    return [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3];
  };
  const worldC = (i: number): V2 => {
    const c = latC(i);
    return latP(c[0], c[1]);
  };

  // ---- the district, the roads, the plazas, the blocks ----
  const district = new Uint8Array(nt);
  const plaza = new Uint8Array(nt);
  for (let i = 0; i < nt; i++) {
    const [a, b, t] = triOf(i);
    const c = worldC(i);
    if (Math.hypot(c[0] - o.anchor[0], c[1] - o.anchor[1]) > o.radius) continue;
    if ([0, 1, 2].some((k) => owner(...triV(a, b, t, k)) === NONE)) continue;
    district[i] = 1;
  }
  for (const pz of o.plan.plazas) for (let i = 0; i < nt; i++) if (inPoly(pz.poly, latC(i))) plaza[i] = 1;
  /** road edges: key → kind and, for an alley, the triangle on its side */
  const roadEdge = new Map<number, { kind: RoadKind; sideTri: number; road: number }>();
  o.plan.roads.forEach((r, ri) => {
    for (const [p, q] of roadSteps(r)) {
      let sideTri = -1;
      if (r.kind === 'alley') {
        // the triangle left (side +1) or right of p → q: a point just off the edge's middle
        const mx = (p[0] + q[0]) / 2;
        const my = (p[1] + q[1]) / 2;
        const wp = latP(mx, my);
        const wd = [latP(q[0], q[1])[0] - latP(p[0], p[1])[0], latP(q[0], q[1])[1] - latP(p[0], p[1])[1]];
        const s = r.side ?? 1;
        const off: V2 = [wp[0] - wd[1] * 0.15 * s, wp[1] + wd[0] * 0.15 * s];
        sideTri = tri(...triAt(latOf(off)));
      }
      roadEdge.set(ek(p, q), { kind: r.kind, sideTri, road: ri });
    }
  });
  // blocks: the district's non-plaza triangles joined across edges that are no road
  const block = new Int32Array(nt).fill(-1);
  const blocks: GrainInfo['blocks'] = [];
  for (let s = 0; s < nt; s++) {
    if (!district[s] || plaza[s] || block[s] >= 0) continue;
    const id = blocks.length;
    const fams: [number, number, number] = [0, 0, 0];
    let n = 0;
    const st = [s];
    block[s] = id;
    while (st.length) {
      const i = st.pop()!;
      n++;
      const [a, b, t] = triOf(i);
      for (let k = 0; k < 3; k++) {
        const e = ek(triV(a, b, t, k), triV(a, b, t, (k + 1) % 3));
        if (roadEdge.has(e)) {
          fams[FAM[t][k]]++;
          continue;
        }
        const nn = tri(...triN(a, b, t, k));
        if (nn < 0 || !district[nn] || plaza[nn] || block[nn] >= 0) continue;
        block[nn] = id;
        st.push(nn);
      }
    }
    blocks.push({ grain: -1, fams, tris: n });
  }
  // each block's grain: a family none of its roads runs along (fewest road edges if every family has some); among
  // those, the one whose axes lie closest to the direction field (the town's streets, a contour) at its middle
  const grain = new Int8Array(nt).fill(-1);
  if (o.grain) {
    const mid = blocks.map(() => [0, 0, 0]);
    for (let i = 0; i < nt; i++) {
      if (block[i] < 0) continue;
      const c = worldC(i);
      mid[block[i]][0] += c[0];
      mid[block[i]][1] += c[1];
      mid[block[i]][2]++;
    }
    blocks.forEach((bl, id) => {
      const least = Math.min(...bl.fams);
      const cand = [0, 1, 2].filter((g) => bl.fams[g] === least);
      let g = cand[0];
      if (cand.length > 1 && o.field) {
        const th = o.field([mid[id][0] / mid[id][2], mid[id][1] / mid[id][2]]);
        // an axis family f ≠ g; after squaring the grain-g grid's axes sit at g ± 45°, i.e. the two families' bisectors
        // move apart — the closest family direction to the field is what reads as "along the street"
        const dist = (f: number) => {
          let d = Math.abs(((famAngle(f) - th) % Math.PI + Math.PI) % Math.PI);
          return Math.min(d, Math.PI - d);
        };
        let best = Infinity;
        for (const c of cand) {
          const s = Math.min(...[0, 1, 2].filter((f) => f !== c).map(dist));
          if (s < best - 1e-9) {
            best = s;
            g = c;
          }
        }
      }
      bl.grain = g;
    });
    for (let i = 0; i < nt; i++) if (block[i] >= 0) grain[i] = blocks[block[i]].grain;
  }

  // ---- pairing: the grain, then the GPU's two hashed rounds among the rest (within plazas, or outside them) ----
  const partner = new Int32Array(nt).fill(-2);
  for (let i = 0; i < nt; i++) {
    const g = grain[i];
    if (g < 0) continue;
    const [a, b, t] = triOf(i);
    const k = FAM[t].indexOf(g);
    const n = tri(...triN(a, b, t, k));
    if (n >= 0 && grain[n] === g && block[n] === block[i]) partner[i] = n;
  }
  const free = (i: number) => i >= 0 && partner[i] === -2;
  const zone = (i: number) => (plaza[i] ? 1 : 0);
  const pick = (i: number, round: number): number => {
    const [a, b, t] = triOf(i);
    const me = triId(a, b, t);
    let best = -1;
    let bh = -1;
    for (let k = 0; k < 3; k++) {
      const [na, nb, nt2] = triN(a, b, t, k);
      const n = tri(na, nb, nt2);
      if (!free(n) || zone(n) !== zone(i)) continue;
      // (a road edge is never merged across: its cells must have it as an edge)
      if (roadEdge.has(ek(triV(a, b, t, k), triV(a, b, t, (k + 1) % 3)))) continue;
      const h = (edgeH(me, triId(na, nb, nt2)) ^ (round ? 0x5bd1e995 : 0)) >>> 0;
      if (h > bh) {
        bh = h;
        best = n;
      }
    }
    return best;
  };
  for (const round of [0, 1]) {
    const pk = new Int32Array(nt).fill(-1);
    for (let i = 0; i < nt; i++) if (free(i)) pk[i] = pick(i, round);
    for (let i = 0; i < nt; i++) if (free(i) && pk[i] >= 0 && pk[pk[i]] === i) partner[i] = pk[i];
  }
  for (let i = 0; i < nt; i++) if (partner[i] === -2) partner[i] = -1;

  // ---- pieces → cells (Townscaper's split), keyed vertices ----
  const keyOf = new Map<string, number>();
  const pos: number[] = [];
  const vid = (key: string, p: V2) => {
    let v = keyOf.get(key);
    if (v === undefined) {
      v = pos.length / 2;
      keyOf.set(key, v);
      pos.push(p[0], p[1]);
    }
    return v;
  };
  const latKey = (q: V2) => `p${q[0]},${q[1]}`;
  const edgeKey = (p: V2, q: V2) => `e${ek(p, q)}`;
  const cells: number[] = [];
  const cellTri: number[] = [];
  /** per cell its two lattice edges at its lattice corner and the triangle each belongs to */
  const cellEdges: { p: V2; q: V2; tri: number }[][] = [];
  /** lattice edge → its middle's vertex */
  const midOf = new Map<number, number>();
  for (let i = 0; i < nt; i++) {
    const pn = partner[i];
    if (pn >= 0 && pn < i) continue;
    const [a, b, t] = triOf(i);
    let V: V2[];
    let ET: number[]; // the triangle owning edge k (V[k] → V[k+1])
    let cKey: string;
    if (pn >= 0) {
      const [na, nb, ntt] = triOf(pn);
      const pk = [0, 1, 2].find((k) => {
        const x = triN(a, b, t, k);
        return x[0] === na && x[1] === nb && x[2] === ntt;
      })!;
      const nk = [0, 1, 2].find((k) => {
        const x = triN(na, nb, ntt, k);
        return x[0] === a && x[1] === b && x[2] === t;
      })!;
      V = [triV(a, b, t, pk), triV(na, nb, ntt, (nk + 2) % 3), triV(a, b, t, (pk + 1) % 3), triV(a, b, t, (pk + 2) % 3)];
      ET = [pn, pn, i, i];
      cKey = edgeKey(triV(a, b, t, pk), triV(a, b, t, (pk + 1) % 3));
    } else {
      V = [triV(a, b, t, 0), triV(a, b, t, 1), triV(a, b, t, 2)];
      ET = [i, i, i];
      cKey = `c${a},${b},${t}`;
    }
    const nv = V.length;
    const Pn = V.map((q) => nudge(latP(q[0], q[1])));
    let cx = 0;
    let cy = 0;
    for (const p of Pn) {
      cx += p[0] / nv;
      cy += p[1] / nv;
    }
    const cen = vid(cKey, nudge([cx, cy]));
    const corner = V.map((q, k) => vid(latKey(q), Pn[k]));
    const mids = V.map((q, k) => {
      const q2 = V[(k + 1) % nv];
      const m = vid(edgeKey(q, q2), [(Pn[k][0] + Pn[(k + 1) % nv][0]) / 2, (Pn[k][1] + Pn[(k + 1) % nv][1]) / 2]);
      midOf.set(ek(q, q2), m);
      return m;
    });
    for (let k = 0; k < nv; k++) {
      const kp = (k + nv - 1) % nv;
      cells.push(corner[k], mids[k], cen, mids[kp]);
      // (the cell's own triangle: for a merged piece's corners on the shared edge, the one its next edge belongs to)
      cellTri.push(ET[k]);
      cellEdges.push([
        { p: V[k], q: V[(k + 1) % nv], tri: ET[k] },
        { p: V[kp], q: V[k], tri: ET[kp] },
      ]);
    }
  }
  const nc = cells.length / 4;
  const xy = new Float64Array(pos);
  // counter-clockwise, checked
  for (let c = 0; c < nc; c++) {
    let area = 0;
    for (let j = 0; j < 4; j++) {
      const p = cells[c * 4 + j];
      const q = cells[c * 4 + ((j + 1) % 4)];
      area += xy[p * 2] * xy[q * 2 + 1] - xy[q * 2] * xy[p * 2 + 1];
    }
    if (area < 0) throw new Error('tilekit: a clockwise cell from the split (the lattice is CCW by construction)');
  }
  const cellArr = new Int32Array(cells);

  // ---- open ground and the district per cell ----
  const open = new Uint8Array(nc);
  const inDistrict = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) {
    const ti = cellTri[c];
    // (in the district's grain: its triangle paired by the grain — a district triangle whose grain partner lies outside
    // the district is left over and paired by the hashed rule: it belongs to the seam, not to the grain)
    inDistrict[c] = district[ti] && (!o.grain || plaza[ti] || (grain[ti] >= 0 && partner[ti] >= 0 && grain[partner[ti]] === grain[ti])) ? 1 : 0;
    if (plaza[ti]) open[c] = 2;
    for (const e of cellEdges[c]) {
      const r = roadEdge.get(ek(e.p, e.q));
      if (!r) continue;
      if (r.kind === 'road') open[c] = open[c] || 1;
      else if (e.tri === r.sideTri) open[c] = open[c] || 3;
    }
  }

  // ---- road chains (the lattice points and edge middles along each road) ----
  const chains: number[][] = o.plan.roads.map((r) => {
    const ch: number[] = [];
    for (const [p, q] of roadSteps(r)) {
      const a = keyOf.get(latKey(p));
      const m = midOf.get(ek(p, q));
      if (a === undefined || m === undefined) continue;
      if (ch[ch.length - 1] !== a) ch.push(a);
      ch.push(m);
      const b = keyOf.get(latKey(q));
      if (b !== undefined) ch.push(b);
    }
    return ch;
  });

  // ---- relaxation: Townscaper's squaring over the whole window, its rim pinned; roads faired ----
  const pre = finish(xy, cellArr);
  const pinned = new Uint8Array(pre.nv);
  for (let c = 0; c < nc; c++) {
    for (let k = 0; k < 4; k++) {
      if (pre.across[c * 4 + k] < 0) {
        pinned[cellArr[c * 4 + k]] = 1;
        pinned[cellArr[c * 4 + ((k + 1) % 4)]] = 1;
      }
    }
  }
  // (a plaza is an authored polygon: its cells' vertices are held where the lattice put them, the grid round it
  // conforms — relaxed freely, the plaza's lone-triangle cells were squeezed by the roads' and blocks' larger cells to
  // 42% of its area, DEVLOG)
  if (o.holdPlazas ?? true) for (let c = 0; c < nc; c++) if (plaza[cellTri[c]]) for (let k = 0; k < 4; k++) pinned[cellArr[c * 4 + k]] = 1;
  // a vertex on two chains (a junction) or at a chain's end is held by the squaring alone
  const onChain = new Int32Array(pre.nv);
  for (const ch of chains) for (const v of new Set(ch)) onChain[v]++;
  // (seams are grid lines the squaring places; only roads and alleys are faired)
  relax(xy, cellArr, pinned, o.relax, o.fair, chains.filter((_, i) => o.plan.roads[i].kind !== 'seam'), onChain);

  // ---- lots a cell (arch.wgsl tgEmit) ----
  const lot = new Uint32Array(nc);
  const cls = new Uint8Array(nc);
  const lotAt = (p: V2) => owner(...nearestLat(p));
  for (let c = 0; c < nc; c++) {
    const q: V2[] = [0, 1, 2, 3].map((k) => [xy[cellArr[c * 4 + k] * 2], xy[cellArr[c * 4 + k] * 2 + 1]]);
    const lc = lotAt([(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4]);
    let k = 0;
    if (lc !== NONE) {
      k = 1;
      for (const p of q) {
        const l = lotAt(p);
        if (l === NONE) k = Math.max(k, 3);
        else if (l !== lc) k = Math.max(k, 2);
      }
    }
    lot[c] = lc;
    cls[c] = k;
  }
  const mesh = finish(xy, cellArr);
  Object.assign(mesh, { lot, cls, open });
  return { mesh, info: { grain, partner, district, plaza, block, blocks, open, inDistrict, cellTri: new Int32Array(cellTri), chains, kinds: o.plan.roads.map((r) => r.kind), W, a0: o.a0, b0: o.b0, nt } };
}

const rot90 = (x: number, y: number, k: number): V2 => {
  let a = x;
  let b = y;
  for (let i = 0; i < k; i++) [a, b] = [-b, a];
  return [a, b];
};

/** Townscaper's squaring (arch.wgsl tgRelax, without its chunks: the whole window, its rim pinned), then each road's
 *  vertices pulled towards the middle of their neighbours along it (junctions and chain ends left to the squaring) */
export function relax(xy: Float64Array, cells: Int32Array, pinned: Uint8Array, steps: number, fair: number, chains: number[][], onChain: Int32Array) {
  const nv = xy.length / 2;
  const nc = cells.length / 4;
  const acc = new Float64Array(nv * 2);
  const cnt = new Int32Array(nv);
  for (let it = 0; it < steps; it++) {
    acc.fill(0);
    cnt.fill(0);
    for (let c = 0; c < nc; c++) {
      const ix = [cells[c * 4], cells[c * 4 + 1], cells[c * 4 + 2], cells[c * 4 + 3]];
      const p = ix.map((v) => [xy[v * 2], xy[v * 2 + 1]]);
      const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
      const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
      const area = (p[2][0] - p[0][0]) * (p[3][1] - p[1][1]) - (p[3][0] - p[1][0]) * (p[2][1] - p[0][1]);
      let sx = 0;
      let sy = 0;
      for (let j = 0; j < 4; j++) {
        const r = rot90(p[j][0] - cx, p[j][1] - cy, area > 0 ? (4 - j) % 4 : j);
        sx += r[0] / 4;
        sy += r[1] / 4;
      }
      for (let j = 0; j < 4; j++) {
        const r = rot90(sx, sy, area > 0 ? j : (4 - j) % 4);
        acc[ix[j] * 2] += cx + r[0] - p[j][0];
        acc[ix[j] * 2 + 1] += cy + r[1] - p[j][1];
        cnt[ix[j]]++;
      }
    }
    for (let v = 0; v < nv; v++) {
      if (pinned[v] || !cnt[v]) continue;
      xy[v * 2] += (acc[v * 2] / cnt[v]) * 0.6;
      xy[v * 2 + 1] += (acc[v * 2 + 1] / cnt[v]) * 0.6;
    }
    if (fair > 0) {
      for (const ch of chains) {
        for (let i = 1; i + 1 < ch.length; i++) {
          const v = ch[i];
          if (pinned[v] || onChain[v] > 1) continue;
          const a = ch[i - 1];
          const b = ch[i + 1];
          xy[v * 2] += ((xy[a * 2] + xy[b * 2]) / 2 - xy[v * 2]) * fair;
          xy[v * 2 + 1] += ((xy[a * 2 + 1] + xy[b * 2 + 1]) / 2 - xy[v * 2 + 1]) * fair;
        }
      }
    }
  }
}

// ---- measurements ----

/** interior vertex valences by where they are: in plots (every cell round it built ground of the district), on open
 *  ground of the district (a road, plaza or alley cell round it), on the district's edge (district and other cells
 *  round it), outside */
export function valenceZones(m: GridMesh, info: GrainInfo) {
  const n = new Int32Array(m.nv);
  const openV = new Uint8Array(m.nv);
  const inV = new Uint8Array(m.nv);
  const outV = new Uint8Array(m.nv);
  const rim = new Uint8Array(m.nv);
  for (let c = 0; c < m.nc; c++) {
    for (let k = 0; k < 4; k++) {
      const v = m.cells[c * 4 + k];
      n[v]++;
      if (info.inDistrict[c]) inV[v] = 1;
      else outV[v] = 1;
      if (info.open[c]) openV[v] = 1;
      if (m.across[c * 4 + k] < 0) {
        rim[v] = 1;
        rim[m.cells[c * 4 + ((k + 1) % 4)]] = 1;
      }
    }
  }
  const zones: Record<string, Record<number, number>> = { plots: {}, open: {}, edge: {}, outside: {} };
  const where = new Uint8Array(m.nv);
  for (let v = 0; v < m.nv; v++) {
    if (rim[v]) continue;
    const z = inV[v] && outV[v] ? 'edge' : outV[v] ? 'outside' : openV[v] ? 'open' : 'plots';
    where[v] = { plots: 1, open: 2, edge: 3, outside: 4 }[z];
    zones[z][n[v]] = (zones[z][n[v]] ?? 0) + 1;
  }
  return { zones, valence: n, where, rim };
}

/** the interior corner angles of the district's built-ground cells: how square the grain came out */
export function squareness(m: GridMesh, info: GrainInfo, cornerAngle: (m: GridMesh, c: number, k: number) => number) {
  const dev: number[] = [];
  for (let c = 0; c < m.nc; c++) {
    if (!info.inDistrict[c] || info.open[c]) continue;
    for (let k = 0; k < 4; k++) dev.push(Math.abs(cornerAngle(m, c, k) - 90));
  }
  dev.sort((a, b) => a - b);
  const q = (f: number) => +(dev[Math.min(dev.length - 1, Math.floor(dev.length * f))] ?? NaN).toFixed(1);
  return { cells: dev.length / 4, median: q(0.5), p90: q(0.9), max: q(1) };
}
