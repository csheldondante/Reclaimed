// Terrain contacts the cheap way (docs/design/PHYSICS_ENGINE.md "Terrain contacts, the cheap way"; BACKLOG PP4): a row
// above the highest ground under its footprint gets no terrain work (engine_ground.wgsl), and the rows that do are
// still right in a cave, at a cliff and on ground edited the same tick.
// Numbers for the DEVLOG: GROUND_LOG=1 npx vitest run --project gpu engine-ground --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { Engine, type EngineBody, type EngineCell } from '../../src/engine/engine';
import { kickOnEvents } from '../../src/engine/install';
import { OP } from '../../src/sim/edit-ops';
import { EventKind } from '../../src/sim/globals';
import { TUNE } from '../../src/tune/params';
import type { Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { breakRig } from './engine-rig';
import { tinyWorld, type TinyWorld } from './world';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const LOG = !!process.env.GROUND_LOG;
const log = (...a: unknown[]) => LOG && console.log(...a);
const T = TUNE.engine as Record<string, number>;
T.deform = 0;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);

interface Rig {
  w: TinyWorld;
  e: Engine;
  step(n: number): Promise<void>;
  row(b: EngineBody): Promise<{ pos: number[]; v: number[]; flags: number }>;
  /** rows awake, and rows on each substep's terrain list, as the last tick left them */
  lists(): Promise<{ awake: number; terrain: number[] }>;
}

async function rig(col: (x: number, y: number) => Interval[], W = 32, H = 32, tap = true): Promise<Rig> {
  const w = await tinyWorld(g, tinyMap(W, H, 64, col), ['surface']);
  const e = new Engine(g.device, w.core.world, w.core.host.profiler);
  const sys = w.core.sim.systems;
  sys.splice(sys.findIndex((s) => s.name === 'surface') + 1, 0, e);
  if (tap) kickOnEvents(w.core.sim, e);
  const on = (s: { name: string }) => s.name === 'surface' || s.name === 'engine' || s.name === 'edit';
  const R: Rig = {
    w,
    e,
    step: async (n) => {
      for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, on);
      await g.device.queue.onSubmittedWorkDone();
    },
    row: async (b) => {
      const D = e.debugBuffers;
      const p = new Float32Array(await g.read(D.pose, 64, b.row * 64));
      const v = new Float32Array(await g.read(D.vel, 32, b.row * 32));
      return { pos: [...p.slice(8, 11)], v: [...v.slice(0, 3)], flags: new Uint32Array(await g.read(D.info, 64, b.row * 64))[3] };
    },
    lists: async () => {
      const D = e.debugBuffers;
      const L = new Uint32Array(await g.read(D.list, 32));
      const A = new Uint32Array(await g.read(D.targs, 32));
      return { awake: L[3], terrain: [A[0], A[4]] };
    },
  };
  await R.step(1);
  return R;
}

const flat = () => [{ z0: 0, z1: 10, mat: MAT.Stone }];
const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number = MAT.Stone): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};

test('rows in free flight are on no terrain list; they join it as they near the ground, land and rest', async () => {
  const R = await rig(flat, 64, 64);
  const bs: EngineBody[] = [];
  for (let k = 0; k < 49; k++) bs.push(R.e.add({ cells: box(4 + (k % 7) * 8, 4 + Math.floor(k / 7) * 8, 30, 2, 2, 2) })!);
  // (one over the map's edge: over no column at all)
  const off = R.e.add({ cells: box(0, 0, 0, 2, 2, 2), pose: { pos: [-20, 10, 30] } })!;
  await R.step(5);
  const air = await R.lists();
  expect(air.awake).toBe(50);
  expect(air.terrain).toEqual([0, 0]);
  // (they fall as gravity says meanwhile)
  const z = (await R.row(bs[0])).pos[2];
  expect(z).toBeLessThan(31);
  expect(z).toBeGreaterThan(30.8);
  let first = -1;
  for (let t = 5; t < 400 && first < 0; t += 5) {
    await R.step(5);
    if ((await R.lists()).terrain[0] > 0) first = t + 5;
  }
  const at = (await R.row(bs[0])).pos[2];
  log(`free flight: on the terrain list from tick ${first}, the centre then at ${at.toFixed(2)} (ground 10, bound ${(1.9).toFixed(1)})`);
  // (listed before it can touch: its lowest point is still above the ground)
  expect(first).toBeGreaterThan(0);
  expect(at).toBeGreaterThan(11.0);
  await R.step(300);
  for (const b of bs) {
    const r = await R.row(b);
    expect(r.pos[2], `row ${b.row}`).toBeGreaterThan(10.9);
    expect(r.pos[2], `row ${b.row}`).toBeLessThan(11.05);
    expect(r.flags & 2).toBe(2);
  }
  // (the one over nothing is still falling, on no list)
  expect((await R.row(off)).pos[2]).toBeLessThan(0);
  ok();
  R.w.destroy();
});

