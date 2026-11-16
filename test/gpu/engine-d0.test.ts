// D0 of build step 2 (docs/design/PHYSICS_ENGINE.md "D0"): the engine's stage 4 against the lattice route it was forked
// from (?solver=lattice, the look the owner approved), on the same drop — a 6 x 6 x 4 stone block from 24 cells — and
// contacts among deforming voxels (the voxel hash, only over what deforms).
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-d0 --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { Physics } from '../../src/physics/physics';
import { modelMesh } from '../../src/engine/modelmesh';
import { POOL } from '../../src/engine/engine';
import { TUNE } from '../../src/tune/params';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat } from './engine-rig';
import { tinyWorld } from './world';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);

const FLOOR = 10;
const DT = 1 / 60;
/** what a drop did, from its voxels' places tick by tick (the same measure for both routes) */
interface Drop {
  /** seconds from the hit till the voxels' mean speed has stayed under 0.4 cells/s for half a second (-1: never) */
  still: number;
  /** how far the voxels' mean height came back up after its lowest (cells), and the highest any voxel's did above the block's own height */
  rebound: number;
  top: number;
  alive: number;
}
function measure(frames: Float32Array[], stride: number): Drop {
  const mean: number[] = [];
  const speed: number[] = [];
  const top: number[] = [];
  let alive = 0;
  frames.forEach((F, t) => {
    let z = 0;
    let n = 0;
    let s = 0;
    let hi = -Infinity;
    const P = frames[Math.max(0, t - 1)];
    for (let i = 0; i < F.length; i += stride) {
      if (F[i + 3] < 0 || P[i + 3] < 0) continue;
      z += F[i + 2];
      hi = Math.max(hi, F[i + 2]);
      s += Math.hypot(F[i] - P[i], F[i + 1] - P[i + 1], F[i + 2] - P[i + 2]) / DT;
      n++;
    }
    mean.push(z / Math.max(1, n));
    speed.push(s / Math.max(1, n));
    top.push(hi);
    alive = n;
  });
  // the hit: the tick the mean height is lowest for the first time after falling (the first local minimum)
  let hit = 1;
  while (hit < mean.length - 1 && mean[hit + 1] < mean[hit]) hit++;
  let still = -1;
  let run = 0;
  for (let t = hit; t < speed.length && still < 0; t++) {
    run = speed[t] < 0.4 ? run + 1 : 0;
    if (run >= 30) still = (t - 29 - hit) * DT;
  }
  let rebound = 0;
  let hiTop = 0;
  for (let t = hit; t < mean.length; t++) {
    rebound = Math.max(rebound, mean[t] - mean[hit]);
    hiTop = Math.max(hiTop, top[t] - (FLOOR + 4));
  }
  return { still, rebound, top: hiTop, alive };
}

const TICKS = 720;

async function latticeDrop(noSleep = false): Promise<Drop> {
  const w = await tinyWorld(g, tinyMap(32, 32, 64, flat), ['surface']);
  const phys = new Physics(g.device, w.core.world, w.core.host.profiler);
  const sys = w.core.sim.systems;
  sys.splice(sys.indexOf(w.core.sim.particles), 0, phys);
  const on = (s: { name: string }) => s.name === 'surface' || s.name === 'physics';
  w.core.sim.step(w.core.globals, on);
  const b = phys.spawnLattice(
    [6, 6, 4],
    () => MAT.Stone,
    (x, y, z) => {
      const [px, py] = cellPos(12 + x, 12 + y);
      return [px, py, 34 + z + 0.5];
    },
  )!;
  const frames: Float32Array[] = [];
  for (let t = 0; t < TICKS; t++) {
    w.core.sim.step(w.core.globals, on);
    await g.device.queue.onSubmittedWorkDone();
    // (the lattice's own sleep is on the CPU, from its read: let it land as it does in the game)
    await new Promise((r) => setTimeout(r, 0));
    if (noSleep) phys.wakeAll();
    const P = await phys.readPositions();
    frames.push(P.slice(b.offset * 8, (b.offset + 144) * 8));
  }
  const d = measure(frames, 8);
  w.destroy();
  return d;
}

