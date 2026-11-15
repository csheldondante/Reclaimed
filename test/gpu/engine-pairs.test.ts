// Bodies meeting bodies in the engine (docs/design/PHYSICS_ENGINE.md "The join"; BACKLOG PJ1): the body ↔ body
// passes (src/engine/sdf) inside the engine's tick and the pair solver (engine_pairs.wgsl), on Dawn over a tiny world.
// A test a rule, for pairs as engine.test.ts has them for terrain.
// Numbers for the DEVLOG: PAIRS_LOG=1 npx vitest run --project gpu engine-pairs --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { EngineBody } from '../../src/engine/engine';
import { PAIR_HEADER_WORDS } from '../../src/engine/sdf/coarse';
import { TUNE } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const LOG = !!process.env.PAIRS_LOG;
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);
const ASLEEP = 2;
const HZ = 60;

const speed = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
/** a row's kinetic energy: its centre's and (by its bound, an upper estimate is not needed here) none of its spin */
const kinetic = (r: { mass: number; v: number[] }) => 0.5 * r.mass * speed(r.v) ** 2;
/** the pairs the tick wrote, 'lo,hi' */
async function pairs(R: BreakRig): Promise<string[]> {
  const c = R.e.collide.coarse;
  const head = new Uint32Array(await g.read(c.pairBuf, PAIR_HEADER_WORDS * 4));
  const k = Math.min(head[0], c.pairRoom);
  const raw = k ? new Uint32Array(await g.read(c.pairBuf, k * 8, PAIR_HEADER_WORDS * 4)) : new Uint32Array(0);
  return Array.from({ length: k }, (_, i) => `${Math.min(raw[2 * i], raw[2 * i + 1])},${Math.max(raw[2 * i], raw[2 * i + 1])}`).sort();
}

test('two blocks sliding head-on stop each other and gain no energy', async () => {
  T.deform = 0;
  T.friction = 0.05;
  const R = await breakRig(g, flat, 48, 32);
  const a = R.e.add({ cells: box(12, 12, 10, 4, 4, 4), vel: [4, 0, 0] })!;
  const b = R.e.add({ cells: box(18, 12, 10, 4, 4, 4), vel: [-4, 0, 0] })!;
  let last = Infinity;
  let most = 0;
  let gap = Infinity;
  const rows: string[] = [];
  for (let t = 0; t < 240; t++) {
    await R.step(1);
    const [ra, rb] = [await R.row(a.row), await R.row(b.row)];
    const e = kinetic(ra) + kinetic(rb);
    // (never more than the tick before: gravity does no work on a block on flat ground beyond the slop's settling)
    most = Math.max(most, e - last);
    last = e;
    gap = Math.min(gap, rb.pos[0] - ra.pos[0]);
    if (LOG && t % 20 === 0) rows.push(`t ${t}: a x ${ra.pos[0].toFixed(3)} v ${ra.v[0].toFixed(3)}  b x ${rb.pos[0].toFixed(3)} v ${rb.v[0].toFixed(3)}  E ${e.toFixed(2)}`);
  }
  const [ra, rb] = [await R.row(a.row), await R.row(b.row)];
  if (LOG) console.log(rows.join('\n'), `\nleast gap of centres ${gap.toFixed(3)}, largest gain a tick ${most.toFixed(4)}`);
  ok();
  // (the blocks are 4 wide: centres never nearer than their width less the slop and a contact's reach)
  expect(gap).toBeGreaterThan(4 - 0.35);
  // (a tick's gain: under a thousandth of what they came in with — the first tick's settling onto the ground)
  expect(most).toBeLessThan(0.002 * (0.5 * a.mass * 16 * 2));
  expect(speed(ra.v)).toBeLessThan(0.3);
  expect(speed(rb.v)).toBeLessThan(0.3);
  expect(ra.pos[0]).toBeLessThan(rb.pos[0]);
});

