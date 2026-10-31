// The rigid rock's own mesh (round 95, `?rockbody=1`; the user: "the rigidbody sim should definitely render the mesh
// not cubes. It can use cubes to simulate the motion but just anchor the vertices to the cubes"). A field mesh of
// its own (fieldmesh.ts, like the band's: the same mesher, the same look) over a sparse copy of the layers that holds
// only the pieces in flight: each piece, when it breaks free, is written into a slot — a region of that copy, its
// cells at their columns shifted by whole columns and an even number of rows (the hex pattern kept), a margin of empty
// cells round it — and meshed there once. Drawn every frame with its body's transform (spawn frame → world) per
// vertex: the vertex's region names its body. A break: the fragments get slots of their own (meshed with their crack
// faces), and until those are built the parent's mesh is drawn split — each vertex with the fragment whose seed is
// nearest it, those where it crumbled not at all (a ghost). Nothing is meshed again while it moves.
// The look (rockmesh.wgsl fsRock): the material from the copy's intervals, the strata, specks, facets and plants
// as at the place it came from (the spawn frame's position), lit and shadowed where it is now.
//
// (Round 120, the rules "no fallbacks" and "no GPU memory caps": every rock body is this mesh. The copy is packed in
// squares of G columns, regions sharing mesh chunks; its storage and its draws grow on demand to what one binding of
// the device holds; the copy full — the window's whole area taken by pieces and their margins — the caller lets the
// resting rock go back to ground first (Integrity.allocRock), and past that it throws.)

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import { CHUNK, SLOT_WORDS, fitColumn, packColumn, type Interval } from '../world/layout';
import { FieldMesh } from './fieldmesh';

const ROW_H = Math.sqrt(3) / 2;
/** a mesh chunk's side (fieldmesh.ts CHUNK: world units across, rows down) */
const MCHUNK = 32;
/** slots a column in the copy */
const K = 8;
/** column chunks of storage to start with (each CHUNK² columns × K slots; one more, empty, for every chunk not in a
 *  slot) — grown on demand to what one binding of the device holds */
const BLOCKS = 72;
/** empty cells round a piece in its slot */
const MARGIN = 3;
/** the copy is packed in squares of this many columns and rows (rows a multiple of 2: the hex parity) */
const G = 4;
/** draws (bodies, ghosts) a frame to start with: grown on demand (rockmesh.wgsl reads them from a storage buffer) */
const RK_START = 64;
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
   * (solver step 2) skinned to a node-solver body's nodes instead (`m` unused): its slot, its rest centre of mass (the
   * spawn frame), its nodes, the material it's drawn as — each vertex goes with the nodes nearest where it was bound
   */
  skin?: { slot: number; com: [number, number, number]; nodes: number; mat?: number };
  /**
   * (round 120) skinned to a voxel-lattice body's particles instead (`m` unused): its first particle, its lattice's
   * low corner (storage column, row, cell z) and size — each vertex goes with the particles of the cells round it
   */
  lattice?: { offset: number; lo: [number, number, number]; dims: [number, number, number] };
}

interface Slot {
  /** its region of the copy: column, row, columns, rows (multiples of G) */
  region: [number, number, number, number];
  /** the column chunks it writes into, and the mesh chunks it lies in */
  chunks: number[];
  meshChunks: number[];
  /** its columns in the copy (emptied when it goes) */
  cols: [number, number][];
  /** spawn frame → the copy (world units) */
  shift: [number, number, number];
  /** frame it was written */
  at: number;
}

type Source = { name: string; chunks: GPUBuffer; layers: GPUBuffer; frames: GPUBuffer; vox: GPUBuffer; zSpan: number; slots: number; pages: number };

