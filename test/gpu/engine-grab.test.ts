// The engine's grab (the telekinesis tool under ?solver=engine; engine.ts grab / grabTarget / grabRelease): the row
// under the finger's view ray, the nearest along it, is picked on the GPU (no read tells the host which), a damped
// spring pulls its centre to where the ray crosses the level plane at the height it was grabbed at (plus a lift) with
// its weight held up, and letting go drops the spring and nothing else.
// Numbers for the DEVLOG: GRAB_LOG=1 npx vitest run --project gpu engine-grab --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE, worldG } from '../../src/tune/params';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);
const log = (s: string) => {
  if (process.env.GRAB_LOG) console.log(s);
};
const ASLEEP = 2;
const GRAB = 128;
const HZ = 60;
const speed = (v: number[]) => Math.hypot(v[0], v[1], v[2]);

/** a 3x3x3 stone block asleep on the floor (its top at 10) */
function sleeper(R: BreakRig, x: number, y: number) {
  const cells = box(x, y, 10, 3, 3, 3);
  return R.e.add({ cells, mesh: modelMesh(cells), asleep: true })!;
}
type V3 = [number, number, number];
const DOWN: V3 = [0, 0, -1];
/** a ray straight down through (x, y): what it crosses a level plane at is (x, y) */
const over = (x: number, y: number): V3 => [x, y, 60];
const slot = async (R: BreakRig) => new Uint32Array(await g.read(R.e.debugBuffers.pool, 4, POOL.grab * 4))[0];
const poseBits = async (R: BreakRig, row: number) => [...new Uint32Array(await g.read(R.e.debugBuffers.pose, 64, row * 64))];
const awake = async (R: BreakRig) => new Uint32Array(await g.read(R.e.debugBuffers.list, 32))[3];

// (the overshoot's bound: a spring damped 0.6 of critical passes its target by e^(-0.6 pi / 0.8) = 9.5 % of the pull,
// 0.57 of 6 cells; the bound leaves room for the substep and the lift)
for (const pairs of [1, 0]) {
  test(`a sleeping block grabbed and pulled 6 cells sideways goes to the target, overshoots under a cell and stays there while held (${pairs ? 'bodies meet bodies' : 'the terrain-only route'})`, async () => {
    T.pairs = pairs;
    const R = await breakRig(g, flat);
    const a = sleeper(R, 6, 12);
    const far = sleeper(R, 22, 22);
    await R.step(2);
    const p0 = (await R.row(a.row)).pos;
    const farBits = await poseBits(R, far.row);
    expect((await R.row(a.row)).flags & ASLEEP).toBe(ASLEEP);
    const target = [p0[0] + 6, p0[1], p0[2] + 2];
    R.e.grab(over(p0[0] + 0.5, p0[1]), DOWN, 0.5);
    R.e.grabTarget(over(target[0], target[1]), DOWN, 2);
    let past = 0;
    let at30 = 0;
    let fastest = 0;
    for (let t = 0; t < 240; t++) {
      await R.step(1);
      const r = await R.row(a.row);
      past = Math.max(past, r.pos[0] - target[0]);
      fastest = Math.max(fastest, speed(r.v));
      if (t === 30) at30 = r.pos[0] - p0[0];
    }
    const r = await R.row(a.row);
    log(`grab pull (pairs ${pairs}): 6 cells; after 0.5 s ${at30.toFixed(2)} cells on, fastest ${fastest.toFixed(2)} cells/s, overshoot ${past.toFixed(3)} cells, after 4 s ${Math.hypot(r.pos[0] - target[0], r.pos[1] - target[1], r.pos[2] - target[2]).toFixed(4)} cells off at ${speed(r.v).toFixed(4)} cells/s`);
    expect(at30).toBeGreaterThan(3);
    expect(past).toBeLessThan(1);
    expect(Math.hypot(r.pos[0] - target[0], r.pos[1] - target[1], r.pos[2] - target[2])).toBeLessThan(0.1);
    expect(speed(r.v)).toBeLessThan(0.05);
    // (held, it is awake and marked; the other block was never touched)
    expect(r.flags & (ASLEEP | GRAB)).toBe(GRAB);
    expect((await R.row(far.row)).flags & (ASLEEP | GRAB)).toBe(ASLEEP);
    expect(await poseBits(R, far.row)).toEqual(farBits);
    ok();
  });
}

test('let go while it moves, a grabbed block keeps its velocity: the spring is gone and only gravity acts', async () => {
  const R = await breakRig(g, flat);
  const a = sleeper(R, 6, 12);
  await R.step(2);
  const p0 = (await R.row(a.row)).pos;
  R.e.grab(over(p0[0], p0[1]), DOWN, 0.5);
  R.e.grabTarget(over(p0[0] + 6, p0[1]), DOWN, 4);
  await R.step(14);
  const before = await R.row(a.row);
  expect(Math.hypot(before.v[0], before.v[1])).toBeGreaterThan(3);
  R.e.grabRelease();
  await R.step(1);
  const after = await R.row(a.row);
  const drag = 1 - T.airDrag / HZ;
  log(`grab release: v before ${before.v.map((x) => x.toFixed(3))}, a tick after ${after.v.map((x) => x.toFixed(3))} (gravity ${(worldG() / HZ).toFixed(3)} a tick)`);
  expect(after.flags & GRAB).toBe(0);
  expect(after.v[0]).toBeCloseTo(before.v[0] * drag, 2);
  expect(after.v[1]).toBeCloseTo(before.v[1] * drag, 2);
  expect(after.v[2]).toBeCloseTo((before.v[2] - worldG() / HZ) * drag, 1);
  // (and it flies on: a third of a second later it is where that speed takes it, sideways)
  await R.step(10);
  const later = await R.row(a.row);
  expect(later.pos[0] - after.pos[0]).toBeGreaterThan(0.8 * after.v[0] * (10 / HZ));
  expect(await slot(R)).toBe(0);
  ok();
});

