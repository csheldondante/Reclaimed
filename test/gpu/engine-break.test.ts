// The physics engine's round trip (DESIGN §10.4; docs/design/PHYSICS_ENGINE.md, build step 2; BACKLOG PE2): a rigid row
// in a hard collision becomes voxel-lattice particles, deforms or breaks, and its parts settle back into rows. The
// real kernels on Dawn over a tiny world's columns. Letter A: the particles' pages, the GPU allocators, growth ahead
// of need from the pool's header (read now and then, never waited for by a tick).
// Numbers for the DEVLOG: BREAK_LOG=1 npx vitest run --project gpu engine-break --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { DL_AT, Engine, PAGE, POOL, SLOT_W, type EngineBody, type EngineCell, type EngineModel } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE } from '../../src/tune/params';
import type { Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));

const ALIVE = 1;
const ASLEEP = 2;
const DEFORM = 8;

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
  /** the frame's draw run now (alpha 1: the poses as they are) and read: a triangle's row, its three vertices' places */
  drawn(): Promise<{ tris: number; row: Uint32Array; p: Float32Array }>;
}

export async function breakRig(g: TestGpu, col: (x: number, y: number) => Interval[], W = 32, H = 32): Promise<BreakRig> {
  const w = await tinyWorld(g, tinyMap(W, H, 64, col), ['surface']);
  const e = new Engine(g.device, w.core.world, w.core.host.profiler);
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
    drawn: async () => {
      const enc = g.device.createCommandEncoder();
      e.skin(enc, 1);
      g.device.queue.submit([enc.finish()]);
      const D = e.debugBuffers;
      const tris = new Uint32Array(await g.read(D.dl, 32))[7];
      const L = new Uint32Array(await g.read(D.dl, Math.max(1, tris) * 8, DL_AT * 4));
      const O = new Float32Array(await g.read(D.dout, Math.max(1, tris) * 96));
      const p = new Float32Array(tris * 9);
      for (let v = 0; v < tris * 3; v++) p.set(O.subarray(v * 8, v * 8 + 3), v * 3);
      return { tris, row: Uint32Array.from({ length: tris }, (_, t) => L[2 * t]), p };
    },
  };
  // (the surface pass has run once before a body is tested against it)
  await R.step(1);
  return R;
}

/** letter A's tests are about the pages: the particles stand as `fill` wrote them, and nothing settles */
function paging(R: BreakRig): void {
  T.stillT = 1e9;
  R.e.holdLattice = true;
}

export const flat = () => [{ z0: 0, z1: 10, mat: MAT.Stone }];
export const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number = MAT.Stone): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};
const ok = () => expect(g.takeErrors()).toEqual([]);

/** every body asked to deform until all of them have (the host can't know which the GPU had room for: a test reads the flags) */
async function expandAll(R: BreakRig, bodies: EngineBody[], tries = 40): Promise<number> {
  let fails = 0;
  for (let t = 0; t < tries; t++) {
    const fl = await R.flags(R.e.rows * 2);
    const left = bodies.filter((b) => !(fl[b.row] & DEFORM));
    if (!left.length) return fails;
    for (const b of left.slice(0, 16)) R.e.expand(b);
    await R.step(2);
    fails = (await R.pool())[POOL.failExpand];
  }
  throw new Error('expandAll: some bodies never got particles');
}

/** n bodies of one shared model, at rest side by side on the ground */
function field(R: BreakRig, m: EngineModel, n: number, pitch: number, perRow: number): EngineBody[] {
  const out: EngineBody[] = [];
  for (let i = 0; i < n; i++) {
    const c = m.body.com;
    out.push(R.e.add({ model: m, pose: { pos: [c[0] + (i % perRow) * pitch, c[1] + Math.floor(i / perRow) * pitch * 0.866 * 2, c[2]] } })!);
  }
  return out;
}

