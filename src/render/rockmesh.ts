// The rigid rock's own mesh (round 95, `?rockbody=1`; the user: "the rigidbody sim should definitely render the mesh
// not cubes. It can use cubes to simulate the motion but just anchor the vertices to the cubes"). A field mesh of
// its own (fieldmesh.ts, like the band's: the same mesher, the same look) over a sparse copy of the layers that holds
// only the pieces in flight: each piece, when it breaks free, is written into a slot — a rectangle of mesh chunks of
// that copy, its cells at their columns shifted by whole columns and an even number of rows (the hex pattern kept),
// a margin of empty cells round it — and meshed there once. Drawn every frame with its body's transform (spawn frame
// → world) per vertex: the vertex's slot names its body. A break: the fragments get slots of their own (meshed with
// their crack faces), and until those are built the parent's mesh is drawn split — each vertex with the fragment
// whose seed is nearest it, those where it crumbled not at all (a ghost). Nothing is meshed again while it moves.
// The look (rockmesh.wgsl fsRock): the material from the copy's intervals, the strata, specks, facets and plants
// as at the place it came from (the spawn frame's position), lit and shadowed where it is now.

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import { CHUNK, SLOT_WORDS, fitColumn, packColumn, type Interval } from '../world/layout';
import { FieldMesh } from './fieldmesh';

const ROW_H = Math.sqrt(3) / 2;
/** a mesh chunk's side (fieldmesh.ts CHUNK: world units across, rows down) */
const MCHUNK = 32;
/** slots a column in the copy */
const K = 8;
/** column chunks of storage (each CHUNK² columns × K slots; one more, empty, for every chunk not in a slot) */
const BLOCKS = 72;
/** empty cells round a piece in its slot */
const MARGIN = 3;
/** draws (bodies, ghosts) a frame: rockmesh.wgsl RK_N */
export const RK_N = 40;
/** vec4s an entry (rockmesh.wgsl RK_STRIDE) */
const STRIDE = 12;
/** frames a slot is given to be meshed before its own mesh is drawn (a ghost's fragments till then) */
export const BUILD_FRAMES = 8;

/** One draw: a slot drawn with a transform, or (ghost) a slot drawn split between other draws' transforms. */
export interface RockDraw {
  /** the slot (RockMesh.alloc), −1: none (only its transform, for a ghost's fragments) */
  slot: number;
  /** spawn frame → world, rows of a 3×4 (rotation | translation) */
  m: number[];
  /** a ghost: its vertices go with the fragment whose seed (spawn frame) is nearest; none within `rad` of `hit` */
  ghost?: { seeds: [number, number, number, number][]; hit: [number, number, number]; rad: number };
  /**
   * (round 96) skinned to a physics body's particles instead (`m` unused): its first particle, its lattice's low
   * corner (column x, y, cell z of the spawn frame) and size — each vertex goes with the particle of its cell
   */
  skin?: { offset: number; lo: [number, number, number]; dims: [number, number, number]; mat?: number };
}

interface Slot {
  /** mesh chunks: i, j, across, down */
  rect: [number, number, number, number];
  blocks: number[];
  /** spawn frame → the copy (world units) */
  shift: [number, number, number];
  /** frame it was written */
  at: number;
}

