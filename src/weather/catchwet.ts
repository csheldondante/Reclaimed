// The rivers' wetness per watershed (round 109 — the user: "I want it per water shed please"). A river rises only from
// rain on its own catchment, and a reach downstream from what its upstream reaches carry, a while later.
//
// The rivers' wetness is the climate's (weather/riverwet.ts: the season, eased — Globals ocean.w, the same for every
// river) plus this: each river node's storm water, over its discharge at the reference wetness (atlas/rivers.ts
// Catchments.ref). Per node, two linear stores:
//  - its own catchment's runoff: the storms' rain (Weather.rainAt) on the catchment's samples, × RAIN, eased over
//    LAG_S (the hillside's slow answer, as the climate's);
//  - its reach: what its runoff and the reaches upstream of it pour in, eased over the time the river takes to run to
//    the next node (the node's speed at the reference wetness) — so a rise travels down the river at the river's pace.
// Storms rain only over the window, so only the nodes round it (the window and MARGIN cells round it) are kept; a
// node's storm water past them is let go (a river that leaves the box and comes back carries none of it back in).
//   ?riverwet=x (world-gpu RIVER_WET): held — no storm water.

import { NODE_WORDS, type Catchments } from '../atlas/rivers';
import { RIVER_WET } from '../sim/world-gpu';
import { ROW_H } from '../world/lattice';

/** seconds the hillside's runoff takes to follow the rain most of the way (riverwet.ts LAG_S, the climate's) */
const LAG_S = 20;
/** a catchment rained on all over at full strength runs off (1 + RAIN) × its reference runoff (a storm covers a few
 *  hundred macro texels: a brook's catchment, a fraction of a river's — 3 so a storm over part of one shows) */
const RAIN = 3;
/** the most storm water a river carries, over its reference discharge */
const MAX_EX = 1.5;
/** cells round the window whose nodes are kept */
const MARGIN = 128;
/** seconds between the rain's samplings (the stores follow it over LAG_S: a quarter second is plenty) */
const RAIN_EVERY = 0.25;
/** the shortest reach's time (s) */
const TAU_MIN = 0.2;

/** the atlas's rivers as this reads them (atlas.ts riverNodes, riverCatchments) */
export interface RiverGraph {
  /** rivers.ts NODE_WORDS a node */
  nodes: Uint32Array;
  catchments: Catchments;
  /** the macro map's texels a side, and the world's size (world units) */
  n: number;
  worldW: number;
  worldH: number;
}

export interface RainSource {
  /** a storm: where (window units), how far it reaches (its radius) */
  storms: readonly { x: number; y: number; radius: number; intensity: number; shape: readonly number[] }[];
  /** the rain at a window point (Weather.rainAt) */
  rainAt(x: number, y: number): number;
}

export class CatchmentWet {
  /** per node: the storm water over its reference discharge (0 outside the kept nodes) */
  readonly ex: Float32Array;
  /** the kept nodes, upstream first, and where each is in the window (window units: x, y) */
  live = new Int32Array(0);
  livePos = new Float32Array(0);
  private next: Int32Array;
  private tau: Float32Array;
  private R: Float32Array;
  private Q: Float32Array;
  private inQ: Float32Array;
  private rain: Float32Array;
  private kept: Uint8Array;
  /** the catchment samples in the box: where (window units), their node, their runoff */
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private sn = new Int32Array(0);
  private sw = new Float32Array(0);
  private count: number;
  /** cost of the updates (ms: the last, the mean) and how many */
  ms = 0;
  msMean = 0;
  updates = 0;
  private rainIn = 0;

  constructor(private g: RiverGraph) {
    const count = (this.count = g.catchments.own.length);
    this.ex = new Float32Array(count);
    this.next = new Int32Array(count);
    this.tau = new Float32Array(count);
    this.R = new Float32Array(count);
    this.Q = new Float32Array(count);
    this.inQ = new Float32Array(count);
    this.rain = new Float32Array(count);
    this.kept = new Uint8Array(count);
    const f = new Float32Array(g.nodes.buffer, g.nodes.byteOffset, g.nodes.length);
    for (let k = 0; k < count; k++) {
      const o = k * NODE_WORDS;
      const nx = g.nodes[o + 4];
      this.next[k] = nx;
      const q = nx * NODE_WORDS;
      let dx = f[q] - f[o];
      let dy = f[q + 1] - f[o + 1];
      dx -= Math.round(dx / g.worldW) * g.worldW;
      dy -= Math.round(dy / g.worldH) * g.worldH;
      const v = Math.max(f[o + 7], 0.05);
      this.tau[k] = Math.max(TAU_MIN, Math.hypot(dx, dy) / (v * 60));
    }
  }

