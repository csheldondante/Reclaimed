// The physics engine's host (DESIGN §10; docs/design/PHYSICS_ENGINE.md, build step 1: rigid rows on terrain).
// Bodies are rows in structure-of-arrays GPU buffers (shaders/engine.wgsl has the layouts). The CPU only adds rows,
// queues velocity changes and wakes; it never reads a row back. A tick: `compact` (the rows awake into a list, the
// host's commands taken), then per substep `fine` (each awake row's surface samples against the terrain's columns)
// and `solve` (the contact rules, the move, sleep), then `fold` (what erosion took, onto the ground) — every dispatch
// after `compact` indirect, sized on the GPU by the rows awake or the events written: rows asleep cost nothing.
//
// One baked voxel model a body: its cells where they stood (the spawn frame). Step 1 keeps its surface cells as the
// contact samples and its mass, centre and inertia; body against body, deformation and the resting claim come later.

import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import { physMass } from '../physics/physics';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import engineWgsl from '../shaders/engine.wgsl?raw';
import compactWgsl from '../shaders/engine_compact.wgsl?raw';
import stepWgsl from '../shaders/engine_step.wgsl?raw';
import foldWgsl from '../shaders/engine_fold.wgsl?raw';
import type { SimSystem } from '../sim/system';
import { TICK_DT } from '../sim/flow';
import type { WorldGpu } from '../sim/world-gpu';
import { TUNE } from '../tune/params';
import { cellPos, nbr, NDIR } from '../world/lattice';

export type V3 = [number, number, number];
export type Q = [number, number, number, number];

export interface EngineCell {
  x: number;
  y: number;
  z: number;
  mat: number;
}

export interface EngineSpec {
  /** its cells where they stand (storage column, row, cell z): the spawn frame */
  cells: readonly EngineCell[];
  /** where it is now if not there: its centre of mass, and its rotation (spawn frame -> world) */
  pose?: { pos?: V3; q?: Q };
  vel?: V3;
  spin?: V3;
}

export interface EngineBody {
  readonly row: number;
  /** its cells' centre of mass where they stood */
  readonly restCom: V3;
  readonly cells: number;
  readonly samples: number;
  readonly mass: number;
}

/** bytes a row (engine.wgsl): pose, vel, info */
const POSE_B = 64;
const VEL_B = 32;
const INFO_B = 48;
/** engine.wgsl LIST_AT, EV_AT, EV_WORDS */
const LIST_AT = 8;
const EV_AT = 4;
const EV_WORDS = 8;
/** events a tick the buffer holds (more are counted, not kept: docs/design/PHYSICS_ENGINE.md, limits) */
export const EVENT_ROOM = 1024;
/** commands a tick (engine.wgsl EC) */
const CMDS = 16;
/** the host's commands and the row count go to `compact` through one of these, a tick each: ticks encoded before a
 *  submit each see their own */
const CMD_RING = 4;
const ROW_ALIVE = 1;

/** A body's mass, centre and inverse inertia from its cells, and its surface cells (pure: test/unit/engine-bake.test.ts). */
export function bakeBody(cells: readonly EngineCell[]): {
  com: V3;
  mass: number;
  cellMass: number;
  /** inverse inertia about the centre of mass, the spawn frame: xx, yy, zz, xy, xz, yz */
  invI: [number, number, number, number, number, number];
  /** surface cells about the centre of mass: x, y, z, radius */
  samples: Float32Array;
  radius: number;
  mat: number;
  loose: number;
} {
  const at = new Set<string>();
  for (const c of cells) at.add(`${c.x},${c.y},${c.z}`);
  const mats = new Map<number, number>();
  const pts: V3[] = [];
  const ms: number[] = [];
  let mass = 0;
  const com: V3 = [0, 0, 0];
  for (const c of cells) {
    const [wx, wy] = cellPos(c.x, c.y);
    const m = physMass(c.mat).density;
    pts.push([wx, wy, c.z + 0.5]);
    ms.push(m);
    mass += m;
    com[0] += wx * m;
    com[1] += wy * m;
    com[2] += (c.z + 0.5) * m;
    mats.set(c.mat, (mats.get(c.mat) ?? 0) + 1);
  }
  com[0] /= mass;
  com[1] /= mass;
  com[2] /= mass;
  // (each cell a unit cube's own inertia, m / 6, and its offset's)
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  let radius = 0;
  pts.forEach((p, i) => {
    const m = ms[i];
    const [x, y, z] = [p[0] - com[0], p[1] - com[1], p[2] - com[2]];
    xx += m * (y * y + z * z + 1 / 6);
    yy += m * (x * x + z * z + 1 / 6);
    zz += m * (x * x + y * y + 1 / 6);
    xy -= m * x * y;
    xz -= m * x * z;
    yz -= m * y * z;
    radius = Math.max(radius, Math.hypot(x, y, z) + 0.87);
  });
  // (the symmetric 3 x 3's inverse)
  const det = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
  const invI: [number, number, number, number, number, number] = [
    (yy * zz - yz * yz) / det,
    (xx * zz - xz * xz) / det,
    (xx * yy - xy * xy) / det,
    (xz * yz - xy * zz) / det,
    (xy * yz - xz * yy) / det,
    (xy * xz - xx * yz) / det,
  ];
  const surf: number[] = [];
  cells.forEach((c, i) => {
    let open = !at.has(`${c.x},${c.y},${c.z + 1}`) || !at.has(`${c.x},${c.y},${c.z - 1}`);
    for (let k = 0; k < NDIR && !open; k++) {
      const [nx, ny] = nbr(c.x, c.y, k);
      open = !at.has(`${nx},${ny},${c.z}`);
    }
    if (open) surf.push(pts[i][0] - com[0], pts[i][1] - com[1], pts[i][2] - com[2], 0.5);
  });
  const mat = [...mats].sort((a, b) => b[1] - a[1])[0][0];
  return { com, mass, cellMass: mass / cells.length, invI, samples: new Float32Array(surf), radius, mat, loose: physMass(mat).loose };
}