export class RockMesh {
  readonly mesh: FieldMesh;
  readonly chunks: GPUBuffer;
  /** the copy's storage (grows: growBlocks) */
  layers: GPUBuffer;
  /** the draws (rockmesh.wgsl RKD; grows with them) */
  uni: GPUBuffer;
  /** (round 120) the buffers made again (grown): the renderer's groups are to be made again */
  onBuffers?: () => void;
  private src: Source;
  private table: Uint32Array;
  private free: number[] = [];
  private blocks = BLOCKS;
  private slots = new Map<number, Slot>();
  private nextId = 1;
  /** the copy's squares (G × G columns and rows) taken */
  private occ: Uint8Array;
  private gx: number;
  private gy: number;
  /** per column chunk: slots writing into it (its block given back at 0), its page; per mesh chunk: slots in it */
  private chunkRef = new Map<number, number>();
  private pages = new Map<number, Uint32Array>();
  private meshRef: Uint16Array;
  private pinned: Uint8Array;
  private nxMesh: number;
  private frame = 0;
  private data: Float32Array;
  /** entries this frame */
  count = 0;
  stats = { slots: 0, refused: 0, written: 0, tall: 0, grown: 0, draws: 0 };

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
    this.layers = world.buf('rock layers', (BLOCKS + 1) * CHUNK * CHUNK * K * SLOT_WORDS * 4, S | GPUBufferUsage.COPY_SRC);
    const frames = world.buf('rock frames', world.strFrames.size, S);
    const vox = world.buf('rock vox', 16, S);
    this.src = { name: 'rock', chunks: this.chunks, layers: this.layers, frames, vox, zSpan: world.zMax, slots: 4, pages: 96 };
    this.mesh = new FieldMesh(device, world, profiler, true, 1, this.src);
    this.data = new Float32Array(4 + RK_START * STRIDE * 4);
    this.uni = world.buf('rock draws', this.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    // (whole mesh chunks inside the window: the last, partial ones not used)
    this.gx = Math.floor(w / MCHUNK) * (MCHUNK / G);
    this.gy = Math.floor(h / MCHUNK) * (MCHUNK / G);
    this.occ = new Uint8Array(this.gx * this.gy);
    this.nxMesh = this.mesh.chunkGrid[0];
    this.meshRef = new Uint16Array(this.mesh.chunkGrid[0] * this.mesh.chunkGrid[1]);
    this.pinned = new Uint8Array(this.meshRef.length);
  }

  /** the most column chunks of storage one binding of the device holds */
  private mostBlocks(): number {
    const lim = this.device.limits;
    return Math.floor(Math.min(lim.maxStorageBufferBindingSize, lim.maxBufferSize) / (CHUNK * CHUNK * K * SLOT_WORDS * 4)) - 1;
  }

