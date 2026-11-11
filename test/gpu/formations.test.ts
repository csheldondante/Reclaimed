// (U2 round 6, docs/design/UNIT_MINDS_U2.md §9d) Formations on the GPU, through the Units contract: a march along a gate's
// route (routeread.wgsl) whose width falls to 1.1 m goes single file there and re-forms after, and tells arrived(g) once;
// an off-road formation (a field march: go in formation) squeezes through a gap between two walls on the clearance left
// and right of its anchor. The town's place table and its routes are stand-ins written here in their contracts' layouts
// (townplace.wgsl, routeread.wgsl) — the tests' only CPU data; the GPU resolves everything from them.
//   FORM_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { MAIL_LAYOUT } from '../../src/agents/agents';
import { cellPos } from '../../src/world/lattice';
import { TOWN_ROOM, PLACE } from '../../src/api/contracts/townplaces';
import { TOWN_WORDS } from '../../src/towncontracts/contracts';
import type { AgentUnits } from '../../src/units/agent-units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const TPS = 60;
const LOG = process.env.FORM_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

/** townplace.wgsl's table: town 0 live, named places at window points (status OK), the rest none */
function fakePlaces(named: Record<number, [number, number, number]>): GPUBuffer {
  const words = new Uint32Array(TOWN_ROOM * TOWN_WORDS);
  const f = new Float32Array(words.buffer);
  words[0] = 1;
  for (let n = 0; n < 23; n++) {
    const e = 16 + n * 8;
    const p = named[n];
    words[e + 3] = p ? 0 : 1;
    if (p) {
      f.set(p, e);
      f.set(p, e + 4);
    }
  }
  const b = g.device.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(b, 0, words);
  return b;
}

/** routeread.wgsl's buffer: one route (id 0, generation 0), gate slot 0 its march route */
function fakeRoutes(points: { at: [number, number, number]; width: number }[]): GPUBuffer {
  const HEAD = 16;
  const heads = HEAD;
  const pts = heads + 4;
  const gates = pts + points.length * 5;
  const words = new Uint32Array(gates + 4);
  const f = new Float32Array(words.buffer);
  // (header: the halves' generations, ids a half, the points, the grid's place, the points' room, the heads, the
  // wall-walks (none), the gate slots (1), the version, the wall table, the gate table)
  words.set([0, 0, 1, pts, 0, 0, 0, points.length, heads, 0, 1, 1, gates, gates], 0);
  let s = 0;
  points.forEach((p, i) => {
    if (i) s += Math.hypot(p.at[0] - points[i - 1].at[0], p.at[1] - points[i - 1].at[1]);
    f.set([...p.at, s, p.width], pts + i * 5);
  });
  words.set([0, points.length], heads);
  f[heads + 2] = s;
  words[heads + 3] = 0;
  words.set([0, 0], gates);
  const b = g.device.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(b, 0, words);
  return b;
}

