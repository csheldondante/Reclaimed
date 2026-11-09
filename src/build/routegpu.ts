// The town's route network on the GPU (DA-A22, docs/design/ROUTES_ON_GPU.md; shaders/townroute.wgsl, the graph and
// the plan's part: build/routegraph.ts). One graph — the cuts read from the ground as it stands, the drawn paths laid
// down fields over them, reach as its connected components, the riders' fields over the same edges — so nothing on the
// CPU judges the land and reach and routes can't differ.
//
// The ground (RouteGround): in play the world's live columns (the chunk table, the layers, the water sheet:
// routeground-live.wgsl); at generation the raw ground the GPU made of a town's box (routeground-raw.wgsl). One cut
// kernel reads either through the same three functions.
//
// A solve, in submits (each read back asynchronously: the "something moved" flag, 4 B, until clear):
//  1. every edge cut; field 0 seeded (the middle, the main roads' verge edges: main streets) and relaxed SWEEPS a submit;
//  2. the gates' far corners traced down it (main streets); field 1 seeded (every main street) and relaxed;
//  3. each structure's lane traced down field 1; the five reach solves started and hooked and jumped ROUND a submit;
//  4. per structure its answer, the gate cells that would join what isn't reached; the answer and the paths' kinds read.
// Nothing waits on it: the caller gets the answer a few frames later.
import { makeBindGroup, makeCompute, whenPipelinesReady, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import routeWgsl from '../shaders/townroute.wgsl?raw';
import liveWgsl from '../shaders/routeground-live.wgsl?raw';
import rawWgsl from '../shaders/routeground-raw.wgsl?raw';
import type { RouteGraph, RoutePlan } from './routegraph';
import { SLOPE } from './ways';
import { ROAD_GRADE } from './grade';
import { DEEP, STEP } from '../agents/rules';

/** the solves (townroute.wgsl LIFTS): their answer bits */
export const REACH_BIT = { reached: 1, wall: 2, water: 4, cliff: 8, terrace: 16 } as const;
const MODES = 5;
/** the cut's bits as read back by `cuts` (townroute.wgsl RC_*) */
export const RC = { wall: 1, water: 2, cliff: 4, steep: 16, inner: 32, off: 64 } as const;
/** townroute.wgsl GATE_CAP, ANSWER_W */
export const GATE_CAP = 64;
const ANSWER_W = 4;
/** hook-and-jump iterations a submit (the flag cleared before the last) */
const ROUND = 16;
/** relax sweeps a submit */
const SWEEPS = 32;
/** submits a phase before it's a bug: a field or labels that never settle, loud */
const MAX_ROUNDS = 64;
/** the layout's fields; the riders' (one a group: agents.ts MAX_GROUPS) after them */
const FIELDS = 2;
export const RIDE_GROUPS = 24;
/** townroute.wgsl RIDE_GOALS; the requests a trace dispatch takes */
export const RIDE_GOALS = 256;
const RIDE_REQUESTS = 1024;

/** where the ground comes from: the world's live columns, or a box's raw ground (box-local, world z, w × h) */
export type RouteGround = { live: WorldGpu } | { raw: { ground: GPUBuffer; water: GPUBuffer; w: number; h: number } };

/** where the town's box lies on the ground: its column (0, 0) at (dx, dy); the ground's z = world z − oz */
export interface RoutePlace {
  dx: number;
  dy: number;
  oz: number;
}

export interface RouteAnswer {
  /** per structure (RoutePlan.ids order): its REACH_BIT word; its lane's door (an edge; -1 none); with no door at
   *  grade, the ground of its walkable side nearest its floor (a terrace's level; NaN none); a door at grade (1) */
  words: Uint32Array;
  door: Int32Array;
  terrace: Float32Array;
  grade: Uint8Array;
  /** wall cells where a gate joins something unreached to the stores (at most GATE_CAP) */
  gates: number[];
  /** per edge its drawn kind (edgenet.ts PATH_LANE 1, PATH_MAIN 2) */
  kinds: Uint8Array;
  /** per vertex 1 when it's in the stores' component: what a rider joins, what a goal stands by */
  main: Uint8Array;
  /** submits a phase took (fields 0 and 1, reach) and the wall time */
  rounds: number[];
  ms: number;
}

/** a rider's goal: its vertex and its point (the box's frame) */
export interface RideGoal {
  node: number;
  x: number;
  y: number;
}

/** a route to trace: its id (its header in `routes`), its group, the vertex it starts from (-1: the goal's point
 *  alone), its goal (an index into the goals as last set: for the goal's point alone) */
export interface RideRequest {
  route: number;
  group: number;
  node: number;
  goal: number;
}

type K = 'cut' | 'fieldInit' | 'fieldSeed' | 'fieldRelax' | 'traceMains' | 'traceLanes' | 'init' | 'hook' | 'jump' | 'struct' | 'gates' | 'verts' | 'rideSeed' | 'rideTrace';
type RK = 'fieldInit' | 'rideSeed' | 'fieldRelax' | 'rideTrace';
type FK = 'fieldInit' | 'fieldSeed' | 'fieldRelax' | 'traceMains' | 'traceLanes';

export class TownRouteGpu {
  private k: Record<K, ComputeKernel>;
  private colOf: GPUBuffer;
  private csr: GPUBuffer;
  private edges: GPUBuffer;
  private cut: GPUBuffer;
  private dist: GPUBuffer;
  private kind: GPUBuffer;
  private doors: GPUBuffer;
  private info: GPUBuffer;
  private jobs: GPUBuffer;
  private label: GPUBuffer;
  private mark: GPUBuffer;
  private answer: GPUBuffer;
  private stage: GPUBuffer;
  private kindStage: GPUBuffer;
  private params: GPUBuffer;
  private fieldParams: GPUBuffer[];
  private vbits: GPUBuffer;
  private vbitsStage: GPUBuffer;
  /** the riders: the goals and requests, their params, the field being solved */
  private ride: GPUBuffer;
  private rideParams: GPUBuffer;
  private rideFieldParams: GPUBuffer;
  /** the goals as last set: per group its list; all of them in order (their index a request's `goal`) */
  private goalsOf = new Map<number, RideGoal[]>();
  private goalList: { group: number; g: RideGoal }[] = [];
  private edgeWords: Uint32Array;
  private plan: RoutePlan | null = null;
  private cap = { doors: 0, structs: 0, jobs: 0 };
  private ready: Promise<void>;
  private gone = false;
  private busy: Promise<unknown> = Promise.resolve();
  readonly stats = { solves: 0, lastMs: 0, rounds: [0, 0, 0] };

  constructor(
    private device: GPUDevice,
    private ground: RouteGround,
    readonly graph: RouteGraph,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const { nv, ne } = graph;
    const buf = (label: string, size: number) => device.createBuffer({ label, size: Math.max(16, size), usage: S });
    this.colOf = buf('route cols', (nv + ne) * 4);
    device.queue.writeBuffer(this.colOf, 0, graph.colOf);
    this.csr = buf('route csr', graph.csr.byteLength);
    device.queue.writeBuffer(this.csr, 0, graph.csr);
    this.edges = buf('route edges', ne * 16);
    this.edgeWords = new Uint32Array(ne * 4);
    const lenBits = new Uint32Array(graph.len.buffer, graph.len.byteOffset, ne);
    for (let e = 0; e < ne; e++) {
      this.edgeWords[e * 4] = graph.ends[e * 2];
      this.edgeWords[e * 4 + 1] = graph.ends[e * 2 + 1];
      this.edgeWords[e * 4 + 2] = lenBits[e];
    }
    this.cut = buf('route cut', ne * 16);
    const kb = Math.ceil(ne / 4) * 4;
    this.kind = buf('route kinds', kb);
    this.kindStage = device.createBuffer({ label: 'route kinds read', size: Math.max(16, kb), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.doors = buf('route doors', 16);
    this.info = buf('route structures', 16);
    this.jobs = buf('route jobs', 16);
    this.dist = buf('route fields', 16);
    this.label = buf('route labels', 16);
    this.mark = buf('route marks', 16);
    this.answer = buf('route answer', 16);
    this.stage = device.createBuffer({ label: 'route answer read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: 'route params', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const vb = Math.ceil(nv / 32) * 4;
    this.vbits = buf('route main verts', vb);
    this.vbitsStage = device.createBuffer({ label: 'route main verts read', size: Math.max(16, vb), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.ride = buf('route riders', (4 + RIDE_GOALS * 4 + RIDE_REQUESTS * 4) * 4);
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.rideParams = device.createBuffer({ label: 'route ride params', size: 16, usage: U });
    this.rideFieldParams = device.createBuffer({ label: 'route ride field', size: 16, usage: U });
    // (field 0: the layout's costs, seeded by the verge; field 1: the layout's, seeded by the main streets)
    this.fieldParams = [
      [0, 0, 0, 0],
      [1, 0, 1, 0],
    ].map((f) => {
      const b = device.createBuffer({ label: 'route field params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array(f));
      return b;
    });
    const live = 'live' in ground;
    const parts = live ? [commonWgsl, layersWgsl, materialsWgsl, routeWgsl, liveWgsl] : [commonWgsl, routeWgsl, rawWgsl];
    const groundSpec: BindSpec = live ? { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read' } : { 3: 'read', 4: 'read' };
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `route-${e}`, parts, { 11: 'uniform', ...sp }, e);
    const F: BindSpec = { 17: 'uniform' };
    this.k = {
      cut: mk('routeCut', { ...groundSpec, 5: 'read', 6: 'read', 7: 'rw' }),
      fieldInit: mk('fieldInit', { ...F, 13: 'rw' }),
      fieldSeed: mk('fieldSeed', { ...F, 6: 'read', 7: 'rw', 13: 'rw', 14: 'rw' }),
      fieldRelax: mk('fieldRelax', { ...F, 6: 'read', 7: 'rw', 10: 'rw', 13: 'rw', 14: 'rw' }),
      traceMains: mk('traceMains', { ...F, 6: 'read', 7: 'rw', 12: 'read', 13: 'rw', 14: 'rw', 15: 'read' }),
      traceLanes: mk('traceLanes', { ...F, 6: 'read', 7: 'rw', 8: 'read', 10: 'rw', 12: 'read', 13: 'rw', 14: 'rw', 16: 'read' }),
      init: mk('routeInit', { 9: 'rw', 18: 'rw' }),
      hook: mk('routeHook', { 6: 'read', 7: 'rw', 9: 'rw', 10: 'rw', 14: 'rw' }),
      jump: mk('routeJump', { 9: 'rw', 10: 'rw' }),
      struct: mk('routeStruct', { 6: 'read', 7: 'rw', 8: 'read', 9: 'rw', 10: 'rw', 16: 'read', 18: 'rw' }),
      gates: mk('routeGates', { 9: 'rw', 10: 'rw', 15: 'read', 18: 'rw' }),
      verts: mk('routeVerts', { 9: 'rw', 23: 'rw' }),
      rideSeed: mk('rideSeed', { ...F, 13: 'rw', 19: 'rw', 22: 'uniform' }),
      rideTrace: mk('rideTrace', { ...F, 6: 'read', 7: 'rw', 12: 'read', 13: 'rw', 14: 'rw', 19: 'rw', 20: 'rw', 21: 'rw', 22: 'uniform' }),
    };
    this.ready = new Promise((r) => whenPipelinesReady(r));
  }

  /** The plan's part (an edit's): the edges' bits, the door candidates, the structures, the jobs, the stores. */
  setPlan(p: RoutePlan): void {
    const { ne, nv } = this.graph;
    if (p.edgeBits.length !== ne) throw new Error(`route: plan bits for ${p.edgeBits.length} edges, the graph has ${ne}`);
    for (let e = 0; e < ne; e++) this.edgeWords[e * 4 + 3] = p.edgeBits[e];
    const d = this.device;
    d.queue.writeBuffer(this.edges, 0, this.edgeWords);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const nd = p.doors.length / 4;
    const ns = p.ids.length;
    if (nd > this.cap.doors) {
      this.cap.doors = Math.max(nd, this.cap.doors * 2, 64);
      this.doors.destroy();
      this.doors = d.createBuffer({ label: 'route doors', size: this.cap.doors * 16, usage: S });
    }
    if (p.jobs.length > this.cap.jobs) {
      this.cap.jobs = Math.max(p.jobs.length, this.cap.jobs * 2, 64);
      this.jobs.destroy();
      this.jobs = d.createBuffer({ label: 'route jobs', size: this.cap.jobs * 4, usage: S });
    }
    if (this.cap.structs === 0 || ns > this.cap.structs) {
      this.cap.structs = Math.max(ns, this.cap.structs * 2, 64);
      const n = nv + this.cap.structs;
      for (const b of [this.info, this.dist, this.label, this.mark, this.answer, this.stage]) b.destroy();
      this.info = d.createBuffer({ label: 'route structures', size: this.cap.structs * 16, usage: S });
      this.dist = d.createBuffer({ label: 'route fields', size: (FIELDS + RIDE_GROUPS) * nv * 4, usage: S });
      this.label = d.createBuffer({ label: 'route labels', size: MODES * n * 4, usage: S });
      this.mark = d.createBuffer({ label: 'route marks', size: n * 4, usage: S });
      const words = 2 + GATE_CAP + this.cap.structs * ANSWER_W;
      this.answer = d.createBuffer({ label: 'route answer', size: words * 4, usage: S });
      this.stage = d.createBuffer({ label: 'route answer read', size: words * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    if (nd) d.queue.writeBuffer(this.doors, 0, p.doors);
    if (p.jobs.length) d.queue.writeBuffer(this.jobs, 0, p.jobs);
    if (ns) d.queue.writeBuffer(this.info, 0, p.info);
    this.plan = p;
  }

  private writeParams(place: RoutePlace): void {
    const p = this.plan!;
    const { nv, ne } = this.graph;
    const b = new ArrayBuffer(80);
    new Int32Array(b, 0, 4).set([place.dx, place.dy, p.storesV, p.centreV]);
    new Uint32Array(b, 16, 4).set([nv, ne, p.ids.length, p.doors.length / 4]);
    new Float32Array(b, 32, 8).set([place.oz, SLOPE, ROAD_GRADE, DEEP, STEP, MODES, 0, 0]);
    const raw = 'raw' in this.ground ? this.ground.raw : null;
    new Uint32Array(b, 64, 4).set([raw?.w ?? 0, raw?.h ?? 0, p.targets, p.walls]);
    this.device.queue.writeBuffer(this.params, 0, b);
  }

  private groups(): { k: Record<'cut' | 'init' | 'hook' | 'jump' | 'struct' | 'gates' | 'verts', GPUBindGroup>; f: Record<FK, GPUBindGroup>[] } {
    const gr = this.ground;
    const base: Record<number, GPUBuffer> = { 11: this.params };
    const groundRes: Record<number, GPUBuffer> = 'live' in gr ? { 0: gr.live.globals, 1: gr.live.chunks, 2: gr.live.materials, 3: gr.live.layers, 4: gr.live.water } : { 3: gr.raw.ground, 4: gr.raw.water };
    const g = (k: ComputeKernel, r: Record<number, GPUBuffer>) => makeBindGroup(this.device, 'route', k.layout, { ...base, ...r });
    const R: Record<number, GPUBuffer> = { 5: this.colOf, 6: this.edges, 7: this.cut, 8: this.doors, 9: this.label, 10: this.answer, 12: this.csr, 13: this.dist, 14: this.kind, 15: this.jobs, 16: this.info, 18: this.mark };
    const pick = (ks: number[]) => Object.fromEntries(ks.map((n) => [n, R[n]]));
    const k = {
      cut: g(this.k.cut, { ...groundRes, ...pick([5, 6, 7]) }),
      init: g(this.k.init, pick([9, 18])),
      verts: g(this.k.verts, { 9: this.label, 23: this.vbits }),
      hook: g(this.k.hook, pick([6, 7, 9, 10, 14])),
      jump: g(this.k.jump, pick([9, 10])),
      struct: g(this.k.struct, pick([6, 7, 8, 9, 10, 16, 18])),
      gates: g(this.k.gates, pick([9, 10, 15, 18])),
    };
    const f = this.fieldParams.map((fp) => ({
      fieldInit: g(this.k.fieldInit, { 17: fp, ...pick([13]) }),
      fieldSeed: g(this.k.fieldSeed, { 17: fp, ...pick([6, 7, 13, 14]) }),
      fieldRelax: g(this.k.fieldRelax, { 17: fp, ...pick([6, 7, 10, 13, 14]) }),
      traceMains: g(this.k.traceMains, { 17: fp, ...pick([6, 7, 12, 13, 14, 15]) }),
      traceLanes: g(this.k.traceLanes, { 17: fp, ...pick([6, 7, 8, 10, 12, 13, 14, 16]) }),
    }));
    return { k, f };
  }

  /** The cuts, the paths, reach — to convergence, the answer read back (see the head). One at a time, in order. */
  solve(place: RoutePlace): Promise<RouteAnswer> {
    const run = this.busy.then(
      () => this.solveNow(place),
      () => this.solveNow(place),
    );
    this.busy = run;
    return run;
  }

  private async solveNow(place: RoutePlace): Promise<RouteAnswer> {
    await this.ready;
    if (this.gone) throw new DOMException('route: disposed', 'AbortError');
    const p = this.plan;
    if (!p) throw new Error('route: solve before setPlan');
    const t0 = performance.now();
    const d = this.device;
    this.writeParams(place);
    const G = this.groups();
    const { nv, ne } = this.graph;
    const ns = p.ids.length;
    const nodes = nv;
    let enc!: GPUCommandEncoder;
    const pass = (k: K, gr: GPUBindGroup, n: number, z = 1) => {
      const cp = enc.beginComputePass({ label: 'route' });
      cp.setPipeline(this.k[k].pipeline);
      cp.setBindGroup(0, gr);
      cp.dispatchWorkgroups(Math.max(1, Math.ceil(n / 64)), 1, z);
      cp.end();
    };
    /** submits until the flag stays clear: `first` once, then `each` `iters` times (the flag cleared before the last) */
    const settle = async (label: string, first: () => void, each: () => void, iters: number): Promise<number> => {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        enc = d.createCommandEncoder({ label });
        if (round === 1) first();
        for (let i = 0; i < iters; i++) {
          if (i === iters - 1) enc.clearBuffer(this.answer, 0, 4);
          each();
        }
        enc.copyBufferToBuffer(this.answer, 0, this.stage, 0, 4);
        d.queue.submit([enc.finish()]);
        await this.stage.mapAsync(GPUMapMode.READ, 0, 4);
        if (this.gone) throw new DOMException('route: disposed', 'AbortError');
        const moved = new Uint32Array(this.stage.getMappedRange(0, 4))[0];
        this.stage.unmap();
        if (!moved) return round;
      }
      throw new Error(`route: ${label} didn't settle in ${MAX_ROUNDS} submits`);
    };
    const words = 2 + GATE_CAP + ns * ANSWER_W;
    const r0 = await settle(
      'route field 0',
      () => {
        enc.clearBuffer(this.kind);
        enc.clearBuffer(this.answer, 0, words * 4);
        pass('cut', G.k.cut, ne);
        pass('fieldInit', G.f[0].fieldInit, nodes);
        pass('fieldSeed', G.f[0].fieldSeed, ne);
      },
      () => pass('fieldRelax', G.f[0].fieldRelax, ne),
      SWEEPS,
    );
    const r1 = await settle(
      'route field 1',
      () => {
        if (p.targets) pass('traceMains', G.f[0].traceMains, p.targets);
        pass('fieldInit', G.f[1].fieldInit, nodes);
        pass('fieldSeed', G.f[1].fieldSeed, ne);
      },
      () => pass('fieldRelax', G.f[1].fieldRelax, ne),
      SWEEPS,
    );
    const r2 = await settle(
      'route reach',
      () => {
        if (ns) pass('traceLanes', G.f[1].traceLanes, ns);
        pass('init', G.k.init, nodes, MODES);
      },
      () => {
        pass('hook', G.k.hook, ne, MODES);
        pass('jump', G.k.jump, nodes, MODES);
        pass('jump', G.k.jump, nodes, MODES);
      },
      ROUND,
    );
    enc = d.createCommandEncoder({ label: 'route answer' });
    if (ns) pass('struct', G.k.struct, ns, MODES);
    if (p.walls) pass('gates', G.k.gates, p.walls);
    const vb = Math.ceil(nv / 32) * 4;
    enc.clearBuffer(this.vbits);
    pass('verts', G.k.verts, nv);
    enc.copyBufferToBuffer(this.vbits, 0, this.vbitsStage, 0, vb);
    enc.copyBufferToBuffer(this.answer, 0, this.stage, 0, words * 4);
    const kb = Math.ceil(ne / 4) * 4;
    enc.copyBufferToBuffer(this.kind, 0, this.kindStage, 0, kb);
    d.queue.submit([enc.finish()]);
    await Promise.all([this.stage.mapAsync(GPUMapMode.READ, 0, words * 4), this.kindStage.mapAsync(GPUMapMode.READ, 0, kb), this.vbitsStage.mapAsync(GPUMapMode.READ, 0, vb)]);
    if (this.gone) throw new DOMException('route: disposed', 'AbortError');
    const all = new Uint32Array(this.stage.getMappedRange(0, words * 4).slice(0));
    this.stage.unmap();
    const kinds = new Uint8Array(this.kindStage.getMappedRange(0, kb).slice(0), 0, ne);
    this.kindStage.unmap();
    const vw = new Uint32Array(this.vbitsStage.getMappedRange(0, vb).slice(0));
    this.vbitsStage.unmap();
    const main = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) main[v] = (vw[v >> 5] >>> (v & 31)) & 1;
    const f = new Float32Array(all.buffer);
    const out: RouteAnswer = {
      words: new Uint32Array(ns),
      door: new Int32Array(ns),
      terrace: new Float32Array(ns),
      grade: new Uint8Array(ns),
      gates: [...all.subarray(2, 2 + Math.min(all[1], GATE_CAP))],
      kinds: kinds.map((k) => (k & 2 ? 2 : k)),
      main,
      rounds: [r0, r1, r2],
      ms: 0,
    };
    for (let s = 0; s < ns; s++) {
      const a = 2 + GATE_CAP + s * ANSWER_W;
      out.words[s] = all[a];
      out.door[s] = all[a + 1] - 1;
      out.terrace[s] = all[a + 2] === 0x7f800000 ? NaN : f[a + 2];
      out.grade[s] = all[a + 3];
    }
    out.ms = performance.now() - t0;
    this.stats.solves++;
    this.stats.lastMs = out.ms;
    this.stats.rounds = out.rounds;
    return out;
  }

  // ---- the riders (agents/routeride.ts): their groups' fields and their routes' points, on the GPU ----

  /**
   * Group `g`'s goals (null: it doesn't ride): its field made again from them over the edges as last solved — queued
   * after what was asked before (a solve, a trace). The goals' indices (a request's `goal`) are as of this call.
   */
  setRideGoals(g: number, goals: readonly RideGoal[] | null): void {
    if (g < 0 || g >= RIDE_GROUPS) throw new Error(`route: group ${g} out of 0..${RIDE_GROUPS - 1}`);
    if (goals?.length) this.goalsOf.set(g, goals.map((x) => ({ ...x })));
    else this.goalsOf.delete(g);
    this.goalList = [...this.goalsOf].flatMap(([group, gs]) => gs.map((x) => ({ group, g: x })));
    if (this.goalList.length > RIDE_GOALS) throw new Error(`route: ${this.goalList.length} riders' goals, at most ${RIDE_GOALS}`);
    const words = new Uint32Array(this.goalList.length * 4);
    const wf = new Float32Array(words.buffer);
    this.goalList.forEach((x, i) => {
      words[i * 4] = FIELDS + x.group;
      words[i * 4 + 1] = x.g.node;
      wf[i * 4 + 2] = x.g.x;
      wf[i * 4 + 3] = x.g.y;
    });
    const n = this.goalList.length;
    const go = () => this.rideField(g, words, n, !!goals?.length);
    this.busy = this.busy.then(go, go);
  }

  /** the index of group `g`'s goal at vertex `node` in the goals as last set (-1: none) */
  goalIndex(g: number, node: number): number {
    return this.goalList.findIndex((x) => x.group === g && x.g.node === node);
  }

  /** the goals written; group g's field relaxed from them to the end (when it rides) */
  private async rideField(g: number, goals: Uint32Array, n: number, rides: boolean): Promise<void> {
    await this.ready;
    if (this.gone || !this.plan) return;
    const d = this.device;
    if (goals.length) d.queue.writeBuffer(this.ride, 16, goals);
    if (!rides) return;
    d.queue.writeBuffer(this.rideParams, 0, new Uint32Array([n, 0, 0, 0]));
    d.queue.writeBuffer(this.rideFieldParams, 0, new Uint32Array([FIELDS + g, 1, 0, 0]));
    const { nv, ne } = this.graph;
    const R = this.rideGroups();
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const enc = d.createCommandEncoder({ label: 'route ride field' });
      const pass = (k: K, gr: GPUBindGroup, count: number) => {
        const cp = enc.beginComputePass({ label: 'route ride' });
        cp.setPipeline(this.k[k].pipeline);
        cp.setBindGroup(0, gr);
        cp.dispatchWorkgroups(Math.max(1, Math.ceil(count / 64)));
        cp.end();
      };
      if (round === 1) {
        pass('fieldInit', R.fieldInit, nv);
        pass('rideSeed', R.rideSeed, n);
      }
      for (let i = 0; i < SWEEPS; i++) {
        if (i === SWEEPS - 1) enc.clearBuffer(this.answer, 0, 4);
        pass('fieldRelax', R.fieldRelax, ne);
      }
      enc.copyBufferToBuffer(this.answer, 0, this.stage, 0, 4);
      d.queue.submit([enc.finish()]);
      await this.stage.mapAsync(GPUMapMode.READ, 0, 4);
      if (this.gone) return;
      const moved = new Uint32Array(this.stage.getMappedRange(0, 4))[0];
      this.stage.unmap();
      if (!moved) return;
    }
    throw new Error(`route: group ${g}'s field didn't settle in ${MAX_ROUNDS} submits`);
  }

  private rideGroups(pts?: GPUBuffer, routes?: GPUBuffer): Record<RK, GPUBindGroup> {
    const g = (k: ComputeKernel, r: Record<number, GPUBuffer>) => makeBindGroup(this.device, 'route ride', k.layout, { 11: this.params, 17: this.rideFieldParams, ...r });
    const out = {
      fieldInit: g(this.k.fieldInit, { 13: this.dist }),
      rideSeed: g(this.k.rideSeed, { 13: this.dist, 19: this.ride, 22: this.rideParams }),
      fieldRelax: g(this.k.fieldRelax, { 6: this.edges, 7: this.cut, 10: this.answer, 13: this.dist, 14: this.kind }),
    } as Record<RK, GPUBindGroup>;
    if (pts && routes) out.rideTrace = g(this.k.rideTrace, { 6: this.edges, 7: this.cut, 12: this.csr, 13: this.dist, 14: this.kind, 19: this.ride, 20: pts, 21: routes, 22: this.rideParams });
    return out;
  }

  /** The pool emptied (no points used): a new net's routes start again. Queued in order. */
  resetRidePool(): void {
    const go = () => this.device.queue.writeBuffer(this.ride, 0, new Uint32Array([0, 0]));
    this.busy = this.busy.then(go, go);
  }

  /**
   * Routes traced down their groups' fields into `pts` (`cap` points) with their headers in `routes` (routes.wgsl's) —
   * queued after the fields asked before. A route the pool can't hold gets no points (its riders stand), counted
   * (`ridePool`).
   */
  traceRides(reqs: readonly RideRequest[], pts: GPUBuffer, routes: GPUBuffer, cap: number): void {
    if (!reqs.length) return;
    const list = reqs.slice();
    const go = async () => {
      await this.ready;
      if (this.gone || !this.plan) return;
      const d = this.device;
      const R = this.rideGroups(pts, routes);
      for (let i0 = 0; i0 < list.length; i0 += RIDE_REQUESTS) {
        const part = list.slice(i0, i0 + RIDE_REQUESTS);
        const w = new Uint32Array(part.length * 4);
        part.forEach((r, i) => w.set([r.route, FIELDS + r.group, r.node < 0 ? 0xffffffff : r.node, r.goal < 0 ? 0xffffffff : r.goal], i * 4));
        d.queue.writeBuffer(this.ride, (4 + RIDE_GOALS * 4) * 4, w);
        d.queue.writeBuffer(this.rideParams, 0, new Uint32Array([this.goalList.length, part.length, cap, 0]));
        const enc = d.createCommandEncoder({ label: 'route ride trace' });
        const cp = enc.beginComputePass({ label: 'route ride trace' });
        cp.setPipeline(this.k.rideTrace.pipeline);
        cp.setBindGroup(0, R.rideTrace);
        cp.dispatchWorkgroups(Math.ceil(part.length / 64));
        cp.end();
        d.queue.submit([enc.finish()]);
      }
    };
    this.busy = this.busy.then(go, go);
  }

  /** (tests) the pool's points used and the traces it couldn't hold */
  async ridePool(): Promise<{ used: number; overflow: number }> {
    await this.idle();
    const buf = this.device.createBuffer({ label: 'route ride pool read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder({ label: 'route ride pool read' });
    enc.copyBufferToBuffer(this.ride, 0, buf, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const w = new Uint32Array(buf.getMappedRange().slice(0));
    buf.destroy();
    return { used: w[0], overflow: w[1] };
  }

  /** everything queued (solves, fields, traces) done */
  idle(): Promise<void> {
    return this.busy.then(
      () => undefined,
      () => undefined,
    );
  }

  /** (tests, ?routedebug) the cuts as last solved: per edge its RC bits and the ground at its middle and its two ends
   *  (world z) */
  async cuts(): Promise<{ bits: Uint32Array; z: Float32Array; za: Float32Array; zb: Float32Array }> {
    const ne = this.graph.ne;
    const buf = this.device.createBuffer({ label: 'route cut read', size: ne * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder({ label: 'route cut read' });
    enc.copyBufferToBuffer(this.cut, 0, buf, 0, ne * 16);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const raw = new Uint32Array(buf.getMappedRange().slice(0));
    buf.destroy();
    const bits = new Uint32Array(ne);
    const z = new Float32Array(ne);
    const za = new Float32Array(ne);
    const zb = new Float32Array(ne);
    const zf = new Float32Array(raw.buffer);
    for (let e = 0; e < ne; e++) ((bits[e] = raw[e * 4]), (z[e] = zf[e * 4 + 1]), (za[e] = zf[e * 4 + 2]), (zb[e] = zf[e * 4 + 3]));
    return { bits, z, za, zb };
  }

  dispose(): void {
    this.gone = true;
    for (const b of [this.colOf, this.csr, this.edges, this.cut, this.dist, this.kind, this.kindStage, this.doors, this.info, this.jobs, this.label, this.mark, this.answer, this.stage, this.params, ...this.fieldParams, this.vbits, this.vbitsStage, this.ride, this.rideParams, this.rideFieldParams]) b.destroy();
  }
}
