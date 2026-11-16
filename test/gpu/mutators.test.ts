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
import { mutWorld } from '../support/mutworld';
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
  // (a river down the middle row band: water with a source)
  for (let y = 44; y < 48; y++)
    for (let x = 0; x < W; x++) {
      map.water[y * W + x] = y === 45 || y === 46 ? 5 : 1.5;
      map.waterSource[y * W + x] = 0.2;
    }
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
  const town: Rig['town'] = { id: 'faketown', centre: () => [32, 32 * ROW_H], radius: 40, lots, changes: 0, changed: () => void town.changes++ };
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
  wilt: Float32Array;
  src: Float32Array;
}
async function snap(r: Rig): Promise<Snap> {
  const c = r.w.core;
  const [layers, water, veg, lava, wilt, src] = await Promise.all([c.readBuffer('layers'), c.readBuffer('water'), c.readBuffer('veg'), c.readBuffer('lava'), c.readBuffer('wilt'), c.readBuffer('waterSource')]);
  return { layers: new Uint32Array(layers.buffer.slice(0)), water: water.slice(), veg: veg.slice(), lava: lava.slice(), wilt: wilt.slice(), src: src.slice() };
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
      const same = JSON.stringify(ca[i]) === JSON.stringify(cb[i]) && a.water[i] === b.water[i] && a.veg[i] === b.veg[i] && a.lava[i * 4 + 2] === b.lava[i * 4 + 2] && a.wilt[i * 4] === b.wilt[i * 4] && a.wilt[i * 4 + 1] === b.wilt[i * 4 + 1] && a.src[i] === b.src[i];
      if (same) continue;
      if (dist(x, y) < R) inside++;
      else outside++;
    }
  return { inside, outside };
}

