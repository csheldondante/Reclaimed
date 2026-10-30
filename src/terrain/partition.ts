// Terrain track (round 117): the region graph — the map partitioned into features and rooms, the borders between them
// and what each controller can cross (api/contracts/terrain.ts TerrainGraph). Pure CPU over a grid of samples of the
// land (terrain/sample.ts takes them on the GPU from the atlas's own ground()); unit-tested in partition.test.ts.
//
// Why on the CPU: the samples are few (a 1024-cell square at 4 cells a sample is 65k), the work is graph search
// (union-find, a watershed, Dijkstra per border) that a GPU does badly, and it runs when a run is planned, not per
// frame. The land itself is sampled on the GPU (the atlas's ground: the same heights the columns are made of).
//
// Why this shape (the user: "open fully connected spaces 1-3 screens big and that are part of larger terrain
// features"; "we should know by character controller what they can and can't pass easily"):
//  - FEATURES are the connected land a reference body (the walker by default) moves over without crossing anything it
//    can't: every barrier in the land is between features, by construction.
//  - ROOMS split a feature at its narrow points: a watershed of the distance to the feature's edges (seeds deep inside,
//    spaced a room apart; rooms grown widest-first meet where the land is narrowest — the doors). Small rooms merge.
//  - BORDERS hold measures (the least climb, the shallowest water, the narrowest gap … found by bottleneck searches
//    across the barrier), not a verdict: what a controller can cross is reckoned from its PassCaps when asked (a
//    Dijkstra across the two rooms' ground, cached per caps.id), so a new controller needs no new generation.

import type { BarrierKind, BorderMeasure, PassCaps, TerrainBorder, TerrainGraph, TerrainPass, TerrainRegion, V2 } from '../api/contracts';
import { CAPS_PRESETS } from '../api/contracts/terrain';

/** The land on a grid (world units; row-major w × h). */
export interface TerrainSamples {
  w: number;
  h: number;
  x0: number;
  y0: number;
  /** world units between samples */
  step: number;
  ground: Float32Array;
  /** the water's surface z (NaN: none) */
  water: Float32Array;
  /** 1 a river's channel, 2 a lake, 3 the sea / a flooded basin, 0 none */
  wet: Uint8Array;
  lava: Uint8Array;
  /** vegetation density 0..1 */
  veg: Float32Array;
  seed: number;
}

export interface PartitionOpts {
  /** the controller rooms are made for */
  caps?: PassCaps;
  /** a screen's area (world units²): rooms 1-3 of them */
  screen?: number;
  /** a feature smaller than this many screens is no room (a ledge, a boulder's top): part of the barrier round it */
  minFeature?: number;
}

/** world units² a phone screen shows at the level's fixed view (~120 cells across, ~160 deep) — an assumption to check */
export const SCREEN_AREA = 120 * 160;
/** what a soft barrier of strength 1 adds to a border's cost (cells of walking) */
export const SOFT_COST = 400;

const N4X = [1, -1, 0, 0];
const N4Y = [0, 0, 1, -1];

/** a binary min-heap of (key, value) */
class Heap {
  k: Float64Array;
  v: Int32Array;
  n = 0;
  constructor(cap: number) {
    this.k = new Float64Array(Math.max(cap, 16));
    this.v = new Int32Array(Math.max(cap, 16));
  }
  push(key: number, val: number): void {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2);
      k.set(this.k);
      const v = new Int32Array(this.n * 2);
      v.set(this.v);
      this.k = k;
      this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  /** the smallest's value (its key in `top`) */
  top = 0;
  pop(): number {
    const val = this.v[0];
    this.top = this.k[0];
    const key = this.k[--this.n];
    const v = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = key;
    this.v[i] = v;
    return val;
  }
}

/** water standing on a sample (cells), 0 none */
export const depthAt = (S: TerrainSamples, i: number) => (Number.isNaN(S.water[i]) ? 0 : Math.max(0, S.water[i] - S.ground[i]));

/** a cell a body can stand in at all (not over its depth, not lava, not vegetation it can't push through uncut) */
export function clearFor(S: TerrainSamples, i: number, c: PassCaps): boolean {
  if (c.fly) return true;
  if (depthAt(S, i) > c.deep) return false;
  if (S.lava[i] && !c.lava) return false;
  return S.veg[i] <= c.veg;
}

/**
 * What stepping from sample i to its neighbour j costs a body (cells of walking-equivalent; Infinity: it can't).
 * The ground's rise over the step's run: up to `step` sheer plus `slope` a cell; down: `drop` plus the slope.
 */
