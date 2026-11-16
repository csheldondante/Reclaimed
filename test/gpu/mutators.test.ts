// Instant world mutators on a tiny world (src/mutate, docs/design/MUTATORS.md): each land mutator writes its end state
// into the columns in one submit with no sim stepped; nothing outside its radius changes; a place that isn't loaded
// arrives already mutated, column for column the same as one mutated while loaded; fake lots carry their condition; the
// same modifier twice is one entry and writes nothing more.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LOT_CONDITION, type MutatorKind } from '../../src/mutate';
import { MutateEngine, type MutTown } from '../../src/mutate/engine';
import { MutateGpu, type Origin } from '../../src/mutate/gpu';
import type { ListWorld } from '../../src/mutate/list';
import { unpackColumns } from '../../src/world/mapfile';
import { ROW_H } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
const H = 64;
/** a slope down to the east with a hollow in the middle: soil over stone */
const ground = (x: number, y: number) => 14 - x * 0.08 - 5 * Math.exp(-((x - 32) ** 2 + (y - 32) ** 2) / 90);
const AT: [number, number] = [32, 32];
const R = 20;

/** the atlas's ground for the list: the same slope (world z = window z here, the origin's oz 0) */
const listWorld: ListWorld = { ground: (x, y) => ground(x, y / ROW_H), sea: -1e9, place: () => null, places: () => [] };

interface Rig {
  w: TinyWorld;
  gpu: MutateGpu;
  eng: MutateEngine;
  origin: { o: Origin | null };
  town: MutTown & { changes: number };
}

let g: TestGpu;
const rigs: Rig[] = [];

/** four fake lots (api/contracts/citygen.ts records): in the hollow, on the high west side, on the low east side (all
 *  inside the radius), and one far outside it */
const LOTS: { at: [number, number]; h: number }[] = [
  { at: [32, 32], h: 4 },
  { at: [15, 32], h: 4 },
  { at: [44, 32], h: 4 },
  { at: [60, 6], h: 4 },
];

async function rig(): Promise<Rig> {
  const map = tinyMap(W, H, 48, (x, y) => {
    const z = ground(x, y);
    return [{ z0: 0, z1: z - 1, mat: MAT.Stone }, { z0: z - 1, z1: z, mat: MAT.Soil }];
  });
  map.vegetation.fill(2);
  const w = await tinyWorld(g, map, []);
  const gpu = new MutateGpu(g.device, w.core.world, W, H);
  await gpu.ready;
  const dev = g.device;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const room = 8;
  const rec = new ArrayBuffer(room * 24 * 4);
  const f = new Float32Array(rec);
  const u = new Uint32Array(rec);
  LOTS.forEach((l, i) => {
    const o = i * 24;
    const [x, y] = [l.at[0] + 0.5, (l.at[1] + 0.5) * ROW_H];
    const q = [x - 2, y - 2, x + 2, y - 2, x + 2, y + 2, x - 2, y + 2];
    f.set(q, o);
    f.set(q, o + 8);
    u[o + 17] = 1;
    f[o + 20] = l.h;
    f[o + 21] = ground(l.at[0], l.at[1]) - 0.5;
  });
  const mk = (label: string, size: number, usage: number, data?: ArrayBuffer | ArrayBufferView) => {
    const b = dev.createBuffer({ label, size, usage });
    if (data) dev.queue.writeBuffer(b, 0, data as ArrayBuffer);
    return b;
  };
  const lots = {
    records: mk('fake lots', rec.byteLength, S, rec),
    counts: mk('fake counts', 16, S, new Uint32Array([LOTS.length, 0, 24, room])),
    condition: mk('fake condition', room * 4, S),
    place: mk('fake place', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, new Float32Array([0, 0, 0, 0])),
    room,
  };
  const origin = { o: [0, 0, 0] as Origin | null };
  const town: Rig['town'] = { id: 'faketown', at: [32, 32 * ROW_H], radius: 40, lots, changes: 0, changed: () => void town.changes++ };
  const eng = new MutateEngine({ gpu, world: listWorld, origin: () => origin.o, towns: () => (origin.o && origin.o[0] === 0 ? [town] : []), time: true });
  const r = { w, gpu, eng, origin, town };
  rigs.push(r);
  return r;
}

