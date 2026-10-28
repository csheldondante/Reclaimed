// A region's record (round 100, `regionstore`; docs/ARCHITECTURE.md "Region storage"). The user (DECISIONS round
// 100): "I want the world to serialize so we can recover the visited cells that change … lean towards the whole
// region until we know we need the other."
//
// One layout serves every tier: the GPU pool's slot (scenes/region-pool.ts), the staging a slot is read back
// through, and the body of the disk record are the same bytes —
//   the region's chunk pages (rc × rc pages of K × CHUNK² slots, SLOT_WORDS words each, row-major in the region),
//   then each kept per-column buffer (per plane, R rows of R × stride bytes),
//   then each kept texture (R / div rows of align256(texels × 16) bytes; rgba32float).
// A record is that body with a header and the region's CPU parts (what's outside the window per column, the
// surface, the ground, the relief) and its things (meshes with transforms that own cells: sim/external.ts):
//   u32 magic 'RCLR' | u32 header length | header JSON (utf-8) | sections, each 16-byte aligned, at the offsets
//   the header lists.
// The format version is RECORD_FORMAT; GEN_VERSION is the land generator's (bump it when the atlas's or
// streamgen's land changes: a record made by another is reported and the region made again). `sig` is the layout's
// own signature (K, the kept fields and their strides): a record of another layout is made again too.

import { CHUNK, SLOT_WORDS, type Interval } from './layout';
import { MATERIALS, MatState } from './materials';

export const RECORD_MAGIC = 0x524c4352;
/** the record's own format */
export const RECORD_FORMAT = 1;
/** the land generator's version: bump when what a region is made of changes (the atlas, streamgen, the hooks) */
export const GEN_VERSION = 1;

export interface LayoutBuf {
  name: string;
  stride: number;
  planes: number;
  off: number;
  bytes: number;
}

export interface LayoutTex {
  name: string;
  per: number;
  div: number;
  /** texels a row, rows */
  tw: number;
  th: number;
  rowBytes: number;
  off: number;
  bytes: number;
}

/** where each part of a region lives in its bytes (a pool slot, a staging buffer, a record's body) */
export interface RegionLayout {
  R: number;
  K: number;
  /** pages a side (R / CHUNK) */
  rc: number;
  pageBytes: number;
  bufs: LayoutBuf[];
  texs: LayoutTex[];
  /** the whole region (a multiple of 256: slots one after another stay aligned for copyBufferToTexture) */
  bytes: number;
  sig: string;
}

const align = (n: number, a: number) => Math.ceil(n / a) * a;

/** `tag`: what else a record of this layout depends on (the window's height: a zmesh full-height window's regions and a sliding window's can't be confused) */
export function regionLayout(R: number, K: number, bufs: { name: string; stride: number; planes: number }[], texs: { name: string; per: number; div: number }[], tag = ''): RegionLayout {
  const rc = R / CHUNK;
  const pageBytes = K * CHUNK * CHUNK * SLOT_WORDS * 4;
  let off = rc * rc * pageBytes;
  const lb: LayoutBuf[] = bufs.map((b) => {
    const bytes = R * R * b.stride * b.planes;
    const o = { ...b, off, bytes };
    off = align(off + bytes, 256);
    return o;
  });
  const lt: LayoutTex[] = texs.map((t) => {
    const tw = (R / t.div) * t.per;
    const th = R / t.div;
    const rowBytes = align(tw * 16, 256);
    const o = { ...t, tw, th, rowBytes, off, bytes: rowBytes * th };
    off = align(off + rowBytes * th, 256);
    return o;
  });
  const sig = `R${R}K${K}${tag}|${bufs.map((b) => `${b.name}:${b.stride}x${b.planes}`).join(',')}|${texs.map((t) => `${t.name}:${t.per}/${t.div}`).join(',')}`;
  return { R, K, rc, pageBytes, bufs: lb, texs: lt, bytes: align(off, 256), sig };
}

/** a region's CPU parts (what the window keeps per column on the CPU) */
export interface RegionMeta {
  oz: number;
  /** per column (row-major in the region): its intervals outside the window (world z) */
  outside: Interval[][];
  surface: Float32Array;
  ground?: Float32Array;
  relief?: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array };
}

/** a thing in the region that owns cells (sim/external.ts): its owner, kind, transform (region cells), its state */
export interface ThingRecord {
  owner: number;
  kind: string;
  /** a 3 × 4 affine transform, row-major (x, y world units in the region from its corner; z world height) */
  m: number[];
  /** what its owner keeps of it (its cells, its material, …): JSON */
  state: unknown;
  /** the cells it claims (region cells; z world height) */
  cols: { x: number; y: number; z0: number; z1: number }[];
  fallback: number;
  /** its id when it was saved (a history id: the same thing across visits) */
  id: number;
}

