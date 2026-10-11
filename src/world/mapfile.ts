// Saved maps (BACKLOG F6/E8): a sandbox world captured from the GPU, written
// as one gzip-compressed binary — a JSON header (version, dims, poi, the
// field list) followed by the raw arrays — so the user can keep maps in the
// browser (IndexedDB) or as files (".reclaimed"), and load them back as a
// level (and so they can later become real levels: B7).

import { CHUNK, ColumnGrid, columnSlots, readSlot, SLOT_WORDS, writeSlot, type PackedWorld } from './layout';
import type { MapData } from './mapgen';

const MAGIC = 'RCLM';
// 2: fractional intervals, four words per slot (branch strata)
const VERSION = 2;

/** Float fields saved per map, in file order. */
const FIELDS = ['water', 'contam', 'moisture', 'vegetation', 'oil', 'drift', 'oilStored', 'waterSource', 'surface', 'driftMat', 'driftTop', 'strata'] as const;

interface Header {
  version: number;
  dims: { w: number; h: number; zMax: number };
  poi: Record<string, [number, number]>;
  /** byte length of the packed column slots, then each field's float count */
  slots: number;
  fields: Record<string, number>;
  /** chunk table (offset, K) the slots are laid out in */
  chunkTable: number[];
}

/** Rebuild the authoring grid from packed slots (as the GPU holds them). */
export function unpackColumns(packed: PackedWorld, slots: Uint32Array): ColumnGrid {
  const grid = new ColumnGrid(packed.dims);
  const { w, h } = packed.dims;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const { base, k } = columnSlots(packed, x, y);
      const col = grid.col(x, y);
      for (let s = 0; s < k; s++) {
        const iv = readSlot(slots, base + s);
        if (!iv) break;
        col.push({ z0: iv.z0, z1: iv.z1, mat: iv.mat });
      }
    }
  return grid;
}

/** Version-1 files: one u32 per slot (z0, z1 whole cells, material bytes) → the current layout. */
function slotsFromV1(old: Uint32Array): Uint32Array {
  const out = new Uint32Array(old.length * SLOT_WORDS);
  old.forEach((v, i) => {
    if (v !== 0) writeSlot(out, i, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff);
  });
  return out;
}

/** Pack a grid back into one slot per interval, chunk by chunk (layout.ts order). */
function flatSlots(grid: ColumnGrid): { table: number[]; slots: Uint32Array } {
  const { w, h } = grid.dims;
  const cx = w / CHUNK;
  const cy = h / CHUNK;
  const table: number[] = [];
  let off = 0;
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) {
      let k = 1;
      for (let ly = 0; ly < CHUNK; ly++) for (let lx = 0; lx < CHUNK; lx++) k = Math.max(k, grid.col(i * CHUNK + lx, j * CHUNK + ly).length);
      table.push(off, k);
      off += k * CHUNK * CHUNK;
    }
  const slots = new Uint32Array(off * SLOT_WORDS);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK);
      const base = table[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * table[ci * 2 + 1];
      grid.col(x, y).forEach((iv, s) => writeSlot(slots, base + s, iv.z0, iv.z1, iv.mat));
    }
  return { table, slots };
}

export async function encodeMap(map: MapData): Promise<Blob> {
  const { table, slots } = flatSlots(map.grid);
  const header: Header = {
    version: VERSION,
    dims: { ...map.grid.dims },
    poi: map.poi,
    slots: slots.byteLength,
    fields: Object.fromEntries(FIELDS.map((f) => [f, (map[f] ?? new Float32Array(map.drift.length)).length])),
    chunkTable: table,
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pre = new Uint8Array(8);
  pre.set(new TextEncoder().encode(MAGIC));
  new DataView(pre.buffer).setUint32(4, head.byteLength, true);
  // float arrays need 4-byte alignment when read back: pad the header
  const pad = new Uint8Array((4 - ((8 + head.byteLength) % 4)) % 4);
  const parts: BlobPart[] = [pre, head, pad, slots as Uint32Array<ArrayBuffer>, ...FIELDS.map((f) => (map[f] ?? new Float32Array(map.drift.length)) as Float32Array<ArrayBuffer>)];
  const raw = new Blob(parts);
  return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function decodeMap(blob: Blob): Promise<MapData> {
  const buf = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== MAGIC) throw new Error('not a Reclaimed map file');
  const headLen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen))) as Header;
  if (header.version !== VERSION && header.version !== 1) throw new Error(`map file version ${header.version} (this build reads ${VERSION})`);
  let off = 8 + headLen;
  off += (4 - (off % 4)) % 4;
  const raw = new Uint32Array(buf, off, header.slots / 4);
  const slots = header.version === 1 ? slotsFromV1(raw) : raw;
  off += header.slots;
  const { w, h } = header.dims;
  const packed: PackedWorld = {
    dims: header.dims,
    chunksX: w / CHUNK,
    chunksY: h / CHUNK,
    chunkTable: Uint32Array.from(header.chunkTable),
    slots,
    maxK: 0,
  };
  const grid = unpackColumns(packed, slots);
  const fields: Record<string, Float32Array> = {};
  for (const f of FIELDS) {
    // (files from before a field existed simply lack it)
    const n = header.fields[f] ?? 0;
    fields[f] = new Float32Array(buf.slice(off, off + n * 4));
    off += n * 4;
  }
  return {
    grid,
    water: fields.water,
    contam: fields.contam,
    moisture: fields.moisture,
    vegetation: fields.vegetation,
    oil: fields.oil,
    drift: fields.drift,
    driftMat: fields.driftMat.length ? fields.driftMat : undefined,
    driftTop: fields.driftTop.length ? fields.driftTop : undefined,
    strata: fields.strata.length === fields.drift.length * 4 ? fields.strata : undefined,
    oilStored: fields.oilStored,
    waterSource: fields.waterSource,
    surface: fields.surface,
    poi: header.poi,
  };
}

// ---- browser storage (IndexedDB: maps are ~1 MB, beyond localStorage) -------

const DB = 'reclaimed';
const STORE = 'maps';

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((res, rej) => {
        const r = f(d.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }),
  );
}

export const savedMaps = {
  list: () => tx('readonly', (s) => s.getAllKeys()).then((k) => (k as string[]).sort()),
  save: (name: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, name)),
  load: (name: string) => tx<Blob>('readonly', (s) => s.get(name)),
  remove: (name: string) => tx('readwrite', (s) => s.delete(name)),
};
