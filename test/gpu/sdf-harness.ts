// The fine pass's test rig (test/gpu/sdf-*.test.ts): a model store, body rows and a pair list on the real device, one
// fine pass, each pair's record and contact rows read back, and every sample contact of the same pairs from the CPU
// mirror (test/support/sdf-reference.ts).
import { expect } from 'vitest';
import { CONTACT_BYTES, CONTACTS_PER_PAIR, COUNT_BRICKS, COUNT_BRICKS_DROPPED, COUNT_CONTACTS, COUNT_PAIRS_DROPPED, COUNT_SAMPLE_CONTACTS, COUNTS_BYTES, PAIR_HIT_BYTES, PAIR_HIT_ENERGY, PAIR_HIT_ROWS, PAIR_HIT_SAMPLES, PAIR_HIT_SLOT, NO_SLOT, SLOT_KEY_AGE, SLOT_KEY_BYTES, packBodies, unpackContacts, SDF_SNORM_SCALE, type BodyRow, type Contact, type SdfFormat } from '../../src/engine/sdf/contract';
import { SdfFine, type FineInputs, type FineOptions } from '../../src/engine/sdf/fine';
import { SdfModels, type SdfModelSpec } from '../../src/engine/sdf/models';
import { angleDeg, exactAt, mirrorContacts, refModel, unrot, type RefContact, type RefModel } from '../support/sdf-reference';
import type { TestGpu } from './dawn';

