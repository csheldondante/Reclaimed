// The physics engine's rigid rows on terrain (DESIGN §10; docs/design/PHYSICS_ENGINE.md, build step 1; BACKLOG PE1):
// the real kernels on Dawn over a tiny world's columns. A test a contact rule, the awake list's indirect dispatch,
// sleep decided on the GPU, and the terrain test's heightfield fast path against the interval walk.
// Numbers for the DEVLOG: ENGINE_LOG=1 npx vitest run --project gpu engine --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { Engine, EVENT_ROOM, type EngineBody, type EngineCell } from '../../src/engine/engine';
import { kickOnEvents } from '../../src/engine/install';
import { OP } from '../../src/sim/edit-ops';
import { EventKind } from '../../src/sim/globals';
import { TUNE } from '../../src/tune/params';
import type { Interval } from '../../src/world/layout';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const LOG = !!process.env.ENGINE_LOG;
const T = TUNE.engine as Record<string, number>;
// (build step 1's rules, each alone: a hard landing stays rigid here — test/gpu/engine-break.test.ts has the round trip)
T.deform = 0;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));

interface Rig {
  w: TinyWorld;
  e: Engine;
  step(n: number): Promise<void>;
  row(b: EngineBody): Promise<{ pos: number[]; q: number[]; v: number[]; spin: number[]; still: number; flags: number; mass: number; bytes: Uint8Array }>;
  awake(): Promise<{ groups: number; rows: number }>;
  events(): Promise<{ kind: number; row: number; col: number; mat: number; p: number[]; val: number }[]>;
}

async function rig(col: (x: number, y: number) => Interval[], W = 32, H = 32, more: string[] = []): Promise<Rig> {
  const w = await tinyWorld(g, tinyMap(W, H, 64, col), ['surface']);
  const e = new Engine(g.device, w.core.world, w.core.host.profiler);
  const sys = w.core.sim.systems;
  sys.splice(sys.findIndex((s) => s.name === 'surface') + 1, 0, e);
  kickOnEvents(w.core.sim, e);
  const on = (s: { name: string }) => s.name === 'surface' || s.name === 'engine' || more.includes(s.name);
  const R: Rig = {
    w,
    e,
    step: async (n) => {
      for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, on);
      await g.device.queue.onSubmittedWorkDone();
    },
    row: async (b) => {
      const D = e.debugBuffers;
      const P = await g.read(D.pose, 64, b.row * 64);
      const V = await g.read(D.vel, 32, b.row * 32);
      const I = await g.read(D.info, 64, b.row * 64);
      const p = new Float32Array(P);
      const v = new Float32Array(V);
      const bytes = new Uint8Array(64 + 32 + 64);
      bytes.set(new Uint8Array(P), 0);
      bytes.set(new Uint8Array(V), 64);
      bytes.set(new Uint8Array(I), 96);
      return { pos: [...p.slice(8, 11)], q: [...p.slice(12, 16)], v: [...v.slice(0, 3)], spin: [...v.slice(4, 7)], still: v[3], flags: new Uint32Array(I)[3], mass: new Float32Array(I)[7], bytes };
    },
    awake: async () => {
      const L = new Uint32Array(await g.read(e.debugBuffers.list, 32));
      return { groups: L[0], rows: L[3] };
    },
    events: async () => {
      const B = await g.read(e.debugBuffers.events, (4 + EVENT_ROOM * 8) * 4);
      const u = new Uint32Array(B);
      const f = new Float32Array(B);
      const out = [];
      for (let k = 0; k < Math.min(u[3], EVENT_ROOM); k++) {
        const o = 4 + k * 8;
        out.push({ kind: u[o], row: u[o + 1], col: u[o + 2], mat: u[o + 3], p: [f[o + 4], f[o + 5], f[o + 6]], val: f[o + 7] });
      }
      return out;
    },
  };
  // (the surface pass has run once before a body is tested against it)
  await R.step(1);
  return R;
}

