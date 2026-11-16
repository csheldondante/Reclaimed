// Rest claims External (DESIGN §3, §10 "At rest"; docs/design/PHYSICS_ENGINE.md "Rest claims External"; BACKLOG PQ10,
// PQ7): a row asleep writes its footprint into the columns as External intervals that name it (engine_claim.wgsl),
// the orphan pass holds them by the row's claim table (the External contract's third owner kind: sim/external.ts
// "GPU-owned rows"), waking clears them, and ground cut from under any column of the claim wakes the row on the GPU.
// Numbers for the DEVLOG: CLAIM_LOG=1 npx vitest run --project gpu engine-claim --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { CLAIM, Engine, POOL, type EngineBody } from '../../src/engine/engine';
import { kickOnEvents } from '../../src/engine/install';
import { ColumnApply } from '../../src/game/colapply';
import { OP } from '../../src/sim/edit-ops';
import { ownedByRow, OWN_KIND_ROW } from '../../src/sim/external';
import { EventKind } from '../../src/sim/globals';
import { TUNE } from '../../src/tune/params';
import { columnSlots, packColumn, readColumn, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { box } from './engine-rig';
import { tinyWorld, type TinyWorld } from './world';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());
const LOG = !!process.env.CLAIM_LOG;
const log = (...a: unknown[]) => LOG && console.log(...a);
const T = TUNE.engine as Record<string, number>;
T.deform = 0;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);
const ASLEEP = 2;
const CLAIMED = 512;
const SUP = 0x10000000;
const ownWord = (row: number, gen: number, sup = false) => (OWN_KIND_ROW | (sup ? SUP : 0) | (gen << 20) | row) >>> 0;
const genOf = (own: number) => (own >>> 20) & 0xff;
const rowOf = (own: number) => own & 0xfffff;

interface Rig {
  w: TinyWorld;
  e: Engine;
  /** ticks one at a time with the event loop turned between them, as between frames: the engine's own read lands */
  frames(n: number, each?: () => void): Promise<void>;
  row(b: EngineBody): Promise<{ pos: number[]; q: number[]; flags: number }>;
  /** the columns as the GPU has them */
  cols(): Promise<(x: number, y: number) => Interval[]>;
  put(x: number, y: number, col: Interval[]): void;
  pool(k: number): Promise<number>;
}