test('A: pages are taken and given back across many bodies, and a body is expanded from a shared model', async () => {
  const R = await breakRig(g, flat, 64, 64);
  paging(R);
  const m = R.e.addModel(box(2, 2, 10, 2, 2, 2));
  const bodies = field(R, m, 20, 3, 5);
  await R.step(2);
  await expandAll(R, bodies);
  let P = await R.pool();
  expect(P[POOL.deforming]).toBe(20);
  expect(P[POOL.expands]).toBe(20);
  // (a page a body: 8 voxels; none on the free stack yet)
  expect(P[POOL.pageNext] - P[POOL.pageTop]).toBe(20);
  // a body's particles: a voxel a model cell, where the row's pose puts it
  const r5 = await R.row(bodies[5].row);
  expect(r5.flags & DEFORM).toBe(DEFORM);
  const p = await R.particles(bodies[5].row);
  expect(p.cells).toBe(8);
  for (let k = 0; k < 8; k++) {
    expect(p.x[k * 4 + 3]).toBeCloseTo(1 / 2.7, 4);
    for (let a = 0; a < 3; a++) expect(p.x[k * 4 + a]).toBeCloseTo(r5.pos[a] + m.body.samples[k * 4 + a], 3);
    // (a 2 x 2 x 2: every voxel bonded to the other seven)
    expect(p.bonds[k].toString(2).replace(/0/g, '').length).toBe(7);
  }
  // let go: every page and slot back on its free stack, the rows freed
  R.e.release();
  await R.step(3);
  P = await R.pool();
  expect(P[POOL.deforming]).toBe(0);
  expect(P[POOL.pageTop]).toBe(P[POOL.pageNext]);
  expect(P[POOL.slotTop]).toBe(P[POOL.slotNext]);
  const fl = await R.flags(40);
  for (const b of bodies) expect(fl[b.row]).toBe(0);
  const used = P[POOL.pageNext];
  // and taken again from the stack: the never-used counter doesn't move
  const more = field(R, m, 20, 3, 5);
  await R.step(2);
  await expandAll(R, more);
  P = await R.pool();
  expect(P[POOL.deforming]).toBe(20);
  expect(P[POOL.pageNext]).toBe(used);
  expect(P[POOL.pageTop]).toBe(used - 20);
  ok();
  R.w.destroy();
});

test('A: more than 255 bodies hold particles at once (no body id in a particle)', async () => {
  const R = await breakRig(g, flat, 64, 64);
  paging(R);
  const m = R.e.addModel(box(1, 1, 10, 2, 2, 2));
  const bodies = field(R, m, 300, 3, 20);
  await R.step(2);
  await expandAll(R, bodies, 80);
  const P = await R.pool();
  expect(P[POOL.deforming]).toBe(300);
  expect(R.e.rooms.slots).toBeGreaterThanOrEqual(300);
  // (every one its own page, and the last one's particles are its own)
  const pages = new Set<number>();
  for (const b of [bodies[0], bodies[255], bodies[256], bodies[299]]) {
    const p = await R.particles(b.row);
    pages.add(p.pages[0]);
    const r = await R.row(b.row);
    expect(p.x[0]).toBeCloseTo(r.pos[0] + m.body.samples[0], 4);
  }
  expect(pages.size).toBe(4);
  ok();
  R.w.destroy();
});

test('A: more than 131,072 voxels across growth; running out leaves a body rigid and is counted', async () => {
  const R = await breakRig(g, flat, 32, 32);
  paging(R);
  const m = R.e.addModel(box(8, 8, 10, 16, 16, 16));
  const bodies: EngineBody[] = [];
  for (let i = 0; i < 40; i++) bodies.push(R.e.add({ model: m })!);
  await R.step(2);
  // no growth: the pool starts with 16 pages, a body takes 8 — two fit, the third finds no room
  R.e.growAhead = false;
  for (const b of bodies.slice(0, 3)) R.e.expand(b);
  await R.step(3);
  let P = await R.pool();
  expect(P[POOL.deforming]).toBe(2);
  expect(P[POOL.failExpand]).toBeGreaterThanOrEqual(1);
  const third = await R.row(bodies[2].row);
  expect(third.flags & (ALIVE | DEFORM)).toBe(ALIVE);
  expect(third.invM).toBeGreaterThan(0);
  // (what it took before it ran out went back: 16 pages out, none lost)
  expect(P[POOL.pageNext] - P[POOL.pageTop]).toBe(16);
  // growth on: the header's `want` sizes the buffers, and every body gets its particles
  R.e.growAhead = true;
  await expandAll(R, bodies, 80);
  P = await R.pool();
  expect(P[POOL.deforming]).toBe(40);
  expect((P[POOL.pageNext] - P[POOL.pageTop]) * PAGE).toBeGreaterThan(131072);
  expect(R.e.rooms.pages * PAGE).toBeGreaterThan(131072);
  // (the first body's particles came through every growth)
  const p = await R.particles(bodies[0].row);
  const r = await R.row(bodies[0].row);
  expect(p.cells).toBe(4096);
  expect(p.x[4095 * 4 + 2]).toBeCloseTo(r.pos[2] + 7.5, 3);
  ok();
  R.w.destroy();
});