export class RockMesh {
  readonly mesh: FieldMesh;
  readonly chunks: GPUBuffer;
  readonly layers: GPUBuffer;
  /** the draws' uniform (rockmesh.wgsl RK) */
  readonly uni: GPUBuffer;
  private table: Uint32Array;
  private free: number[] = [];
  private slots = new Map<number, Slot>();
  private nextId = 1;
  /** per mesh chunk: taken by a slot */
  private occ: Uint8Array;
  private pinned: Uint8Array;
  private mx: number;
  private my: number;
  private nxMesh: number;
  private frame = 0;
  private data = new Float32Array(4 + RK_N * STRIDE * 4);
  /** entries this frame */
  count = 0;
  stats = { slots: 0, refused: 0, written: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    profiler: Profiler,
  ) {
    const { w, h } = world;
    const cx = w / CHUNK;
    const cy = h / CHUNK;
    this.table = new Uint32Array(cx * cy * 2);
    for (let c = 0; c < cx * cy; c++) this.table.set([0, K], c * 2);
    for (let b = BLOCKS; b >= 1; b--) this.free.push(b);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.chunks = world.buf('rock chunks', this.table.byteLength, S);
    device.queue.writeBuffer(this.chunks, 0, this.table);
    this.layers = world.buf('rock layers', (BLOCKS + 1) * CHUNK * CHUNK * K * SLOT_WORDS * 4, S);
    const frames = world.buf('rock frames', world.strFrames.size, S);
    const vox = world.buf('rock vox', 16, S);
    this.mesh = new FieldMesh(device, world, profiler, true, 1, { name: 'rock', chunks: this.chunks, layers: this.layers, frames, vox, zSpan: world.zMax, slots: 4, pages: 96 });
    this.uni = device.createBuffer({ label: 'rock draws', size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // (whole mesh chunks inside the window: the last, partial ones not used)
    this.mx = Math.floor(w / MCHUNK);
    this.my = Math.floor(h / MCHUNK);
    this.nxMesh = this.mesh.chunkGrid[0];
    this.occ = new Uint8Array(this.mesh.chunkGrid[0] * this.mesh.chunkGrid[1]);
    this.pinned = new Uint8Array(this.occ.length);
  }

  /**
   * A piece (lattice cells: column x, y, cell z) into a slot of its own, to be meshed: its id and the shift from
   * its spawn frame, or null (too big, or no room: it's drawn as cubes).
   */
  alloc(cells: { x: number; y: number; z: number; mat: number }[]): { id: number; shift: [number, number, number] } | null {
    if (!cells.length || !this.mesh.on) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (const c of cells) {
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      z0 = Math.min(z0, c.z);
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
      z1 = Math.max(z1, c.z);
    }
    const zs = Math.max(0, MARGIN - z0);
    if (z1 + 1 + zs > this.world.zMax - MARGIN) return this.refuse();
    // (its size in mesh chunks, with the margins and a row to keep the rows' parity)
    const a = Math.ceil((x1 - x0 + 2 + 2 * MARGIN) / MCHUNK);
    const b = Math.ceil((y1 - y0 + 2 + 2 * MARGIN) / MCHUNK);
    if (a > 3 || b > 3) return this.refuse();
    const need = a * b * 4;
    if (this.free.length < need) return this.refuse();
    let at: [number, number] | null = null;
    for (let j = 0; j + b <= this.my && !at; j++)
      for (let i = 0; i + a <= this.mx && !at; i++) {
        let ok = true;
        for (let q = 0; q < b && ok; q++) for (let p = 0; p < a && ok; p++) if (this.occ[(j + q) * this.nxMesh + i + p]) ok = false;
        if (ok) at = [i, j];
      }
    if (!at) return this.refuse();
    const [i, j] = at;
    for (let q = 0; q < b; q++) for (let p = 0; p < a; p++) this.occ[(j + q) * this.nxMesh + i + p] = 1;
    // (columns along, rows down: an even number of rows, so the odd rows' half-cell shift is kept)
    const ox = i * MCHUNK + MARGIN - x0;
    let oy = j * MCHUNK + MARGIN - y0;
    if (oy & 1) oy++;
    const shift: [number, number, number] = [ox, oy * ROW_H, zs];
    // the columns: runs of the cells, by column chunk
    const cols = new Map<number, { x: number; y: number; cells: { z: number; mat: number }[] }>();
    for (const c of cells) {
      const x = c.x + ox;
      const y = c.y + oy;
      const k = y * 65536 + x;
      const e = cols.get(k) ?? { x, y, cells: [] };
      e.cells.push({ z: c.z + zs, mat: c.mat });
      cols.set(k, e);
    }
    const ccx = this.world.w / CHUNK;
    const blocks: number[] = [];
    const pages = new Map<number, Uint32Array>();
    for (let q = 0; q < b * 2; q++)
      for (let p = 0; p < a * 2; p++) {
        const c = (j * 2 + q) * ccx + i * 2 + p;
        const blk = this.free.pop()!;
        blocks.push(c);
        this.table[c * 2] = blk * CHUNK * CHUNK * K;
        pages.set(c, new Uint32Array(CHUNK * CHUNK * K * SLOT_WORDS));
      }
    for (const e of cols.values()) {
      e.cells.sort((p, q) => p.z - q.z);
      const col: Interval[] = [];
      for (const c of e.cells) {
        const last = col[col.length - 1];
        if (last && last.mat === c.mat && Math.abs(last.z1 - c.z) < 1e-4) last.z1 = c.z + 1;
        else if (!last || c.z >= last.z1 - 1e-4) col.push({ z0: c.z, z1: c.z + 1, mat: c.mat });
      }
      fitColumn(col, K);
      const c = Math.floor(e.y / CHUNK) * ccx + Math.floor(e.x / CHUNK);
      const page = pages.get(c);
      if (!page) continue;
      page.set(packColumn(col, K), ((e.y % CHUNK) * CHUNK + (e.x % CHUNK)) * K * SLOT_WORDS);
    }
    for (const [c, page] of pages) this.device.queue.writeBuffer(this.layers, this.table[c * 2] * SLOT_WORDS * 4, page);
    this.device.queue.writeBuffer(this.chunks, 0, this.table);
    this.mesh.packed();
    const id = this.nextId++;
    this.slots.set(id, { rect: [i, j, a, b], blocks, shift, at: this.frame });
    this.stats.slots = this.slots.size;
    this.stats.written++;
    return { id, shift };
  }

  private refuse(): null {
    this.stats.refused++;
    return null;
  }

  /** frames since slot `id` was written (Infinity: no such slot) */
  age(id: number): number {
    const s = this.slots.get(id);
    return s ? this.frame - s.at : Infinity;
  }

  /** A slot given back: its chunks empty again (meshed to nothing, their pages given back). */
  release(id: number): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    for (const c of s.blocks) {
      this.free.push(this.table[c * 2] / (CHUNK * CHUNK * K));
      this.table[c * 2] = 0;
    }
    const [i, j, a, b] = s.rect;
    for (let q = 0; q < b; q++)
      for (let p = 0; p < a; p++) {
        this.occ[(j + q) * this.nxMesh + i + p] = 0;
        this.gone.set((j + q) * this.nxMesh + i + p, 6);
      }
    this.device.queue.writeBuffer(this.chunks, 0, this.table);
    this.mesh.packed();
    this.stats.slots = this.slots.size;
  }

  /** This frame's draws (at most RK_N; the rest aren't drawn). */
  setDraws(draws: RockDraw[]): void {
    const d = this.data;
    d.fill(0);
    const n = Math.min(RK_N, draws.length);
    d[0] = n;
    for (let e = 0; e < n; e++) {
      const r = draws[e];
      const o = 4 + e * STRIDE * 4;
      const s = this.slots.get(r.slot);
      if (s) {
        const [i, j, a, b] = s.rect;
        d.set([i * MCHUNK, j * MCHUNK * ROW_H, (i + a) * MCHUNK, (j + b) * MCHUNK * ROW_H], o);
        d.set([s.shift[0], s.shift[1], s.shift[2], r.skin ? 2 : r.ghost ? 1 : 0], o + 16);
      } else d.set([1, 1, 0, 0], o);
      if (r.skin) {
        d.set([r.skin.offset, ...r.skin.lo], o + 4);
        d.set([...r.skin.dims, r.skin.mat ?? 0], o + 8);
      } else d.set(r.m, o + 4);
      if (r.ghost) {
        d.set([...r.ghost.hit, r.ghost.rad], o + 20);
        for (let k = 0; k < 6; k++) d.set(r.ghost.seeds[k] ?? [0, 0, 0, -1], o + 24 + k * 4);
      }
    }
    this.count = n;
    this.device.queue.writeBuffer(this.uni, 0, d);
  }

  /** Mesh what's changed (its slots' chunks only: they're pinned, not the camera's). */
  encode(enc: GPUCommandEncoder, cam: Parameters<FieldMesh['encode']>[1]): void {
    this.frame++;
    if (!this.slots.size && !this.releasing()) return;
    this.pinned.fill(0);
    // (a released chunk is kept pinned a few frames: meshed to nothing, its pages given back)
    for (const s of this.slots.values()) {
      const [i, j, a, b] = s.rect;
      for (let q = 0; q < b; q++) for (let p = 0; p < a; p++) this.pinned[(j + q) * this.nxMesh + i + p] = 1;
    }
    for (const [c, left] of this.gone) {
      this.pinned[c] = 1;
      if (left <= 1) this.gone.delete(c);
      else this.gone.set(c, left - 1);
    }
    this.mesh.pin(this.pinned);
    this.mesh.encode(enc, cam);
  }
  /** chunks just released: frames they're still looked at */
  private gone = new Map<number, number>();
  private releasing(): boolean {
    return this.gone.size > 0;
  }

  /** Draw the slots' chunks (the pipeline and group set: renderer.ts). */
  draw(pass: GPURenderPassEncoder): void {
    if (this.count) this.mesh.draw(pass);
  }
}
