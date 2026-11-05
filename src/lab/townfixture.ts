// (round 128m, townlab) The user's start town as a lab fixture (?level=lab&lab=town; docs/TOOLING.md). The user: "copy
// the land data around the town for your own fast load tests so you see the same issues I do". Captured once from the
// full game on the user's link (scripts/labtown.mjs capture: the atlas's window round the start town as it opened, the
// town's buildings stamped into its columns, its held rivers, its heap, doors and gate posts) into data/lab/town.rclt;
// the lab loads it instead of generating anything. Pure: no GPU, no DOM (CompressionStream is in Node and browsers).
//
// The file: gzip of  u32 magic 'RCLT' | u32 header length | header JSON | pad to 4 | the columns' interval counts (u8 a
// column) | their intervals (z0 f32, z1 f32 — window z less the header's zBase — then mat u8, aux u8) | water, vegetation,
// waterSource (f32 a column) | riverFlow (4 f32 a column). Columns row-major, window order.
// GEN_VERSION (world/region-record.ts) is in the header: a fixture made by another land generator is stale — its test
// fails (test/unit/townfixture.test.ts) and it's captured again.
import { ColumnGrid, type WorldDims } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { cellAt } from '../world/lattice';
import type { LiveSpot } from '../settle/life';

const MAGIC = 0x544c4352; // 'RCLT'
export const TOWN_FIXTURE_FORMAT = 1;

export interface TownFixtureHeader {
  format: number;
  /** the land generator that made it (GEN_VERSION) */
  gen: string;
  /** the link it was captured on and when */
  link: string;
  capturedAt: string;
  /** the window's first column (world cells) and its size */
  origin: [number, number];
  dims: WorldDims;
  /** the window z the fixture's z 0 was (what's below it is stone, left out) */
  zBase: number;
  /** the sea's level (fixture z; -1e9 none) and the rivers' wetness when captured */
  seaZ: number;
  riverWet: number;
  /** the town that becomes the fortress: its record's place (window world units) and its spots (window coordinates) */
  town: { id: string; name: string; at: [number, number]; spots: LiveSpot[] };
}

export interface TownFixture {
  header: TownFixtureHeader;
  map: MapData;
}

/** what a capture reads of the live window (scripts/labtown.mjs, through the level's test API) */
export interface TownCapture {
  header: Omit<TownFixtureHeader, 'format' | 'zBase' | 'dims' | 'seaZ'> & { seaZ: number; zMaxWindow: number };
  w: number;
  h: number;
  /** per column its intervals (window z) */
  cols: { z0: number; z1: number; mat: number; aux?: number }[][];
  water: Float32Array;
  vegetation: Float32Array;
  waterSource: Float32Array;
  riverFlow: Float32Array;
}

/** room kept over the highest top (buildings' roofs, a keep's levels) */
const HEADROOM = 40;
/** stone kept under the lowest top (a pit dug, a river's bed) */
const FOOT = 12;

