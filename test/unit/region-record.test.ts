// A region's record (world/region-record.ts, rounds 100/107/114): the layout every tier shares, the record's bytes
// round-tripped, why a record can't be used, the columns' hash (the same land at any window height hashes the same),
// and the land generator's version — a hash of its sources (scripts/lib/gen-sources.mjs), never bumped by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CHUNK, SLOT_WORDS, writeSlot, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import {
  columnsHash,
  columnsHashSteps,
  decodeRecord,
  encodeRecord,
  GEN_VERSION,
  RECORD_FORMAT,
  recordHeader,
  recordMismatch,
  regionLayout,
  type RegionLayout,
} from '../../src/world/region-record';
// @ts-expect-error (a plain .mjs: no types)
import { genHash, genSources, GEN_ENTRIES } from '../../scripts/lib/gen-sources.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

const layout16 = (tag = '') => regionLayout(16, 4, [{ name: 'water', stride: 4, planes: 1 }, { name: 'veg', stride: 16, planes: 2 }], [{ name: 'shade', per: 1, div: 2 }], tag);

/** a region's pages with each column's window intervals (window z) */
function pagesOf(L: RegionLayout, col: (x: number, y: number) => Interval[]): Uint32Array {
  const u = new Uint32Array((L.rc * L.rc * L.pageBytes) / 4);
  const pageSlots = L.K * CHUNK * CHUNK;
  for (let y = 0; y < L.R; y++)
    for (let x = 0; x < L.R; x++) {
      const page = Math.floor(y / CHUNK) * L.rc + Math.floor(x / CHUNK);
      const base = page * pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * L.K;
      col(x, y).forEach((iv, s) => writeSlot(u, base + s, iv.z0, iv.z1, iv.mat, iv.aux ?? 0));
    }
  return u;
}

/** the land (world z), cut at window height oz: the window's part (window z) and what's outside it (world z) */
function cut(land: Interval[], oz: number): { inside: Interval[]; outside: Interval[] } {
  const inside: Interval[] = [];
  const outside: Interval[] = [];
  for (const iv of land) {
    if (iv.z1 <= oz) outside.push({ ...iv });
    else if (iv.z0 >= oz) inside.push({ ...iv, z0: iv.z0 - oz, z1: iv.z1 - oz });
    else {
      outside.push({ ...iv, z1: oz });
      inside.push({ ...iv, z0: 0, z1: iv.z1 - oz });
    }
  }
  return { inside, outside };
}

const land = (x: number, y: number): Interval[] => [
  { z0: 0, z1: 8 + ((x * 7 + y * 3) % 5), mat: MAT.Stone },
  { z0: 8 + ((x * 7 + y * 3) % 5), z1: 10.5 + ((x + y) % 3) * 0.25, mat: MAT.Soil },
];

function hashAt(L: RegionLayout, oz: number, f = land, sig?: Float32Array): number {
  const outside: Interval[][] = [];
  const cols: Interval[][] = [];
  for (let y = 0; y < L.R; y++)
    for (let x = 0; x < L.R; x++) {
      const c = cut(f(x, y), oz);
      cols[y * L.R + x] = c.inside;
      outside[y * L.R + x] = c.outside;
    }
  return columnsHash(pagesOf(L, (x, y) => cols[y * L.R + x]), L, outside, oz, sig);
}

describe('regionLayout', () => {
  test('pages first, then each buffer and texture, every part 256-aligned; the signature names them', () => {
    const L = layout16('w64');
    expect(L.rc).toBe(1);
    expect(L.pageBytes).toBe(4 * CHUNK * CHUNK * SLOT_WORDS * 4);
    expect(L.bufs[0].off).toBe(L.pageBytes);
    for (const b of L.bufs) expect(b.off % 256).toBe(0);
    for (const t of L.texs) expect(t.off % 256).toBe(0);
    expect(L.bufs[1].bytes).toBe(16 * 16 * 16 * 2);
    expect(L.texs[0]).toMatchObject({ tw: 8, th: 8, rowBytes: 256 });
    expect(L.bytes % 256).toBe(0);
    expect(L.bytes).toBeGreaterThanOrEqual(L.texs[0].off + L.texs[0].bytes);
    expect(L.sig).toBe('R16K4w64|water:4x1,veg:16x2|shade:1/2');
  });
});

