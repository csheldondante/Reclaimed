// The engine's piles (docs/design/PHYSICS_ENGINE.md "The join"; BACKLOG PJ1): many bodies at once through the joined
// tick — every pair found (against brute force), nothing through the floor, all asleep within a bound, the same run
// twice the same; what a tick costs awake and asleep; a row a room could not serve is held; instances bake once.
// Numbers for the DEVLOG: PAIRS_LOG=1 npx vitest run --project gpu engine-pile --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { EngineBody, EngineCell } from '../../src/engine/engine';
import { PAIR_HEADER_WORDS } from '../../src/engine/sdf/coarse';
import type { BodyRow } from '../../src/engine/sdf/contract';
import { hexSdfSpec } from '../../src/engine/sdf/hexmodel';
import type { SdfModelSpec } from '../../src/engine/sdf/models';
import { TUNE } from '../../src/tune/params';
import type { Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { brutePairs } from '../support/sdf-coarse-ref';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const LOG = !!process.env.PAIRS_LOG;
const log = (...a: unknown[]) => LOG && console.log(...a);
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);
const ASLEEP = 2;
const ALIVE = 1;
const FLOOR = 4;

/** flat ground at 10 with a pit down to FLOOR */
const pit = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number): Interval[] => [{ z0: 0, z1: x >= x0 && x < x1 && y >= y0 && y < y1 ? FLOOR : 10, mat: MAT.Stone }];

const SHAPES: [number, number, number, number][] = [
  [2, 2, 2, MAT.Stone],
  [3, 2, 2, MAT.Brick],
  [4, 2, 2, MAT.Concrete],
  [2, 2, 4, MAT.Stone],
  [3, 3, 3, MAT.Steel],
];

/** `n` mixed blocks in layers over the pit, none touching another */
function pour(R: BreakRig, n: number, x0: number, y0: number, across: number, z0 = 14): EngineBody[] {
  const out: EngineBody[] = [];
  for (let k = 0; k < n; k++) {
    const s = SHAPES[(k * 7 + Math.floor(k / across)) % SHAPES.length];
    const layer = Math.floor(k / (across * across));
    const i = k % across;
    const j = Math.floor(k / across) % across;
    // (rows in twos: the same shape two rows on is the same model)
    out.push(R.e.add({ cells: box(x0 + i * 5 + (layer % 2), y0 + j * 6 + 2 * (layer % 2), z0 + layer * 5, s[0], s[1], s[2], s[3]) })!);
  }
  return out;
}

interface Snap {
  flags: Uint32Array;
  pose: Float32Array;
  vel: Float32Array;
  model: Uint32Array;
}
async function snap(R: BreakRig): Promise<Snap> {
  const D = R.e.debugBuffers;
  const n = R.e.rooms.rows;
  const info = new Uint32Array(await g.read(D.info, n * 64));
  return { flags: Uint32Array.from({ length: n }, (_, r) => info[r * 16 + 3]), pose: new Float32Array(await g.read(D.pose, n * 64)), vel: new Float32Array(await g.read(D.vel, n * 32)), model: new Uint32Array(await g.read(D.model, n * 4)) };
}
async function pairsOf(R: BreakRig): Promise<string[]> {
  const c = R.e.collide.coarse;
  const head = new Uint32Array(await g.read(c.pairBuf, PAIR_HEADER_WORDS * 4));
  const k = Math.min(head[0], c.pairRoom);
  const raw = k ? new Uint32Array(await g.read(c.pairBuf, k * 8, PAIR_HEADER_WORDS * 4)) : new Uint32Array(0);
  return Array.from({ length: k }, (_, i) => `${Math.min(raw[2 * i], raw[2 * i + 1])},${Math.max(raw[2 * i], raw[2 * i + 1])}`);
}

/**
 * One tick, and its pair set against brute force over the poses it began with: the rows awake are the tick's own
 * list, the sleepers those asleep before it that the list lacks. Returns [pairs, pairs brute force has and the tick
 * lacks with a row not flagged].
 */
