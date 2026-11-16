// Deforming voxels meet rigid rows (docs/design/PHYSICS_ENGINE.md "Pieces break pieces"; BACKLOG PJ5): a body that is
// lattice particles collides with the rigid rows of its pairs by their distance fields (engine_meetlink.wgsl,
// engine_meet.wgsl), and the rows take the reaction. On Dawn over a tiny world.
// Numbers for the DEVLOG: MEET_LOG=1 npx vitest run --project gpu engine-meet --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { EngineBody } from '../../src/engine/engine';
import { TUNE } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const LOG = !!process.env.MEET_LOG;
const log = (...a: unknown[]) => LOG && console.log(...a);
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);
const ASLEEP = 2;
const DEFORM = 8;

/** a deforming body's voxels: how many live, their mass, momentum, kinetic energy and bounds */
async function voxels(R: BreakRig, b: EngineBody) {
  const P = await R.particles(b.row);
  let n = 0;
  let mass = 0;
  const p = [0, 0, 0];
  let ke = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < P.cells; k++) {
    const w = P.x[k * 4 + 3];
    if (w <= 0) continue;
    const m = 1 / w;
    n++;
    mass += m;
    for (let a = 0; a < 3; a++) {
      const v = P.v[k * 4 + a];
      p[a] += m * v;
      ke += 0.5 * m * v * v;
      lo[a] = Math.min(lo[a], P.x[k * 4 + a]);
      hi[a] = Math.max(hi[a], P.x[k * 4 + a]);
    }
  }
  return { n, mass, p, ke, lo, hi };
}
const rowKe = (r: { mass: number; v: number[] }) => 0.5 * r.mass * (r.v[0] ** 2 + r.v[1] ** 2 + r.v[2] ** 2);

test('a deforming stone block lands on a sleeping steel block and does not pass through it', async () => {
  T.stillT = 100;
  const R = await breakRig(g, flat);
  const steel = R.e.add({ cells: box(10, 10, 10, 8, 8, 3, MAT.Steel) })!;
  await R.step(90);
  const s0 = await R.row(steel.row);
  expect(s0.flags & ASLEEP).toBe(ASLEEP);
  const top = s0.pos[2] + 1.5;
  const stone = R.e.add({ cells: box(12, 12, 15, 4, 4, 4), vel: [0, 0, -4] })!;
  R.e.expand(stone);
  await R.step(2);
  expect((await R.row(stone.row)).flags & DEFORM).toBe(DEFORM);
  const v0 = await voxels(R, stone);
  let lowest = Infinity;
  let last = v0.ke;
  let gain = 0;
  const rows: string[] = [];
  for (let t = 0; t < 150; t++) {
    await R.step(1);
    const v = await voxels(R, stone);
    const s = await R.row(steel.row);
    lowest = Math.min(lowest, v.lo[2]);
    const e = v.ke + rowKe(s);
    // (falling adds what gravity gives: what it had when it touched is the most it may ever have after)
    if (v.lo[2] - 0.5 > top + 0.05) last = Math.max(last, e);
    else gain = Math.max(gain, e - last);
    if (t % 25 === 0) rows.push(`t ${t + 1}: ${v.n} voxels, lowest centre ${v.lo[2].toFixed(3)} (steel top ${top.toFixed(3)}), KE ${e.toFixed(1)}, steel ${s.flags & ASLEEP ? 'asleep' : 'awake'} z ${s.pos[2].toFixed(4)}`);
  }
  const v = await voxels(R, stone);
  const s = await R.row(steel.row);
  log(rows.join('\n'), `\nlowest voxel centre ever ${lowest.toFixed(3)}; most its kinetic energy was over what it landed with ${gain.toFixed(2)} of ${v0.ke.toFixed(1)}; voxels ${v0.n} -> ${v.n}`);
  ok();
  // (a voxel is a ball of half a cell: its centre never deeper than the material's overlap past the steel's top)
  expect(lowest).toBeGreaterThan(top + 0.5 - 0.45);
  expect(v.n).toBeGreaterThan(v0.n * 0.6);
  // (no more than the tick of gravity between the last look before it touched and the touch)
  expect(gain).toBeLessThan(0.05 * last);
  // (the steel is on the ground: it has not been driven into it)
  expect(Math.abs(s.pos[2] - s0.pos[2])).toBeLessThan(0.1);
}, 120_000);