const flat = () => [{ z0: 0, z1: 10, mat: MAT.Stone }];
const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number = MAT.Stone): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};
const ok = () => expect(g.takeErrors()).toEqual([]);

test('a row in free fall follows gravity', async () => {
  T.airDrag = 0;
  const R = await rig(flat);
  const b = R.e.add({ cells: box(14, 14, 50, 2, 2, 2) })!;
  const z0 = b.restCom[2];
  const n = 60;
  await R.step(n);
  const r = await R.row(b);
  const t = n / 60;
  // (semi-implicit Euler at 120 Hz: ½ g t² within a substep's worth)
  expect(z0 - r.pos[2]).toBeGreaterThan(0.5 * 9.8 * t * t * 0.98);
  expect(z0 - r.pos[2]).toBeLessThan(0.5 * 9.8 * t * t * 1.03);
  expect(r.v[2]).toBeCloseTo(-9.8 * t, 1);
  ok();
  R.w.destroy();
});

test('a dropped block comes to rest on the column tops and sleeps; rows asleep are not dispatched', async () => {
  const R = await rig(flat);
  const b = R.e.add({ cells: box(14, 14, 12, 2, 2, 2) })!;
  await R.step(8);
  expect((await R.awake()).rows).toBe(1);
  await R.step(240);
  const r = await R.row(b);
  // (its lowest cells' undersides at the ground, within the slop its mass allows)
  expect(r.pos[2] - 1).toBeGreaterThan(10 - 0.25);
  expect(r.pos[2] - 1).toBeLessThan(10 + 0.02);
  expect(r.flags & 2).toBe(2);
  expect(r.v).toEqual([0, 0, 0]);
  const a = await R.awake();
  expect(a).toEqual({ groups: 0, rows: 0 });
  ok();
  R.w.destroy();
});

test('rule: separation adds no speed (an overlap past the slop is moved out without velocity)', async () => {
  const R = await rig(flat);
  // (2 x 2 x 2 at rest 0.3 into the ground: past its slop of about 0.16, short of the erode depth)
  const cells = box(14, 14, 10, 2, 2, 2);
  const [cx, cy] = [(cellPos(14, 14)[0] + cellPos(15, 14)[0] + cellPos(14, 15)[0] + cellPos(15, 15)[0]) / 4, (cellPos(14, 14)[1] + cellPos(14, 15)[1]) / 2];
  const body = R.e.add({ cells, pose: { pos: [cx, cy, 11 - 0.3] } })!;
  let up = 0;
  let z = 0;
  for (let i = 0; i < 90; i++) {
    await R.step(1);
    const r = await R.row(body);
    up = Math.max(up, r.v[2]);
    z = r.pos[2];
  }
  // (it rose out to its slop, and never had upward speed: nothing to carry it on)
  expect(z).toBeGreaterThan(11 - 0.3 + 0.08);
  expect(z).toBeLessThan(11);
  // (the push-out runs at 0.6 cells/s; what the velocity shows is the solve's residue, a hundredth of that at most)
  expect(up).toBeLessThan(0.006);
  ok();
  R.w.destroy();
});

test('rule: an overlap within the mass-scaled slop is never corrected', async () => {
  const R = await rig(flat);
  const cells = box(14, 14, 10, 2, 2, 2);
  const cx = (cellPos(14, 14)[0] + cellPos(15, 14)[0] + cellPos(14, 15)[0] + cellPos(15, 15)[0]) / 4;
  const cy = (cellPos(14, 14)[1] + cellPos(14, 15)[1]) / 2;
  const z0 = 11 - 0.1;
  const body = R.e.add({ cells, pose: { pos: [cx, cy, z0] } })!;
  await R.step(60);
  const r = await R.row(body);
  expect(Math.abs(r.pos[2] - z0)).toBeLessThan(2e-3);
  ok();
  R.w.destroy();
});

