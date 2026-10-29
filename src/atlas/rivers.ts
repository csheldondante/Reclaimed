// The atlas's rivers (round 69: "it would be cool to add waterfalls or lava waterfalls" / "And
// rivers (water or lava)"), on the CPU over the macro ground (hmac):
//  - the land drains to the sea: a priority flood from the coast (8 neighbours) fills every hollow
//    to its spill height (a hair more each step, so flats drain too) and gives each texel the one
//    it drains to — a drainage tree with its roots in the water;
//  - what drains through each texel (texels upstream, fewer where the latitude is dry) — over
//    RIVER_MIN, a river, wider downstream; its level is the filled ground's, so it only falls, and
//    where the ground drops away (a cliff) it falls all at once: a waterfall;
//  - lava rivers: from the top of each volcanic region (lavafield, basalt, rift) down the same tree,
//    LAVA_RUN texels at most.
// The rivers are nodes (a texel each: where, its level, width, depth, the next one down); the GPU
// spreads the nearest node to every texel (JFA, build.wgsl jfaSeedV/jfaOutV) and compose.wgsl
// carves a channel along the segments between nodes.

import { warmth } from './regions';

/** texels drained through for a river, and the most a lava river runs */
const RIVER_MIN = 160;
const LAVA_RUN = 40;
/** u32 words a node (compose.wgsl RiverNode) */
export const NODE_WORDS = 8;
export const RIVER_LAVA = 1;
/**
 * (rivers branch, round 84 — the user: "Find the atlas level rivers and what watersheds feed them … precompute the
 * flow of those as a function of dryness … the unperturbed river basin as a steady state with no actual simulation
 * and flow as strictly a render artifact computed at the atlas level") A node's discharge at the reference wetness:
 * RIVER_RUNOFF cells³ a tick for each texel its watershed drains (acc: texels upstream, fewer where the latitude is
 * dry). The water's pipes (water_flux.wgsl) carry a flow set by the level's fall, not by the depth — the steady
 * surface slope for a discharge Q through a channel W columns wide is Q / (PIPE_Q · W), PIPE_Q = GAIN / (1 −
 * FRICTION) / 2 — so the depth is the channel's (the carve's) and the speed is Q over the wetted section, quickened
 * where the level falls fast (rapids). The rating for other wetness (Q × wet) is the riverFlow contract's
 * (sim/world-gpu.ts RIVER_DEPTH_EXP, RIVER_SPEED_EXP).
 */
export const RIVER_RUNOFF = 0.002;
const PIPE_Q = 0.08 / 0.015 / 2;

/**
 * (round 90, BACKLOG W2 — the user: "For the rivers why does the river height lie above the dip? Is it because the
 * river exits going higher? If so can we compute that the region is flooded at the atlas level?") The priority
 * flood fills every hollow to its spill height; a filled hollow is a lake when its water would stand LAKE_DEPTH
 * deep or more and LAKE_CATCH (texels, dryness-weighted, as `acc`) or more drains into it. Its extent: the texels
 * whose filled level is over the ground by LAKE_EPS (less is a flat the flood only tilted); its level: the spill
 * height (the lowest filled level in it); its outlet: the rim texel it spills over. A shallower or drier hollow
 * isn't kept: a river through it follows its floor.
 */
const LAKE_EPS = 0.25;
const LAKE_DEPTH = 2.5;
const LAKE_CATCH = 30;
/** the rim round a lake (texels, 8 neighbours) the region generator raises its shore on (compose.wgsl lakeAt) */
const LAKE_RING = 2;
/** per texel (Rivers.lakeAt): the lake's id + 1 in the low 15 bits; this bit set inside it (unset: its rim) */
export const LAKE_IN = 0x8000;
/** u32 words a lake in the GPU's table (compose.wgsl lakeAt): its level, 0 */
export const LAKE_WORDS = 2;

