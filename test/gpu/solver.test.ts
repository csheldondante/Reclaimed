// The node solver on the GPU (solver.wgsl through solver.ts, on Dawn): the design's rules (DECISIONS rounds 106, 120;
// the user's notes) as tests, written before the kernel ran. A flat stone floor (top at z 10) on a tiny world; bodies
// placed over it and stepped at the tick rate.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { Solver } from '../../src/solver/solver';
import { TUNE, TUNING, worldG } from '../../src/tune/params';
import type { BodyRead, SolverBody, SolverCell } from '../../src/api/contracts/solver';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
const H = 64;
const FLOOR = 10;
// a ledge: x >= 40 stands 6 higher
const LEDGE_X = 40;
const LEDGE = 16;

let g: TestGpu;
let w: TinyWorld;
let solver: Solver;
beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(W, H, 32, (x) => [{ z0: 0, z1: x >= LEDGE_X ? LEDGE : FLOOR, mat: MAT.Stone }]), []);
  solver = new Solver(g.device, w.core.world, w.core.host.profiler);
  w.core.sim.systems.push(solver);
});
afterAll(async () => {
  // (the readbacks in flight finished before the world goes)
  await g.device.queue.onSubmittedWorkDone();
  await solver?.destroy();
  w?.destroy();
});

const box = (w0: number, d: number, h: number, x0: number, y0: number, z0: number, mat: number = MAT.Stone): SolverCell[] => {
  const out: SolverCell[] = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w0; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};

/** n ticks of the solver alone; the readbacks in */
async function step(n: number, each?: (t: number) => void) {
  for (let i = 0; i < n; i++) {
    w.core.sim.step(w.core.globals, (s) => s.name === 'solver');
    // (each tick's readback in before the next: the host keeps at most three in flight)
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 0));
    each?.(i);
  }
  await g.device.queue.onSubmittedWorkDone();
  await new Promise((r) => setTimeout(r, 5));
}
const rd = (b: SolverBody): BodyRead => {
  const r = solver.read(b);
  if (!r) throw new Error('no readback');
  return r;
};
const clear = () => {
  for (const b of [...solver.bodies]) solver.remove(b);
  TUNING.reset();
};
/** the angle (degrees) a rotation turns by */
const angle = (q: number[]) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;

test('compiles and steps with no GPU validation errors', async () => {
  clear();
  solver.add({ cells: box(2, 2, 2, 10, 10, 20) });
  await step(5);
  expect(g.takeErrors()).toEqual([]);
});

test('falls at the world gravity, uncapped (AR9, AR10)', async () => {
  clear();
  TUNE.rigid.airDrag = 0;
  const b = solver.add({ cells: box(3, 3, 3, 20, 20, 50) })!;
  await step(30); // 0.5 s
  const r = rd(b);
  expect(r.vel[2]).toBeLessThan(-worldG() * 0.5 * 0.95);
  expect(r.vel[2]).toBeGreaterThan(-worldG() * 0.5 * 1.05);
  expect(g.takeErrors()).toEqual([]);
});

test('lands without a bounce, never launched, and goes to sleep where it landed', async () => {
  clear();
  const b = solver.add({ cells: box(3, 3, 3, 20, 20, 18) })!;
  let landed = -1;
  let maxUp = 0;
  let hardest = 0;
  await step(240, (t) => {
    const r = solver.read(b);
    if (!r) return;
    if (r.impact) hardest = Math.max(hardest, r.impact.speed);
    if (landed < 0 && r.touching > 0) landed = t;
    if (landed >= 0 && t > landed + 2) maxUp = Math.max(maxUp, r.vel[2]);
  });
  const r = rd(b);
  expect(landed).toBeGreaterThan(0);
  // (an 8-cell drop lands at ~12.5 cells/s)
  expect(hardest).toBeGreaterThan(9);
  // separation never adds speed: nothing going up faster than the push-out speed
  expect(maxUp).toBeLessThanOrEqual(TUNE.rigid.pushV + 0.05);
  // resting on the floor within its slop (its bottom at 10 less what it may sink)
  const bottom = r.pos[2] - 1.5;
  expect(bottom).toBeGreaterThan(FLOOR - 0.35);
  expect(bottom).toBeLessThan(FLOOR + 0.1);
  expect(r.asleep).toBe(true);
  expect(angle(r.q)).toBeLessThan(5);
});