export function stepCost(S: TerrainSamples, i: number, j: number, c: PassCaps): number {
  const run = S.step;
  // (a body over water it can't touch bottom in rides its surface: a hovering bike, a swimmer climbs out from it)
  const z = (k: number) => (c.deep === Infinity && depthAt(S, k) > 0 ? S.water[k] : S.ground[k]);
  const dh = z(j) - z(i);
  const fly = c.fly ?? 0;
  if (dh > c.step + c.slope * run + fly) return Infinity;
  if (-dh > c.drop + c.slope * run + (fly ? Infinity : 0)) return Infinity;
  let cost = run + 0.5 * Math.max(dh, 0);
  if (fly) return cost;
  const d = depthAt(S, j);
  if (d > c.deep) return Infinity;
  cost += d * run * 0.5;
  if (S.lava[j] && !c.lava) return Infinity;
  if (S.veg[j] > c.veg) {
    if (!c.vegCost) return Infinity;
    cost += c.vegCost * run;
  }
  return cost;
}

interface Built {
  S: TerrainSamples;
  caps: PassCaps;
  screen: number;
  /** per sample: its room (−1: none — a barrier's inside), and the room whose zone it is in (every sample) */
  room: Int32Array;
  zone: Int32Array;
  /** per sample: its distance from its feature's edge (samples) */
  dist: Float32Array;
  regions: TerrainRegion[];
  borders: TerrainBorder[];
  passes: TerrainPass[];
  /** per border: its crossing pairs (sample i in a's zone, j in b's), flattened */
  pairs: Int32Array[];
  /** rooms (the regions after the features) */
  zoneRooms: number;
}