test('A: nothing deforming, the deform kernels are dispatched with no workgroups', async () => {
  const R = await breakRig(g, flat);
  const b = R.e.add({ cells: box(14, 14, 10, 2, 2, 2) })!;
  await R.step(4);
  const args = async () => {
    const A = new Uint32Array(await g.read(R.e.debugBuffers.dargs, 32));
    const K = new Uint32Array(await g.read(R.e.debugBuffers.kargs, 32));
    // (the lattice's and the settle's over the live pages; the per-page and per-slot kernels')
    return [A[0], A[4], K[0], K[4]];
  };
  expect(await args()).toEqual([0, 0, 0, 0]);
  R.e.expand(b);
  await R.step(2);
  expect(await args()).toEqual([8, 0, 1, 1]);
  R.e.release(b);
  await R.step(3);
  expect(await args()).toEqual([0, 0, 0, 0]);
  expect(((await R.row(b.row)).flags & ASLEEP) | 0).toBe(0);
  ok();
  R.w.destroy();
});

// ---- letter B: expand ---------------------------------------------------------------------------------------------------
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

test('B: at the instant of expansion the mesh skinned to the particles is the rigid mesh (no vertex moves)', async () => {
  const R = await breakRig(g, flat);
  const cells = box(12, 12, 30, 4, 3, 5);
  const b = R.e.add({ cells, mesh: modelMesh(cells), vel: [1.5, -0.5, 0], spin: [1.2, 0.7, -0.9] })!;
  // (tumbling in the air: its pose is nothing special when it expands)
  await R.step(20);
  const rigid = await R.drawn();
  expect(rigid.tris).toBe(b.model.verts / 3);
  expect(rigid.tris).toBeGreaterThan(100);
  const before = await R.row(b.row);
  expect(Math.abs(before.q[3])).toBeLessThan(0.99);
  R.e.expand(b);
  await R.step(1);
  expect((await R.row(b.row)).flags & DEFORM).toBe(DEFORM);
  const skinned = await R.drawn();
  expect(skinned.tris).toBe(rigid.tris);
  // (the row is not solved on the tick it expands: the same triangles, vertex for vertex, to float rounding)
  const d = maxDiff(rigid.p, skinned.p);
  if (process.env.BREAK_LOG) console.log(`expand: ${rigid.tris} triangles, the largest vertex move ${d.toExponential(2)} cells`);
  expect(d).toBeLessThan(2e-4);
  // (and they are real triangles about the body, not collapsed ones)
  let far = 0;
  for (let v = 0; v < skinned.p.length; v += 3) far = Math.max(far, Math.hypot(skinned.p[v] - before.pos[0], skinned.p[v + 1] - before.pos[1], skinned.p[v + 2] - before.pos[2]));
  expect(far).toBeGreaterThan(2.5);
  expect(far).toBeLessThan(4.5);
  ok();
  R.w.destroy();
});