const KINDS: { kind: MutatorKind; lots: number[] }[] = [
  // (the level is taken from the place's own ground: the hollow's lot and the low one stand in water, the high one
  // is over it, the far one never)
  { kind: 'flooded', lots: [LOT_CONDITION.drowned, 0, LOT_CONDITION.drowned, 0] },
  { kind: 'burned', lots: [LOT_CONDITION.burned, LOT_CONDITION.burned, LOT_CONDITION.burned, 0] },
  // (the vent uphill — west — and the flow east through the hollow: the hollow's lot and the low one go)
  { kind: 'melted', lots: [LOT_CONDITION.destroyed, 0, LOT_CONDITION.destroyed, 0] },
  { kind: 'buried', lots: [LOT_CONDITION.buried, LOT_CONDITION.buried, LOT_CONDITION.buried, 0] },
  // (these change no lot)
  { kind: 'dried', lots: [0, 0, 0, 0] },
  { kind: 'withered', lots: [0, 0, 0, 0] },
  { kind: 'greened', lots: [0, 0, 0, 0] },
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
    await a.eng.levels;
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
      // (the level was chosen on the GPU from the ground in the disc and kept on the entry: the atlas's guess replaced)
      const [level, fixed] = a.eng.record().list[0].params;
      expect(fixed).toBe(1);
      expect(after.water[i]).toBeCloseTo(level - top.z1, 3);
      // (a basin fill of the real ground: at strength 1 most of the disc's ground is under water; the hill stays dry, below)
      let under = 0;
      let all = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (dist(x, y) < R * 0.6) {
            all++;
            if (after.water[y * W + x] > 0.05) under++;
          }
      expect(under / all).toBeGreaterThan(0.5);
      // (one level: no water stands over it, ground at or over it is dry, and inside the rim the water's top is it)
      let high = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const k = y * W + x;
          const t = c[k][c[k].length - 1].z1;
          if (before.water[k] > 0) continue;
          expect(t + after.water[k]).toBeLessThanOrEqual(Math.max(t, level) + 1e-3);
          if (t >= level) high++;
          if (dist(x, y) < R * 0.6 && t < level - 0.06) expect(t + after.water[k]).toBeCloseTo(level, 2);
        }
      console.log(`[mutators] flood level ${level.toFixed(2)}: ${under} of ${all} columns inside the rim under water, ${high} columns of the map at or over the level`);

    } else if (kind === 'burned') {
      expect(top.mat).toBe(MAT.Ash);
      expect(after.veg[i]).toBe(0);
      expect(before.veg[i]).toBe(2);
    } else if (kind === 'melted') {
      expect([MAT.Basalt, MAT.Obsidian]).toContain(top.mat);
      let hot = 0;
      for (let k = 0; k < W * H; k++) if (after.lava[k * 4 + 2] > 1000) hot++;
      expect(hot).toBeGreaterThan(3);
      // (uphill of the vent, inside the radius: untouched)
      const up = c[32 * W + 14];
      expect(up[up.length - 1].mat).toBe(MAT.Soil);
    } else if (kind === 'buried') {
      expect(top.mat).toBe(MAT.Sand);
      expect(top.z1 - top.z0).toBeGreaterThan(1);
    } else if (kind === 'dried') {
      // (the shallows dry, a pool left in the deep middle; the source shut)
      expect(after.water[44 * W + 32]).toBe(0);
      expect(after.water[45 * W + 32]).toBeCloseTo(1, 3);
      expect(after.src[45 * W + 32]).toBeLessThanOrEqual(0);
      expect(after.src[45 * W + 32]).toBeGreaterThan(-1e-20);
      expect(after.src[45 * W + 2]).toBeCloseTo(0.2, 5);
    } else if (kind === 'withered') {
      // (dying: yellowed to brown by its noise — past where the trees go bare (0.35..0.6, vegprep.wgsl) — and the
      // ground hostile, so woken plants stay dead)
      const y = after.wilt[(20 * W + 32) * 4 + 1];
      expect(y).toBeGreaterThanOrEqual(0.52 - 1e-6);
      expect(y).toBeLessThanOrEqual(0.92 + 1e-6);
      // (blighted: common.wgsl WILT_BLIGHT 4 + hostility 1)
      expect(after.wilt[(20 * W + 32) * 4]).toBe(5);
      expect(after.veg[20 * W + 32]).toBe(2);
    } else {
      expect(after.veg[20 * W + 32]).toBeGreaterThan(2.1);
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
    for (const [lx, ly] of [[32, 32], [0, 0], [32, 0], [0, 32], [32, 32]]) wrote += b.eng.landWritten(lx, ly, 32, 32) ? 1 : 0;
    // (a flood is written whole, once, when its whole area is in the window: its level is taken there)
    expect(wrote).toBe(kind === 'flooded' ? 1 : 5);
    b.eng.townMade(b.town);
    await b.eng.levels;
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
  // (no fact world: there is nowhere for a place's state to live, so a state kind is refused)
  expect(() => eng.apply({ kind: 'captured', place: 'faketown', by: 'iron-league' })).toThrow(/no fact world/);
  const fw = mutWorld([world.place('faketown')!]);
  eng.useWorld(fw);
  const cap = eng.apply({ kind: 'captured', place: 'faketown', by: 'iron-league' });
  expect(await conds(r)).toEqual([LOT_CONDITION.occupied, LOT_CONDITION.occupied, LOT_CONDITION.occupied, LOT_CONDITION.occupied]);
  // (the state is the fact world's: the settlement's record, the relation, the event the entry names)
  expect(fw.settlement('faketown')!.faction).toBe('iron-league');
  expect(fw.facts.events({ kind: 'captured' }).map((e) => e.id)).toEqual([cap.fact]);
  expect(eng.place('faketown')).toMatchObject({ owner: 'iron-league', status: 'occupied', restless: true });
  eng.apply({ kind: 'destroyed', place: 'faketown' });
  expect(await conds(r)).toEqual([LOT_CONDITION.burned, LOT_CONDITION.burned, LOT_CONDITION.burned, LOT_CONDITION.burned]);
  expect(fw.settlement('faketown')!.condition).toBe('ruined');
  expect(eng.place('faketown')).toMatchObject({ status: 'destroyed', population: 0, tribute: 0, restless: false });
  expect(eng.places().map((p) => p.id)).toEqual(['faketown']);
  expect(g.takeErrors()).toEqual([]);
});