test('a block rests on a cave floor under a roof, one on the roof, one beside', async () => {
  // (a cave for x in 8..16: floor at 5, a roof from 9 to 12; elsewhere solid to 12)
  const cave = (x: number) => (x >= 8 && x < 16 ? [{ z0: 0, z1: 5, mat: MAT.Stone }, { z0: 9, z1: 12, mat: MAT.Stone }] : [{ z0: 0, z1: 12, mat: MAT.Stone }]);
  const R = await rig(cave);
  const inCave = R.e.add({ cells: box(11, 14, 6, 2, 2, 2) })!;
  const onRoof = R.e.add({ cells: box(11, 20, 16, 2, 2, 2) })!;
  const open = R.e.add({ cells: box(22, 14, 16, 2, 2, 2) })!;
  await R.step(3);
  // (the one in the cave is under its columns' top: listed from the first tick; the two above are not yet)
  expect((await R.lists()).terrain[0]).toBe(1);
  await R.step(300);
  const rows = [await R.row(inCave), await R.row(onRoof), await R.row(open)];
  log(`cave: rest heights ${rows.map((r) => r.pos[2].toFixed(3)).join(' ')}`);
  expect(rows[0].pos[2]).toBeGreaterThan(5.9);
  expect(rows[0].pos[2]).toBeLessThan(6.05);
  for (const r of rows.slice(1)) {
    expect(r.pos[2]).toBeGreaterThan(12.9);
    expect(r.pos[2]).toBeLessThan(13.05);
  }
  ok();
  R.w.destroy();
});

test('a block slides into a cliff face and stops there', async () => {
  const cliff = (x: number) => [{ z0: 0, z1: x >= 20 ? 16 : 10, mat: MAT.Stone }];
  T.friction = 0.1;
  const R = await rig(cliff);
  const b = R.e.add({ cells: box(8, 14, 10, 2, 2, 2), vel: [9, 0, 0] })!;
  let furthest = 0;
  for (let t = 0; t < 240; t += 4) {
    await R.step(4);
    furthest = Math.max(furthest, (await R.row(b)).pos[0]);
  }
  const r = await R.row(b);
  log(`cliff at x 20: the block's centre went as far as ${furthest.toFixed(2)}, rests at ${r.pos[0].toFixed(2)}, z ${r.pos[2].toFixed(2)}`);
  // (it got there, and its centre never came nearer the face than its own half width less the slop)
  expect(furthest).toBeGreaterThan(17.5);
  expect(furthest).toBeLessThan(19.3);
  expect(r.pos[2]).toBeGreaterThan(10.9);
  expect(r.pos[2]).toBeLessThan(11.1);
  ok();
  R.w.destroy();
});

