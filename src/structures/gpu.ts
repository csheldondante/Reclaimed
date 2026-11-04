// The pieces on the GPU (any host: the viewer, the game's renderer): the module library in one vertex and one index
// buffer, the palette, the grid table and the pieces in one storage buffer (shaders/structmesh.wgsl reads them), one
// instanced draw a module in use per slab (pieces sorted by module within a slab; firstInstance offsets into them —
// core WebGPU, no indirect-first-instance). Why instancing: a module is stored once however many thousand walls use it;
// the pieces are 64 bytes each.
//
// (round 128g, the user: "There should be multiple grids with their own coordinate system on the GPU and everything
// should be instanced without CPU readback"; "the plan is to support physics and maybe floating islands or giants with
// grids on their back eventually") The data buffer, in vec4s:
//   [0, SP_PAL)                       the palette
//   [SP_GRID0, SP_GRID0 + 2·GRID_CAP) the grid table: a grid a row of two vec4s — (position xyz, uniform scale) and its
//                                     rotation (a unit quaternion xyzw). A piece's frame is its grid's: the vertex shader
//                                     composes grid ∘ local (structmesh.wgsl spGrid). Grid 0 is the identity (the host's
//                                     own frame: the viewer's world, the game's window). Moving a grid writes its row
//                                     (32 bytes) and nothing else; a GPU pass may write rows too (a physics body, a bone).
//   [SP_PIECE0, …)                    4 vec4s a piece: MOVING_CAP pieces rewritten every frame (ships), then slabs.
// A slab is one owner's pieces (a settlement's, the fortress's), uploaded when they change — never when their grid moves —
// sorted by module within it, its grid id in each piece's flags (bits 8-23). Slabs come and go without touching the
// others; hidden slabs stay on the GPU, cached, and cost no draws.
import type { StructurePieces } from '../api/contracts/structures';
import { library } from './modules';
import { PIECE_FLOATS } from './pieces';
import { PARTS } from './modules';
import { STYLES, STYLE_IDS, VARIANTS } from './styles';

/** vec4s of palette at the head of the data buffer */
export const SP_PAL = STYLE_IDS.length * PARTS * VARIANTS;
/** (round 128g) grids the table holds (grid 0: the identity) */
export const GRID_CAP = 256;
/** vec4s a grid row */
export const GRID_VEC4 = 2;
/** the grid table's first vec4 */
export const SP_GRID0 = SP_PAL;
/** the pieces' first vec4 (instance 0) */
export const SP_PIECE0 = SP_GRID0 + GRID_CAP * GRID_VEC4;
/** (round 120) pieces kept at the head of the pieces for what moves every frame (sailing ships): written in place, never sorted */
export const MOVING_CAP = 64;
/** a piece's flags float: its grid id from this bit (structmesh.wgsl spGridOf) */
export const GRID_SHIFT = 8;

export interface DrawRange {
  module: number;
  /** its far look (modules.ts lodOf) */
  lod: number;
  first: number;
  count: number;
}

/** (round 128g) A grid's frame in its host's: x' = position + scale · rotate(quat, x). */
export interface GridTransform {
  pos: [number, number, number];
  /** a unit quaternion (x, y, z, w); absent: none */
  quat?: [number, number, number, number];
  /** absent: 1 */
  scale?: number;
}

interface Slab {
  grid: number;
  first: number;
  count: number;
  ranges: DrawRange[];
  glow: DrawRange[];
  shown: boolean;
  tris: number;
  lodTris: number;
}

