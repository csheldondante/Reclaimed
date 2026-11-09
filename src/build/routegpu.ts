// The town's route network on the GPU (DA-A22, docs/design/ROUTES_ON_GPU.md; shaders/townroute.wgsl, the graph and
// the plan's part: build/routegraph.ts). One graph — the cuts read from the live columns, reach as its connected
// components — so nothing on the CPU judges the land.
//
// A solve: one submit cuts every edge from the columns as they stand, starts the five solves' labels (the rules as they
// are; a wall, water, a cliff, a terrace lifted), hooks and jumps them ROUND times, asks each structure's node whether
// it's in the stores' vertex's component, and copies out the answers with the "something moved in the last iteration"
// flag. Read back asynchronously: a word for the flag and one a structure (bit m: reached in solve m). Not settled (the
// flag set): another ROUND on the same labels. A half-made labelling only ever leaves components split, never joined,
// so a bit set is a reach that holds.
import { makeBindGroup, makeCompute, whenPipelinesReady, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import routeWgsl from '../shaders/townroute.wgsl?raw';
import type { RouteGraph, RoutePlan } from './routegraph';
import { SLOPE } from './ways';
import { ROAD_GRADE } from './grade';
import { DEEP, STEP } from '../agents/rules';

/** the solves (townroute.wgsl LIFTS): their answer bits */
export const REACH_BIT = { reached: 1, wall: 2, water: 4, cliff: 8, terrace: 16 } as const;
const MODES = 5;
/** the cut's bits as read back by `cuts` (townroute.wgsl RC_*) */
export const RC = { wall: 1, water: 2, cliff: 4, steep: 16, inner: 32, off: 64 } as const;
/** hook-and-jump iterations a submit (the flag cleared before the last) */
const ROUND = 16;
/** submits before a solve is a bug: labels that never settle, loud */
const MAX_ROUNDS = 64;

type K = 'cut' | 'init' | 'hook' | 'jump' | 'query';

export interface RouteSolve {
  /** per structure (RoutePlan.ids order) its answer word (REACH_BIT) */
  words: Uint32Array;
  rounds: number;
  ms: number;
}

/** where the town's box lies in the window: its column (0, 0) at (dx, dy); window z = world z − oz */
export interface RoutePlace {
  dx: number;
  dy: number;
  oz: number;
}

export class TownRouteGpu {
  private k: Record<K, ComputeKernel>;
  private colOf: GPUBuffer;
  private edges: GPUBuffer;
  private cut: GPUBuffer;
  private doors: GPUBuffer;
  private label: GPUBuffer;
  private answer: GPUBuffer;
  private stage: GPUBuffer;
  private params: GPUBuffer;
  private edgeWords: Uint32Array;
  private ns = 0;
  private nd = 0;
  private storesV = 0;
  private doorCap = 0;
  private structCap = 0;
  private ready: Promise<void>;
  private gone = false;
  readonly stats = { solves: 0, rounds: 0, lastMs: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    readonly graph: RouteGraph,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const { nv, ne } = graph;
    this.colOf = device.createBuffer({ label: 'route cols', size: (nv + ne) * 4, usage: S });
    device.queue.writeBuffer(this.colOf, 0, graph.colOf);
    this.edges = device.createBuffer({ label: 'route edges', size: ne * 16, usage: S });
    this.edgeWords = new Uint32Array(ne * 4);
    const lenBits = new Uint32Array(graph.len.buffer, graph.len.byteOffset, ne);
    for (let e = 0; e < ne; e++) {
      this.edgeWords[e * 4] = graph.ends[e * 2];
      this.edgeWords[e * 4 + 1] = graph.ends[e * 2 + 1];
      this.edgeWords[e * 4 + 2] = lenBits[e];
    }
    this.cut = device.createBuffer({ label: 'route cut', size: ne * 16, usage: S });
    this.doors = device.createBuffer({ label: 'route doors', size: 16, usage: S });
    this.label = device.createBuffer({ label: 'route labels', size: 4, usage: S });
    this.answer = device.createBuffer({ label: 'route answer', size: 4, usage: S });
    this.stage = device.createBuffer({ label: 'route answer read', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: 'route params', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const parts = [commonWgsl, layersWgsl, materialsWgsl, routeWgsl];
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `route-${e}`, parts, { 0: 'uniform', 11: 'uniform', ...sp }, e);
    this.k = {
      cut: mk('routeCut', { 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw' }),
      init: mk('routeInit', { 9: 'rw' }),
      hook: mk('routeHook', { 6: 'read', 7: 'rw', 8: 'read', 9: 'rw', 10: 'rw' }),
      jump: mk('routeJump', { 9: 'rw', 10: 'rw' }),
      query: mk('routeQuery', { 9: 'rw', 10: 'rw' }),
    };
    this.ready = new Promise((r) => whenPipelinesReady(r));
  }

  /** The plan's part (an edit's): the edges' bits, the door candidates, the structures, the stores' vertex. */
  setPlan(p: RoutePlan): void {
    const { ne, nv } = this.graph;
    if (p.edgeBits.length !== ne) throw new Error(`route: plan bits for ${p.edgeBits.length} edges, the graph has ${ne}`);
    for (let e = 0; e < ne; e++) this.edgeWords[e * 4 + 3] = p.edgeBits[e];
    this.device.queue.writeBuffer(this.edges, 0, this.edgeWords);
    this.ns = p.ids.length;
    this.nd = p.doors.length / 4;
    this.storesV = p.storesV;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    if (this.nd > this.doorCap) {
      this.doorCap = Math.max(this.nd, this.doorCap * 2, 64);
      this.doors.destroy();
      this.doors = this.device.createBuffer({ label: 'route doors', size: this.doorCap * 16, usage: S });
    }
    if (this.nd) this.device.queue.writeBuffer(this.doors, 0, p.doors);
    if (this.structCap === 0 || this.ns > this.structCap) {
      this.structCap = Math.max(this.ns, this.structCap * 2, 64);
      this.label.destroy();
      this.answer.destroy();
      this.stage.destroy();
      this.label = this.device.createBuffer({ label: 'route labels', size: MODES * (nv + this.structCap) * 4, usage: S });
      this.answer = this.device.createBuffer({ label: 'route answer', size: (1 + this.structCap) * 4, usage: S });
      this.stage = this.device.createBuffer({ label: 'route answer read', size: (1 + this.structCap) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
  }

  private writeParams(place: RoutePlace): void {
    const { nv, ne } = this.graph;
    const b = new ArrayBuffer(64);
    new Int32Array(b, 0, 4).set([place.dx, place.dy, this.storesV, 0]);
    new Uint32Array(b, 16, 4).set([nv, ne, this.ns, this.nd]);
    new Float32Array(b, 32, 8).set([place.oz, SLOPE, ROAD_GRADE, DEEP, STEP, MODES, 0, 0]);
    this.device.queue.writeBuffer(this.params, 0, b);
  }

  private groups(): Record<K, GPUBindGroup> {
    const W = this.world;
    const g = (k: ComputeKernel, r: Record<number, GPUBuffer>) => makeBindGroup(this.device, 'route', k.layout, { 0: W.globals, 11: this.params, ...r });
    return {
      cut: g(this.k.cut, { 1: W.chunks, 2: W.materials, 3: W.layers, 4: W.water, 5: this.colOf, 6: this.edges, 7: this.cut }),
      init: g(this.k.init, { 9: this.label }),
      hook: g(this.k.hook, { 6: this.edges, 7: this.cut, 8: this.doors, 9: this.label, 10: this.answer }),
      jump: g(this.k.jump, { 9: this.label, 10: this.answer }),
      query: g(this.k.query, { 9: this.label, 10: this.answer }),
    };
  }

  /** The cuts and the components to convergence, the answers read back (see the head). */
  async solve(place: RoutePlace): Promise<RouteSolve> {
    await this.ready;
    if (this.gone) throw new DOMException('route: disposed', 'AbortError');
    const t0 = performance.now();
    const d = this.device;
    this.writeParams(place);
    const G = this.groups();
    const { nv, ne } = this.graph;
    const nodes = nv + this.ns;
    const bytes = (1 + this.ns) * 4;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const enc = d.createCommandEncoder({ label: 'route' });
      const pass = (k: ComputeKernel, gr: GPUBindGroup, n: number, z: number) => {
        const cp = enc.beginComputePass({ label: 'route' });
        cp.setPipeline(k.pipeline);
        cp.setBindGroup(0, gr);
        cp.dispatchWorkgroups(Math.max(1, Math.ceil(n / 64)), 1, z);
        cp.end();
      };
      if (round === 1) {
        pass(this.k.cut, G.cut, ne, 1);
        pass(this.k.init, G.init, nodes, MODES);
      }
      for (let i = 0; i < ROUND; i++) {
        if (i === ROUND - 1) enc.clearBuffer(this.answer, 0, 4);
        pass(this.k.hook, G.hook, ne + this.nd, MODES);
        pass(this.k.jump, G.jump, nodes, MODES);
        pass(this.k.jump, G.jump, nodes, MODES);
      }
      if (this.ns) enc.clearBuffer(this.answer, 4, this.ns * 4);
      pass(this.k.query, G.query, this.ns, MODES);
      enc.copyBufferToBuffer(this.answer, 0, this.stage, 0, bytes);
      d.queue.submit([enc.finish()]);
      await this.stage.mapAsync(GPUMapMode.READ, 0, bytes);
      if (this.gone) throw new DOMException('route: disposed', 'AbortError');
      const all = new Uint32Array(this.stage.getMappedRange(0, bytes).slice(0));
      this.stage.unmap();
      if (all[0] !== 0) continue;
      this.stats.solves++;
      this.stats.rounds = round;
      this.stats.lastMs = performance.now() - t0;
      return { words: all.slice(1), rounds: round, ms: this.stats.lastMs };
    }
    throw new Error(`route: the labels didn't settle in ${MAX_ROUNDS * ROUND} iterations`);
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
    for (const b of [this.colOf, this.edges, this.cut, this.doors, this.label, this.answer, this.stage, this.params]) b.destroy();
  }
}