interface Snap {
  layers: Uint32Array;
  water: Float32Array;
  veg: Float32Array;
  lava: Float32Array;
}
async function snap(r: Rig): Promise<Snap> {
  const c = r.w.core;
  const [layers, water, veg, lava] = await Promise.all([c.readBuffer('layers'), c.readBuffer('water'), c.readBuffer('veg'), c.readBuffer('lava')]);
  return { layers: new Uint32Array(layers.buffer.slice(0)), water: water.slice(), veg: veg.slice(), lava: lava.slice() };
}
const cols = (r: Rig, s: Snap) => unpackColumns(r.w.core.packed, s.layers).cols;
const conds = async (r: Rig) => [...new Uint32Array(await g.read(r.town.lots.condition, LOTS.length * 4))].map((c) => c & 0xff);
const dist = (x: number, y: number) => Math.hypot(x + 0.5 + 0.5 * (y & 1) - (AT[0] + 0.5), (y + 0.5 - (AT[1] + 0.5)) * ROW_H);

beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => {
  for (const r of rigs) {
    r.gpu.dispose();
    r.w.destroy();
  }
});

/** what a kind must have done to the columns inside its radius: how many it changed */
function changedCols(r: Rig, a: Snap, b: Snap): { inside: number; outside: number } {
  const ca = cols(r, a);
  const cb = cols(r, b);
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const same = JSON.stringify(ca[i]) === JSON.stringify(cb[i]) && a.water[i] === b.water[i] && a.veg[i] === b.veg[i] && a.lava[i * 4 + 2] === b.lava[i * 4 + 2];
      if (same) continue;
      if (dist(x, y) < R) inside++;
      else outside++;
    }
  return { inside, outside };
}

const KINDS: { kind: MutatorKind; lots: number[] }[] = [
  // (the hollow's lot is under the level; the high one isn't; the far one never)
  { kind: 'flooded', lots: [LOT_CONDITION.drowned, 0, LOT_CONDITION.standing, 0] },
  { kind: 'burned', lots: [LOT_CONDITION.burned, LOT_CONDITION.burned, LOT_CONDITION.burned, 0] },
  // (the vent uphill — west — and the flow east through the hollow: the hollow's lot and the low one go)
  { kind: 'melted', lots: [LOT_CONDITION.destroyed, 0, LOT_CONDITION.destroyed, 0] },
  { kind: 'buried', lots: [LOT_CONDITION.buried, LOT_CONDITION.buried, LOT_CONDITION.buried, 0] },
];

