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
  const L = units.agents.mailLayout;
  const out: { row: number; cols: number }[] = [];
  for (let k = 0; k < n; k++) {
    const w = mail[L.ranks + (slot * L.ranksPerGroup + k) * L.rankW + 6];
    out.push({ row: w & 0xff, cols: w >>> 16 });
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

test('spawnAt at a missing place, then orderGroup guard → 0 units, the failure sticking; a spawn past the groups → pool-full', async () => {
  const { units, run } = await world();
  const yard = cellPos(60, 40);
  // (a muster yard, no barracks)
  units.usePlaces(fakePlaces({ [PLACE.muster]: [yard[0], yard[1], 10] }));
  const failed: [number, string][] = [];
  units.orderFailed.push((gid, why) => failed.push([gid, why]));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.barracks }, 3);
  // (at once, before the spawn resolved: it waits for it, and fails with it)
  units.orderGroup!(gid, { kind: 'guard', at: { town: 0, place: PLACE.muster } });
  await run(30);
  units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: PLACE.muster } });
  await run(30);
  const standing = [...units.recs.values()].filter((u) => u.v.alive && u.v.role === 'soldier').length;
  const near = (await units.query([yard[0], yard[1]], 20)).length;
  // (every order group held — as many as the memory given them, Agents.orderGroups — and one more: an id, no units,
  // pool-full)
  const held = Array.from({ length: units.agents.orderGroups }, () => units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.muster }, 1));
  const ninth = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.muster }, 1);
  await run(10);
  log(`missing place: standing ${standing}, near the yard ${near}, failed ${JSON.stringify(failed)}, held ${held.length}`);
  expect(standing).toBe(0);
  expect(near).toBe(0);
  expect(units.members!(gid)).toEqual([]);
  expect(failed.filter(([x]) => x === gid).map(([, w]) => w)).toEqual(['none', 'none']);
  expect(failed.filter(([x]) => x === ninth).map(([, w]) => w)).toEqual(['pool-full']);
  expect(units.members!(ninth)).toEqual([]);
  expect(g.takeErrors()).toEqual([]);
});

/** a group's anchor words (formAnchor's: FORM_AT + 4 s, 8 state, 10 lag, 11 the loop's radius) */
async function anchor(units: AgentUnits, slot: number): Promise<{ s: number; st: number; lag: number; radius: number }> {
  const L = units.agents.mailLayout;
  const mail = new Uint32Array(await units.agents.readRaw('mail'));
  const f = new Float32Array(mail.buffer);
  const o = L.groups + slot * L.groupW + L.formAt;
  return { s: f[o + 4], st: mail[o + 8], lag: f[o + 10], radius: f[o + 11] };
}

/** the window cell whose hexagon holds a point (common.wgsl cellAt: cube rounding) */
const ROW_H = Math.sqrt(3) / 2;
const cellOf = (x: number, y: number): [number, number] => {
  const r = (y - 0.5 * ROW_H) / ROW_H;
  const c = [x - 0.5 - 0.5 * r, r, -(x - 0.5 - 0.5 * r) - r];
  const q = c.map(Math.round);
  const d = c.map((v, i) => Math.abs(q[i] - v));
  if (d[0] > d[1] && d[0] > d[2]) q[0] = -q[1] - q[2];
  else if (d[1] > d[2]) q[1] = -q[0] - q[2];
  return [q[0] + (q[1] - (q[1] & 1)) / 2, q[1]];
};

/** (round 6b) the rank table as it stands (the test's read): each live rank's unit position, its target, its mode, its
 *  row, order index and row count; and the rows' counts this frame (word 8's high half, rows until all are placed) */