async function engineDrop(): Promise<Drop & { settled: number }> {
  const R = await breakRig(g, flat);
  // (measured as the lattice is: by its voxels, so it must not settle into rows under the measure)
  T.stillT = 1e9;
  const cells = box(12, 12, 34, 6, 6, 4);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  const frames: Float32Array[] = [];
  let last: Float32Array | null = null;
  for (let t = 0; t < TICKS; t++) {
    await R.step(1);
    const row = await R.row(b.row);
    if (row.flags & 8) {
      last = (await R.particles(b.row)).x;
      frames.push(last);
    } else {
      // (rigid still: its voxels are the pose's — the mean is all the measure needs before the hit)
      const F = new Float32Array(144 * 4);
      for (let k = 0; k < 144; k++) F.set([row.pos[0], row.pos[1], row.pos[2], 1], k * 4);
      frames.push(F);
    }
  }
  const d = measure(frames, 4);
  const P = await R.pool();
  ok();
  R.w.destroy();
  return { ...d, settled: P[POOL.crumbs] };
}

test('D0.1: a cracked stone block comes to rest on the engine route about as fast as on the lattice route, and rebounds no higher', async () => {
  const lat = await latticeDrop();
  const eng = await engineDrop();
  if (process.env.BREAK_LOG) {
    const raw = await latticeDrop(true);
    console.log(`lattice route, its CPU sleep held off: still ${raw.still.toFixed(2)} s after the hit, mean rebound ${raw.rebound.toFixed(2)} cells, ${raw.alive} voxels left`);
  }
  if (process.env.BREAK_LOG) {
    console.log(`lattice route: still ${lat.still.toFixed(2)} s after the hit, mean rebound ${lat.rebound.toFixed(2)} cells, highest voxel ${lat.top.toFixed(2)} above the block's height, ${lat.alive} voxels left`);
    console.log(`engine route:  still ${eng.still.toFixed(2)} s after the hit, mean rebound ${eng.rebound.toFixed(2)} cells, highest voxel ${eng.top.toFixed(2)} above the block's height, ${eng.alive} voxels left`);
  }
  expect(lat.still).toBeGreaterThan(0);
  expect(eng.still).toBeGreaterThanOrEqual(0);
  // The margin: within a second of the lattice route's, its rebound within half a cell. (Five runs: the lattice
  // route 0.33 to 0.80 s and 0.07 to 0.10 cells, the engine 0.45 to 1.45 s and 0.26 to 0.34 cells; before the voxel
  // hash was restored the engine took 7.57 s and came back up 1.88 cells.)
  // (Since the shape matching takes places about the voxel's own — PE33 — the engine is still 1.8 to 1.9 s after the
  // hit, every run: the rounding it removed had been shortening this. The margin is 1.5 s for now; bringing stone's
  // time to still down to the lattice route's is BACKLOG PE35, the owner's "stone is too rubbery".)
  // (the lattice route's own figure runs from 0.33 to 0.82 s: against 0.33 the engine's 1.85 to 1.92 s missed 1.5 s by
  // a hair one run in three, so the bound is also never under 2.5 s, engine-stone's)
  // (PE35, the owner's "stone is too rubbery": brittle materials on the engine route have no bounce, full ring
  // damping and a give of 1 %, and part along their grain — still 0.00 to 0.05 s after the hit, rebound 0.00 to 0.03
  // cells: now inside the lattice route's own figures, and held there)
  expect(eng.still).toBeLessThan(0.85);
  expect(eng.rebound).toBeLessThan(0.1);
  ok();
  // (the limit: two routes of 720 ticks, each tick read back whole — 59 to 60 s on physics10-all, 84 s after the join's
  // gated stage 4 on physics10-atlas, on this PC alone on the GPU; the project's 60 s was a wall-time miss, not a
  // behaviour one: BACKLOG TKN9, PA16)
}, 180_000);

// ---- D0.2: contacts among deforming voxels (the voxel hash, only over what deforms) ----------------------------------------
/** the least distance between two living voxels (x: 4 floats a voxel, w < 0 gone) of a and b (the same set: every pair once) */
function nearest(a: Float32Array, b: Float32Array): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 0) continue;
    for (let j = a === b ? i + 4 : 0; j < b.length; j += 4) {
      if (b[j + 3] < 0) continue;
      best = Math.min(best, Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]));
    }
  }
  return best;
}

