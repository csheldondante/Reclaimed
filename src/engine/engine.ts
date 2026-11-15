// The physics engine's host (DESIGN §10; docs/design/PHYSICS_ENGINE.md, build step 1: rigid rows on terrain).
// Bodies are rows in structure-of-arrays GPU buffers (shaders/engine.wgsl has the layouts). The CPU only adds rows,
// queues velocity changes and wakes; it never reads a row back. A tick: `compact` (the rows awake into a list, the
// host's commands taken), then per substep `fine` (each awake row's surface samples against the terrain's columns)
// and `solve` (the contact rules, the move, sleep), then `fold` (what erosion took, onto the ground) — every dispatch
// after `compact` indirect, sized on the GPU by the rows awake or the events written: rows asleep cost nothing.
//
// One baked voxel model a body: its cells where they stood (the spawn frame). Step 1 keeps its surface cells as the
// contact samples and its mass, centre and inertia; body against body, deformation and the resting claim come later.

import { ignoreTeardown, makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import { packPhysMats, physMass } from '../physics/physics';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import engineWgsl from '../shaders/engine.wgsl?raw';
import compactWgsl from '../shaders/engine_compact.wgsl?raw';
import stepWgsl from '../shaders/engine_step.wgsl?raw';
import foldWgsl from '../shaders/engine_fold.wgsl?raw';
import deformWgsl from '../shaders/engine_deform.wgsl?raw';
import latticeWgsl from '../shaders/engine_lattice.wgsl?raw';
import drawWgsl from '../shaders/engine_draw.wgsl?raw';
import settleWgsl from '../shaders/engine_settle.wgsl?raw';
import type { SimSystem } from '../sim/system';
import { TICK_DT } from '../sim/flow';
import type { WorldGpu } from '../sim/world-gpu';
import { TUNE } from '../tune/params';
import { cellPos, nbr, NDIR } from '../world/lattice';
import { MAT, MAX_MATERIALS } from '../world/materials';

export type V3 = [number, number, number];
export type Q = [number, number, number, number];

export interface EngineCell {
  x: number;
  y: number;
  z: number;
  mat: number;
}

export interface EngineSpec {
  /** its cells where they stand (storage column, row, cell z): the spawn frame — a model of its own is made from them */
  cells?: readonly EngineCell[];
  /** or a model already in the heap (Engine.addModel): shared, nothing uploaded but the row */
  model?: EngineModel;
  /** the mesh of a model made from `cells` (modelmesh.ts) */
  mesh?: (m: { com: V3; lo: V3; dims: V3 }) => Float32Array;
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
  readonly model: EngineModel;
}

/** bytes a row (engine.wgsl): pose, vel, info */
const POSE_B = 64;
const VEL_B = 32;
const INFO_B = 64;
/** engine.wgsl EngU */
const EU_B = 192;
/** engine_deform.wgsl: voxels a page, the pool's header, a slot's record and sums, where the live pages start, a model's header, a mesh vertex (vec4s) */
export const PAGE = 512;
export const POOL_HDR = 64;
export const SLOT_W = 24;
const SUMS_W = 8;
export const DARGS_AT = 16;
export const MODEL_HDR = 4;
export const MESH_V = 3;
/** engine_deform.wgsl DL_AT: where the draw list's triangles start; engine_settle.wgsl OCC_AT */
export const DL_AT = 16;
export const OCC_AT = 4;
/** the pool's header (engine_deform.wgsl P_*) */
export const POOL = { pageTop: 0, pageNext: 1, pageWant: 2, slotTop: 3, slotNext: 4, slotWant: 5, rowTop: 6, rowNext: 7, rowWant: 8, sampNext: 9, sampWant: 10, heapNext: 11, heapWant: 12, failExpand: 13, failSettle: 14, deforming: 15, expands: 16, parts: 17, crumbs: 18, dlWant: 19, dlDirty: 20, settling: 21, hashOver: 22 } as const;
/** ticks between reads of the pool's header */
const STAT_EVERY = 4;
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
/** label passes a tick while a body settles (engine_settle.wgsl labelStep: a label crosses a part in a few) */
const LABEL_PASSES = 8;

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

/** a model's voxels as the heap keeps them (engine_deform.wgsl): its lattice box, a record a cell */
export interface ModelBake {
  lo: V3;
  dims: V3;
  /** 4 floats a lattice cell: its rest place about the centre of mass, then (u32) material | bonds << 6 */
  recs: Float32Array;
  solid: number;
}

/** The lattice box of these cells and a record a cell: rest place about `com`, material, bonds to its 26 neighbours (pure). */
export function bakeModel(cells: readonly EngineCell[], com: V3): ModelBake {
  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
    hi = [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
  }
  const dims: V3 = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const [w, d, h] = dims;
  const mat = new Uint8Array(w * d * h);
  const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= w || y >= d || z >= h ? 0 : mat[x + w * (y + d * z)]);
  for (const c of cells) {
    if (c.mat <= 0 || c.mat > 63) throw new Error(`bakeModel: material ${c.mat} does not fit a model record (1..63)`);
    mat[c.x - lo[0] + w * (c.y - lo[1] + d * (c.z - lo[2]))] = c.mat;
  }
  const recs = new Float32Array(w * d * h * 4);
  const u = new Uint32Array(recs.buffer);
  for (let z = 0; z < h; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) {
        const k = x + w * (y + d * z);
        if (!mat[k]) continue;
        const [wx, wy] = cellPos(lo[0] + x, lo[1] + y);
        recs.set([wx - com[0], wy - com[1], lo[2] + z + 0.5 - com[2]], k * 4);
        // (engine_deform.wgsl n26: every offset in -1..1 but the centre)
        let bits = 0;
        for (let j = 0, kk = 0; j < 27; j++) {
          if (j === 13) continue;
          if (at(x + (j % 3) - 1, y + (Math.floor(j / 3) % 3) - 1, z + Math.floor(j / 9) - 1)) bits |= 1 << kk;
          kk++;
        }
        u[k * 4 + 3] = (mat[k] | (bits << 6)) >>> 0;
      }
  return { lo, dims, recs, solid: cells.length };
}