export function partition(S: TerrainSamples, opts: PartitionOpts = {}): Built {
  // (TERRAIN_PROF=1 in Node: each phase's ms)
  const PROF = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TERRAIN_PROF;
  let tp = performance.now();
  const prof = (k: string) => {
    if (!PROF) return;
    const t = performance.now();
    console.log(`partition ${k}: ${(t - tp).toFixed(1)} ms`);
    tp = t;
  };
  const caps = opts.caps ?? CAPS_PRESETS.walker;
  const screen = opts.screen ?? SCREEN_AREA;
  const minFeature = opts.minFeature ?? 0.08;
  const { w, h } = S;
  const N = w * h;
  const cellA = S.step * S.step;
  const clear = new Uint8Array(N);
  for (let i = 0; i < N; i++) clear[i] = clearFor(S, i, caps) ? 1 : 0;
  // undirected passable edges (east and south of each sample): both ways for the reference body
  const passE = new Uint8Array(N);
  const passS = new Uint8Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!clear[i]) continue;
      if (x + 1 < w && clear[i + 1] && stepCost(S, i, i + 1, caps) < Infinity && stepCost(S, i + 1, i, caps) < Infinity) passE[i] = 1;
      if (y + 1 < h && clear[i + w] && stepCost(S, i, i + w, caps) < Infinity && stepCost(S, i + w, i, caps) < Infinity) passS[i] = 1;
    }
  const linked = (i: number, k: number): boolean => {
    const x = i % w;
    if (k === 0) return x + 1 < w && passE[i] === 1;
    if (k === 1) return x > 0 && passE[i - 1] === 1;
    if (k === 2) return i + w < N && passS[i] === 1;
    return i - w >= 0 && passS[i - w] === 1;
  };
  prof('edges');
  // features: union-find over the passable edges
  const par = new Int32Array(N);
  for (let i = 0; i < N; i++) par[i] = i;
  const find = (i: number): number => {
    while (par[i] !== i) {
      par[i] = par[par[i]];
      i = par[i];
    }
    return i;
  };
  for (let i = 0; i < N; i++) {
    if (passE[i]) par[find(i)] = find(i + 1);
    if (passS[i]) par[find(i)] = find(i + w);
  }
  const compSize = new Map<number, number>();
  for (let i = 0; i < N; i++) if (clear[i]) compSize.set(find(i), (compSize.get(find(i)) ?? 0) + 1);
  const minSamples = Math.max(4, (minFeature * screen) / cellA);
  const comp = new Int32Array(N).fill(-1);
  const featOf = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (!clear[i]) continue;
    const r = find(i);
    if ((compSize.get(r) ?? 0) < minSamples) continue;
    let f = featOf.get(r);
    if (f === undefined) featOf.set(r, (f = featOf.size));
    comp[i] = f;
  }
  prof('features');
  // distance from each feature sample to its feature's edge (a sample with an edge it can't take: BFS, 4 neighbours)
  const dist = new Float32Array(N).fill(-1);
  let q: number[] = [];
  for (let i = 0; i < N; i++) {
    if (comp[i] < 0) continue;
    let edge = false;
    for (let k = 0; k < 4 && !edge; k++) {
      const x = (i % w) + N4X[k];
      const y = Math.floor(i / w) + N4Y[k];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (!linked(i, k)) edge = true;
    }
    if (edge) {
      dist[i] = 0;
      q.push(i);
    }
  }
  for (let d = 0; q.length; d++) {
    const nq: number[] = [];
    for (const i of q)
      for (let k = 0; k < 4; k++) {
        if (!linked(i, k)) continue;
        const j = i + N4X[k] + N4Y[k] * w;
        if (dist[j] >= 0) continue;
        dist[j] = d + 1;
        nq.push(j);
      }
    q = nq;
  }
  // (a feature with no edge in the rectangle — all of it open: its distance from the rectangle's border)
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && dist[i] < 0) dist[i] = Math.min(i % w, w - 1 - (i % w), Math.floor(i / w), h - 1 - Math.floor(i / w));
  // (a feature with no clear disc two samples across is a slot — a ravine's floor, a ledge: part of the barrier round it)
  const deepest = new Float32Array(featOf.size).fill(-1);
  for (let i = 0; i < N; i++) if (comp[i] >= 0) deepest[comp[i]] = Math.max(deepest[comp[i]], dist[i]);
  {
    const keep = new Int32Array(featOf.size).fill(-1);
    let nk = 0;
    for (let f = 0; f < featOf.size; f++) if (deepest[f] >= 2) keep[f] = nk++;
    for (let i = 0; i < N; i++) if (comp[i] >= 0) comp[i] = keep[comp[i]];
    for (const [r, f] of [...featOf]) {
      if (keep[f] < 0) featOf.delete(r);
      else featOf.set(r, keep[f]);
    }
  }
  prof('dist');
  // rooms: seeds deepest first, a room's spacing apart in its feature; a watershed grown widest first
  // (seeds closer than a room's size — rooms then merge up to three screens: a long shared edge is no narrows)
  const spacing = Math.sqrt(1.2 * screen) / S.step;
  // (deepest first: a counting sort on the whole-sample distances, index order within one)
  let maxD = 0;
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && dist[i] > maxD) maxD = dist[i];
  const byD = new Int32Array(Math.floor(maxD) + 2);
  for (let i = 0; i < N; i++) if (comp[i] >= 0) byD[Math.floor(maxD) - Math.floor(dist[i]) + 1]++;
  for (let d = 1; d < byD.length; d++) byD[d] += byD[d - 1];
  const order = new Int32Array(byD[byD.length - 1]);
  for (let i = 0; i < N; i++) if (comp[i] >= 0) order[byD[Math.floor(maxD) - Math.floor(dist[i])]++] = i;
  const bin = Math.max(1, Math.floor(spacing));
  const bins = new Map<number, number[]>();
  const room = new Int32Array(N).fill(-1);
  const seeds: number[] = [];
  const featArea = new Map<number, number>();
  for (const i of order) featArea.set(comp[i], (featArea.get(comp[i]) ?? 0) + 1);
  const seededFeat = new Set<number>();
  for (const i of order) {
    const x = i % w;
    const y = Math.floor(i / w);
    const f = comp[i];
    // (a feature of up to three screens is one room)
    if ((featArea.get(f) ?? 0) * cellA <= 3 * screen && seededFeat.has(f)) continue;
    const bx = Math.floor(x / bin);
    const by = Math.floor(y / bin);
    let near = false;
    for (let oy = -1; oy <= 1 && !near; oy++)
      for (let ox = -1; ox <= 1 && !near; ox++)
        for (const s of bins.get((by + oy) * 65536 + bx + ox) ?? []) {
          if (comp[s] !== f) continue;
          if (Math.hypot((s % w) - x, Math.floor(s / w) - y) < spacing) {
            near = true;
            break;
          }
        }
    if (near) continue;
    room[i] = seeds.length;
    seeds.push(i);
    seededFeat.add(f);
    const key = by * 65536 + bx;
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key)!.push(i);
  }
  prof('seeds');
  // grown together from every seed by a weighted geodesic distance — a step costs more the nearer the feature's edge
  // (1 + NARROW / (1 + dist)): on open land the rooms are a Voronoi of the seeds (bounded in size); where the land
  // narrows the crossing is dear, so two rooms meet in the narrows (the door), not in the halls
  const NARROW = 6;
  const far = new Float64Array(N).fill(Infinity);
  const heap = new Heap(N);
  for (const s0 of seeds) {
    far[s0] = 0;
    heap.push(0, s0);
  }
  while (heap.n) {
    const i = heap.pop();
    const c = heap.top;
    if (c > far[i]) continue;
    for (let k = 0; k < 4; k++) {
      if (!linked(i, k)) continue;
      const j = i + N4X[k] + N4Y[k] * w;
      if (comp[j] < 0) continue;
      const nc = c + 1 + NARROW / (1 + dist[j]);
      if (nc < far[j]) {
        far[j] = nc;
        room[j] = room[i];
        heap.push(nc, j);
      }
    }
  }
  prof('grow');
  // merge: a room under a screen into the neighbour (of its feature) it shares the most edge with; then neighbours
  // across a long shared edge (no narrows between them) while the two together stay within three screens
  let nRooms = seeds.length;
  {
    const into = new Int32Array(nRooms).map((_, r) => r);
    const res = (r: number) => {
      while (into[r] !== r) r = into[r] = into[into[r]];
      return r;
    };
    const area = new Float64Array(nRooms);
    for (let i = 0; i < N; i++) if (room[i] >= 0) area[room[i]]++;
    const edge = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      if (room[i] < 0) continue;
      for (const k of [0, 2]) {
        if (!linked(i, k)) continue;
        const a0 = room[i];
        const b0 = room[i + N4X[k] + N4Y[k] * w];
        if (a0 === b0) continue;
        const key = Math.min(a0, b0) * 65536 + Math.max(a0, b0);
        edge.set(key, (edge.get(key) ?? 0) + 1);
      }
    }
    const pairsBy = [...edge].sort((x, y) => y[1] - x[1]);
    // (1) small rooms, smallest first: into the neighbour sharing the most edge that keeps the two within three screens
    // (else the one sharing the most)
    for (let again = true; again; ) {
      again = false;
      const small = [...Array(nRooms).keys()].filter((r) => res(r) === r && area[r] * cellA < screen).sort((x, y) => area[x] - area[y]);
      for (const r0 of small) {
        const r = res(r0);
        if (area[r] * cellA >= screen) continue;
        const shared = new Map<number, number>();
        for (const [m0, len] of pairsBy.map(([k, l]) => [k, l] as [number, number])) {
          const a0 = res(Math.floor(m0 / 65536));
          const b0 = res(m0 % 65536);
          if (a0 === b0 || (a0 !== r && b0 !== r)) continue;
          const o = a0 === r ? b0 : a0;
          shared.set(o, (shared.get(o) ?? 0) + len);
        }
        let best = -1;
        let bl = -1;
        let fit = false;
        for (const [o, len] of shared) {
          const ok = (area[o] + area[r]) * cellA <= 3 * screen;
          if ((ok && !fit) || (ok === fit && len > bl)) (best = o), (bl = len), (fit = ok);
        }
        if (best < 0) continue;
        into[r] = best;
        area[best] += area[r];
        again = true;
      }
    }
    // (2) neighbours across a long shared edge (no narrows between them) while the two stay within three screens
    for (let again = true; again; ) {
      again = false;
      for (const [key, len] of pairsBy) {
        const a0 = res(Math.floor(key / 65536));
        const b0 = res(key % 65536);
        if (a0 === b0) continue;
        const sa = area[a0] * cellA;
        const sb = area[b0] * cellA;
        if (sa + sb > 3 * screen || len * S.step < 0.5 * Math.sqrt(Math.min(sa, sb))) continue;
        into[b0] = a0;
        area[a0] += area[b0];
        again = true;
      }
    }
    const dense = new Map<number, number>();
    for (let r = 0; r < nRooms; r++) {
      const t = res(r);
      if (!dense.has(t)) dense.set(t, dense.size);
    }
    for (let i = 0; i < N; i++) if (room[i] >= 0) room[i] = dense.get(res(room[i]))!;
    nRooms = dense.size;
  }
  prof('merge');
  // zones: every sample to its nearest room (BFS over all samples): a barrier's samples split between its two sides
  const zone = Int32Array.from(room);
  q = [];
  for (let i = 0; i < N; i++) if (room[i] >= 0) q.push(i);
  while (q.length) {
    const nq: number[] = [];
    for (const i of q) {
      const x = i % w;
      for (let k = 0; k < 4; k++) {
        const nx = x + N4X[k];
        const j = i + N4X[k] + N4Y[k] * w;
        if (nx < 0 || nx >= w || j < 0 || j >= N || zone[j] >= 0) continue;
        zone[j] = zone[i];
        nq.push(j);
      }
    }
    q = nq;
  }
  prof('zones');
  // regions: features then rooms
  const regions: TerrainRegion[] = [];
  const nFeat = featOf.size;
  const roomFeat = new Int32Array(nRooms).fill(-1);
  for (let i = 0; i < N; i++) if (room[i] >= 0) roomFeat[room[i]] = comp[i];
  const mk = (id: number, level: 0 | 1, parent: number): TerrainRegion => ({ id, level, parent, children: [], area: 0, screens: 0, centre: [0, 0], bounds: [Infinity, Infinity, -Infinity, -Infinity], floor: [0, 0, 0], openness: 0 });
  for (let f = 0; f < nFeat; f++) regions.push(mk(f, 0, -1));
  for (let r = 0; r < nRooms; r++) {
    const R = mk(nFeat + r, 1, roomFeat[r]);
    regions.push(R);
    if (roomFeat[r] >= 0) regions[roomFeat[r]].children.push(R.id);
  }
  // (per sample its feature and its room; heights gathered per region in one typed array, a region's run sorted)
  const nReg = regions.length;
  const cnt = new Int32Array(nReg + 1);
  const best = new Float32Array(nReg).fill(-1);
  const touch = (id: number, i: number, x: number, y: number) => {
    const R = regions[id];
    cnt[id + 1]++;
    if (x < R.bounds[0]) R.bounds[0] = x;
    if (y < R.bounds[1]) R.bounds[1] = y;
    if (x + S.step > R.bounds[2]) R.bounds[2] = x + S.step;
    if (y + S.step > R.bounds[3]) R.bounds[3] = y + S.step;
    if (dist[i] > best[id]) {
      best[id] = dist[i];
      R.centre = [x, y];
      R.openness = dist[i] * S.step;
    }
  };
  for (let i = 0; i < N; i++) {
    if (comp[i] < 0) continue;
    const x = S.x0 + (i % w) * S.step;
    const y = S.y0 + Math.floor(i / w) * S.step;
    touch(comp[i], i, x, y);
    if (room[i] >= 0) touch(nFeat + room[i], i, x, y);
  }
  for (let r = 0; r < nReg; r++) cnt[r + 1] += cnt[r];
  const zs = new Float32Array(cnt[nReg]);
  const fill = cnt.slice(0, nReg);
  for (let i = 0; i < N; i++) {
    if (comp[i] < 0) continue;
    zs[fill[comp[i]]++] = S.ground[i];
    if (room[i] >= 0) zs[fill[nFeat + room[i]]++] = S.ground[i];
  }
  for (const R of regions) {
    const n0 = cnt[R.id];
    const n1 = cnt[R.id + 1];
    R.area = (n1 - n0) * cellA;
    R.screens = +(R.area / screen).toFixed(2);
    const z = zs.subarray(n0, n1).sort();
    R.floor = z.length ? [z[0], z[z.length >> 1], z[z.length - 1]] : [0, 0, 0];
  }
  prof('regions');
  // borders: zone boundaries; open where two rooms' own samples meet by a passable edge, else a barrier
  const bmap = new Map<number, { a: number; b: number; open: number; pairs: number[]; edges: number }>();
  for (let i = 0; i < N; i++) {
    for (const k of [0, 2]) {
      if (k === 0 && (i % w) + 1 >= w) continue;
      const j = i + N4X[k] + N4Y[k] * w;
      if (j >= N) continue;
      const za = zone[i];
      const zb = zone[j];
      if (za < 0 || zb < 0 || za === zb) continue;
      const a = Math.min(za, zb);
      const b = Math.max(za, zb);
      const key = a * 65536 + b;
      let B = bmap.get(key);
      if (!B) bmap.set(key, (B = { a, b, open: 0, pairs: [], edges: 0 }));
      B.edges++;
      // (i in a's zone, j in b's)
      if (za === a) B.pairs.push(i, j);
      else B.pairs.push(j, i);
      if (room[i] >= 0 && room[j] >= 0 && linked(i, k)) B.open++;
    }
  }
  const borders: TerrainBorder[] = [];
  const passes: TerrainPass[] = [];
  const pairs: Int32Array[] = [];
  const built: Built = { S, caps, screen, room, zone, dist, regions, borders, passes, pairs, zoneRooms: nRooms };
  for (const B of bmap.values()) {
    const id = borders.length;
    const ra = nFeat + B.a;
    const rb = nFeat + B.b;
    const P = Int32Array.from(B.pairs);
    pairs.push(P);
    const T: TerrainBorder = { id, a: ra, b: rb, kind: 'open', causes: [], length: B.edges * S.step, measure: measureOf(built, ra, rb, P), passes: [], soft: [] };
    if (B.open > 0) {
      T.causes = ['open'];
      // the door: the open pair deepest inside (the widest point of the narrows)
      let bi = -1;
      let bd = -1;
      for (let k = 0; k < P.length; k += 2) {
        const i = P[k];
        const j = P[k + 1];
        if (room[i] < 0 || room[j] < 0) continue;
        const d = Math.min(dist[i], dist[j]);
        if (d > bd) (bd = d), (bi = i);
      }
      if (bi >= 0) {
        passes.push({ id: passes.length, border: id, at: [S.x0 + (bi % w) * S.step, S.y0 + Math.floor(bi / w) * S.step], width: (2 * bd + 1) * S.step, kind: 'opening', edit: -1 });
        T.passes.push(passes.length - 1);
      }
    } else {
      T.causes = causesOf(built, T, P);
      T.kind = T.causes[0] ?? 'steep';
    }
    borders.push(T);
  }
  prof('borders');
  return built;
}

