// The riders on their routes on the GPU (round 128p, DA-A13; shaders/routes.wgsl says how, agents/routes.ts makes the
// routes). An owner (the fortress) hands its town's RouteNet once a change (its roads laid again) and where its frame
// sits in the window each frame; a group rides to goals (`setGoals`: the stores, the houses, the farms); a unit put in a
// riding group (Agents.regroup) joins the route from the net's node nearest where it was last seen to the group's
// nearest goal — an entry in that route's queue, behind the last to join it — and leaves it when its group changes or
// it's gone. All of that on the CPU, at those events; the GPU only advances the entries (routeAdvance, an agents stage):
// O(riders) a tick, nothing per unit not riding, nothing over the network. Nothing read back.
//
// Transfers (AGENT_RULES 1b; gpu/transfers.ts): a route's points when it's first made (16 B a point; a town's routes a
// few hundred points), an entry when a unit joins or leaves (48 B), the params each tick (32 B).
import commonWgsl from '../shaders/common.wgsl?raw';
import routesWgsl from '../shaders/routes.wgsl?raw';
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import { cellPos } from '../world/lattice';
import { Router, type RouteNet } from './routes';
import { TICK_DT } from '../sim/flow';

type P = readonly [number, number];

/** (agents.ts MAX_GROUPS) */
const GROUPS = 24;
/** (agents.ts MAX_KINDS) */
const KINDS = 8;
/** a goal rides only if a node of the net is this near it (m): its last leg is straight */
export const RIDE_NEAR = 6;
/** the queue's gap: a rider keeps this far behind the one ahead on its route (m) */
export const QUEUE_GAP = 1.1;
const RP_BYTES = 48;

export class RouteRide {
  private k: ComputeKernel;
  private g!: GPUBindGroup;
  private pts: GPUBuffer;
  private ptsCap = 0;
  private ptsUsed = 0;
  private routes: GPUBuffer;
  private routesCap = 0;
  private entries: GPUBuffer;
  private state: GPUBuffer;
  private params: GPUBuffer;
  private router: Router | null = null;
  private net: RouteNet | null = null;
  /** per route made: uploaded yet */
  private uploaded = 0;
  private off: [number, number] = [0, 0];
  private oz = 0;
  /** per group its goals (the net's frame) — kept to set again on a new net */
  private goals: (P[] | null)[] = Array.from({ length: GROUPS }, () => null);
  private kindSpeed = new Float32Array(KINDS);
  /** the entries: per slot of the units its entry (-1 none); per entry its unit slot (-1 free) and route */
  private entryOf: Int32Array;
  private slotOfEntry: number[] = [];
  private routeOfEntry: number[] = [];
  private freeEntries: number[] = [];
  private hwm = 0;
  /** per route its queue: its entries, the last to join last */
  private queues = new Map<number, number[]>();
  private armed = false;
  /** per unit slot its group (-1: none) and where it was last put (window world) — a group that starts riding, or rides
   *  to new goals, takes its units on from there */
  private member: Int16Array;
  private atOf: Float32Array;

