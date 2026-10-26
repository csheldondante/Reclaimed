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

export interface Rivers {
  /** NODE_WORDS a node: x, y (world), level, width, next (index), flags, depth, 0 */
  nodes: Uint32Array;
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
      if (water[i]) break;
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
    f[o + 2] = water[i] ? sea - 0.4 : fill[i];
    f[o + 3] = w;
    nodes[o + 4] = next;
    nodes[o + 5] = flags[k];
    f[o + 6] = lv ? 1.4 : Math.min(3.5, Math.max(1.2, w * 0.3));
    const fall = next !== k ? fill[i] - (water[d] ? sea : fill[d]) : 0;
    if (fall > 12) waterfalls++;
    // (round 84) the speed at the reference wetness: the discharge over the wetted section (the carve's parabola,
    // filled to 0.3 under the level), the square root taken so a brook still moves; quicker where the level falls
    if (!lv) {
      const Q = RIVER_RUNOFF * acc[i];
      const dn = f[o + 6];
      const A = 2 * w * Math.max(0.3, (2 / 3) * dn - 0.3);
      const dist = next !== k ? Math.hypot(((i % n) - (d % n)) * cell, (Math.floor(i / n) - Math.floor(d / n)) * cell) || cell : cell;
      const slope = Math.min(fall, 12) / dist;
      const v = Math.min(0.8, Math.min(0.45, Math.max(0.06, 0.5 * Math.sqrt(Q / A))) * (1 + Math.min(slope * 6, 1.5)));
      f[o + 7] = v;
      speeds.push(v);
      qs.push(Q);
      if (slope > 0) ratio.push(Q / (PIPE_Q * 2 * w) / slope);
    }
  }
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
  const sp = speeds.slice().sort((x, y) => x - y);
  const r3 = (x: number) => +x.toFixed(3);
  return {
    nodes,
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