/** the cause at a barrier sample, against the two rooms' floors */
function causeAt(B: Built, i: number, fa: number, fb: number): BarrierKind {
  const S = B.S;
  const c = B.caps;
  if (S.lava[i]) return 'lava';
  const d = depthAt(S, i);
  if (d > c.deep) return S.wet[i] === 1 ? 'river' : S.wet[i] === 3 ? 'sea' : 'lake';
  if (S.veg[i] > c.veg) return 'vegetation';
  const g = S.ground[i];
  if (g < Math.min(fa, fb) - c.drop) return 'ravine';
  if (g > Math.max(fa, fb) + 3 * c.step) return 'ridge';
  // (the steepest rise to a neighbour: a sheer face is a cliff, a slope a steep flank)
  let m = 0;
  const w = S.w;
  for (let k = 0; k < 4; k++) {
    const x = (i % w) + N4X[k];
    const j = i + N4X[k] + N4Y[k] * w;
    if (x < 0 || x >= w || j < 0 || j >= S.ground.length) continue;
    m = Math.max(m, Math.abs(S.ground[j] - g));
  }
  return m > 3 * c.step + c.slope * S.step ? 'cliff' : 'steep';
}

function causesOf(B: Built, T: TerrainBorder, P: Int32Array): BarrierKind[] {
  const fa = B.regions[T.a].floor[1];
  const fb = B.regions[T.b].floor[1];
  const n = new Map<BarrierKind, number>();
  for (let k = 0; k < P.length; k += 2) {
    for (const i of [P[k], P[k + 1]]) {
      const c = B.room[i] >= 0 ? null : causeAt(B, i, fa, fb);
      // (two rooms' own samples facing each other across a sheer step: a cliff between them)
      const kind = c ?? (Math.abs(B.S.ground[P[k]] - B.S.ground[P[k + 1]]) > 3 * B.caps.step ? 'cliff' : 'steep');
      n.set(kind, (n.get(kind) ?? 0) + 1);
    }
  }
  return [...n].sort((x, y) => y[1] - x[1]).map((e) => e[0]);
}