describe.each(KINDS)('$kind', ({ kind, lots }) => {
  let a: Rig;
  let before: Snap;
  let after: Snap;
  test('written at once, with no sim stepped: columns changed inside the radius, none outside', async () => {
    a = await rig();
    before = await snap(a);
    const m = a.eng.apply({ kind, at: AT, radius: R, strength: 1, seed: 5 });
    expect(m.resident).toBe(true);
    expect(m.fresh).toBe(true);
    const ms = await a.eng.lastMs;
    after = await snap(a);
    expect(g.takeErrors()).toEqual([]);
    const ch = changedCols(a, before, after);
    console.log(`[mutators] ${kind}: ${ch.inside} columns changed, GPU ${ms === null ? 'n/a' : ms.toFixed(3)} ms, ${a.gpu.dispatches} dispatches`);
    expect(ch.outside).toBe(0);
    expect(ch.inside).toBeGreaterThan(60);
    // (no sim ran and none was asked to: no tick, no event queued)
    expect(a.w.ticks).toBe(0);
    expect(a.w.core.globals.events.length).toBe(0);
  });

  test('the columns hold what the kind says', () => {
    const c = cols(a, after);
    const i = AT[1] * W + AT[0];
    const top = c[i][c[i].length - 1];
    if (kind === 'flooded') {
      const level = a.eng.record().list[0].params[0];
      expect(after.water[i]).toBeCloseTo(level - top.z1, 3);
      // (high ground inside the radius stays dry)
      expect(after.water[32 * W + 16]).toBe(0);
    } else if (kind === 'burned') {
      expect(top.mat).toBe(MAT.Ash);
      expect(after.veg[i]).toBe(0);
      expect(before.veg[i]).toBe(2);
    } else if (kind === 'melted') {
      expect(top.mat).toBe(MAT.Basalt);
      let hot = 0;
      for (let k = 0; k < W * H; k++) if (after.lava[k * 4 + 2] > 1000) hot++;
      expect(hot).toBeGreaterThan(3);
      // (uphill of the vent, inside the radius: untouched)
      const up = c[32 * W + 14];
      expect(up[up.length - 1].mat).toBe(MAT.Soil);
    } else {
      expect(top.mat).toBe(MAT.Sand);
      expect(top.z1 - top.z0).toBeGreaterThan(1);
    }
  });

  test('the fake lots carry their condition; the far one stands', async () => {
    expect(await conds(a)).toEqual(lots);
    expect(a.town.changes).toBe(1);
  });

  test('the same modifier again is the same entry: nothing recorded, nothing written', async () => {
    const n = a.gpu.dispatches;
    const m = a.eng.apply({ kind, at: AT, radius: R, strength: 1, seed: 5 });
    expect(m.fresh).toBe(false);
    expect(a.eng.record().list.length).toBe(1);
    expect(a.gpu.dispatches).toBe(n);
    // (and the op itself is idempotent: written again from the list, the land is the same)
    a.eng.rewrite();
    const again = await snap(a);
    expect(changedCols(a, after, again)).toEqual({ inside: 0, outside: 0 });
    expect(await conds(a)).toEqual(lots);
  });

  test('applied to a place that is not loaded, then loaded a region at a time: identical columns', async () => {
    const b = await rig();
    // (the window is somewhere else: nothing of the area is resident)
    b.origin.o = [4096, 4096, 0];
    const m = b.eng.apply({ kind, at: AT, radius: R, strength: 1, seed: 5 });
    expect(m.resident).toBe(false);
    expect(b.gpu.dispatches).toBe(0);
    // (the list is what a save keeps: through JSON and back)
    const saved = JSON.parse(JSON.stringify(b.eng.record()));
    b.eng.restore(saved);
    expect(b.gpu.dispatches).toBe(0);
    // (the player travels there: the window's regions arrive in some order, one of them twice; then the town is made)
    b.origin.o = [0, 0, 0];
    let wrote = 0;
    for (const [lx, ly] of [[32, 32], [0, 0], [32, 0], [0, 32], [32, 32]]) wrote += b.eng.landWritten(lx, ly, 32, 32);
    expect(wrote).toBe(5);
    b.eng.townMade(b.town);
    const arrived = await snap(b);
    expect(g.takeErrors()).toEqual([]);
    expect(changedCols(b, after, arrived)).toEqual({ inside: 0, outside: 0 });
    expect(await conds(b)).toEqual(lots);
  });
});

test('world state: a place destroyed, abandoned, captured — its lots all carry it, and places() says who holds it', async () => {
  const r = await rig();
  const world: ListWorld = { ...listWorld, place: (id) => (id === 'faketown' ? { id, name: 'Fake Town', at: [32, 32 * ROW_H], radius: 40, size: 'town', faction: 'locals' } : null), places: () => [world.place('faketown')!] };
  const eng = new MutateEngine({ gpu: r.gpu, world, origin: () => r.origin.o, towns: () => [r.town] });
  eng.apply({ kind: 'captured', place: 'faketown', by: 'Iron League' });
  expect(await conds(r)).toEqual([LOT_CONDITION.occupied, LOT_CONDITION.occupied, LOT_CONDITION.occupied, LOT_CONDITION.occupied]);
  expect(eng.place('faketown')).toMatchObject({ owner: 'Iron League', status: 'occupied', restless: true });
  eng.apply({ kind: 'vassal', place: 'faketown', by: 'player', tribute: 3 });
  expect(eng.place('faketown')).toMatchObject({ owner: 'player', status: 'vassal', tribute: 3, restless: true });
  eng.apply({ kind: 'destroyed', place: 'faketown' });
  expect(await conds(r)).toEqual([LOT_CONDITION.burned, LOT_CONDITION.burned, LOT_CONDITION.burned, LOT_CONDITION.burned]);
  expect(eng.place('faketown')).toMatchObject({ status: 'destroyed', population: 0, tribute: 0, restless: false });
  expect(eng.places().map((p) => p.id)).toEqual(['faketown']);
  expect(g.takeErrors()).toEqual([]);
});