// The user (2026-11-15): "the local simulation and playable battle make the instant mutations read as fully simulated".
// An instant end state must be one the live sims would leave: woken on it, they barely move it.
describe('woken sims leave an instant result nearly as it is', () => {
  const hollow = (x: number, y: number) => 12 - 6 * Math.exp(-((x - 32) ** 2 + (y - 32) ** 2) / 160);
  async function bowlRig(systems: string[] | 'all', closedBowl: (x: number, y: number) => number = hollow) {
    const map = tinyMap(W, H, 48, (x, y) => {
      const z = closedBowl(x, y);
      return [{ z0: 0, z1: z - 1, mat: MAT.Stone }, { z0: z - 1, z1: z, mat: MAT.Soil }];
    });
    const w = await tinyWorld(g, map, systems);
    const gpu = new MutateGpu(g.device, w.core.world, W, H);
    await gpu.ready;
    const world: ListWorld = { ground: (x, y) => closedBowl(x, y / ROW_H), sea: -1e9, place: () => null, places: () => [] };
    const eng = new MutateEngine({ gpu, world, origin: () => [0, 0, 0], towns: () => [] });
    return { w, gpu, eng };
  }

  // (round 3, BACKLOG MU-28) On open ground the flow model drained a flood in seconds: at Muru 1 900 flooded columns
  // fell to 400 in 12 s. The flood's level is now a stage the liquid holds (liquid.wgsl publishWater, the source word).
  test('flooded on an open slope, then the liquid woken for 5 s: the stage holds the water at its level', async () => {
    const slope = (x: number, _y: number) => 14 - 0.12 * x;
    const r = await bowlRig(['surface', 'liquid-water'], slope);
    r.eng.apply({ kind: 'flooded', at: AT, radius: R, strength: 1, seed: 1 });
    await r.eng.levels;
    const level = r.eng.record().list[0].params[0];
    const a = (await r.w.read('water')).slice();
    await r.w.step(300);
    const b = await r.w.read('water');
    let n = 0;
    let low = 0;
    let worst = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (dist(x, y) > R * 0.5 || a[i] < 0.3) continue;
        n++;
        // (silt lies under the water: the surface is the level whatever the bed)
        worst = Math.max(worst, a[i] - b[i]);
        if (b[i] < a[i] - 0.25) low++;
      }
    // (round 4, BACKLOG MU-36) The rim: the flood's surface comes down to the ground round it with no step, and what
    // the held core sheds is taken up in the rim — nothing pours out over the land below.
    const sf = await r.w.read('surface');
    const top = Float32Array.from(new Uint32Array(sf.buffer, sf.byteOffset, W * H), (v) => (v & 0x1ffff) / 256);
    let step = 0;
    let outside = 0;
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (dist(x, y) > R) outside += b[i];
        if (dist(x, y) < R * 0.6 || dist(x, y) > R + 2) continue;
        for (const k of [i + 1, i + W]) if (a[i] > 0.05 || a[k] > 0.05) step = Math.max(step, Math.abs(top[i] + a[i] - top[k] - a[k]));
      }
    console.log(`[mutators] flood on a slope woken 5 s: level ${level.toFixed(2)}, ${n} flooded columns in the core, ${low} fell by a quarter cell or more, the most ${worst.toFixed(3)}; the rim's tallest step between neighbours ${step.toFixed(3)}, water beyond the radius after 5 s ${outside.toFixed(2)}`);
    expect(g.takeErrors()).toEqual([]);
    expect(n).toBeGreaterThan(100);
    expect(low).toBe(0);
    expect(step).toBeLessThan(0.75);
    expect(outside).toBeLessThan(3);
    r.gpu.dispose();
    r.w.destroy();
  });

  test('flooded in a closed hollow, then the liquid woken for 5 s: the water keeps its volume and its level', async () => {
    const r = await bowlRig(['surface', 'liquid-water']);
    r.eng.apply({ kind: 'flooded', at: AT, radius: R, strength: 0.6, seed: 1 });
    const a = (await r.w.read('water')).slice();
    await r.w.step(300);
    const b = await r.w.read('water');
    let va = 0;
    let vb = 0;
    let moved = 0;
    for (let i = 0; i < W * H; i++) {
      va += a[i];
      vb += b[i];
      moved = Math.max(moved, Math.abs(a[i] - b[i]));
    }
    console.log(`[mutators] flood woken 5 s: volume ${va.toFixed(1)} -> ${vb.toFixed(1)}, the most a column's depth moved ${moved.toFixed(3)}`);
    expect(g.takeErrors()).toEqual([]);
    expect(va).toBeGreaterThan(50);
    expect(Math.abs(vb - va)).toBeLessThan(0.02 * va);
    expect(moved).toBeLessThan(0.25);
    r.gpu.dispose();
    r.w.destroy();
  });

  test('buried, then every system woken for 5 s: the sand has not slumped much', async () => {
    const r = await bowlRig('all');
    r.eng.apply({ kind: 'buried', at: AT, radius: R, strength: 1, seed: 1 });
    const top = async () => {
      const s = await r.w.read('surface');
      return Float32Array.from(new Uint32Array(s.buffer, s.byteOffset, W * H), (v) => (v & 0x1ffff) / 256);
    };
    await r.w.step(2);
    const a = await top();
    await r.w.step(300);
    const b = await top();
    let moved = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const d = Math.abs(a[i] - b[i]);
      moved = Math.max(moved, d);
      if (dist(i % W, Math.floor(i / W)) < R) {
        sum += d;
        n++;
      }
    }
    console.log(`[mutators] burial woken 5 s: the most a column's top moved ${moved.toFixed(3)}, mean ${(sum / n).toFixed(4)}`);
    expect(g.takeErrors()).toEqual([]);
    expect(moved).toBeLessThan(1);
    expect(sum / n).toBeLessThan(0.15);
    r.gpu.dispose();
    r.w.destroy();
  });
});