/** the samples in two zones (a's and b's), with the room samples of each marked */
const zoneLists = new WeakMap<Built, number[][]>();
function zoneCells(B: Built, ra: number, rb: number): { cells: number[]; src: number[]; dst: number[] } {
  const nFeat = B.regions.filter((r) => r.level === 0).length;
  let L = zoneLists.get(B);
  if (!L) {
    L = [];
    for (let i = 0; i < B.zone.length; i++) {
      const z = B.zone[i];
      if (z < 0) continue;
      (L[z] ??= []).push(i);
    }
    zoneLists.set(B, L);
  }
  const za = ra - nFeat;
  const zb = rb - nFeat;
  const cells = [...(L[za] ?? []), ...(L[zb] ?? [])];
  const src: number[] = [];
  const dst: number[] = [];
  for (const i of cells) {
    if (B.room[i] === za) src.push(i);
    else if (B.room[i] === zb) dst.push(i);
  }
  return { cells, src, dst };
}

/** the two zones' samples made ready for searches across them (slot: each sample's index in `cells`, −1 none) */
interface Zones {
  cells: number[];
  src: number[];
  dst: number[];
  slot: Int32Array;
}
const slots = new WeakMap<Built, Int32Array>();
const seenOf = new WeakMap<Built, Uint8Array>();
/**
 * The samples of the two zones within a band round their border: rings out from its crossing pairs until both rooms'
 * own samples are reached, then `extra` rings more (a crossing's search needs the barrier and a little of each side,
 * not the whole of two rooms — the partition's borders' measures were most of its time)
 */
