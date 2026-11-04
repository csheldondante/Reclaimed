// The agents ride the roads on the GPU (round 128i, V128-14; shaders/roadride.wgsl says how). An owner hands its road
// graph (roadgraph.ts, in its own grid's frame) once a change and the frame's place in the window each frame; a group
// rides to goals in that frame (`setGoals`): each goal gets off at its nearest node. The next-hop tables are made again
// on the GPU when the graph or the goals change; each tick the ride stage steers the riding groups' units (after their
// step, the agents' stage list). Nothing read back: the CPU keeps its own copy of the graph to pick the goals' nodes.
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import roadrideWgsl from '../shaders/roadride.wgsl?raw';
import { ROW_H } from '../world/lattice';
import { MAX_NODES, nearestNode, nodeCount, noGraph, type RoadGraph } from './roadgraph';

type P = readonly [number, number];

/** destination slots in all (roadride.wgsl RideParams.dest) */
export const MAX_DESTS = 64;
const GROUPS = 16;
/** a goal rides only if a node is this near it (m): the last leg is straight, off the roads */
export const RIDE_NEAR = 6;
/** RideParams: n, off (2 vec4), group (16), dest (64), destNode (16) */
const RP_BYTES = (2 + GROUPS + MAX_DESTS + MAX_DESTS / 4) * 16;

export class RoadRide {
  private hopsK: ComputeKernel;
  private rideK: ComputeKernel;
  private netClearK: ComputeKernel;
  private netStampK: ComputeKernel;
  private netG!: GPUBindGroup;
  /** the frame's offset the network's plane was last stamped at */
  private netOff: [number, number] | null = null;
  private nodesBuf: GPUBuffer;
  private adjBuf: GPUBuffer;
  private adjCap = 0;
  private hopsBuf: GPUBuffer;
  private state: GPUBuffer;
  private params: GPUBuffer;
  private hopsG!: GPUBindGroup;
  private rideG!: GPUBindGroup;
  private graph: RoadGraph = noGraph();
  private off: [number, number] = [0, 0];
  /** per group its goals (the graph's frame), or none */
  private goals: (P[] | null)[] = Array.from({ length: GROUPS }, () => null);
  private dirty = false;
  private armed = false;