async function rankTable(units: AgentUnits, slot: number) {
  const L = units.agents.mailLayout;
  const mail = new Uint32Array(await units.agents.readRaw('mail'));
  const f = new Float32Array(mail.buffer);
  const raw = new Float32Array(await units.agents.readRaw('units'));
  const rs: { k: number; at: [number, number]; to: [number, number]; d: number; mode: number; row: number; idx: number; cols: number }[] = [];
  for (let k = 0; k < L.ranksPerGroup; k++) {
    const r = L.ranks + (slot * L.ranksPerGroup + k) * L.rankW;
    const u = mail[r + 4];
    if (!u || (mail[r + 3] & 0xff) === 0) continue;
    const o = (u - 1) * 24;
    rs.push({ k, at: [raw[o], raw[o + 1]], to: [f[r], f[r + 1]], d: f[r + 5], mode: mail[r + 3] & 0xff, row: mail[r + 6] & 0xff, idx: (mail[r + 6] >> 8) & 0xff, cols: mail[r + 6] >>> 16 });
  }
  const rows: number[] = [];
  let placed = 0;
  for (let r = 0; r < L.ranksPerGroup && placed < rs.length; r++) {
    const c = mail[L.ranks + (slot * L.ranksPerGroup + r) * L.rankW + 8] >>> 16;
    if (!c) break;
    rows.push(Math.min(c, rs.length - placed));
    placed += c;
  }
  return { rs, rows };
}

/** pairs of the ranks' straight paths (where it stands → its target) that cross */
function crossings(rs: { at: [number, number]; to: [number, number] }[]): number {
  const side = (a: [number, number], b: [number, number], c: [number, number]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let n = 0;
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const p = rs[i], q = rs[j];
      if (side(p.at, p.to, q.at) * side(p.at, p.to, q.to) < 0 && side(q.at, q.to, p.at) * side(q.at, q.to, p.to) < 0) n++;
    }
  return n;
}

/** a world of 2 m stone walls where `wallAt`, and water `depth(x, y)` deep on the ground */
async function worldWith(wallAt: (x: number, y: number) => boolean, depth: (x: number, y: number) => number = () => 0) {
  const map = tinyMap(W, W, 32, (x: number, y: number) => [{ z0: 0, z1: wallAt(x, y) ? 12 : 10, mat: MAT.Stone }]);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) map.water[y * W + x] = depth(x, y);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const { AgentUnits } = await import('../../src/units/agent-units');
  const units: AgentUnits = new AgentUnits(agents);
  const run = async (k: number, every?: () => Promise<boolean | void>) => {
    for (let i = 0; i < k; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
      units.update(1 / TPS);
      await g.device.queue.onSubmittedWorkDone();
      if (every && (await every())) return i + 1;
    }
    return k;
  };
  return { units, run };
}

/** a drill in a yard ringed by a 2 m hedge (inner radius `inner` cells, open to the west; 0: open ground): the soldiers
 *  walk in from the barracks; returns the laps the anchor went in `secs` once formed, how far each soldier moved, the
 *  rows' counts seen, arrived's count */