async function rig(col: (x: number, y: number) => Interval[], W = 32, H = 32): Promise<Rig> {
  const w = await tinyWorld(g, tinyMap(W, H, 64, col), ['surface']);
  const e = new Engine(g.device, w.core.world, w.core.host.profiler);
  const sys = w.core.sim.systems;
  sys.splice(sys.findIndex((s) => s.name === 'surface') + 1, 0, e);
  kickOnEvents(w.core.sim, e);
  const on = (s: { name: string }) => s.name === 'surface' || s.name === 'engine' || s.name === 'edit';
  const R: Rig = {
    w,
    e,
    frames: async (n, each) => {
      for (let i = 0; i < n; i++) {
        w.core.sim.step(w.core.globals, on);
        await g.device.queue.onSubmittedWorkDone();
        each?.();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    row: async (b) => {
      const D = e.debugBuffers;
      const p = new Float32Array(await g.read(D.pose, 64, b.row * 64));
      return { pos: [...p.slice(8, 11)], q: [...p.slice(12, 16)], flags: new Uint32Array(await g.read(D.info, 64, b.row * 64))[3] };
    },
    cols: async () => {
      const L = w.core.world.layers;
      const u = new Uint32Array(await g.read(L, L.size));
      return (x, y) => readColumn(w.core.packed, u, x, y);
    },
    put: (x, y, c) => {
      const { base, k } = columnSlots(w.core.packed, x, y);
      g.device.queue.writeBuffer(w.core.world.layers, base * 16, packColumn(c, k));
    },
    pool: async (k) => new Uint32Array(await g.read(e.debugBuffers.pool, 4, k * 4))[0],
  };
  await R.frames(1);
  return R;
}
const flat = () => [{ z0: 0, z1: 10, mat: MAT.Stone }];
const claimsOf = (col: Interval[]) => col.filter((iv) => iv.mat === MAT.External && ownedByRow(iv.own));
const gpuCols = (R: Rig) => ({ slots: R.w.core.world.layers, chunks: R.w.core.world.chunks, packed: R.w.core.packed, stamp: R.w.core.globals.tick + 1 });

// ---- item 1: the ownership contract -----------------------------------------------------------------------------------
test('the orphan pass turns an External interval no owner holds back into ground (the finding); a row named in it holds it while its claim of that generation is live, and not otherwise', async () => {
  const R = await rig(flat);
  const ap = new ColumnApply(g.device);
  const claim = (gen: number): Interval[] => [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 12, mat: MAT.External, aux: MAT.Brick, own: ownWord(4, gen, true) }];
  const live = (gen: number) => g.device.queue.writeBuffer(R.e.rowClaims, (CLAIM.at + 4 * CLAIM.words + 1) * 4, new Uint32Array([gen]));
  // the finding: unnamed to the pass (no table bound), it is an orphan and becomes its fallback
  R.put(5, 5, claim(3));
  ap.orphans(gpuCols(R), new Map());
  let at = await R.cols();
  expect(at(5, 5).map((iv) => iv.mat)).toEqual([MAT.Stone, MAT.Brick]);
  // the contract: the row's table bound, its live claim of that generation holds the interval, owner word and all
  R.put(5, 5, claim(3));
  live(3);
  ap.orphans(gpuCols(R), new Map(), null, { buf: R.e.rowClaims });
  at = await R.cols();
  expect(at(5, 5)[1]).toMatchObject({ mat: MAT.External, aux: MAT.Brick, own: ownWord(4, 3, true), z0: 10, z1: 12 });
  // a row used again (another generation live), or with no live claim: the old claim is an orphan
  live(4);
  ap.orphans(gpuCols(R), new Map(), null, { buf: R.e.rowClaims });
  at = await R.cols();
  expect(at(5, 5).map((iv) => iv.mat)).toEqual([MAT.Stone, MAT.Brick]);
  expect(at(5, 5)[1].own ?? 0).toBe(0);
  ok();
  ap.destroy();
  R.w.destroy();
});

// ---- item 2: sleep writes the claim, wake clears it -------------------------------------------------------------------
test('a block that falls asleep is in the columns as External naming its row; an impulse clears it to air; asleep again it claims under a new generation; a quiet tick still encodes nothing', async () => {
  const R = await rig(flat);
  const b = R.e.add({ cells: box(14, 14, 11, 3, 3, 3) })!;
  await R.frames(200);
  const rest = await R.row(b);
  expect(rest.flags & (ASLEEP | CLAIMED)).toBe(ASLEEP | CLAIMED);
  let at = await R.cols();
  const mine = claimsOf(at(15, 15));
  log('asleep at', rest.pos.map((v) => v.toFixed(2)).join(' '), 'column (15, 15):', JSON.stringify(at(15, 15)));
  expect(mine.length).toBe(1);
  expect(rowOf(mine[0].own!)).toBe(b.row);
  expect(mine[0].own! & SUP).toBe(SUP);
  expect(mine[0].aux).toBe(MAT.Stone);
  // (it stands on the ground: brought down onto it; its top the block's, within the field's quarter cell)
  expect(mine[0].z0).toBeCloseTo(10, 3);
  expect(Math.abs(mine[0].z1 - (rest.pos[2] + 1.5))).toBeLessThan(0.3);
  // (its footprint and no more: 3 columns across, none two columns off)
  let n = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) n += claimsOf(at(x, y)).length;
  expect(n).toBeGreaterThanOrEqual(7);
  expect(n).toBeLessThanOrEqual(16);
  expect(claimsOf(at(11, 15)).length + claimsOf(at(19, 15)).length).toBe(0);
  expect(await R.pool(POOL.claims)).toBe(1);
  expect(await R.pool(POOL.claimFull)).toBe(0);
  // asleep and claimed, it stays asleep (its own claim is not a change of its ground) and the tick is empty
  const pos0 = rest.pos;
  await R.frames(60);
  expect(R.e.counts.direct + R.e.counts.indirect).toBe(0);
  expect((await R.row(b)).pos).toEqual(pos0);
  const g1 = genOf(mine[0].own!);
  // an impulse wakes it: the claim is air the tick it wakes
  R.e.impulse(b, [0, 0, 8]);
  await R.frames(6);
  at = await R.cols();
  n = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) n += claimsOf(at(x, y)).length;
  expect(n).toBe(0);
  expect(at(15, 15)).toEqual([{ z0: 0, z1: 10, mat: MAT.Stone, aux: 0 }]);
  expect((await R.row(b)).flags & (ASLEEP | CLAIMED)).toBe(0);
  expect(await R.pool(POOL.claims)).toBe(0);
  // it comes down on the ground, not on a claim left behind, and claims again: a new generation
  await R.frames(300);
  const again = await R.row(b);
  expect(again.flags & (ASLEEP | CLAIMED)).toBe(ASLEEP | CLAIMED);
  expect(Math.abs(again.pos[2] - rest.pos[2])).toBeLessThan(0.1);
  at = await R.cols();
  const c = cellOf(again.pos);
  const m2 = claimsOf(at(c[0], c[1]));
  expect(m2.length).toBe(1);
  expect(genOf(m2[0].own!)).not.toBe(g1);
  // a dead claim of the row's earlier generation, planted far off with air under it: the orphan pass does not hold it
  // (the live one it does), and the support watch does not wake the row for it
  R.put(3, 3, [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 12, z1: 13, mat: MAT.External, aux: MAT.Stone, own: ownWord(b.row, g1, true) }]);
  R.w.core.globals.events.push({ kind: EventKind.Edit, x: 3.5, y: 3, z: OP.DIG * 32 + 512, radius: 0.6, strength: 1 });
  await R.frames(40);
  expect((await R.row(b)).flags & ASLEEP).toBe(ASLEEP);
  const ap = new ColumnApply(g.device);
  ap.orphans(gpuCols(R), new Map(), null, { buf: R.e.rowClaims });
  at = await R.cols();
  expect(claimsOf(at(3, 3)).length).toBe(0);
  expect(claimsOf(at(c[0], c[1])).length).toBe(1);
  // the host lets every row go: their claims go with them
  R.e.clear();
  await R.frames(2);
  at = await R.cols();
  n = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) n += claimsOf(at(x, y)).length;
  expect(n).toBe(0);
  ok();
  ap.destroy();
  R.w.destroy();
}, 120_000);