export interface AtlasLake {
  id: number;
  /** its water's level (world z): the spill height */
  level: number;
  /** texels of the macro map, and the deepest water over the macro ground */
  texels: number;
  depth: number;
  /** world units: its middle (the mean of its texels), the outlet (the rim texel it spills over) */
  at: [number, number];
  outlet: [number, number];
  /** what drains into it (texels, dryness-weighted) */
  catchment: number;
  /** river nodes running into it from outside, and the node of the river leaving it (−1: none) */
  inflow: number;
  outflow: number;
  /** the regions (dense ids) it lies in */
  regions: number[];
}

/**
 * (round 109, watershed — the user: "I want it per water shed please") Which river each piece of land drains into:
 * the land sampled every CATCH_STEP texels, each sample the node its water reaches first going down the drainage
 * tree (−1: it reaches the sea or a lake's floor with no river on the way). A node's own catchment is the samples
 * that are its; what reaches it from upstream is its upstream nodes' (`order`, `next`). weather/catchwet.ts rains on
 * the samples under the storms.
 */
export interface Catchments {
  /** texels between samples, the samples a side (n / step) */
  step: number;
  side: number;
  /** per sample (row-major, side × side): its node, −1 none */
  of: Int32Array;
  /** per sample row: a sample's runoff (texels it stands for × the latitude's wetness, as `acc`) */
  rowW: Float32Array;
  /** per node: its own catchment's runoff (the sum of its samples'), and the whole of what drains through it (the
   *  sum of its own and every node's upstream of it) — its discharge at the reference wetness, in samples' runoff */
  own: Float32Array;
  ref: Float32Array;
  /** the nodes, every node before the one it runs into (upstream first) */
  order: Int32Array;
}
const CATCH_STEP = 2;

export interface Rivers {
  /** NODE_WORDS a node: x, y (world), level, width, next (index), flags, depth, speed (cells a tick; water) */
  nodes: Uint32Array;
  /** (round 109) what drains into each node */
  catchments: Catchments;
  /** (round 90) the lakes, and per texel which (LAKE_IN) */
  lakes: AtlasLake[];
  lakeAt: Uint16Array;
  count: number;
  /** per texel: its node + 1 (0: none) — the JFA's seeds */
  nodeAt: Uint32Array;
  lava: number;
  waterfalls: number;
  ms: number;
  /** (round 84) the water nodes' reference speeds (cells a tick: min, median, max), discharge (median), and the
   *  median ratio of the pipes' steady surface slope for that discharge to the level's own fall */
  speed: [number, number, number];
  discharge: number;
  pipeSlope: number;
}

/** how dry a latitude is (regions.ts dryness: compose.wgsl moistureAt's latitude term) */
const dryness = (cy: number) => 0.5 - 0.5 * Math.cos((1 - warmth(cy)) * 3 * Math.PI);