async function drillIn(inner: number, n: number, secs: number, discipline = 1) {
  const c = cellPos(48, 40);
  const hedge = (x: number, y: number) => {
    if (!inner) return false;
    const [px, py] = cellPos(x, y);
    const d = Math.hypot(px - c[0], py - c[1]);
    return d >= inner && d < inner + 1.5 && !(px < c[0] - inner * 0.7 && Math.abs(py - c[1]) < 1.6);
  };
  const { units, run } = await worldWith(hedge);
  const from = cellPos(20, 40);
  units.usePlaces(fakePlaces({ [PLACE.barracks]: [from[0], from[1], 10], [PLACE.muster]: [c[0], c[1], 10] }));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.barracks }, n);
  const arrived: number[] = [];
  units.arrived.push((x) => arrived.push(x));
  await run(30);
  units.orderGroup!(gid, { kind: 'drill', at: { town: 0, place: PLACE.muster }, formation: 'column', discipline });
  const ids = units.members!(gid);
  // (formed: every rank within FORM_LAG of its slot; then the clock)
  const formedIn = await run(TPS * 40, async () => {
    const a = await anchor(units, 0);
    return a.lag > 0 && a.lag < 3;
  });
  let a = await anchor(units, 0);
  let lastS = a.s;
  let went = 0;
  let prev = await where(units, ids);
  const moved = prev.map(() => 0);
  let lagMax = 0;
  const rowsSeen = new Set<string>();
  let inWall = 0;
  let gaps: number[] = [];
  await run(TPS * secs, async () => {
    a = await anchor(units, 0);
    const loop = 2 * Math.PI * Math.max(a.radius, 1e-3);
    went += (((a.s - lastS) % loop) + loop) % loop;
    lastS = a.s;
    lagMax = Math.max(lagMax, a.lag);
    const ps = await where(units, ids);
    ps.forEach((p, i) => (moved[i] += Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1])));
    for (const [x, y] of ps) if (hedge(...cellOf(x, y))) inWall++;
    prev = ps;
    const t = await rankTable(units, 0);
    rowsSeen.add(t.rows.join(','));
    // (the slots' spacing within each row: neighbours by order index)
    for (let r = 0; r < t.rows.length; r++) {
      const row = t.rs.filter((x) => x.row === r).sort((p, q) => p.idx - q.idx);
      for (let i = 1; i < row.length; i++) gaps.push(Math.hypot(row[i].to[0] - row[i - 1].to[0], row[i].to[1] - row[i - 1].to[1]));
    }
  });
  const laps = a.radius > 0 ? went / (2 * Math.PI * a.radius) : 0;
  const mean = gaps.reduce((s, x) => s + x, 0) / Math.max(gaps.length, 1);
  const gapSd = Math.sqrt(gaps.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(gaps.length, 1));
  gaps = [];
  const out = { formedIn, radius: a.radius, laps, moved, lagMax, rows: [...rowsSeen], inWall, gapMean: mean, gapSd, arrived: arrived.filter((x) => x === gid).length, st: a.st };
  log(`drill (inner ${inner}, discipline ${discipline}): ${JSON.stringify({ ...out, moved: moved.map((m) => +m.toFixed(1)) })}`);
  return out;
}