async function tickAgainstBrute(R: BreakRig, specs: SdfModelSpec[]): Promise<{ pairs: number; bare: string[]; extra: string[] }> {
  const before = await snap(R);
  await R.step(1);
  const D = R.e.debugBuffers;
  const head = new Uint32Array(await g.read(D.list, 32));
  const awake = new Set(head[3] ? [...new Uint32Array(await g.read(D.list, head[3] * 4, 32))] : []);
  const got = await pairsOf(R);
  const missing = new Uint32Array(await g.read(R.e.collide.missing, before.flags.length * 4));
  const bodies: BodyRow[] = [...before.flags].map((fl, r) => {
    const p = before.pose.subarray(r * 16 + 8, r * 16 + 16);
    const listed = awake.has(r);
    return { pos: [p[0], p[1], p[2]], quat: [p[4], p[5], p[6], p[7]], invMass: p[3], radius: before.vel[r * 8 + 7], model: before.model[r], asleep: !listed, dead: !(fl & ALIVE) || before.model[r] === 0xffffffff || (!listed && !(fl & ASLEEP)) };
  });
  const margin = R.e.collide.coarse.margin;
  const ref = brutePairs(bodies, specs, (b) => (b.model === 0xffffffff ? 0 : b.model), margin);
  const sure = ref.filter((x) => x.slack > 1e-3).map((x) => `${x.a},${x.b}`);
  const maybe = new Set(ref.filter((x) => Math.abs(x.slack) <= 1e-3).map((x) => `${x.a},${x.b}`));
  const have = new Set(got);
  expect(have.size, 'a pair written twice').toBe(got.length);
  const want = new Set(sure);
  return { pairs: got.length, bare: sure.filter((x) => !have.has(x) && x.split(',').some((r) => missing[Number(r)] === 0)), extra: got.filter((x) => !want.has(x) && !maybe.has(x)) };
}

test('a hundred instances of one model bake once', async () => {
  T.deform = 0;
  const R = await breakRig(g, flat, 64, 64);
  for (let k = 0; k < 100; k++) R.e.add({ cells: box(4 + (k % 10) * 5, 4 + Math.floor(k / 10) * 6, 10, 3, 2, 2) });
  await R.step(2);
  ok();
  expect(R.e.models.length).toBe(1);
  expect(R.e.store.count).toBe(1);
  expect(R.e.bakes).toEqual({ batches: 1, models: 1 });
  // (and each stands where its own cells were)
  const s = await snap(R);
  for (let k = 0; k < 100; k++) expect(s.pose[2 * k * 16 + 8], `row ${2 * k} x`).toBeCloseTo(4 + (k % 10) * 5 + 1.75, 1);
});

test('two hundred mixed blocks poured into a pit: every pair found, none through the floor, all asleep', async () => {
  T.deform = 0;
  const R = await breakRig(g, pit(6, 6, 42, 42), 48, 48);
  const bodies = pour(R, 200, 8, 8, 6);
  expect(R.e.models.length).toBeLessThanOrEqual(SHAPES.length * 2);
  // (the store's specs by its row, as the engine made them)
  const specs: SdfModelSpec[] = [];
  for (const b of bodies) if (!specs[b.model.sdf]) specs[b.model.sdf] = hexSdfSpec(box(b.model.lo[0], b.model.lo[1], b.model.lo[2], b.model.dims[0], b.model.dims[1], b.model.dims[2]), b.model.body.com);
  let sleptAt = -1;
  let worst = 0;
  let mostAwake = 0;
  let mostPairs = 0;
  const checks: string[] = [];
  const times: number[] = [];
  for (let t = 0; t < 30 * 60 && sleptAt < 0; t += 20) {
    const t0 = performance.now();
    await R.step(19);
    times.push((performance.now() - t0) / 19);
    worst = Math.max(worst, times[times.length - 1]);
    // (three ticks against brute force: falling, piling, settling — and every twentieth for the count)
    const c = await tickAgainstBrute(R, specs);
    mostPairs = Math.max(mostPairs, c.pairs);
    if (t === 60 || t === 140 || t === 240) checks.push(`tick ${t + 20}: ${c.pairs} pairs, ${c.bare.length} missed, ${c.extra.length} extra`);
    expect(c.bare, `tick ${t + 20}: pairs brute force has, the tick lacks, a row not flagged`).toEqual([]);
    expect(c.extra, `tick ${t + 20}: pairs brute force lacks`).toEqual([]);
    const s = await snap(R);
    const awake = bodies.filter((b) => !(s.flags[b.row] & ASLEEP)).length;
    mostAwake = Math.max(mostAwake, awake);
    if (!awake) sleptAt = t + 20;
  }
  const s = await snap(R);
  const zs = bodies.map((b) => s.pose[b.row * 16 + 10]);
  const inPit = bodies.filter((b) => s.pose[b.row * 16 + 10] < 10).length;
  log(checks.join('\n'), `\n200 blocks: all asleep at tick ${sleptAt} (${(sleptAt / 60).toFixed(1)} s); most pairs in a checked tick ${mostPairs}; lowest centre ${Math.min(...zs).toFixed(3)} (floor ${FLOOR}); ${inPit} in the pit; wall time a tick: mean ${(times.reduce((a, c) => a + c, 0) / times.length).toFixed(2)} ms, worst 19-tick mean ${worst.toFixed(2)} ms; growths ${JSON.stringify(R.e.collide.growths.map((x) => `${x.room} ${x.from}->${x.to}`))}; reads ${R.e.reads}`);
  ok();
  expect(checks.length).toBe(3);
  expect(sleptAt).toBeGreaterThan(0);
  // (no centre below the floor plus half the thinnest block, less the slop)
  expect(Math.min(...zs)).toBeGreaterThan(FLOOR + 1 - 0.3);
  expect(s.flags.filter((_, r) => r % 2 === 0 && r < 400).every((fl) => fl & ALIVE)).toBe(true);
  // nothing awake: the GPU's own timing of a whole tick, the kernels apart
  const asleep = await R.gpuTick();
  if (asleep) log(`asleep: engine GPU ${asleep.get('total')!.toFixed(3)} ms a tick (${[...asleep].filter(([k, v]) => v > 0.01 && k !== 'total' && k !== 'wall').map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})`);
}, 240_000);

