// Canonical world representation (design doc §12) — the data contract every
// system reads/writes. Mirrors src/shaders/common.wgsl + layers.wgsl.
//
// Columns: an XY grid. Each column holds up to K ordered vertical intervals
// ("slots"), bottom → top. A slot is four u32 words (vec4<u32> on the GPU):
//     word 0  z0 (f32 bits, inclusive bottom; heights are fractional)
//     word 1  z1 (f32 bits, exclusive top)
//     word 2  material id | aux << 8 (aux: damage / support, structural system)
//     word 3  spare
// An empty slot has word 1 = 0 (no interval ends at 0); valid slots are
// contiguous from slot 0. (Round 22, branch strata: fractional heights so the
// loose ground can live in the same intervals as everything else.)
//
// Storage is chunked: the map is split into CHUNK×CHUNK column chunks and each
// chunk has its own slot stride K (as recommended in the handoff: most chunks
// need few layers, ruins need more). A chunk table maps chunk → (offset, K).

export const CHUNK = 16;
/** Hard upper bound on K: shaders keep a column in a fixed local array this big. */
export const MAX_K = 16;
export const MIN_K = 4;
/** Free slots every chunk gets beyond its initial need, for rubble/sediment. */
export const K_HEADROOM = 2;

export interface WorldDims {
  w: number;
  h: number;
  zMax: number; // < 256
}

/** u32 words per slot (vec4<u32> in WGSL). */
export const SLOT_WORDS = 4;

const f1 = new Float32Array(1);
const u1 = new Uint32Array(f1.buffer);
const bitsOf = (z: number) => ((f1[0] = z), u1[0]);

/** Write an interval into slot `slot` of `slots` (a slot index, not a word index). */
export function writeSlot(slots: Uint32Array, slot: number, z0: number, z1: number, mat: number, aux = 0): void {
  const o = slot * SLOT_WORDS;
  slots[o] = bitsOf(z0);
  slots[o + 1] = bitsOf(z1);
  slots[o + 2] = ((mat & 0xff) | ((aux & 0xff) << 8)) >>> 0;
  slots[o + 3] = 0;
}

/** The interval in slot `slot`, or null if the slot is empty. */
export function readSlot(slots: Uint32Array, slot: number): Interval | null {
  const o = slot * SLOT_WORDS;
  if (slots[o + 1] === 0) return null;
  const f = new Float32Array(slots.buffer, slots.byteOffset + o * 4, 2);
  const w = slots[o + 2];
  return { z0: f[0], z1: f[1], mat: w & 0xff, aux: (w >>> 8) & 0xff };
}

/** First and one-past-last whole cell an interval covers (cells whose centre lies inside it). */
export function cellRange(z0: number, z1: number): [number, number] {
  return [Math.ceil(z0 - 0.5), Math.ceil(z1 - 0.5)];
}

/** The surface buffer's packing (surface.wgsl): z in 8.8 fixed point, material, slot count. */
export const sfZ = (v: number) => (v & 0xffff) / 256;
export const sfMat = (v: number) => (v >>> 16) & 0xff;
export const sfPack = (z: number, mat: number, n = 0) => (Math.min(Math.round(Math.max(z, 0) * 256), 0xffff) | ((mat & 0xff) << 16) | ((n & 0xff) << 24)) >>> 0;

export interface Interval {
  z0: number;
  z1: number;
  mat: number;
  /** aux byte (support·16 + damage) when read back from the GPU; 0 if absent */
  aux?: number;
}

/** CPU-side authoring representation used by map generation only. */
export class ColumnGrid {
  readonly cols: Interval[][];
  constructor(readonly dims: WorldDims) {
    this.cols = Array.from({ length: dims.w * dims.h }, () => []);
  }
  col(x: number, y: number): Interval[] {
    return this.cols[y * this.dims.w + x];
  }
  top(x: number, y: number): number {
    const c = this.col(x, y);
    return c.length ? c[c.length - 1].z1 : 0;
  }
  topMat(x: number, y: number): number {
    const c = this.col(x, y);
    return c.length ? c[c.length - 1].mat : 0;
  }
  /** Remove everything above z (excavation). */
  cut(x: number, y: number, z: number): void {
    const c = this.col(x, y);
    while (c.length && c[c.length - 1].z0 >= z) c.pop();
    const last = c[c.length - 1];
    if (last && last.z1 > z) last.z1 = z;
  }
  /** Append an interval above the current top (merging with an identical material below it). */
  push(x: number, y: number, z0: number, z1: number, mat: number): void {
    if (z1 <= z0) return;
    const c = this.col(x, y);
    const last = c[c.length - 1];
    if (last && z0 < last.z1) throw new Error(`interval overlap at ${x},${y}`);
    if (last && last.z1 === z0 && last.mat === mat) last.z1 = z1;
    else c.push({ z0, z1, mat });
  }
}

export interface PackedWorld {
  dims: WorldDims;
  chunksX: number;
  chunksY: number;
  /** Per chunk: [slotOffset, K] (in slots) */
  chunkTable: Uint32Array;
  /** SLOT_WORDS u32 per slot */
  slots: Uint32Array;
  maxK: number;
}