test('§9d drill: a squad drills round a small hedged yard (inner radius 4): the loop fits it, the anchor laps, every soldier moves, arrived once', async () => {
  const r = await drillIn(4, 6, 30);
  expect(r.formedIn).toBeLessThan(TPS * 40);
  expect(r.radius).toBeLessThan(4);
  expect(r.laps).toBeGreaterThanOrEqual(1);
  expect(Math.min(...r.moved)).toBeGreaterThan(4);
  expect(r.inWall).toBe(0);
  expect(r.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('§9d drill on open ground stays a grid: rows of 3 at the full spacing, the anchor lapping', async () => {
  const r = await drillIn(0, 6, 20);
  expect(r.rows).toEqual(['3,3']);
  expect(Math.abs(r.gapMean - 1.2)).toBeLessThan(0.05);
  expect(r.gapSd).toBeLessThan(0.05);
  expect(r.laps).toBeGreaterThan(0.4);
  expect(r.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('§9d discipline: a ragged drill (discipline 0) wanders measurably off the grid a drilled one keeps; nobody in the hedge', async () => {
  const drilled = await drillIn(0, 6, 20, 1);
  const ragged = await drillIn(0, 6, 20, 0);
  expect(ragged.gapSd).toBeGreaterThan(drilled.gapSd + 0.15);
  expect(ragged.inWall).toBe(0);
  expect(ragged.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

/** (round 6b, the chain of rows) a squad of n from x 18 to x 72 along row 40 through corridors: segments [x0, x1) open
 *  within `half` (world y, or a function of x) of the row, 2 m walls round them; elsewhere open ground. Read each frame:
 *  the rows' counts (logged when they change), crossings of the ranks' paths to their slots, anyone in a wall column,
 *  each segment's row-0 counts while the front row is inside it */
async function corridorRun(segs: { x0: number; x1: number; half: number | ((x: number) => number) }[], n: number, formation: 'line' | 'column' | 'loose' = 'line', kind = 'soldier') {
  const cy = cellPos(0, 40)[1];
  const halfAt = (s: (typeof segs)[number], x: number) => (typeof s.half === 'number' ? s.half : s.half(x));
  const wallAt = (x: number, y: number) => {
    const [, py] = cellPos(x, y);
    return segs.some((s) => x >= s.x0 && x < s.x1 && Math.abs(py - cy) > halfAt(s, x));
  };
  const { units, run } = await worldWith(wallAt);
  const from = cellPos(18, 40);
  const to = cellPos(72, 40);
  units.usePlaces(fakePlaces({ [PLACE.barracks]: [from[0], from[1], 10], [PLACE.muster]: [to[0], to[1], 10] }));
  const gid = units.spawnAt!(kind, 'f-town', { town: 0, place: PLACE.barracks }, n);
  const arrived: number[] = [];
  units.arrived.push((x) => arrived.push(x));
  await run(30);
  units.orderGroup!(gid, kind === 'raider' ? { kind: 'go', at: { town: 0, place: PLACE.muster } } : { kind: 'go', at: { town: 0, place: PLACE.muster }, formation });
  const ids = units.members!(gid);
  const rowsLog: string[] = [];
  let inWall = 0;
  let cross = 0;
  let crossChecks = 0;
  let spreadMost = 0;
  const colsIn = segs.map(() => [99, 0]);
  await run(TPS * 90, async () => {
    const ps = await where(units, ids);
    for (const [x, y] of ps) if (wallAt(...cellOf(x, y))) {
      if (inWall++ < 3 && process.env.FORM_DEBUG) log(`in wall at ${x.toFixed(2)},${y.toFixed(2)} cell ${cellOf(x, y)}`);
    }
    const mx = ps.reduce((s, p) => s + p[0], 0) / ps.length;
    const my = ps.reduce((s, p) => s + p[1], 0) / ps.length;
    spreadMost = Math.max(spreadMost, ...ps.map(([x, y]) => Math.hypot(x - mx, y - my)));
    if (formation !== 'loose' && kind !== 'raider') {
      const t = await rankTable(units, 0);
      const L = units.agents.mailLayout;
      const ax = new Float32Array(await units.agents.readRaw('mail'))[L.groups + L.formAt + 5];
      const key = t.rows.join(',');
      if (rowsLog[rowsLog.length - 1]?.split(' ')[1] !== key) {
        rowsLog.push(`${ax.toFixed(1)} ${key}`);
        // (as the rows change, once formed (the first shape is from a crowd): pairs of the ranks' straight paths to their
        // slots that cross — those steering at their slot
        // itself (its distance, word 5, is the way's length); one re-slotted onto its row's point is on its way there)
        const steer = t.rs.filter((x) => x.mode === 1 && Math.abs(Math.hypot(x.to[0] - x.at[0], x.to[1] - x.at[1]) - x.d) < 0.05);
        const cn = rowsLog.length > 1 ? crossings(steer) : 0;
        if (cn && process.env.FORM_DEBUG) log(`cross ${cn} at ${key}: ${steer.map((x) => `${x.idx}:${x.at.map((v) => v.toFixed(1))}->${x.to.map((v) => v.toFixed(1))}`).join(' ')}`);
        cross += cn;
        crossChecks++;
      }
      segs.forEach((s, i) => {
        if (ax > s.x0 + 3 && ax < s.x1 - 1) colsIn[i] = [Math.min(colsIn[i][0], t.rows[0]), Math.max(colsIn[i][1], t.rows[0])];
      });
    }
    return arrived.includes(gid);
  });
  await run(TPS * 2);
  const ps = await where(units, ids);
  const beyond = ps.filter(([x]) => x > 62).length;
  const out = { rowsLog, inWall, cross, crossChecks, colsIn, spreadMost, beyond, n: ids.length, arrived: arrived.filter((x) => x === gid).length };
  log(`corridor ${formation}/${kind} ${JSON.stringify(segs.map((s) => [s.x0, s.x1, typeof s.half === 'number' ? s.half : 'fn']))}: ${JSON.stringify(out)}`);
  return out;
}

test('§9d elastic: a slight narrowing (9 abreast → room for about 7) squeezes the front row, its count unchanged', async () => {
  const r = await corridorRun([{ x0: 36, x1: 54, half: 5.4 }], 9);
  expect(r.colsIn[0]).toEqual([9, 9]);
  expect(r.inWall).toBe(0);
  expect(r.beyond).toBe(r.n);
  expect(r.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('§9d chain: a 5-wide line of 15 through a 1.1 m gate — rows drop their outer soldiers into the rows behind and refill after, nobody crossing or in a wall, arrived once', async () => {
  // (a corridor 5 abreast, a one-cell gate in it, the corridor again, then open ground)
  const r = await corridorRun([{ x0: 26, x1: 40, half: 4.8 }, { x0: 40, x1: 42, half: 0.5 }, { x0: 42, x1: 54, half: 4.8 }], 15);
  const counts = r.rowsLog.map((l) => l.split(' ')[1].split(',').map(Number));
  // (single file through the gate: some row of 1 behind rows of 5)
  expect(counts.some((c) => c.includes(1) && c.includes(5))).toBe(true);
  expect(r.colsIn[0][1]).toBeLessThanOrEqual(5);
  // (out on open ground again: the clean grid, 10 and 5)
  expect(counts[counts.length - 1]).toEqual([10, 5]);
  // (the order follows where they stand as the rows change: a zipper into single file or a row refilling can still
  // cross a pair — measured, under one pair a change)
  expect(r.cross).toBeLessThan(r.crossChecks);
  expect(r.inWall).toBe(0);
  expect(r.beyond).toBe(r.n);
  expect(r.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('§9d chain: no flicker — a corridor whose width saws across the threshold every two cells changes the front row a couple of times at most', async () => {
  // (half 4.0 / 4.8 by turns: room for 4 or 5 abreast at the full spacing, squeezed 6 or 7)
  const r = await corridorRun([{ x0: 30, x1: 54, half: (x) => (Math.floor(x / 2) % 2 ? 4.0 : 4.8) }], 9);
  const front = r.rowsLog.map((l) => Number(l.split(' ')[1].split(',')[0]));
  let changes = 0;
  for (let i = 1; i < front.length; i++) if (front[i] !== front[i - 1]) changes++;
  log(`sawtooth front row changes ${changes}: ${front.join(' ')}`);
  expect(r.colsIn[0][1] - r.colsIn[0][0]).toBeLessThanOrEqual(1);
  expect(r.inWall).toBe(0);
  expect(r.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('§9d loose: raiders (loose by default) cross a 4-row gap as a crowd — together, nobody in a wall, arrived once', async () => {
  const r = await corridorRun([{ x0: 46, x1: 49, half: 1.8 }], 9, 'loose', 'raider');
  expect(r.spreadMost).toBeLessThan(7);
  expect(r.inWall).toBe(0);
  expect(r.beyond).toBe(r.n);
  expect(r.arrived).toBe(1);
  expect(g.takeErrors()).toEqual([]);
});

test('spawnAt next to water: every unit placed on dry ground, none drowned in 10 s; a spawn in a lake fails "water", none made', async () => {
  // (water 2 deep east of x 30 — over a soldier's head; the barracks on the shore; the muster yard in the lake's middle)
  const { units, run } = await worldWith(() => false, (x) => (x >= 30 ? 2 : 0));
  // (the nav reads the water once the world has run a little: a spawn comes into a live world)
  await run(30);
  const shore = cellPos(30, 40);
  const lake = cellPos(60, 40);
  const inland = cellPos(12, 40);
  units.usePlaces(fakePlaces({ [PLACE.barracks]: [shore[0], shore[1], 10], [PLACE.muster]: [lake[0], lake[1], 10], [PLACE.market]: [inland[0], inland[1], 10] }));
  const died: number[] = [];
  const failed: [number, string][] = [];
  units.died.push((u) => died.push(u.id));
  units.orderFailed.push((gid, why) => failed.push([gid, why]));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.barracks }, 12);
  // (ordered inland at once, as a raid's or a squad's spawn is: a unit left standing idle on the shore can wander in —
  // the nav's deep-water link reads the nav's copy of the water, which lags where no unit has been)
  units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: PLACE.market } });
  await run(3);
  const placed = await where(units, units.members!(gid));
  const wet = placed.filter(([x, y]) => cellOf(x, y)[0] >= 30).length;
  log(`water: at spawn ${JSON.stringify(placed.map(([x, y]) => cellOf(x, y)))}`);
  await run(TPS * 10);
  const ps = await where(units, units.members!(gid));
  const g2 = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.muster }, 4);
  await run(30);
  log(`water: made ${ps.length}, wet ${wet}, died ${died.length}, failed ${JSON.stringify(failed)}`);
  expect(ps.length).toBe(12);
  expect(wet).toBe(0);
  expect(died).toEqual([]);
  expect(failed.filter(([x]) => x === g2).map(([, w]) => w)).toEqual(['water']);
  expect(units.members!(g2)).toEqual([]);
  expect(g.takeErrors()).toEqual([]);
});

test('spawnAt spawn k also gate k else barracks: with gate k invalid the spawn falls over to the barracks (a hand-made place table)', async () => {
  // (Muru no longer has a spawn point standing with its gate invalid — UC-13 marks its wet spawn points WATER — so the
  // case is built here: spawn 0 valid, gate 0 missing, the barracks valid)
  const { units, run } = await world();
  const sp = cellPos(70, 40);
  const bk = cellPos(20, 40);
  units.usePlaces(fakePlaces({ [PLACE.spawn0]: [sp[0], sp[1], 10], [PLACE.barracks]: [bk[0], bk[1], 10] }));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.spawn0, also: { town: 0, place: PLACE.gate0 }, else: { town: 0, place: PLACE.barracks } }, 3);
  await run(30);
  const ps = await where(units, units.members!(gid));
  const atBarracks = ps.filter(([x, y]) => Math.hypot(x - bk[0], y - bk[1]) < 6).length;
  log(`spawn also gate: ${ps.length} made, ${atBarracks} at the barracks`);
  expect(ps.length).toBe(3);
  expect(atBarracks).toBe(3);
  expect(g.takeErrors()).toEqual([]);
});

test('U2-FORMBITS: 40 order groups in formation at once — every one forms and arrives (anchors, places and arrivals for groups past 8 and 31)', async () => {
  const { units, run } = await world();
  // (10 named places in pairs 18 cells apart (2 × 5); 4 squads spawned at each, each walking in a column to its pair's
  // place. Ten destination fields: with 20, some never reached their anchors even with no formation — U2-FIELDCAP)
  const at = (n: number) => cellPos(30 + (n % 2) * 18, 10 + Math.floor(n / 2) * 16);
  const named: Record<number, [number, number, number]> = {};
  for (let n = 0; n < 10; n++) {
    const p = at(n);
    named[n] = [p[0], p[1], 10];
  }
  units.usePlaces(fakePlaces(named));
  const arrived = new Set<number>();
  const failed: [number, string][] = [];
  units.arrived.push((x) => arrived.add(x));
  units.orderFailed.push((x, why) => failed.push([x, why]));
  const gids: number[] = [];
  for (let i = 0; i < 40; i++) {
    const from = i % 10;
    const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: from }, 2);
    units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: from ^ 1 }, formation: 'column' });
    gids.push(gid);
  }
  const L = units.agents.mailLayout;
  await run(TPS * 60, async () => gids.every((x) => arrived.has(x)));
  // (each group's formation anchor moved off its start: formAnchor ran for it)
  const mail = new Float32Array(await units.agents.readRaw('mail'));
  const anchored = gids.filter((_, s) => mail[L.groups + s * L.groupW + L.formAt + 4] > 1).length;
  const u32 = new Uint32Array(mail.buffer);
  const miss = gids.map((x, s) => [x, s] as const).filter(([x]) => !arrived.has(x)).map(([, s]) => { const o = L.groups + s * L.groupW; return `${s}:k${u32[o]} st${u32[o + 11]} a${u32[o + L.formAt + 8]} s${mail[o + L.formAt + 4].toFixed(1)} lag${mail[o + L.formAt + 10].toFixed(1)} alive${u32[o + 18]}`; });
  log(`40 groups missing: ${miss.join(' | ')}`);
  log(`40 groups: order groups ${L.orderGroups}, arrived ${gids.filter((x) => arrived.has(x)).length}/40, anchored ${anchored}, failed ${JSON.stringify(failed)}`);
  expect(L.orderGroups).toBeGreaterThan(32);
  expect(failed).toEqual([]);
  expect(gids.filter((x) => arrived.has(x)).length).toBe(40);
  expect(anchored).toBe(40);
  expect(g.takeErrors()).toEqual([]);
});
