// (DA-A22) The town's route network on the GPU (build/routegpu.ts, shaders/townroute.wgsl) on the user's start town
// (data/lab/town.rclt: its window's columns as the game had them, its site): the cuts from the live columns, reach as
// the components. Measured against the CPU edge net (build/edgenet.ts, the reference during the cutover only):
//  - which structures the stores reach, structure by structure, every difference explained by what the columns say;
//  - the CPU's cliff cuts (groundCols: the land before the town) against the live surface's (the levelling slice's
//    baseline), and a road edge in the core the CPU called a cliff;
//  - the time a solve takes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { decodeTownFixture, type TownFixtureHeader } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { relayRoads, type TownRoads } from '../../src/build/townroads';
import { CUT_CLIFF, CUT_WALL, CUT_WATER, PATH_LANE } from '../../src/build/edgenet';
import { deckOf, routeGraphOf, routePlanOf, type RouteGraph, type RoutePlan } from '../../src/build/routegraph';
import { RC, REACH_BIT, TownRouteGpu, type RoutePlace } from '../../src/build/routegpu';
import type { MapData } from '../../src/world/mapgen';
import { SLOPE } from '../../src/build/ways';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

let g: TestGpu;
let w: TinyWorld;
let header: TownFixtureHeader;
let map: MapData;
let site: TownSite;
let roads: TownRoads;
let graph: RouteGraph;
let plan: RoutePlan;
let gpu: TownRouteGpu;
let place: RoutePlace;

beforeAll(async () => {
  g = await testGpu();
  ({ header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE))));
  site = TownSite.fromData(siteFromJson(header.site));
  roads = relayRoads(site)!;
  w = await tinyWorld(g, map, [], 'table');
  graph = routeGraphOf(site.grid, { curves: site.plan.layout.roads!.curves.map((c) => c.pts), deck: deckOf(site.plan.layout.linear) });
  const r = site.plan.layout.roads!;
  plan = routePlanOf({ plan: site.plan, grid: site.grid, floor: (c) => site.town.base[c] }, graph, { roads: new Set(r.verge), stores: r.stores, centre: r.centre, far: 4 });
  place = { dx: site.box.x0 - header.origin[0], dy: site.box.y0 - header.origin[1], oz: header.oz! + header.zBase };
  gpu = new TownRouteGpu(g.device, { live: w.core.world }, graph);
  gpu.setPlan(plan);
}, 120_000);
afterAll(() => {
  gpu?.dispose();
  w?.destroy();
});