// PAIRS_BENCH=1: what a tick costs with `n` blocks falling, piled and asleep (the GPU's own timestamps a kernel; the
// wall time of the worst tick). Desktop proxy; the phone decides (BACKLOG PJ3).
test.skipIf(!process.env.PAIRS_BENCH).each([200, 1000])('bench: %i blocks into a pit, a tick by kernel', async (n) => {
  T.deform = 0;
  const R = await breakRig(g, pit(4, 4, 92, 92), 96, 96);
  const bodies = pour(R, n, 6, 6, 12);
  const split = (m: Map<string, number> | null) => (m ? `${m.get('total')!.toFixed(2)} ms GPU, ${m.get('wall')!.toFixed(1)} ms wall (${[...m].filter(([k, v]) => v >= 0.06 && k !== 'total' && k !== 'wall').sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})` : 'no timestamps');
  let worst = 0;
  let worstAt = 0;
  const rows: string[] = [];
  let slept = -1;
  for (let t = 0; t < 40 * 60 && slept < 0; t++) {
    const t0 = performance.now();
    await R.step(1);
    const ms = performance.now() - t0;
    if (t > 2 && ms > worst) {
      worst = ms;
      worstAt = t;
    }
    if (t === 30 || t === 150 || t === 300 || t % 600 === 599) {
      const s = await snap(R);
      const awake = bodies.filter((b) => !(s.flags[b.row] & ASLEEP)).length;
      const head = new Uint32Array(await g.read(R.e.collide.coarse.pairBuf, 16));
      rows.push(`tick ${t}: ${awake} awake, ${head[0]} pairs: ${split(await R.gpuTick())}`);
      if (!awake) slept = t;
    }
  }
  if (slept < 0) rows.push('(not all asleep in 40 s)');
  const m = await R.gpuTick();
  console.log(`${n} blocks:\n${rows.join('\n')}\nasleep: ${split(m)}\nworst tick ${worst.toFixed(1)} ms wall at tick ${worstAt}; growths ${JSON.stringify(R.e.collide.growths.map((x) => `${x.room} ${x.from}->${x.to}`))}; reads ${R.e.reads}; bakes ${JSON.stringify(R.e.bakes)}`);
  ok();
}, 600_000);

test('the same pile twice comes to rest in the same poses', async () => {
  T.deform = 0;
  const run = async () => {
    const R = await breakRig(g, pit(14, 14, 36, 36), 48, 48);
    const bodies = pour(R, 48, 15, 15, 4);
    await R.step(900);
    const s = await snap(R);
    ok();
    return bodies.map((b) => [...s.pose.subarray(b.row * 16 + 8, b.row * 16 + 16), s.flags[b.row] & ASLEEP]);
  };
  const a = await run();
  const b = await run();
  let worst = 0;
  a.forEach((p, k) => p.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - b[k][i])))));
  log(`48 blocks, 900 ticks, twice: the largest difference in any pose word ${worst.toExponential(2)}; asleep ${a.filter((p) => p[8]).length} and ${b.filter((p) => p[8]).length}`);
  expect(worst).toBeLessThan(1e-3);
}, 240_000);