test('rule: erode, do not push — a cell deep in solid ground is lost, and its volume lands on the column', async () => {
  const R = await rig(flat);
  // (2 x 2 x 3 with its lowest layer a whole cell into the stone)
  const body = R.e.add({ cells: box(14, 14, 9, 2, 2, 3) })!;
  const m0 = body.mass;
  await R.step(2);
  const ev = (await R.events()).filter((e) => e.kind === 2);
  await R.step(30);
  const r = await R.row(body);
  const dep = new Float32Array(await g.read(R.w.core.world.deposit, 32 * 32 * 16));
  let landed = 0;
  for (let i = 0; i < 32 * 32; i++) landed += dep[i * 4 + 1];
  const cellMass = m0 / 12;
  const lostCells = (m0 - r.mass) / cellMass;
  if (LOG) console.log(`erode: ${ev.length} events the first two ticks, cells lost ${lostCells.toFixed(3)}, volume landed ${landed.toFixed(3)}`);
  expect(lostCells).toBeCloseTo(4, 3);
  expect(landed).toBeCloseTo(lostCells, 3);
  // (and it wasn't thrown out: no upward speed)
  expect(r.v[2]).toBeLessThan(1e-3);
  ok();
  R.w.destroy();
});

test('rule: sleepers stay — a row asleep keeps every byte while another moves; an impulse wakes it', async () => {
  const R = await rig(flat);
  const a = R.e.add({ cells: box(6, 6, 10, 2, 2, 2) })!;
  await R.step(120);
  const before = await R.row(a);
  expect(before.flags & 2).toBe(2);
  const b = R.e.add({ cells: box(20, 20, 16, 2, 2, 2) })!;
  await R.step(90);
  const after = await R.row(a);
  expect([...after.bytes]).toEqual([...before.bytes]);
  expect((await R.row(b)).pos[2]).toBeLessThan(13);
  R.e.impulse(a, [0, 0, 6]);
  await R.step(4);
  const woke = await R.row(a);
  expect(woke.flags & 2).toBe(0);
  expect(woke.pos[2]).toBeGreaterThan(before.pos[2] + 0.1);
  ok();
  R.w.destroy();
});

test('rule: sleepers stay unless their support goes — the ground dug from under a sleeper wakes it, and it falls', async () => {
  const R = await rig(flat, 32, 32, ['edit']);
  const b = R.e.add({ cells: box(14, 14, 10, 2, 2, 2) })!;
  await R.step(120);
  const before = await R.row(b);
  expect(before.flags & 2).toBe(2);
  // (nothing changed under it: still asleep, the same bytes)
  await R.step(30);
  expect([...(await R.row(b)).bytes]).toEqual([...before.bytes]);
  // (a pit dug under it, four cells deep)
  for (let k = 0; k < 8; k++) R.w.core.globals.events.push({ kind: EventKind.Edit, x: before.pos[0], y: before.pos[1], z: OP.DIG * 32 + 512, radius: 3.5, strength: 1 });
  await R.step(8);
  await R.step(150);
  const after = await R.row(b);
  if (LOG) console.log(`dug out: it went from ${before.pos[2].toFixed(2)} to ${after.pos[2].toFixed(2)}, flags ${after.flags}`);
  expect(after.pos[2]).toBeLessThan(before.pos[2] - 0.4);
  ok();
  R.w.destroy();
});

test('a row eroded to nothing is freed: not alive, never dispatched again, its inverse mass marks its mesh', async () => {
  const R = await rig(flat);
  // (a single layer wholly inside the stone)
  const b = R.e.add({ cells: box(14, 14, 8, 2, 2, 1) })!;
  await R.step(6);
  const r = await R.row(b);
  expect(r.flags).toBe(0);
  expect(r.mass).toBe(0);
  expect(new Float32Array(r.bytes.buffer, 0, 16)[11]).toBeLessThan(0);
  // (it stays where it was: not parked anywhere)
  expect(r.pos[2]).toBeGreaterThan(8);
  expect(await R.awake()).toEqual({ groups: 0, rows: 0 });
  ok();
  R.w.destroy();
});