/** (round 128g) A first-fit allocator over [0, cap): ranges given back merge with their neighbours. Pure (unit-tested). */
export class RangeAlloc {
  /** free ranges, sorted by start, never touching */
  free: [number, number][] = [];
  constructor(public cap: number) {
    if (cap > 0) this.free.push([0, cap]);
  }
  /** a range of n (its start), or -1: no room */
  take(n: number): number {
    if (n <= 0) return 0;
    for (let i = 0; i < this.free.length; i++) {
      const [s, l] = this.free[i];
      if (l < n) continue;
      if (l === n) this.free.splice(i, 1);
      else this.free[i] = [s + n, l - n];
      return s;
    }
    return -1;
  }
  give(s: number, n: number): void {
    if (n <= 0) return;
    let i = 0;
    while (i < this.free.length && this.free[i][0] < s) i++;
    this.free.splice(i, 0, [s, n]);
    // (merged with what touches it)
    if (i + 1 < this.free.length && this.free[i][0] + this.free[i][1] === this.free[i + 1][0]) {
      this.free[i][1] += this.free[i + 1][1];
      this.free.splice(i + 1, 1);
    }
    if (i > 0 && this.free[i - 1][0] + this.free[i - 1][1] === this.free[i][0]) {
      this.free[i - 1][1] += this.free[i][1];
      this.free.splice(i, 1);
    }
  }
  /** room grown to `cap` (the new space free at the end) */
  grow(cap: number): void {
    if (cap <= this.cap) return;
    const old = this.cap;
    this.cap = cap;
    this.give(old, cap - old);
  }
}

export class StructureGpu {
  verts!: GPUBuffer;
  index!: GPUBuffer;
  data!: GPUBuffer;
  /** bumped whenever a buffer is made anew (the host makes its bind group again) */
  version = 0;
  /** (round 120) the moving pieces' draws (setMoving) */
  moving: DrawRange[] = [];
  private mods: { first: number; count: number; base: number }[] = [];
  private libSize = 0;
  /** slab pieces' room (pieces, after the moving ones) */
  private alloc = new RangeAlloc(0);
  private slabs = new Map<string, Slab>();
  private grids: RangeAlloc;
  private drawList: { ranges: DrawRange[]; glow: DrawRange[] } | null = null;
  readonly stats = { pieces: 0, draws: 0, tris: 0, lodTris: 0, modules: 0, bytes: 0, slabs: 0, shown: 0, grids: 0, uploads: 0, uploadedPieces: 0, gridWrites: 0 };

  constructor(private device: GPUDevice) {
    this.uploadLibrary();
    // (grid 0 the identity, never given out)
    this.grids = new RangeAlloc(GRID_CAP);
    this.grids.take(1);
    this.ensureData(256);
  }

  wgsl(): string {
    return `const SP_PAL: u32 = ${SP_PAL}u;\nconst SP_GRID0: u32 = ${SP_GRID0}u;\nconst SP_PIECE0: u32 = ${SP_PIECE0}u;\nconst SP_GRID_SHIFT: u32 = ${GRID_SHIFT}u;\nconst SP_PARTS: u32 = ${PARTS}u;\nconst SP_VARIANTS: u32 = ${VARIANTS}u;\n`;
  }

