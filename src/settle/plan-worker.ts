// (round 94) A settlement planned off the main thread for the land past the window (settlements.ts farPlans): on the
// atlas's rough ground (atlas/bake.ts roughGround) with the ways stamped on it as the window's raw land has them,
// planned (plan.ts, as on arrival) and rastered (raster.ts). Posts back the stamp alone.
import { planSettlement } from './plan';
import { rasterPlan } from './raster';
import { stampWays, type Ways } from '../atlas/ways';
import { ROW_H } from '../world/lattice';
import type { Interval } from '../world/layout';
import type { SettlementSeed } from './records';

export interface FarPlanInit {
  init: { regionOf: Uint16Array | Uint32Array | Int32Array; n: number; worldW: number; worldH: number };
}
export interface FarPlanJob {
  id: string;
  seed: SettlementSeed;
  ground: Float32Array;
  water: Float32Array;
  top: Uint8Array;
  veg: Float32Array;
  sea: number;
  ways: Ways;
}
export interface FarPlanDone {
  id: string;
  stamp: import('../atlas/bake').SurfaceStamp;
  /** ms: the ways stamped, the plan, the raster */
  ms: [number, number, number];
}

let world: FarPlanInit['init'] | null = null;

self.onmessage = (e: MessageEvent<FarPlanInit | FarPlanJob>) => {
  if ('init' in e.data) {
    world = e.data.init;
    return;
  }
  if (!world) throw new Error('plan-worker: no world');
  const W = world;
  const j = e.data;
  const { box } = j.seed;
  const N = box.w * box.h;
  const t0 = performance.now();
  // the ways on it, as atlas.ts regionLand stamps them on the raw land
  const cols: Interval[][] = new Array(N);
  for (let i = 0; i < N; i++) cols[i] = [{ z0: j.ground[i] - 8, z1: j.ground[i], mat: j.top[i] }];
  const land = { cols, surface: j.ground.slice(), vegetation: j.veg, ground: j.ground, water: j.water };
  stampWays(j.ways, land, box.x0, box.y0, box.w, box.h, (cx, cy) => [cx + 0.5 + 0.5 * (cy & 1), (cy + 0.5) * ROW_H], W.worldW, W.worldH);
  for (let i = 0; i < N; i++) {
    const c = cols[i];
    j.ground[i] = c.length ? c[c.length - 1].z1 : 0;
    j.top[i] = c.length ? c[c.length - 1].mat : 0;
  }
  const t1 = performance.now();
  const mod = (v: number, n: number) => ((v % n) + n) % n;
  const regionAt = (x: number, y: number) => {
    const tx = mod(Math.floor(((x + box.x0) / W.worldW) * W.n), W.n);
    const ty = mod(Math.floor(((y + box.y0 * ROW_H) / W.worldH) * W.n), W.n);
    return W.regionOf[ty * W.n + tx];
  };
  const plan = planSettlement({ ...j.seed, ground: j.ground, water: j.water, top: j.top, veg: j.veg, sea: j.sea, regionAt });
  const t2 = performance.now();
  const stamp = rasterPlan(j.id, plan.columns, box, j.ground, j.top);
  const t3 = performance.now();
  const out: FarPlanDone = { id: j.id, stamp, ms: [+(t1 - t0).toFixed(1), +(t2 - t1).toFixed(1), +(t3 - t2).toFixed(1)] };
  (self as unknown as Worker).postMessage(out, [stamp.px.buffer, stamp.px4.buffer]);
};