test('a deforming stone block thrown at a sleeping steel block: the steel gains at most the momentum the stone lost, and kinetic energy never rises', async () => {
  T.stillT = 100;
  T.friction = 0.05;
  const R = await breakRig(g, flat, 64, 32);
  const steel = R.e.add({ cells: box(30, 12, 10, 3, 4, 4, MAT.Steel) })!;
  await R.step(90);
  expect((await R.row(steel.row)).flags & ASLEEP).toBe(ASLEEP);
  const stone = R.e.add({ cells: box(22, 12, 10, 4, 4, 4), vel: [10, 0, 0] })!;
  R.e.expand(stone);
  await R.step(2);
  const v0 = await voxels(R, stone);
  const x0 = (await R.row(steel.row)).pos[0];
  let last = v0.ke;
  let gain = 0;
  let most = 0;
  let woke = -1;
  let through = -Infinity;
  const rows: string[] = [];
  for (let t = 0; t < 120; t += 2) {
    await R.step(2);
    const v = await voxels(R, stone);
    const s = await R.row(steel.row);
    const e = v.ke + rowKe(s);
    // (never more than came in: a reaction lands a tick after the voxels gave it, so a tick's sum can dip and return)
    gain = Math.max(gain, e - last);
    if (woke < 0 && !(s.flags & ASLEEP)) woke = t + 2;
    // the steel's momentum along the throw against what the stone has lost of its own
    const lost = v0.p[0] - v.p[0];
    most = Math.max(most, steel.mass * s.v[0] - lost);
    // (the stone's leading voxels against the steel's near face)
    through = Math.max(through, v.hi[0] + 0.5 - (s.pos[0] - 1.5));
    if (t % 10 === 0) rows.push(`t ${t + 2}: stone px ${v.p[0].toFixed(1)} (${v.n} voxels, front ${v.hi[0].toFixed(2)}), steel px ${(steel.mass * s.v[0]).toFixed(1)} x ${s.pos[0].toFixed(3)}, KE ${e.toFixed(1)}`);
  }
  const s = await R.row(steel.row);
  log(rows.join('\n'), `\nstone came in with px ${v0.p[0].toFixed(1)}, KE ${v0.ke.toFixed(1)}; steel woke at tick ${woke}, moved ${(s.pos[0] - x0).toFixed(3)}; most the steel's momentum was over what the stone had lost ${most.toFixed(2)}; most the kinetic energy was over what came in ${gain.toFixed(2)}; deepest the stone's front was past the steel's face ${through.toFixed(3)}`);
  ok();
  expect(woke).toBeGreaterThan(0);
  expect(s.pos[0] - x0).toBeGreaterThan(0.05);
  // (at most what was lost: the tolerance is a hundredth of what came in)
  expect(most).toBeLessThan(0.01 * v0.p[0]);
  expect(gain).toBeLessThan(0.01 * v0.ke);
  expect(through).toBeLessThan(0.6);
}, 120_000);