// (round 5, BACKLOG MU-17) In the level the withered ground went green again in seconds wherever chunks were awake:
// the wilt system took the hostility from the ground each tick (none) and healed the brownness, and where it had not
// yet, the ecology cleared the browned plants away. Blighted columns are left as written.
test('withered, then the plants’ systems woken for 5 s: still dead, still standing', async () => {
  const map = tinyMap(W, H, 48, (x, y) => [{ z0: 0, z1: 11, mat: MAT.Stone }, { z0: 11, z1: 12, mat: MAT.Soil }]);
  map.vegetation.fill(4.2);
  map.moisture.fill(0.5);
  const w = await tinyWorld(g, map, 'all');
  const gpu = new MutateGpu(g.device, w.core.world, W, H);
  await gpu.ready;
  const eng = new MutateEngine({ gpu, world: { ground: () => 12, sea: -1e9, place: () => null, places: () => [] }, origin: () => [0, 0, 0], towns: () => [] });
  eng.apply({ kind: 'withered', at: AT, radius: R, strength: 1, seed: 1 });
  await w.step(2);
  const i = 32 * W + 32;
  const far = 2 * W + 2;
  const a = { wilt: (await w.core.readBuffer('wilt')).slice(), veg: (await w.core.readBuffer('veg')).slice() };
  await w.step(300);
  const b = { wilt: (await w.core.readBuffer('wilt')).slice(), veg: (await w.core.readBuffer('veg')).slice() };
  expect(g.takeErrors()).toEqual([]);
  expect(a.wilt[i * 4 + 1]).toBeGreaterThanOrEqual(0.52 - 1e-6);
  expect(b.wilt[i * 4 + 1]).toBe(a.wilt[i * 4 + 1]);
  expect(b.wilt[i * 4]).toBeGreaterThanOrEqual(5);
  expect(b.veg[i]).toBe(a.veg[i]);
  expect(b.veg[i]).toBeGreaterThan(4);
  // (outside the place the woods live on, unmarked)
  expect(b.wilt[far * 4]).toBeLessThan(4);
  expect(b.wilt[far * 4 + 1]).toBeLessThan(0.1);
  gpu.dispose();
  w.destroy();
});