test('ground edited as a block comes down on it: dug under it, it falls on to the new floor; built up under it, it rests on the new top', async () => {
  const R = await rig(flat);
  const push = (x: number, y: number, op: number, cells: number) => {
    for (let k = 0; k < 8; k++) R.w.core.globals.events.push({ kind: EventKind.Edit, x, y, z: op + 512, radius: 3.5, strength: cells });
  };
  // dug: the block is a few ticks from landing when the pit is started under it (a dig takes a cell a tick)
  const a = R.e.add({ cells: box(7, 14, 13, 2, 2, 2) })!;
  // built: stone is rising under the other as it arrives (a cell a tick)
  const b = R.e.add({ cells: box(22, 14, 22, 2, 2, 2) })!;
  let cut = -1;
  let built = -1;
  const heights: string[] = [];
  for (let t = 0; t < 500; t++) {
    await R.step(1);
    if (cut < 0 || built < 0) {
      const ra = await R.row(a);
      const rb = await R.row(b);
      if (cut < 0 && ra.pos[2] < 11.6) {
        push(ra.pos[0], ra.pos[1], OP.DIG * 32, 4);
        cut = t;
      }
      if (built < 0 && rb.pos[2] < 13.2) {
        push(rb.pos[0], rb.pos[1], OP.BUILD * 32 + MAT.Stone, 2);
        built = t;
      }
    }
    if (t % 20 === 19 && t < 200) heights.push(`${(await R.row(a)).pos[2].toFixed(2)}/${(await R.row(b)).pos[2].toFixed(2)}`);
  }
  const ra = await R.row(a);
  const rb = await R.row(b);
  log(`dug at tick ${cut}, built at tick ${built}: heights every 20 ticks ${heights.join(' ')}; over the pit the block rests at z ${ra.pos[2].toFixed(2)} (flags ${ra.flags}); on the built ground at ${rb.pos[2].toFixed(2)} (flags ${rb.flags})`);
  expect(cut).toBeGreaterThan(0);
  expect(built).toBeGreaterThan(cut);
  // (it did not hang where the ground was, and stopped on the pit's floor)
  expect(ra.pos[2]).toBeLessThan(9);
  expect(ra.pos[2]).toBeGreaterThan(2.9);
  // (it did not fall through what was built to the old ground; the stone rose into it and took its cells — the rule
  // "erode, do not push" — so the row may have ended there: flags 0)
  expect(rb.pos[2]).toBeGreaterThan(11.9);
  expect(Math.hypot(...rb.v)).toBeLessThan(0.3);
  ok();
  R.w.destroy();
});

// GROUND_BENCH=1: what a tick costs with `n` rows in free flight, none colliding, the row test on and off (the GPU's
// own timestamps a kernel, the least of five ticks; desktop proxy — the phone decides: enginebench.html).
test.skipIf(!process.env.GROUND_BENCH).each([1000, 10000, 50000])('bench: %i rows in free flight, the terrain test with and without the row test', async (n) => {
  const R = await breakRig(g, flat, 128, 128);
  R.e.hold = true;
  const model = R.e.addModel(box(0, 0, 0, 2, 2, 2));
  for (let k = 0; k < n; k++) R.e.add({ model, pose: { pos: [5 + (k % 24) * 5, 5 + (Math.floor(k / 24) % 24) * 5, 30 + Math.floor(k / 576) * 5] } });
  for (let i = 0; i < 12; i++) {
    await R.step(1);
    await new Promise((r) => setTimeout(r, 2));
  }
  const least = async () => {
    const runs: Map<string, number>[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await R.gpuTick();
      if (m) runs.push(m);
    }
    runs.sort((a, c) => a.get('total')! - c.get('total')!);
    const m = runs[0];
    return m ? `${m.get('total')!.toFixed(2)} ms (${[...m].filter(([k, v]) => v >= 0.06 && k !== 'total' && k !== 'wall').sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})` : 'no timestamps';
  };
  R.e.groundMargin = 1e9;
  await R.step(2);
  const before = await least();
  R.e.groundMargin = 0.5;
  await R.step(2);
  const after = await least();
  const A = new Uint32Array(await g.read(R.e.debugBuffers.targs, 32));
  console.log(`${n} rows in free flight: every row given terrain threads ${before}; with the row test ${after}; rows on the terrain lists ${A[0]}, ${A[4]}`);
  expect([A[0], A[4]]).toEqual([0, 0]);
  ok();
}, 600_000);

// ---- asleep costs nothing (docs/design/PHYSICS_ENGINE.md "Asleep costs nothing"; BACKLOG PP5) -------------------------
/** ticks one at a time with the event loop turned between them, as between frames: the engine's own read lands */
async function frames(R: Rig, n: number, each?: () => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    await R.step(1);
    each?.();
    await new Promise((r) => setTimeout(r, 0));
  }
}
const dig = (R: Rig, x: number, y: number) => {
  for (let k = 0; k < 8; k++) R.w.core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.DIG * 32 + 512, radius: 3.5, strength: 3 });
};

