// Pieces break pieces (docs/design/PHYSICS_ENGINE.md "Pieces break pieces"; BACKLOG PM3-PM6): a hard hit between
// bodies expands them, a settled body's parts go on colliding, and the chain — A breaks B, a part of B breaks C. On
// Dawn over a tiny world. Numbers for the DEVLOG: CHAIN_LOG=1 npx vitest run --project gpu engine-chain --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
import { TUNE } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const LOG = !!process.env.CHAIN_LOG;
const log = (...a: unknown[]) => LOG && console.log(...a);
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);
const ALIVE = 1;
const ASLEEP = 2;
const DEFORM = 8;
// (engine.wgsl ROW_HELD: 256 since the merge into physics10-one — 128 is the grab's)
const HELD = 256;

/** stepped till nothing deforms but what is held and no body settles, or `most` ticks; the ticks it took */
async function rest(R: BreakRig, most: number, least = 60): Promise<number> {
  let P = await R.pool();
  let t = 0;
  for (; t < most && (t < least || P[POOL.deforming] > P[POOL.held] || P[POOL.settling]); t += 20) {
    await R.step(20);
    P = await R.pool();
  }
  return t;
}
/** the rows that are bodies now: a held body's own row is its parts' bound, not a body */
const bodies = async (R: BreakRig) => (await R.rows()).filter((r) => !(r.flags & DEFORM));

test('a steel block thrown into a stone block breaks the stone, not the steel; the mass is all there', async () => {
  T.friction = 0.2;
  // (MODE: free parts, the default — Engine.holdParts off: the stone's parts are rows with no field, PM4)
  const R = await breakRig(g, flat, 64, 32);
  const stone = R.e.add({ cells: box(30, 12, 10, 4, 4, 4) })!;
  await R.step(90);
  const steel = R.e.add({ cells: box(24, 12, 10, 3, 3, 3, MAT.Steel), vel: [25, 0, 0] })!;
  let stoneBroke = -1;
  for (let t = 0; t < 60 && stoneBroke < 0; t++) {
    await R.step(1);
    if ((await R.row(stone.row)).flags & DEFORM) stoneBroke = t;
  }
  const ticks = await rest(R, 30 * 60);
  const P = await R.pool();
  const rows = await bodies(R);
  const mass = rows.reduce((s, r) => s + r.mass, 0);
  const crumbs = P[POOL.crumbs] * (stone.mass / 64);
  const steels = rows.filter((r) => Math.abs(r.mass - steel.mass) < 0.01 * steel.mass);
  log(`steel at 25 cells/s into stone: the stone deformed at tick ${stoneBroke}; ${P[POOL.expands]} expanded; at rest after ${ticks} ticks: ${rows.length} rows (masses ${rows.map((r) => r.mass.toFixed(0)).join(', ')}), ${P[POOL.crumbs]} voxels to the ground, ${P[POOL.held]} bodies held; mass ${mass.toFixed(1)} + ${crumbs.toFixed(1)} of ${(stone.mass + steel.mass).toFixed(1)}`);
  ok();
  expect(stoneBroke).toBeGreaterThanOrEqual(0);
  expect(P[POOL.deforming]).toBe(P[POOL.held]);
  // (the steel is one row with all its mass; the stone lost voxels or came apart)
  expect(steels.length).toBe(1);
  expect(P[POOL.crumbs] + rows.length - 2).toBeGreaterThan(0);
  expect(mass + crumbs).toBeCloseTo(stone.mass + steel.mass, 0);
}, 240_000);

test('a soft touch between bodies expands nothing', async () => {
  const R = await breakRig(g, flat, 64, 32);
  R.e.add({ cells: box(30, 12, 10, 4, 4, 4) });
  await R.step(90);
  R.e.add({ cells: box(24, 12, 10, 4, 4, 4), vel: [3, 0, 0] });
  R.e.add({ cells: box(30, 12, 15, 4, 4, 4) });
  await R.step(300);
  const P = await R.pool();
  ok();
  expect(P[POOL.expands]).toBe(0);
  expect((await R.rows()).every((r) => r.flags & ASLEEP)).toBe(true);
}, 120_000);

/** flat ground at 10 with a ridge two cells wide and four high across it (columns 17 and 18) */
const ridge = (x: number) => [{ z0: 0, z1: x === 17 || x === 18 ? 14 : 10, mat: MAT.Stone }];