test('rule: deflect and topple, do not bounce — the speed out of a hit is at most the bounce share of the speed in', async () => {
  const R = await rig(flat);
  const b = R.e.add({ cells: box(14, 14, 14, 2, 2, 2), vel: [0, 0, -12] })!;
  let vin = 0;
  let out = 0;
  let hit = false;
  const impacts: number[] = [];
  for (let i = 0; i < 60; i++) {
    await R.step(1);
    const r = await R.row(b);
    if (!hit && r.v[2] > -1) hit = true;
    if (!hit) vin = Math.max(vin, -r.v[2]);
    else out = Math.max(out, r.v[2]);
    for (const e of await R.events()) if (e.kind === 1) impacts.push(e.val);
  }
  if (LOG) console.log(`impact: in at ${vin.toFixed(2)} cells/s, most upward speed after ${out.toFixed(3)}, events ${impacts.map((x) => x.toFixed(0)).join(', ')}`);
  expect(vin).toBeGreaterThan(12);
  expect(out).toBeLessThanOrEqual(T.restitution * vin + 0.05);
  // (the impact is an event, with the energy the stop took: about ½ m v²)
  expect(impacts.length).toBeGreaterThan(0);
  expect(Math.max(...impacts)).toBeGreaterThan(0.25 * b.mass * vin * vin * 0.5);
  ok();
  R.w.destroy();
});

test('a block hung over an edge topples off it and comes to rest below', async () => {
  // (a shelf at 16 for columns under 16, the ground at 8 beyond)
  const R = await rig((x) => [{ z0: 0, z1: x < 16 ? 16 : 8, mat: MAT.Stone }]);
  // (6 long, two columns on the shelf and four past its edge)
  const b = R.e.add({ cells: box(14, 14, 16, 6, 2, 2) })!;
  for (let k = 0; k < 6; k++) {
    await R.step(60);
    const d = await R.row(b);
    if (LOG) console.log(`topple ${k + 1} s: pos ${d.pos.map((x) => x.toFixed(2)).join(', ')} v ${d.v.map((x) => x.toFixed(3)).join(', ')} spin ${d.spin.map((x) => x.toFixed(3)).join(', ')} still ${d.still.toFixed(2)}`);
  }
  const r = await R.row(b);
  if (LOG) console.log(`topple: rests at ${r.pos.map((x) => x.toFixed(2)).join(', ')}, q ${r.q.map((x) => x.toFixed(2)).join(', ')}, flags ${r.flags}`);
  expect(r.pos[2]).toBeLessThan(13);
  expect(r.pos[0]).toBeGreaterThan(16);
  expect(r.flags & 2).toBe(2);
  ok();
  R.w.destroy();
});

test('a block on stepped ground: down a steep stair it tumbles, on a shallow one it stays', async () => {
  // (a stair a cell a column for x in 8..20, flat above and below)
  const stair = (rise: number) => (x: number) => [{ z0: 0, z1: 24 - rise * Math.min(12, Math.max(0, x - 8)), mat: MAT.Stone }];
  const steep = await rig(stair(1));
  const a = steep.e.add({ cells: box(8, 14, 26, 2, 2, 2), vel: [2, 0, 0] })!;
  for (let k = 0; k < 8; k++) {
    await steep.step(60);
    const d = await steep.row(a);
    if (LOG) console.log(`steep ${k + 1} s: x ${d.pos[0].toFixed(2)} z ${d.pos[2].toFixed(2)} speed ${Math.hypot(...d.v).toFixed(2)} spin ${Math.hypot(...d.spin).toFixed(2)}`);
  }
  const ra = await steep.row(a);
  if (LOG) console.log(`steep stair: ends at x ${ra.pos[0].toFixed(2)} z ${ra.pos[2].toFixed(2)} flags ${ra.flags}`);
  // (off the stair's foot, at x 20, within 8 s)
  expect(ra.pos[0]).toBeGreaterThan(20);
  expect(ra.pos[2]).toBeLessThan(13.3);
  steep.w.destroy();
  const shallow = await rig(stair(0.1));
  const b = shallow.e.add({ cells: box(12, 14, 25, 2, 2, 2) })!;
  await shallow.step(360);
  const rb = await shallow.row(b);
  if (LOG) console.log(`shallow stair: ends at x ${rb.pos[0].toFixed(2)} z ${rb.pos[2].toFixed(2)} flags ${rb.flags}`);
  expect(Math.abs(rb.pos[0] - b.restCom[0])).toBeLessThan(1);
  expect(rb.flags & 2).toBe(2);
  ok();
  shallow.w.destroy();
});