/** the storage column a world point lies over (world/lattice.ts: rows 0.866 apart, odd rows half a cell along) */
function cellOf(p: number[]): [number, number] {
  const y = Math.floor(p[1] / 0.8660254);
  return [Math.floor(p[0] - 0.5 * (y & 1)), y];
}

// ---- item 3: support gone wakes the owner, anywhere under the claim (BACKLOG PQ7's repro) -----------------------------
/** a 12-long beam on stone piers (its ends, and with `mid` its middle), over a floor four cells down */
const piers = (mid: boolean) => (x: number, y: number): Interval[] => {
  const pier = y >= 13 && y <= 17 && ((x >= 8 && x <= 10) || (x >= 17 && x <= 19) || (mid && x >= 13 && x <= 14));
  return [{ z0: 0, z1: pier ? 14 : 10, mat: MAT.Stone }];
};
const dig = (R: Rig, x: number, y: number, radius: number) => {
  for (let k = 0; k < 8; k++) R.w.core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.DIG * 32 + 512, radius, strength: 3 });
};
const tilt = (q: number[]) => 2 * Math.asin(Math.min(1, Math.hypot(q[0], q[1], q[2])));

for (const [name, at, moves] of [
  ['one end', 9.5, true],
  ['the middle', 14, false],
] as const) {
  test(`a 12-long beam asleep on piers: the pier under ${name} dug away, it wakes${moves ? ' and tips' : ', and stays where it lay'}`, async () => {
    const R = await rig(piers(!moves));
    const b = R.e.add({ cells: box(8, 14, 14, 12, 3, 2) })!;
    await R.frames(200);
    const rest = await R.row(b);
    expect(rest.flags & (ASLEEP | CLAIMED)).toBe(ASLEEP | CLAIMED);
    // (the centre's own column is over no pier at the end's dig: what the old watch looked at does not change)
    let woke = -1;
    let n = 0;
    const each = () => {
      n++;
      if (woke < 0 && R.e.awakeSeen > 0) woke = n;
    };
    // the pier dug down in a few goes, as a player's dig does
    for (let k = 0; k < 4; k++) {
      dig(R, at, 15.5 * 0.8660254, 2.6);
      await R.frames(20, each);
    }
    await R.frames(300, each);
    const after = await R.row(b);
    log(`${name}: woke at frame ${woke}; centre ${rest.pos.map((v) => v.toFixed(2)).join(' ')} -> ${after.pos.map((v) => v.toFixed(2)).join(' ')}; tilt ${tilt(rest.q).toFixed(3)} -> ${tilt(after.q).toFixed(3)}; flags ${after.flags}`);
    const cols = await R.cols();
    expect(cols(Math.round(at - 0.5), 15)[0].z1).toBeLessThan(13);
    expect(woke).toBeGreaterThan(0);
    if (moves) {
      expect(tilt(after.q)).toBeGreaterThan(0.15);
      expect(after.pos[2]).toBeLessThan(rest.pos[2] - 0.5);
    } else {
      expect(tilt(after.q)).toBeLessThan(0.03);
      expect(Math.hypot(after.pos[0] - rest.pos[0], after.pos[1] - rest.pos[1], after.pos[2] - rest.pos[2])).toBeLessThan(0.15);
      // (asleep again where it lay, claimed again)
      expect(after.flags & (ASLEEP | CLAIMED)).toBe(ASLEEP | CLAIMED);
    }
    ok();
    R.w.destroy();
  }, 120_000);
}