test('a far eruption casts ash fall and darkness on the home town for three seasons; a near one casts none', async () => {
  const r = await rig();
  const seen: string[][] = [];
  const eng = new MutateEngine({ gpu: r.gpu, world: listWorld, origin: () => r.origin.o, towns: () => [], home: () => ({ id: 'home', at: [2000, 32 * ROW_H] }), signsChanged: (s) => void seen.push(s.map((q) => q.kind)) });
  eng.season(2);
  eng.apply({ kind: 'melted', at: AT, radius: R, seed: 2 });
  const signs = eng.signs('home');
  expect(signs.map((s) => s.kind).sort()).toEqual(['ashfall', 'darkness']);
  expect(signs[0].until).toBe(5);
  expect(signs[0].strength).toBeGreaterThan(0.3);
  expect(signs[0].strength).toBeLessThan(0.3 + 1e-9 + 0.7);
  expect(seen.length).toBe(1);
  eng.season(6);
  expect(eng.signs()).toEqual([]);
  const near = new MutateEngine({ gpu: r.gpu, world: listWorld, origin: () => r.origin.o, towns: () => [], home: () => ({ id: 'home', at: [100, 32 * ROW_H] }) });
  near.apply({ kind: 'melted', at: AT, radius: R, seed: 3 });
  expect(near.signs()).toEqual([]);
  expect(g.takeErrors()).toEqual([]);
});

// ---- (round 5, BACKLOG MU-42) a river run dry: the window's river columns settled to the cut ----------------------
test('riverSettle: river columns under a cut hold the table’s depth at it; the river beyond the cut, water off the table and a flood’s held stage are left; twice is the same', async () => {
  const r = await rig();
  const c = r.w.core;
  const dev = g.device;
  // (the rig's river band — rows 44..47, 5 deep at its line, 1.5 at its banks — as the atlas's table has it)
  const table = new Float32Array(W * H * 4);
  for (let y = 44; y < 48; y++)
    for (let x = 0; x < W; x++) table.set([0.1, 0, y === 45 || y === 46 ? 5 : 1.5, 5], (y * W + x) * 4);
  dev.queue.writeTexture({ texture: c.world.riverFlow }, c.world.ring.texToStore(table, 4), { bytesPerRow: c.world.riverFlow.width * 16 }, [c.world.riverFlow.width, c.world.riverFlow.height]);
  // (the wetness field: the climate's 1 taken off west of x = 24 — a cut to nothing — easing to none by x = 32)
  const wet = c.world.riverWet;
  const field = new Float32Array(wet.width * wet.height);
  for (let j = 0; j < wet.height; j++) for (let i = 0; i < wet.width; i++) field[j * wet.width + i] = i <= 3 ? -1 : 0;
  dev.queue.writeTexture({ texture: wet }, field, { bytesPerRow: wet.width * 4 }, [wet.width, wet.height]);
  // (a pond off the table, inside the cut; and a river column a flood holds)
  const before = await snap(r);
  const pond = 20 * W + 10;
  const heldCol = 45 * W + 6;
  const water = before.water.slice();
  water[pond] = 2;
  const src = before.src.slice();
  src[heldCol] = -(1024 + 20);
  dev.queue.writeBuffer(c.world.water, 0, c.world.ring.toStore(water, 1));
  dev.queue.writeBuffer(c.world.waterSource, 0, c.world.ring.toStore(src, 1));
  const d0 = r.gpu.dispatches;
  r.gpu.riverSettle([0, 0, W, H]);
  expect(r.gpu.dispatches - d0).toBe(1);
  const a = await snap(r);
  for (let y = 44; y < 48; y++) {
    // (under the whole cut: a dry bed)
    for (let x = 0; x < 24; x++) if (y * W + x !== heldCol) expect(a.water[y * W + x], `dry at ${x},${y}`).toBe(0);
    // (past it: as it was)
    for (let x = 33; x < W; x++) expect(a.water[y * W + x], `whole at ${x},${y}`).toBe(before.water[y * W + x]);
    // (between: lowered, never raised)
    for (let x = 24; x < 33; x++) expect(a.water[y * W + x]).toBeLessThanOrEqual(before.water[y * W + x]);
  }
  expect(a.water[pond]).toBe(2);
  expect(a.water[heldCol]).toBe(before.water[heldCol]);
  r.gpu.riverSettle([0, 0, W, H]);
  const b = await snap(r);
  expect(Array.from(b.water)).toEqual(Array.from(a.water));
});
