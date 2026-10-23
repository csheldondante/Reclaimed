// Physics voxels (docs/PHYSICS.md): bodies whose every voxel is a particle,
// one GPU solver for every material (phys.wgsl). The CPU only places bodies
// (uploads their voxels once) and aims the heat beam; everything after that
// runs on the GPU: the solve, contacts, fracture, plastic bending, heat, and
// what crumbles into loose ground (through the deposit buffer, like the
// editor's pours) or melts away as embers.

import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import physWgsl from '../shaders/phys.wgsl?raw';
import type { SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { MAT, MATERIALS } from '../world/materials';
import type { VoxelModel } from '../world/models';
import { qRotate, type Q, type V3 } from '../grids/structures';
import { TICK_DT } from '../sim/simulation';

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
  [MAT.Trash]: { density: 1, stiffness: 0.4, yield: 0.2, plastic: 0.4, break: 0.12, restitution: 0.05, friction: 0.8, crumble: 10, soften: 200, melt: 350, heat: 2, loose: MAT.Litter, damp: 0.3, crack: 0 },
};

/** The physics table as the GPU reads it (phys.wgsl PM: 4 vec4 per material). */
function packPhysMats(): Float32Array {
  const out = new Float32Array(128 * 4);
  MATERIALS.forEach((_, m) => {
    const p = PHYS[m] ?? ROCKY;
    out.set([p.density, p.stiffness, p.yield, p.plastic, p.break, p.restitution, p.friction, p.crumble, p.soften, p.melt, p.heat, p.loose, p.damp, p.crack, 0, 0], m * 16);
  });
  return out;
}

export interface PhysBody {
  id: number;
  /** first particle */
  offset: number;
  dims: V3;
  /** what it was made from (null: cut from the map's own structures) */
  model: VoxelModel | null;
  /** its voxels' edge in cells */
  size: number;
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
  private k: Record<string, { k: ComputeKernel; g: GPUBindGroup }> = {};

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
    this.uni = world.buf('physU', 80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.mats = world.buf('physMats', 128 * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.mats, 0, packPhysMats());
    this.bodyTable = world.buf('physBodies', 256 * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // the fragments' ring: a lattice of FRAG_CAP × 1 × 1 (they have no bonds)
    device.queue.writeBuffer(this.bodyTable, FRAG_BODY * 16, new Uint32Array([0, FRAG_CAP, 1, 1]));
    this.inst = world.buf('physInst', PV_CAP * 32, GPUBufferUsage.STORAGE);
    this.indirect = world.buf('physIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
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
    };
    const kernel = (entry: string, spec: BindSpec) => {
      const all = { ...base, ...spec };
      const k = makeCompute(device, `phys-${entry}`, parts, all, entry);
      const g = makeBindGroup(device, `phys-${entry}`, k.layout, Object.fromEntries(Object.keys(all).map((b) => [b, res[Number(b)]])));
      this.k[entry] = { k, g };
    };
    kernel('predict', { 3: 'rw', 4: 'rw', 5: 'rw' });
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
    opts: { model?: VoxelModel; q?: Q; vel?: V3; pinned?: (x: number, y: number, z: number) => boolean; size?: number } = {},
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
    const body: PhysBody = { id: this.bodies.length, offset: this.used, dims: [w, d, h], model: opts.model ?? null, size };
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
          R.set(qRotate(qi, p), k * 4);
          RU[k * 4 + 3] = (mat & 0xff) | (body.id << 8) | (code << 16);
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
    return body;
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
  }

  private writeUniforms(tick: number): void {
    const u = new ArrayBuffer(80);
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
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
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
    pass.end();
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