function bandCells(B: Built, za: number, zb: number, P: Int32Array, extra: number): { cells: number[]; src: number[]; dst: number[] } {
  const S = B.S;
  const w = S.w;
  const N = B.zone.length;
  let seen = seenOf.get(B);
  if (!seen) seenOf.set(B, (seen = new Uint8Array(N)));
  const cells: number[] = [];
  let front: number[] = [];
  for (let k = 0; k < P.length; k++) {
    const i = P[k];
    if (seen[i]) continue;
    seen[i] = 1;
    cells.push(i);
    front.push(i);
  }
  let gotA = false;
  let gotB = false;
  let more = -1;
  for (let ring = 0; front.length && ring < 400; ring++) {
    for (const i of front) {
      if (B.room[i] === za) gotA = true;
      else if (B.room[i] === zb) gotB = true;
    }
    if (more < 0 && gotA && gotB) more = extra;
    if (more === 0) break;
    if (more > 0) more--;
    const next: number[] = [];
    for (const i of front) {
      const xi = i % w;
      for (let d = 0; d < 4; d++) {
        const x = xi + N4X[d];
        const j = i + N4X[d] + N4Y[d] * w;
        if (x < 0 || x >= w || j < 0 || j >= N || seen[j]) continue;
        const z = B.zone[j];
        if (z !== za && z !== zb) continue;
        seen[j] = 1;
        cells.push(j);
        next.push(j);
      }
    }
    front = next;
  }
  for (const c of cells) seen[c] = 0;
  const src: number[] = [];
  const dst: number[] = [];
  for (const i of cells) {
    if (B.room[i] === za) src.push(i);
    else if (B.room[i] === zb) dst.push(i);
  }
  return { cells, src, dst };
}

