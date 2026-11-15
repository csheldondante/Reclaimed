// The fine pass's test rig (test/gpu/sdf-*.test.ts): a model store, body rows and a pair list on the real device, one
// fine pass, its contacts read back, and the same contacts from the CPU mirror (test/support/sdf-reference.ts).
import { expect } from 'vitest';
import { CONTACT_BYTES, COUNTS_BYTES, packBodies, unpackContacts, SDF_SNORM_SCALE, type BodyRow, type Contact, type SdfFormat } from '../../src/engine/sdf/contract';
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

/** a model's row sample count, the bake's counter, and its sample words (sorted) */
export async function readSamples(g: TestGpu, store: SdfModels, id: number): Promise<{ count: number; found: number; words: number[] }> {
  const m = store.info(id);
  const count = new Uint32Array(await g.read(store.models, 32, id * 32))[3];
  const found = new Uint32Array(await g.read(store.bakeCount, 4, id * 4))[0];
  const words = [...new Uint32Array(await g.read(store.data, Math.max(count, 1) * 4, m.sampleBase * 4))].slice(0, count).sort((a, b) => a - b);
  return { count, found, words };
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
  /** one pass: the counts, the contact rows kept, and the mirror's */
  run(tick?: number): Promise<{ asked: number; dropped: number; chunks: number; chunksDropped: number; contacts: Contact[]; mirror: RefContact[] }>;
  destroy(): void;
}

export function makeScene(g: TestGpu, format: SdfFormat, specs: SdfModelSpec[], bodies: BodyRow[], pairs: number[], opts: Partial<FineOptions> = {}): Scene {
  const store = new SdfModels(g.device, format);
  const ids = specs.map((s) => store.add(s));
  store.flush();
  const refs: RefModel[] = [];
  specs.forEach((s, k) => (refs[ids[k]] = refModel(s, format)));
  const fine = new SdfFine(g.device, store, { maxPairs: Math.max(pairs.length / 2, 1), maxContacts: 8192, cap: 1 << 16, ...opts });
  const packed = packBodies(bodies);
  const inputs: FineInputs = {
    pairs: storage(g, 'test pairs', new Uint32Array(pairs)),
    pairCount: storage(g, 'test pair count', new Uint32Array([pairs.length / 2, 0, 0, 0])),
    pose: storage(g, 'test pose', packed.pose),
    vel: storage(g, 'test vel', packed.vel),
    info: storage(g, 'test info', packed.info),
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
      g.device.queue.writeBuffer(inputs.pose, 0, p.pose);
      g.device.queue.writeBuffer(inputs.vel, 0, p.vel);
      g.device.queue.writeBuffer(inputs.info, 0, p.info);
    },
    async run(tick = 0) {
      fine.setParams(pairs.length / 2, tick);
      const enc = g.device.createCommandEncoder();
      fine.encode(enc, inputs, pairs.length / 2);
      g.device.queue.submit([enc.finish()]);
      const c = new Uint32Array(await g.read(fine.counts, COUNTS_BYTES));
      const kept = Math.min(c[0], fine.maxContacts);
      const contacts = kept ? unpackContacts(await g.read(fine.contacts, kept * CONTACT_BYTES), kept) : [];
      expect(g.takeErrors()).toEqual([]);
      return { asked: c[0], dropped: c[1], chunks: c[2], chunksDropped: c[3], contacts, mirror: mirrorContacts(scene.refs, scene.bodies, pairs, fine.margin) };
    },
    destroy() {
      fine.destroy();
      store.destroy();
      for (const b of Object.values(inputs)) (b as GPUBuffer).destroy();
    },
  };
  return scene;
}

/**
 * The GPU's contacts against the mirror's: each mirror contact not within `edge` voxels of the margin has one GPU
 * contact of its pair at its point (within 0.01 cells), with its depth (0.005 cells), normal (1°), closing speed and
 * energy; and the GPU has no contact the mirror lacks (again but for the margin's edge). Returns the matches.
 */
export function expectMirror(contacts: Contact[], mirror: RefContact[], marginVox: (c: RefContact) => number, edge = 0.01): { gpu: Contact; ref: RefContact }[] {
  const left = contacts.map((c) => ({ c, used: false }));
  const out: { gpu: Contact; ref: RefContact }[] = [];
  const missing: string[] = [];
  for (const r of mirror) {
    let best = -1;
    let bd = 0.01;
    left.forEach((x, k) => {
      if (x.used || x.c.a !== r.a || x.c.b !== r.b) return;
      const d = Math.hypot(x.c.point[0] - r.point[0], x.c.point[1] - r.point[1], x.c.point[2] - r.point[2]) + Math.abs(x.c.depth - r.depth);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    if (best < 0) {
      if (Math.abs(r.gapVox - marginVox(r)) > edge) missing.push(`pair ${r.a},${r.b} way ${r.way} at ${r.point.map((v) => v.toFixed(3))} depth ${r.depth.toFixed(4)}`);
      continue;
    }
    left[best].used = true;
    out.push({ gpu: left[best].c, ref: r });
  }
  expect(missing, 'mirror contacts the GPU lacks').toEqual([]);
  const extra = left.filter((x) => !x.used).map((x) => `pair ${x.c.a},${x.c.b} at ${x.c.point.map((v) => v.toFixed(3))} depth ${x.c.depth.toFixed(4)}`);
  // (a GPU contact with no twin is only one at the margin's edge the mirror left out: its depth is the margin's)
  expect(extra.length, `GPU contacts the mirror lacks: ${extra.slice(0, 5).join('; ')}`).toBeLessThanOrEqual(mirror.filter((r) => Math.abs(r.gapVox - marginVox(r)) <= edge).length + 0);
  for (const { gpu, ref } of out) {
    expect(Math.abs(gpu.depth - ref.depth)).toBeLessThan(0.005);
    expect(angleDeg(gpu.normal, ref.normal)).toBeLessThan(1);
    expect(Math.abs(gpu.closing - ref.closing)).toBeLessThan(0.01 + 0.01 * Math.abs(ref.closing));
    expect(Math.abs(gpu.energy - ref.energy)).toBeLessThan(0.01 + 0.02 * Math.abs(ref.energy));
    expect([gpu.a, gpu.b]).toEqual([ref.a, ref.b]);
  }
  return out;
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
 * Each matched contact against the exact voxel geometry: the brute-force distance and normal at its sample's point,
 * and whether the field's model is smooth there (the exact normal within 5° of itself at 12 points `reach` and
 * `reach / 2` voxels away along the axes).
 */
export function judge(scene: Scene, matches: { gpu: Contact; ref: RefContact }[], reach: number): Judged[] {
  return matches.map(({ gpu, ref: r }) => {
    const fb = scene.bodies[r.way ? r.a : r.b];
    const mf = scene.refs[fb.model];
    const at: [number, number, number] = [r.q[0] + 0.5, r.q[1] + 0.5, r.q[2] + 0.5];
    const ex = exactAt(mf, at);
    // (the GPU's normal back in the field model's frame, outward)
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