test('an overlap within the slop is never corrected (PX3: surface deformation, no push-back)', async () => {
  clear();
  // a big slab (432 cells: slop 0.03 + min(0.8, 0.065·432^0.35) = 0.575) placed 0.3 into the floor: within its slop it is
  // never pushed out — it settles on to the slop's depth and is never moved up
  const cells = box(12, 12, 3, 10, 10, FLOOR);
  const probe = solver.add({ cells })!;
  const com = probe.restCom;
  solver.remove(probe);
  const slop = TUNE.rigid.slop + Math.min(TUNE.rigid.slopCap, TUNE.rigid.slopK * 432 ** TUNE.rigid.slopP);
  const b = solver.add({ cells, pose: { pos: [com[0], com[1], com[2] - 0.3], q: [0, 0, 0, 1] } })!;
  let maxUp = 0;
  let minZ = Infinity;
  await step(120, () => {
    const r = solver.read(b);
    if (r) {
      maxUp = Math.max(maxUp, r.vel[2]);
      minZ = Math.min(minZ, r.pos[2]);
    }
  });
  const r = rd(b);
  expect(maxUp).toBeLessThan(0.02);
  expect(r.pos[2]).toBeGreaterThan(com[2] - slop - 0.05);
  expect(r.pos[2]).toBeLessThan(com[2] - 0.3 + 1e-3);
  // and once there it stays there
  expect(r.pos[2] - minZ).toBeLessThan(0.02);
});

test('two big bodies resting against each other stay put, no separating speed', async () => {
  clear();
  // side by side, their faces touching: their node spheres reach into each other within the slop
  const a = solver.add({ cells: box(8, 8, 4, 10, 10, FLOOR) })!;
  const b = solver.add({ cells: box(8, 8, 4, 18, 10, FLOOR) })!;
  await step(30);
  const a0 = rd(a).pos;
  const b0 = rd(b).pos;
  let sep = 0;
  await step(300, () => {
    const ra = solver.read(a);
    const rb = solver.read(b);
    if (ra && rb) sep = Math.max(sep, rb.vel[0] - ra.vel[0]);
  });
  const ra = rd(a);
  const rb = rd(b);
  expect(Math.abs(ra.pos[0] - a0[0])).toBeLessThan(0.05);
  expect(Math.abs(rb.pos[0] - b0[0])).toBeLessThan(0.05);
  expect(sep).toBeLessThan(0.05);
});

test('overlapped past the slop: pushed apart no faster than rigid.pushV, never flung', async () => {
  clear();
  const a = solver.add({ cells: box(8, 8, 4, 10, 10, FLOOR) })!;
  const b = solver.add({ cells: box(8, 8, 4, 16, 10, FLOOR) })!;
  let fastest = 0;
  await step(240, () => {
    const ra = solver.read(a);
    const rb = solver.read(b);
    if (ra && rb) fastest = Math.max(fastest, Math.abs(rb.vel[0]), Math.abs(ra.vel[0]));
  });
  expect(fastest).toBeLessThanOrEqual(TUNE.rigid.pushV + 0.1);
});

test('stacked: a block on a block stays on it (body against body, PX6/RB5)', async () => {
  clear();
  const lower = solver.add({ cells: box(4, 4, 3, 20, 20, FLOOR) })!;
  const upper = solver.add({ cells: box(3, 3, 3, 20, 20, FLOOR + 6) })!;
  await step(300);
  const rl = rd(lower);
  const ru = rd(upper);
  // the upper rests on the lower (not through it, not fallen off)
  expect(ru.pos[2]).toBeGreaterThan(rl.pos[2] + 2.2);
  expect(Math.hypot(ru.pos[0] - rl.pos[0], ru.pos[1] - rl.pos[1])).toBeLessThan(1.5);
  expect(angle(ru.q)).toBeLessThan(10);
  expect(g.takeErrors()).toEqual([]);
});

test('topples over an edge by its weight (RB15): a pillar standing half off the ledge falls like a tree', async () => {
  clear();
  // a 2 × 2 × 10 pillar whose foot overhangs the ledge's edge, its weight off it
  const b = solver.add({ cells: box(2, 2, 10, LEDGE_X - 1, 20, LEDGE), vel: [-0.3, 0, 0] })!;
  await step(240);
  const r = rd(b);
  expect(angle(r.q)).toBeGreaterThan(45);
  expect(r.pos[2]).toBeLessThan(LEDGE);
});