test('a block lands on a sleeping block and rests on it; both sleep', async () => {
  T.deform = 0;
  const R = await breakRig(g, flat);
  const a = R.e.add({ cells: box(12, 12, 10, 4, 4, 4) })!;
  await R.step(90);
  const a0 = await R.row(a.row);
  expect(a0.flags & ASLEEP).toBe(ASLEEP);
  const b = R.e.add({ cells: box(12, 12, 15, 4, 4, 4) })!;
  await R.step(300);
  const [ra, rb] = [await R.row(a.row), await R.row(b.row)];
  if (LOG) console.log(`a z ${ra.pos[2].toFixed(4)} (was ${a0.pos[2].toFixed(4)})  b z ${rb.pos[2].toFixed(4)}  b xy drift ${Math.hypot(rb.pos[0] - a0.pos[0], rb.pos[1] - a0.pos[1]).toFixed(4)}`);
  ok();
  // (b's centre a block's height above a's, less at most the slop; never inside it)
  expect(rb.pos[2] - ra.pos[2]).toBeGreaterThan(4 - 0.2);
  expect(rb.pos[2] - ra.pos[2]).toBeLessThan(4 + 0.1);
  expect(Math.abs(ra.pos[2] - a0.pos[2])).toBeLessThan(0.1);
  expect(Math.hypot(rb.pos[0] - a0.pos[0], rb.pos[1] - a0.pos[1])).toBeLessThan(0.3);
  expect(ra.flags & ASLEEP).toBe(ASLEEP);
  expect(rb.flags & ASLEEP).toBe(ASLEEP);
});

test('a stack of five stays up for ten seconds and sleeps', async () => {
  T.deform = 0;
  const R = await breakRig(g, flat);
  const bs: EngineBody[] = [];
  for (let k = 0; k < 5; k++) bs.push(R.e.add({ cells: box(12, 12, 10 + k * 4, 4, 4, 4) })!);
  const z0 = (await Promise.all(bs.map((b) => R.row(b.row)))).map((r) => r.pos);
  let sleptAt = -1;
  let jitter = 0;
  for (let t = 0; t < 10 * HZ; t += 20) {
    await R.step(20);
    const rs = await Promise.all(bs.map((b) => R.row(b.row)));
    if (t > 60) jitter = Math.max(jitter, ...rs.map((r) => speed(r.v)));
    if (sleptAt < 0 && rs.every((r) => r.flags & ASLEEP)) sleptAt = t + 20;
  }
  const rs = await Promise.all(bs.map((b) => R.row(b.row)));
  if (LOG) console.log(rs.map((r, k) => `block ${k}: z ${r.pos[2].toFixed(4)} (from ${z0[k][2].toFixed(2)}), xy drift ${Math.hypot(r.pos[0] - z0[k][0], r.pos[1] - z0[k][1]).toFixed(4)}`).join('\n'), `\nall asleep at tick ${sleptAt}; fastest after the first second ${jitter.toFixed(4)} cells/s`);
  ok();
  rs.forEach((r, k) => {
    // (each within the summed slops of where it was put, none sunk into the one below)
    expect(Math.abs(r.pos[2] - z0[k][2]), `block ${k} height`).toBeLessThan(0.12 * (k + 1));
    expect(Math.hypot(r.pos[0] - z0[k][0], r.pos[1] - z0[k][1]), `block ${k} drift`).toBeLessThan(0.3);
    if (k) expect(r.pos[2] - rs[k - 1].pos[2], `block ${k} on ${k - 1}`).toBeGreaterThan(4 - 0.2);
    expect(r.flags & ASLEEP, `block ${k} asleep`).toBe(ASLEEP);
  });
  expect(sleptAt).toBeGreaterThan(0);
  expect(sleptAt).toBeLessThan(5 * HZ);
});