test('everything asleep: a tick encodes nothing and no read is issued; an impulse and an edit each wake the sleeper', async () => {
  const R = await rig(flat);
  const b = R.e.add({ cells: box(14, 14, 10, 2, 2, 2) })!;
  // (five more asleep from the start)
  for (let k = 0; k < 5; k++) R.e.add({ cells: box(4 + k * 5, 24, 10, 2, 2, 2), asleep: true });
  await frames(R, 150);
  const rest = await R.row(b);
  expect(rest.flags & 2).toBe(2);
  expect(R.e.quietTicks).toBeGreaterThan(0);
  R.e.watchEvery = 0;
  const q0 = R.e.quietTicks;
  const reads0 = R.e.reads;
  let made = 0;
  await frames(R, 100, () => {
    const c = R.e.counts;
    made += c.passes + c.direct + c.indirect + c.clears + c.copies + c.uploads;
  });
  expect(made).toBe(0);
  expect(R.e.quietTicks - q0).toBe(100);
  expect(R.e.reads).toBe(reads0);
  // (and the frame's skin pass encodes nothing either: no error, nothing to see here but that it runs)
  const enc = g.device.createCommandEncoder();
  R.e.skin(enc, 1);
  g.device.queue.submit([enc.finish()]);
  // an impulse: the next tick is a whole one again
  R.e.impulse(b, [0, 0, 6]);
  await frames(R, 12);
  expect(R.e.counts.indirect).toBeGreaterThan(0);
  expect((await R.row(b)).pos[2]).toBeGreaterThan(rest.pos[2] + 0.3);
  await frames(R, 220);
  expect((await R.row(b)).flags & 2).toBe(2);
  expect(R.e.counts.direct + R.e.counts.indirect).toBe(0);
  // an edit under it (the host's event reaches the engine: install.ts kickOnEvents)
  dig(R, rest.pos[0], rest.pos[1]);
  await frames(R, 150);
  const after = await R.row(b);
  log(`quiet: ${R.e.quietTicks} quiet ticks of ${150 + 100 + 12 + 220 + 150}, ${R.e.reads} reads; dug out it went from ${rest.pos[2].toFixed(2)} to ${after.pos[2].toFixed(2)}`);
  expect(after.pos[2]).toBeLessThan(rest.pos[2] - 1);
  ok();
  R.w.destroy();
});

test('a sleeper whose ground changes with no host event is found by the watch tick, a direct dispatch now and then', async () => {
  // (no tap: the dig below stands for a simulation changing the ground on the GPU with nothing said to the engine)
  const R = await rig(flat, 32, 32, false);
  R.e.watchEvery = 20;
  const b = R.e.add({ cells: box(14, 14, 10, 2, 2, 2) })!;
  await frames(R, 150);
  const rest = await R.row(b);
  expect(rest.flags & 2).toBe(2);
  const reads0 = R.e.reads;
  let direct = 0;
  let indirect = 0;
  await frames(R, 100, () => {
    direct += R.e.counts.direct;
    indirect += R.e.counts.indirect;
  });
  // (asleep and unchanged: `compact` alone every twentieth tick, and one read after each)
  expect(indirect).toBe(0);
  expect(direct).toBeGreaterThanOrEqual(4);
  expect(direct).toBeLessThanOrEqual(5);
  expect(R.e.reads - reads0).toBe(direct);
  expect([...(await R.row(b)).pos]).toEqual([...rest.pos]);
  dig(R, rest.pos[0], rest.pos[1]);
  let woke = -1;
  await frames(R, 60, () => {
    if (woke < 0 && R.e.counts.indirect > 0) woke = R.e.quietTicks;
  });
  await frames(R, 150);
  const after = await R.row(b);
  log(`watch tick every 20: whole ticks again within 60 of the dig (${woke >= 0}); it went from ${rest.pos[2].toFixed(2)} to ${after.pos[2].toFixed(2)}`);
  expect(woke).toBeGreaterThanOrEqual(0);
  expect(after.pos[2]).toBeLessThan(rest.pos[2] - 1);
  ok();
  R.w.destroy();
});