test('D0.2: the parts of a cracked block do not pass through each other (no two voxels nearer than the crumble overlap allows)', async () => {
  const R = await breakRig(g, flat);
  T.stillT = 1e9;
  const cells = box(12, 12, 34, 6, 6, 4);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  let worst = Infinity;
  let deformed = false;
  for (let t = 0; t < 36; t++) {
    await R.step(10);
    if (!((await R.row(b.row)).flags & 8)) continue;
    deformed = true;
    const p = await R.particles(b.row);
    worst = Math.min(worst, nearest(p.x, p.x));
  }
  expect(deformed).toBe(true);
  const P = await R.pool();
  if (process.env.BREAK_LOG) console.log(`cracked block: the nearest two voxels came ${worst.toFixed(3)} cells apart; hash chains cut short ${P[POOL.hashOver]}`);
  // (a voxel is a cell across; two this far into each other and the weaker crumbles: voxels.crumbleOverlap, 0.5)
  expect(worst).toBeGreaterThan(0.45);
  expect(P[POOL.hashOver]).toBe(0);
  ok();
  R.w.destroy();
});

test('D0.2: two deforming blocks meet: one dropped on another comes to rest on it, not inside it', async () => {
  const R = await breakRig(g, flat);
  T.stillT = 1e9;
  const lowCells = box(13, 13, 10, 4, 4, 2);
  const low = R.e.add({ cells: lowCells, mesh: modelMesh(lowCells) })!;
  const highCells = box(14, 14, 16, 2, 2, 2);
  const high = R.e.add({ cells: highCells, mesh: modelMesh(highCells) })!;
  await R.step(1);
  R.e.expand(low);
  R.e.expand(high);
  await R.step(120);
  const a = await R.particles(low.row);
  const c = await R.particles(high.row);
  let lowTop = -Infinity;
  let highLow = Infinity;
  for (let k = 0; k < a.cells; k++) if (a.x[k * 4 + 3] >= 0) lowTop = Math.max(lowTop, a.x[k * 4 + 2]);
  for (let k = 0; k < c.cells; k++) if (c.x[k * 4 + 3] >= 0) highLow = Math.min(highLow, c.x[k * 4 + 2]);
  if (process.env.BREAK_LOG) console.log(`two deforming blocks: the lower one's top voxels at ${lowTop.toFixed(2)}, the upper one's lowest at ${highLow.toFixed(2)}, nearest pair ${nearest(a.x, c.x).toFixed(3)}`);
  // (voxel centres: the lower block's top layer at 11.5, the upper one resting on it at about 12.5)
  expect(highLow).toBeGreaterThan(lowTop + 0.5);
  expect(nearest(a.x, c.x)).toBeGreaterThan(0.45);
  ok();
  R.w.destroy();
});

// ---- found in letter E's lab captures (BACKLOG PE33): far from the origin a body lying still was pushed across the ground --
test('a cracked block far from the origin stays where it fell (the shape matching takes every place about the voxel\'s own)', async () => {
  // (x about 236, y about 199: where the playground's break station stands; a float's step there is 1.5e-5 of a cell)
  const R = await breakRig(g, flat, 256, 256);
  T.stillT = 1e9;
  // (and with no voxel contacts to damp it: the drift was 4 to 11 cells/s so, 0.5 with them)
  R.e.voxelHash = false;
  const cells = box(234, 228, 34, 4, 4, 3);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  let hit = -1;
  for (let t = 0; t < 300 && hit < 0; t++) {
    await R.step(1);
    if ((await R.row(b.row)).flags & 8) hit = t;
  }
  expect(hit).toBeGreaterThan(0);
  const centre = async () => {
    const p = await R.particles(b.row);
    const c = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < p.cells; k++) {
      if (p.x[k * 4 + 3] < 0) continue;
      n++;
      for (let a = 0; a < 3; a++) c[a] += p.x[k * 4 + a];
    }
    return c.map((v) => v / n);
  };
  await R.step(60);
  const c0 = await centre();
  await R.step(240);
  const c1 = await centre();
  const moved = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  if (process.env.BREAK_LOG) console.log(`far from the origin (${c0.map((v) => v.toFixed(1))}): in 4 s lying on the ground its voxels' centre moved ${moved.toFixed(4)} cells sideways`);
  // (measured 0.30 cells in the 4 s — a broken pile spreading, 0.08 cells/s — against tens of cells before the fix)
  expect(moved).toBeLessThan(1);
  ok();
  R.w.destroy();
});
