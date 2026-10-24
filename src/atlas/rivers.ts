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

export interface Rivers {
  /** NODE_WORDS a node: x, y (world), level, width, next (index), flags, depth, 0 */
  nodes: Uint32Array;
  count: number;
  /** per texel: its node + 1 (0: none) — the JFA's seeds */
  nodeAt: Uint32Array;
  lava: number;
  waterfalls: number;
  ms: number;
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
    if (next !== k && fill[i] - (water[d] ? sea : fill[d]) > 12) waterfalls++;
  }
  return { nodes, count, nodeAt, lava, waterfalls, ms: +(performance.now() - t0).toFixed(0) };
}