test('a rigid block dropped on a deforming body rests on it', async () => {
  T.stillT = 100;
  const R = await breakRig(g, flat);
  const slab = R.e.add({ cells: box(10, 10, 10, 8, 8, 3) })!;
  R.e.expand(slab);
  await R.step(30);
  expect((await R.row(slab.row)).flags & DEFORM).toBe(DEFORM);
  const v0 = await voxels(R, slab);
  const top = v0.hi[2] + 0.5;
  const block = R.e.add({ cells: box(12, 12, 14, 3, 3, 3) })!;
  const rows: string[] = [];
  const b0 = await R.row(block.row);
  let z2 = 0;
  for (let t = 0; t < 360; t += 30) {
    await R.step(30);
    const b = await R.row(block.row);
    if (t + 30 === 180) z2 = b.pos[2];
    rows.push(`t ${t + 30}: block xy ${b.pos[0].toFixed(2)},${b.pos[1].toFixed(2)} z ${b.pos[2].toFixed(4)} v ${b.v[2].toFixed(4)} (slab top ${top.toFixed(3)})`);
  }
  const b = await R.row(block.row);
  const v = await voxels(R, slab);
  log(rows.join('\n'), `\nslab voxels ${v0.n} -> ${v.n}`);
  ok();
  // (its centre a cell and a half over the slab's top, less the overlap a voxel bears)
  expect(b.pos[2]).toBeGreaterThan(top + 1.5 - 0.45);
  expect(b.pos[2]).toBeLessThan(top + 1.5 + 0.2);
  // (at rest but for a creep: the voxels under it give way slowly, as voxels do under voxels — measured 0.03 cells/s
  // on a slab kept deforming for this test; in play a still body settles in half a second. BACKLOG PM2)
  expect(Math.abs(b.pos[2] - z2)).toBeLessThan(0.15);
  expect(Math.abs(b.v[2])).toBeLessThan(0.3);
  // (it has not slid off: voxels give a row no friction yet, and their jostling moves it — BACKLOG PM2)
  expect(Math.hypot(b.pos[0] - b0.pos[0], b.pos[1] - b0.pos[1])).toBeLessThan(2);
  expect(v.n).toBeGreaterThan(v0.n * 0.9);
}, 120_000);

test('a rigid block dropped on a body whose particles stand (still, not stepped) rests on it', async () => {
  const R = await breakRig(g, flat);
  R.e.settles = false;
  const slab = R.e.add({ cells: box(10, 10, 10, 8, 8, 3) })!;
  R.e.expand(slab);
  // (still for the still time: parked, its particles standing)
  await R.step(90);
  const v0 = await voxels(R, slab);
  const top = v0.hi[2] + 0.5;
  const block = R.e.add({ cells: box(12, 12, 14, 3, 3, 3) })!;
  await R.step(240);
  const b = await R.row(block.row);
  log(`block on standing particles: z ${b.pos[2].toFixed(4)} (top ${top.toFixed(3)}), v ${Math.hypot(...b.v).toFixed(4)}`);
  ok();
  expect(b.pos[2]).toBeGreaterThan(top + 1.5 - 0.45);
  expect(b.pos[2]).toBeLessThan(top + 1.5 + 0.2);
  expect(Math.hypot(...b.v)).toBeLessThan(0.3);
}, 120_000);

// (since the merge into physics10-one the join's quiet tick stands above `meets()`: with everything asleep the tick
// encodes nothing at all, so the meet kernels' own gate is no longer what is seen here — on physics10-mech this test
// counted 5 dispatches fewer than with them forced on. `meetAlways` cannot force them through a quiet tick.)
test('nothing awake, nothing deforming: the tick encodes nothing, the meet kernels with it', async () => {
  T.deform = 1;
  const R = await breakRig(g, flat);
  R.e.add({ cells: box(12, 12, 10, 4, 4, 4) });
  await R.step(120);
  await R.step(12);
  await new Promise((r) => setTimeout(r, 20));
  await R.step(4);
  await new Promise((r) => setTimeout(r, 20));
  const prof = (R.e as unknown as { prof: { dispatches: number } }).prof;
  const count = async () => {
    const d0 = prof.dispatches;
    await R.step(1);
    return prof.dispatches - d0;
  };
  const idle = await count();
  R.e.meetAlways = true;
  const always = await count();
  R.e.meetAlways = false;
  log(`dispatches a tick with everything asleep: ${idle}; with the meet kernels encoded: ${always}`);
  ok();
  expect(idle).toBe(0);
  expect(always).toBe(0);
  // awake again (a block added): the tick is encoded, with the candidates' kernel and one `meet` a lattice substep
  R.e.add({ cells: box(20, 12, 14, 2, 2, 2) });
  R.e.timeKernels = true;
  const names: string[] = [];
  const P = (R.e as unknown as { prof: { timestamps: (n: string) => unknown } }).prof;
  const real = P.timestamps.bind(P);
  P.timestamps = (n: string) => {
    names.push(n);
    return real(n);
  };
  await R.step(1);
  P.timestamps = real;
  R.e.timeKernels = false;
  ok();
  expect(names.filter((n) => n === 'engine:meetLink').length).toBe(1);
  expect(names.filter((n) => n === 'engine:meet').length).toBe(Math.round(T.latticeSubsteps));
});