export interface RecordHeader {
  format: number;
  gen: number;
  world: string;
  /** the region (regions on the world's torus) and its corner (world cells) */
  rx: number;
  ry: number;
  x0: number;
  y0: number;
  oz: number;
  sig: string;
  /** the page session that wrote it (a region made again in the session that wrote it is that session's to drop) */
  session: string;
  savedAt: number;
  /** its columns' hash as saved (columnsHash) */
  hash: number;
  sections: Record<string, [number, number]>;
  things?: ThingRecord[];
}

export interface DecodedRecord {
  header: RecordHeader;
  body: Uint8Array;
  meta: RegionMeta;
}

const te = new TextEncoder();
const td = new TextDecoder();

/** outside intervals as floats: per column n, then (z0, z1, mat, aux) × n */
function packOutside(out: Interval[][]): Float32Array {
  let n = out.length;
  for (const c of out) n += c.length * 4;
  const f = new Float32Array(n);
  let o = 0;
  for (const c of out) {
    f[o++] = c.length;
    for (const iv of c) {
      f[o++] = iv.z0;
      f[o++] = iv.z1;
      f[o++] = iv.mat;
      f[o++] = iv.aux ?? 0;
    }
  }
  return f;
}

function unpackOutside(f: Float32Array, cols: number): Interval[][] {
  const out: Interval[][] = [];
  let o = 0;
  for (let i = 0; i < cols; i++) {
    const n = f[o++];
    const c: Interval[] = [];
    for (let k = 0; k < n; k++) {
      const iv: Interval = { z0: f[o], z1: f[o + 1], mat: f[o + 2] };
      if (f[o + 3]) iv.aux = f[o + 3];
      c.push(iv);
      o += 4;
    }
    out.push(c);
  }
  return out;
}

/** A record's bytes (uncompressed: the store compresses it in its worker). */
export function encodeRecord(h: Omit<RecordHeader, 'sections' | 'format' | 'gen'>, body: Uint8Array, meta: RegionMeta): Uint8Array {
  const parts: [string, Uint8Array][] = [['body', body]];
  const u8 = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  parts.push(['outside', u8(packOutside(meta.outside))]);
  parts.push(['surface', u8(meta.surface)]);
  if (meta.ground) parts.push(['ground', u8(meta.ground)]);
  if (meta.relief) {
    parts.push(['relief', meta.relief.relief]);
    parts.push(['gapTop', u8(meta.relief.gapTop)]);
    parts.push(['colTop', u8(meta.relief.colTop)]);
  }
  // (offsets from the data's start: the first 16-byte boundary after the header)
  const sections: Record<string, [number, number]> = {};
  let off = 0;
  for (const [name, p] of parts) {
    sections[name] = [off, p.byteLength];
    off = align(off + p.byteLength, 16);
  }
  const header: RecordHeader = { format: RECORD_FORMAT, gen: GEN_VERSION, ...h, sections };
  const json = te.encode(JSON.stringify(header));
  const start = align(8 + json.length, 16);
  const out = new Uint8Array(start + off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, RECORD_MAGIC, true);
  dv.setUint32(4, json.length, true);
  out.set(json, 8);
  for (const [name, p] of parts) out.set(p, start + sections[name][0]);
  return out;
}

/** A record's header only (what to check before decoding it all). */
export function recordHeader(bytes: Uint8Array): RecordHeader {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || dv.getUint32(0, true) !== RECORD_MAGIC) throw new Error('not a region record (bad magic)');
  const n = dv.getUint32(4, true);
  return JSON.parse(td.decode(bytes.subarray(8, 8 + n))) as RecordHeader;
}

/** Why a record can't be used here (null: it can). */
export function recordMismatch(h: RecordHeader, layout: RegionLayout, world: string): string | null {
  if (h.format !== RECORD_FORMAT) return `record format ${h.format}, this build reads ${RECORD_FORMAT}`;
  if (h.gen !== GEN_VERSION) return `made by land generator ${h.gen}, this build's is ${GEN_VERSION}`;
  if (h.world !== world) return `of world "${h.world}", not "${world}"`;
  if (h.sig !== layout.sig) return `its layout (${h.sig}) isn't this build's (${layout.sig})`;
  return null;
}