describe('a record', () => {
  const L = layout16();
  const meta = () => {
    const outside: Interval[][] = Array.from({ length: 256 }, (_, i) => (i % 5 === 0 ? [{ z0: -4, z1: 0, mat: MAT.Stone }, { z0: 40, z1: 41.5, mat: MAT.Soil, aux: 3 }] : []));
    const surface = Float32Array.from({ length: 256 }, (_, i) => 10 + i / 256);
    const ground = Float32Array.from({ length: 256 }, (_, i) => 9 + i / 512);
    const relief = { relief: Uint8Array.from({ length: 256 }, (_, i) => i & 0xff), gapTop: new Float32Array(256).fill(3), colTop: new Float32Array(256).fill(12) };
    return { oz: 4, outside, surface, ground, relief };
  };
  const head = { world: 'seed-7', rx: 2, ry: 3, x0: 32, y0: 48, oz: 4, sig: L.sig, session: 's1', savedAt: 123, hash: 0xdeadbeef, things: [{ owner: 1, kind: 'rock', m: [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4], state: { cells: 3 }, cols: [{ x: 1, y: 2, z0: 10, z1: 12 }], fallback: MAT.Stone, id: 9 }] };

  test('decodes to what was encoded', () => {
    const body = Uint8Array.from({ length: L.bytes }, (_, i) => (i * 31) & 0xff);
    const m = meta();
    const bytes = encodeRecord(head, body, m);
    const d = decodeRecord(bytes, 16);
    expect(d.header).toMatchObject({ ...head, format: RECORD_FORMAT, gen: GEN_VERSION });
    expect(d.body).toEqual(body);
    expect(d.meta.oz).toBe(4);
    expect(d.meta.outside).toEqual(m.outside);
    expect(d.meta.surface).toEqual(m.surface);
    expect(d.meta.ground).toEqual(m.ground);
    expect(d.meta.relief).toEqual(m.relief);
  });

  test('without the optional parts: none come back', () => {
    const d = decodeRecord(encodeRecord(head, new Uint8Array(L.bytes), { oz: 0, outside: Array.from({ length: 256 }, () => []), surface: new Float32Array(256) }), 16);
    expect(d.meta.ground).toBeUndefined();
    expect(d.meta.relief).toBeUndefined();
  });

  test('every section starts 16-byte aligned', () => {
    const bytes = encodeRecord(head, new Uint8Array(L.bytes), meta());
    const h = recordHeader(bytes);
    for (const [off] of Object.values(h.sections)) expect(off % 16).toBe(0);
  });

  test('bytes that are not a record say so', () => {
    expect(() => recordHeader(new Uint8Array(16))).toThrow(/bad magic/);
    expect(() => recordHeader(new Uint8Array(3))).toThrow(/bad magic/);
  });

  test("why a record can't be used: format, generator, world, layout", () => {
    const h = recordHeader(encodeRecord(head, new Uint8Array(L.bytes), meta()));
    expect(recordMismatch(h, L, 'seed-7')).toBeNull();
    expect(recordMismatch({ ...h, format: 1 }, L, 'seed-7')).toMatch(/format 1/);
    expect(recordMismatch({ ...h, gen: 1 }, L, 'seed-7')).toMatch(/land generator 1/);
    expect(recordMismatch(h, L, 'seed-8')).toMatch(/of world "seed-7"/);
    expect(recordMismatch(h, layout16('w64'), 'seed-7')).toMatch(/layout/);
  });
});