export function storage(g: TestGpu, label: string, bytes: ArrayBufferView | ArrayBuffer): GPUBuffer {
  const src = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b = g.device.createBuffer({ label, size: Math.max(16, Math.ceil(src.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(src);
  b.unmap();
  return b;
}

/** a model's field as the store keeps it, decoded to voxels */
export async function readField(g: TestGpu, store: SdfModels, id: number): Promise<Float32Array> {
  const m = store.info(id);
  const n = m.dims[0] * m.dims[1] * m.dims[2];
  const raw = await g.read(store.data, m.fieldWords * 4, m.fieldBase * 4);
  if (store.format === 'f32') return new Float32Array(raw).slice(0, n);
  const b = new Int8Array(raw);
  const stride = store.format === 'grad8' ? 4 : 1;
  return Float32Array.from({ length: n }, (_, i) => b[i * stride] / SDF_SNORM_SCALE);
}

/** grad8: a model's kept gradients (x, y, z a voxel, decoded) */
export async function readGrad(g: TestGpu, store: SdfModels, id: number): Promise<Float32Array> {
  const m = store.info(id);
  const b = new Int8Array(await g.read(store.data, m.fieldWords * 4, m.fieldBase * 4));
  return Float32Array.from({ length: m.fieldWords * 3 }, (_, i) => Math.max(b[Math.floor(i / 3) * 4 + 1 + (i % 3)] / 127, -1));
}

/** a model's row sample count, the bake's counter, its brick table and its sample words, in the store's order */
export async function readSamples(g: TestGpu, store: SdfModels, id: number): Promise<{ count: number; found: number; bricks: number[]; words: number[] }> {
  const m = store.info(id);
  const count = new Uint32Array(await g.read(store.models, 32, id * 32))[3];
  const found = new Uint32Array(await g.read(store.bakeCount, 4, id * 4))[0];
  const all = new Uint32Array(await g.read(store.data, (m.bricks + 1 + Math.max(count, 1)) * 4, m.sampleBase * 4));
  return { count, found, bricks: [...all.slice(0, m.bricks + 1)], words: [...all.slice(m.bricks + 1, m.bricks + 1 + count)] };
}

export interface PairResult {
  /** the pair's record: samples that touched, the largest energy, and its contact rows */
  samples: number;
  energy: number;
  rows: Contact[];
  /** the pair's slot (its rows are the contact rows slot * 4 on), the slot's age in passes, and all four of the slot's rows as they are */
  slot: number;
  age: number;
  slotRows: Contact[];
  /** the slot's key: the pair's lower and higher body rows */
  key: [number, number];
}

export interface RunResult {
  /** contract.ts COUNT_* */
  rowsWritten: number;
  pairsDropped: number;
  bricks: number;
  bricksDropped: number;
  sampleContacts: number;
  pairs: PairResult[];
  /** every pair's rows together */
  rows: Contact[];
  /** every sample contact, from the CPU mirror */
  mirror: RefContact[];
  /** the rows' `missing` words (contract.ts MISS_*) */
  missing: number[];
}

export interface Scene {
  store: SdfModels;
  fine: SdfFine;
  ids: number[];
  refs: RefModel[];
  bodies: BodyRow[];
  pairs: number[];
  inputs: FineInputs;
  /** the body rows uploaded again (after a test moves one) */
  setBodies(bodies: BodyRow[]): void;
  run(tick?: number): Promise<RunResult>;
  destroy(): void;
}

export function makeScene(g: TestGpu, format: SdfFormat, specs: SdfModelSpec[], bodies: BodyRow[], pairs: number[], opts: Partial<FineOptions> = {}): Scene {
  const store = new SdfModels(g.device, format);
  const ids = specs.map((s) => store.add(s));
  store.flush();
  const refs: RefModel[] = [];
  specs.forEach((s, k) => (refs[ids[k]] = refModel(s, format)));
  const fine = new SdfFine(g.device, store, { maxPairs: Math.max(pairs.length / 2, 1), cap: 1 << 16, ...opts });
  const packed = packBodies(bodies);
  const inputs: FineInputs = {
    pairs: storage(g, 'test pairs', new Uint32Array(pairs)),
    pairCount: storage(g, 'test pair count', new Uint32Array([pairs.length / 2, 0, 0, 0])),
    pose: storage(g, 'test pose', packed.pose),
    vel: storage(g, 'test vel', packed.vel),
    info: storage(g, 'test info', packed.info),
    model: storage(g, 'test model', packed.model),
    // (the coarse pass's words: here the test's own, never cleared)
    missing: storage(g, 'test missing', new Uint32Array(Math.max(bodies.length, 4))),
  };
  const scene: Scene = {
    store,
    fine,
    ids,
    refs,
    bodies,
    pairs,
    inputs,
    setBodies(next) {
      scene.bodies = next;
      const p = packBodies(next);
      g.device.queue.writeBuffer(inputs.pose as GPUBuffer, 0, p.pose);
      g.device.queue.writeBuffer(inputs.vel, 0, p.vel);
      g.device.queue.writeBuffer(inputs.info, 0, p.info);
      g.device.queue.writeBuffer(inputs.model, 0, p.model);
    },
    async run(tick = 0) {
      const n = Math.min(pairs.length / 2, fine.maxPairs);
      fine.setParams(pairs.length / 2, tick);
      const enc = g.device.createCommandEncoder();
      fine.encode(enc, inputs, pairs.length / 2);
      g.device.queue.submit([enc.finish()]);
      const c = new Uint32Array(await g.read(fine.counts, COUNTS_BYTES));
      const hits = await g.read(fine.hits, n * PAIR_HIT_BYTES);
      const hu = new Uint32Array(hits);
      const hf = new Float32Array(hits);
      // (a pair's rows are at its slot)
      const all = unpackContacts(await g.read(fine.contacts, fine.slots * CONTACTS_PER_PAIR * CONTACT_BYTES), fine.slots * CONTACTS_PER_PAIR);
      const keys = new Uint32Array(await g.read(fine.slotKeys, fine.slots * SLOT_KEY_BYTES));
      const out: PairResult[] = [];
      for (let p = 0; p < n; p++) {
        const slot = hu[p * 32 + PAIR_HIT_SLOT];
        const at = slot === NO_SLOT ? 0 : slot * CONTACTS_PER_PAIR;
        const rows = slot === NO_SLOT ? 0 : hu[p * 32 + PAIR_HIT_ROWS];
        out.push({ samples: hu[p * 32 + PAIR_HIT_SAMPLES], energy: hf[p * 32 + PAIR_HIT_ENERGY], rows: all.slice(at, at + rows), slot, age: slot === NO_SLOT ? -1 : keys[slot * 4 + SLOT_KEY_AGE], slotRows: slot === NO_SLOT ? [] : all.slice(at, at + CONTACTS_PER_PAIR), key: slot === NO_SLOT ? [-1, -1] : [keys[slot * 4], keys[slot * 4 + 1]] });
      }
      const missing = [...new Uint32Array(await g.read(inputs.missing, scene.bodies.length * 4))];
      expect(g.takeErrors()).toEqual([]);
      return {
        missing,
        rowsWritten: c[COUNT_CONTACTS],
        pairsDropped: c[COUNT_PAIRS_DROPPED],
        bricks: c[COUNT_BRICKS],
        bricksDropped: c[COUNT_BRICKS_DROPPED],
        sampleContacts: c[COUNT_SAMPLE_CONTACTS],
        pairs: out,
        rows: out.flatMap((x) => x.rows),
        mirror: mirrorContacts(scene.refs, scene.bodies, pairs.slice(0, n * 2), fine.margin),
      };
    },
    destroy() {
      fine.destroy();
      store.destroy();
      for (const b of Object.values(inputs)) (b as GPUBuffer).destroy();
    },
  };
  return scene;
}

/** the bin of a world normal for a pair of bodies at pa and pb, as sdf-fine.wgsl pairFrame and binOf */
export function binOf(w: readonly number[], pa: readonly number[], pb: readonly number[]): number {
  const ax = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
  const al = Math.hypot(...ax);
  const n0 = al > 1e-5 ? ax.map((v) => v / al) : [0, 0, 1];
  const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let t1 = cr(n0, Math.abs(n0[0]) > 0.7 ? [0, 1, 0] : [1, 0, 0]);
  const tl = Math.hypot(...t1);
  t1 = t1.map((v) => v / tl);
  const t2 = cr(n0, t1);
  const n = [n0, t1, t2].map((e) => e[0] * w[0] + e[1] * w[1] + e[2] * w[2]);
  const m = n.map(Math.abs);
  if (m[0] >= m[1] && m[0] >= m[2]) return n[0] < 0 ? 1 : 0;
  if (m[1] >= m[2]) return n[1] < 0 ? 3 : 2;
  return n[2] < 0 ? 5 : 4;
}

/**
 * A pass against the mirror, pair by pair:
 * - the pair's record counts the mirror's sample contacts (but for those within `edge` voxels of the margin, which
 *   the GPU's floats may put either side) and carries their largest energy;
 * - it has 1 to 4 rows when anything touched, each one of the mirror's sample contacts (point 0.01 cells, depth 0.005
 *   cells), no sample twice, the deepest sample among them;
 * - a row's normal is the mean of the mirror's sample normals in its own normal's bin (2°), its closing speed is
 *   along that normal, its energy the pair's.
 * Returns each row with the mirror's sample it is.
 */
export function expectReduced(scene: Scene, r: RunResult, edge = 0.01): { gpu: Contact; ref: RefContact; pair: number }[] {
  const out: { gpu: Contact; ref: RefContact; pair: number }[] = [];
  expect(r.rowsWritten).toBe(r.rows.length);
  expect(r.sampleContacts).toBe(r.pairs.reduce((s, p) => s + p.samples, 0));
  r.pairs.forEach((pair, pi) => {
    const a = scene.pairs[pi * 2];
    const b = scene.pairs[pi * 2 + 1];
    const mine = r.mirror.filter((m, k) => m.a === a && m.b === b && mirrorPair(scene, r.mirror, k) === pi);
    const marginVox = (c: RefContact) => scene.fine.margin / scene.refs[scene.bodies[c.way ? c.a : c.b].model].voxel;
    const unsure = mine.filter((c) => Math.abs(c.gapVox - marginVox(c)) <= edge).length;
    expect(Math.abs(pair.samples - mine.length), `pair ${pi}: sample contacts ${pair.samples}, the mirror's ${mine.length}`).toBeLessThanOrEqual(unsure);
    if (!mine.length) {
      expect(pair.rows.length).toBe(0);
      return;
    }
    if (pair.samples) {
      expect(pair.rows.length).toBeGreaterThanOrEqual(1);
      expect(pair.rows.length).toBeLessThanOrEqual(CONTACTS_PER_PAIR);
    }
    const top = Math.max(...mine.map((c) => c.energy));
    expect(Math.abs(pair.energy - top)).toBeLessThan(0.01 + 0.02 * top);
    const used = new Set<RefContact>();
    for (const row of pair.rows) {
      expect([row.a, row.b]).toEqual([a, b]);
      let best: RefContact | null = null;
      let bd = 0.01;
      for (const m of mine) {
        const d = Math.hypot(row.point[0] - m.point[0], row.point[1] - m.point[1], row.point[2] - m.point[2]) + Math.abs(row.depth - m.depth);
        if (d < bd && !used.has(m)) {
          bd = d;
          best = m;
        }
      }
      expect(best, `pair ${pi}: a row at ${row.point.map((v) => v.toFixed(3))} depth ${row.depth.toFixed(4)} is none of the mirror's samples`).not.toBeNull();
      used.add(best!);
      expect(Math.abs(row.depth - best!.depth)).toBeLessThan(0.005);
      // the mean of the sample normals that point the same way
      const pa = scene.bodies[a].pos;
      const pb = scene.bodies[b].pos;
      const bin = binOf(best!.normal, pa, pb);
      const sum = [0, 0, 0];
      for (const m of mine) if (binOf(m.normal, pa, pb) === bin) m.normal.forEach((v, k) => (sum[k] += v));
      const l = Math.hypot(...sum);
      const meanN = sum.map((v) => v / l);
      expect(angleDeg(row.normal, meanN), `pair ${pi}: a row's normal against its bin's mean`).toBeLessThan(2);
      expect(Math.abs(row.closing + (best!.vrel[0] * row.normal[0] + best!.vrel[1] * row.normal[1] + best!.vrel[2] * row.normal[2]))).toBeLessThan(0.02);
      expect(Math.abs(row.energy - pair.energy)).toBeLessThan(1e-6 + 1e-6 * pair.energy);
      out.push({ gpu: row, ref: best!, pair: pi });
    }
    if (pair.rows.length) expect(Math.max(...pair.rows.map((x) => x.depth))).toBeGreaterThan(Math.max(...mine.map((c) => c.depth)) - 0.01);
  });
  return out;
}

/** which pair of the scene's list a mirror contact came from (the mirror walks the list in order, both ways a pair) */
function mirrorPair(scene: Scene, mirror: RefContact[], k: number): number {
  // (pairs in the tests' lists are distinct, but for the one that repeats a pair past the count)
  const c = mirror[k];
  for (let p = 0; p * 2 < scene.pairs.length; p++) if (scene.pairs[p * 2] === c.a && scene.pairs[p * 2 + 1] === c.b) return p;
  return -1;
}

export interface Judged {
  gpu: Contact;
  ref: RefContact;
  /** the method against the exact voxel geometry at this sample: depth (voxels of the field's model) and normal (degrees) */
  depthErr: number;
  normalErr: number;
  /** no edge, corner or step of the field's model within `reach` voxels of the sample (the exact normal is the same all round it) */
  smooth: boolean;
}

/**
 * Each contact against the exact voxel geometry: the brute-force distance and normal at its sample's point, and
 * whether the field's model is smooth there (the exact normal within 5° of itself at 12 points `reach` and
 * `reach / 2` voxels away along the axes).
 */
export function judge(scene: Scene, matches: { gpu: Contact; ref: RefContact }[], reach: number): Judged[] {
  return matches.map(({ gpu, ref: r }) => {
    const fb = scene.bodies[r.way ? r.a : r.b];
    const mf = scene.refs[fb.model];
    const at: [number, number, number] = [r.q[0] + 0.5, r.q[1] + 0.5, r.q[2] + 0.5];
    const ex = exactAt(mf, at);
    // (the normal back in the field model's frame, outward)
    const nw = (r.way ? gpu.normal.map((v) => -v) : gpu.normal) as [number, number, number];
    const nl = unrot(fb.quat, nw);
    let smooth = Math.hypot(...ex.n) > 0.5;
    for (const k of [0, 1, 2])
      for (const e of [-reach, -reach / 2, reach / 2, reach]) {
        const p: [number, number, number] = [at[0], at[1], at[2]];
        p[k] += e;
        const o = exactAt(mf, p);
        // (a point exactly on the surface has no normal: it says nothing either way)
        if (Math.abs(o.d) > 1e-6 && angleDeg(o.n, ex.n) > 5) smooth = false;
      }
    return { gpu, ref: r, depthErr: Math.abs(-gpu.depth / mf.voxel - (ex.d - r.ball)), normalErr: Math.hypot(...ex.n) > 0.5 ? angleDeg(nl, ex.n) : 0, smooth };
  });
}