export function findRivers(opt: {
  n: number;
  hmac: Float32Array;
  /** per texel: 1 water (the sea, lakes), 0 land */
  water: Uint8Array;
  /** per texel: 1 a volcanic region's */
  volcanic: Uint8Array;
  regionOf: Uint32Array;
  sea: number;
  worldW: number;
  worldH: number;
}): Rivers {
  const t0 = performance.now();
  const { n, hmac, water, volcanic, regionOf, sea } = opt;
  const N = n * n;
  const fill = new Float32Array(N);
  const down = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const order = new Int32Array(N);
  let no = 0;
  // a binary heap of texels by filled height
  const hk = new Float32Array(N);
  const hv = new Int32Array(N);
  let hs = 0;
  const push = (v: number, k: number) => {
    let i = hs++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= k) break;
      hk[i] = hk[p];
      hv[i] = hv[p];
      i = p;
    }
    hk[i] = k;
    hv[i] = v;
  };
  const pop = (): number => {
    const top = hv[0];
    const k = hk[--hs];
    const v = hv[hs];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hs) break;
      if (c + 1 < hs && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= k) break;
      hk[i] = hk[c];
      hv[i] = hv[c];
      i = c;
    }
    hk[i] = k;
    hv[i] = v;
    return top;
  };
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const nb = (i: number, k: number) => {
    const x = i % n;
    const y = (i - x) / n;
    return ((y + DY[k] + n) % n) * n + ((x + DX[k] + n) % n);
  };
  // the water: done; the water next to land is where the flood starts
  for (let i = 0; i < N; i++) {
    if (!water[i]) continue;
    done[i] = 1;
    fill[i] = Math.min(hmac[i], sea);
    for (let k = 0; k < 4; k++)
      if (!water[nb(i, k)]) {
        push(i, fill[i]);
        break;
      }
  }
  while (hs > 0) {
    const c = pop();
    for (let k = 0; k < 8; k++) {
      const j = nb(c, k);
      if (done[j]) continue;
      done[j] = 1;
      fill[j] = Math.max(hmac[j], fill[c] + 0.01);
      down[j] = c;
      order[no++] = j;
      push(j, fill[j]);
    }
  }
  // what drains through each texel
  const acc = new Float32Array(N);
  for (let i = 0; i < N; i++) if (!water[i]) acc[i] = 1 - 0.85 * dryness((Math.floor(i / n) + 0.5) / n);
  for (let k = no - 1; k >= 0; k--) {
    const i = order[k];
    if (down[i] >= 0) acc[down[i]] += acc[i];
  }
  // (round 90) the lakes: each filled hollow (8 neighbours) deep and wet enough
  const lakes: AtlasLake[] = [];
  const lakeAt = new Uint16Array(N);
  const mems: number[][] = [];
  const filled = (i: number) => !water[i] && fill[i] > hmac[i] + LAKE_EPS;
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  // (a river's level: the filled ground's, the lake's level in a lake, the floor in a hollow too small for one)
  const lev = new Float32Array(fill);
  for (let s = 0; s < N; s++) {
    if (seen[s] || !filled(s)) continue;
    const mem: number[] = [];
    seen[s] = 1;
    stack.push(s);
    let i0 = s;
    let lo = Infinity;
    while (stack.length) {
      const c = stack.pop()!;
      mem.push(c);
      if (fill[c] < fill[i0]) i0 = c;
      lo = Math.min(lo, hmac[c]);
      for (let k = 0; k < 8; k++) {
        const j = nb(c, k);
        if (!seen[j] && filled(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const L = fill[i0];
    if (L - lo < LAKE_DEPTH || acc[i0] < LAKE_CATCH) {
      for (const c of mem) lev[c] = hmac[c];
      continue;
    }
    if (lakes.length >= LAKE_IN - 1) throw new Error(`atlas: more than ${LAKE_IN - 2} lakes`);
    const id = lakes.length;
    const x0 = s % n;
    const y0 = (s - x0) / n;
    let sx = 0;
    let sy = 0;
    const regs = new Set<number>();
    for (const c of mem) {
      lakeAt[c] = (id + 1) | LAKE_IN;
      lev[c] = L;
      const x = c % n;
      const y = (c - x) / n;
      // (unwrapped round its first texel: a lake may straddle the torus's seam)
      sx += x0 + ((((x - x0 + n / 2) % n) + n) % n) - n / 2;
      sy += y0 + ((((y - y0 + n / 2) % n) + n) % n) - n / 2;
      regs.add(opt.regionOf[c]);
    }
    const o = down[i0] >= 0 ? down[i0] : i0;
    const wx = (t: number) => (((t + 0.5) / n) * opt.worldW + opt.worldW) % opt.worldW;
    const wy = (t: number) => (((t + 0.5) / n) * opt.worldH + opt.worldH) % opt.worldH;
    lakes.push({
      id,
      level: +L.toFixed(2),
      texels: mem.length,
      depth: +(L - lo).toFixed(1),
      at: [Math.round(wx(sx / mem.length)), Math.round(wy(sy / mem.length))],
      outlet: [Math.round(wx(o % n)), Math.round(wy(Math.floor(o / n)))],
      catchment: Math.round(acc[i0]),
      inflow: 0,
      outflow: -1,
      regions: [...regs].sort((a, b) => a - b),
    });
    mems.push(mem);
  }
  // each lake's rim: land texels within LAKE_RING of it whose filled level is near the lake's (not the valley past
  // its outlet); a texel two lakes' rims reach is the higher's (its shore must stand over the higher water)
  const byLevel = lakes.slice().sort((a, b) => b.level - a.level);
  const ringOf = new Uint8Array(N);
  for (const lk of byLevel) {
    let front = mems[lk.id];
    const mark = new Set<number>(front);
    for (let r = 0; r < LAKE_RING; r++) {
      const next: number[] = [];
      for (const c of front)
        for (let k = 0; k < 8; k++) {
          const j = nb(c, k);
          if (mark.has(j)) continue;
          mark.add(j);
          if (water[j] || fill[j] < lk.level - 0.5) continue;
          next.push(j);
          if (!(lakeAt[j] & LAKE_IN) && !ringOf[j]) {
            lakeAt[j] = lk.id + 1;
            ringOf[j] = 1;
          }
        }
      front = next;
    }
  }
  // the nodes: rivers (and the water each runs into), then lava
  const nodeAt = new Uint32Array(N);
  const xs: number[] = [];
  const flags: number[] = [];
  const add = (i: number, f: number) => {
    if (nodeAt[i]) {
      flags[nodeAt[i] - 1] |= f;
      return;
    }
    xs.push(i);
    flags.push(f);
    nodeAt[i] = xs.length;
  };
  for (let i = 0; i < N; i++) {
    if (water[i] || acc[i] < RIVER_MIN) continue;
    add(i, 0);
    // (its mouth: the water it runs into)
    if (water[down[i]]) add(down[i], 0);
  }
  // lava: from each volcanic region's highest texel, down
  const topOf = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (!volcanic[i]) continue;
    const r = regionOf[i];
    const t = topOf.get(r);
    if (t === undefined || hmac[i] > hmac[t]) topOf.set(r, i);
  }
  let lava = 0;
  for (const top of topOf.values()) {
    let i = top;
    for (let s = 0; s < LAVA_RUN && i >= 0; s++) {
      add(i, RIVER_LAVA);
      lava++;
      if (water[i] || lakeAt[i] & LAKE_IN) break;
      i = down[i];
    }
  }
  // the table
  const count = xs.length;
  const nodes = new Uint32Array(Math.max(count, 1) * NODE_WORDS);
  const f = new Float32Array(nodes.buffer);
  let waterfalls = 0;
  const speeds: number[] = [];
  const qs: number[] = [];
  const ratio: number[] = [];
  const cell = opt.worldW / n;
  for (let k = 0; k < count; k++) {
    const i = xs[k];
    const x = i % n;
    const y = (i - x) / n;
    const lv = flags[k] & RIVER_LAVA;
    // (lava: narrower; a river wider downstream)
    const w = lv ? 3 : Math.min(12, 2 + Math.sqrt(acc[i]) * 0.3);
    const d = down[i];
    const next = d >= 0 && nodeAt[d] ? nodeAt[d] - 1 : k;
    const o = k * NODE_WORDS;
    f[o] = ((x + 0.5) / n) * opt.worldW;
    f[o + 1] = ((y + 0.5) / n) * opt.worldH;
    f[o + 2] = water[i] ? sea - 0.4 : lev[i];
    f[o + 3] = w;
    nodes[o + 4] = next;
    nodes[o + 5] = flags[k];
    f[o + 6] = lv ? 1.4 : Math.min(3.5, Math.max(1.2, w * 0.3));
    const fall = next !== k ? Math.max(0, lev[i] - (water[d] ? sea : lev[d])) : 0;
    // (round 90) a river into a lake, and the one out of it
    if (!lv && d >= 0) {
      const li = lakeAt[i] & LAKE_IN ? (lakeAt[i] & 0x7fff) - 1 : -1;
      const ld = lakeAt[d] & LAKE_IN ? (lakeAt[d] & 0x7fff) - 1 : -1;
      if (ld >= 0 && li !== ld) lakes[ld].inflow++;
      if (li >= 0 && ld !== li && nodeAt[d]) lakes[li].outflow = nodeAt[d] - 1;
    }
    if (fall > 12) waterfalls++;
    // (round 84) the speed at the reference wetness: the discharge over the wetted section (the carve's parabola,
    // filled to 0.3 under the level), the square root taken so a brook still moves; quicker where the level falls
    if (!lv) {
      const Q = RIVER_RUNOFF * acc[i];
      const dn = f[o + 6];
      const A = 2 * w * Math.max(0.3, (2 / 3) * dn - 0.3);
      const dist = next !== k ? Math.hypot(((i % n) - (d % n)) * cell, (Math.floor(i / n) - Math.floor(d / n)) * cell) || cell : cell;
      const slope = Math.max(0, Math.min(fall, 12)) / dist;
      const v = Math.min(0.8, Math.min(0.45, Math.max(0.06, 0.5 * Math.sqrt(Q / A))) * (1 + Math.min(slope * 6, 1.5)));
      f[o + 7] = v;
      speeds.push(v);
      qs.push(Q);
      if (slope > 0) ratio.push(Q / (PIPE_Q * 2 * w) / slope);
    }
  }
  // (round 109) the catchments: each texel's first node down the tree (the flood's order: a texel after the one it
  // drains to), sampled every CATCH_STEP texels; the nodes upstream first (the flood's order backwards, then the rest:
  // the mouths, in the water)
  const catchments = (() => {
    const basin = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (water[i] && nodeAt[i]) basin[i] = nodeAt[i] - 1;
    for (let k = 0; k < no; k++) {
      const j = order[k];
      basin[j] = nodeAt[j] ? nodeAt[j] - 1 : down[j] >= 0 ? basin[down[j]] : -1;
    }
    const step = CATCH_STEP;
    const side = Math.floor(n / step);
    const of = new Int32Array(side * side);
    const rowW = new Float32Array(side);
    const own = new Float32Array(Math.max(count, 1));
    for (let sy = 0; sy < side; sy++) {
      rowW[sy] = step * step * (1 - 0.85 * dryness((sy * step + 0.5) / n));
      for (let sx = 0; sx < side; sx++) {
        const i = sy * step * n + sx * step;
        const b = water[i] ? -1 : basin[i];
        of[sy * side + sx] = b;
        if (b >= 0) own[b] += rowW[sy];
      }
    }
    const ord = new Int32Array(count);
    const placed = new Uint8Array(count);
    let m = 0;
    for (let k = no - 1; k >= 0; k--) {
      const j = order[k];
      if (nodeAt[j] && !placed[nodeAt[j] - 1]) {
        placed[nodeAt[j] - 1] = 1;
        ord[m++] = nodeAt[j] - 1;
      }
    }
    for (let k = 0; k < count; k++) if (!placed[k]) ord[m++] = k;
    const ref = new Float32Array(own);
    for (const k of ord) {
      const nx = nodes[k * NODE_WORDS + 4];
      if (nx !== k) ref[nx] += ref[k];
    }
    return { step, side, of, rowW, own, ref, order: ord };
  })();
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
  const sp = speeds.slice().sort((x, y) => x - y);
  const r3 = (x: number) => +x.toFixed(3);
  return {
    nodes,
    catchments,
    lakes,
    lakeAt,
    count,
    nodeAt,
    lava,
    waterfalls,
    ms: +(performance.now() - t0).toFixed(0),
    speed: [r3(sp[0] ?? 0), r3(med(sp)), r3(sp[sp.length - 1] ?? 0)],
    discharge: r3(med(qs)),
    pipeSlope: r3(med(ratio)),
  };
}