export function decodeRecord(bytes: Uint8Array, R: number): DecodedRecord {
  const header = recordHeader(bytes);
  const start = align(8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true), 16);
  const sec = (name: string) => {
    const s = header.sections[name];
    if (!s) return null;
    // (copied out: each its own buffer, aligned for its typed view)
    return bytes.slice(start + s[0], start + s[0] + s[1]);
  };
  const f32 = (name: string) => {
    const b = sec(name);
    return b ? new Float32Array(b.buffer) : undefined;
  };
  const body = sec('body');
  const outside = f32('outside');
  const surface = f32('surface');
  if (!body || !outside || !surface) throw new Error('region record: a section is missing');
  const meta: RegionMeta = { oz: header.oz, outside: unpackOutside(outside, R * R), surface, ground: f32('ground') };
  const relief = sec('relief');
  const gapTop = f32('gapTop');
  const colTop = f32('colTop');
  if (relief && gapTop && colTop) meta.relief = { relief, gapTop, colTop };
  return { header, body, meta };
}

/** a column's top and its matter's thickness, R × R of them: what tells a region changed from drift (CHANGED_DZ) */
export type ColumnsSig = Float32Array;
/** (cells) a column's top or thickness moved by more than this: changed, not the sims' drift (0.03–0.06 measured) */
export const CHANGED_DZ = 0.3;

/** whether a region's columns changed from `base` (as made) by more than drift: any column's top or thickness */
export function sigChanged(sig: ColumnsSig, base: ColumnsSig): boolean {
  for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i] - base[i]) > CHANGED_DZ) return true;
  return false;
}

/**
 * A region's columns in world z, hashed (FNV-1a over each column's intervals joined with what's outside the window,
 * z to 1/256 of a cell): the same land cut at another oz hashes the same; and (`sig`) each column's top and the
 * thickness of its matter (not air, not liquid). The hash says whether a region is as it was saved; the signature
 * whether it changed from how it was made by more than the sims' drift.
 */
export function columnsHash(pages: Uint32Array, layout: RegionLayout, outside: Interval[][], oz: number, sig?: ColumnsSig): number {
  const { R, K, rc } = layout;
  const pageSlots = K * CHUNK * CHUNK;
  const f = new Float32Array(pages.buffer, pages.byteOffset, pages.length);
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= v >>> 16;
    h = Math.imul(h, 0x01000193);
  };
  const q = (z: number) => Math.round(z * 256) | 0;
  let top = 0;
  let solid = 0;
  const matter = (m: number) => {
    const st = MATERIALS[m]?.state;
    return st !== undefined && st !== MatState.Empty && st !== MatState.Liquid;
  };
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
      const base = (page * pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K) * SLOT_WORDS;
      const out = outside[y * R + x];
      top = 0;
      solid = 0;
      // (outside is below the window's floor or over its top: those below first, the window's, those above)
      let lz1 = NaN;
      let lmat = -1;
      let lz0 = 0;
      let laux = 0;
      const flush = () => {
        mix(q(lz0));
        mix(q(lz1));
        mix(lmat | (laux << 8));
        if (matter(lmat)) {
          solid += lz1 - lz0;
          top = Math.max(top, lz1);
        }
      };
      const put = (z0: number, z1: number, mat: number, aux: number) => {
        if (mat === lmat && Math.abs(z0 - lz1) < 1e-4) {
          lz1 = Math.max(lz1, z1);
          return;
        }
        if (lmat >= 0) flush();
        lz0 = z0;
        lz1 = z1;
        lmat = mat;
        laux = aux;
      };
      if (out.length) {
        const below = out.filter((iv) => iv.z0 < oz).sort((p, r) => p.z0 - r.z0);
        for (const iv of below) put(iv.z0, iv.z1, iv.mat, iv.aux ?? 0);
      }
      for (let s = 0; s < K; s++) {
        const o = base + s * SLOT_WORDS;
        if (pages[o + 1] === 0) break;
        const w = pages[o + 2];
        put(f[o] + oz, f[o + 1] + oz, w & 0xff, (w >>> 8) & 0xff);
      }
      if (out.length) {
        const above = out.filter((iv) => iv.z0 >= oz).sort((p, r) => p.z0 - r.z0);
        for (const iv of above) put(iv.z0, iv.z1, iv.mat, iv.aux ?? 0);
      }
      if (lmat >= 0) flush();
      mix(0xfffe);
      if (sig) {
        sig[(y * R + x) * 2] = top;
        sig[(y * R + x) * 2 + 1] = solid;
      }
    }
  return h >>> 0;
}