  /** The window (origin in world cells, size in cells): the nodes and the samples round it. */
  setWindow(ox: number, oy: number, w: number, h: number): void {
    const { g } = this;
    const f = new Float32Array(g.nodes.buffer, g.nodes.byteOffset, g.nodes.length);
    const X0 = ox;
    const Y0 = oy * ROW_H;
    const W = w;
    const H = h * ROW_H;
    // (window units of a world point: the nearest copy to the window's middle on the torus)
    const lx = (x: number) => {
      const d = x - X0;
      return d - Math.round((d - W / 2) / g.worldW) * g.worldW;
    };
    const ly = (y: number) => {
      const d = y - Y0;
      return d - Math.round((d - H / 2) / g.worldH) * g.worldH;
    };
    const M = MARGIN;
    const inBox = (x: number, y: number) => x >= -M && x <= W + M && y >= -M && y <= H + M;
    const was = this.kept.slice();
    this.kept.fill(0);
    let m = 0;
    for (let k = 0; k < this.count; k++) if (inBox(lx(f[k * NODE_WORDS]), ly(f[k * NODE_WORDS + 1]))) this.kept[k] = 1;
    for (let k = 0; k < this.count; k++) {
      if (was[k] && !this.kept[k]) this.R[k] = this.Q[k] = this.inQ[k] = this.ex[k] = 0;
      if (this.kept[k]) m++;
    }
    this.live = new Int32Array(m);
    this.livePos = new Float32Array(m * 2);
    let j = 0;
    for (const k of g.catchments.order)
      if (this.kept[k]) {
        this.livePos[j * 2] = lx(f[k * NODE_WORDS]);
        this.livePos[j * 2 + 1] = ly(f[k * NODE_WORDS + 1]);
        this.live[j++] = k;
      }
    // the samples in the box (rain falls only on the window)
    const C = g.catchments;
    const tw = (g.worldW / g.n) * C.step;
    const th = (g.worldH / g.n) * C.step;
    const sx: number[] = [];
    const sy: number[] = [];
    const sn: number[] = [];
    const sw: number[] = [];
    const i0 = Math.floor((X0 - M) / tw);
    const i1 = Math.ceil((X0 + W + M) / tw);
    const j0 = Math.floor((Y0 - M) / th);
    const j1 = Math.ceil((Y0 + H + M) / th);
    for (let b = j0; b <= j1; b++) {
      const r = ((b % C.side) + C.side) % C.side;
      for (let a = i0; a <= i1; a++) {
        const c = ((a % C.side) + C.side) % C.side;
        const node = C.of[r * C.side + c];
        if (node < 0 || !this.kept[node]) continue;
        // (the sample's texel's middle: texel (c · step) of the macro map)
        sx.push(lx(((c * C.step + 0.5) / g.n) * g.worldW));
        sy.push(ly(((r * C.step + 0.5) / g.n) * g.worldH));
        sn.push(node);
        sw.push(C.rowW[r]);
      }
    }
    this.sx = Float32Array.from(sx);
    this.sy = Float32Array.from(sy);
    this.sn = Int32Array.from(sn);
    this.sw = Float32Array.from(sw);
  }

  /** a step of dt seconds (game time) with the storms' rain */
  update(dt: number, src: RainSource): void {
    if (RIVER_WET >= 0) return;
    const t0 = performance.now();
    const { live, rain, R, Q, inQ, ex, next, tau, kept } = this;
    const ref = this.g.catchments.ref;
    this.rainIn -= dt;
    const storms = this.rainIn <= 0 ? src.storms.filter((s) => s.intensity > 0.01) : [];
    if (this.rainIn <= 0) {
      this.rainIn = RAIN_EVERY;
      for (let j = 0; j < live.length; j++) rain[live[j]] = 0;
    }
    if (storms.length) {
      const reach = storms.map((s) => s.radius * 1.5 * Math.max(1, s.shape[3] ?? 1));
      const { sx, sy, sn, sw } = this;
      for (let i = 0; i < sx.length; i++) {
        let near = false;
        for (let s = 0; s < storms.length && !near; s++) near = Math.abs(sx[i] - storms[s].x) < reach[s] && Math.abs(sy[i] - storms[s].y) < reach[s];
        if (!near) continue;
        const r = src.rainAt(sx[i], sy[i]);
        if (r > 0) rain[sn[i]] += sw[i] * r;
      }
    }
    const a = 1 - Math.exp(-dt / LAG_S);
    for (let j = 0; j < live.length; j++) {
      const k = live[j];
      R[k] += (RAIN * rain[k] - R[k]) * a;
      const qin = R[k] + inQ[k];
      inQ[k] = 0;
      Q[k] += (qin - Q[k]) * (1 - Math.exp(-dt / tau[k]));
      const nx = next[k];
      if (nx !== k && kept[nx]) inQ[nx] += Q[k];
      ex[k] = ref[k] > 0 ? Math.min(MAX_EX, Q[k] / ref[k]) : 0;
    }
    this.ms = performance.now() - t0;
    this.updates++;
    this.msMean += (this.ms - this.msMean) / Math.min(this.updates, 600);
  }
}
