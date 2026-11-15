// The engine's test rig (test/gpu/engine-break.test.ts, engine-d0.test.ts, engine-settle.test.ts): a tiny world with
// the surface pass and the engine stepping, and the engine's buffers read back (tests only: nothing in play reads them).
import { DL_AT, Engine, PAGE, SLOT_W, type EngineCell } from '../../src/engine/engine';
import { Profiler } from '../../src/gpu/profiler';
import type { Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import type { TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

export interface BreakRig {
  w: TinyWorld;
  e: Engine;
  step(n: number): Promise<void>;
  /** a row's words: flags, mass, its slot, pose and velocity */
  row(r: number): Promise<{ flags: number; mass: number; model: number; slot: number; pos: number[]; q: number[]; v: number[]; spin: number[]; invM: number }>;
  flags(rows: number): Promise<Uint32Array>;
  /** the pool's header, and the buffers grown by it (what the engine's own read does now and then) */
  pool(): Promise<Uint32Array>;
  /** a deforming row's particles in lattice order: place (xyz, inverse mass), velocity, bonds */
  particles(r: number): Promise<{ x: Float32Array; v: Float32Array; bonds: Uint32Array; cells: number; pages: number[] }>;
  /** the frame's draw run now (alpha 1: the poses as they are) and read: a triangle's row, its three vertices' places,
   *  their places in the grain's frame (the lattice of the body it first was), its material word (bit 29: a break face) */
  drawn(): Promise<{ tris: number; row: Uint32Array; p: Float32Array; grain: Float32Array; word: Uint32Array }>;
  /** one tick with each of the engine's kernels in a pass of its own, timed by the GPU (timestamp queries): ms by
   *  kernel, `total` their sum, `wall` the tick's submit to done; null where the device has no timestamps */
  gpuTick(): Promise<Map<string, number> | null>;
  /** every row in use: its index, flags, mass, model (a heap index as the row holds it), centre */
  rows(): Promise<{ row: number; flags: number; mass: number; model: number; pos: number[] }[]>;
  /** a model's header: its lattice box, voxels, mesh vertices, and its records (4 floats a cell: rest place, material | bonds << 6) */
  model(id: number): Promise<{ dims: number[]; solid: number; verts: number; recs: Float32Array }>;
}

export async function breakRig(g: TestGpu, col: (x: number, y: number) => Interval[], W = 32, H = 32, opts: ConstructorParameters<typeof Engine>[3] = {}): Promise<BreakRig> {
  const w = await tinyWorld(g, tinyMap(W, H, 64, col), ['surface']);
  const prof = new Profiler(g.device, g.device.features.has('timestamp-query'));
  prof.active = false;
  const e = new Engine(g.device, w.core.world, prof, opts);
  const sys = w.core.sim.systems;
  sys.splice(sys.findIndex((s) => s.name === 'surface') + 1, 0, e);
  const on = (s: { name: string }) => s.name === 'surface' || s.name === 'engine';
  const R: BreakRig = {
    w,
    e,
    step: async (n) => {
      for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, on);
      await g.device.queue.onSubmittedWorkDone();
    },
    row: async (r) => {
      const D = e.debugBuffers;
      const I = await g.read(D.info, 64, r * 64);
      const P = new Float32Array(await g.read(D.pose, 64, r * 64));
      const V = new Float32Array(await g.read(D.vel, 32, r * 32));
      const u = new Uint32Array(I);
      return { flags: u[3], mass: new Float32Array(I)[7], model: u[12], slot: u[13], pos: [...P.slice(8, 11)], invM: P[11], q: [...P.slice(12, 16)], v: [...V.slice(0, 3)], spin: [...V.slice(4, 7)] };
    },
    flags: async (rows) => {
      const u = new Uint32Array(await g.read(e.debugBuffers.info, rows * 64));
      return Uint32Array.from({ length: rows }, (_, r) => u[r * 16 + 3]);
    },
    pool: () => e.readPool(),
    particles: async (r) => {
      const D = e.debugBuffers;
      const row = await R.row(r);
      const L = e.rooms;
      const rec = new Uint32Array(await g.read(D.dmeta, SLOT_W * 4, (L.slotRec + SLOT_W * row.slot) * 4));
      const cells = rec[3] * rec[4] * rec[5];
      const pages = [...new Uint32Array(await g.read(D.dmeta, rec[6] * 4, (L.tables + row.slot * L.table) * 4))];
      const x = new Float32Array(cells * 4);
      const v = new Float32Array(cells * 4);
      const bonds = new Uint32Array(cells);
      for (let j = 0; j < pages.length; j++) {
        const n = Math.min(PAGE, cells - j * PAGE);
        const X = new Float32Array(await g.read(D.px, n * 32, pages[j] * PAGE * 32));
        const S = new Float32Array(await g.read(D.ps, n * 48, pages[j] * PAGE * 48));
        const B = new Uint32Array(await g.read(D.pb, n * 4, pages[j] * PAGE * 4));
        for (let k = 0; k < n; k++) {
          x.set(X.subarray(k * 8, k * 8 + 4), (j * PAGE + k) * 4);
          v.set(S.subarray(k * 12, k * 12 + 4), (j * PAGE + k) * 4);
        }
        bonds.set(B, j * PAGE);
      }
      return { x, v, bonds, cells, pages };
    },
    gpuTick: async () => {
      if (!prof.enabled) return null;
      prof.active = true;
      e.timeKernels = true;
      prof.beginFrame();
      const t0 = performance.now();
      w.core.sim.step(w.core.globals, on);
      const enc = g.device.createCommandEncoder();
      const done = prof.endFrame(enc);
      g.device.queue.submit([enc.finish()]);
      const seen = prof.framesResolved;
      done?.();
      await g.device.queue.onSubmittedWorkDone();
      const wall = performance.now() - t0;
      for (let i = 0; i < 200 && prof.framesResolved === seen; i++) await new Promise((r) => setTimeout(r, 1));
      prof.active = false;
      e.timeKernels = false;
      const out = new Map<string, number>();
      let total = 0;
      for (const [k, ms] of prof.lastPasses) {
        out.set(k.replace('engine:', ''), ms);
        total += ms;
      }
      out.set('total', total);
      out.set('wall', wall);
      return out;
    },
    rows: async () => {
      const D = e.debugBuffers;
      const n = e.rooms.rows;
      const I = new Uint32Array(await g.read(D.info, n * 64));
      const If = new Float32Array(I.buffer);
      const P = new Float32Array(await g.read(D.pose, n * 64));
      const out = [];
      for (let r = 0; r < n; r++) if (I[r * 16 + 3] & 1) out.push({ row: r, flags: I[r * 16 + 3], mass: If[r * 16 + 7], model: I[r * 16 + 12], pos: [...P.slice(r * 16 + 8, r * 16 + 11)] });
      return out;
    },
    model: async (id) => {
      const at = id >>> 31 ? e.rooms.heap.cpu + (id & 0x7fffffff) : id;
      const H = new Uint32Array(await g.read(e.debugBuffers.heap, 64, at * 16));
      const cells = H[0] * H[1] * H[2];
      const recs = new Float32Array(await g.read(e.debugBuffers.heap, cells * 16, (at + 4) * 16));
      return { dims: [H[0], H[1], H[2]], solid: H[3], verts: H[5], recs };
    },
    drawn: async () => {
      const enc = g.device.createCommandEncoder();
      e.skin(enc, 1);
      g.device.queue.submit([enc.finish()]);
      const D = e.debugBuffers;
      const tris = new Uint32Array(await g.read(D.dl, 32))[7];
      const L = new Uint32Array(await g.read(D.dl, Math.max(1, tris) * 8, DL_AT * 4));
      const O = new Float32Array(await g.read(D.dout, Math.max(1, tris) * 96));
      const p = new Float32Array(tris * 9);
      const grain = new Float32Array(tris * 9);
      const W = new Uint32Array(O.buffer, O.byteOffset, O.length);
      for (let v = 0; v < tris * 3; v++) {
        p.set(O.subarray(v * 8, v * 8 + 3), v * 3);
        grain.set(O.subarray(v * 8 + 4, v * 8 + 7), v * 3);
      }
      return { tris, row: Uint32Array.from({ length: tris }, (_, t) => L[2 * t]), p, grain, word: Uint32Array.from({ length: tris }, (_, t) => W[t * 24 + 3]) };
    },
  };
  // (the surface pass has run once before a body is tested against it)
  await R.step(1);
  return R;
}

export const flat = () => [{ z0: 0, z1: 10, mat: MAT.Stone }];
export const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number = MAT.Stone): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};