test('a slab broken over a ridge: its parts stay where they settled and hold what lands on them; a body that settles whole is let go', async () => {
  const R = await breakRig(g, ridge);
  // (MODE: held parts — Engine.holdParts, the hack of BACKLOG PM4, off by default: this test is of that mode alone)
  R.e.holdParts = true;
  const slab = R.e.add({ cells: box(12, 12, 40, 12, 4, 3) })!;
  // (it falls for two seconds before it breaks)
  for (let t = 0; t < 300 && !(await R.pool())[POOL.expands]; t += 10) await R.step(10);
  const ticks = await rest(R, 30 * 60);
  let P = await R.pool();
  const parts = (await R.rows()).filter((r) => r.flags & HELD);
  log(`slab over a ridge: at rest after ${ticks + 60} ticks, ${parts.length} parts (${parts.map((p) => `row ${p.row} mass ${p.mass.toFixed(0)} at ${p.pos.map((v) => v.toFixed(1))}`).join('; ')}), ${P[POOL.held]} held`);
  expect(parts.length).toBeGreaterThanOrEqual(2);
  expect(P[POOL.held]).toBe(1);
  expect((await R.row(slab.row)).flags & (ALIVE | ASLEEP | DEFORM)).toBe(ALIVE | ASLEEP | DEFORM);
  // a block dropped on the biggest part, from just above it
  const big = parts.sort((a, b) => b.mass - a.mass)[0];
  const D = R.e.debugBuffers;
  const before = new Uint8Array(await g.read(D.pose, 64, big.row * 64)).slice();
  const cx = Math.round(big.pos[0] - 0.5);
  const cy = Math.round(big.pos[1] / 0.866 - 0.5);
  const z = Math.ceil(big.pos[2]) + 4;
  const block = R.e.add({ cells: box(cx - 1, cy - 1, z, 2, 2, 2) })!;
  // (an impulse does not move a held part)
  R.e.impulse(big, [3, 0, 3]);
  let low = Infinity;
  for (let t = 0; t < 300; t += 10) {
    await R.step(10);
    low = Math.min(low, (await R.row(block.row)).pos[2]);
  }
  const b = await R.row(block.row);
  log(`a block dropped on the part at z ${big.pos[2].toFixed(2)}: at rest at ${b.pos.map((v) => v.toFixed(2))}, lowest ${low.toFixed(3)}, ${b.flags & ASLEEP ? 'asleep' : 'awake'}`);
  ok();
  // (it lies on the part — its centre over the part's — or beside it on the ground: never inside the part)
  const beside = Math.hypot(b.pos[0] - big.pos[0], b.pos[1] - big.pos[1]) > 2.5;
  if (!beside) expect(low).toBeGreaterThan(big.pos[2] + 0.5);
  expect(low).toBeGreaterThan(10 + 1 - 0.3);
  expect([...new Uint8Array(await g.read(D.pose, 64, big.row * 64))]).toEqual([...before]);
  // a body that expands and settles unbroken is its own row again on the shared model: nothing held for it
  const whole = R.e.add({ cells: box(4, 20, 10, 3, 3, 3) })!;
  await R.step(60);
  R.e.expand(whole);
  await R.step(4);
  await rest(R, 600);
  P = await R.pool();
  const w = await R.row(whole.row);
  ok();
  expect(w.flags & (ALIVE | DEFORM | HELD)).toBe(ALIVE);
  expect(P[POOL.held]).toBe(1);
  expect(P[POOL.deforming]).toBe(1);
}, 240_000);