  constructor(
    private device: GPUDevice,
    private globals: GPUBuffer,
    private units: GPUBuffer,
    private maxUnits: number,
  ) {
    this.k = makeCompute(device, 'agents-routeAdvance', [commonWgsl, routesWgsl], { 0: 'uniform', 52: 'rw', 53: 'read', 54: 'read', 55: 'rw', 56: 'rw', 57: 'uniform' }, 'routeAdvance');
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.entries = device.createBuffer({ label: 'agents route entries', size: maxUnits * 32, usage: S });
    this.state = device.createBuffer({ label: 'agents route entry state', size: maxUnits * 8, usage: S });
    this.params = device.createBuffer({ label: 'agents route params', size: RP_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.entryOf = new Int32Array(maxUnits).fill(-1);
    this.member = new Int16Array(maxUnits).fill(-1);
    this.atOf = new Float32Array(maxUnits * 2).fill(NaN);
    this.pts = this.grow('pts', 4096);
    this.routes = this.grow('routes', 256);
  }

  private grow(which: 'pts' | 'routes', n: number): GPUBuffer {
    const d = this.device;
    const buf = d.createBuffer({ label: `agents route ${which}`, size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const was = which === 'pts' ? this.pts : this.routes;
    if (was) {
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(was, 0, buf, 0, was.size);
      d.queue.submit([enc.finish()]);
      was.destroy();
    }
    if (which === 'pts') ((this.pts = buf), (this.ptsCap = n));
    else ((this.routes = buf), (this.routesCap = n));
    if (this.pts && this.routes) this.g = makeBindGroup(d, 'agents-routeAdvance', this.k.layout, { 0: this.globals, 52: this.units, 53: this.pts, 54: this.routes, 55: this.entries, 56: this.state, 57: this.params });
    return buf;
  }

  /**
   * The town's net (the same object again: unchanged) and where its frame sits: window offset (ox, oy: whole columns,
   * whole rows, even) and the window's oz. A new net: every route made again, every rider rejoining from where it is.
   */
  setNet(net: RouteNet | null, ox: number, oy: number, oz: number, where: (slot: number) => [number, number] | null): void {
    this.off = [ox, oy];
    this.oz = oz;
    if (net === this.net) return;
    this.net = net;
    this.router = net ? new Router(net, (x, y) => this.zAt(x, y)) : null;
    this.ptsUsed = 0;
    this.uploaded = 0;
    for (let g = 0; g < GROUPS; g++) if (this.goals[g] && this.router) this.router.setGoals(g, this.goals[g], RIDE_NEAR);
    // (the riders on the old routes: each on again from where it was last seen)
    const riders: [number, number][] = [];
    this.slotOfEntry.forEach((s, e) => {
      if (s >= 0) riders.push([s, this.groupOfEntry[e]]);
    });
    for (const [s] of riders) this.leave(s);
    for (const [s, g] of riders) this.join(s, g, where(s));
  }

  /** a point's z (world) by the net's nearest node (a goal's: the ground there) */
  private zAt(x: number, y: number): number {
    const n = this.net;
    if (!n) return 0;
    const v = n.nearest(x, y).node;
    return v >= 0 ? n.xyz[v * 3 + 2] : 0;
  }

  setKindSpeed(k: number, speed: number): void {
    if (k < 0 || k >= KINDS) throw new Error(`routes: kind ${k} out of 0..${KINDS - 1}`);
    this.kindSpeed[k] = speed;
  }

  /**
   * Group `g` rides to these goals (the net's frame), or not (null); false: no net, or a goal off it. Its units on their
   * routes to them from where each was last seen (`where`; else where it was put) — none, if it doesn't ride.
   */
  setGoals(g: number, goals: readonly P[] | null, where: (slot: number) => [number, number] | null): boolean {
    this.goals[g] = goals ? goals.map((p) => [p[0], p[1]] as const) : null;
    const ok = this.router ? this.router.setGoals(g, goals, RIDE_NEAR) : false;
    for (let s = 0; s < this.maxUnits; s++) {
      if (this.member[s] !== g) continue;
      this.leave(s);
      if (ok) this.join(s, g, where(s) ?? this.lastAt(s));
    }
    return ok;
  }

  private lastAt(slot: number): [number, number] | null {
    const x = this.atOf[slot * 2];
    return Number.isFinite(x) ? [x, this.atOf[slot * 2 + 1]] : null;
  }

  /** groups riding now (a bit each) */
  get riding(): number {
    let m = 0;
    for (let g = 0; g < GROUPS; g++) if (this.router?.riding(g)) m |= 1 << g;
    return m;
  }

  get nodes(): number {
    return this.net?.nodes ?? 0;
  }

  /** riders now (entries live) */
  get riders(): number {
    return this.slotOfEntry.filter((s) => s >= 0).length;
  }

  /** routes made (shared: fewer than riders) */
  get routeCount(): number {
    return this.router?.made.length ?? 0;
  }

  goalPoints(): [number, number][] {
    return this.router?.goalPoints() ?? [];
  }

  /** the window-world point of a net-frame point */
  toWindow(p: P): [number, number] {
    const [bx, by] = cellPos(this.off[0], this.off[1]);
    const [zx, zy] = cellPos(0, 0);
    return [p[0] + bx - zx, p[1] + by - zy];
  }

  private fromWindow(p: P): [number, number] {
    const [bx, by] = cellPos(this.off[0], this.off[1]);
    const [zx, zy] = cellPos(0, 0);
    return [p[0] - (bx - zx), p[1] - (by - zy)];
  }

  private groupOfEntry: number[] = [];

  /**
   * Unit `slot` (its kind `kind`) now in group `g`, last seen at window world `at`: on the route from there to the
   * group's nearest goal if the group rides (behind the last to join it), else off any route.
   */
  regroup(slot: number, g: number, kind: number, at: [number, number] | null): void {
    this.leave(slot);
    this.kindOfSlot[slot] = kind;
    this.member[slot] = g;
    if (at) this.atOf.set(at, slot * 2);
    this.join(slot, g, at ?? this.lastAt(slot));
  }

  /** unit `slot` gone (dead, taken out): off its route and out of its group */
  drop(slot: number): void {
    this.leave(slot);
    this.member[slot] = -1;
    this.atOf[slot * 2] = NaN;
  }

  private kindOfSlot = new Uint8Array(65536);

  private join(slot: number, g: number, at: [number, number] | null): void {
    const R = this.router;
    if (!R || !R.riding(g) || !at) return;
    const [x, y] = this.fromWindow(at);
    const r = R.routeFrom(g, x, y);
    if (!r) return;
    this.uploadRoutes();
    const e = this.freeEntries.length ? this.freeEntries.pop()! : this.hwm++;
    const q = this.queues.get(r.route) ?? this.queues.set(r.route, []).get(r.route)!;
    const ahead = q.length ? q[q.length - 1] : -1;
    q.push(e);
    this.entryOf[slot] = e;
    this.slotOfEntry[e] = slot;
    this.routeOfEntry[e] = r.route;
    this.groupOfEntry[e] = g;
    const lead = Math.hypot(r.first[0] - x, r.first[1] - y);
    const d = new Float32Array(8);
    const u = new Uint32Array(d.buffer);
    d[0] = -lead;
    d[1] = this.kindSpeed[this.kindOfSlot[slot] ?? 0] || 1.4;
    u[2] = r.route;
    u[3] = slot;
    d.set([x, y, r.first[2], lead], 4);
    this.device.queue.writeBuffer(this.entries, e * 32, d);
    this.device.queue.writeBuffer(this.state, e * 8, new Uint32Array([ahead < 0 ? 0xffffffff : ahead, 1]));
    this.armed = true;
  }

  /** unit `slot` off its route (its group changed, it's gone) */
  leave(slot: number): void {
    const e = slot < this.entryOf.length ? this.entryOf[slot] : -1;
    if (e < 0) return;
    this.entryOf[slot] = -1;
    const route = this.routeOfEntry[e];
    const q = this.queues.get(route) ?? [];
    const i = q.indexOf(e);
    if (i >= 0) {
      // (the one behind it now follows the one it followed)
      if (i + 1 < q.length) this.device.queue.writeBuffer(this.state, q[i + 1] * 8, new Uint32Array([i > 0 ? q[i - 1] : 0xffffffff]));
      q.splice(i, 1);
    }
    this.slotOfEntry[e] = -1;
    this.routeOfEntry[e] = -1;
    this.device.queue.writeBuffer(this.state, e * 8 + 4, new Uint32Array([0]));
    this.freeEntries.push(e);
  }

  /** the routes made since the last upload into the pool (grown as needed: an error only past the device's limit) */
  private uploadRoutes(): void {
    const R = this.router;
    if (!R) return;
    while (this.uploaded < R.made.length) {
      const id = this.uploaded;
      const p = R.made[id];
      const n = p.xyzl.length / 4;
      if (this.ptsUsed + n > this.ptsCap) this.grow('pts', Math.max(this.ptsCap * 2, this.ptsUsed + n));
      if (id + 1 > this.routesCap) this.grow('routes', this.routesCap * 2);
      this.device.queue.writeBuffer(this.pts, this.ptsUsed * 16, p.xyzl);
      const r = new Uint32Array(4);
      const rf = new Float32Array(r.buffer);
      r.set([this.ptsUsed, n, R.groupOf[id]]);
      rf[3] = p.length;
      this.device.queue.writeBuffer(this.routes, id * 16, r);
      this.ptsUsed += n;
      this.uploaded++;
    }
  }

  /**
   * (round 128p, DA-B22 with DA-A13: advance(route, dt)) The sim time the next advance covers (s): the time since it last
   * ran — the agents set it to the frame's ticks × TICK_DT, the advance running once a frame at fast-forward.
   */
  elapsed = TICK_DT;

  /** the advance: an agents stage, after the units' step, once a frame (the frame's elapsed time: `elapsed`) */
  encode(pass: GPUComputePassEncoder): void {
    if (!this.armed || !this.hwm) return;
    const b = new ArrayBuffer(RP_BYTES);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    u.set([this.hwm, this.maxUnits, 0, 0], 0);
    const [wx, wy] = this.toWindow([0, 0]);
    f.set([wx, wy, this.oz, QUEUE_GAP], 4);
    f[8] = this.elapsed;
    this.device.queue.writeBuffer(this.params, 0, b);
    pass.setBindGroup(0, this.g);
    pass.setPipeline(this.k.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.hwm / 64));
  }
}