describe('columnsHash', () => {
  const L = layout16();

  test('the same land cut at another window height hashes the same', () => {
    const h0 = hashAt(L, 0);
    expect(hashAt(L, 5)).toBe(h0);
    expect(hashAt(L, 9)).toBe(h0);
  });

  test('a change of material, or of height by 1/256 of a cell, changes it', () => {
    const h0 = hashAt(L, 0);
    const moved = (x: number, y: number) => (x === 3 && y === 7 ? land(x, y).map((iv, i) => (i === 1 ? { ...iv, z1: iv.z1 + 1 / 256 } : iv)) : land(x, y));
    const swapped = (x: number, y: number) => (x === 3 && y === 7 ? land(x, y).map((iv, i) => (i === 1 ? { ...iv, mat: MAT.Sand } : iv)) : land(x, y));
    expect(hashAt(L, 0, moved)).not.toBe(h0);
    expect(hashAt(L, 0, swapped)).not.toBe(h0);
  });

  test('a few rows at a time is the same hash', () => {
    const outside = Array.from({ length: 256 }, () => [] as Interval[]);
    const pages = pagesOf(L, land);
    const g = columnsHashSteps(pages, L, outside, 0, undefined, 3);
    let yields = 0;
    let r = g.next();
    while (!r.done) {
      yields++;
      r = g.next();
    }
    expect(yields).toBe(5);
    expect(r.value).toBe(columnsHash(pages, L, outside, 0));
  });

  test("its signature: each column's top and its matter's thickness (water isn't matter)", () => {
    const sig = new Float32Array(256 * 2);
    const wet = (x: number, y: number): Interval[] => [...land(x, y), { z0: land(x, y)[1].z1, z1: land(x, y)[1].z1 + 2, mat: MAT.Water }];
    hashAt(L, 0, wet, sig);
    const top = land(3, 7)[1].z1;
    expect(sig[(7 * 16 + 3) * 2]).toBeCloseTo(top, 5);
    expect(sig[(7 * 16 + 3) * 2 + 1]).toBeCloseTo(top, 5);
  });
});

describe("the land generator's version (scripts/lib/gen-sources.mjs)", () => {
  test("GEN_VERSION is this checkout's generator hash (vite.config.ts's define)", () => {
    expect(GEN_VERSION).toMatch(/^[0-9a-f]{16}$/);
    expect(GEN_VERSION).toBe(genHash(ROOT));
  });

  test('the generator files: the entries and what they reach, not the engine past the boundary', () => {
    const files: string[] = genSources(ROOT);
    for (const e of GEN_ENTRIES) expect(files).toContain(e);
    expect(files.some((f) => f.startsWith('src/render/') || f.startsWith('src/sim/') || f.startsWith('src/ui/'))).toBe(false);
  });

  /** a fake checkout: the four entries, a helper the atlas imports, a render file, a type-only import */
  function fakeRoot(): string {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaimed-gen-'));
    const put = (f: string, s: string) => {
      fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
      fs.writeFileSync(path.join(r, f), s);
    };
    for (const e of GEN_ENTRIES) put(e, `export const x = 1;\n`);
    put('src/atlas/atlas.ts', `import { h } from './helper';\nimport { draw } from '../render/draw';\nimport type { T } from './types';\nexport const a = h + draw;\n`);
    put('src/atlas/helper.ts', `export const h = 1;\n`);
    put('src/atlas/types.ts', `export type T = number;\n`);
    put('src/render/draw.ts', `export const draw = 2;\n`);
    return r;
  }

  test("a generator file's edit changes it; an edit past the boundary, a type-only file or a line ending doesn't", () => {
    const r = fakeRoot();
    try {
      const h0 = genHash(r);
      expect(genSources(r)).toEqual([...GEN_ENTRIES, 'src/atlas/helper.ts'].sort());
      fs.writeFileSync(path.join(r, 'src/render/draw.ts'), `export const draw = 3;\n`);
      fs.writeFileSync(path.join(r, 'src/atlas/types.ts'), `export type T = string;\n`);
      expect(genHash(r)).toBe(h0);
      fs.writeFileSync(path.join(r, 'src/atlas/helper.ts'), `export const h = 1;\r\n`);
      expect(genHash(r)).toBe(h0);
      fs.writeFileSync(path.join(r, 'src/atlas/helper.ts'), `export const h = 2;\n`);
      expect(genHash(r)).not.toBe(h0);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });
});
