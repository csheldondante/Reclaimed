// Terrain pieces are rows (docs/design/PHYSICS_ENGINE.md "Terrain pieces are rows", step 4; BACKLOG PT1). The owner:
// "terrain breaks and seems to use the lattice." Under ?solver=engine what the judge frees is a rigid row of the
// engine: the level's own Integrity on a tiny world, every system stepping; a rock tower's hold is cut — a row
// appears, no lattice particle and no CPU rock, the columns lost the cells the row gained, the row falls, lands and
// sleeps; a second freed piece lands on a row lying under it and does not pass through.
// Numbers for the DEVLOG: TERRAIN_LOG=1 npx vitest run --project gpu engine-terrain
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Engine, type EngineBody } from '../../src/engine/engine';
import type { EngineKit } from '../../src/engine/install';
import { modelMesh } from '../../src/engine/modelmesh';
import { Integrity } from '../../src/game/integrity';
import { installPhysics } from '../../src/physics/install';
import type { Physics } from '../../src/physics/physics';
import { OP } from '../../src/sim/edit-ops';
import { EventKind } from '../../src/sim/globals';
import { cellPos } from '../../src/world/lattice';
import { readColumn, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { box } from './engine-rig';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
const FLOOR = 10;
const ASLEEP = 2;
const LOG = !!process.env.TERRAIN_LOG;
let g: TestGpu;
let w: TinyWorld;
let ig: Integrity;
let phys: Physics;
let e: Engine;
const made: EngineBody[] = [];

// (stone to 10; two stone towers 4 x 4 to 26, each hanging over a gap and held by one corner column — its peg:
// tower A at 16..19 over a gap of 2, tower B at 40..43 over a gap of 4)
const A = { x: 16, y: 16, gap: 2 };
const B = { x: 40, y: 40, gap: 4 };
const TOP = 26;
const col = (x: number, y: number): Interval[] => {
  for (const t of [A, B]) {
    if (x < t.x || x >= t.x + 4 || y < t.y || y >= t.y + 4) continue;
    if (x === t.x && y === t.y) return [{ z0: 0, z1: TOP, mat: MAT.Stone }];
    return [{ z0: 0, z1: FLOOR, mat: MAT.Stone }, { z0: FLOOR + t.gap, z1: TOP, mat: MAT.Stone }];
  }
  return [{ z0: 0, z1: FLOOR, mat: MAT.Stone }];
};

beforeAll(async () => {
  g = await testGpu();
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/?solver=engine'), configurable: true });
  w = await tinyWorld(g, tinyMap(W, W, 48, col), 'all');
  // (the voxel lattice is there, as in the level: nothing may reach it on this route)
  phys = installPhysics(w.core, { wakeOnTouch: false }).physics;
  // (the engine as engine/install.ts puts it in: after the surface pass; no renderer here, so no draw hook)
  e = new Engine(g.device, w.core.world, w.core.host.profiler);
  const sys = w.core.sim.systems;
  sys.splice(sys.findIndex((s) => s.name === 'surface') + 1, 0, e);
  const kit: EngineKit = {
    engine: e,
    drop: (cells, vel, spin) => {
      const b = e.add({ cells, mesh: modelMesh(cells), vel, spin });
      if (b) made.push(b);
      return b;
    },
    model: (cells) => e.addModel(cells, modelMesh(cells)),
    clear: () => e.clear(),
  };
  ig = new Integrity(w.core, true);
  ig.physics = phys;
  ig.engine = kit;
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  w?.destroy();
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true });
});

async function frames(n: number, until?: () => boolean): Promise<number> {
  for (let i = 0; i < n; i++) {
    w.core.sim.step(w.core.globals, () => true);
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 0));
    ig.update(1 / 60);
    if (until?.()) return i + 1;
  }
  return n;
}

/** everything solid in the columns, in cells (the test's own read) */
async function volume(): Promise<number> {
  const f = await w.read('layers');
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  let v = 0;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) for (const iv of readColumn(w.core.packed, u, x, y)) v += iv.z1 - iv.z0;
  return v;
}

async function row(b: EngineBody): Promise<{ flags: number; pos: number[]; v: number[] }> {
  const D = e.debugBuffers;
  const I = new Uint32Array(await g.read(D.info, 64, b.row * 64));
  const P = new Float32Array(await g.read(D.pose, 64, b.row * 64));
  const V = new Float32Array(await g.read(D.vel, 32, b.row * 32));
  return { flags: I[3], pos: [...P.slice(8, 11)], v: [...V.slice(0, 3)] };
}