test('B: a soft landing never expands; a hard one does, and the particles carry the velocity and spin of the row', async () => {
  const R = await breakRig(g, flat);
  T.stillT = 1e9;
  // a short drop: under the stone's threshold
  const soft = R.e.add({ cells: box(6, 6, 12, 2, 2, 2) })!;
  await R.step(150);
  let P = await R.pool();
  expect(P[POOL.expands]).toBe(0);
  const s = await R.row(soft.row);
  expect(s.flags & (ALIVE | DEFORM | ASLEEP)).toBe(ALIVE | ASLEEP);
  // a long one, turning as it falls
  const hard = R.e.add({ cells: box(20, 20, 40, 3, 3, 3), spin: [0.8, 0.3, 0.5] })!;
  let hit = -1;
  for (let i = 0; i < 240 && hit < 0; i++) {
    await R.step(1);
    if ((await R.row(hard.row)).flags & DEFORM) hit = i;
  }
  expect(hit).toBeGreaterThan(60);
  P = await R.pool();
  expect(P[POOL.expands]).toBe(1);
  // (the tick it expands the lattice has not stepped it yet: the particles are as `fill` made them)
  const r = await R.row(hard.row);
  expect(r.v[2]).toBeLessThan(-15);
  const p = await R.particles(hard.row);
  expect(p.cells).toBe(27);
  for (let k = 0; k < 27; k++) {
    const rel = [p.x[k * 4] - r.pos[0], p.x[k * 4 + 1] - r.pos[1], p.x[k * 4 + 2] - r.pos[2]];
    const want = [r.v[0] + r.spin[1] * rel[2] - r.spin[2] * rel[1], r.v[1] + r.spin[2] * rel[0] - r.spin[0] * rel[2], r.v[2] + r.spin[0] * rel[1] - r.spin[1] * rel[0]];
    for (let a = 0; a < 3; a++) expect(p.v[k * 4 + a]).toBeCloseTo(want[a], 3);
  }
  // (the soft one slept through it)
  expect((await R.row(soft.row)).flags & DEFORM).toBe(0);
  ok();
  R.w.destroy();
});

// ---- letter C: the lattice on those particles only, still decided on the GPU ---------------------------------------------
const bondsOf = (b: Uint32Array) => b.reduce((n, w) => n + w.toString(2).replace(/0/g, '').length, 0);
const slotState = async (R: BreakRig, row: number) => {
  const L = R.e.rooms;
  const r = await R.row(row);
  return new Uint32Array(await g.read(R.e.debugBuffers.dmeta, 8, (L.slotRec + SLOT_W * r.slot) * 4))[0];
};

test('C: a stone block dropped from height is deformed by the lattice — it cracks, comes to rest on the ground, and goes still on the GPU', async () => {
  const R = await breakRig(g, flat);
  const cells = box(12, 12, 34, 6, 6, 4);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  let hit = -1;
  for (let i = 0; i < 300 && hit < 0; i++) {
    await R.step(1);
    if ((await R.row(b.row)).flags & DEFORM) hit = i;
  }
  expect(hit).toBeGreaterThan(0);
  const whole = bondsOf((await R.particles(b.row)).bonds);
  // the lattice takes the hit: bonds snap, some voxels go to the ground, the rest stop on it
  await R.step(30);
  const p1 = await R.particles(b.row);
  expect(bondsOf(p1.bonds)).toBeLessThan(whole);
  let alive = 0;
  let low = Infinity;
  for (let k = 0; k < p1.cells; k++) {
    if (p1.x[k * 4 + 3] < 0) continue;
    alive++;
    low = Math.min(low, p1.x[k * 4 + 2]);
  }
  expect(low).toBeGreaterThan(10.2);
  const P = await R.pool();
  // (every voxel is in the body or went to the ground: none lost)
  expect(alive + P[POOL.crumbs]).toBe(144);
  expect(alive).toBeGreaterThan(72);
  if (process.env.BREAK_LOG) console.log(`stone 6x6x4 from 24 cells: ${alive} voxels left of 144, ${P[POOL.crumbs]} to the ground, bonds ${whole} -> ${bondsOf(p1.bonds)}`);
  // still: decided by `slots` on the GPU; from then no lattice kernel moves it (its places bit for bit), and its mesh is drawn by them
  let still = -1;
  for (let i = 0; i < 150 && still < 0; i++) {
    await R.step(10);
    if ((await slotState(R, b.row)) === 7) still = i;
  }
  if (process.env.BREAK_LOG) console.log(`still ${(still * 10 + 30) / 60} s after the hit`);
  expect(still).toBeGreaterThanOrEqual(0);
  const a = await R.particles(b.row);
  await R.step(30);
  const c = await R.particles(b.row);
  expect(Buffer.from(c.x.buffer).equals(Buffer.from(a.x.buffer))).toBe(true);
  const d = await R.drawn();
  expect(d.tris).toBe(b.model.verts / 3);
  ok();
  R.w.destroy();
});

