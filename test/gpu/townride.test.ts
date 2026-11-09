// (DA-A22) The riders' routes on the GPU (build/routegpu.ts setRideGoals / traceRides, shaders/townroute.wgsl
// rideSeed / rideTrace) on the user's start town (data/lab/town.rclt): a group's field from its goals over the same
// edges the reach walks, routes traced down it into a points pool. The property the design is for: reach and routes
// can't differ — a structure is reached exactly when a route from its door gets to the stores — as it stands and after
// random floods across the town's edges (water written into the live columns, the next solve reads it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { decodeTownFixture, type TownFixtureHeader } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { routeGraphOf, routePlanOf, type RouteGraph, type RoutePlan } from '../../src/build/routegraph';
import { REACH_BIT, TownRouteGpu, type RouteAnswer, type RoutePlace } from '../../src/build/routegpu';
import type { MapData } from '../../src/world/mapgen';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');
/** the pool's size (points) in this test */
const CAP = 1 << 18;

let g: TestGpu;
let w: TinyWorld;
let header: TownFixtureHeader;
let map: MapData;
let site: TownSite;
let graph: RouteGraph;
let plan: RoutePlan;
let gpu: TownRouteGpu;
let place: RoutePlace;
let pts: GPUBuffer;
let routes: GPUBuffer;
let stores: [number, number];

beforeAll(async () => {
  g = await testGpu();
  ({ header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE))));
  site = TownSite.fromData(siteFromJson(header.site));
  w = await tinyWorld(g, map, [], 'table');
  graph = routeGraphOf(site.grid);
  const r = site.plan.layout.roads!;
  stores = [r.stores[0], r.stores[1]];
  plan = routePlanOf({ plan: site.plan, grid: site.grid, floor: (c) => site.town.base[c] }, graph, { roads: new Set(r.verge), stores: r.stores, centre: r.centre, far: 4 });
  place = { dx: site.box.x0 - header.origin[0], dy: site.box.y0 - header.origin[1], oz: header.oz! + header.zBase };
  gpu = new TownRouteGpu(g.device, { live: w.core.world }, graph);
  gpu.setPlan(plan);
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  pts = g.device.createBuffer({ label: 'test route pts', size: CAP * 16, usage: S });
  routes = g.device.createBuffer({ label: 'test routes', size: 4096 * 16, usage: S });
}, 120_000);
afterAll(() => {
  pts?.destroy();
  routes?.destroy();
  gpu?.dispose();
  w?.destroy();
});

/** per structure: reached by the solve, and whether the route from its door gets to the stores (its last point the
 *  stores' point); the routes' points read back */
async function agreement(a: RouteAnswer): Promise<{ reached: boolean; routed: boolean; id: number; n: number }[]> {
  gpu.resetRidePool();
  gpu.setRideGoals(0, [{ node: plan.storesV, x: stores[0], y: stores[1] }]);
  const reqs = plan.ids.map((_, i) => {
    // (from its doors' first end at grade in the graph: the lane's door, else any candidate's)
    const e = a.door[i] >= 0 ? a.door[i] : plan.doors[plan.info[i * 4] * 4];
    return { route: i, group: 0, node: graph.ends[e * 2], goal: -1 };
  });
  g.device.queue.writeBuffer(routes, 0, new Uint32Array(plan.ids.length * 4));
  gpu.traceRides(reqs, pts, routes, CAP);
  await gpu.idle();
  const hdr = new Uint32Array(await g.read(routes, plan.ids.length * 16));
  const P = new Float32Array(await g.read(pts, CAP * 16));
  return plan.ids.map((id, i) => {
    const [first, n] = [hdr[i * 4], hdr[i * 4 + 1]];
    const last = first + n - 1;
    const routed = n > 0 && Math.hypot(P[last * 4] - stores[0], P[last * 4 + 1] - stores[1]) < 1e-3;
    return { reached: !!(a.words[i] & REACH_BIT.reached), routed, id, n };
  });
}