function zonesFor(B: Built, ra: number, rb: number, P?: Int32Array, extra = 4): Zones {
  const nFeat = B.regions.length - B.zoneRooms;
  const { cells, src, dst } = P && P.length ? bandCells(B, ra - nFeat, rb - nFeat, P, extra) : zoneCells(B, ra, rb);
  let slot = slots.get(B);
  if (!slot) slots.set(B, (slot = new Int32Array(B.zone.length).fill(-1)));
  for (let k = 0; k < cells.length; k++) slot[cells[k]] = k;
  return { cells, src, dst, slot };
}
function release(Z: Zones): void {
  for (const c of Z.cells) Z.slot[c] = -1;
}

/**
 * The cheapest way from a's room samples to b's over the two zones for a body (Dijkstra; cost per stepCost), or with
 * `bottleneck` the path minimising the worst of edge(i, j) along it. Returns the cost and the path.
 */
function search(B: Built, Z: Zones, edge: (i: number, j: number) => number, bottleneck: boolean): { cost: number; path: number[] } {
  const S = B.S;
  const { cells, src, dst, slot } = Z;
  if (!src.length || !dst.length) return { cost: Infinity, path: [] };
  const isDst = new Uint8Array(cells.length);
  for (const d of dst) isDst[slot[d]] = 1;
  const best = new Float64Array(cells.length).fill(Infinity);
  const from = new Int32Array(cells.length).fill(-1);
  const H = new Heap(cells.length);
  for (const s0 of src) {
    const k = slot[s0];
    best[k] = 0;
    H.push(0, k);
  }
  const w = S.w;
  const N = S.ground.length;
  while (H.n) {
    const k = H.pop();
    const c = H.top;
    if (c > best[k]) continue;
    if (isDst[k]) {
      const path: number[] = [];
      for (let t = k; t >= 0; t = from[t]) path.push(cells[t]);
      return { cost: c, path: path.reverse() };
    }
    const i = cells[k];
    const xi = i % w;
    for (let d = 0; d < 4; d++) {
      const x = xi + N4X[d];
      const j = i + N4X[d] + N4Y[d] * w;
      if (x < 0 || x >= w || j < 0 || j >= N) continue;
      const kj = slot[j];
      if (kj < 0) continue;
      const e = edge(i, j);
      if (e === Infinity) continue;
      const nc = bottleneck ? Math.max(c, e) : c + e;
      if (nc < best[kj]) {
        best[kj] = nc;
        from[kj] = k;
        H.push(nc, kj);
      }
    }
  }
  return { cost: Infinity, path: [] };
}

function measureOf(B: Built, ra: number, rb: number, P: Int32Array): BorderMeasure {
  const S = B.S;
  const fa = B.regions[ra].floor[1];
  const fb = B.regions[rb].floor[1];
  if (!P.length) return { rise: fb - fa, minClimb: 0, minDrop: 0, minDeep: 0, minWaterSpan: 0, lava: false, minVeg: 0, minGap: 0 };
  const Z = zonesFor(B, ra, rb, P);
  const climb = search(B, Z, (i, j) => Math.max(0, S.ground[j] - S.ground[i]), true).cost;
  const drop = search(B, Z, (i, j) => Math.max(0, S.ground[i] - S.ground[j]), true).cost;
  const deep = search(B, Z, (_i, j) => depthAt(S, j), true).cost;
  const veg = search(B, Z, (_i, j) => S.veg[j], true).cost;
  const lavaFree = search(B, Z, (_i, j) => (S.lava[j] ? Infinity : 0), true).cost;
  // spans: the fewest wet / non-room samples a crossing must go over
  const wetSpan = search(B, Z, (_i, j) => (depthAt(S, j) > 0 ? S.step : 0), false).cost;
  const gap = search(B, Z, (_i, j) => (B.room[j] < 0 && S.ground[j] < Math.min(fa, fb) - B.caps.drop ? S.step : 0), false).cost;
  release(Z);
  const r2 = (x: number) => (Number.isFinite(x) ? +x.toFixed(2) : x);
  return { rise: r2(fb - fa), minClimb: r2(climb), minDrop: r2(drop), minDeep: r2(deep), minWaterSpan: r2(wetSpan), lava: lavaFree === Infinity, minVeg: r2(veg), minGap: r2(gap) };
}

