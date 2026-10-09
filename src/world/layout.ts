// Canonical world representation (design doc §12) — the data contract every
// system reads/writes. Mirrors src/shaders/common.wgsl + layers.wgsl.
//
// Columns: an XY grid. Each column holds up to K ordered vertical intervals
// ("slots"), bottom → top, packed into one u32:
//     bits  0..7   z0   (inclusive bottom)
//     bits  8..15  z1   (exclusive top)
//     bits 16..23  material id
//     bits 24..31  aux  (damage / flags — reserved for structural system)
// A slot value of 0 means "empty"; valid slots are contiguous from slot 0.
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

export function packInterval(z0: number, z1: number, mat: number, aux = 0): number {
  return ((z0 & 0xff) | ((z1 & 0xff) << 8) | ((mat & 0xff) << 16) | ((aux & 0xff) << 24)) >>> 0;
}

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
  /** Per chunk: [slotOffset, K] */
  chunkTable: Uint32Array;
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
  const slots = new Uint32Array(offset);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(y / CHUNK) * chunksX + Math.floor(x / CHUNK);
      const base = chunkTable[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * chunkTable[ci * 2 + 1];
      const col = grid.col(x, y);
      col.forEach((iv, i) => {
        if (iv.z1 > zMax) throw new Error(`interval above zMax at ${x},${y}`);
        slots[base + i] = packInterval(iv.z0, iv.z1, iv.mat);
      });
    }
  }
  return { dims: grid.dims, chunksX, chunksY, chunkTable, slots, maxK };
}

/** Where column (x, y) lives in packed slots: first slot and slot count K. */
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
    const v = slots[base + s];
    if (v === 0) break;
    out.push({ z0: v & 0xff, z1: (v >>> 8) & 0xff, mat: (v >>> 16) & 0xff, aux: v >>> 24 });
  }
  return out;
}