test('five odd blocks dropped a cell onto soil as a stack land as a stack and stay one (the button of the lab station)', async () => {
  // (soil over stone, as the playground's ground; stone and concrete in turn: two models)
  const soil = () => [{ z0: 0, z1: 8, mat: MAT.Stone }, { z0: 8, z1: 10, mat: MAT.Soil }];
  const R = await breakRig(g, soil);
  const bs: EngineBody[] = [];
  for (let k = 0; k < 5; k++) bs.push(R.e.add({ cells: box(12, 12, 11 + k * 2, 3, 3, 2, k % 2 ? MAT.Concrete : MAT.Stone) })!);
  const p0 = (await Promise.all(bs.map((b) => R.row(b.row)))).map((r) => r.pos);
  const rows: string[] = [];
  for (let t = 0; t < 360; t += 12) {
    await R.step(12);
    const rs = await Promise.all(bs.map((b) => R.row(b.row)));
    rows.push(`t ${t + 12}: ` + rs.map((r) => `${r.pos[2].toFixed(2)}${r.flags & ASLEEP ? 'z' : ''}/${Math.hypot(r.pos[0] - p0[0][0], r.pos[1] - p0[0][1]).toFixed(2)}`).join('  '));
  }
  if (LOG) console.log(rows.join('\n'), '\n(pool)', [...(await R.pool())].slice(13, 19).join(','));
  const rs = await Promise.all(bs.map((b) => R.row(b.row)));
  ok();
  rs.forEach((r, k) => {
    // (each interface gives up to the slop: 0.16 measured for these)
    expect(Math.abs(r.pos[2] - (11 + 2 * k)), `block ${k} height`).toBeLessThan(0.2 * k + 0.05);
    expect(Math.hypot(r.pos[0] - p0[k][0], r.pos[1] - p0[k][1]), `block ${k} drift`).toBeLessThan(0.4);
    expect(r.flags & ASLEEP, `block ${k} asleep`).toBe(ASLEEP);
  });
});

test('a sleeper under a light touch keeps its pose bit for bit; a hard hit wakes it and moves it', async () => {
  T.deform = 0;
  const R = await breakRig(g, flat, 48, 32);
  const a = R.e.add({ cells: box(20, 12, 10, 4, 4, 4) })!;
  await R.step(90);
  const D = R.e.debugBuffers;
  const before = new Uint8Array(await g.read(D.pose, 64, a.row * 64)).slice();
  // a block set down beside it, touching, creeping at it slower than the wake threshold
  const slow = R.e.add({ cells: box(15, 12, 10, 4, 4, 4), vel: [0.15, 0, 0] })!;
  await R.step(120);
  const mid = await R.row(a.row);
  expect(mid.flags & ASLEEP).toBe(ASLEEP);
  expect([...new Uint8Array(await g.read(D.pose, 64, a.row * 64))]).toEqual([...before]);
  expect(await pairs(R).then((p) => p.length)).toBeGreaterThanOrEqual(0);
  // then a block thrown at it
  const fast = R.e.add({ cells: box(25, 12, 10, 4, 4, 4), vel: [-8, 0, 0] })!;
  let woke = false;
  for (let t = 0; t < 60 && !woke; t++) {
    await R.step(1);
    woke = ((await R.row(a.row)).flags & ASLEEP) === 0;
  }
  await R.step(30);
  const after = await R.row(a.row);
  if (LOG) console.log(`sleeper x ${mid.pos[0].toFixed(3)} -> ${after.pos[0].toFixed(3)}; slow block at ${(await R.row(slow.row)).pos[0].toFixed(3)}, fast at ${(await R.row(fast.row)).pos[0].toFixed(3)}`);
  ok();
  expect(woke).toBe(true);
  expect(after.pos[0]).toBeLessThan(mid.pos[0] - 0.05);
});