describe("the riders' routes on the start town", () => {
  it('a route from every structure reached gets to the stores, along the graph', async () => {
    const a = await gpu.solve(place);
    const rows = await agreement(a);
    expect(g.takeErrors()).toEqual([]);
    const pool = await gpu.ridePool();
    console.log(JSON.stringify({ structures: rows.length, reached: rows.filter((r) => r.reached).length, routed: rows.filter((r) => r.routed).length, points: pool.used, overflow: pool.overflow, longest: Math.max(...rows.map((r) => r.n)) }));
    expect(pool.overflow).toBe(0);
    for (const r of rows) expect(r.routed, `structure ${r.id}`).toBe(r.reached);
    // (each step a graph edge: consecutive points are two ends of one edge, the last the goal)
    const hdr = new Uint32Array(await g.read(routes, 16));
    const P = new Float32Array(await g.read(pts, CAP * 16));
    const V = graph.verts;
    const near = (x: number, y: number) => {
      for (let v = 0; v < graph.nv; v++) if (Math.hypot(V[v * 2] - x, V[v * 2 + 1] - y) < 1e-3) return v;
      return -1;
    };
    const edgeSet = new Set<number>();
    for (let e = 0; e < graph.ne; e++) edgeSet.add(Math.min(graph.ends[e * 2], graph.ends[e * 2 + 1]) * graph.nv + Math.max(graph.ends[e * 2], graph.ends[e * 2 + 1]));
    for (let k = hdr[0]; k + 2 < hdr[0] + hdr[1]; k++) {
      const a0 = near(P[k * 4], P[k * 4 + 1]);
      const b0 = near(P[k * 4 + 4], P[k * 4 + 5]);
      expect(edgeSet.has(Math.min(a0, b0) * graph.nv + Math.max(a0, b0))).toBe(true);
      expect(P[k * 4 + 7]).toBeGreaterThan(P[k * 4 + 3]);
    }
  });

  it('reach and routes agree after random floods (a property over edits of the live columns)', async () => {
    const water0 = await w.core.readBuffer('water');
    const W = header.dims.w;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const unpack = (p: number) => [(p & 0xffff) - 32768 + place.dx, (p >>> 16) - 32768 + place.dy];
    let outV = 0;
    for (let trial = 0; trial < 6; trial++) {
      const water = water0.slice();
      // (a flood: deep water over 40 random edges' columns)
      for (let k = 0; k < 40; k++) {
        const e = Math.floor(rnd() * graph.ne);
        for (const p of [graph.colOf[graph.ends[e * 2]], graph.colOf[graph.ends[e * 2 + 1]], graph.colOf[graph.nv + e]]) {
          const [x, y] = unpack(p);
          if (x >= 0 && y >= 0 && x < W) water[y * W + x] = 2;
        }
      }
      g.device.queue.writeBuffer(w.core.world.water, 0, w.core.world.ring.toStore(water));
      const a = await gpu.solve(place);
      // per vertex (1,000 of them): in the stores' component exactly when a route from it gets to the stores
      gpu.resetRidePool();
      gpu.setRideGoals(0, [{ node: plan.storesV, x: stores[0], y: stores[1] }]);
      const vs = Array.from({ length: 1000 }, () => Math.floor(rnd() * graph.nv));
      g.device.queue.writeBuffer(routes, 0, new Uint32Array(vs.length * 4));
      gpu.traceRides(vs.map((v, i) => ({ route: i, group: 0, node: v, goal: -1 })), pts, routes, CAP);
      await gpu.idle();
      const hdr = new Uint32Array(await g.read(routes, vs.length * 16));
      const P = new Float32Array(await g.read(pts, CAP * 16));
      expect((await gpu.ridePool()).overflow).toBe(0);
      vs.forEach((v, i) => {
        const n = hdr[i * 4 + 1];
        const last = hdr[i * 4] + n - 1;
        const routed = n > 0 && Math.hypot(P[last * 4] - stores[0], P[last * 4 + 1] - stores[1]) < 1e-3;
        if (!a.main[v]) outV++;
        expect(routed, `trial ${trial}, vertex ${v}`).toBe(!!a.main[v]);
      });
      // and the structures: reached exactly when a door at grade has an end in the stores' component (one rule)
      const rows = await agreement(a);
      for (const r of rows) if (r.routed) expect(r.reached, `trial ${trial}, structure ${r.id}`).toBe(true);
    }
    g.device.queue.writeBuffer(w.core.world.water, 0, w.core.world.ring.toStore(water0));
    console.log(JSON.stringify({ floods: 6, verticesOutOfReach: outV }));
    expect(g.takeErrors()).toEqual([]);
  });
});