export class Engine implements SimSystem {
  readonly name = 'engine';
  readonly period = 1;
  /** rows in use (their high-water mark) and the samples' */
  rows = 0;
  samplesUsed = 0;
  private rowRoom = 0;
  private sampleRoom = 0;
  /** the rows' poses (4 vec4 a row: the tick's start, now) — what a body's mesh is drawn by (render/bodymesh.ts) */
  pose!: GPUBuffer;
  private vel!: GPUBuffer;
  private info!: GPUBuffer;
  private samples!: GPUBuffer;
  private contacts!: GPUBuffer;
  /** the rows awake: its head an indirect dispatch's arguments (tests read it) */
  list!: GPUBuffer;
  /** the tick's events (impacts with their energy, erosion): GPU consumers bind it; a test reads it */
  readonly events: GPUBuffer;
  private eu: GPUBuffer[] = [];
  private cu: { eu: GPUBuffer; ec: GPUBuffer }[] = [];
  private k!: { compact: ComputeKernel; fine: ComputeKernel; solve: ComputeKernel; fold: ComputeKernel };
  private g: { compact: GPUBindGroup[]; fine: GPUBindGroup; solve: GPUBindGroup[]; fold: GPUBindGroup } | null = null;
  private cmds: { kind: number; row: number; a: [number, number, number, number] }[] = [];
  private ring = 0;
  readonly bodies = new Set<EngineBody>();
  /** the pose buffer made again (the rows grew): what draws by it binds the new one */
  onBuffers?: () => void;
  /** (tests, the bench) the heightfield fast path of the terrain test, over the panel's switch when set */
  fastPath: boolean | null = null;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    const parts = [commonWgsl, layersWgsl, materialsWgsl, engineWgsl];
    const base: BindSpec = { 0: 'uniform', 2: 'uniform', 3: 'uniform', 16: 'uniform' };
    this.k = {
      compact: makeCompute(device, 'engine-compact', [...parts, compactWgsl], { ...base, 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw' }, 'compact'),
      fine: makeCompute(device, 'engine-fine', [...parts, stepWgsl], { ...base, 1: 'read', 4: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'read', 11: 'read', 12: 'read', 13: 'tex' }, 'fine'),
      solve: makeCompute(device, 'engine-solve', [...parts, stepWgsl], { ...base, 4: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'read', 15: 'rw' }, 'solve'),
      fold: makeCompute(device, 'engine-fold', [...parts, foldWgsl], { ...base, 14: 'rw', 15: 'read' }, 'fold'),
    };
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    // (two for the substeps: the tick's first writes the pose the frame is drawn from)
    this.eu = [world.buf('engine uniform (first substep)', 96, U), world.buf('engine uniform', 96, U)];
    for (let i = 0; i < CMD_RING; i++) this.cu.push({ eu: world.buf('engine uniform (compact)', 96, U), ec: world.buf('engine commands', CMDS * 32, U) });
    this.events = world.buf('engine events', (EV_AT + EVENT_ROOM * EV_WORDS) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.grow(64, 4096);
  }

  /** room for this many rows and samples: the buffers doubled, what they held copied across on the GPU */
  private grow(rows: number, samples: number): void {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const enc = this.device.createCommandEncoder({ label: 'engine grow' });
    const olds: GPUBuffer[] = [];
    const again = (old: GPUBuffer | undefined, label: string, size: number, keep: number, usage = S) => {
      const b = this.world.buf(label, size, usage);
      if (old) {
        if (keep) enc.copyBufferToBuffer(old, 0, b, 0, keep);
        olds.push(old);
      }
      return b;
    };
    if (rows > this.rowRoom) {
      let r = Math.max(64, this.rowRoom);
      while (r < rows) r *= 2;
      this.pose = again(this.pose, 'engine pose', r * POSE_B, this.rows * POSE_B);
      this.vel = again(this.vel, 'engine vel', r * VEL_B, this.rows * VEL_B);
      this.info = again(this.info, 'engine info', r * INFO_B, this.rows * INFO_B);
      this.list = again(this.list, 'engine awake list', (LIST_AT + r) * 4, 0, S | GPUBufferUsage.INDIRECT);
      this.rowRoom = r;
      this.onBuffers?.();
    }
    if (samples > this.sampleRoom) {
      let r = Math.max(4096, this.sampleRoom);
      while (r < samples) r *= 2;
      this.samples = again(this.samples, 'engine samples', r * 16, this.samplesUsed * 16);
      this.contacts = again(this.contacts, 'engine contacts', r * 64, 0);
      this.sampleRoom = r;
    }
    if (!olds.length) return;
    this.device.queue.submit([enc.finish()]);
    // (the old ones go once the copy has run)
    void this.device.queue.onSubmittedWorkDone().then(() => olds.forEach((o) => o.destroy()));
    this.g = null;
  }

  private groups(): NonNullable<Engine['g']> {
    if (this.g) return this.g;
    const w = this.world;
    const d = this.device;
    const common = { 0: w.globals, 2: w.materials };
    const rowsB = { 4: this.pose, 5: this.vel, 6: this.info };
    this.g = {
      compact: this.cu.map((c) => makeBindGroup(d, 'engine-compact', this.k.compact.layout, { ...common, 3: c.eu, 16: c.ec, ...rowsB, 10: this.list })),
      fine: makeBindGroup(d, 'engine-fine', this.k.fine.layout, { ...common, 1: w.chunks, 3: this.eu[1], 16: this.cu[0].ec, 4: this.pose, 6: this.info, 7: this.samples, 8: this.contacts, 10: this.list, 11: w.layers, 12: w.surface, 13: w.driftView }),
      solve: this.eu.map((eu) => makeBindGroup(d, 'engine-solve', this.k.solve.layout, { ...common, 3: eu, 16: this.cu[0].ec, ...rowsB, 7: this.samples, 8: this.contacts, 10: this.list, 15: this.events })),
      fold: makeBindGroup(d, 'engine-fold', this.k.fold.layout, { ...common, 3: this.eu[1], 16: this.cu[0].ec, 14: w.deposit, 15: this.events }),
    };
    return this.g;
  }

  /** A body from its cells: a row. (No cells: null.) */
  add(spec: EngineSpec): EngineBody | null {
    if (!spec.cells.length) return null;
    const b = bakeBody(spec.cells);
    const n = b.samples.length / 4;
    this.grow(this.rows + 1, this.samplesUsed + n);
    const row = this.rows++;
    const first = this.samplesUsed;
    this.samplesUsed += n;
    const pos = spec.pose?.pos ?? b.com;
    const q = spec.pose?.q ?? [0, 0, 0, 1];
    const P = new Float32Array(16);
    P.set([pos[0], pos[1], pos[2], 1 / b.mass, q[0], q[1], q[2], q[3]], 0);
    P.set([pos[0], pos[1], pos[2], 1 / b.mass, q[0], q[1], q[2], q[3]], 8);
    this.device.queue.writeBuffer(this.pose, row * POSE_B, P);
    const v = spec.vel ?? [0, 0, 0];
    const s = spec.spin ?? [0, 0, 0];
    this.device.queue.writeBuffer(this.vel, row * VEL_B, new Float32Array([v[0], v[1], v[2], 0, s[0], s[1], s[2], b.radius]));
    const I = new ArrayBuffer(INFO_B);
    const If = new Float32Array(I);
    const Iu = new Uint32Array(I);
    If.set([b.invI[0], b.invI[1], b.invI[2]], 0);
    Iu[3] = ROW_ALIVE;
    If.set([b.invI[3], b.invI[4], b.invI[5], b.mass], 4);
    Iu[8] = first;
    Iu[9] = n;
    Iu[10] = (b.mat & 255) | ((b.loose & 255) << 8);
    If[11] = b.cellMass;
    this.device.queue.writeBuffer(this.info, row * INFO_B, I);
    this.device.queue.writeBuffer(this.samples, first * 16, b.samples);
    const body: EngineBody = { row, restCom: b.com, cells: spec.cells.length, samples: n, mass: b.mass };
    this.bodies.add(body);
    return body;
  }

  /** a velocity change at the next tick (cells/s): a throw, a blast; it wakes the row */
  impulse(b: EngineBody, dv: V3): void {
    this.cmds.push({ kind: 1, row: b.row, a: [dv[0], dv[1], dv[2], 0] });
  }

  wake(b: EngineBody): void {
    this.cmds.push({ kind: 2, row: b.row, a: [0, 0, 0, 0] });
  }

  /** every row within r of a point wakes (the ground there was cut, something was thrown in) */
  wakeNear(p: V3, r: number): void {
    this.cmds.push({ kind: 3, row: 0, a: [p[0], p[1], p[2], r] });
  }

  /** the window slid: every row moves with it */
  shift(dx: number, dy: number, dz: number): void {
    this.cmds.push({ kind: 4, row: 0, a: [dx, dy, dz, 0] });
  }

  /** every row let go (a level reset) */
  clear(): void {
    this.rows = 0;
    this.samplesUsed = 0;
    this.bodies.clear();
    this.cmds.length = 0;
  }

  /** the step's parameters as a kernel reads them (engine.wgsl EngU) */
  private uniform(first: boolean, cmds: number): ArrayBuffer {
    const T = TUNE.engine;
    const U = new ArrayBuffer(96);
    const f = new Float32Array(U);
    const u = new Uint32Array(U);
    const sub = Math.max(1, Math.round(T.substeps));
    f.set([TICK_DT / sub, T.friction, T.restitution, T.pushV], 0);
    f.set([T.slop, T.slopK, T.slopP, T.slopCap], 4);
    f.set([T.erodeDepth, T.restV, T.restW, T.restT], 8);
    f.set([T.airDrag, T.angDamp, T.stepUp, T.eventEnergy], 12);
    f.set([T.nearGap, EVENT_ROOM, T.groundDamp, 0], 16);
    const fast = this.fastPath ?? T.fastPath >= 0.5;
    u.set([this.rows, cmds, Math.max(1, Math.round(T.passes)), (fast ? 1 : 0) | (first ? 2 : 0)], 20);
    return U;
  }

  encode(enc: GPUCommandEncoder): void {
    if (!this.rows) {
      this.cmds.length = 0;
      return;
    }
    const g = this.groups();
    const q = this.device.queue;
    const take = this.cmds.splice(0, CMDS);
    const C = new ArrayBuffer(CMDS * 32);
    const cf = new Float32Array(C);
    const cuv = new Uint32Array(C);
    take.forEach((c, i) => {
      cf.set(c.a, i * 8);
      cuv[i * 8 + 4] = c.kind;
      cuv[i * 8 + 5] = c.row;
    });
    const ring = this.ring;
    this.ring = (ring + 1) % CMD_RING;
    q.writeBuffer(this.cu[ring].ec, 0, C);
    q.writeBuffer(this.cu[ring].eu, 0, this.uniform(false, take.length));
    q.writeBuffer(this.eu[0], 0, this.uniform(true, 0));
    q.writeBuffer(this.eu[1], 0, this.uniform(false, 0));
    enc.clearBuffer(this.list, 0, LIST_AT * 4);
    enc.clearBuffer(this.events, 0, EV_AT * 4);
    const pass = enc.beginComputePass({ label: 'engine', timestampWrites: this.prof.timestamps('engine') });
    pass.setPipeline(this.k.compact.pipeline);
    pass.setBindGroup(0, g.compact[ring]);
    pass.dispatchWorkgroups(Math.ceil(this.rows / 64));
    const sub = Math.max(1, Math.round(TUNE.engine.substeps));
    for (let s = 0; s < sub; s++) {
      pass.setPipeline(this.k.fine.pipeline);
      pass.setBindGroup(0, g.fine);
      pass.dispatchWorkgroupsIndirect(this.list, 16);
      pass.setPipeline(this.k.solve.pipeline);
      pass.setBindGroup(0, g.solve[s === 0 ? 0 : 1]);
      pass.dispatchWorkgroupsIndirect(this.list, 0);
    }
    pass.setPipeline(this.k.fold.pipeline);
    pass.setBindGroup(0, g.fold);
    pass.dispatchWorkgroupsIndirect(this.events, 0);
    pass.end();
    this.prof.dispatches += 2 + 2 * sub;
  }

  /** (tests only: nothing in play reads a row) the rows' buffers, to read back */
  get debugBuffers(): { pose: GPUBuffer; vel: GPUBuffer; info: GPUBuffer; samples: GPUBuffer; list: GPUBuffer; events: GPUBuffer } {
    return { pose: this.pose, vel: this.vel, info: this.info, samples: this.samples, list: this.list, events: this.events };
  }
}