test('a ray that passes no body grabs nothing: nothing changes and nothing wakes', async () => {
  const R = await breakRig(g, flat);
  const a = sleeper(R, 4, 4);
  const b = sleeper(R, 10, 4);
  await R.step(2);
  const bits = [await poseBits(R, a.row), await poseBits(R, b.row)];
  expect(await awake(R)).toBe(0);
  R.e.grab(over(24, 20), DOWN, 2);
  R.e.grabTarget(over(24, 14), DOWN, 2);
  for (let t = 0; t < 30; t++) {
    await R.step(1);
    expect(await awake(R)).toBe(0);
  }
  expect(await slot(R)).toBe(0);
  expect([await poseBits(R, a.row), await poseBits(R, b.row)]).toEqual(bits);
  for (const r of [a, b]) expect((await R.row(r.row)).flags & (ASLEEP | GRAB)).toBe(ASLEEP);
  ok();
});

test('the spring slack adds no energy: a block held at the place it lies stays at rest', async () => {
  const R = await breakRig(g, flat);
  const a = sleeper(R, 12, 12);
  await R.step(2);
  const p0 = (await R.row(a.row)).pos;
  R.e.grab(over(p0[0], p0[1]), DOWN, 0.5);
  R.e.grabTarget(over(p0[0], p0[1]), DOWN, 0);
  let fastest = 0;
  let off = 0;
  for (let t = 0; t < 120; t++) {
    await R.step(1);
    const r = await R.row(a.row);
    fastest = Math.max(fastest, speed(r.v) + speed(r.spin));
    off = Math.max(off, Math.hypot(r.pos[0] - p0[0], r.pos[1] - p0[1], r.pos[2] - p0[2]));
  }
  log(`grab slack: over 2 s fastest ${fastest.toExponential(2)} cells/s, furthest ${off.toExponential(2)} cells`);
  expect((await R.row(a.row)).flags & (ASLEEP | GRAB)).toBe(GRAB);
  expect(fastest).toBeLessThan(0.01);
  expect(off).toBeLessThan(0.01);
  ok();
});

// (the owner's ruling on TKN8: "the tool must grab what is under the finger, not what stands on the ground point behind it")
test('a ray through the top block of a stack of five grabs it and not the bottom one, and it is held at its own height', async () => {
  const R = await breakRig(g, flat);
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const cells = box(12, 12, 10 + 2 * i, 3, 3, 2);
    rows.push(R.e.add({ cells, mesh: modelMesh(cells), asleep: true })!);
  }
  await R.step(2);
  const top = (await R.row(rows[4].row)).pos;
  const bottomBits = await poseBits(R, rows[0].row);
  // (a view ray as the camera's: down at a slant, through the top block's centre; it passes within a thumb of the
  // blocks under it too, and its ground point is far behind the stack)
  const l = Math.hypot(1, 0.6, -0.8);
  const d: V3 = [1 / l, 0.6 / l, -0.8 / l];
  const from = (p: number[]): V3 => [p[0] - d[0] * 40, p[1] - d[1] * 40, p[2] - d[2] * 40];
  R.e.grab(from(top), d, 2);
  R.e.grabTarget(from(top), d, 0);
  await R.step(30);
  expect((await slot(R)) & 0xfffff).toBe(rows[4].row);
  expect((await R.row(rows[4].row)).flags & (ASLEEP | GRAB)).toBe(GRAB);
  for (const b of rows.slice(0, 4)) expect((await R.row(b.row)).flags & GRAB).toBe(0);
  expect(await poseBits(R, rows[0].row)).toEqual(bottomBits);
  // (the finger moves 5 cells sideways: the block goes there in the plane it was grabbed in, not down to the ground)
  const aim = [top[0] + 5, top[1], top[2]];
  R.e.grabTarget(from(aim), d, 0);
  let low = Infinity;
  for (let t = 0; t < 180; t++) {
    await R.step(1);
    low = Math.min(low, (await R.row(rows[4].row)).pos[2]);
  }
  const r = await R.row(rows[4].row);
  log(`grab by ray: the top block of five (row ${rows[4].row}) from ${top.map((v) => v.toFixed(2))} to ${r.pos.map((v) => v.toFixed(2))}, lowest ${low.toFixed(3)}`);
  expect(Math.hypot(r.pos[0] - aim[0], r.pos[1] - aim[1], r.pos[2] - aim[2])).toBeLessThan(0.1);
  expect(low).toBeGreaterThan(top[2] - 0.1);
  expect(await poseBits(R, rows[0].row)).toEqual(bottomBits);
  ok();
});

test('a slanted ray that misses every body grabs nothing', async () => {
  const R = await breakRig(g, flat);
  const a = sleeper(R, 12, 12);
  await R.step(2);
  const bits = await poseBits(R, a.row);
  const p = (await R.row(a.row)).pos;
  const l = Math.hypot(1, 0.6, -0.8);
  const d: V3 = [1 / l, 0.6 / l, -0.8 / l];
  // (through a point 8 cells beside the block: further than its bound and a thumb)
  R.e.grab([p[0] - d[0] * 40, p[1] + 8 - d[1] * 40, p[2] - d[2] * 40], d, 1);
  R.e.grabTarget([p[0] - d[0] * 40, p[1] + 2 - d[1] * 40, p[2] - d[2] * 40], d, 0);
  await R.step(20);
  expect(await slot(R)).toBe(0);
  expect(await awake(R)).toBe(0);
  expect(await poseBits(R, a.row)).toEqual(bits);
  ok();
});