describe("the start town's routes on the GPU", () => {
  it('the same graph and stores as the CPU net', () => {
    expect(graph.neGrid).toBe(roads.net.cut.length);
    expect(plan.storesV).toBe(roads.net.storesV);
    expect(plan.ids.length).toBe(roads.net.reach.structures);
  });

  it('reach per structure against the CPU, each difference by what the live columns say', async () => {
    const s = await gpu.solve(place);
    expect(g.takeErrors()).toEqual([]);
    const { bits, z, za, zb } = await gpu.cuts();
    const cpu = roads.net.reach.reachedIds;
    const diff: string[] = [];
    let gpuReached = 0;
    for (let i = 0; i < plan.ids.length; i++) {
      const id = plan.ids[i];
      const gr = !!(s.words[i] & REACH_BIT.reached);
      gpuReached += +gr;
      if (gr === cpu.has(id)) continue;
      const why = (['wall', 'water', 'cliff', 'terrace'] as const).filter((k) => s.words[i] & REACH_BIT[k]);
      diff.push(`${id} ${site.plan.structure(id)!.type}: cpu ${cpu.has(id) ? 'reached' : `out (${roads.net.reach.out.find((o) => o.id === id)?.why})`}, gpu ${gr ? 'reached' : `out (lifting ${why.join('/') || 'nothing'} reaches it)`}`);
    }
    // the cuts, CPU (the land before the town) against GPU (the live columns)
    const n = { cpu: { wall: 0, water: 0, cliff: 0, steep: 0 }, gpu: { wall: 0, water: 0, cliff: 0, steep: 0, off: 0 }, cliffKept: 0, cliffGone: 0, cliffNew: 0 };
    const net = roads.net;
    const ends = { cliff: 0, kept: 0 };
    const drops: number[] = [];
    for (let e = 0; e < graph.neGrid; e++) {
      const c = net.cut[e];
      const b = bits[e];
      n.cpu.wall += +!!(c & CUT_WALL);
      n.cpu.water += +!!(c & CUT_WATER);
      n.cpu.cliff += +!!(c & CUT_CLIFF);
      n.cpu.steep += net.steep[e];
      n.gpu.wall += +!!(b & RC.wall);
      n.gpu.water += +!!(b & RC.water);
      n.gpu.cliff += +!!(b & RC.cliff);
      n.gpu.steep += +!!(b & RC.steep);
      n.gpu.off += +!!(b & RC.off);
      if (c & CUT_CLIFF) {
        if (b & RC.cliff) n.cliffKept++;
        else n.cliffGone++;
      } else if (b & RC.cliff) n.cliffNew++;
      // (the live surface by the CPU's rule — its two ends only, over the whole edge)
      const endsRise = Math.abs(zb[e] - za[e]) / Math.max(net.length[e], 1e-6);
      if (endsRise > SLOPE) ends.cliff++;
      if (endsRise > SLOPE && c & CUT_CLIFF) ends.kept++;
      const dz = Math.max(Math.abs(z[e] - za[e]), Math.abs(zb[e] - z[e]), Math.abs(zb[e] - za[e]));
      if (b & RC.cliff) drops.push(dz);
    }
    drops.sort((p, q) => p - q);
    const q = (f: number) => +(drops[Math.min(drops.length - 1, Math.floor(f * drops.length))] ?? 0).toFixed(2);
    console.log(JSON.stringify({ structures: plan.ids.length, cpuReached: cpu.size, gpuReached, rounds: s.rounds, ms: +s.ms.toFixed(2), diff, cuts: n, liveEndsOnly: ends, gpuCliffDrop: { min: q(0), q1: q(0.25), median: q(0.5), q3: q(0.75), max: q(0.999) } }));
    // (the walls are the plan's: the same bits)
    expect(n.gpu.wall).toBe(n.cpu.wall);
    expect(n.gpu.off).toBe(0);
    expect(z.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("a road edge in the core the CPU called a cliff: what the live columns say", async () => {
    await gpu.solve(place);
    const { bits, z, za, zb } = await gpu.cuts();
    const net = roads.net;
    const verge = new Set(site.plan.layout.roads!.verge);
    const [cx, cy] = site.plan.layout.roads!.centre;
    const V = site.grid.verts;
    let best = -1;
    let bd = Infinity;
    for (let e = 0; e < graph.neGrid; e++) {
      if (!(net.cut[e] & CUT_CLIFF)) continue;
      const kinds = net.kind[e];
      const c0 = net.cells[e * 2];
      const c1 = net.cells[e * 2 + 1];
      if (!kinds && !verge.has(c0) && !verge.has(c1)) continue;
      const a = net.ends[e * 2];
      const d = Math.hypot(V[a * 2] - cx, V[a * 2 + 1] - cy);
      if (d < bd) ((bd = d), (best = e));
    }
    const cases: unknown[] = [];
    if (best >= 0) {
      const a = net.ends[best * 2];
      const b = net.ends[best * 2 + 1];
      cases.push({
        edge: best,
        fromCentre: +bd.toFixed(1),
        len: +net.length[best].toFixed(2),
        kind: net.kind[best],
        cpuGround: [site.groundAt(V[a * 2], V[a * 2 + 1]), site.groundAt(V[b * 2], V[b * 2 + 1])].map((v) => +v.toFixed(2)),
        live: [za[best], z[best], zb[best]].map((v) => +v.toFixed(2)),
        gpuBits: bits[best],
        gpuCliff: !!(bits[best] & RC.cliff),
      });
    }
    // every CPU cliff the live surface doesn't cut: the ends as the CPU had them and as the columns are
    const gone: unknown[] = [];
    for (let e = 0; e < graph.neGrid; e++) {
      if (!(net.cut[e] & CUT_CLIFF) || bits[e] & RC.cliff) continue;
      const a = net.ends[e * 2];
      const b = net.ends[e * 2 + 1];
      const c = [net.cells[e * 2], net.cells[e * 2 + 1]].map((c) => (c < 0 ? 'rim' : verge.has(c) ? 'road' : (site.plan.structureAt(c)?.type ?? 'open')));
      gone.push({ e, len: +net.length[e].toFixed(2), cells: c, cpu: [site.groundAt(V[a * 2], V[a * 2 + 1]), site.groundAt(V[b * 2], V[b * 2 + 1])].map((v) => +v.toFixed(2)), live: [za[e], z[e], zb[e]].map((v) => +v.toFixed(2)) });
    }
    console.log(JSON.stringify({ levelledRoad: cases, cpuCliffsNotLive: gone }));
    expect(best).toBeGreaterThanOrEqual(0);
    // (the levelled road: a road edge the land before the town made a cliff, the stamped road walkable as it stands)
    expect(gone.some((x) => (x as { cells: string[] }).cells.every((c) => c === 'road'))).toBe(true);
  });

  it('the drawn paths laid down the GPU fields, against the CPU walks', async () => {
    const s = await gpu.solve(place);
    const net = roads.net;
    const n = { cpu: { main: 0, lane: 0 }, gpu: { main: 0, lane: 0 }, both: 0, cpuOnly: 0, gpuOnly: 0, mainBoth: 0 };
    for (let e = 0; e < graph.neGrid; e++) {
      const c = net.kind[e];
      const k = s.kinds[e];
      if (c === 2) n.cpu.main++;
      else if (c === 1) n.cpu.lane++;
      if (k === 2) n.gpu.main++;
      else if (k === 1) n.gpu.lane++;
      if (c && k) n.both++;
      else if (c) n.cpuOnly++;
      else if (k) n.gpuOnly++;
      if (c === 2 && k === 2) n.mainBoth++;
    }
    let doorsSame = 0;
    let doorsCpu = 0;
    let doorsGpu = 0;
    for (let i = 0; i < plan.ids.length; i++) {
      const cd = net.door.get(plan.ids[i]);
      if (cd !== undefined) doorsCpu++;
      if (s.door[i] >= 0) doorsGpu++;
      if (cd !== undefined && cd === s.door[i]) doorsSame++;
    }
    const terraces = [...s.terrace].filter((t) => !Number.isNaN(t)).length;
    const noGrade = [...s.grade].filter((x) => !x).length;
    console.log(JSON.stringify({ paths: n, doors: { cpu: doorsCpu, gpu: doorsGpu, same: doorsSame }, far: plan.far.length, cpuFar: net.far.length, terraces, noDoorAtGrade: noGrade, cpuNoDoorAtGrade: net.reach.noDoorAtGrade, gates: s.gates, rounds: s.rounds }));
    expect(n.gpu.main).toBeGreaterThan(0);
    expect(n.gpu.lane).toBeGreaterThan(0);
    // (every structure that isn't far and has a free door at grade gets a lane)
    expect(doorsGpu).toBeGreaterThan(0);
  });

  it('a solve costs (desktop, Dawn D3D12): cut + 5 solves to convergence + the answer read', async () => {
    const t: number[] = [];
    for (let i = 0; i < 8; i++) t.push((await gpu.solve(place)).ms);
    t.sort((a, b) => a - b);
    console.log(JSON.stringify({ solveMs: { min: +t[0].toFixed(2), median: +t[4].toFixed(2), max: +t[7].toFixed(2) }, rounds: gpu.stats.rounds, edges: graph.neGrid, nodes: graph.nv + plan.ids.length, doors: plan.doors.length / 4 }));
  });
});

describe('the live columns change: the cuts follow', () => {
  it('a flood across a lane cuts it (water written into the columns, the next solve reads it)', async () => {
    await gpu.solve(place);
    const before = await gpu.cuts();
    const net = roads.net;
    let lane = -1;
    for (let e = 0; e < graph.neGrid && lane < 0; e++) if (net.kind[e] === PATH_LANE && !before.bits[e]) lane = e;
    expect(lane).toBeGreaterThanOrEqual(0);
    const W = header.dims.w;
    const unpack = (p: number) => [(p & 0xffff) - 32768 + place.dx, (p >>> 16) - 32768 + place.dy];
    const water = await w.core.readBuffer('water');
    const was = water.slice();
    for (const p of [graph.colOf[graph.ends[lane * 2]], graph.colOf[graph.ends[lane * 2 + 1]], graph.colOf[graph.nv + lane]]) {
      const [x, y] = unpack(p);
      water[y * W + x] = 2;
    }
    g.device.queue.writeBuffer(w.core.world.water, 0, w.core.world.ring.toStore(water));
    await gpu.solve(place);
    const after = await gpu.cuts();
    expect(after.bits[lane] & RC.water).toBe(RC.water);
    // (dry again: walkable again)
    g.device.queue.writeBuffer(w.core.world.water, 0, w.core.world.ring.toStore(was));
    await gpu.solve(place);
    expect((await gpu.cuts()).bits[lane] & RC.water).toBe(0);
    expect(g.takeErrors()).toEqual([]);
  });
});