  /** room for `n` more blocks: the storage doubled (its contents copied over, the mesher's and the draws' groups made again) */
  private growBlocks(n: number): void {
    if (this.free.length >= n) return;
    const used = this.blocks - this.free.length;
    const most = this.mostBlocks();
    let want = this.blocks;
    while (want - used < n && want < most) want = Math.min(most, want * 2);
    if (want - used < n) throw new Error(`rock mesh: ${used + n} chunks of its copy won't fit one binding on this device (${most})`);
    const bytes = CHUNK * CHUNK * K * SLOT_WORDS * 4;
    const layers = this.world.buf('rock layers', (want + 1) * bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const enc = this.device.createCommandEncoder({ label: 'rock layers grow' });
    enc.copyBufferToBuffer(this.layers, 0, layers, 0, this.layers.size);
    this.device.queue.submit([enc.finish()]);
    for (let b = want; b > this.blocks; b--) this.free.unshift(b);
    this.blocks = want;
    // (the frames in flight may still read the old one: let go a few frames on)
    this.retired.push({ buf: this.layers, frames: 3 });
    this.layers = layers;
    this.src.layers = layers;
    this.mesh.sourceChanged();
    this.stats.grown++;
    this.onBuffers?.();
  }

  /** how many blocks it holds now (its storage's room) */
  get blockRoom(): number {
    return this.blocks;
  }

  /**
   * A piece (lattice cells: column x, y, cell z) into a slot of its own, to be meshed: its id and the shift from its
   * spawn frame; null when the copy has no region free for it (the caller lets resting rock go and asks again).
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
    // (taller than the window: it can't be in it)
    if (z1 + 1 + zs > this.world.zMax - MARGIN) throw new Error(`rock mesh: a piece ${z1 - z0 + 1} cells tall won't fit the window's ${this.world.zMax}`);
    // (its region of the copy, in squares of G: the margins, and a row to keep the rows' parity)
    const a = Math.ceil((x1 - x0 + 2 + 2 * MARGIN) / G);
    const b = Math.ceil((y1 - y0 + 2 + 2 * MARGIN) / G);
    let at: [number, number] | null = null;
    for (let j = 0; j + b <= this.gy && !at; j++)
      for (let i = 0; i + a <= this.gx && !at; i++) {
        let ok = true;
        for (let q = 0; q < b && ok; q++) for (let p = 0; p < a && ok; p++) if (this.occ[(j + q) * this.gx + i + p]) ok = false;
        if (ok) at = [i, j];
      }
    if (!at) {
      this.stats.refused++;
      return null;
    }
    const [i, j] = at;
    for (let q = 0; q < b; q++) for (let p = 0; p < a; p++) this.occ[(j + q) * this.gx + i + p] = 1;
    const rx = i * G;
    const ry = j * G;
    // (columns along, rows down: an even number of rows, so the odd rows' half-cell shift is kept)
    const ox = rx + MARGIN - x0;
    let oy = ry + MARGIN - y0;
    if (oy & 1) oy++;
    const shift: [number, number, number] = [ox, oy * ROW_H, zs];
    const ccx = this.world.w / CHUNK;
    // the column chunks and the mesh chunks its region touches
    const chunks: number[] = [];
    for (let cy = Math.floor(ry / CHUNK); cy <= Math.floor((ry + b * G - 1) / CHUNK); cy++)
      for (let cx = Math.floor(rx / CHUNK); cx <= Math.floor((rx + a * G - 1) / CHUNK); cx++) chunks.push(cy * ccx + cx);
    const meshChunks: number[] = [];
    for (let my = Math.floor(ry / MCHUNK); my <= Math.floor((ry + b * G - 1) / MCHUNK); my++)
      for (let mx = Math.floor(rx / MCHUNK); mx <= Math.floor((rx + a * G - 1) / MCHUNK); mx++) meshChunks.push(my * this.nxMesh + mx);
    this.growBlocks(chunks.filter((c) => !this.chunkRef.get(c)).length);
    for (const c of chunks) {
      const r = this.chunkRef.get(c) ?? 0;
      if (!r) {
        this.table[c * 2] = this.free.pop()! * CHUNK * CHUNK * K;
        this.pages.set(c, new Uint32Array(CHUNK * CHUNK * K * SLOT_WORDS));
      }
      this.chunkRef.set(c, r + 1);
    }
    for (const m of meshChunks) this.meshRef[m]++;
    // the columns: runs of the cells
    const cols = new Map<number, { x: number; y: number; cells: { z: number; mat: number }[] }>();
    for (const c of cells) {
      const x = c.x + ox;
      const y = c.y + oy;
      const k = y * 65536 + x;
      const e = cols.get(k) ?? { x, y, cells: [] };
      e.cells.push({ z: c.z + zs, mat: c.mat });
      cols.set(k, e);
    }
    const written = new Set<number>();
    const colList: [number, number][] = [];
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
      const page = this.pages.get(c);
      if (!page) throw new Error(`rock mesh: column ${e.x}, ${e.y} outside its region`);
      page.set(packColumn(col, K), ((e.y % CHUNK) * CHUNK + (e.x % CHUNK)) * K * SLOT_WORDS);
      written.add(c);
      colList.push([e.x, e.y]);
    }
    for (const c of written) this.device.queue.writeBuffer(this.layers, this.table[c * 2] * SLOT_WORDS * 4, this.pages.get(c)!);
    this.device.queue.writeBuffer(this.chunks, 0, this.table);
    this.mesh.packed();
    const id = this.nextId++;
    this.slots.set(id, { region: [rx, ry, a * G, b * G], chunks, meshChunks, cols: colList, shift, at: this.frame });
    this.stats.slots = this.slots.size;
    this.stats.written++;
    return { id, shift };
  }

  /** frames since slot `id` was written (Infinity: no such slot) */
  age(id: number): number {
    const s = this.slots.get(id);
    return s ? this.frame - s.at : Infinity;
  }

  /** slots held now */
  get held(): number {
    return this.slots.size;
  }

  /** A slot given back: its columns emptied, its chunks' blocks given back once nothing else is in them. */
  release(id: number): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    const ccx = this.world.w / CHUNK;
    const empty = new Uint32Array(K * SLOT_WORDS);
    const touched = new Set<number>();
    for (const [x, y] of s.cols) {
      const c = Math.floor(y / CHUNK) * ccx + Math.floor(x / CHUNK);
      this.pages.get(c)?.set(empty, ((y % CHUNK) * CHUNK + (x % CHUNK)) * K * SLOT_WORDS);
      touched.add(c);
    }
    for (const c of s.chunks) {
      const r = (this.chunkRef.get(c) ?? 1) - 1;
      if (r > 0) {
        this.chunkRef.set(c, r);
        if (touched.has(c)) this.device.queue.writeBuffer(this.layers, this.table[c * 2] * SLOT_WORDS * 4, this.pages.get(c)!);
        continue;
      }
      this.chunkRef.delete(c);
      this.pages.delete(c);
      this.free.push(this.table[c * 2] / (CHUNK * CHUNK * K));
      this.table[c * 2] = 0;
    }
    for (const m of s.meshChunks) {
      this.meshRef[m]--;
      this.gone.set(m, 6);
    }
    const [rx, ry, rw, rh] = s.region;
    for (let q = ry / G; q < (ry + rh) / G; q++) for (let p = rx / G; p < (rx + rw) / G; p++) this.occ[q * this.gx + p] = 0;
    this.device.queue.writeBuffer(this.chunks, 0, this.table);
    this.mesh.packed();
    this.stats.slots = this.slots.size;
  }