/** A voxel model in the heap: shared by every row made from it until one deforms (its parts then get their own). */
export interface EngineModel {
  /** its header's heap index */
  readonly id: number;
  readonly cells: number;
  readonly lo: V3;
  readonly dims: V3;
  readonly body: ReturnType<typeof bakeBody>;
  /** its mesh's vertices (0: it draws nothing) */
  readonly verts: number;
}

const pow2 = (n: number, from: number) => {
  let r = from;
  while (r < n) r *= 2;
  return r;
};

interface Dims {
  rows: number;
  pages: number;
  slots: number;
  /** pages a slot's table holds: the biggest model's */
  table: number;
}

/** a buffer in two halves, the host's first then the GPU's (engine.wgsl sAt, hAt) */
interface Halves {
  /** the host's half: in use, room; the GPU's room (its use is the pool header's) */
  used: number;
  cpu: number;
  gpu: number;
}

export class Engine implements SimSystem {
  readonly name = 'engine';
  readonly period = 1;
  /** rows the host has added (they hold the even indices) */
  rows = 0;
  private d: Dims = { rows: 0, pages: 0, slots: 0, table: 1 };
  private samp: Halves = { used: 0, cpu: 0, gpu: 0 };
  /** (heap index 0 is "no model") */
  private hp: Halves = { used: 1, cpu: 0, gpu: 0 };
  /** the rows' poses (4 vec4 a row: the tick's start, now) */
  pose!: GPUBuffer;
  private vel!: GPUBuffer;
  private info!: GPUBuffer;
  private samples!: GPUBuffer;
  private contacts!: GPUBuffer;
  /** the rows awake: its head an indirect dispatch's arguments (tests read it) */
  list!: GPUBuffer;
  /** the tick's events (impacts with their energy, erosion): GPU consumers bind it; a test reads it */
  readonly events: GPUBuffer;
  // build step 2 (engine_deform.wgsl): the allocators, the pages' and slots' records, the dispatch arguments and live
  // pages, models and meshes, the particles
  private pool!: GPUBuffer;
  private dmeta!: GPUBuffer;
  private dargs!: GPUBuffer;
  private heap!: GPUBuffer;
  private px!: GPUBuffer;
  private ps!: GPUBuffer;
  private pw!: GPUBuffer;
  private pb!: GPUBuffer;
  /** the voxel hash among deforming voxels (engine_lattice.wgsl vh): 20 B a voxel of room, all zero between substeps */
  private vh!: GPUBuffer;
  private pm: GPUBuffer;
  private fu!: GPUBuffer;
  // the draw (engine_draw.wgsl): the list of triangles (its head the draw's arguments), and the triangles placed
  private dl!: GPUBuffer;
  private dout!: GPUBuffer;
  private dlRoom = 0;
  /** triangles of the rows the host added */
  private tris = 0;
  /** the bodies' triangles (render.wgsl vsSkin's list) and their draw arguments: one mesh a body in every state */
  get drawOut(): GPUBuffer {
    return this.dout;
  }
  get drawArgs(): GPUBuffer {
    return this.dl;
  }
  private kargs!: GPUBuffer;
  private et: GPUBuffer;
  private ou: GPUBuffer;
  private eu: GPUBuffer[] = [];
  private cu: { eu: GPUBuffer; ec: GPUBuffer }[] = [];
  private k: Record<string, { k: ComputeKernel; spec: BindSpec }> = {};
  private g: Record<string, GPUBindGroup> | null = null;
  private cmds: { kind: number; row: number; a: [number, number, number, number] }[] = [];
  private ring = 0;
  private ticks = 0;
  readonly bodies = new Set<EngineBody>();
  readonly models: EngineModel[] = [];
  /** a buffer made again (it grew): what binds it binds the new one */
  onBuffers?: () => void;
  /** (tests, the bench) the heightfield fast path of the terrain test, over the panel's switch when set */
  fastPath: boolean | null = null;
  /** the pool's header as last read (engine_deform.wgsl P_*; POOL names them): what the GPU has allocated. Read now and
   *  then, never waited for: it only sizes the buffers ahead of need. */
  readonly seen = new Uint32Array(POOL_HDR);
  /** (tests) off: the buffers are not grown ahead, so the GPU's allocations run out */
  growAhead = true;
  private statBuf: GPUBuffer;
  private statBusy = false;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    const parts = [commonWgsl, layersWgsl, materialsWgsl, engineWgsl];
    const base: BindSpec = { 0: 'uniform', 2: 'uniform', 3: 'uniform', 16: 'uniform', 17: 'uniform' };
    const kernel = (name: string, files: string[], spec: BindSpec, entry = name) => {
      const all = { ...base, ...spec };
      this.k[name] = { k: makeCompute(device, `engine-${name}`, [...parts, ...files], all, entry), spec: all };
    };
    kernel('compact', [compactWgsl], { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 12: 'read', 18: 'rw' });
    kernel('fine', [stepWgsl], { 1: 'read', 4: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'read', 11: 'read', 12: 'read', 13: 'tex' });
    kernel('solve', [stepWgsl], { 4: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'read', 12: 'read', 15: 'rw' });
    kernel('fold', [foldWgsl], { 14: 'rw', 15: 'read' });
    kernel('expand', [deformWgsl], { 4: 'rw', 5: 'rw', 6: 'rw', 18: 'rw', 19: 'rw', 22: 'rw', 27: 'read' });
    kernel('arm', [deformWgsl], { 18: 'rw', 37: 'rw' });
    kernel('pagelist', [deformWgsl], { 18: 'rw', 19: 'rw', 20: 'rw' });
    kernel('fill', [deformWgsl], { 19: 'rw', 21: 'read', 22: 'rw', 23: 'rw', 24: 'rw', 25: 'rw', 26: 'rw', 35: 'uniform' });
    kernel('release', [deformWgsl], { 18: 'rw', 19: 'rw' });
    kernel('slots', [deformWgsl], { 4: 'rw', 6: 'rw', 18: 'rw', 19: 'rw' });
    const P4: BindSpec = { 19: 'rw', 21: 'read', 23: 'rw', 24: 'rw', 35: 'uniform' };
    const lat = [deformWgsl, latticeWgsl];
    kernel('predict', lat, P4);
    kernel('region', lat, { ...P4, 25: 'rw', 26: 'rw' });
    kernel('gather', lat, { ...P4, 25: 'rw', 26: 'rw' });
    kernel('vhash', lat, { ...P4, 26: 'rw', 38: 'rw' });
    kernel('collide', lat, { ...P4, 1: 'read', 25: 'rw', 29: 'read', 38: 'rw' });
    kernel('finalize', lat, { ...P4, 25: 'rw', 26: 'rw', 30: 'rw', 31: 'rw' });
    kernel('relax', lat, { ...P4, 25: 'rw', 26: 'rw', 38: 'rw' });
    kernel('deaths', lat, { ...P4, 18: 'rw', 28: 'rw', 30: 'rw', 31: 'rw' });
    kernel('stats', lat, { ...P4, 18: 'rw', 38: 'rw' });
    const drw = [deformWgsl, drawWgsl];
    kernel('drawArm', drw, { 18: 'rw', 32: 'rw', 37: 'rw' });
    kernel('drawlist', drw, { 6: 'rw', 18: 'rw', 22: 'rw', 32: 'rw' });
    kernel('drawlistAsleep', drw, { 6: 'rw', 18: 'rw', 22: 'rw', 32: 'rw' });
    kernel('drawEnd', drw, { 18: 'rw', 32: 'rw', 37: 'rw' });
    kernel('eskinEnd', drw, { 32: 'rw' });
    // letter D: settle (engine_settle.wgsl) — the labels, then a part's numbers, model, mesh and row
    const stl = [deformWgsl, settleWgsl];
    const S4: BindSpec = { 19: 'rw', 21: 'read', 23: 'rw', 25: 'rw' };
    kernel('labelInit', stl, S4);
    kernel('labelStep', stl, { ...S4, 18: 'rw', 26: 'rw' });
    kernel('partScan', stl, { ...S4, 22: 'rw', 24: 'rw', 26: 'rw', 38: 'rw' });
    kernel('partCount', stl, { ...S4, 22: 'rw', 38: 'rw' });
    kernel('triCount', stl, { 6: 'rw', 19: 'rw', 22: 'rw', 23: 'rw', 25: 'rw', 34: 'read', 38: 'rw' });
    kernel('partAlloc', stl, { ...S4, 18: 'rw', 22: 'rw', 24: 'rw', 38: 'rw' });
    kernel('partSamples', stl, { ...S4, 7: 'rw', 38: 'rw' });
    kernel('partFaces', stl, { ...S4, 22: 'rw', 24: 'rw', 38: 'rw' });
    kernel('triWrite', stl, { 6: 'rw', 19: 'rw', 22: 'rw', 23: 'rw', 24: 'rw', 25: 'rw', 34: 'read', 38: 'rw' });
    kernel('partRecs', stl, { ...S4, 18: 'rw', 22: 'rw', 24: 'rw', 26: 'rw' });
    kernel('partRow', stl, { ...S4, 4: 'rw', 5: 'rw', 6: 'rw', 24: 'rw' });
    kernel('occupancy', stl, { 6: 'rw', 22: 'rw', 39: 'rw' });
    kernel('eskin', drw, { 4: 'rw', 6: 'rw', 19: 'rw', 22: 'rw', 23: 'rw', 24: 'rw', 33: 'rw', 34: 'read', 36: 'uniform' });
    this.kargs = world.buf('engine kernel dispatch', 64, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    // (two for the substeps: the tick's first writes the pose the frame is drawn from)
    this.eu = [world.buf('engine uniform (first substep)', EU_B, U), world.buf('engine uniform', EU_B, U)];
    for (let i = 0; i < CMD_RING; i++) this.cu.push({ eu: world.buf('engine uniform (compact)', EU_B, U), ec: world.buf('engine commands', CMDS * 32, U) });
    this.events = world.buf('engine events', (EV_AT + EVENT_ROOM * EV_WORDS) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.pm = world.buf('engine lattice materials', MAX_MATERIALS * 64, U);
    device.queue.writeBuffer(this.pm, 0, packPhysMats());
    this.et = world.buf('engine expand thresholds', 192, U);
    this.fu = world.buf('engine draw uniform', 16, U);
    this.ou = world.buf('engine uniform (occupancy)', EU_B, U);
    this.statBuf = world.buf('engine pool header read', POOL_HDR * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    this.resize({ rows: 64, pages: 16, slots: 16, table: 1 });
    this.drawRoom(4096);
    this.samp = { used: 0, cpu: 4096, gpu: 1024 };
    this.samples = this.halves(undefined, 'engine samples', 16, this.samp, 4096, 1024);
    this.contacts = this.halves(undefined, 'engine contacts', 64, this.samp, 4096, 1024);
    this.hp = { used: 1, cpu: 4096, gpu: 4096 };
    this.heap = this.halves(undefined, 'engine heap', 16, this.hp, 4096, 4096);
  }

  private olds: GPUBuffer[] = [];
  /** the buffers that grew are let go once what was copied out of them has run */
  private retire(enc?: GPUCommandEncoder): void {
    if (enc) this.device.queue.submit([enc.finish()]);
    const olds = this.olds.splice(0);
    if (olds.length) void this.device.queue.onSubmittedWorkDone().then(() => olds.forEach((o) => o.destroy()));
    this.g = null;
    this.onBuffers?.();
  }

  /**
   * A two-halves buffer made again with these rooms: the host's half copied where it was, the GPU's whole half to
   * where the new one starts.
   */
  private halves(old: GPUBuffer | undefined, label: string, stride: number, was: Halves, cpu: number, gpu: number, keep = true): GPUBuffer {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const b = this.world.buf(label, (cpu + gpu) * stride, S);
    if (old) {
      const enc = this.device.createCommandEncoder({ label: 'engine grow' });
      if (keep && was.used) enc.copyBufferToBuffer(old, 0, b, 0, was.used * stride);
      if (keep && was.gpu) enc.copyBufferToBuffer(old, was.cpu * stride, b, cpu * stride, was.gpu * stride);
      this.device.queue.submit([enc.finish()]);
      this.olds.push(old);
    }
    return b;
  }

  /** room in the samples and the heap: each half doubled till it holds what is asked */
  private room(sampCpu: number, sampGpu: number, heapCpu: number, heapGpu: number): void {
    const s = this.samp;
    if (sampCpu > s.cpu || sampGpu > s.gpu) {
      const cpu = pow2(sampCpu, s.cpu);
      const gpu = pow2(sampGpu, s.gpu);
      this.samples = this.halves(this.samples, 'engine samples', 16, s, cpu, gpu);
      this.contacts = this.halves(this.contacts, 'engine contacts', 64, s, cpu, gpu, false);
      this.samp = { used: s.used, cpu, gpu };
      this.retire();
    }
    const h = this.hp;
    if (heapCpu > h.cpu || heapGpu > h.gpu) {
      const cpu = pow2(heapCpu, h.cpu);
      const gpu = pow2(heapGpu, h.gpu);
      this.heap = this.halves(this.heap, 'engine heap', 16, h, cpu, gpu);
      this.hp = { used: h.used, cpu, gpu };
      this.retire();
    }
  }

  /** room for this many triangles in the draw list (made again by the GPU at the next tick) */
  private drawRoom(tris: number): void {
    if (tris <= this.dlRoom) return;
    const room = pow2(tris, Math.max(4096, this.dlRoom));
    if (this.dl) this.olds.push(this.dl, this.dout);
    this.dl = this.world.buf('engine draw list', (DL_AT + 2 * room) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.device.queue.writeBuffer(this.dl, 0, new Uint32Array([0, 1, 0, 0]));
    this.dout = this.world.buf('engine draw triangles', room * 96, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.dlRoom = room;
    if (this.pool) this.dirtyDraw();
    this.retire();
  }

  /** where the pool's and dmeta's parts start, by the rooms (engine.wgsl EU.h, EU.i) */
  private static layout(d: Dims) {
    const pageStack = POOL_HDR;
    const slotStack = pageStack + d.pages;
    const rowStack = slotStack + d.slots;
    const sums = rowStack + d.rows / 2;
    const slotRec = 2 * d.pages;
    const tables = slotRec + SLOT_W * d.slots;
    return { pageStack, slotStack, rowStack, sums, pool: sums + SUMS_W * d.slots, pageInfo: 0, slotRec, tables, dmeta: tables + d.slots * d.table };
  }

  /**
   * The rows, pages, slots and page tables given this room: the buffers that change made again at the new size and
   * what they held copied across on the GPU (rows and particles whole — the host doesn't know which the GPU made).
   */
  private resize(n: Dims): void {
    const o = this.d;
    if (n.rows === o.rows && n.pages === o.pages && n.slots === o.slots && n.table === o.table) return;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const enc = this.device.createCommandEncoder({ label: 'engine grow' });
    const again = (old: GPUBuffer | undefined, label: string, size: number, keep: number, usage = S) => {
      const b = this.world.buf(label, size, usage);
      if (old) {
        if (keep) enc.copyBufferToBuffer(old, 0, b, 0, keep);
        this.olds.push(old);
      }
      return b;
    };
    if (n.rows !== o.rows) {
      this.pose = again(this.pose, 'engine pose', n.rows * POSE_B, o.rows * POSE_B);
      this.vel = again(this.vel, 'engine vel', n.rows * VEL_B, o.rows * VEL_B);
      this.info = again(this.info, 'engine info', n.rows * INFO_B, o.rows * INFO_B);
      this.list = again(this.list, 'engine awake list', (LIST_AT + n.rows) * 4, 0, S | GPUBufferUsage.INDIRECT);
    }
    if (n.pages !== o.pages) {
      const v = n.pages * PAGE;
      const ov = o.pages * PAGE;
      this.px = again(this.px, 'engine particles (place)', v * 32, ov * 32);
      this.ps = again(this.ps, 'engine particles (state)', v * 48, ov * 48);
      this.pw = again(this.pw, 'engine particles (work)', v * 48, ov * 48);
      this.pb = again(this.pb, 'engine particles (bonds)', v * 4, ov * 4);
      // (empty between substeps, so a grown one starts empty: nothing copied)
      this.vh = again(this.vh, 'engine voxel hash', (4 + 5 * v) * 4, 0);
      this.dargs = again(this.dargs, 'engine deform dispatch', (DARGS_AT + n.pages) * 4, DARGS_AT * 4, S | GPUBufferUsage.INDIRECT);
    }
    const lo = Engine.layout(o);
    const ln = Engine.layout(n);
    const pool = this.world.buf('engine pool', ln.pool * 4, S);
    const dmeta = this.world.buf('engine deform records', ln.dmeta * 4, S);
    if (this.pool) {
      const cp = (src: GPUBuffer, dst: GPUBuffer, from: number, to: number, words: number) => {
        if (words) enc.copyBufferToBuffer(src, from * 4, dst, to * 4, words * 4);
      };
      cp(this.pool, pool, 0, 0, POOL_HDR);
      cp(this.pool, pool, lo.pageStack, ln.pageStack, o.pages);
      cp(this.pool, pool, lo.slotStack, ln.slotStack, o.slots);
      cp(this.pool, pool, lo.rowStack, ln.rowStack, o.rows / 2);
      cp(this.pool, pool, lo.sums, ln.sums, SUMS_W * o.slots);
      cp(this.dmeta, dmeta, lo.pageInfo, ln.pageInfo, 2 * o.pages);
      cp(this.dmeta, dmeta, lo.slotRec, ln.slotRec, SLOT_W * o.slots);
      // (a slot's table keeps its place in the slot: wider tables, each copied to its new start)
      if (n.table === o.table) cp(this.dmeta, dmeta, lo.tables, ln.tables, o.slots * o.table);
      else for (let s = 0; s < o.slots; s++) cp(this.dmeta, dmeta, lo.tables + s * o.table, ln.tables + s * n.table, o.table);
      this.olds.push(this.pool, this.dmeta);
    }
    this.pool = pool;
    this.dmeta = dmeta;
    this.d = { ...n };
    this.retire(enc);
  }

  private groups(): Record<string, GPUBindGroup> {
    if (this.g) return this.g;
    const w = this.world;
    const res: Record<number, GPUBuffer | GPUTextureView> = {
      0: w.globals, 1: w.chunks, 2: w.materials, 3: this.eu[1], 16: this.cu[0].ec, 17: this.et,
      4: this.pose, 5: this.vel, 6: this.info, 7: this.samples, 8: this.contacts, 10: this.list, 11: w.layers, 12: w.surface, 13: w.driftView, 14: w.deposit, 15: this.events,
      18: this.pool, 19: this.dmeta, 20: this.dargs, 21: this.dargs, 22: this.heap, 23: this.px, 24: this.ps, 25: this.pw, 26: this.pb, 27: this.list, 28: this.events, 29: w.layers, 30: w.particles, 31: w.particleCounters, 32: this.dl, 33: this.dout, 34: this.dl, 35: this.pm, 36: this.fu, 37: this.kargs, 38: this.vh,
    };
    const make = (name: string, over: Record<number, GPUBuffer> = {}) => {
      const { k, spec } = this.k[name];
      return makeBindGroup(this.device, `engine-${name}`, k.layout, Object.fromEntries(Object.keys(spec).map((b) => [b, over[Number(b)] ?? res[Number(b)]])));
    };
    const g: Record<string, GPUBindGroup> = {};
    for (const name of Object.keys(this.k)) if (name !== 'occupancy') g[name] = make(name);
    this.cu.forEach((c, i) => (g[`compact${i}`] = make('compact', { 3: c.eu, 16: c.ec })));
    this.cu.forEach((c, i) => (g[`slots${i}`] = make('slots', { 3: c.eu, 16: c.ec })));
    g.solve0 = make('solve', { 3: this.eu[0] });
    this.g = g;
    return g;
  }

  /** A voxel model into the heap, with its mesh (modelmesh.ts; none: it draws nothing). Rows made from it share it. */
  addModel(cells: readonly EngineCell[], mesh?: (m: { com: V3; lo: V3; dims: V3 }) => Float32Array): EngineModel {
    if (!cells.length) throw new Error('Engine.addModel: no cells');
    const body = bakeBody(cells);
    const mb = bakeModel(cells, body.com);
    const mv = mesh?.({ com: body.com, lo: mb.lo, dims: mb.dims }) ?? new Float32Array(0);
    const verts = mv.length / (MESH_V * 4);
    const n = MODEL_HDR + mb.recs.length / 4 + verts * MESH_V;
    this.room(0, 0, this.hp.used + n, 0);
    const id = this.hp.used;
    this.hp.used += n;
    const H = new ArrayBuffer(MODEL_HDR * 16);
    const hu = new Uint32Array(H);
    const hf = new Float32Array(H);
    // (the parity of its box's first row: the hex lattice's odd rows sit half a cell right — settle's break faces find
    // a cell's six neighbours by it; its lattice's frame: the rest frame's own)
    hu.set([mb.dims[0], mb.dims[1], mb.dims[2], mb.solid, id + MODEL_HDR + mb.recs.length / 4, verts, (body.mat & 255) | ((body.loose & 255) << 8), mb.lo[1] & 1]);
    hf.set([body.cellMass, body.radius], 8);
    hf.set([0, 0, 0, 1], 12);
    const q = this.device.queue;
    q.writeBuffer(this.heap, id * 16, H);
    q.writeBuffer(this.heap, (id + MODEL_HDR) * 16, mb.recs);
    if (verts) q.writeBuffer(this.heap, (id + MODEL_HDR + mb.recs.length / 4) * 16, mv);
    // (a slot's page table holds the biggest model's pages)
    const pages = Math.ceil((mb.dims[0] * mb.dims[1] * mb.dims[2]) / PAGE);
    if (pages > this.d.table) this.resize({ ...this.d, table: pow2(pages, this.d.table) });
    const m: EngineModel = { id, cells: cells.length, lo: mb.lo, dims: mb.dims, body, verts };
    this.models.push(m);
    return m;
  }

  /** A body: a row (an even index) of a model — its own from `cells`, or one shared. (No cells: null.) */
  add(spec: EngineSpec): EngineBody | null {
    if (!spec.model && !spec.cells?.length) return null;
    const model = spec.model ?? this.addModel(spec.cells!, spec.mesh);
    const b = model.body;
    const n = b.samples.length / 4;
    if (2 * (this.rows + 1) > this.d.rows) this.resize({ ...this.d, rows: pow2(2 * (this.rows + 1), this.d.rows) });
    this.room(this.samp.used + n, 0, 0, 0);
    const row = 2 * this.rows++;
    const first = this.samp.used;
    this.samp.used += n;
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
    Iu[12] = model.id;
    this.device.queue.writeBuffer(this.info, row * INFO_B, I);
    this.device.queue.writeBuffer(this.samples, first * 16, b.samples);
    this.tris += model.verts / 3;
    this.drawRoom(2 * this.tris);
    this.dirtyDraw();
    const body: EngineBody = { row, restCom: b.com, cells: model.cells, samples: n, mass: b.mass, model };
    this.bodies.add(body);
    return body;
  }

  /** the draw list is made again at the next tick (a row came) */
  private dirtyDraw(): void {
    this.device.queue.writeBuffer(this.pool, POOL.dlDirty * 4, new Uint32Array([1]));
  }

  /** a velocity change at the next tick (cells/s): a throw, a blast; it wakes the row */
  impulse(b: { row: number }, dv: V3): void {
    this.cmds.push({ kind: 1, row: b.row, a: [dv[0], dv[1], dv[2], 0] });
  }

  wake(b: { row: number }): void {
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

  /** the row deforms at the next tick whatever hits it (a lab's button, a test): its particles are made as an impact's are */
  expand(b: { row: number }): void {
    this.cmds.push({ kind: 5, row: b.row, a: [0, 0, 0, 0] });
  }

  /** a deforming body let go — its pages back to the pool, its row freed — or with none named, every one */
  release(b?: { row: number }): void {
    this.cmds.push({ kind: 6, row: b ? b.row : 0xffffffff, a: [0, 0, 0, 0] });
  }

  /** every row, model and particle let go (a level reset) */
  clear(): void {
    this.rows = 0;
    this.tris = 0;
    this.samp.used = 0;
    this.hp.used = 1;
    this.bodies.clear();
    this.models.length = 0;
    this.cmds.length = 0;
    this.seen.fill(0);
    const enc = this.device.createCommandEncoder({ label: 'engine clear' });
    for (const b of [this.info, this.pool, this.dmeta, this.dargs, this.kargs]) enc.clearBuffer(b);
    enc.clearBuffer(this.dl, 0, DL_AT * 4);
    this.device.queue.submit([enc.finish()]);
  }

  /** the step's parameters as a kernel reads them (engine.wgsl EngU) */
  private uniform(first: boolean, cmds: number): ArrayBuffer {
    const T = TUNE.engine;
    const U = new ArrayBuffer(EU_B);
    const f = new Float32Array(U);
    const u = new Uint32Array(U);
    const sub = Math.max(1, Math.round(T.substeps));
    f.set([TICK_DT / sub, T.friction, T.restitution, T.pushV], 0);
    f.set([T.slop, T.slopK, T.slopP, T.slopCap], 4);
    f.set([T.erodeDepth, T.restV, T.restW, T.restT], 8);
    f.set([T.airDrag, T.angDamp, T.stepUp, T.eventEnergy], 12);
    f.set([T.nearGap, EVENT_ROOM, T.groundDamp, T.breakRough], 16);
    const fast = this.fastPath ?? T.fastPath >= 0.5;
    const d = this.d;
    const L = Engine.layout(d);
    u.set([d.rows, cmds, Math.max(1, Math.round(T.passes)), (fast ? 1 : 0) | (first ? 2 : 0) | (T.deform >= 0.5 ? 4 : 0) | (this.settles ? 8 : 0)], 20);
    u.set([d.pages, d.slots, d.table, this.ticks], 24);
    u.set([L.pageStack, L.slotStack, L.rowStack, L.sums], 28);
    u.set([L.pageInfo, L.slotRec, L.tables, this.dlRoom], 32);
    u.set([this.samp.cpu, this.samp.gpu, this.hp.cpu, this.hp.gpu], 36);
    const lsub = Math.max(1, Math.round(T.latticeSubsteps));
    f.set([T.stillV, T.stillT, T.crumb, TICK_DT / lsub], 40);
    u.set([Math.max(1, Math.round(T.latticeIters)), 0, lsub, 0], 44);
    f[45] = T.breakSmooth;
    return U;
  }

  /** the pool's header, read now and then (256 B, never waited for), then the buffers grown ahead of what it shows */
  private watch(): void {
    if (!this.statBusy && this.ticks % STAT_EVERY === 0) {
      this.statBusy = true;
      const enc = this.device.createCommandEncoder({ label: 'engine pool header' });
      enc.copyBufferToBuffer(this.pool, 0, this.statBuf, 0, POOL_HDR * 4);
      this.device.queue.submit([enc.finish()]);
      this.statBuf.mapAsync(GPUMapMode.READ).then(() => {
        this.seen.set(new Uint32Array(this.statBuf.getMappedRange()));
        this.statBuf.unmap();
        this.statBusy = false;
      }, ignoreTeardown);
    }
    if (this.growAhead) this.ahead();
  }

  /** Room for twice what the GPU has asked for so far (engine_deform.wgsl: its `want` counters), so it rarely runs out. */
  private ahead(): void {
    const s = this.seen;
    const d = this.d;
    const n: Dims = { ...d };
    if (2 * s[POOL.pageWant] > d.pages) n.pages = pow2(2 * s[POOL.pageWant], d.pages);
    if (2 * s[POOL.slotWant] > d.slots) n.slots = pow2(2 * s[POOL.slotWant], d.slots);
    // (the GPU's rows are the odd ones: g of them reach row 2g)
    if (4 * s[POOL.rowWant] > d.rows) n.rows = pow2(4 * s[POOL.rowWant], d.rows);
    this.resize(n);
    this.room(0, 2 * s[POOL.sampWant], 0, 2 * s[POOL.heapWant]);
    this.drawRoom(2 * s[POOL.dlWant]);
  }

  /** (tests) the header read now, and the buffers grown by it */
  async readPool(): Promise<Uint32Array> {
    const tmp = this.device.createBuffer({ size: POOL_HDR * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.pool, 0, tmp, 0, POOL_HDR * 4);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    this.seen.set(new Uint32Array(tmp.getMappedRange()));
    tmp.destroy();
    return this.seen;
  }

  private thresholds(): Float32Array {
    const T = TUNE.engine;
    const E = new Float32Array(48).fill(T.expandRock);
    E[MAT.Concrete] = T.expandConcrete;
    E[MAT.Brick] = T.expandBrick;
    E[MAT.Steel] = T.expandSteel;
    E[MAT.Rust] = T.expandSteel;
    E[MAT.Wood] = T.expandWood;
    return E;
  }

  encode(enc: GPUCommandEncoder): void {
    if (!this.rows) {
      this.cmds.length = 0;
      return;
    }
    this.ticks++;
    this.watch();
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
    q.writeBuffer(this.et, 0, this.thresholds());
    enc.clearBuffer(this.list, 0, LIST_AT * 4);
    enc.clearBuffer(this.events, 0, EV_AT * 4);
    enc.clearBuffer(this.dargs, 0, 32);
    // (`timeKernels`: a pass a kernel, each with its own timestamps — what a tick is made of; else one pass)
    const cur = { pass: enc.beginComputePass({ label: 'engine', timestampWrites: this.prof.timestamps('engine') }) };
    const run = (name: string, group = name) => {
      if (this.timeKernels) {
        cur.pass.end();
        cur.pass = enc.beginComputePass({ label: `engine ${name}`, timestampWrites: this.prof.timestamps(`engine:${name}`) });
      }
      const pass = cur.pass;
      pass.setPipeline(this.k[name].k.pipeline);
      pass.setBindGroup(0, g[group]);
      this.prof.dispatches++;
    };
    run('compact', `compact${ring}`);
    cur.pass.dispatchWorkgroups(Math.ceil(this.d.rows / 64));
    const sub = Math.max(1, Math.round(TUNE.engine.substeps));
    for (let s = 0; s < sub; s++) {
      run('fine');
      cur.pass.dispatchWorkgroupsIndirect(this.list, 16);
      run('solve', s === 0 ? 'solve0' : 'solve');
      cur.pass.dispatchWorkgroupsIndirect(this.list, 0);
    }
    if (TUNE.engine.deform >= 0.5) {
      // build step 2: rows into particles (the rows awake), the live pages listed and the new ones filled — the
      // per-page and per-slot kernels dispatched from the GPU's own count: nothing deforming, no workgroups
      run('expand');
      cur.pass.dispatchWorkgroupsIndirect(this.list, 0);
      run('arm');
      cur.pass.dispatchWorkgroups(1);
      run('pagelist');
      cur.pass.dispatchWorkgroupsIndirect(this.kargs, 0);
      run('fill');
      cur.pass.dispatchWorkgroupsIndirect(this.dargs, 0);
      this.deform(cur, run);
      run('release');
      cur.pass.dispatchWorkgroupsIndirect(this.kargs, 0);
      run('slots', `slots${ring}`);
      cur.pass.dispatchWorkgroupsIndirect(this.kargs, 16);
    }
    run('fold');
    cur.pass.dispatchWorkgroupsIndirect(this.events, 0);
    // the draw list, made again by the GPU only when a row came or went
    run('drawArm');
    cur.pass.dispatchWorkgroups(1);
    run('drawlist');
    cur.pass.dispatchWorkgroupsIndirect(this.kargs, 32);
    run('drawlistAsleep');
    cur.pass.dispatchWorkgroupsIndirect(this.kargs, 32);
    run('drawEnd');
    cur.pass.dispatchWorkgroups(1);
    cur.pass.end();
  }

  /**
   * The frame's draw: every listed triangle placed (a thread a triangle, dispatched by the list's own count) — a rigid
   * row's by its pose between the tick's start and now (alpha), a deforming body's by the voxels its vertices are
   * weighted to.
   */
  skin(enc: GPUCommandEncoder, alpha: number): void {
    if (!this.rows) return;
    this.device.queue.writeBuffer(this.fu, 0, new Float32Array([alpha, 0, 0, 0]));
    const pass = enc.beginComputePass({ label: 'engine skin', timestampWrites: this.prof.timestamps('engine-skin') });
    pass.setPipeline(this.k.eskin.k.pipeline);
    pass.setBindGroup(0, this.groups().eskin);
    pass.dispatchWorkgroupsIndirect(this.dl, 16);
    // (the list has been placed whole: from the next frame only the rows awake are — engine_draw.wgsl)
    pass.setPipeline(this.k.eskinEnd.k.pipeline);
    pass.setBindGroup(0, this.groups().eskinEnd);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.prof.dispatches += 2;
  }

  /** the lattice's substeps over the live pages, then the settling bodies' labels and parts (later letters of step 2) */
  private deform(cur: { pass: GPUComputePassEncoder }, run: (name: string, group?: string) => void): void {
    const T = TUNE.engine;
    const each = (name: string) => {
      run(name);
      cur.pass.dispatchWorkgroupsIndirect(this.dargs, 0);
    };
    const sub = this.holdLattice ? 0 : Math.max(1, Math.round(T.latticeSubsteps));
    const iters = Math.max(1, Math.round(T.latticeIters));
    for (let s = 0; s < sub; s++) {
      each('predict');
      for (let i = 0; i < iters; i++) {
        each('region');
        each('gather');
      }
      if (this.voxelHash) each('vhash');
      each('collide');
      each('finalize');
      each('relax');
      each('deaths');
    }
    each('stats');
    if (!this.settles) return;
    // settle (engine_settle.wgsl): over the live pages only while a body settles (dargs[4], the GPU's count); the two
    // mesh kernels over the draw list (dl[12], zero otherwise)
    const settle = (name: string) => {
      run(name);
      cur.pass.dispatchWorkgroupsIndirect(this.dargs, 16);
    };
    const tris = (name: string) => {
      run(name);
      cur.pass.dispatchWorkgroupsIndirect(this.dl, 48);
    };
    settle('labelInit');
    for (let i = 0; i < LABEL_PASSES; i++) settle('labelStep');
    settle('partScan');
    settle('partCount');
    tris('triCount');
    settle('partAlloc');
    settle('partSamples');
    settle('partFaces');
    tris('triWrite');
    settle('partRecs');
    settle('partRow');
  }

  /**
   * For the collision branch (body against body, PE3): a row's occupancy at its model's resolution into `out` (u32:
   * its lattice box, its voxels, then a word a lattice cell from OCC_AT — its material, 0 none), for an SDF bake to
   * take. A thread a cell, as many as `out` holds; the host need not know the row's model (a row the GPU made).
   */
  occupancy(enc: GPUCommandEncoder, row: number, out: GPUBuffer): void {
    const U = this.uniform(false, 0);
    const u = new Uint32Array(U);
    const cells = out.size / 4 - OCC_AT;
    u[27] = row;
    u[35] = cells;
    this.device.queue.writeBuffer(this.ou, 0, U);
    const { k, spec } = this.k.occupancy;
    const res: Record<number, GPUBuffer> = { 0: this.world.globals, 2: this.world.materials, 3: this.ou, 16: this.cu[0].ec, 17: this.et, 6: this.info, 22: this.heap, 39: out };
    const pass = enc.beginComputePass({ label: 'engine occupancy' });
    pass.setPipeline(k.pipeline);
    pass.setBindGroup(0, makeBindGroup(this.device, 'engine-occupancy', k.layout, Object.fromEntries(Object.keys(spec).map((b) => [b, res[Number(b)]]))));
    pass.dispatchWorkgroups(Math.ceil(cells / 64));
    pass.end();
  }

  /** letter D of build step 2: a still deforming body's parts become rigid rows again (engine_settle.wgsl). (tests)
   *  off: a still body's particles stand where they are, stepped by nothing, drawn as its mesh, till it is let go */
  settles = true;
  /** (tests, the perf overlay) a compute pass a kernel, timed apart as `engine:<kernel>`; off: one pass, `engine` */
  timeKernels = false;
  /** (tests) off: deforming voxels are not put in the voxel hash, so they meet the ground only */
  voxelHash = true;
  /** (tests) the lattice's substeps skipped: deforming bodies stand as they are */
  holdLattice = false;

  /** (tests only: nothing in play reads a row) the buffers, to read back */
  get debugBuffers() {
    return { pose: this.pose, vel: this.vel, info: this.info, samples: this.samples, list: this.list, events: this.events, pool: this.pool, dmeta: this.dmeta, dargs: this.dargs, kargs: this.kargs, dl: this.dl, dout: this.dout, heap: this.heap, px: this.px, ps: this.ps, pb: this.pb };
  }

  /** (tests, the lab's read-out) the rooms now, and where the records start */
  get rooms() {
    return { ...this.d, ...Engine.layout(this.d), samples: { ...this.samp }, heap: { ...this.hp } };
  }
}