  private uploadLibrary(): void {
    const lib = library();
    if (lib.modules.length === this.libSize) return;
    let nv = 0;
    let ni = 0;
    this.mods = lib.modules.map((m) => {
      const r = { first: ni, count: m.index.length, base: nv };
      nv += m.verts.length / 4;
      ni += m.index.length;
      return r;
    });
    const v = new Float32Array(nv * 4);
    const ix = new Uint32Array(ni);
    lib.modules.forEach((m, i) => {
      v.set(m.verts, this.mods[i].base * 4);
      ix.set(m.index, this.mods[i].first);
    });
    this.verts?.destroy();
    this.index?.destroy();
    this.verts = this.device.createBuffer({ label: 'struct verts', size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.verts, 0, v);
    this.index = this.device.createBuffer({ label: 'struct index', size: ix.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.index, 0, ix);
    this.libSize = lib.modules.length;
    this.stats.modules = lib.modules.length;
  }

  /** room for `pieces` slab pieces: a bigger buffer, what was there copied over on the GPU (nothing re-sent) */
  private ensureData(pieces: number): void {
    if (pieces <= this.alloc.cap) return;
    const cap = Math.max(pieces, Math.ceil(this.alloc.cap * 1.5));
    const size = (SP_PIECE0 + (MOVING_CAP + cap) * 4) * 16;
    const old = this.data as GPUBuffer | undefined;
    this.data = this.device.createBuffer({ label: 'struct data', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.version++;
    if (old) {
      const enc = this.device.createCommandEncoder({ label: 'struct data grow' });
      enc.copyBufferToBuffer(old, 0, this.data, 0, old.size);
      this.device.queue.submit([enc.finish()]);
      old.destroy();
    } else {
      const pal = new Float32Array(SP_PAL * 4);
      STYLE_IDS.forEach((id, s) => {
        const st = STYLES[id];
        for (let p = 0; p < PARTS; p++) {
          const vars = st.palette[p];
          for (let k = 0; k < VARIANTS; k++) {
            const c = vars[Math.min(k, vars.length - 1)];
            const o = ((s * PARTS + p) * VARIANTS + k) * 4;
            // (linear: the palette is authored in sRGB)
            pal[o] = Math.pow(c[0], 2.2);
            pal[o + 1] = Math.pow(c[1], 2.2);
            pal[o + 2] = Math.pow(c[2], 2.2);
            pal[o + 3] = Math.min(vars.length, VARIANTS);
          }
        }
      });
      this.device.queue.writeBuffer(this.data, 0, pal);
      // (every grid row the identity until it's set)
      const id = new Float32Array(GRID_CAP * GRID_VEC4 * 4);
      for (let g = 0; g < GRID_CAP; g++) {
        id[g * 8 + 3] = 1;
        id[g * 8 + 7] = 1;
      }
      this.device.queue.writeBuffer(this.data, SP_GRID0 * 16, id);
    }
    this.alloc.grow(cap);
    this.stats.bytes = this.data.size + this.verts.size + this.index.size;
  }

  // ---- grids ----

  /** A grid of its own (its row the identity until set). Throws when the table is full (GRID_CAP). */
  newGrid(t?: GridTransform): number {
    const g = this.grids.take(1);
    if (g < 0) throw new Error(`structures: the grid table is full (${GRID_CAP} grids)`);
    this.stats.grids++;
    this.setGrid(g, t ?? { pos: [0, 0, 0] });
    return g;
  }

  /** A grid's frame (one row written: 32 bytes) */
  setGrid(g: number, t: GridTransform): void {
    if (g <= 0 || g >= GRID_CAP) throw new Error(`structures: grid ${g} isn't one of the table's (1..${GRID_CAP - 1})`);
    this.device.queue.writeBuffer(this.data, (SP_GRID0 + g * GRID_VEC4) * 16, gridRow(t));
    this.stats.gridWrites++;
  }

  freeGrid(g: number): void {
    if (g <= 0) return;
    this.setGrid(g, { pos: [0, 0, 0] });
    this.grids.give(g, 1);
    this.stats.grids--;
  }

  // ---- slabs ----

  /**
   * (round 128g) `key`'s pieces (replacing what it had), in grid `grid`'s frame: sorted by module and uploaded once into
   * a range of their own. Shown unless `shown` is false.
   */
  put(key: string, p: StructurePieces, grid = 0, shown = true): void {
    this.drop(key);
    // (the far looks first: asking for one may make a module — then the library is uploaded with it)
    const lib = library();
    const lodOf = new Map<number, number>();
    for (let i = 0; i < p.count; i++) if (!lodOf.has(p.module[i])) lodOf.set(p.module[i], lib.lodOf(p.module[i]));
    this.uploadLibrary();
    let first = this.alloc.take(p.count);
    if (first < 0) {
      this.ensureData(this.alloc.cap + p.count);
      first = this.alloc.take(p.count);
      if (first < 0) throw new Error(`structures: no room for ${p.count} pieces after growing`);
    }
    const order = Array.from({ length: p.count }, (_, i) => i).sort((a, b) => p.module[a] - p.module[b]);
    const buf = new Float32Array(p.count * PIECE_FLOATS);
    const slab: Slab = { grid, first, count: p.count, ranges: [], glow: [], shown, tris: 0, lodTris: 0 };
    const pool = lib.id('pool');
    const gbits = grid << GRID_SHIFT;
    order.forEach((src, dst) => {
      const o = dst * PIECE_FLOATS;
      buf.set(p.data.subarray(src * PIECE_FLOATS, src * PIECE_FLOATS + PIECE_FLOATS), o);
      buf[o + 15] = (buf[o + 15] & ((1 << GRID_SHIFT) - 1)) | gbits;
      const m = p.module[src];
      const list = m === pool ? slab.glow : slab.ranges;
      const last = list[list.length - 1];
      if (last && last.module === m) last.count++;
      else list.push({ module: m, lod: lodOf.get(m)!, first: MOVING_CAP + first + dst, count: 1 });
    });
    if (buf.byteLength) this.device.queue.writeBuffer(this.data, (SP_PIECE0 + (MOVING_CAP + first) * 4) * 16, buf);
    for (const r of slab.ranges) {
      slab.tris += (this.mods[r.module].count / 3) * r.count;
      slab.lodTris += (this.mods[r.lod].count / 3) * r.count;
    }
    this.slabs.set(key, slab);
    this.stats.uploads++;
    this.stats.uploadedPieces += p.count;
    this.drawList = null;
  }

  /** `key`'s pieces gone (their range free again) */
  drop(key: string): void {
    const s = this.slabs.get(key);
    if (!s) return;
    this.alloc.give(s.first, s.count);
    this.slabs.delete(key);
    this.drawList = null;
  }

  has(key: string): boolean {
    return this.slabs.has(key);
  }

  /** `key`'s pieces drawn or not (kept on the GPU either way) */
  show(key: string, on: boolean): void {
    const s = this.slabs.get(key);
    if (!s || s.shown === on) return;
    s.shown = on;
    this.drawList = null;
  }

  /** Show these pieces in the host's frame (grid 0), replacing every slab (the viewer's one city). */
  set(p: StructurePieces): void {
    for (const k of [...this.slabs.keys()]) this.drop(k);
    this.put('', p, 0);
  }

  /** the shown slabs' draws */
  get ranges(): DrawRange[] {
    return this.list().ranges;
  }
  /** (round 120) the lights' pools: drawn by their host's glow pass (blended), not with the rest */
  get glow(): DrawRange[] {
    return this.list().glow;
  }

  private list(): { ranges: DrawRange[]; glow: DrawRange[] } {
    if (this.drawList) return this.drawList;
    const ranges: DrawRange[] = [];
    const glow: DrawRange[] = [];
    let pieces = 0;
    let tris = 0;
    let lodTris = 0;
    let shown = 0;
    for (const s of this.slabs.values()) {
      if (!s.shown) continue;
      shown++;
      ranges.push(...s.ranges);
      glow.push(...s.glow);
      pieces += s.count;
      tris += s.tris;
      lodTris += s.lodTris;
    }
    this.drawList = { ranges, glow };
    this.stats.pieces = pieces;
    this.stats.tris = tris;
    this.stats.lodTris = lodTris;
    this.stats.draws = ranges.length;
    this.stats.slabs = this.slabs.size;
    this.stats.shown = shown;
    return this.drawList;
  }

  /**
   * (round 120) What moves every frame (the sailing ships: contracts Structures.shipPieces), at most MOVING_CAP pieces,
   * written in place at the head of the pieces (grid 0) — the slabs aren't touched, sorted or re-uploaded.
   */
  setMoving(p: StructurePieces): void {
    if (p.count > MOVING_CAP) throw new Error(`structures: ${p.count} moving pieces, at most ${MOVING_CAP}`);
    const lib = library();
    for (let i = 0; i < p.count; i++) lib.lodOf(p.module[i]);
    this.uploadLibrary();
    const order = Array.from({ length: p.count }, (_, i) => i).sort((a, b) => p.module[a] - p.module[b]);
    const buf = new Float32Array(Math.max(1, p.count) * PIECE_FLOATS);
    this.moving = [];
    order.forEach((src, dst) => {
      buf.set(p.data.subarray(src * PIECE_FLOATS, src * PIECE_FLOATS + PIECE_FLOATS), dst * PIECE_FLOATS);
      buf[dst * PIECE_FLOATS + 15] = buf[dst * PIECE_FLOATS + 15] & ((1 << GRID_SHIFT) - 1);
      const m = p.module[src];
      const last = this.moving[this.moving.length - 1];
      if (last && last.module === m) last.count++;
      else this.moving.push({ module: m, lod: lib.lodOf(m), first: dst, count: 1 });
    });
    if (p.count) this.device.queue.writeBuffer(this.data, SP_PIECE0 * 16, buf, 0, p.count * PIECE_FLOATS);
  }

  /** the draws (pipeline and bind group set by the host); `lod`: every piece in its far look */
  draw(pass: GPURenderPassEncoder, lod = false): number {
    pass.setVertexBuffer(0, this.verts);
    pass.setIndexBuffer(this.index, 'uint32');
    const ranges = this.ranges;
    for (const r of ranges) {
      const m = this.mods[lod ? r.lod : r.module];
      pass.drawIndexed(m.count, r.count, m.first, m.base, r.first);
    }
    for (const r of this.moving) {
      const m = this.mods[lod ? r.lod : r.module];
      pass.drawIndexed(m.count, r.count, m.first, m.base, r.first);
    }
    return ranges.length + this.moving.length;
  }

  /** (round 120) the lights' pools (the host's glow pipeline set: blended, no depth written) */
  drawGlow(pass: GPURenderPassEncoder): number {
    const glow = this.glow;
    if (!glow.length) return 0;
    pass.setVertexBuffer(0, this.verts);
    pass.setIndexBuffer(this.index, 'uint32');
    for (const r of glow) {
      const m = this.mods[r.module];
      pass.drawIndexed(m.count, r.count, m.first, m.base, r.first);
    }
    return glow.length;
  }

  /** the vertex layout every host's pipeline uses */
  static vertexLayout(): GPUVertexBufferLayout {
    return { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] };
  }

  destroy(): void {
    this.verts.destroy();
    this.index.destroy();
    this.data.destroy();
  }
}

/** (round 128g) a grid's row as the shader reads it: (pos, scale), (quat) — the quaternion normalised */
export function gridRow(t: GridTransform): Float32Array {
  const q = t.quat ?? [0, 0, 0, 1];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 0)) throw new Error('structures: a grid rotation of length 0');
  return Float32Array.of(t.pos[0], t.pos[1], t.pos[2], t.scale ?? 1, q[0] / l, q[1] / l, q[2] / l, q[3] / l);
}

/** (round 128g) a point through a grid row (structmesh.wgsl spGrid's statement on the CPU; tests) */
export function gridApply(row: ArrayLike<number>, p: readonly [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = [row[4], row[5], row[6], row[7]];
  // v + 2w(q × v) + 2 q × (q × v)
  const tx = 2 * (qy * p[2] - qz * p[1]);
  const ty = 2 * (qz * p[0] - qx * p[2]);
  const tz = 2 * (qx * p[1] - qy * p[0]);
  const rx = p[0] + qw * tx + (qy * tz - qz * ty);
  const ry = p[1] + qw * ty + (qz * tx - qx * tz);
  const rz = p[2] + qw * tz + (qx * ty - qy * tx);
  const s = row[3];
  return [row[0] + s * rx, row[1] + s * ry, row[2] + s * rz];
}