/** the graph's object: the contract over a built partition */
export class RegionGraph implements TerrainGraph {
  readonly rect: [number, number, number, number];
  readonly step: number;
  readonly screen: number;
  readonly seed: number;
  private costs = new Map<string, number>();
  private routes = new Map<string, number[]>();
  private nFeat: number;
  /** passes made by edits, by border: a predicate on caps and the cost of the crossing it makes */
  private made = new Map<number, { pass: number; ok: (c: PassCaps) => boolean; cost: number }[]>();
  /** borders closed by edits: a predicate on caps (true: still passable for it) */
  private closed = new Map<number, ((c: PassCaps) => boolean)[]>();
  constructor(readonly built: Built) {
    const S = built.S;
    this.rect = [S.x0, S.y0, S.x0 + S.w * S.step, S.y0 + S.h * S.step];
    this.step = S.step;
    this.screen = built.screen;
    this.seed = S.seed;
    this.nFeat = built.regions.filter((r) => r.level === 0).length;
  }
  regions(): TerrainRegion[] {
    return this.built.regions;
  }
  rooms(): TerrainRegion[] {
    return this.built.regions.filter((r) => r.level === 1);
  }
  features(): TerrainRegion[] {
    return this.built.regions.filter((r) => r.level === 0);
  }
  region(id: number): TerrainRegion {
    const r = this.built.regions[id];
    if (!r) throw new Error(`terrain graph: no region ${id}`);
    return r;
  }
  roomAt(at: V2): number {
    const S = this.built.S;
    const x = Math.round((at[0] - S.x0) / S.step);
    const y = Math.round((at[1] - S.y0) / S.step);
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return -1;
    const r = this.built.room[y * S.w + x];
    return r < 0 ? -1 : this.nFeat + r;
  }
  borders(room?: number): TerrainBorder[] {
    return room === undefined ? this.built.borders : this.built.borders.filter((b) => b.a === room || b.b === room);
  }
  border(id: number): TerrainBorder {
    const b = this.built.borders[id];
    if (!b) throw new Error(`terrain graph: no border ${id}`);
    return b;
  }
  pass(id: number): TerrainPass {
    return this.built.passes[id];
  }
  /** the samples of the route a body takes across a border (after cost(); empty: none) */
  route(border: number, caps: PassCaps, from?: number): number[] {
    this.cost(border, caps, from);
    const B = this.border(border);
    return this.routes.get(`${border}:${caps.id}:${from ?? B.a}`) ?? [];
  }
  cost(border: number, caps: PassCaps, from?: number): number {
    const B = this.border(border);
    const a = from ?? B.a;
    if (a !== B.a && a !== B.b) throw new Error(`terrain graph: room ${a} isn't on border ${border}`);
    const b = a === B.a ? B.b : B.a;
    const key = `${border}:${caps.id}:${a}`;
    let c = this.costs.get(key);
    if (c === undefined) {
      const S = this.built.S;
      // (a body's route: a wider band — it may go round)
      const Z = zonesFor(this.built, a, b, this.built.pairs[border], 12);
      const r = search(this.built, Z, (i, j) => stepCost(S, i, j, caps), false);
      release(Z);
      c = r.cost;
      // a gap jumped (level or down, at speed): the narrowest gap's span and a run-up
      const rise = (this.region(b).floor[1] - this.region(a).floor[1]);
      if (c === Infinity && caps.gap && B.measure.minGap > 0 && B.measure.minGap <= caps.gap && rise <= caps.step + caps.slope * S.step) c = 4 * B.measure.minGap;
      this.costs.set(key, c);
      this.routes.set(key, r.path);
    }
    for (const m of this.made.get(border) ?? []) if (m.ok(caps)) c = Math.min(c, m.cost);
    for (const ok of this.closed.get(border) ?? []) if (!ok(caps)) c = Infinity;
    for (const s of B.soft) c += s.strength * SOFT_COST;
    return c;
  }
  exits(room: number, caps: PassCaps): { border: number; to: number; cost: number }[] {
    const out: { border: number; to: number; cost: number }[] = [];
    for (const B of this.borders(room)) {
      const c = this.cost(B.id, caps, room);
      if (c < Infinity) out.push({ border: B.id, to: B.a === room ? B.b : B.a, cost: c });
    }
    return out.sort((x, y) => x.cost - y.cost);
  }
  reach(room: number, caps: PassCaps): number[] {
    const seen = new Set([room]);
    const q = [room];
    while (q.length) {
      const r = q.shift()!;
      for (const e of this.exits(r, caps)) if (!seen.has(e.to)) seen.add(e.to), q.push(e.to);
    }
    return [...seen].sort((a, b) => a - b);
  }
  soften(border: number, kind: BarrierKind, strength: number): void {
    this.border(border).soft.push({ kind, strength: Math.max(0, Math.min(1, strength)) });
  }
  /** (TerrainSystem.request) a pass made by an edit */
  addMade(border: number, pass: Omit<TerrainPass, 'id' | 'border'>, ok: (c: PassCaps) => boolean, cost: number): TerrainPass {
    const P: TerrainPass = { ...pass, id: this.built.passes.length, border };
    this.built.passes.push(P);
    this.border(border).passes.push(P.id);
    if (!this.made.has(border)) this.made.set(border, []);
    this.made.get(border)!.push({ pass: P.id, ok, cost });
    return P;
  }
  /** (TerrainSystem.request) a border closed to bodies `ok` says false for */
  addClosed(border: number, ok: (c: PassCaps) => boolean): void {
    if (!this.closed.has(border)) this.closed.set(border, []);
    this.closed.get(border)!.push(ok);
  }
  /** a sample's world position */
  at(i: number): V2 {
    const S = this.built.S;
    return [S.x0 + (i % S.w) * S.step, S.y0 + Math.floor(i / S.w) * S.step];
  }
}
