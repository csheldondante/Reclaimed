// The node solver's host (src/api/contracts/solver.ts NodeSolver; solver.wgsl the kernel). One GPU constraint solver
// for everything that breaks free (BACKLOG AR4; DECISIONS rounds 106, 120): the CPU only places bodies (their nodes,
// bonds and contact points, uploaded once), passes on impulses and wakes, and reads back each body's summary a tick or
// two late. A sim system of period 1: one tick is a copy (the node snapshot other bodies feel), the pairs pass and the
// solve (one workgroup a body, every substep inside), then the readback.
//
// Its buffers grow with what it holds (the user: no GPU memory caps — sized to the device): slots double when full,
// up to what the device can bind.

import { makeBindGroup, makeCompute, ignoreTeardown, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import solverWgsl from '../shaders/solver.wgsl?raw';
import { dispatch, type SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { TICK_DT } from '../sim/simulation';
import { TUNE, TUNING, worldG } from '../tune/params';
import type { BodyRead, BodySpec, NodeSolver, Q, SolverBody, V3 } from '../api/contracts/solver';
import { buildBody, cellCentre, NN } from './build';
import { kindOf, packSolverMats, solverMat } from './materials';

/** vec4s a body (solver.wgsl BODY_V: its summary, [9..12] erode points, [13..14] neighbours, [15] the game's impulse) */
export const BODY_V = 16;
const ERODE_AT = 9;
const CTL_AT = 15;
/** vec4s a lane (solver.wgsl LANE_V: a node and a contact point) */
export const LANE_V = 8;
const START_SLOTS = 32;

interface Slot extends SolverBody {
  /** impulse queued (cells/s) */
  dv: V3 | null;
}

const qrot = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

export class Solver implements SimSystem, NodeSolver {
  readonly name = 'solver';
  readonly period = 1;
  readonly bodies = new Set<SolverBody>();
  onRead?: (tick: number) => void;
  /** bodies' slots in use (the highest + 1) */
  used = 0;
  capacity = 0;
  /** what the last tick cost to read: bytes */
  stats = { reads: 0, readBytes: 0, grown: 0 };
  /** (the renderer's) called when the draw buffers are replaced (grown) */
  onBuffers?: () => void;

  private slots: (Slot | null)[] = [];
  private nextId = 1;
  private reads = new Map<number, BodyRead>();
  private buf!: Record<'lane' | 'bodies' | 'wake' | 'snap' | 'pose', GPUBuffer>;
  /** (drawCells) the cells drawn as voxels: their buffer, its room, each body's cells (packed as skinCells), the instances */
  private skinCells!: GPUBuffer;
  private skinRoom = 0;
  private skinCount = 0;
  private skinOf = new Map<SolverBody, Uint32Array>();
  private skinDirty = false;
  /** render.wgsl vsBody instances of the drawn cells, and their drawIndirect args (Renderer.addVoxels) */
  skinInst!: GPUBuffer;
  readonly skinArgs: GPUBuffer;
  private uni: GPUBuffer;
  private mats: GPUBuffer;
  private k: Record<string, { k: ComputeKernel; g: GPUBindGroup }> = {};
  private kernels: Record<string, { k: ComputeKernel; spec: BindSpec }> = {};
  private readPool: GPUBuffer[] = [];
  private tick = 0;
  private shiftBy: V3 | null = null;
  private matsDirty = true;
  private dvDirty = false;
  private maxSlots: number;
  private uniData = new Float32Array(24);

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    this.uni = world.buf('solverU', this.uniData.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.mats = world.buf('solverMats', packSolverMats().byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.skinArgs = world.buf('solver skin args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.skinArgs, 0, new Uint32Array([36, 0, 0, 0]));
    // (the deformables' numbers are tuning parameters: re-packed when one moves)
    TUNING.onChange((id) => {
      if (id === null || id.startsWith('solver.')) this.matsDirty = true;
    });
    // the most slots one binding can hold (the pose buffer is the biggest: 4 vec4 a node)
    this.maxSlots = Math.floor(device.limits.maxStorageBufferBindingSize / (NN * 64));
    const parts = [commonWgsl, layersWgsl, materialsWgsl, solverWgsl];
    const base: BindSpec = { 0: 'uniform', 22: 'uniform' };
    const spec: Record<string, BindSpec> = {
      solve: { 1: 'read', 2: 'uniform', 3: 'rw', 9: 'rw', 11: 'read', 13: 'rw', 14: 'read', 15: 'rw', 23: 'uniform' },
      pairs: { 9: 'rw', 13: 'rw' },
      shift: { 3: 'rw', 9: 'rw', 15: 'rw' },
      skin: { 3: 'rw', 9: 'rw', 15: 'rw', 17: 'read', 18: 'rw', 19: 'rw' },
    };
    for (const [entry, s] of Object.entries(spec)) {
      const all = { ...base, ...s };
      this.kernels[entry] = { k: makeCompute(device, `solver-${entry}`, parts, all, entry), spec: all };
    }
    this.growSkin(4096);
    this.alloc(START_SLOTS);
  }

  /** room for this many drawn cells (doubling): the cells' and the instances' buffers made again */
  private growSkin(n: number): void {
    if (n <= this.skinRoom) return;
    let room = Math.max(4096, this.skinRoom);
    while (room < n) room *= 2;
    this.skinCells?.destroy();
    this.skinInst?.destroy();
    this.skinCells = this.world.buf('solver skin cells', room * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.skinInst = this.world.buf('solver skin instances', room * 32, GPUBufferUsage.STORAGE);
    this.skinRoom = room;
    this.skinDirty = true;
    if (this.k.skin) this.bindAll();
    this.onBuffers?.();
  }

  /** the node transforms for the last two ticks (4 vec4 a node: prev pos, prev rot, pos, rot; slot b's nodes at b·64) */
  get pose(): GPUBuffer {
    return this.buf.pose;
  }

  /** the lanes (LANE_V vec4 a node: [6] its bind rest, about the body's rest centre of mass) */
  get lanes(): GPUBuffer {
    return this.buf.lane;
  }

  private alloc(slots: number): void {
    if (slots > this.maxSlots) throw new Error(`solver: ${slots} bodies won't fit one binding on this device (${this.maxSlots})`);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const n = slots * NN;
    const old = this.buf;
    const make = (label: string, bytes: number) => this.world.buf(`solver ${label}`, bytes, S);
    this.buf = {
      lane: make('lanes', n * LANE_V * 16),
      bodies: make('bodies', slots * BODY_V * 16),
      wake: make('wake', slots * 4),
      snap: make('snap', n * LANE_V * 16),
      pose: make('pose', n * 64),
    };
    // new slots start empty (bodies state 0; a slot's lanes are written whole when it's taken)
    if (old) {
      const enc = this.device.createCommandEncoder({ label: 'solver grow' });
      for (const k of Object.keys(old) as (keyof typeof old)[]) enc.copyBufferToBuffer(old[k], 0, this.buf[k], 0, old[k].size);
      this.device.queue.submit([enc.finish()]);
      for (const b of Object.values(old)) b.destroy();
      this.stats.grown++;
    }
    this.capacity = slots;
    while (this.slots.length < slots) this.slots.push(null);
    const res: Record<number, GPUBuffer> = {
      0: this.world.globals,
      1: this.world.chunks,
      2: this.world.materials,
      3: this.buf.lane,
      9: this.buf.bodies,
      11: this.world.layers,
      13: this.buf.wake,
      14: this.buf.snap,
      15: this.buf.pose,
      22: this.uni,
      23: this.mats,
    };
    this.res = res;
    this.bindAll();
    this.readPool = [];
    this.onBuffers?.();
  }

  private res: Record<number, GPUBuffer> = {};
  private bindAll(): void {
    const res: Record<number, GPUBuffer> = { ...this.res, 17: this.skinCells, 18: this.skinInst, 19: this.skinArgs };
    for (const [entry, { k, spec }] of Object.entries(this.kernels)) {
      const g = makeBindGroup(this.device, `solver-${entry}`, k.layout, Object.fromEntries(Object.keys(spec).map((b) => [b, res[Number(b)]])));
      this.k[entry] = { k, g };
    }
  }

  add(spec: BodySpec): SolverBody | null {
    const k0 = spec.kind ?? (spec.cells.length ? kindOf(spec.cells[0].mat) : 'rigid');
    const built = buildBody(spec.cells, spec.pinned, k0 === 'deformable' && spec.cells.length > 16 ? 2 : 1);
    if (!built) return null;
    let s = this.slots.findIndex((x) => x === null);
    if (s < 0 || s >= this.capacity) {
      this.alloc(Math.min(this.maxSlots, this.capacity * 2));
      s = this.slots.findIndex((x) => x === null);
    }
    const kind = spec.kind ?? kindOf(built.mat);
    const body: Slot = { slot: s, id: this.nextId++, restCom: built.com, cells: built.cells, nodes: built.nodes.length, kind, dv: null };
    this.slots[s] = body;
    this.bodies.add(body);
    this.used = Math.max(this.used, s + 1);
    // where it is now: its rest shape moved to `pose` (or where it stood), moving at vel + spin × r
    const q: Q = spec.pose?.q ?? [0, 0, 0, 1];
    const pos: V3 = spec.pose?.pos ?? built.com;
    const vel: V3 = spec.vel ?? [0, 0, 0];
    const spin: V3 = spec.spin ?? [0, 0, 0];
    const n = built.nodes.length;
    const L = new Float32Array(NN * LANE_V * 4);
    const LU = new Uint32Array(L.buffer);
    const pose = new Float32Array(NN * 16);
    for (let i = 0; i < NN; i++) {
      L[(i * LANE_V) * 4 + 3] = -1;
      L[(i * LANE_V + 5) * 4 + 3] = -1;
    }
    for (let i = 0; i < n; i++) {
      const nd = built.nodes[i];
      const r: V3 = [nd.rest[0] - built.com[0], nd.rest[1] - built.com[1], nd.rest[2] - built.com[2]];
      const rr = qrot(q, r);
      const x: V3 = [pos[0] + rr[0], pos[1] + rr[1], pos[2] + rr[2]];
      const v: V3 = [vel[0] + spin[1] * rr[2] - spin[2] * rr[1], vel[1] + spin[2] * rr[0] - spin[0] * rr[2], vel[2] + spin[0] * rr[1] - spin[1] * rr[0]];
      const o4 = i * LANE_V * 4;
      L.set([...x, nd.pinned ? 0 : 1 / nd.mass], o4);
      L.set([...v, nd.mat], o4 + 4);
      // (rest positions about its rest centre of mass: small numbers — summed at world size in f32 its centre came out
      // 1e-5 off every iteration, a drift of 0.01 cells/s a tick)
      L.set([r[0], r[1], r[2], built.g], o4 + 8);
      L.set([r[0], r[1], r[2], nd.cells], o4 + 24);
      L.set([0, 0, 0, 1], o4 + 28);
      L.set(q, o4 + 12);
      LU.set(built.bonds[i], o4 + 16);
      L[o4 + 18] = nd.exposed;
      L[o4 + 19] = nd.foot;
      pose.set([...x, 0, ...q, ...x, 0, ...q], i * 16);
    }
    built.points.forEach((p, k) => L.set([p.rest[0] - built.com[0], p.rest[1] - built.com[1], p.rest[2] - built.com[2], p.node], (k * LANE_V + 5) * 4));
    const B = new Float32Array(BODY_V * 4);
    B.set([n, built.points.length, 1, built.cells], 0);
    B.set([...pos, built.radius], 4);
    B.set([...vel, 0], 8);
    B.set([...spin, TUNE.solver.nodeRadius], 12);
    B.set(q, 16);
    B.set([0, 0, spec.allow ?? 0, 0], 24);
    B.set([0, 1, built.mass, 0], 28);
    B.set([kind === 'rigid' ? 1 : 0, built.nodes.some((nd) => nd.pinned) ? 1 : 0, 0, 0], 32);
    const q0 = this.device.queue;
    const o = s * NN;
    q0.writeBuffer(this.buf.lane, o * LANE_V * 16, L);
    q0.writeBuffer(this.buf.pose, o * 64, pose);
    q0.writeBuffer(this.buf.bodies, s * BODY_V * 16, B);
    q0.writeBuffer(this.buf.wake, s * 4, new Uint32Array([0]));
    if (spec.drawCells) {
      // (its surface cells: their rest about its rest centre of mass, f32 bits; their node's lane | material << 24)
      const list: number[] = [];
      const f = new Float32Array(1);
      const u = new Uint32Array(f.buffer);
      spec.cells.forEach((c, i) => {
        if (!built.surface[i]) return;
        const [cx, cy, cz] = cellCentre(c);
        for (const v of [cx - built.com[0], cy - built.com[1], cz - built.com[2]]) {
          f[0] = v;
          list.push(u[0]);
        }
        list.push(((s * NN + built.cellNode[i]) | ((c.mat & 0xff) << 24)) >>> 0);
      });
      this.skinOf.set(body, new Uint32Array(list));
      this.skinDirty = true;
    }
    return body;
  }

  remove(b: SolverBody): void {
    const s = b.slot;
    if (this.slots[s] !== b) return;
    this.slots[s] = null;
    this.bodies.delete(b);
    this.reads.delete(b.id);
    if (this.skinOf.delete(b)) this.skinDirty = true;
    this.device.queue.writeBuffer(this.buf.bodies, s * BODY_V * 16, new Float32Array([0, 0, 0, 0]));
    while (this.used > 0 && !this.slots[this.used - 1]) this.used--;
  }

  impulse(b: SolverBody, dv: V3): void {
    const s = b as Slot;
    s.dv = s.dv ? [s.dv[0] + dv[0], s.dv[1] + dv[1], s.dv[2] + dv[2]] : dv;
    this.dvDirty = true;
  }

  wake(b: SolverBody): void {
    if (this.slots[b.slot] !== b) return;
    this.device.queue.writeBuffer(this.buf.wake, b.slot * 4, new Uint32Array([1]));
  }

  read(b: SolverBody): BodyRead | undefined {
    return this.reads.get(b.id);
  }

  /** the window slid by (dx, dy, dz) world cells: every body moved back by it */
  shift(dx: number, dy: number, dz: number): void {
    const s = this.shiftBy ?? [0, 0, 0];
    this.shiftBy = [s[0] + dx, s[1] + dy, s[2] + dz];
    for (const r of this.reads.values()) r.pos = [r.pos[0] - dx, r.pos[1] - dy, r.pos[2] - dz];
  }

  private packUniform(): Float32Array {
    const R = TUNE.rigid;
    const S = TUNE.solver;
    const subs = Math.round(S.substeps);
    const h = TICK_DT / subs;
    const u = this.uniData;
    u.set([h, subs, Math.round(S.iterations), this.used], 0);
    u.set([worldG() * R.gravity, R.airDrag, R.slop, R.slopK], 4);
    u.set([R.slopP, R.slopCap, R.pushV, R.erodeDepth], 8);
    u.set([R.restV, R.restT, TICK_DT, S.wakeImpulse], 12);
    u.set([S.friction, S.nodeRadius, this.skinCount, S.blowG], 16);
    u.set([...(this.shiftBy ?? [0, 0, 0]), 0], 20);
    return u;
  }

  encode(enc: GPUCommandEncoder): void {
    this.tick++;
    if (!this.used) return;
    if (this.matsDirty) {
      this.device.queue.writeBuffer(this.mats, 0, packSolverMats());
      this.matsDirty = false;
    }
    // impulses: added to every node's velocity of the body (they're written before this tick's work runs)
    if (this.dvDirty) {
      this.dvDirty = false;
      for (const b of this.slots) {
        if (!b?.dv) continue;
        this.applyImpulse(b, b.dv);
        b.dv = null;
      }
    }
    this.device.queue.writeBuffer(this.uni, 0, this.packUniform());
    if (this.shiftBy) {
      dispatch(enc, this.prof, 'solver-shift', this.k.shift.k, this.k.shift.g, [Math.ceil((this.used * NN) / 64), 1]);
      this.shiftBy = null;
    }
    enc.copyBufferToBuffer(this.buf.lane, 0, this.buf.snap, 0, this.used * NN * LANE_V * 16);
    dispatch(enc, this.prof, 'solver-pairs', this.k.pairs.k, this.k.pairs.g, [Math.ceil(this.used / 64), 1]);
    dispatch(enc, this.prof, 'solver', this.k.solve.k, this.k.solve.g, [this.used, 1]);
    // the drawn cells where their nodes are now
    if (this.skinDirty) {
      this.skinDirty = false;
      let n = 0;
      for (const c of this.skinOf.values()) n += c.length / 4;
      this.growSkin(n);
      const all = new Uint32Array(n * 4);
      let o = 0;
      for (const c of this.skinOf.values()) {
        all.set(c, o);
        o += c.length;
      }
      this.device.queue.writeBuffer(this.skinCells, 0, all);
      this.skinCount = n;
    }
    this.device.queue.writeBuffer(this.skinArgs, 0, new Uint32Array([36, 0, 0, 0]));
    if (this.skinCount) dispatch(enc, this.prof, 'solver-skin', this.k.skin.k, this.k.skin.g, [Math.ceil(this.skinCount / 64), 1]);
    this.readBack(enc);
  }

  /** an impulse: the body's `ctl` (the solve adds it to every node's velocity, wakes the body, and clears it) */
  private applyImpulse(b: Slot, dv: V3): void {
    this.device.queue.writeBuffer(this.buf.bodies, (b.slot * BODY_V + CTL_AT) * 16, new Float32Array([dv[0], dv[1], dv[2], 1]));
  }

  private busy = 0;
  private readBack(enc: GPUCommandEncoder): void {
    // (a pool: a tick's read waits for none before it; at most three in flight)
    if (this.busy >= 3) return;
    const bytesB = this.used * BODY_V * 16;
    const bytesE = 0;
    let rb = this.readPool.pop();
    if (!rb || rb.size < bytesB) {
      rb?.destroy();
      rb = this.device.createBuffer({ label: 'solver read', size: this.capacity * BODY_V * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    enc.copyBufferToBuffer(this.buf.bodies, 0, rb, 0, bytesB);
    const tick = this.tick;
    const used = this.used;
    const buf = rb;
    const live = this.slots.slice(0, used);
    this.busy++;
    // (mapped once the work is submitted: the sim submits this encoder right after the systems encode)
    this.toMap.push(() =>
      buf.mapAsync(GPUMapMode.READ).then(
        () => {
          this.busy--;
          const f = new Float32Array(buf.getMappedRange().slice(0));
          buf.unmap();
          if (this.readPool.length < 4 && buf.size >= this.capacity * BODY_V * 16) this.readPool.push(buf);
          else buf.destroy();
          this.stats.reads++;
          this.stats.readBytes = bytesB + bytesE;
          for (let s = 0; s < used; s++) {
            const b = live[s];
            if (!b || this.slots[s] !== b) continue;
            const o = s * BODY_V * 4;
            if (f[o + 2] === 0) continue;
            const eo = o + ERODE_AT * 4;
            const ne = Math.round(f[o + 28]);
            const erode: V3[] = [];
            for (let k = 0; k < ne; k++) erode.push([f[eo + k * 4], f[eo + k * 4 + 1], f[eo + k * 4 + 2]]);
            const hit = f[o + 20];
            this.reads.set(b.id, {
              tick,
              pos: [f[o + 4], f[o + 5], f[o + 6]],
              q: [f[o + 16], f[o + 17], f[o + 18], f[o + 19]],
              vel: [f[o + 8], f[o + 9], f[o + 10]],
              spin: [f[o + 12], f[o + 13], f[o + 14]],
              asleep: f[o + 2] === 2,
              touching: f[o + 24],
              still: f[o + 11],
              impact: hit > 0 ? { speed: hit, at: [f[o + 21], f[o + 22], f[o + 23]] } : null,
              erode,
              parts: f[o + 29],
              broke: f[o + 31],
              mass: f[o + 30],
            });
          }
          this.onRead?.(tick);
        },
        (e) => {
          this.busy--;
          ignoreTeardown(e);
        },
      ),
    );
  }

  private toMap: (() => void)[] = [];
  /** (Simulation: after the tick's work is submitted) the readbacks mapped */
  afterSubmit(): void {
    for (const f of this.toMap.splice(0)) f();
  }

  /** (tests, tools) every node of a body as it is on the GPU now: positions and rotations */
  async nodes(b: SolverBody): Promise<{ x: V3; q: Q; w: number }[]> {
    const f = new Float32Array(await this.readLanes(b));
    const out: { x: V3; q: Q; w: number }[] = [];
    for (let i = 0; i < b.nodes; i++) {
      const o = i * LANE_V * 4;
      out.push({ x: [f[o], f[o + 1], f[o + 2]], w: f[o + 3], q: [f[o + 12], f[o + 13], f[o + 14], f[o + 15]] });
    }
    return out;
  }

  private async readLanes(b: SolverBody): Promise<ArrayBuffer> {
    const size = NN * LANE_V * 16;
    const rb = this.device.createBuffer({ label: 'solver lanes read', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.buf.lane, b.slot * size, rb, 0, size);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = rb.getMappedRange().slice(0);
    rb.unmap();
    rb.destroy();
    return out;
  }

  /** (tests) a body's bond masks now */
  async rests(b: SolverBody): Promise<V3[]> {
    const f = new Float32Array(await this.readLanes(b));
    const c = b.restCom;
    const out: V3[] = [];
    for (let i = 0; i < b.nodes; i++) {
      const o = (i * LANE_V + 2) * 4;
      out.push([f[o] + c[0], f[o + 1] + c[1], f[o + 2] + c[2]]);
    }
    return out;
  }

  /** (tests) a body's bond masks now */
  async bonds(b: SolverBody): Promise<[number, number][]> {
    const u = new Uint32Array(await this.readLanes(b));
    const out: [number, number][] = [];
    for (let i = 0; i < b.nodes; i++) out.push([u[i * LANE_V * 4 + 16], u[i * LANE_V * 4 + 17]]);
    return out;
  }

  /** what it holds outside the world's buffers (its readback buffers) let go: once the readbacks in flight are in */
  async destroy(): Promise<void> {
    this.slots.fill(null);
    this.bodies.clear();
    this.used = 0;
    while (this.busy > 0) await new Promise((r) => setTimeout(r, 1));
    for (const b of this.readPool) b.destroy();
    this.readPool = [];
  }

  /** a material's numbers (re-exported for tools) */
  static mat = solverMat;
}