/** a tower's peg cut through (a blow the height of its gap), with the judge held till the rubble lies */
async function cutPeg(t: { x: number; y: number; gap: number }): Promise<number> {
  ig.paused.judge = true;
  const [px, py] = cellPos(t.x, t.y);
  w.core.globals.events.push({ kind: EventKind.Edit, x: px, y: py, z: OP.SMASH * 32, radius: t.gap / 2 + 0.1, strength: FLOOR + t.gap / 2 });
  await frames(40);
  const v = await volume();
  ig.paused.judge = false;
  ig.markDirty(px, py, 6);
  return v;
}

test('the engine route sends nothing to the lattice or the CPU rock', () => {
  expect(ig.route.rock).toBe('engine');
  expect(ig.route.metal).toBe('engine');
  expect(ig.route.structures).toBe('rock');
});

test('a rock tower cut at its base: an engine row of exactly its cells, which falls, lands and sleeps', async () => {
  await frames(3);
  const before = await cutPeg(A);
  const waited = await frames(300, () => ig.stats.rows > 0);
  expect(ig.stats.rows).toBe(1);
  expect(made.length).toBe(1);
  // (no old-lattice particle, no CPU rock body, nothing falling in the columns)
  expect(phys.bodies.length).toBe(0);
  expect(phys.used).toBe(0);
  expect(ig.rigid!.list.length).toBe(0);
  expect(ig.falling.list.length).toBe(0);
  await frames(2);
  const after = await volume();
  const b = made[0];
  // (mass: the columns lost what the row gained — the tower above its gap, 16 columns; the cut's ends are fractional
  // in the peg's column only, its cells whole)
  expect(b.cells).toBe(ig.stats.rowCells);
  expect(b.cells).toBeGreaterThanOrEqual(15 * (TOP - FLOOR - A.gap));
  expect(Math.abs(before - after - b.cells)).toBeLessThan(0.5);
  const z0 = b.restCom[2];
  let fell = 0;
  let slept = -1;
  for (let i = 0; i < 40 && slept < 0; i++) {
    await frames(15);
    const r = await row(b);
    fell = Math.max(fell, z0 - r.pos[2]);
    if (r.flags & ASLEEP) slept = (i + 1) * 15;
  }
  const r = await row(b);
  if (LOG) console.log(`tower A: judged in ${waited} frames, ${b.cells} cells, columns lost ${(before - after).toFixed(3)}, release ${ig.stats.rowMs.toFixed(1)} ms, fell ${fell.toFixed(2)}, asleep after ${slept} frames at z ${r.pos[2].toFixed(2)}`);
  // (it fell its gap, to the floor — not through it — and sleeps)
  expect(fell).toBeGreaterThan(A.gap - 0.6);
  expect(r.pos[2]).toBeGreaterThan(z0 - A.gap - 1.5);
  expect(slept).toBeGreaterThan(0);
  expect(phys.bodies.length).toBe(0);
  expect(g.takeErrors()).toEqual([]);
}, 240_000);

test('a freed piece lands on an engine row lying under it: it does not pass through', async () => {
  // (a steel slab two thick on the floor in tower B's gap, under all of it but the peg's row)
  const slab = e.add({ cells: box(B.x + 1, B.y, FLOOR, 3, 4, 2, MAT.Steel), asleep: true })!;
  const n0 = made.length;
  await cutPeg(B);
  await frames(300, () => made.length > n0);
  expect(made.length).toBe(n0 + 1);
  const b = made[n0];
  const z0 = b.restCom[2];
  let slept = -1;
  for (let i = 0; i < 60 && slept < 0; i++) {
    await frames(15);
    if ((await row(b)).flags & ASLEEP) slept = (i + 1) * 15;
  }
  const r = await row(b);
  const s = await row(slab);
  if (LOG) console.log(`tower B: ${b.cells} cells fell ${(z0 - r.pos[2]).toFixed(2)} of a gap of ${B.gap} (slab 2 thick), asleep after ${slept} frames; slab at z ${s.pos[2].toFixed(2)}`);
  // (the gap is 4, the slab 2: it comes down 2 and stops on the slab — through it, it would have come down 4)
  expect(z0 - r.pos[2]).toBeGreaterThan(1.2);
  expect(z0 - r.pos[2]).toBeLessThan(3);
  // (the slab stayed on the floor under it)
  expect(s.pos[2]).toBeGreaterThan(FLOOR + 0.5);
  expect(s.pos[2]).toBeLessThan(FLOOR + 1.6);
  expect(slept).toBeGreaterThan(0);
  expect(phys.bodies.length).toBe(0);
  expect(ig.rigid!.list.length).toBe(0);
  expect(g.takeErrors()).toEqual([]);
}, 240_000);