/** @param minK slots every chunk gets at least (the sandbox wants room to stack models) */
export function packColumns(grid: ColumnGrid, minK = MIN_K): PackedWorld {
  const { w, h, zMax } = grid.dims;
  if (w % CHUNK || h % CHUNK) throw new Error(`map size must be a multiple of ${CHUNK}`);
  if (zMax > 255) throw new Error('zMax must fit in 8 bits');
  const chunksX = w / CHUNK;
  const chunksY = h / CHUNK;
  const chunkTable = new Uint32Array(chunksX * chunksY * 2);
  let offset = 0;
  let maxK = 0;
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      let need = 0;
      for (let ly = 0; ly < CHUNK; ly++)
        for (let lx = 0; lx < CHUNK; lx++) need = Math.max(need, grid.col(cx * CHUNK + lx, cy * CHUNK + ly).length);
      const k = Math.max(minK, need + K_HEADROOM);
      if (k > MAX_K) throw new Error(`chunk ${cx},${cy} needs ${k} slots (> MAX_K ${MAX_K})`);
      const ci = cy * chunksX + cx;
      chunkTable[ci * 2] = offset;
      chunkTable[ci * 2 + 1] = k;
      offset += k * CHUNK * CHUNK;
      maxK = Math.max(maxK, k);
    }
  }
  const slots = new Uint32Array(offset * SLOT_WORDS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(y / CHUNK) * chunksX + Math.floor(x / CHUNK);
      const base = chunkTable[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * chunkTable[ci * 2 + 1];
      const col = grid.col(x, y);
      col.forEach((iv, i) => {
        if (iv.z1 > zMax) throw new Error(`interval above zMax at ${x},${y}`);
        writeSlot(slots, base + i, iv.z0, iv.z1, iv.mat);
      });
    }
  }
  return { dims: grid.dims, chunksX, chunksY, chunkTable, slots, maxK };
}

/** Where column (x, y) lives in packed slots: first slot and slot count K (slot indices). */
export function columnSlots(p: PackedWorld, x: number, y: number): { base: number; k: number } {
  const ci = Math.floor(y / CHUNK) * p.chunksX + Math.floor(x / CHUNK);
  const k = p.chunkTable[ci * 2 + 1];
  return { base: p.chunkTable[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * k, k };
}

/** The intervals of column (x, y) in packed slots (e.g. read back from the GPU). */
export function readColumn(p: PackedWorld, slots: Uint32Array, x: number, y: number): Interval[] {
  const { base, k } = columnSlots(p, x, y);
  const out: Interval[] = [];
  for (let s = 0; s < k; s++) {
    const iv = readSlot(slots, base + s);
    if (!iv) break;
    out.push(iv);
  }
  return out;
}

/** Column (x, y) packed into its K slots (empty slots zeroed), ready to write at slot `base`. */
export function packColumn(col: Interval[], k: number): Uint32Array {
  const data = new Uint32Array(k * SLOT_WORDS);
  col.forEach((iv, s) => writeSlot(data, s, iv.z0, iv.z1, iv.mat, iv.aux ?? 0));
  return data;
}

// ---- a window onto taller columns (round 69: the streamed window slides in z) ----

/** Column `col` (world z) cut at the window [oz, oz + zMax): what's in it (window z) and what's outside it (world z, below then above). */
export function splitColumn(col: Interval[], oz: number, zMax: number): { inside: Interval[]; outside: Interval[] } {
  const inside: Interval[] = [];
  const outside: Interval[] = [];
  const hi = oz + zMax;
  for (const iv of col) {
    if (iv.z0 < oz) outside.push({ z0: iv.z0, z1: Math.min(iv.z1, oz), mat: iv.mat });
    if (iv.z1 > oz && iv.z0 < hi) inside.push({ z0: Math.max(iv.z0, oz) - oz, z1: Math.min(iv.z1, hi) - oz, mat: iv.mat, aux: iv.aux });
    if (iv.z1 > hi) outside.push({ z0: Math.max(iv.z0, hi), z1: iv.z1, mat: iv.mat });
  }
  return { inside, outside };
}

/** The whole column again (world z): what's in the window at oz, and what's outside it; pieces cut at the window's edges joined. */
export function joinColumn(inside: Interval[], oz: number, outside: Interval[]): Interval[] {
  const all = [...outside.map((iv) => ({ z0: iv.z0, z1: iv.z1, mat: iv.mat })), ...inside.map((iv) => ({ z0: iv.z0 + oz, z1: iv.z1 + oz, mat: iv.mat, aux: iv.aux }))].sort((a, b) => a.z0 - b.z0);
  const out: Interval[] = [];
  for (const iv of all) {
    const last = out[out.length - 1];
    if (last && last.mat === iv.mat && Math.abs(iv.z0 - last.z1) < 1e-4) last.z1 = Math.max(last.z1, iv.z1);
    else out.push(iv);
  }
  return out;
}

/** At most k intervals: the neighbours closest to being one (the gap between them and the thinner's
 *  thickness least) become one, of the thicker's material, until it fits. Whether it had to. */
export function fitColumn(col: Interval[], k: number): boolean {
  if (col.length <= k) return false;
  const cost = (i: number) => col[i].z0 - col[i - 1].z1 + Math.min(col[i].z1 - col[i].z0, col[i - 1].z1 - col[i - 1].z0);
  while (col.length > k) {
    let best = 1;
    for (let i = 2; i < col.length; i++) if (cost(i) < cost(best)) best = i;
    const lo = col[best - 1];
    const hi = col[best];
    const mat = hi.z1 - hi.z0 > lo.z1 - lo.z0 ? hi.mat : lo.mat;
    col.splice(best - 1, 2, { z0: lo.z0, z1: hi.z1, mat });
  }
  return true;
}
