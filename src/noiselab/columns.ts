// (round 111, BACKLOG TG1) A noise-lab record (lab.ts LabResult) as the world's columns, and as the lab's overhead
// preview. The columns are the game's own format (world/layout.ts: intervals, packed by the chunk table): rock from
// the floor, a cave's open between its floor and roof (the atlas's caves are the same — atlas/columns.wgsl
// caveVoids: gaps in a column's intervals), the rock in strata, the top material over it; the sea's water as depth
// over the columns under its level.

import { CHUNK, SLOT_WORDS, writeSlot } from '../world/layout';
import { MATERIALS } from '../world/materials';
import type { LabResult } from './lab';
import { labValues, matOf } from './params';

/** what the world's window is packed by (world/layout.ts PackedWorld's) */
export interface ChunkLayout {
  chunksX: number;
  chunkTable: Uint32Array;
  /** slots in all (the layers' length) */
  slots: number;
}

export interface LabColumns {
  /** the world's layers, packed by its chunk table */
  slots: Uint32Array;
  /** water depth a column (row-major) */
  water: Float32Array;
  /** the top's height a column (row-major) */
  surface: Float32Array;
  /** intervals in the fullest column */
  maxRuns: number;
}

/** the columns of a record (row-major in, packed by the world's chunk table out) */
export function labColumns(r: LabResult, lay: ChunkLayout): LabColumns {
  const L = labValues().lab;
  const { w, h, cols } = r;
  const slots = new Uint32Array(lay.slots * SLOT_WORDS);
  const water = new Float32Array(w * h);
  const surface = new Float32Array(w * h);
  const soil = Math.round(L.soil);
  const bandH = Math.round(L.bandH);
  const bandMat = matOf(L.bandMat);
  const sea = L.sea;
  let maxRuns = 0;
  // (a column's runs: flat, reused — a closure and arrays a column cost 60 ms over the map)
  const R0 = new Float64Array(64);
  const R1 = new Float64Array(64);
  const RM = new Int32Array(64);
  let nr = 0;
  const push = (z0: number, z1: number, mat: number) => {
    if (nr && RM[nr - 1] === mat && R1[nr - 1] === z0) R1[nr - 1] = z1;
    else {
      R0[nr] = z0;
      R1[nr] = z1;
      RM[nr++] = mat;
    }
  };
  const rock = (z0: number, z1: number, rockMat: number, room: number) => {
    if (z1 <= z0) return;
    if (!bandH || bandMat === rockMat) return push(z0, z1, rockMat);
    // strata: bands at the same heights across the map, thickened where a column has no room for them all
    let bh = bandH;
    while (Math.ceil(z1 / bh) - Math.floor(z0 / bh) > room - nr && bh < 256) bh *= 2;
    for (let z = z0; z < z1; ) {
      const b = Math.floor(z / bh);
      const e = Math.min(z1, (b + 1) * bh);
      push(z, e, b % 2 ? bandMat : rockMat);
      z = e;
    }
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const top = Math.max(1, Math.round(cols[i * 4]));
      let lo = Math.round(cols[i * 4 + 1]);
      let hi = Math.round(cols[i * 4 + 2]);
      const m = cols[i * 4 + 3];
      const topMat = m % 64;
      const rockMat = Math.floor(m / 64) % 64;
      const cliff = m >= 4096;
      // (rock to the top on a cliff: its face its own material a cell deep; elsewhere the cover `soil` deep)
      const cover = cliff ? 1 : Math.min(soil, top - 1);
      const rockTop = top - cover;
      if (!(hi - lo >= 1 && lo >= 1 && hi < rockTop)) lo = hi = 0;
      const ci = (y >> 4) * lay.chunksX + (x >> 4);
      const k = lay.chunkTable[ci * 2 + 1];
      const base = lay.chunkTable[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * k;
      // (room: what the editor builds on top keeps two slots)
      const room = k - 2 - (lo ? 1 : 0) - (cover ? 1 : 0);
      nr = 0;
      if (lo) {
        rock(0, lo, rockMat, room);
        // (the open: the next run starts above it, never merged across it)
        const at = nr;
        rock(hi, rockTop, rockMat, room);
        if (at < nr && R0[at] !== hi) throw new Error('noise lab: a cave merged shut');
      } else rock(0, rockTop, rockMat, room);
      if (cover) push(rockTop, top, topMat);
      if (nr > k) throw new Error(`noise lab: column ${x},${y} has ${nr} runs (> ${k} slots)`);
      for (let j = 0; j < nr; j++) writeSlot(slots, base + j, R0[j], R1[j], RM[j]);
      maxRuns = Math.max(maxRuns, nr);
      surface[i] = top;
      if (sea > 0 && top < sea) water[i] = sea - top;
    }
  return { slots, water, surface, maxRuns };
}

const albedo = (mat: number) => MATERIALS[mat]?.albedo ?? [1, 0, 1];

/** the record drawn from above (x right, rows down): materials, lit from the north-west, the sea over them, caves tinted */
export function drawPreview(r: LabResult, ctx: CanvasRenderingContext2D): void {
  const { w, h, cols } = r;
  const L = labValues().lab;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const H = (x: number, y: number) => cols[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z = H(x, y);
      const m = cols[i * 4 + 3];
      const a = albedo(m % 64);
      const sl = (H(x - 1, y) - H(x + 1, y)) * 0.5 + (H(x, y - 1) - H(x, y + 1)) * 0.5;
      let lit = Math.max(0.35, Math.min(1.4, 0.85 + 0.12 * sl)) * (0.75 + 0.35 * Math.min(1, z / 100));
      let c = [a[0] * lit, a[1] * lit, a[2] * lit];
      if (cols[i * 4 + 2] > cols[i * 4 + 1]) c = [c[0] * 0.6 + 0.4 * 0.9, c[1] * 0.6 + 0.1, c[2] * 0.6 + 0.4 * 0.8];
      if (L.sea > 0 && z < L.sea) {
        const t = Math.min(1, 0.45 + (L.sea - z) * 0.05);
        lit = 1;
        c = [c[0] * (1 - t) + 0.12 * t, c[1] * (1 - t) + 0.3 * t, c[2] * (1 - t) + 0.48 * t];
      }
      d[i * 4] = Math.min(255, c[0] * 255);
      d[i * 4 + 1] = Math.min(255, c[1] * 255);
      d[i * 4 + 2] = Math.min(255, c[2] * 255);
      d[i * 4 + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

/** the record's numbers (the panel's line) */
export function recordStats(r: LabResult): { min: number; max: number; caves: number; sea: number } {
  const L = labValues().lab;
  let min = 1e9;
  let max = -1e9;
  let caves = 0;
  let sea = 0;
  for (let i = 0; i < r.w * r.h; i++) {
    const z = r.cols[i * 4];
    min = Math.min(min, z);
    max = Math.max(max, z);
    if (r.cols[i * 4 + 2] > r.cols[i * 4 + 1]) caves++;
    if (L.sea > 0 && z < L.sea) sea++;
  }
  return { min, max, caves, sea };
}

