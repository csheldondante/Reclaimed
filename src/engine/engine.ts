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
import pairsWgsl from '../shaders/engine_pairs.wgsl?raw';
import groundWgsl from '../shaders/engine_ground.wgsl?raw';
import { PAIR_ASKED, PAIR_HW_PAIRS } from './sdf/coarse';
import { SdfCollide, type CollideOptions } from './sdf/collide';
import { hexSdfSpec } from './sdf/hexmodel';
import { SdfModels } from './sdf/models';
import type { SimSystem } from '../sim/system';
import { TICK_DT } from '../sim/flow';
import type { WorldGpu } from '../sim/world-gpu';
import { TUNE } from '../tune/params';
import { cellPos, nbr, NDIR, ROW_H } from '../world/lattice';
import { CHUNK } from '../world/layout';
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
  /** added asleep where it is put (a level's standing things; a test's fixed block): it wakes as any sleeper does */
  asleep?: boolean;
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
const EU_B = 224;
/** engine.wgsl RWW: a row's work words in the awake list's buffer; engine_pairs.wgsl TRW, PRW (vec4s) */
const RWW = 20;
const TRW = 48;
const PRW = 16;
/** ticks between the reads of a chain (the read an event starts is at once) */
const READ_GAP = 4;
/** the chained read's bytes: the pool's header, the awake list's header, what was asked of the pair rooms */
const READ_B = 64 * 4 + 32 + SdfCollide.ASKED_BYTES;
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
export const POOL = { pageTop: 0, pageNext: 1, pageWant: 2, slotTop: 3, slotNext: 4, slotWant: 5, rowTop: 6, rowNext: 7, rowWant: 8, sampNext: 9, sampWant: 10, heapNext: 11, heapWant: 12, failExpand: 13, failSettle: 14, deforming: 15, expands: 16, parts: 17, crumbs: 18, dlWant: 19, dlDirty: 20, settling: 21, hashOver: 22, expandWait: 40 } as const;
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
/** substeps a tick at most (the panel's): a uniform and a terrain list each (engine.wgsl tlAt, TARGS_AT) */
const SUBSTEPS_MOST = 8;
/** the terrain lists' dispatch arguments: 16 B a substep (engine_pairs.wgsl targs) */
const TARGS_B = 16 * SUBSTEPS_MOST;
/** engine_ground.wgsl GT_WORDS */
const GT_WORDS = 20;

/** the tick's stages a bench can leave out (Engine.skip): the six of the note, and what else a tick encodes */
export type EngineStage = 'compact' | 'integrate' | 'coarse' | 'fine' | 'terrain' | 'solve' | 'sleep' | 'stage4' | 'draw';
/** what a tick was made of (Engine.counts; docs/design/PHYSICS_ENGINE.md "Counts a tick") */
export interface TickCounts {
  passes: number;
  direct: number;
  indirect: number;
  clears: number;
  copies: number;
  uploads: number;
  uploadBytes: number;
}

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

/**
 * A model's content: its cells about the least corner of their box, with their materials, and the parity of the box's
 * first row (the lattice's odd rows sit half a cell right, so the same cells two rows up are the same shape and one
 * row up are not). Two bodies with the same key are instances of one model: one heap model, one mesh, one distance
 * field and sample list, baked once (the owner, 2026-11-15: "make the distance fields and voxels for each mesh
 * (instanced ones anyway)"). Pure (test/unit/engine-bake.test.ts).
 */