  /** This frame's draws, all of them (their buffer grows with them). */
  setDraws(draws: RockDraw[], alpha = 1): void {
    const n = draws.length;
    if (4 + n * STRIDE * 4 > this.data.length) {
      let room = (this.data.length - 4) / (STRIDE * 4);
      while (room < n) room *= 2;
      this.data = new Float32Array(4 + room * STRIDE * 4);
      this.uni = this.world.buf('rock draws', this.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.onBuffers?.();
    }
    const d = this.data;
    d.fill(0);
    this.stats.draws = n;
    d[0] = n;
    // (solver step 2: where the frame lies between the solver's last two ticks — its skinned draws are drawn there)
    d[1] = alpha;
    for (let e = 0; e < n; e++) {
      const r = draws[e];
      const o = 4 + e * STRIDE * 4;
      const s = this.slots.get(r.slot);
      if (s) {
        // (its region: a vertex of its mesh lies in it — the margins keep the next region's out)
        const [rx, ry, rw, rh] = s.region;
        d.set([rx, ry * ROW_H, rx + rw + 1, (ry + rh) * ROW_H], o);
        d.set([s.shift[0], s.shift[1], s.shift[2], r.lattice ? 3 : r.skin ? 2 : r.ghost ? 1 : 0], o + 16);
      } else {
        // (no mesh of its own: only a ghost's vertices go with it — skinned, round 120, or by its matrix)
        d.set([1, 1, 0, 0], o);
        d.set([0, 0, 0, r.skin ? 2 : 0], o + 16);
      }
      if (r.lattice) {
        d.set([r.lattice.offset, ...r.lattice.lo], o + 4);
        d.set([...r.lattice.dims, 0], o + 8);
      } else if (r.skin) {
        d.set([r.skin.slot, ...r.skin.com], o + 4);
        d.set([r.skin.nodes, 0, 0, r.skin.mat ?? 0], o + 8);
      } else d.set(r.m, o + 4);
      if (r.ghost) {
        d.set([...r.ghost.hit, r.ghost.rad], o + 20);
        for (let k = 0; k < 6; k++) d.set(r.ghost.seeds[k] ?? [0, 0, 0, -1], o + 24 + k * 4);
      }
    }
    this.count = n;
    this.device.queue.writeBuffer(this.uni, 0, d, 0, 4 + n * STRIDE * 4);
  }

  /** Mesh what's changed (its slots' chunks only: they're pinned, not the camera's). */
  private retired: { buf: GPUBuffer; frames: number }[] = [];
  encode(enc: GPUCommandEncoder, cam: Parameters<FieldMesh['encode']>[1]): void {
    this.frame++;
    for (const r of this.retired) if (--r.frames <= 0) r.buf.destroy();
    this.retired = this.retired.filter((r) => r.frames > 0);
    if (!this.slots.size && !this.releasing()) return;
    this.pinned.fill(0);
    for (let m = 0; m < this.meshRef.length; m++) if (this.meshRef[m]) this.pinned[m] = 1;
    // (a released chunk is kept pinned a few frames: meshed again without it)
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