test('a row a room could not serve is held where it is, and goes on once the room has grown', async () => {
  T.deform = 0;
  // (room for two pairs: a column of six blocks set down touching asks for five)
  const R = await breakRig(g, flat, 32, 32, { collide: { pairRoom: 2 } });
  R.e.growPairs = false;
  const bs: EngineBody[] = [];
  for (let k = 0; k < 6; k++) bs.push(R.e.add({ cells: box(12, 12, 10 + k * 4, 4, 4, 4) })!);
  // and one in the air beside them, in no pair
  const free = R.e.add({ cells: box(22, 12, 20, 2, 2, 2) })!;
  let held = 0;
  for (let t = 0; t < 12; t++) {
    const before = await snap(R);
    await R.step(1);
    const after = await snap(R);
    const missing = new Uint32Array(await g.read(R.e.collide.missing, before.flags.length * 4));
    for (const b of bs) {
      if (!missing[b.row]) continue;
      held++;
      // (bit for bit: the centre and the rotation)
      expect([...new Uint32Array(after.pose.buffer, (b.row * 16 + 8) * 4, 8)], `tick ${t}, row ${b.row} held`).toEqual([...new Uint32Array(before.pose.buffer, (b.row * 16 + 8) * 4, 8)]);
    }
    expect(missing[free.row]).toBe(0);
  }
  expect(held).toBeGreaterThan(0);
  // (the block in no pair fell meanwhile)
  expect((await R.row(free.row)).pos[2]).toBeLessThan(20.9);
  R.e.growPairs = true;
  R.e.kick();
  // (a few ticks a step: a read lands between steps, as it does between frames)
  for (let t = 0; t < 80; t++) await R.step(3);
  const s = await snap(R);
  const missing = new Uint32Array(await g.read(R.e.collide.missing, s.flags.length * 4));
  ok();
  log(`rooms ${JSON.stringify(R.e.collide.rooms)}; growths ${JSON.stringify(R.e.collide.growths)}; missing ${[...missing].slice(0, 16)}; reads ${R.e.reads}`);
  expect([...missing].some((m) => m !== 0)).toBe(false);
  expect(R.e.collide.coarse.pairRoom).toBeGreaterThan(2);
  bs.forEach((b, k) => {
    expect(Math.abs(s.pose[b.row * 16 + 10] - (12 + 4 * k)), `block ${k}`).toBeLessThan(0.15 * (k + 1));
    expect(s.flags[b.row] & ASLEEP).toBe(ASLEEP);
  });
});

test('a fast stone block into a stone block: one deforms at least, and the mass is all there after they settle', async () => {
  T.pairExpand = 1;
  T.friction = 0.2;
  const R = await breakRig(g, flat, 64, 32);
  const cells = (x: number): EngineCell[] => box(x, 12, 10, 4, 4, 4);
  const rest = R.e.add({ cells: cells(30) })!;
  const hit = R.e.add({ cells: cells(24), vel: [30, 0, 0] })!;
  const mass0 = rest.mass + hit.mass;
  let expands = 0;
  for (let t = 0; t < 40 && !expands; t++) {
    await R.step(1);
    expands = (await R.pool())[16];
  }
  expect(expands).toBeGreaterThanOrEqual(1);
  let P = await R.pool();
  for (let t = 0; t < 30 * 60 && (P[15] || P[21] || t < 60); t += 30) {
    await R.step(30);
    P = await R.pool();
  }
  const rows = await R.rows();
  const mass = rows.reduce((s, r) => s + r.mass, 0);
  // (a stone voxel's mass for each that crumbled to the ground: engine-settle.test.ts)
  const crumbs = P[18] * (hit.mass / 64);
  log(`hit at 30 cells/s: ${expands} expanded, ${rows.length} rows at rest, ${P[18]} voxels to the ground; mass ${mass.toFixed(1)} + ${crumbs.toFixed(1)} of ${mass0.toFixed(1)}`);
  ok();
  expect(P[15]).toBe(0);
  expect(mass + crumbs).toBeCloseTo(mass0, 0);
}, 240_000);