/** a row's drawn triangles, 9 floats each, in the list's order (collapsed ones left out) */
export function trisOf(d: Awaited<ReturnType<BreakRig['drawn']>>, row: number): number[][] {
  const out: number[][] = [];
  for (let t = 0; t < d.tris; t++) {
    if (d.row[t] !== row) continue;
    const p = [...d.p.subarray(t * 9, t * 9 + 9)];
    if (Math.hypot(p[3] - p[0], p[4] - p[1], p[5] - p[2]) < 1e-6) continue;
    out.push(p);
  }
  return out;
}
/** edges of a triangle set that are not shared by exactly two triangles, vertices welded within `tol` */
export function openEdges(tris: number[][], tol = 0.02): number {
  const ids = new Map<string, number>();
  const pts: number[][] = [];
  const idOf = (x: number, y: number, z: number) => {
    const c = [Math.round(x / tol), Math.round(y / tol), Math.round(z / tol)];
    // (a point near a cell's edge may round either way: look in the cells round it)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const id = ids.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
          if (id !== undefined && Math.hypot(pts[id][0] - x, pts[id][1] - y, pts[id][2] - z) < tol) return id;
        }
    ids.set(c.join(','), pts.length);
    pts.push([x, y, z]);
    return pts.length - 1;
  };
  const edges = new Map<string, number>();
  for (const t of tris) {
    const v = [idOf(t[0], t[1], t[2]), idOf(t[3], t[4], t[5]), idOf(t[6], t[7], t[8])];
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  // (closed: every edge is shared by an even number of triangles — two, or four where two cells of a part touch only
  // along an edge, which the grain's breaks leave more often than the plain ones did)
  let open = 0;
  for (const n of edges.values()) if (n % 2 !== 0) open++;
  return open;
}