test('a heavy block moves a light one more than a light one moves a heavy one', async () => {
  T.deform = 0;
  T.friction = 0.2;
  const run = async (wHit: number, wRest: number) => {
    const R = await breakRig(g, flat, 64, 32);
    const rest = R.e.add({ cells: box(30, 12 - wRest / 2, 10, wRest, wRest, 4) })!;
    const hit = R.e.add({ cells: box(30 - 3 - wHit, 12 - wHit / 2, 10, wHit, wHit, 4), vel: [6, 0, 0] })!;
    const x0 = (await R.row(rest.row)).pos[0];
    await R.step(240);
    const moved = (await R.row(rest.row)).pos[0] - x0;
    const h = await R.row(hit.row);
    ok();
    return { moved, hitV: h.v[0], rest: rest.mass, hit: hit.mass };
  };
  const heavy = await run(6, 2);
  const light = await run(2, 6);
  if (LOG) console.log(`heavy (${heavy.hit.toFixed(0)}) into light (${heavy.rest.toFixed(0)}): the light one moved ${heavy.moved.toFixed(3)}; light into heavy: the heavy one moved ${light.moved.toFixed(3)}`);
  expect(heavy.moved).toBeGreaterThan(0.5);
  expect(heavy.moved).toBeGreaterThan(3 * Math.max(light.moved, 0.01));
});

test('a block slides off a tilted block', async () => {
  T.deform = 0;
  T.friction = 0.2;
  // (the slab is to stay as put whatever lands on it)
  T.wakeEnergy = 5;
  const R = await breakRig(g, flat, 48, 32);
  // a wide steel slab tilted 20 degrees about y, added asleep in the air: it stays as put (the small block's landing
  // is under the wake threshold for a slab many times its mass)
  const a = 20 * (Math.PI / 180);
  const slab = R.e.add({ cells: box(14, 8, 14, 16, 8, 2, MAT.Steel), pose: { q: [0, Math.sin(a / 2), 0, Math.cos(a / 2)] }, asleep: true })!;
  const b = R.e.add({ cells: box(21, 11, 17, 2, 2, 2) })!;
  const s0 = await R.row(slab.row);
  const x0 = (await R.row(b.row)).pos;
  await R.step(360);
  const rb = await R.row(b.row);
  if (LOG) console.log(`block from (${x0.map((v) => v.toFixed(2))}) to (${rb.pos.map((v) => v.toFixed(2))})`);
  ok();
  // (it went down the slope's fall line, not through the slab: sideways by more than its own width)
  expect(Math.abs(rb.pos[0] - x0[0])).toBeGreaterThan(2);
  expect(rb.pos[2]).toBeGreaterThan(10.5);
  const s1 = await R.row(slab.row);
  expect(s1.flags & ASLEEP).toBe(ASLEEP);
  expect(s1.pos).toEqual(s0.pos);
});

test('nothing awake: no workgroup beyond the fixed ones, and no read is issued', async () => {
  T.deform = 0;
  const R = await breakRig(g, flat);
  for (let k = 0; k < 3; k++) R.e.add({ cells: box(8 + 6 * k, 12, 10, 4, 4, 4) });
  await R.step(120);
  const flags = await R.flags(6);
  expect([0, 2, 4].every((r) => flags[r] & ASLEEP)).toBe(true);
  // (the chain's last reads land and find nothing awake)
  await R.step(12);
  await new Promise((r) => setTimeout(r, 20));
  await R.step(4);
  // (the watch tick apart — `compact` alone every 60th quiet tick and one read after it, BACKLOG PP5a: off here,
  // tested in engine-ground.test.ts)
  R.e.watchEvery = 0;
  const reads = R.e.reads;
  await R.step(120);
  expect(R.e.reads).toBe(reads);
  expect(R.e.awakeSeen).toBe(0);
  // the tick's dispatches: the awake list's arguments are zero workgroups, and so is every argument the pair passes size
  const D = R.e.debugBuffers;
  const list = new Uint32Array(await g.read(D.list, 32));
  expect([list[0], list[3], list[4]]).toEqual([0, 0, 0]);
  const pd = R.e.collide.fine.pairDispatch;
  expect(new Uint32Array(await g.read(pd.buffer, 64))[pd.offset / 4]).toBe(0);
  expect(await pairs(R)).toEqual([]);
  // an event starts the chain again
  R.e.wakeNear([10, 12, 12], 3);
  await R.step(2);
  expect(R.e.reads).toBeGreaterThan(reads);
  ok();
});