async function world(wallAt: (x: number, y: number) => boolean = () => false) {
  const map = tinyMap(W, W, 32, (x: number, y: number) => [{ z0: 0, z1: wallAt(x, y) ? 22 : 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const { AgentUnits } = await import('../../src/units/agent-units');
  const units: AgentUnits = new AgentUnits(agents);
  const run = async (n: number, every?: () => Promise<boolean | void>) => {
    for (let i = 0; i < n; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
      units.update(1 / TPS);
      await g.device.queue.onSubmittedWorkDone();
      if (every && (await every())) return i + 1;
    }
    return n;
  };
  return { w, agents, units, run };
}

/** where each of the ids stands (a raw read of the rows: the test's) */
async function where(units: AgentUnits, ids: number[]): Promise<[number, number][]> {
  const raw = new Float32Array(await units.agents.readRaw('units'));
  return ids.flatMap((id) => {
    const u = units.recs.get(id);
    if (!u || !u.v.alive) return [];
    const o = (u.gpu % 8192) * 24;
    return [[raw[o], raw[o + 1]] as [number, number]];
  });
}

/** a group's rank table: each rank's row and its row's columns (formSlots' word 6) */
async function ranks(units: AgentUnits, slot: number, n: number): Promise<{ row: number; cols: number }[]> {
  const mail = new Uint32Array(await units.agents.readRaw('mail'));
  const out: { row: number; cols: number }[] = [];
  for (let k = 0; k < n; k++) {
    const w = mail[MAIL_LAYOUT.ranks + (slot * MAIL_LAYOUT.ranksPerGroup + k) * MAIL_LAYOUT.rankW + 6];
    out.push({ row: w & 0xffff, cols: w >>> 16 });
  }
  return out;
}

test('§9d: a column narrows to single file where its route is 1.1 m wide and re-forms after; march g along r gives arrived(g) once', async () => {
  const { units, run } = await world();
  const y = 40;
  // (a straight route along row 40, x 14 → 80: 5 m wide but 1.1 m over x 40-50 — a stair's width)
  const pts = Array.from({ length: 67 }, (_, i) => {
    const x = 14 + i;
    const [px, py] = cellPos(x, y);
    return { at: [px, py, 10] as [number, number, number], width: x >= 40 && x <= 50 ? 1.1 : 5 };
  });
  const yard = cellPos(10, y);
  units.usePlaces(fakePlaces({ [PLACE.barracks]: [yard[0], yard[1], 10] }), null, () => fakeRoutes(pts));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.barracks }, 12);
  const arrived: number[] = [];
  units.arrived.push((x) => arrived.push(x));
  await run(30);
  units.orderGroup!(gid, { kind: 'march', town: 0, gate: 0 });
  const ids = units.members!(gid);
  const lineY = cellPos(0, y)[1];
  let narrowMax = 0;
  let narrowSeen = 0;
  let wideSpread = 0;
  let wideCols = 0;
  let arrivedAt = -1;
  await run(TPS * 60, async () => {
    const ps = await where(units, ids);
    for (const [x, py] of ps) {
      // (the narrow stretch's middle: every unit there within half a cell of the line)
      if (x > 42 && x < 48) {
        narrowMax = Math.max(narrowMax, Math.abs(py - lineY));
        narrowSeen++;
      }
    }
    const past = ps.filter(([x]) => x > 58 && x < 78);
    if (past.length >= 6) wideSpread = Math.max(wideSpread, Math.max(...past.map(([, py]) => py)) - Math.min(...past.map(([, py]) => py)));
    const rk = await ranks(units, 0, 12);
    wideCols = Math.max(wideCols, ...rk.map((r) => r.cols));
    if (arrived.includes(gid) && arrivedAt < 0) arrivedAt = 1;
    return arrivedAt > 0 && wideSpread > 0;
  });
  await run(TPS * 3);
  log(`narrows: narrowMax ${narrowMax.toFixed(2)} over ${narrowSeen} reads, wide spread ${wideSpread.toFixed(2)}, cols ${wideCols}, arrived ${arrived.filter((x) => x === gid).length}`);
  expect(narrowSeen).toBeGreaterThan(20);
  expect(narrowMax).toBeLessThan(0.6);
  expect(wideCols).toBeGreaterThanOrEqual(2);
  expect(wideSpread).toBeGreaterThan(0.9);
  expect(arrived.filter((x) => x === gid).length).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('§9d: an off-road formation squeezes through a gap between two walls (the clearance on each side) and re-forms', async () => {
  // (a wall across x 46-48, a gap at rows 38-41; the squad from x 20 to x 75 in a line)
  const wall = (x: number, yy: number) => x >= 46 && x <= 48 && !(yy >= 38 && yy <= 41);
  const { units, run } = await world(wall);
  const from = cellPos(20, 40);
  const to = cellPos(75, 40);
  units.usePlaces(fakePlaces({ [PLACE.barracks]: [from[0], from[1], 10], [PLACE.muster]: [to[0], to[1], 10] }));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.barracks }, 9);
  const arrived: number[] = [];
  units.arrived.push((x) => arrived.push(x));
  await run(30);
  units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: PLACE.muster }, formation: 'line' });
  const ids = units.members!(gid);
  let colsMost = 0;
  let colsAtGap = 99;
  await run(TPS * 60, async () => {
    const ps = await where(units, ids);
    const rk = await ranks(units, 0, 9);
    colsMost = Math.max(colsMost, ...rk.map((r) => r.cols));
    // (while the front is in the gap: the rows there)
    if (ps.some(([x]) => x > 45 && x < 49)) colsAtGap = Math.min(colsAtGap, ...rk.map((r) => r.cols));
    return arrived.includes(gid);
  });
  const ps = await where(units, ids);
  const beyond = ps.filter(([x]) => x > 60).length;
  log(`gap: cols most ${colsMost}, at the gap ${colsAtGap}, beyond ${beyond}/${ids.length}, arrived ${arrived.filter((x) => x === gid).length}`);
  expect(colsMost).toBeGreaterThanOrEqual(3);
  expect(colsAtGap).toBeLessThanOrEqual(3);
  expect(colsAtGap).toBeLessThan(colsMost);
  expect(beyond).toBe(ids.length);
  expect(arrived.filter((x) => x === gid).length).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});