  constructor(
    private device: GPUDevice,
    private units: GPUBuffer,
    private roads: GPUBuffer,
    private w: number,
    maxUnits: number,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.hopsK = makeCompute(device, 'agents-rideHops', [roadrideWgsl], { 46: 'read', 47: 'read', 48: 'rw', 49: 'uniform' }, 'rideHops');
    this.rideK = makeCompute(device, 'agents-ride', [roadrideWgsl], { 44: 'rw', 45: 'rw', 46: 'read', 47: 'read', 48: 'rw', 49: 'uniform', 50: 'read' }, 'ride');
    const netSpec = { 46: 'read', 47: 'read', 48: 'rw', 49: 'uniform', 51: 'rw' } as const;
    this.netClearK = makeCompute(device, 'agents-rideNetClear', [roadrideWgsl], netSpec, 'rideNetClear');
    this.netStampK = makeCompute(device, 'agents-rideNetStamp', [roadrideWgsl], netSpec, 'rideNetStamp');
    this.nodesBuf = device.createBuffer({ label: 'agents road nodes', size: MAX_NODES * 16, usage: S });
    this.hopsBuf = device.createBuffer({ label: 'agents road hops', size: MAX_DESTS * MAX_NODES * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.state = device.createBuffer({ label: 'agents ride state', size: maxUnits * 16, usage: S | GPUBufferUsage.COPY_SRC });
    this.params = device.createBuffer({ label: 'agents ride params', size: RP_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.adjBuf = this.growAdj(1024);
  }

  private growAdj(n: number): GPUBuffer {
    this.adjBuf?.destroy();
    this.adjCap = n;
    this.adjBuf = this.device.createBuffer({ label: 'agents road edges', size: n * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.hopsG = makeBindGroup(this.device, 'agents-rideHops', this.hopsK.layout, { 46: this.nodesBuf, 47: this.adjBuf, 48: this.hopsBuf, 49: this.params });
    this.rideG = makeBindGroup(this.device, 'agents-ride', this.rideK.layout, { 44: this.units, 45: this.state, 46: this.nodesBuf, 47: this.adjBuf, 48: this.hopsBuf, 49: this.params, 50: this.roads });
    this.netG = makeBindGroup(this.device, 'agents-rideNet', this.netClearK.layout, { 46: this.nodesBuf, 47: this.adjBuf, 48: this.hopsBuf, 49: this.params, 51: this.roads });
    return this.adjBuf;
  }

  /** the hop table (tests: test/gpu/roadride.test.ts reads it) */
  get hopsBuffer(): GPUBuffer {
    return this.hopsBuf;
  }

  /** the graph (the same object again: unchanged) at window offset (ox, oy): whole columns, whole rows (even) */
  setGraph(g: RoadGraph, ox: number, oy: number): void {
    if (nodeCount(g) > MAX_NODES) throw new Error(`ride: ${nodeCount(g)} road nodes, at most ${MAX_NODES}`);
    if (oy % 2) throw new Error(`ride: the graph's row offset ${oy} must be even (the rows' stagger)`);
    this.off = [ox, oy];
    if (g === this.graph) return;
    this.graph = g;
    const n = nodeCount(g);
    const words = new Uint32Array(Math.max(n, 1) * 4);
    const f = new Float32Array(words.buffer);
    for (let v = 0; v < n; v++) {
      f[v * 4] = g.xy[v * 2];
      f[v * 4 + 1] = g.xy[v * 2 + 1];
      words[v * 4 + 2] = g.start[v];
      words[v * 4 + 3] = g.count[v];
    }
    this.device.queue.writeBuffer(this.nodesBuf, 0, words);
    const edges = g.adj.length / 2;
    if (edges > this.adjCap) this.growAdj(Math.max(edges, this.adjCap * 2));
    if (edges) this.device.queue.writeBuffer(this.adjBuf, 0, g.adj);
    this.dirty = true;
  }

  get nodes(): number {
    return nodeCount(this.graph);
  }

  /**
   * Group `g` rides to these goals (the graph's frame), or not (null). False, and it doesn't ride, when there are no
   * roads or a goal has no node within RIDE_NEAR (its last leg would be long and off the roads: a field's work).
   */
  setGoals(g: number, goals: readonly P[] | null): boolean {
    const ok = !!goals && goals.length > 0 && goals.every((p) => nearestNode(this.graph, p[0], p[1]).d <= RIDE_NEAR);
    const next = ok ? goals!.map((p) => [p[0], p[1]] as const) : null;
    const was = this.goals[g];
    const same = was === next || (!!was && !!next && was.length === next.length && was.every((p, i) => p[0] === next[i][0] && p[1] === next[i][1]));
    if (!same) {
      this.goals[g] = next;
      if (this.goals.reduce((a, q) => a + (q?.length ?? 0), 0) > MAX_DESTS) throw new Error(`ride: more than ${MAX_DESTS} goals`);
      this.dirty = true;
    }
    return ok;
  }

  /** groups riding now (a bit each) */
  get riding(): number {
    if (!this.nodes) return 0;
    let m = 0;
    this.goals.forEach((q, g) => (m |= q ? 1 << g : 0));
    return m;
  }

  /** (round 128k) the graph's nodes in window world (x, y): where the road field's seeds are */
  nodePoints(): [number, number][] {
    const out: [number, number][] = [];
    for (let v = 0; v < this.nodes; v++) out.push(this.toWindow([this.graph.xy[v * 2], this.graph.xy[v * 2 + 1]]));
    return out;
  }

  /** every goal of the riding groups (the graph's frame) */
  goalPoints(): P[] {
    return this.goals.flatMap((q) => q ?? []);
  }

  /** the window-world point of a graph-frame point */
  toWindow(p: P): [number, number] {
    return [p[0] + this.off[0], p[1] + this.off[1] * ROW_H];
  }

  private writeParams(units: number): number {
    const b = new ArrayBuffer(RP_BYTES);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    let slots = 0;
    const G0 = 8;
    const D0 = G0 + GROUPS * 4;
    const N0 = D0 + MAX_DESTS * 4;
    this.goals.forEach((q, g) => {
      if (!q || !this.nodes) return;
      u[G0 + g * 4] = slots;
      u[G0 + g * 4 + 1] = q.length;
      for (const p of q) {
        f[D0 + slots * 4] = p[0];
        f[D0 + slots * 4 + 1] = p[1];
        u[N0 + slots] = nearestNode(this.graph, p[0], p[1]).node;
        slots++;
      }
    });
    u.set([this.nodes, slots, units, this.w], 0);
    f.set([this.off[0], this.off[1] * ROW_H, 0, 0], 4);
    this.device.queue.writeBuffer(this.params, 0, b);
    return slots;
  }

  /**
   * The tables made again if the graph or the goals changed, and the network's plane of the road bits (the columns of
   * the edges that lead to a goal: the road field's seeds) if they did or the frame moved (its own pass, before the
   * agents'). True when the tables were made again (the road field's chunks to relax again).
   */
  encodeHops(enc: GPUCommandEncoder, units: number): boolean {
    const slots = this.writeParams(units);
    const moved = !this.netOff || this.netOff[0] !== this.off[0] || this.netOff[1] !== this.off[1];
    if (!this.dirty && !moved) return false;
    const hops = this.dirty;
    this.dirty = false;
    this.netOff = [this.off[0], this.off[1]];
    const words = this.roads.size / 8;
    const pass = enc.beginComputePass({ label: 'agents road hops' });
    if (hops && slots && this.nodes) {
      pass.setBindGroup(0, this.hopsG);
      pass.setPipeline(this.hopsK.pipeline);
      pass.dispatchWorkgroups(slots);
    }
    pass.setBindGroup(0, this.netG);
    pass.setPipeline(this.netClearK.pipeline);
    pass.dispatchWorkgroups(Math.ceil(words / 64));
    if (slots && this.nodes) {
      pass.setPipeline(this.netStampK.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.nodes / 64));
    }
    pass.end();
    // (round 128k: true only when the network changed — a slide restamps the same network where the window put it, and
    // the fields slid with it: relaxing the whole scope again each slide starved the fields while the player panned)
    return hops;
  }

  /** the ride: an agents stage, after the units' step (every tick there are units) */
  encode(pass: GPUComputePassEncoder, units: number): void {
    // (once any group rode, every tick: a unit no longer riding has its steer cleared by the stage itself)
    if (this.riding) this.armed = true;
    if (!units || !this.armed) return;
    pass.setBindGroup(0, this.rideG);
    pass.setPipeline(this.rideK.pipeline);
    pass.dispatchWorkgroups(Math.ceil(units / 64));
  }
}