test('a sleeping body is woken by a hard hit, not by being touched', async () => {
  clear();
  const base = solver.add({ cells: box(4, 4, 2, 20, 20, FLOOR) })!;
  await step(120);
  expect(rd(base).asleep).toBe(true);
  solver.add({ cells: box(3, 3, 3, 20, 20, FLOOR + 14) });
  let woke = false;
  await step(120, () => {
    if (solver.read(base)?.asleep === false) woke = true;
  });
  expect(woke).toBe(true);
});

test('steel holds its shape: a girder cantilevered off the ledge barely sags under its own weight', async () => {
  clear();
  const cells = box(24, 1, 2, LEDGE_X - 20, 30, LEDGE, MAT.Steel);
  const b = solver.add({ cells, pinned: (c) => c.x >= LEDGE_X })!;
  await step(180);
  const nodes = await solver.nodes(b);
  const low = Math.min(...nodes.map((n) => n.x[2]));
  if (process.env.SOLVER_LOG) console.log('cantilever low', low);
  expect(low).toBeGreaterThan(LEDGE + 0.5 - 0.3);
  expect(rd(b).parts).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('soft metal droops and stays drooped (plastic): no frame, a low yield', async () => {
  clear();
  TUNE.solver.steelFrame = 0;
  TUNE.solver.steelYield = 2;
  TUNE.solver.steelTensile = 2000;
  TUNE.solver.steelShear = 2000;
  const cells = box(24, 1, 2, LEDGE_X - 20, 34, LEDGE, MAT.Steel);
  const b = solver.add({ cells, pinned: (c) => c.x >= LEDGE_X })!;
  await step(120);
  const mid = await solver.nodes(b);
  const tip0 = Math.min(...mid.map((n) => n.x[2]));
  expect(tip0).toBeLessThan(LEDGE + 0.5 - 1);
  // its rest shape has followed: the girder's own idea of straight is now bent (plastic)
  const rest = await solver.rests(b);
  const r0 = Math.min(...rest.map((r) => r[2]));
  expect(r0).toBeLessThan(Math.max(...rest.map((r) => r[2])) - 1.5 - 0.5);
});

test('a girder bridge dents where a rock lands on it, and stays dented', async () => {
  clear();
  // a 24-long, 2 × 2 steel girder pinned at both ends, a 4-cell stone block dropped on its middle
  const cells = box(24, 2, 2, 16, 44, LEDGE, MAT.Steel);
  const b = solver.add({ cells, pinned: (c) => c.x < 18 || c.x >= 38 })!;
  await step(10);
  const rest0 = await solver.rests(b);
  const rock = solver.add({ cells: box(6, 2, 6, 25, 44, LEDGE + 16) })!;
  let hit = 0;
  for (let t = 0; t < 12; t++) {
    await step(20, () => {
      hit = Math.max(hit, solver.read(b)?.impact?.speed ?? 0);
    });
    if (process.env.SOLVER_LOG) {
      const ns = await solver.nodes(b);
      console.log(t * 20, ns.map((n) => n.x[2].toFixed(2)).join(' '), '| rest', (await solver.rests(b)).map((r) => r[2].toFixed(2)).join(' '), '| rock', solver.read(rock)?.pos[2].toFixed(2));
    }
  }
  expect(hit).toBeGreaterThan(5);
  const rest1 = await solver.rests(b);
  // the middle's rest shape went down (a dent), the pinned ends' didn't
  const midOf = (rs: number[][]) => Math.min(...rs.filter((r) => r[0] > 26 && r[0] < 30).map((r) => r[2]));
  expect(midOf(rest1)).toBeLessThan(midOf(rest0) - 0.1);
  expect(rd(b).parts).toBe(1);
});

test('a bond stressed past its strength snaps: the graph splits into parts', async () => {
  clear();
  TUNE.solver.steelFrame = 0;
  TUNE.solver.steelTensile = 8;
  TUNE.solver.steelShear = 8;
  const cells = box(24, 1, 2, LEDGE_X - 20, 40, LEDGE, MAT.Steel);
  const b = solver.add({ cells, pinned: (c) => c.x >= LEDGE_X })!;
  let broke = 0;
  await step(180, () => {
    broke += solver.read(b)?.broke ?? 0;
  });
  expect(broke).toBeGreaterThan(0);
  expect(rd(b).parts).toBeGreaterThan(1);
});