async function gz(bytes: Uint8Array, how: 'gzip' | 'gunzip'): Promise<Uint8Array> {
  const s = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(how === 'gzip' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The live window as a fixture's bytes: z shifted down to the lowest top less FOOT, its height the highest top plus HEADROOM. */
export async function encodeTownFixture(c: TownCapture): Promise<Uint8Array> {
  const N = c.w * c.h;
  let lo = Infinity;
  let hi = -Infinity;
  for (const col of c.cols) {
    if (!col.length) continue;
    const top = col[col.length - 1].z1;
    lo = Math.min(lo, top);
    hi = Math.max(hi, top);
  }
  const zBase = Math.max(0, Math.floor(lo - FOOT));
  const zMax = Math.min(c.header.zMaxWindow, Math.ceil((hi - zBase + HEADROOM) / 16) * 16);
  const counts = new Uint8Array(N);
  const z: number[] = [];
  const m: number[] = [];
  c.cols.forEach((col, i) => {
    let n = 0;
    for (const iv of col) {
      if (iv.z1 <= zBase) continue;
      z.push(Math.max(0, iv.z0 - zBase), iv.z1 - zBase);
      m.push(iv.mat, iv.aux ?? 0);
      n++;
    }
    if (n > 255) throw new Error(`town fixture: column ${i} has ${n} intervals`);
    counts[i] = n;
  });
  const { zMaxWindow: _z, seaZ, ...rest } = c.header;
  const header: TownFixtureHeader = { ...rest, format: TOWN_FIXTURE_FORMAT, dims: { w: c.w, h: c.h, zMax }, zBase, seaZ: seaZ > -1e8 ? seaZ - zBase : -1e9 };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pre = 8 + head.length;
  const pad = (4 - (pre % 4)) % 4;
  // (the f32 parts first after the header, so they stay aligned; the bytes after)
  const f32 = new Float32Array(z.length + N * 3 + N * 4);
  f32.set(z, 0);
  let o = z.length;
  for (const f of [c.water, c.vegetation, c.waterSource]) {
    f32.set(f.subarray(0, N), o);
    o += N;
  }
  f32.set(c.riverFlow.subarray(0, N * 4), o);
  const out = new Uint8Array(pre + pad + f32.byteLength + N + m.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, head.length, true);
  out.set(head, 8);
  let p = pre + pad;
  out.set(new Uint8Array(f32.buffer), p);
  p += f32.byteLength;
  out.set(counts, p);
  p += N;
  out.set(m, p);
  return gz(out, 'gzip');
}

/** A fixture's bytes as the lab's map: the columns, water, held rivers and woods; surface from the columns' tops. */
export async function decodeTownFixture(bytes: Uint8Array): Promise<TownFixture> {
  const raw = await gz(bytes, 'gunzip');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('town fixture: not a fixture (magic)');
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + hl))) as TownFixtureHeader;
  if (header.format !== TOWN_FIXTURE_FORMAT) throw new Error(`town fixture: format ${header.format}, this build reads ${TOWN_FIXTURE_FORMAT}`);
  const { w, h } = header.dims;
  const N = w * h;
  const p0 = 8 + hl + ((4 - ((8 + hl) % 4)) % 4);
  // (counts first, to know how many intervals the f32 part holds)
  const nCounts = N;
  const rest = raw.byteLength - p0;
  // rest = 4 * (2 I + 7 N) + N + 2 I  →  I
  const I = (rest - 28 * N - nCounts) / 10;
  if (!Number.isInteger(I) || I < 0) throw new Error('town fixture: truncated');
  const f32 = new Float32Array(raw.buffer.slice(raw.byteOffset + p0, raw.byteOffset + p0 + 4 * (2 * I + 7 * N)));
  const counts = raw.subarray(p0 + f32.byteLength, p0 + f32.byteLength + N);
  const mats = raw.subarray(p0 + f32.byteLength + N);
  const grid = new ColumnGrid(header.dims);
  const surface = new Float32Array(N);
  let k = 0;
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    for (let j = 0; j < counts[i]; j++, k++) col.push({ z0: f32[2 * k], z1: f32[2 * k + 1], mat: mats[2 * k], aux: mats[2 * k + 1] });
    surface[i] = col.length ? col[col.length - 1].z1 : 0;
  }
  const at = (o: number, n: number) => f32.slice(2 * I + o * N, 2 * I + o * N + n);
  const water = at(0, N);
  const vegetation = at(1, N);
  const waterSource = at(2, N);
  const riverFlow = at(3, 4 * N);
  const heap = header.town.spots.find((s) => s.kind === 'pile')?.w ?? header.town.at;
  const heapCell = cellAt(heap[0], heap[1]);
  const f = (n: number) => new Float32Array(n);
  const map: MapData = {
    grid,
    water,
    contam: f(N * 2),
    moisture: f(N).fill(0.35),
    vegetation,
    waterSource,
    oil: f(N),
    oilStored: f(N * 2),
    drift: f(N),
    driftMat: f(N),
    surface,
    riverFlow,
    poi: { healthy: heapCell, dam: heapCell, pool: heapCell, tutorial: heapCell, heap: heapCell },
  };
  return { header, map };
}