test('C: a steel beam dropped across a post bends and keeps its bonds', async () => {
  // a post two cells wide under the beam's middle
  const R = await breakRig(g, (x, y) => (x >= 15 && x <= 16 && y >= 14 && y <= 17 ? [{ z0: 0, z1: 16, mat: MAT.Stone }] : [{ z0: 0, z1: 10, mat: MAT.Stone }]));
  const cells = box(6, 15, 32, 20, 2, 1, MAT.Steel);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  let hit = -1;
  for (let i = 0; i < 300 && hit < 0; i++) {
    await R.step(1);
    if ((await R.row(b.row)).flags & DEFORM) hit = i;
  }
  expect(hit).toBeGreaterThan(0);
  const whole = bondsOf((await R.particles(b.row)).bonds);
  await R.step(180);
  const p = await R.particles(b.row);
  // (ductile: nothing crumbled, no bond snapped)
  expect((await R.pool())[POOL.crumbs]).toBe(0);
  expect(bondsOf(p.bonds)).toBe(whole);
  // bent over the post: its ends hang below its middle
  const zAt = (x: number) => (p.x[x * 4 + 2] + p.x[(x + 20) * 4 + 2]) / 2;
  const mid = (zAt(9) + zAt(10)) / 2;
  const ends = (zAt(0) + zAt(19)) / 2;
  if (process.env.BREAK_LOG) console.log(`steel 20x2x1 across a post: middle at ${mid.toFixed(2)}, ends at ${ends.toFixed(2)}`);
  expect(mid - ends).toBeGreaterThan(1);
  ok();
  R.w.destroy();
});

// ---- numbers for the DEVLOG (desktop proxy; BREAK_LOG=1) --------------------------------------------------------------------
test.runIf(!!process.env.BREAK_LOG)('numbers: a tick with nothing deforming, the tick 8 bodies of 16 x 16 x 16 expand, a tick with 32,768 voxels deforming', async () => {
  const R = await breakRig(g, flat);
  T.stillT = 1e9;
  const cells = box(8, 8, 10, 16, 16, 16);
  const m = R.e.addModel(cells, modelMesh(cells));
  const bodies: EngineBody[] = [];
  for (let i = 0; i < 8; i++) bodies.push(R.e.add({ model: m })!);
  await R.step(4);
  // (room made first, so the timed ticks hold no growth)
  R.e.growAhead = false;
  const ms = async (n: number) => {
    const t0 = performance.now();
    await R.step(n);
    return (performance.now() - t0) / n;
  };
  const idle = await ms(60);
  R.e.growAhead = true;
  for (const b of bodies) R.e.expand(b);
  await R.step(2);
  await R.pool();
  await R.step(2);
  R.e.release();
  await R.step(4);
  const again: EngineBody[] = [];
  for (let i = 0; i < 8; i++) again.push(R.e.add({ model: m })!);
  await R.step(4);
  for (const b of again) R.e.expand(b);
  const exp = await ms(1);
  const P = await R.pool();
  const live = await ms(60);
  console.log(`numbers (${g.adapterInfo}): rigid tick ${idle.toFixed(2)} ms; the tick 8 x 4,096 voxels expand ${exp.toFixed(2)} ms; ${P[POOL.deforming]} bodies, ${(P[POOL.pageNext] - P[POOL.pageTop]) * PAGE} voxels deforming ${live.toFixed(2)} ms a tick (wall time of submit to done, the surface pass included)`);
  ok();
  R.w.destroy();
});