// The chain, as the lab's button has it (src/levels/playground.ts, the pile station): a stone slab B lies across a
// concrete post with one end overhanging; a thin brick slab C lies on the ground under the overhang. A stone block A
// is thrown down on the overhang. B is to break, what comes down — the end of B, and A with it — to land on C, and C
// to break.
test('the chain: A falls on B and B breaks; a part of B falls on C and C breaks; everything ends at rest with its mass', async () => {
  const R = await breakRig(g, flat, 48, 32);
  // (MODE: held parts — Engine.holdParts, the hack of BACKLOG PM4, off by default. With free parts, the default, what
  // breaks off B has no field and passes through C: C does not break — the gap PJ6/PM4)
  R.e.holdParts = true;
  const post = R.e.add({ cells: box(18, 12, 10, 6, 4, 6, MAT.Concrete) })!;
  const C = R.e.add({ cells: box(24, 12, 10, 5, 4, 1, MAT.Brick) })!;
  const B = R.e.add({ cells: box(13, 12, 16, 16, 4, 1) })!;
  await R.step(120);
  expect((await R.row(B.row)).flags & ASLEEP).toBe(ASLEEP);
  expect((await R.row(C.row)).flags & ASLEEP).toBe(ASLEEP);
  // (thrown down: at the 20 cells/s a fall from here gives, the hit is at stone's break threshold, 60 measured against 60)
  const A = R.e.add({ cells: box(25, 12, 40, 4, 4, 4), vel: [0, 0, -15] })!;
  const mass0 = A.mass + B.mass + C.mass + post.mass;
  let bAt = -1;
  let cAt = -1;
  let most = 0;
  const rows: string[] = [];
  let P = await R.pool();
  let t = 0;
  for (; t < 40 * 60 && (t < 120 || P[POOL.deforming] > P[POOL.held] || P[POOL.settling] || cAt < 0); t += 4) {
    await R.step(4);
    const fb = (await R.row(B.row)).flags;
    const fc = (await R.row(C.row)).flags;
    if (bAt < 0 && fb & DEFORM) bAt = t;
    if (cAt < 0 && fc & DEFORM) cAt = t;
    P = await R.pool();
    most = Math.max(most, P[POOL.deforming] - P[POOL.held]);
    const ra = await R.row(A.row);
    if (t % 120 === 0) rows.push(`t ${t}: A ${ra.flags} at ${ra.pos.map((v) => v.toFixed(1))} v ${ra.v.map((v) => v.toFixed(1))}; ${P[POOL.expands]} expanded, ${P[POOL.deforming] - P[POOL.held]} deforming, ${P[POOL.held]} held, ${P[POOL.parts]} parts, ${P[POOL.crumbs]} voxels to the ground`);
    if (cAt < 0 && t > 20 * 60) break;
    // (what a tick costs while two bodies deform: the GPU's own timestamps a kernel)
    if (LOG && t === 100) {
      const m = await R.gpuTick();
      if (m) rows.push(`tick ${t}, ${P[POOL.deforming] - P[POOL.held]} deforming: engine GPU ${m.get('total')!.toFixed(2)} ms (${[...m].filter(([k, v]) => v >= 0.06 && k !== 'total' && k !== 'wall').sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})`);
    }
  }
  // (and the rows that are still awake come to rest)
  let all = await R.rows();
  for (let k = 0; k < 60 && all.some((r) => !(r.flags & ASLEEP)); k++) {
    await R.step(20);
    t += 20;
    all = await R.rows();
  }
  P = await R.pool();
  const rs = all.filter((r) => !(r.flags & DEFORM));
  const mass = rs.reduce((s, r) => s + r.mass, 0);
  // (stone to the ground: a steel voxel is not expected there)
  const crumbs = P[POOL.crumbs] * (B.mass / 64);
  const missing = new Uint32Array(await g.read(R.e.collide.missing, R.e.rooms.rows * 4));
  log(rows.join('\n'), `\nB deformed at tick ${bAt}, C at tick ${cAt}; all at rest at tick ${t}: ${rs.length} rows (${rs.filter((r) => r.flags & HELD).length} held parts), ${P[POOL.expands]} expansions, most deforming at once ${most}, ${P[POOL.crumbs]} voxels to the ground; mass ${mass.toFixed(1)} + ${crumbs.toFixed(1)} of ${mass0.toFixed(1)}; lowest row centre ${Math.min(...rs.map((r) => r.pos[2])).toFixed(2)}; failed expands ${P[POOL.failExpand]}, settles ${P[POOL.failSettle]}, hash guard ${P[POOL.hashOver]}`);
  ok();
  expect(bAt).toBeGreaterThanOrEqual(0);
  expect(cAt).toBeGreaterThan(bAt);
  expect(P[POOL.deforming]).toBe(P[POOL.held]);
  expect(P[POOL.settling]).toBe(0);
  expect(all.every((r) => r.flags & ASLEEP)).toBe(true);
  expect([...missing].some((m) => m !== 0)).toBe(false);
  // (nothing under the ground)
  expect(Math.min(...rs.map((r) => r.pos[2]))).toBeGreaterThan(10);
  // (a voxel to the ground is counted, not weighed: the lightest material's mass each at least, the heaviest's at most)
  const each = [B.mass / 64, C.mass / 20, post.mass / 144];
  expect(mass + P[POOL.crumbs] * Math.min(...each)).toBeLessThan(mass0 + 0.5);
  expect(mass + P[POOL.crumbs] * Math.max(...each)).toBeGreaterThan(mass0 - 0.5);
}, 400_000);