export function modelKey(cells: readonly EngineCell[]): { key: string; lo: V3 } {
  let lo: V3 = [Infinity, Infinity, Infinity];
  for (const c of cells) lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
  const words = cells.map((c) => [c.x - lo[0], c.y - lo[1], c.z - lo[2], c.mat]).sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  // (two 32-bit FNV-1a hashes of the sorted cells, and their count: not the cells themselves — a key is kept a model)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const w of words)
    for (const v of w) {
      h1 = Math.imul(h1 ^ (v & 0xffff), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (v + 0x9e37), 0x85ebca6b) >>> 0;
    }
  return { key: `${cells.length}:${lo[1] & 1}:${h1.toString(16)}:${h2.toString(16)}`, lo };
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
  /** its row in the distance-field store (sdf/models.ts): what bodies meet it by */
  readonly sdf: number;
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
  /** a u32 a row: its model's row in the distance-field store */
  private sdfModel!: GPUBuffer;
  /** a row's terrain contact rows this substep (engine_pairs.wgsl trow) */
  private trow!: GPUBuffer;
  /** the tick's pairs as the solver keeps them, and the impulses kept by pair slot (engine_pairs.wgsl prow, pimp) */
  private prow!: GPUBuffer;
  private pimp!: GPUBuffer;
  private pimpOld: GPUBuffer | null = null;
  private dummy: GPUBuffer;
  /** the awake list's dispatch arguments again (engine_compact.wgsl rargs) */
  private rargs: GPUBuffer;
  /** the terrain lists' dispatch arguments (engine_pairs.wgsl targs) */
  private targs: GPUBuffer;
  private pairRoom = 0;
  private slotRoom = 0;
  /** the distance-field models and the body ↔ body passes (src/engine/sdf) */
  readonly store: SdfModels;
  readonly collide: SdfCollide;
  /** a model was added since the last bake */
  private unbaked = false;
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
  /** the models by content (modelKey), each with the corner of the cells it was made from: instances share one */
  private byContent = new Map<string, { model: EngineModel; lo: V3 }>();
  /** distance-field bakes so far: batches flushed, models in them (a test's count; the lab's read-out) */
  readonly bakes = { batches: 0, models: 0 };
  /** a buffer made again (it grew): what binds it binds the new one */
  onBuffers?: () => void;
  /** (tests, the bench) the heightfield fast path of the terrain test, over the panel's switch when set */
  fastPath: boolean | null = null;
  /** the pool's header as last read (engine_deform.wgsl P_*; POOL names them): what the GPU has allocated. Read now and
   *  then, never waited for: it only sizes the buffers ahead of need. */
  readonly seen = new Uint32Array(POOL_HDR);
  /** (tests) off: the buffers are not grown ahead, so the GPU's allocations run out */
  growAhead = true;
  /** (tests) off: the pair passes' rooms stay as made, so they run out and their rows are held (`missing`) */
  growPairs = true;
  private statBuf: GPUBuffer;
  private statBusy = false;
  /** (benches: src/perf/enginebench.ts) stages left out of the tick. Only for a held scene (`hold`): what a stage left
   *  out would have written stays as the tick before left it, so the stages after it do the same work */
  skip: Partial<Record<EngineStage, boolean>> = {};
  /** (benches) the scene is held: every stage does its work, but `rowFinish` leaves each row where it was, at rest and
   *  awake — every tick is the tick after the one the hold began at (engine_pairs.wgsl rowFinish, EU.e.w bit 256) */
  hold = false;
  /** cells added to a row's reach when it is tested against the ground tops (engine_pairs.wgsl integrate): half a cell
   *  for a speed a hit gives it within the substep. (tests, benches) 1e9: every awake row gets terrain threads, as
   *  before the test was built */
  groundMargin = 0.5;
  /** what the last tick encoded was made of (the skin pass apart) */
  counts: TickCounts = { passes: 0, direct: 0, indirect: 0, clears: 0, copies: 0, uploads: 0, uploadBytes: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
    /** (tests) the pair passes' rooms as first made */
    opts: { collide?: Partial<CollideOptions> } = {},
  ) {
    const parts = [commonWgsl, layersWgsl, materialsWgsl, engineWgsl];
    const base: BindSpec = { 0: 'uniform', 2: 'uniform', 3: 'uniform', 16: 'uniform', 17: 'uniform' };
    const kernel = (name: string, files: string[], spec: BindSpec, entry = name) => {
      const all = { ...base, ...spec };
      this.k[name] = { k: makeCompute(device, `engine-${name}`, [...parts, ...files], all, entry), spec: all };
    };
    kernel('compact', [compactWgsl], { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 12: 'read', 18: 'rw', 50: 'rw' });
    kernel('fine', [stepWgsl], { 1: 'read', 4: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'read', 11: 'read', 12: 'read', 13: 'tex' });
    kernel('solve', [stepWgsl], { 4: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'read', 12: 'read', 15: 'rw' });
    kernel('fold', [foldWgsl], { 14: 'rw', 15: 'read' });
    // bodies meeting bodies (engine_pairs.wgsl): the substep with pairs in it
    // (engine_ground.wgsl first: the ground tops a row is tested against before its samples get threads)
    const pw = [groundWgsl, pairsWgsl];
    if (CHUNK !== 16) throw new Error('engine_ground.wgsl is written for chunks of 16 columns');
    kernel('tground', pw, { 1: 'read', 11: 'read', 51: 'rw' });
    kernel('integrate', pw, { 1: 'read', 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 51: 'rw', 52: 'rw' });
    kernel('tfine', pw, { 1: 'read', 4: 'rw', 6: 'rw', 7: 'rw', 10: 'rw', 11: 'read', 12: 'read', 13: 'tex', 40: 'rw' });
    kernel('pimpMove', pw, { 42: 'rw', 48: 'read', 49: 'read' });
    kernel('pairPrep', pw, { 4: 'rw', 41: 'rw', 42: 'rw', 43: 'read', 44: 'read', 45: 'read', 46: 'read' });
    kernel('pairPre', pw, { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 41: 'rw', 43: 'read', 47: 'read' });
    kernel('pairSolve', pw, { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 41: 'rw', 43: 'read' });
    kernel('rowSolve', pw, { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 40: 'rw', 47: 'read' });
    kernel('pairPush', pw, { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 41: 'rw', 42: 'rw', 43: 'read' });
    kernel('rowFinish', pw, { 4: 'rw', 5: 'rw', 6: 'rw', 10: 'rw', 12: 'read', 15: 'rw', 40: 'rw', 47: 'read' });
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
    this.eu = Array.from({ length: SUBSTEPS_MOST }, (_, s) => world.buf(`engine uniform (substep ${s})`, EU_B, U));
    for (let i = 0; i < CMD_RING; i++) this.cu.push({ eu: world.buf('engine uniform (compact)', EU_B, U), ec: world.buf('engine commands', CMDS * 32, U) });
    this.events = world.buf('engine events', (EV_AT + EVENT_ROOM * EV_WORDS) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.pm = world.buf('engine lattice materials', MAX_MATERIALS * 64, U);
    device.queue.writeBuffer(this.pm, 0, packPhysMats());
    this.et = world.buf('engine expand thresholds', 192, U);
    this.fu = world.buf('engine draw uniform', 16, U);
    this.ou = world.buf('engine uniform (occupancy)', EU_B, U);
    this.statBuf = world.buf('engine chained read', READ_B, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    this.rargs = world.buf('engine row dispatch', 32, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.targs = world.buf('engine terrain dispatch', TARGS_B, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.groundRoom();
    this.dummy = world.buf('engine (no slot growth)', 64, GPUBufferUsage.STORAGE);
    this.store = new SdfModels(device, 'grad8');
    // (the engine reads what was asked of the rooms itself, with the pool's header: one read, chained from events)
    this.collide = new SdfCollide(device, this.store, { rows: 64, cellTop: 12, margin: TUNE.engine.nearGap, readEvery: 0, spread: true, epochWord: 7, ...opts.collide });
    this.resize({ rows: 64, pages: 16, slots: 16, table: 1 });
    this.pairRooms();
    this.drawRoom(4096);
    this.samp = { used: 0, cpu: 4096, gpu: 1024 };
    this.samples = this.halves(undefined, 'engine samples', 16, this.samp, 4096, 1024);
    this.contacts = this.halves(undefined, 'engine contacts', 64, this.samp, 4096, 1024);
    this.hp = { used: 1, cpu: 4096, gpu: 4096 };
    this.heap = this.halves(undefined, 'engine heap', 16, this.hp, 4096, 4096);
  }

  private olds: GPUBuffer[] = [];
  /** the ground tops (engine_ground.wgsl gtop): a record a chunk of columns the world keeps versions for; made again, empty, when that count changes */
  private gtop!: GPUBuffer;
  private gtopChunks = 0;
  private groundRoom(): void {
    const n = this.world.versionChunks;
    if (n === this.gtopChunks) return;
    if (this.gtop) this.olds.push(this.gtop);
    this.gtopChunks = n;
    this.gtop = this.world.buf('engine ground tops', Math.max(1, n) * GT_WORDS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.g = null;
  }
  /** the buffers a growth replaced, let go once every encoder that may hold them has run */
  private letGo(): void {
    const olds = this.olds.splice(0);
    void this.device.queue.onSubmittedWorkDone().then(() => {
      olds.forEach((o) => o.destroy());
      this.collide.release();
    });
  }

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
      // (the list, then the rows' work words — engine.wgsl rwAt. Made again empty: a wake asked for in the tick before
      // a growth is lost, and the sleep epoch starts again, so the coarse pass is told to build its sleeper table)
      this.list = again(this.list, 'engine awake list', (LIST_AT + n.rows * (1 + RWW + SUBSTEPS_MOST) + 4) * 4, 0, S | GPUBufferUsage.INDIRECT);
      this.sdfModel = again(this.sdfModel, 'engine row models', n.rows * 4, o.rows * 4);
      // (a row with no model in the store — every row the GPU makes at settle, till its field is baked: BACKLOG PJ6 —
      // is in no pair: the coarse pass reads this word)
      this.device.queue.writeBuffer(this.sdfModel, o.rows * 4, new Uint32Array(n.rows - o.rows).fill(0xffffffff));
      this.trow = again(this.trow, 'engine terrain rows', n.rows * TRW * 16, 0);
      this.collide.coarse.invalidateSleepers();
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

  /** the solver's own buffers by the pair passes' rooms: made again when those grow (the slots' kept impulses moved on the GPU by the fine pass's remap, at the next tick's `pimpMove`) */
  private pairRooms(): boolean {
    const c = this.collide;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    let moved = false;
    if (c.coarse.pairRoom !== this.pairRoom) {
      if (this.prow) this.olds.push(this.prow);
      this.pairRoom = c.coarse.pairRoom;
      this.prow = this.world.buf('engine pair rows', this.pairRoom * PRW * 16, S);
      this.g = null;
    }
    if (c.fine.slots !== this.slotRoom) {
      if (this.pimpOld) this.olds.push(this.pimpOld);
      this.pimpOld = this.pimp ?? null;
      this.oldSlots = this.slotRoom;
      this.slotRoom = c.fine.slots;
      this.pimp = this.world.buf('engine pair impulses', this.slotRoom * 16, S);
      moved = !!this.pimpOld;
      this.g = null;
    }
    return moved;
  }
  private oldSlots = 0;
  /** the pair passes' buffers the bind groups were made with (a growth replaces them) */
  private boundTo: GPUBuffer[] = [];
  private pairBuffers(): GPUBuffer[] {
    const c = this.collide;
    return [c.coarse.pairBuf, c.fine.hits, c.fine.contacts, c.fine.slotKeys, c.missing];
  }

  private groups(): Record<string, GPUBindGroup> {
    const pb = this.pairBuffers();
    if (this.g && pb.some((b, i) => b !== this.boundTo[i])) this.g = null;
    if (this.g) return this.g;
    this.boundTo = pb;
    const w = this.world;
    const res: Record<number, GPUBuffer | GPUTextureView> = {
      0: w.globals, 1: w.chunks, 2: w.materials, 3: this.eu[1], 16: this.cu[0].ec, 17: this.et,
      4: this.pose, 5: this.vel, 6: this.info, 7: this.samples, 8: this.contacts, 10: this.list, 11: w.layers, 12: w.surface, 13: w.driftView, 14: w.deposit, 15: this.events,
      18: this.pool, 19: this.dmeta, 20: this.dargs, 21: this.dargs, 22: this.heap, 23: this.px, 24: this.ps, 25: this.pw, 26: this.pb, 27: this.list, 28: this.events, 29: w.layers, 30: w.particles, 31: w.particleCounters, 32: this.dl, 33: this.dout, 34: this.dl, 35: this.pm, 36: this.fu, 37: this.kargs, 38: this.vh,
      40: this.trow, 41: this.prow, 42: this.pimp, 43: pb[0], 44: pb[1], 45: pb[2], 46: pb[3], 47: pb[4], 48: this.pimpOld ?? this.dummy, 50: this.rargs, 51: this.gtop, 52: this.targs, 49: (this.pimpOld && this.collide.fine.slotRemap) || this.dummy,
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
    // (a substep its own uniform for the two kernels that keep a terrain list a substep)
    for (let s = 0; s < SUBSTEPS_MOST; s++) {
      g[`integrate${s}`] = make('integrate', { 3: this.eu[s] });
      g[`tfine${s}`] = make('tfine', { 3: this.eu[s] });
    }
    g.pairPre0 = make('pairPre', { 3: this.eu[0] });
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
    // (what bodies meet it by: its cells as a distance field, baked on the GPU in one batch at the next tick)
    const sdf = this.store.add(hexSdfSpec(cells, body.com));
    this.unbaked = true;
    const m: EngineModel = { id, cells: cells.length, lo: mb.lo, dims: mb.dims, body, verts, sdf };
    this.models.push(m);
    return m;
  }

  /** A body: a row (an even index) of a model — its own from `cells`, or one shared. (No cells: null.) */
  add(spec: EngineSpec): EngineBody | null {
    if (!spec.model && !spec.cells?.length) return null;
    // (cells whose content a model already has are an instance of it: nothing uploaded or baked but the row; the
    // model's centre moved to where these cells stand)
    let model = spec.model;
    let shift: V3 = [0, 0, 0];
    if (!model) {
      const k = modelKey(spec.cells!);
      const hit = this.byContent.get(k.key);
      if (hit) {
        model = hit.model;
        shift = [k.lo[0] - hit.lo[0], (k.lo[1] - hit.lo[1]) * ROW_H, k.lo[2] - hit.lo[2]];
      } else {
        model = this.addModel(spec.cells!, spec.mesh);
        this.byContent.set(k.key, { model, lo: k.lo });
      }
    }
    const b = model.body;
    const n = b.samples.length / 4;
    if (2 * (this.rows + 1) > this.d.rows) this.resize({ ...this.d, rows: pow2(2 * (this.rows + 1), this.d.rows) });
    this.room(this.samp.used + n, 0, 0, 0);
    const row = 2 * this.rows++;
    const first = this.samp.used;
    this.samp.used += n;
    const com: V3 = [b.com[0] + shift[0], b.com[1] + shift[1], b.com[2] + shift[2]];
    const pos = spec.pose?.pos ?? com;
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
    // (asleep as settle's rows are made: `compact` takes the ground's word it sleeps on, and bumps the sleep epoch)
    Iu[3] = ROW_ALIVE | (spec.asleep ? 2 | 64 : 0);
    If.set([b.invI[3], b.invI[4], b.invI[5], b.mass], 4);
    Iu[8] = first;
    Iu[9] = n;
    Iu[10] = (b.mat & 255) | ((b.loose & 255) << 8);
    If[11] = b.cellMass;
    Iu[12] = model.id;
    this.device.queue.writeBuffer(this.info, row * INFO_B, I);
    this.device.queue.writeBuffer(this.sdfModel, row * 4, new Uint32Array([model.sdf]));
    this.kick();
    this.device.queue.writeBuffer(this.samples, first * 16, b.samples);
    this.tris += model.verts / 3;
    this.drawRoom(2 * this.tris);
    this.dirtyDraw();
    const body: EngineBody = { row, restCom: com, cells: model.cells, samples: n, mass: b.mass, model };
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
    this.kick();
  }

  wake(b: { row: number }): void {
    this.cmds.push({ kind: 2, row: b.row, a: [0, 0, 0, 0] });
    this.kick();
  }

  /** every row within r of a point wakes (the ground there was cut, something was thrown in) */
  wakeNear(p: V3, r: number): void {
    this.cmds.push({ kind: 3, row: 0, a: [p[0], p[1], p[2], r] });
    this.kick();
  }

  /** the window slid: every row moves with it */
  shift(dx: number, dy: number, dz: number): void {
    this.cmds.push({ kind: 4, row: 0, a: [dx, dy, dz, 0] });
    this.kick();
  }

  /** the row deforms at the next tick whatever hits it (a lab's button, a test): its particles are made as an impact's are */
  expand(b: { row: number }): void {
    this.cmds.push({ kind: 5, row: b.row, a: [0, 0, 0, 0] });
    this.kick();
  }

  /** a deforming body let go — its pages back to the pool, its row freed — or with none named, every one */
  release(b?: { row: number }): void {
    this.cmds.push({ kind: 6, row: b ? b.row : 0xffffffff, a: [0, 0, 0, 0] });
    this.kick();
  }

  /** every row, model and particle let go (a level reset) */
  clear(): void {
    this.rows = 0;
    this.tris = 0;
    this.samp.used = 0;
    this.hp.used = 1;
    this.bodies.clear();
    for (const m of this.models) this.store.remove(m.sdf);
    this.models.length = 0;
    this.byContent.clear();
    this.collide.coarse.invalidateSleepers();
    this.kick();
    this.cmds.length = 0;
    this.seen.fill(0);
    this.s4Words = [];
    const enc = this.device.createCommandEncoder({ label: 'engine clear' });
    for (const b of [this.info, this.pool, this.dmeta, this.dargs, this.kargs, this.list]) enc.clearBuffer(b);
    enc.clearBuffer(this.dl, 0, DL_AT * 4);
    this.device.queue.submit([enc.finish()]);
  }

  /** the step's parameters as a kernel reads them (engine.wgsl EngU) */
  private uniform(first: boolean, cmds: number, substep = 0): ArrayBuffer {
    const T = TUNE.engine;
    const U = new ArrayBuffer(EU_B);
    const f = new Float32Array(U);
    const u = new Uint32Array(U);
    const sub = Math.min(SUBSTEPS_MOST, Math.max(1, Math.round(T.substeps)));
    f.set([TICK_DT / sub, T.friction, T.restitution, T.pushV], 0);
    f.set([T.slop, T.slopK, T.slopP, T.slopCap], 4);
    f.set([T.erodeDepth, T.restV, T.restW, T.restT], 8);
    f.set([T.airDrag, T.angDamp, T.stepUp, T.eventEnergy], 12);
    f.set([T.nearGap, EVENT_ROOM, T.groundDamp, T.breakRough], 16);
    const fast = this.fastPath ?? T.fastPath >= 0.5;
    const d = this.d;
    const L = Engine.layout(d);
    u.set([d.rows, cmds, Math.max(1, Math.round(T.passes)), (fast ? 1 : 0) | (first ? 2 : 0) | (T.deform >= 0.5 ? 4 : 0) | (this.settles ? 8 : 0) | (T.pairExpand >= 0.5 ? 16 : 0) | (this.hold ? 256 : 0)], 20);
    u.set([d.pages, d.slots, d.table, this.ticks], 24);
    u.set([L.pageStack, L.slotStack, L.rowStack, L.sums], 28);
    u.set([L.pageInfo, L.slotRec, L.tables, this.dlRoom], 32);
    u.set([this.samp.cpu, this.samp.gpu, this.hp.cpu, this.hp.gpu], 36);
    const lsub = Math.max(1, Math.round(T.latticeSubsteps));
    f.set([T.stillV, T.stillT, T.crumb, TICK_DT / lsub], 40);
    u.set([Math.max(1, Math.round(T.latticeIters)), 0, lsub, substep], 44);
    f[45] = T.breakSmooth;
    f.set([T.wakeEnergy, T.warmStart, T.rimDepth, this.groundMargin], 48);
    u.set([Math.max(1, Math.round(T.pairIters)), Math.min(this.pairRoom, this.pairsNow || this.pairRoom), this.slotRoom, this.oldSlots], 52);
    return U;
  }

  // ---- the one read (DESIGN §24: "CPU reads are small, async, and only after edits or events; nothing reads back per
  // frame"). It starts when the host adds a body, changes a velocity, wakes rows, slides the window or says the
  // world was edited; it is issued again only while the last one showed activity (rows awake, bodies deforming or
  // settling, a buffer or a room about to grow). With everything asleep and nothing asked, none is issued.
  // What it carries: the pool's header (what the GPU's allocators have asked for), the awake count, and what was asked
  // of the pair passes' rooms. No body is in it. Trade-off: a wake that happens on the GPU alone (a sleeper's ground
  // changed by a sim) is not seen by the CPU until the next event it knows of — the tick itself needs no read, and a
  // room that runs out meanwhile holds its rows still (`missing`) instead of dropping a collision.
  /** reads an event still owes: two, the one issued with the event shows the tick before it */
  private owed = 2;
  /** the last read showed activity: the chain goes on */
  private active = false;
  private nextRead = 0;
  /** reads issued so far (a test's count; the lab's read-out) */
  reads = 0;
  /** rows awake as the last read saw them */
  awakeSeen = 0;
  /** a read landed since the buffers were last sized by it */
  private fresh = false;

  /** the host changed something the engine cannot see from the GPU's side alone (an edit under bodies, a spawn): the read chain starts */
  kick(): void {
    this.owed = 2;
    this.calm = false;
  }

  // ---- the quiet tick (docs/design/PHYSICS_ENGINE.md "Asleep costs nothing"). When the last read to land showed
  // nothing awake, deforming, settling or growing, and the host has asked nothing since (every ask calls `kick`), no
  // row can be awake: the tick encodes nothing at all, and the frame's skin pass is left out once it has placed the
  // list whole. What the CPU cannot know is a sleeper whose ground a simulation changed on the GPU with no host event
  // (`compact` is what notices that). So every `watchEvery` quiet ticks `compact` alone is encoded — one direct
  // dispatch — and the tick after, one read of what it found: a sleeper woken that way moves a second late at most.
  // (Departure from DESIGN §24's "only after edits or events": one read a second while everything sleeps. 0: never,
  // and such a sleeper then wakes at the next host event.)
  // ---- stage 4 only while something deforms (docs/design/PHYSICS_ENGINE.md "Stage 4 only while something deforms").
  // Its 81 dispatches (expand, arm, the page list, fill, the lattice, settle, release, slots) are encoded only while
  // the CPU has reason (s4Mode has the exact rule): the last read showed a body deforming or settling, a row waiting to deform (`compact` counts
  // those: P_EXPAND_WAIT), an expansion or a part since the read before; or the host asked for one (`expand`,
  // `release`); for 30 ticks after any of those; and whenever the last read is more than 12 ticks old (ticks stepped
  // with no frame between them, a stalled read: then as before). A row flagged to deform is frozen as it came in by
  // the rigid kernels until `expand` runs, so a gate that opens late delays its deformation — by the read's age, a few
  // ticks — and loses nothing.
  // ---- direct dispatches (docs/design/PHYSICS_ENGINE.md "Direct, not indirect"). On the owner's phone an indirect
  // dispatch costs about 0.1 ms whether or not it does anything (its arguments are checked on the GPU first) and a
  // direct one under 0.01. So while the rooms are small the kernels a thread a row or a pair are dispatched direct
  // over the whole room — every row slot, every pair the room holds — and each thread leaves at once past the live
  // count, as it always did. Nothing live can be past such a dispatch, so there is no tail to handle: a count that
  // jumps in a tick (10 awake to 500) is covered like any other. Past the bounds below the empty workgroups would
  // cost more than the checks and the dispatches are indirect as before.
  /** (tests, benches) off: every dispatch sized by the GPU's counts is indirect, as before */
  directDispatch = true;
  // The pair kernels are dispatched over this tick's pair budget, not the whole room (a room is eight pairs a row
  // slot: mostly empty): twice the most pairs any tick asked for as the last read saw, plus `pairHeadroom`, 1,024 at
  // least, the room at most — and the whole room whenever that read is over 12 ticks old. The budget is given to the
  // coarse and fine passes as the tick's pair room, so a tick that finds more pairs than it fails safe the way a full
  // room does: the pairs past it are counted (the next read raises the budget) and their rows are flagged `missing`
  // and held where they are, bit for bit. No pair is solved for half its rows and none is dropped unseen.
  /** pairs of headroom over twice the last count seen ((tests) 0 with `pairFloor` 1: a budget any new pair overruns) */
  pairHeadroom = 512;
  pairFloor = 1024;
  /** the most pairs a tick asked for, as the last read saw it (-1: no read yet) */
  private pairsSeen = -1;
  /** this tick's pair budget */
  private pairsNow = 0;
  private pairBudget(): number {
    if (!this.directDispatch || this.pairsSeen < 0 || this.ticks - this.readAt > 12) return this.pairRoom;
    return Math.min(this.pairRoom, pow2(2 * this.pairsSeen + this.pairHeadroom, this.pairFloor));
  }
  /** row slots and pairs up to which the row and pair kernels are dispatched direct (256 and 512 workgroups) */
  static readonly DIRECT_ROWS = 16384;
  static readonly DIRECT_PAIRS = 32768;

  /** (tests, benches) off: stage 4 is encoded every tick anything is awake, as before */
  stage4Gate = true;
  private s4Until = -1;
  /** the tick the last read to land was issued at */
  private readAt = -1e9;
  /** the header's words that only move when stage 4 has work, as the last header read (by either read) had them */
  private s4Words: number[] = [];
  /** a header just read: stage 4 stays encoded for 30 ticks if it shows a body deforming, settling, waiting to, or one made or ended since the header before */
  private s4Evidence(): boolean {
    const now = [POOL.expandWait, POOL.expands, POOL.parts, POOL.failExpand, POOL.failSettle].map((k) => this.seen[k]);
    const busy = this.seen[POOL.deforming] > 0 || this.seen[POOL.settling] > 0 || now.some((v, i) => v !== (this.s4Words[i] ?? 0));
    if (busy) this.s4Until = this.ticks + 30;
    this.s4Words = now;
    return busy;
  }
  /** the last tick `expand` was encoded, and whether the last chained read to land showed stage 4 any work */
  private s4Armed = -1;
  private s4Busy = true;
  /**
   * This tick's stage 4: `armed` (all of it), `drain` (all but `expand`: bodies already deforming go on, a row flagged
   * to deform waits), `closed` (none). It closes only on a read issued after the last tick `expand` ran that shows
   * nothing deforming, settling or waiting: no body can have begun to deform since, so none is ever left half way.
   */
  private s4Mode(): 'armed' | 'drain' | 'closed' {
    if (!this.stage4Gate || this.ticks <= this.s4Until || this.ticks - this.readAt > 12) {
      this.s4Armed = this.ticks;
      return 'armed';
    }
    return this.readAt > this.s4Armed && !this.s4Busy ? 'closed' : 'drain';
  }

  /** the last read to land showed nothing that can move, and nothing was asked since */
  private calm = false;
  /** quiet ticks since the last tick that encoded the engine */
  private idle = 0;
  /** a watch tick ran: one read is owed of what its `compact` found */
  private beat = false;
  /** quiet ticks between watch ticks (60: a second); 0, the default: none — the read after a watch tick is a timed
   *  read, which DESIGN §24 does not allow, and the CPU has no other way to learn that a simulation changed the ground
   *  (the chunks' versions are read on the GPU only). So a sleeper undermined by a simulation alone wakes at the next
   *  host event (BACKLOG PP5a) */
  watchEvery = 0;
  /** ticks that encoded nothing (a test's count; the lab's read-out) */
  quietTicks = 0;
  /** a tick was encoded since the frame's skin pass last ran */
  private skinOwed = true;

  private watch(): void {
    if (!this.statBusy && (this.owed > 0 || (this.active && this.ticks >= this.nextRead))) this.issueRead(false);
    this.grown();
  }

  /** the buffers sized ahead by what the last read showed */
  private grown(): void {
    if (this.growAhead && this.fresh) {
      this.fresh = false;
      this.ahead();
    }
  }

  /** the chained read issued; `keepCalm`: a watch tick's (the engine stays quiet while it is on its way) */
  private issueRead(keepCalm: boolean): void {
    {
      this.statBusy = true;
      this.active = false;
      if (!keepCalm) this.calm = false;
      if (this.owed > 0) this.owed--;
      this.nextRead = this.ticks + READ_GAP;
      this.reads++;
      const issuedAt = this.ticks;
      const enc = this.device.createCommandEncoder({ label: 'engine chained read' });
      enc.copyBufferToBuffer(this.pool, 0, this.statBuf, 0, POOL_HDR * 4);
      enc.copyBufferToBuffer(this.list, 0, this.statBuf, POOL_HDR * 4, 32);
      this.collide.copyAsked(enc, this.statBuf, POOL_HDR * 4 + 32);
      this.device.queue.submit([enc.finish()]);
      const rooms = this.collide.rooms;
      this.statBuf.mapAsync(GPUMapMode.READ).then(() => {
        const w = new Uint32Array(this.statBuf.getMappedRange().slice(0));
        this.statBuf.unmap();
        this.statBusy = false;
        const was = [...this.seen];
        this.seen.set(w.subarray(0, POOL_HDR));
        this.awakeSeen = w[POOL_HDR + 3];
        const grows = this.growPairs && this.collide.consider(w.subarray(POOL_HDR + 8), rooms);
        const asked = [POOL.pageWant, POOL.slotWant, POOL.rowWant, POOL.sampWant, POOL.heapWant, POOL.dlWant, POOL.expands, POOL.parts].some((k) => was[k] !== this.seen[k]);
        this.active = this.awakeSeen > 0 || this.seen[POOL.deforming] > 0 || this.seen[POOL.settling] > 0 || grows || asked;
        this.readAt = issuedAt;
        this.pairsSeen = Math.max(w[POOL_HDR + 8 + PAIR_ASKED], w[POOL_HDR + 8 + PAIR_HW_PAIRS]);
        this.s4Busy = this.s4Evidence();
        // (an ask since this read was issued still owes its own)
        this.calm = !this.active && this.owed === 0;
        this.fresh = true;
      }, ignoreTeardown);
    }
  }

  /** nothing can be awake: the CPU's own proof (the last read, and no ask since). Never while a bench holds a scene */
  private quiet(): boolean {
    return this.calm && this.owed === 0 && !this.cmds.length && !this.hold && !this.unbaked && !this.collide.growing && Object.keys(this.skip).length === 0;
  }

  /** a quiet tick: nothing, or every `watchEvery` of them `compact` alone, and the tick after it one read */
  private quietTick(enc: GPUCommandEncoder): void {
    const n: TickCounts = (this.counts = { passes: 0, direct: 0, indirect: 0, clears: 0, copies: 0, uploads: 0, uploadBytes: 0 });
    this.quietTicks++;
    this.idle++;
    this.grown();
    if (this.beat) {
      if (!this.statBusy) {
        this.beat = false;
        this.issueRead(true);
      }
      return;
    }
    if (!this.watchEvery || this.idle % this.watchEvery !== 0) return;
    const ring = this.ring;
    this.ring = (ring + 1) % CMD_RING;
    this.device.queue.writeBuffer(this.cu[ring].ec, 0, new ArrayBuffer(CMDS * 32));
    this.device.queue.writeBuffer(this.cu[ring].eu, 0, this.uniform(false, 0));
    enc.clearBuffer(this.list, 0, (LIST_AT - 1) * 4);
    enc.clearBuffer(this.rargs);
    const pass = enc.beginComputePass({ label: 'engine watch', timestampWrites: this.prof.timestamps('engine') });
    pass.setPipeline(this.k.compact.k.pipeline);
    pass.setBindGroup(0, this.groups()[`compact${ring}`]);
    pass.dispatchWorkgroups(Math.ceil(this.d.rows / 64));
    pass.end();
    this.prof.dispatches++;
    Object.assign(n, { passes: 1, direct: 1, clears: 2, uploads: 2, uploadBytes: CMDS * 32 + EU_B });
    this.beat = true;
    this.skinOwed = true;
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
    this.s4Evidence();
    if (this.growAhead) this.ahead();
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
    // (models added since the last tick: baked now, in one batch — a level's bodies are added before its first tick)
    if (this.unbaked) {
      this.unbaked = false;
      this.bakes.models += this.store.flush();
      this.bakes.batches++;
    }
    if (this.quiet()) {
      this.quietTick(enc);
      return;
    }
    this.idle = 0;
    this.beat = false;
    this.skinOwed = true;
    this.watch();
    const pairs = TUNE.engine.pairs >= 0.5;
    this.groundRoom();
    const skip = this.skip;
    const n: TickCounts = (this.counts = { passes: 1, direct: 0, indirect: 0, clears: 0, copies: 0, uploads: 0, uploadBytes: 0 });
    let moved = false;
    if (pairs) {
      // (before the pass begins: a growth the read asked for, the pair passes' uniforms and two GPU clears)
      this.collide.coarse.margin = this.collide.fine.margin = TUNE.engine.nearGap;
      this.collide.coarse.pairBudget = this.pairsNow = this.pairBudget();
      const pc = this.collide.prepare(enc, this.d.rows, this.ticks, !skip.coarse);
      n.clears += pc.clears;
      n.uploads += pc.uploads;
      n.uploadBytes += pc.uploadBytes;
      moved = this.pairRooms();
      if (!moved && this.pimpOld) {
        this.olds.push(this.pimpOld);
        this.pimpOld = null;
        this.g = null;
      }
      this.letGo();
    }
    const g = this.groups();
    const q = this.device.queue;
    const up = (buf: GPUBuffer, data: ArrayBuffer | Float32Array) => {
      q.writeBuffer(buf, 0, data as ArrayBuffer);
      n.uploads++;
      n.uploadBytes += data.byteLength;
    };
    const take = this.cmds.splice(0, CMDS);
    // (the host asked a body to deform or let one go: stage 4 runs from this tick)
    if (take.some((c) => c.kind === 5 || c.kind === 6)) this.s4Until = this.ticks + 30;
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
    up(this.cu[ring].ec, C);
    up(this.cu[ring].eu, this.uniform(false, take.length));
    const sub = Math.min(SUBSTEPS_MOST, Math.max(1, Math.round(TUNE.engine.substeps)));
    for (let s = 0; s < sub; s++) up(this.eu[s], this.uniform(s === 0, 0, s));
    up(this.et, this.thresholds());
    const clear = (buf: GPUBuffer, offset?: number, size?: number) => {
      enc.clearBuffer(buf, offset, size);
      n.clears++;
    };
    if (!skip.compact) {
      // (the list's header but its last word, the sleep epoch)
      clear(this.list, 0, (LIST_AT - 1) * 4);
      clear(this.rargs);
    }
    // (the terrain lists' counts; kept when a bench leaves `integrate`, which makes them, out of a held scene)
    if (!skip.integrate) clear(this.targs);
    clear(this.events, 0, EV_AT * 4);
    clear(this.dargs, 0, 32);
    // (`timeKernels`: a pass a kernel, each with its own timestamps — what a tick is made of; else one pass)
    const cur = { pass: enc.beginComputePass({ label: 'engine', timestampWrites: this.prof.timestamps('engine') }) };
    const run = (name: string, group = name) => {
      if (this.timeKernels) {
        cur.pass.end();
        cur.pass = enc.beginComputePass({ label: `engine ${name}`, timestampWrites: this.prof.timestamps(`engine:${name}`) });
        n.passes++;
      }
      const pass = cur.pass;
      pass.setPipeline(this.k[name].k.pipeline);
      pass.setBindGroup(0, g[group]);
      this.prof.dispatches++;
    };
    const direct = (groups: number) => {
      cur.pass.dispatchWorkgroups(groups);
      n.direct++;
    };
    const indirect = (buf: GPUBuffer, offset: number) => {
      cur.pass.dispatchWorkgroupsIndirect(buf, offset);
      n.indirect++;
    };
    const rowsDirect = this.directDispatch && this.d.rows <= Engine.DIRECT_ROWS;
    if (!skip.compact) {
      run('compact', `compact${ring}`);
      direct(Math.ceil(this.d.rows / 64));
    }
    if (pairs) {
      // (the ground tops, where the columns changed: a thread a chunk — engine_ground.wgsl)
      if (!skip.terrain) {
        run('tground');
        direct(Math.ceil(this.gtopChunks / 64));
      }
      // bodies meet bodies (engine_pairs.wgsl): integrate, the tick's pairs (coarse, fine: once, at the first
      // substep), the terrain rows, the solve, the move and sleep. Every dispatch sized on the GPU: by the rows awake
      // (the list) or by the pairs (the fine pass's own arguments)
      const pd = this.collide.fine.pairDispatch;
      const rowsOf = (name: string, group = name) => {
        run(name, group);
        if (rowsDirect) direct(Math.ceil(this.d.rows / 64));
        else indirect(this.rargs, 0);
      };
      const pairsDirect = this.directDispatch && this.pairsNow <= Engine.DIRECT_PAIRS;
      const pairsOf = (name: string, group = name) => {
        run(name, group);
        if (pairsDirect) direct(Math.ceil(this.pairsNow / 64));
        else indirect(pd.buffer, pd.offset);
      };
      const iters = Math.max(1, Math.round(TUNE.engine.pairIters));
      for (let s = 0; s < sub; s++) {
        if (!skip.integrate) rowsOf('integrate', `integrate${s}`);
        if (s === 0) {
          if (this.timeKernels) {
            cur.pass.end();
            cur.pass = enc.beginComputePass({ label: 'engine collide', timestampWrites: this.prof.timestamps('engine:collide') });
            n.passes++;
          }
          const cc = this.collide.encodeInto(cur.pass, { list: this.list, pose: this.pose, vel: this.vel, info: this.info, model: this.sdfModel, sleepEpoch: this.list }, { coarse: !skip.coarse, fine: !skip.fine, direct: rowsDirect });
          n.direct += cc.direct;
          n.indirect += cc.indirect;
          this.prof.dispatches += cc.direct + cc.indirect;
          if (moved) {
            run('pimpMove');
            direct(Math.ceil(this.oldSlots / 64));
          }
          if (!skip.solve) pairsOf('pairPrep');
        }
        if (!skip.terrain) {
          run('tfine', `tfine${s}`);
          indirect(this.targs, 16 * s);
        }
        if (!skip.solve) {
          pairsOf('pairPre', s === 0 ? 'pairPre0' : 'pairPre');
          for (let i = 0; i < iters; i++) {
            pairsOf('pairSolve');
            rowsOf('rowSolve');
          }
          pairsOf('pairPush');
        }
        if (!skip.sleep) rowsOf('rowFinish');
      }
    } else {
      // (step 1's route, kept: each row over its own terrain contacts; bodies pass through each other)
      for (let s = 0; s < sub; s++) {
        run('fine');
        indirect(this.list, 16);
        run('solve', s === 0 ? 'solve0' : 'solve');
        indirect(this.list, 0);
      }
    }
    const s4 = this.s4Mode();
    if (TUNE.engine.deform >= 0.5 && !skip.stage4 && s4 !== 'closed') {
      // build step 2: rows into particles (the rows awake), the live pages listed and the new ones filled — the
      // per-page and per-slot kernels dispatched from the GPU's own count: nothing deforming, no workgroups
      if (s4 === 'armed') {
        run('expand');
        indirect(this.list, 0);
      }
      run('arm');
      direct(1);
      run('pagelist');
      indirect(this.kargs, 0);
      run('fill');
      indirect(this.dargs, 0);
      this.deform(run, indirect);
      run('release');
      indirect(this.kargs, 0);
      run('slots', `slots${ring}`);
      indirect(this.kargs, 16);
    }
    if (!skip.draw) {
      run('fold');
      if (this.directDispatch) direct(Math.ceil(EVENT_ROOM / 64));
      else indirect(this.events, 0);
      // the draw list, made again by the GPU only when a row came or went
      run('drawArm');
      direct(1);
      run('drawlist');
      if (rowsDirect) direct(Math.ceil(this.d.rows / 64));
      else indirect(this.kargs, 32);
      run('drawlistAsleep');
      if (rowsDirect) direct(Math.ceil(this.d.rows / 64));
      else indirect(this.kargs, 32);
      run('drawEnd');
      direct(1);
    }
    cur.pass.end();
  }

  /**
   * The frame's draw: every listed triangle placed (a thread a triangle, dispatched by the list's own count) — a rigid
   * row's by its pose between the tick's start and now (alpha), a deforming body's by the voxels its vertices are
   * weighted to.
   */
  skin(enc: GPUCommandEncoder, alpha: number): void {
    if (!this.rows) return;
    // (quiet, and the list placed whole since the last tick that ran: nothing moves, nothing to place)
    if (this.calm && !this.skinOwed) return;
    this.skinOwed = false;
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
  private deform(run: (name: string, group?: string) => void, indirect: (buf: GPUBuffer, offset: number) => void): void {
    const T = TUNE.engine;
    const each = (name: string) => {
      run(name);
      indirect(this.dargs, 0);
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
      indirect(this.dargs, 16);
    };
    const tris = (name: string) => {
      run(name);
      indirect(this.dl, 48);
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
    return { targs: this.targs, model: this.sdfModel, prow: this.prow, pimp: this.pimp, pose: this.pose, vel: this.vel, info: this.info, samples: this.samples, list: this.list, events: this.events, pool: this.pool, dmeta: this.dmeta, dargs: this.dargs, kargs: this.kargs, dl: this.dl, dout: this.dout, heap: this.heap, px: this.px, ps: this.ps, pb: this.pb };
  }

  /** (tests, the lab's read-out) the rooms now, and where the records start */
  get rooms() {
    return { ...this.d, ...Engine.layout(this.d), samples: { ...this.samp }, heap: { ...this.hp } };
  }
}
