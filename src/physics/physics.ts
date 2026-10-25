// Physics voxels (docs/PHYSICS.md): bodies whose every voxel is a particle,
// one GPU solver for every material (phys.wgsl). The CPU only places bodies
// (uploads their voxels once) and aims the heat beam; everything after that
// runs on the GPU: the solve, contacts, fracture, plastic bending, heat, and
// what crumbles into loose ground (through the deposit buffer, like the
// editor's pours) or melts away as embers.

import { Translator } from '../sim/translate';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import physWgsl from '../shaders/phys.wgsl?raw';
import type { SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { MAT, MATERIALS, MAX_MATERIALS } from '../world/materials';
import type { VoxelModel } from '../world/models';
import { qRotate, type Q, type V3 } from '../grids/structures';
import { TICK_DT } from '../sim/simulation';
import { bindSkin, latticeFor, type SkinMesh } from './mesh';

/** particles, all bodies together */
export const PV_CAP = 1 << 17;
/**
 * Fragments (round 49, phys.wgsl split): a crumbling voxel breaks into eight
 * half its size, in a ring of FRAG_CAP slots at the start of the particles
 * (bodies start after it), all of body FRAG_BODY.
 */
export const FRAG_CAP = 8192;
const FRAG_BODY = 255;
export const MAX_BODIES = FRAG_BODY;
const HASH_N = 262144;
/** triangles of meshes drawn over bodies (phys.wgsl skin), all together */
export const SKIN_TRIS = 16384;
const SKIN_V_BYTES = 7 * 16;

/** A voxel's edge in cells as phys.wgsl's size code (0 a whole cell, n is n/16). */
export function sizeCode(s: number): number {
  const c = Math.round(s * 16);
  if (!(s > 0 && s <= 1) || Math.abs(c / 16 - s) > 1e-6) throw new Error(`voxel size ${s} is not n/16 of a cell (0 < size <= 1)`);
  return c === 16 ? 0 : c;
}

/**
 * What each material does as a physics voxel. density (mass per voxel);
 * stiffness (0..1: how far toward its rest shape a voxel moves each
 * iteration; 1 rigid); yield (cells a voxel may be pushed out of its rest
 * shape before the rest shape follows; 99 never: brittle); plastic (how much
 * of the excess the rest shape takes per substep); break (bond strain at
 * which it snaps: small brittle, large ductile); restitution; friction;
 * crumble (cells/s: an impact faster than this breaks the voxel into its
 * loose material); soften / melt (temperatures: stiffness and yield fall
 * between them, and at melt it's gone; 0 never); heat (how fast the beam
 * heats it); loose (what it crumbles to); damp (share of its bonds'
 * stretching speed taken out each substep: 0 rings like a spring); crack
 * (cells/s: an impact faster than this may snap its bonds, more often the
 * harder it hits; 0 never).
 */
interface PhysMat {
  density: number;
  stiffness: number;
  yield: number;
  plastic: number;
  break: number;
  restitution: number;
  friction: number;
  crumble: number;
  soften: number;
  melt: number;
  heat: number;
  loose: number;
  damp: number;
  crack: number;
}

const ROCKY: PhysMat = { density: 2.5, stiffness: 1, yield: 99, plastic: 0, break: 0.035, restitution: 0.1, friction: 0.7, crumble: 14, soften: 1000, melt: 1600, heat: 0.45, loose: MAT.Rubble, damp: 0.5, crack: 9 };
const PHYS: Partial<Record<number, PhysMat>> = {
  [MAT.Stone]: { ...ROCKY, density: 2.7, break: 0.04 },
  [MAT.Concrete]: { ...ROCKY, density: 2.3, break: 0.02, crumble: 9, crack: 5 },
  [MAT.Asphalt]: { ...ROCKY, density: 2.2, break: 0.05, crumble: 12, crack: 7, soften: 120, melt: 400, loose: MAT.Rubble },
  [MAT.Brick]: { ...ROCKY, density: 1.9, break: 0.02, crumble: 9, crack: 5 },
  [MAT.Bone]: { ...ROCKY, density: 1.9, break: 0.03, crumble: 12, crack: 7, loose: MAT.Drift },
  [MAT.Steel]: { density: 7.8, stiffness: 0.6, yield: 0.025, plastic: 0.9, break: 0.25, restitution: 0.2, friction: 0.4, crumble: 40, soften: 450, melt: 1400, heat: 1.3, loose: MAT.Rubble, damp: 0.2, crack: 0 },
  [MAT.Rust]: { density: 7, stiffness: 0.5, yield: 0.02, plastic: 0.9, break: 0.1, restitution: 0.1, friction: 0.6, crumble: 18, soften: 400, melt: 1300, heat: 1.3, loose: MAT.Rubble, damp: 0.25, crack: 14 },
  [MAT.Wood]: { density: 0.7, stiffness: 0.7, yield: 0.2, plastic: 0.2, break: 0.15, restitution: 0.2, friction: 0.5, crumble: 22, soften: 200, melt: 300, heat: 2, loose: MAT.Ash, damp: 0.3, crack: 16 },
  [MAT.Canvas]: { density: 0.3, stiffness: 0.25, yield: 0.4, plastic: 0.3, break: 1, restitution: 0.05, friction: 0.8, crumble: 40, soften: 100, melt: 250, heat: 3, loose: MAT.Ash, damp: 0.15, crack: 0 },
  // (round 50) brittle, they shatter: ice to snow, crystal to sand
  // (ice never melts into lava: it melts in the world, sim/climate.ts)
  [MAT.Ice]: { ...ROCKY, density: 0.92, break: 0.03, crumble: 8, crack: 4, soften: 2000, melt: 0, loose: MAT.Snow },
  [MAT.Crystal]: { ...ROCKY, density: 2.6, break: 0.02, crumble: 10, crack: 3, loose: MAT.Sand },
  [MAT.Trash]: { density: 1, stiffness: 0.4, yield: 0.2, plastic: 0.4, break: 0.12, restitution: 0.05, friction: 0.8, crumble: 10, soften: 200, melt: 350, heat: 2, loose: MAT.Litter, damp: 0.3, crack: 0 },
};

/** The physics table as the GPU reads it (phys.wgsl PM: 4 vec4 per material). */
function packPhysMats(): Float32Array {
  const out = new Float32Array(MAX_MATERIALS * 16);
  MATERIALS.forEach((_, m) => {
    const p = PHYS[m] ?? ROCKY;
    out.set([p.density, p.stiffness, p.yield, p.plastic, p.break, p.restitution, p.friction, p.crumble, p.soften, p.melt, p.heat, p.loose, p.damp, p.crack, 0, 0], m * 16);
  });
  return out;
}

export interface PhysBody {
  id: number;
  /** its rotation at spawn, and its rest centre and voxels then (drive goals are relative to them) */
  q0: Q;
  restCentre: V3;
  total: number;
  /** first particle */
  offset: number;
  dims: V3;
  /** the mesh drawn over it (its voxels hidden), if any: its first triangle and how many */
  skin?: { mesh: SkinMesh; first: number; tris: number };
  /** what it was made from (null: cut from the map's own structures) */
  model: VoxelModel | null;
  /** its voxels' edge in cells */
  size: number;
}

/** A body as the game sees it (round 49): read back from the GPU a tick or two late (`tick` says which). */
export interface BodyState {
  /** its centre (world cells) and velocity (cells/s) */
  pos: V3;
  vel: V3;
  /** its rotation, rest frame → world (what drive() takes) */
  q: Q;
  /** voxels still part of it, of `total` at spawn; damage = 1 − alive / total */
  alive: number;
  total: number;
  damage: number;
  /** its hottest voxel's temperature */
  heat: number;
  tick: number;
}

/**
 * Hold a body to a pose (round 49): every voxel is pulled toward where the
 * pose puts it (a spring of `stiffness`, 1/s²; damped toward `vel` at
 * `damping`, 1/s, default critical), so the body follows — a grab, a carry,
 * a vehicle steered — and still collides, bends and breaks on the way.
 */
export interface Drive {
  pos: V3;
  /** rest frame → world (default: as it was at spawn) */
  q?: Q;
  vel?: V3;
  stiffness: number;
  damping?: number;
}

/**
 * A force field for one tick (round 49; call every tick it lasts): pull toward
 * `at`, push away from it, or wind along `dir`; `strength` cells/s² at the
 * centre, falling to 0 at `radius`. `body`: only that one. `sizeRef`: bodies
 * smaller than this many voxels feel it in proportion (big pieces move, small
 * ones and fragments barely).
 */
export interface PushField {
  kind: 'pull' | 'push' | 'wind';
  at: V3;
  radius: number;
  strength: number;
  dir?: V3;
  body?: PhysBody;
  sizeRef?: number;
  /** 1/s: slows what it holds (by the same falloff), so a pull settles instead of swinging through */
  damping?: number;
}

export interface Beam {
  /** where it hits (world cells) */
  at: V3;
  /** its direction, into the surface */
  dir: V3;
  radius: number;
  /** heat per second at its centre */
  power: number;
}

export class Physics implements SimSystem {
  readonly name = 'physics';
  readonly period = 1;
  /** substeps per tick, and solver iterations per substep */
  substeps = 4;
  iterations = 4;
  readonly bodies: PhysBody[] = [];
  used = 0;
  beam: Beam | null = null;

  private px: GPUBuffer;
  private pv: GPUBuffer;
  private pr: GPUBuffer;
  private pq: GPUBuffer;
  private pg: GPUBuffer;
  private pb: GPUBuffer;
  private pc: GPUBuffer;
  private hash: GPUBuffer;
  private dep: GPUBuffer;
  private touches: GPUBuffer;
  private fragHead: GPUBuffer;
  private touchRead: GPUBuffer;
  private touchBusy = false;
  private touchAt = 0;
  /** map structures (columns) that bodies ran into, a few times a second: the level wakes them */
  onTouch?: (cols: number[]) => void;
  private uni: GPUBuffer;
  private mats: GPUBuffer;
  private bodyTable: GPUBuffer;
  /** draw instances (render.wgsl vsBody) and their indirect args */
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  /** meshes over bodies, bent by them (render.wgsl vsSkin; Renderer.addMesh) and their draw args */
  readonly skinOut: GPUBuffer;
  readonly skinArgs: GPUBuffer;
  private skinSrc: GPUBuffer;
  private skinTris = 0;
  private k: Record<string, { k: ComputeKernel; g: GPUBindGroup }> = {};
  // the game's hold on bodies (round 49): BODY_CTL, pushes, the state readback
  private ctl = new Float32Array(256 * 5 * 4);
  private ctlBuf: GPUBuffer;
  private ctlDirty = true;
  private impulsed = false;
  private pushBuf: GPUBuffer;
  private pushes: PushField[] = [];
  private pushLive = false;
  private bstat: GPUBuffer;
  private bstatRead: GPUBuffer;
  private bstatBusy = false;
  private bstatCopied = -1;
  private states = new Map<number, BodyState>();

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.px = world.buf('physX', PV_CAP * 32, S);
    this.pv = world.buf('physV', PV_CAP * 16, S);
    this.pr = world.buf('physRest', PV_CAP * 16, S);
    this.pq = world.buf('physRot', PV_CAP * 16, S);
    this.pg = world.buf('physRegion', PV_CAP * 32, S);
    this.pb = world.buf('physBonds', PV_CAP * 4, S);
    this.pc = world.buf('physContact', PV_CAP * 16, S);
    this.hash = world.buf('physHash', (HASH_N + PV_CAP) * 4, S);
    this.dep = world.buf('physDeposit', world.cells * 8, S);
    this.touches = world.buf('physTouches', 256 * 4, S);
    this.fragHead = world.buf('physFragHead', 16, S);
    this.touchRead = world.buf('physTouchRead', 256 * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    this.uni = world.buf('physU', 96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.mats = world.buf('physMats', MAX_MATERIALS * 64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.mats, 0, packPhysMats());
    this.bodyTable = world.buf('physBodies', 256 * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // the fragments' ring: a lattice of FRAG_CAP × 1 × 1 (they have no bonds)
    device.queue.writeBuffer(this.bodyTable, FRAG_BODY * 16, new Uint32Array([0, FRAG_CAP, 1, 1]));
    this.inst = world.buf('physInst', PV_CAP * 32, GPUBufferUsage.STORAGE);
    this.indirect = world.buf('physIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.skinSrc = world.buf('physSkinSrc', SKIN_TRIS * 3 * SKIN_V_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.skinOut = world.buf('physSkinOut', SKIN_TRIS * 3 * 32, GPUBufferUsage.STORAGE);
    this.skinArgs = world.buf('physSkinArgs', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.skinArgs, 0, new Uint32Array([0, 1, 0, 0]));
    this.ctlBuf = world.buf('physBodyCtl', 256 * 5 * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.pushBuf = world.buf('physPushes', 8 * 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.bstat = world.buf('physBodyStats', 256 * 16 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.bstatRead = world.buf('physBodyStatsRead', 256 * 16 * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    // (the fragments: one voxel each, so a push by size barely moves them)
    this.ctl[FRAG_BODY * 20 + 11] = 1;
    // every slot starts empty (w < 0)
    const empty = new Float32Array(PV_CAP * 8);
    for (let i = 0; i < PV_CAP; i++) empty[i * 8 + 3] = -1;
    device.queue.writeBuffer(this.px, 0, empty);

    const parts = [commonWgsl, layersWgsl, materialsWgsl, physWgsl];
    const base: BindSpec = { 0: 'uniform', 22: 'uniform', 23: 'uniform', 24: 'uniform' };
    const res: Record<number, GPUBuffer> = {
      0: world.globals,
      1: world.chunks,
      2: world.materials,
      3: this.px,
      4: this.pv,
      5: this.pr,
      6: this.pq,
      7: this.pg,
      8: this.pb,
      9: this.hash,
      10: this.pc,
      11: world.layers,
      12: world.particles,
      13: world.particleCounters,
      14: this.dep,
      16: world.deposit,
      19: this.inst,
      20: this.indirect,
      22: this.uni,
      23: this.mats,
      24: this.bodyTable,
      25: this.touches,
      26: world.physCols,
      27: world.physPuff,
      28: world.lava,
      29: this.fragHead,
      30: this.skinSrc,
      31: this.skinOut,
      32: this.skinArgs,
      33: this.ctlBuf,
      34: this.pushBuf,
      35: this.bstat,
    };
    const kernel = (entry: string, spec: BindSpec) => {
      const all = { ...base, ...spec };
      const k = makeCompute(device, `phys-${entry}`, parts, all, entry);
      const g = makeBindGroup(device, `phys-${entry}`, k.layout, Object.fromEntries(Object.keys(all).map((b) => [b, res[Number(b)]])));
      this.k[entry] = { k, g };
    };
    kernel('predict', { 3: 'rw', 4: 'rw', 5: 'rw', 33: 'uniform', 34: 'uniform' });
    kernel('stats', { 3: 'rw', 4: 'rw', 5: 'rw', 6: 'rw', 35: 'rw' });
    kernel('region', { 3: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' });
    kernel('gather', { 3: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' });
    kernel('hashClear', { 9: 'rw' });
    kernel('hashInsert', { 3: 'rw', 9: 'rw' });
    kernel('collide', { 1: 'read', 2: 'uniform', 3: 'rw', 4: 'rw', 5: 'rw', 8: 'rw', 9: 'rw', 10: 'rw', 11: 'read' });
    kernel('finalize', { 3: 'rw', 4: 'rw', 5: 'rw', 8: 'rw', 10: 'rw', 12: 'rw', 13: 'rw', 27: 'rw' });
    kernel('relax', { 3: 'rw', 4: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'rw', 28: 'read' });
    kernel('split', { 3: 'rw', 4: 'rw', 5: 'rw', 6: 'rw', 8: 'rw', 10: 'rw', 14: 'rw', 29: 'rw' });
    kernel('deaths', { 3: 'rw', 5: 'rw', 8: 'rw', 10: 'rw', 12: 'rw', 13: 'rw', 14: 'rw', 25: 'rw' });
    kernel('fold', { 14: 'rw', 16: 'rw' });
    kernel('skin', { 3: 'rw', 6: 'rw', 30: 'read', 31: 'rw', 32: 'rw' });
    kernel('prep', { 3: 'rw', 5: 'rw', 6: 'rw', 8: 'rw', 19: 'rw', 20: 'rw', 26: 'rw' });
  }

  /**
   * Place a model as a physics body: its local origin (voxel (0,0,0)'s
   * corner) at world `pos`, rotated by q, moving at `vel`. Null with no room.
   */
  spawn(m: VoxelModel, pos: V3, q: Q, vel: V3 = [0, 0, 0]): PhysBody | null {
    const [w, d] = m.size;
    const s = m.voxel ?? 1;
    return this.spawnLattice(
      m.size,
      (x, y, z) => m.vox[x + w * (y + d * z)],
      (x, y, z) => {
        const p = qRotate(q, [(x + 0.5) * s, (y + 0.5) * s, (z + 0.5) * s]);
        return [pos[0] + p[0], pos[1] + p[1], pos[2] + p[2]];
      },
      { model: m, q, vel, size: s },
    );
  }

  /**
   * A body on a w × d × h lattice: matAt gives each cell's material (0 air),
   * at its world position (also its rest shape: a map's hex columns go in
   * where they stand, rows half a cell apart). pinned cells don't move (a
   * ruin's foundation in the bedrock) until their bonds break. size: each
   * voxel's edge in cells (n/16; `at` places them that far apart).
   */
  spawnLattice(
    dims: V3,
    matAt: (x: number, y: number, z: number) => number,
    at: (x: number, y: number, z: number) => V3,
    opts: { model?: VoxelModel; q?: Q; vel?: V3; pinned?: (x: number, y: number, z: number) => boolean; size?: number; hidden?: boolean } = {},
  ): PhysBody | null {
    const [w, d, h] = dims;
    const n = w * d * h;
    // (the fragments' ring comes first, from the first body on)
    const start = Math.max(this.used, FRAG_CAP);
    if (this.bodies.length >= MAX_BODIES || start + n > PV_CAP) return null;
    if (this.used < FRAG_CAP) this.used = FRAG_CAP;
    const q = opts.q ?? [0, 0, 0, 1];
    const vel = opts.vel ?? [0, 0, 0];
    const size = opts.size ?? 1;
    const code = sizeCode(size);
    const vol = size * size * size;
    const body: PhysBody = { id: this.bodies.length, offset: this.used, dims: [w, d, h], model: opts.model ?? null, size, q0: q, restCentre: [0, 0, 0], total: 0 };
    const rc: V3 = [0, 0, 0];
    const X = new Float32Array(n * 8);
    const V = new Float32Array(n * 4);
    const R = new Float32Array(n * 4);
    const RU = new Uint32Array(R.buffer);
    const Qb = new Float32Array(n * 4);
    const B = new Uint32Array(n);
    const solid = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < w && y < d && z < h && matAt(x, y, z) !== 0;
    // rest positions in the body's own frame: the world positions turned back by q
    const qi: Q = [-q[0], -q[1], -q[2], q[3]];
    for (let z = 0; z < h; z++)
      for (let y = 0; y < d; y++)
        for (let x = 0; x < w; x++) {
          const k = x + w * (y + d * z);
          const mat = matAt(x, y, z);
          Qb.set(q, k * 4);
          if (!mat) {
            X[k * 8 + 3] = -1;
            continue;
          }
          const p = at(x, y, z);
          const dens = (PHYS[mat] ?? ROCKY).density;
          const inv = opts.pinned?.(x, y, z) ? 0 : 1 / (dens * vol);
          X.set([p[0], p[1], p[2], inv, p[0], p[1], p[2], 0], k * 8);
          V.set([vel[0], vel[1], vel[2], 0], k * 4);
          const rp = qRotate(qi, p);
          R.set(rp, k * 4);
          for (let a = 0; a < 3; a++) rc[a] += rp[a];
          body.total++;
          // bonds to every solid lattice neighbour (phys.wgsl n26 order)
          let bits = 0;
          for (let j = 0, kk = 0; j < 27; j++) {
            if (j === 13) continue;
            const dx = (j % 3) - 1;
            const dy = (Math.floor(j / 3) % 3) - 1;
            const dz = Math.floor(j / 9) - 1;
            if (solid(x + dx, y + dy, z + dz)) bits |= 1 << kk;
            kk++;
          }
          B[k] = bits >>> 0;
          // (a hidden body's voxels keep which of their six faces were bonded
          // at spawn, bits 23..28: one that loses a face shows where the mesh tore)
          let faces = 0;
          if (opts.hidden) [4, 10, 12, 13, 15, 21].forEach((f, j) => (faces |= ((bits >> f) & 1) << j));
          RU[k * 4 + 3] = ((mat & 0xff) | (body.id << 8) | (code << 16) | (opts.hidden ? 1 << 22 : 0) | (faces << 23)) >>> 0;
        }
    const o = this.used;
    const qd = this.device.queue;
    qd.writeBuffer(this.px, o * 32, X);
    qd.writeBuffer(this.pv, o * 16, V);
    qd.writeBuffer(this.pr, o * 16, R);
    qd.writeBuffer(this.pq, o * 16, Qb);
    qd.writeBuffer(this.pb, o * 4, B);
    qd.writeBuffer(this.bodyTable, body.id * 16, new Uint32Array([o, w, d, h]));
    this.used += n;
    this.bodies.push(body);
    // (the game's drive goals are relative to its rest centre)
    body.restCentre = rc.map((v) => v / Math.max(1, body.total)) as V3;
    this.ctl.set([0, 0, 0, 0, ...q, ...body.restCentre, body.total, 0, 0, 0, 0, 0, 0, 0, 0], body.id * 20);
    this.ctlDirty = true;
    return body;
  }

  /**
   * A mesh as a physics body (round 49, F15): a lattice of voxels `voxel`
   * cells apart built under it (mesh.ts latticeFor) is what the world feels;
   * the mesh is what's drawn, bent every tick by the voxels it's bound to,
   * torn where the body breaks. The mesh's frame: its lattice's low corner
   * at world `pos`, rotated by q. Null with no room.
   */
  spawnMesh(mesh: SkinMesh, voxel: number, pos: V3, q: Q, vel: V3 = [0, 0, 0]): PhysBody | null {
    const lat = latticeFor(mesh, voxel);
    const { data, tris } = bindSkin(mesh, lat);
    if (this.skinTris + tris > SKIN_TRIS) return null;
    const m = lat.model;
    const [w, d] = m.size;
    const body = this.spawnLattice(
      m.size,
      (x, y, z) => m.vox[x + w * (y + d * z)],
      (x, y, z) => {
        const p = qRotate(q, [(x + 0.5) * voxel, (y + 0.5) * voxel, (z + 0.5) * voxel]);
        return [pos[0] + p[0], pos[1] + p[1], pos[2] + p[2]];
      },
      { model: m, q, vel, size: voxel, hidden: true },
    );
    if (!body) return null;
    // (the records name voxels within the body: offset them to its particles)
    const U = new Uint32Array(data.buffer);
    for (let v = 0; v < tris * 3; v++)
      for (let k = 0; k < 4; k++) if (U[v * 28 + k] !== 0xffffffff) U[v * 28 + k] += body.offset;
    this.device.queue.writeBuffer(this.skinSrc, this.skinTris * 3 * SKIN_V_BYTES, data);
    body.skin = { mesh, first: this.skinTris, tris };
    this.skinTris += tris;
    return body;
  }

  /** Is there room for `bodies` more bodies of `voxels` lattice cells in all? */
  private translator?: Translator;

  /** The streamed window slid (round 80): every body's particles move with the land (−d, world units). */
  shift(dx: number, dy: number, dz: number): void {
    this.translator ??= new Translator(this.device);
    // (both a particle's positions: now, and before this substep)
    this.translator.run(this.px, PV_CAP, 2, 0b11, [dx, dy, dz]);
    for (const b of this.bodies) b.restCentre = [b.restCentre[0] - dx, b.restCentre[1] - dy, b.restCentre[2] - dz];
  }

  hasRoom(voxels: number, bodies = 1): boolean {
    return this.bodies.length + bodies <= MAX_BODIES && Math.max(this.used, FRAG_CAP) + voxels <= PV_CAP;
  }

  /** Hold `body` to a pose (null: let go). It stays until changed: call again each tick to move the target. */
  drive(body: PhysBody, d: Drive | null): void {
    const o = body.id * 20;
    if (!d) {
      this.ctl[o + 3] = 0;
    } else {
      const k = d.stiffness;
      this.ctl.set([...d.pos, k], o);
      this.ctl.set(d.q ?? body.q0, o + 4);
      this.ctl.set([...(d.vel ?? [0, 0, 0]), d.damping ?? 2 * Math.sqrt(k)], o + 12);
    }
    this.ctlDirty = true;
  }

  /** Change `body`'s velocity by dv (cells/s) over the next tick (a throw, a hit). */
  impulse(body: PhysBody, dv: V3): void {
    const o = body.id * 20 + 16;
    for (let a = 0; a < 3; a++) this.ctl[o + a] += dv[a] / this.substeps;
    this.ctlDirty = true;
    this.impulsed = true;
  }

  /** A force field for the next tick (up to 8 a tick; more are dropped with an error). */
  push(p: PushField): void {
    if (this.pushes.length >= 8) throw new Error('physics: more than 8 pushes in one tick');
    this.pushes.push(p);
  }

  /**
   * The force fields for the next tick, replacing any queued since the last
   * one (for a game that sets its fields every frame: a frame with no tick
   * between doesn't pile them up). Eight at most.
   */
  setPushes(list: PushField[]): void {
    if (list.length > 8) throw new Error(`physics: ${list.length} pushes in one tick (8 at most)`);
    this.pushes = [...list];
  }

  /** `body` as last read back (undefined until the first readback, or once nothing of it is left). */
  state(body: PhysBody): BodyState | undefined {
    return this.states.get(body.id);
  }

  /** A blast at a world point: voxels within `radius` crumble, those within 2.5× are thrown outward. */
  blast(at: V3, radius: number, strength = 8): void {
    this.blasts.push({ at, radius, strength });
  }
  private blasts: { at: V3; radius: number; strength: number }[] = [];
  private blastNow = 0;

  /** Positions (xyz, inverse mass; then previous xyz, temperature) of the particles in use: tests and probes. */
  async readPositions(): Promise<Float32Array> {
    const n = Math.max(1, this.used) * 32;
    const tmp = this.device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.px, 0, tmp, 0, n);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    return out;
  }

  private readTouches = false;
  private colsLive = false;

  /** After the tick's submit: read the touches it copied, if any. */
  afterSubmit(): void {
    if (this.bstatCopied >= 0) {
      const tick = this.bstatCopied;
      this.bstatCopied = -1;
      this.bstatRead.mapAsync(GPUMapMode.READ).then(
        () => {
          const S = new Int32Array(this.bstatRead.getMappedRange().slice(0));
          this.bstatRead.unmap();
          this.bstatBusy = false;
          this.readStates(S, tick);
        },
        () => (this.bstatBusy = false),
      );
    }
    if (!this.readTouches) return;
    this.readTouches = false;
    this.touchRead.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new Uint32Array(this.touchRead.getMappedRange().slice(0));
        this.touchRead.unmap();
        this.touchBusy = false;
        const n = Math.min(255, t[0]);
        if (!n) return;
        // one per column, a handful at most
        const cols = [...new Set(t.slice(1, 1 + n))].slice(0, 8);
        this.onTouch?.(cols);
      },
      () => (this.touchBusy = false),
    );
  }

  /** Remove every body. */
  clear(): void {
    // (the fragments' ring with them)
    const empty = new Float32Array(this.used * 8);
    for (let i = 0; i < this.used; i++) empty[i * 8 + 3] = -1;
    if (this.used) this.device.queue.writeBuffer(this.px, 0, empty);
    this.bodies.length = 0;
    this.used = 0;
    this.skinTris = 0;
    this.states.clear();
    this.ctl.fill(0, 0, FRAG_BODY * 20);
    this.ctlDirty = true;
    // (nothing left to draw: encode stops writing the draw args)
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    this.device.queue.writeBuffer(this.skinArgs, 0, new Uint32Array([0, 1, 0, 0]));
  }

  /** The game's drives, impulses (this tick only) and pushes (this tick only) to the GPU. */
  private writeGame(): void {
    if (this.ctlDirty) {
      this.device.queue.writeBuffer(this.ctlBuf, 0, this.ctl);
      this.ctlDirty = false;
      if (this.impulsed) {
        // (spent: cleared for the next tick)
        for (const b of this.bodies) this.ctl.fill(0, b.id * 20 + 16, b.id * 20 + 19);
        this.impulsed = false;
        this.ctlDirty = true;
      }
    }
    if (this.pushes.length || this.pushLive) {
      const u = new ArrayBuffer(8 * 48);
      const f = new Float32Array(u);
      const ui = new Uint32Array(u);
      const KIND = { pull: 1, push: 2, wind: 3 };
      this.pushes.forEach((p, k) => {
        const o = k * 12;
        f.set([...p.at, p.radius, ...(p.dir ?? [0, 0, 0]), p.strength], o);
        ui[o + 8] = KIND[p.kind];
        ui[o + 9] = p.body ? p.body.id : 0xffffffff;
        f[o + 10] = p.sizeRef ?? 0;
        f[o + 11] = p.damping ?? 0;
      });
      this.device.queue.writeBuffer(this.pushBuf, 0, u);
      this.pushLive = this.pushes.length > 0;
      this.pushes.length = 0;
    }
  }

  private readStates(S: Int32Array, tick: number): void {
    for (const b of this.bodies) {
      const o = b.id * 16;
      const n = S[o];
      if (!n) {
        this.states.delete(b.id);
        continue;
      }
      const ql = Math.hypot(S[o + 7], S[o + 8], S[o + 9], S[o + 10]) || 1;
      this.states.set(b.id, {
        pos: [S[o + 1] / 32 / n, S[o + 2] / 32 / n, S[o + 3] / 32 / n],
        vel: [S[o + 4] / 64 / n, S[o + 5] / 64 / n, S[o + 6] / 64 / n],
        q: [S[o + 7] / ql, S[o + 8] / ql, S[o + 9] / ql, S[o + 10] / ql],
        alive: n,
        total: b.total,
        damage: 1 - n / Math.max(1, b.total),
        heat: S[o + 11],
        tick,
      });
    }
  }

  private writeUniforms(tick: number): void {
    const u = new ArrayBuffer(96);
    const f = new Float32Array(u);
    const ui = new Uint32Array(u);
    const b = this.beam;
    f.set([TICK_DT / this.substeps, this.used, 0, b ? 1 : 0], 0);
    if (b) {
      f.set([...b.at, b.radius], 4);
      f.set([...b.dir, b.power], 8);
    }
    ui.set([this.used, this.bodies.length, tick, 0], 12);
    // one blast a tick (the rest wait)
    const bl = this.blasts.shift();
    if (bl) f.set([...bl.at, bl.radius], 16);
    this.blastNow = bl?.strength ?? 0;
    ui[15] = 0;
    f[15] = this.blastNow;
    ui[20] = this.skinTris;
    this.device.queue.writeBuffer(this.uni, 0, u);
  }

  encode(enc: GPUCommandEncoder, tick: number): void {
    // the columns the voxels cover, refilled by prep (once more after the last body goes)
    if (this.used || this.colsLive) {
      enc.clearBuffer(this.world.physCols);
      enc.clearBuffer(this.world.physPuff);
    }
    this.colsLive = this.used > 0;
    if (!this.used) return;
    this.writeUniforms(tick);
    this.writeGame();
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    this.device.queue.writeBuffer(this.skinArgs, 0, new Uint32Array([0, 1, 0, 0]));
    const pass = enc.beginComputePass({ label: 'physics', timestampWrites: this.prof.timestamps('physics') });
    const n = Math.ceil(this.used / 64);
    const run = (name: string, groups: number | [number, number] = n) => {
      const { k, g } = this.k[name];
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, g);
      if (typeof groups === 'number') pass.dispatchWorkgroups(groups);
      else pass.dispatchWorkgroups(groups[0], groups[1]);
      this.prof.dispatches++;
    };
    for (let s = 0; s < this.substeps; s++) {
      run('predict');
      for (let it = 0; it < this.iterations; it++) {
        run('region');
        run('gather');
      }
      run('hashClear', Math.ceil(HASH_N / 64));
      run('hashInsert');
      run('collide');
      run('finalize');
      run('relax');
      run('split');
      run('deaths');
    }
    run('fold', this.world.groups);
    run('prep');
    if (this.skinTris) {
      // (its draw args counted afresh: three vertices a triangle kept)
      run('skin', Math.ceil(this.skinTris / 64));
    }
    // each body's state for the game, read back when the last one is in
    const readStats = !this.bstatBusy;
    if (readStats) run('stats');
    pass.end();
    if (readStats) {
      this.bstatBusy = true;
      enc.copyBufferToBuffer(this.bstat, 0, this.bstatRead, 0, 256 * 64);
      enc.clearBuffer(this.bstat);
      this.bstatCopied = tick;
    }
    // the touches, a few times a second (then cleared)
    if (!this.touchBusy && ++this.touchAt >= 15) {
      this.touchAt = 0;
      this.touchBusy = true;
      enc.copyBufferToBuffer(this.touches, 0, this.touchRead, 0, 1024);
      enc.clearBuffer(this.touches);
      this.readTouches = true;
    }
  }
}