test('the heightfield fast path agrees with the interval walk, under an overhang too', async () => {
  // (a cave for x in 8..16: floor at 5, a roof from 9 to 12; elsewhere solid to 12)
  const cave = (x: number) => (x >= 8 && x < 16 ? [{ z0: 0, z1: 5, mat: MAT.Stone }, { z0: 9, z1: 12, mat: MAT.Stone }] : [{ z0: 0, z1: 12, mat: MAT.Stone }]);
  const ends: number[][] = [];
  for (const fast of [true, false]) {
    const R = await rig(cave);
    R.e.fastPath = fast;
    const inCave = R.e.add({ cells: box(11, 14, 6, 2, 2, 2) })!;
    const onRoof = R.e.add({ cells: box(11, 20, 14, 2, 2, 2) })!;
    const open = R.e.add({ cells: box(22, 14, 14, 2, 2, 2) })!;
    await R.step(240);
    const rows = [await R.row(inCave), await R.row(onRoof), await R.row(open)];
    ends.push(rows.map((r) => r.pos[2]));
    expect(rows[0].pos[2]).toBeGreaterThan(5.7);
    expect(rows[0].pos[2]).toBeLessThan(6.05);
    expect(rows[1].pos[2]).toBeGreaterThan(12.7);
    expect(rows[1].pos[2]).toBeLessThan(13.05);
    expect(rows[2].pos[2]).toBeGreaterThan(12.7);
    ok();
    R.w.destroy();
  }
  if (LOG) console.log(`fast path / walk rest heights: ${ends.map((e) => e.map((x) => x.toFixed(4)).join(' ')).join(' | ')}`);
  for (let i = 0; i < 3; i++) expect(Math.abs(ends[0][i] - ends[1][i])).toBeLessThan(0.02);
});

test('cost: many rows awake, the fast path on and off (desktop proxy)', async () => {
  // (rows kept awake by never letting them rest: the cost of the terrain test and the solve, not of sleep)
  T.restT = 3;
  const out: string[] = [];
  for (const n of [256, 1024, 4096]) {
    for (const fast of [true, false]) {
      const W = 64;
      // (three intervals a column, as land with soil on stone has)
      const R = await rig(() => [{ z0: 0, z1: 6, mat: MAT.Stone }, { z0: 6, z1: 9, mat: MAT.Stone }, { z0: 9, z1: 10, mat: MAT.Stone }], W, W);
      R.e.fastPath = fast;
      const side = Math.ceil(Math.sqrt(n));
      // (2 x 2 x 2 blocks, 8 samples each, spread over the map and falling from different heights)
      for (let i = 0; i < n; i++) R.e.add({ cells: box(2 + Math.floor(((i % side) * 58) / side), 2 + Math.floor((Math.floor(i / side) * 58) / side), 10 + (i % 5), 2, 2, 2) });
      await R.step(4);
      const t0 = performance.now();
      const ticks = 120;
      await R.step(ticks);
      const ms = (performance.now() - t0) / ticks;
      const a = await R.awake();
      out.push(`${n} rows (${a.rows} awake at the end) ${fast ? 'heightfield first' : 'interval walk'}: ${ms.toFixed(3)} ms a tick (surface pass included)`);
      ok();
      R.w.destroy();
    }
  }
  if (LOG) console.log(out.join('\n'));
  expect(out.length).toBe(6);
}, 240000);
