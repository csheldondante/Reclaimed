// (U2-FIELDREACH) An order's field takes pages only round its seed and the members walking it (fieldseam.wgsl's want
// box), so many squads going to many places fit the pool: 40 groups to 40 destinations on a 320 x 320 map arrive with
// a handful of pages a field and no refusals. The riskiest case first: the shortest way leaves the box (a U round a
// wall between the members and the place) — the box grows until the field reaches them; never a silent FAR.
//   FIELD_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { cellPos } from '../../src/world/lattice';
import { TOWN_ROOM } from '../../src/api/contracts/townplaces';
import type { PlaceRef } from '../../src/api/contracts/units';
import { TOWN_WORDS } from '../../src/towncontracts/contracts';
import type { AgentUnits } from '../../src/units/agent-units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const TPS = 60;
const LOG = process.env.FIELD_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

/** a stand-in place table in townplace.wgsl's layout (as fieldcap.test.ts): named places 0-22 */
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

async function world(W: number, H: number, walled: (x: number, y: number) => boolean = () => false) {
  const map = tinyMap(W, H, 32, (x: number, y: number) => [{ z0: 0, z1: walled(x, y) ? 22 : 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  // (the whole map in the fields' scope: the box, not the scope, is what bounds a field here)
  agents.keepInScope('test', [cellPos(0, 0), cellPos(W - 1, H - 1)]);
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
  return { units, run, slots: (W / 16) * (H / 16) };
}

/** each field's pages held */
async function held(units: AgentUnits, fields: number[]) {
  const pool = units.agents.fields;
  const { ctl } = await pool.readAll();
  return fields.map((f) => {
    let n = 0;
    for (let s = 0; s < pool.o.slots; s++) if (pool.pageOf(ctl, f, s)) n++;
    return n;
  });
}

/** field f's want box (fieldseam.wgsl FW_*: world chunks x0, y0, x1, y1) and its growth */
async function boxOf(units: AgentUnits, f: number) {
  const pool = units.agents.fields;
  const { ctl } = await pool.readAll();
  const o = pool.layout.og + f * 10;
  return `${[...ctl.subarray(o, o + 4)].map((v) => v - 16384).join(',')} grown ${ctl[o + 8]}`;
}

/** the order groups' fields (group word 6) */
async function fieldsOf(units: AgentUnits, n: number) {
  const L = units.agents.mailLayout;
  const mail = new Uint32Array(await units.agents.readRaw('mail'));
  return Array.from({ length: n }, (_, s) => mail[L.groups + s * L.groupW + 6]);
}

test('U2-FIELDREACH: a U round a wall (the way leaves the members-and-place box) — the field grows round it, they arrive', async () => {
  // (a cup: a wall across between the place (above) and the members (inside, below), its arms running down 74 cells —
  // the way out of the cup goes down past the arms' ends and back up round one of them)
  const W = 192;
  const cup = (x: number, y: number) => (y >= 96 && y <= 98 && x >= 40 && x <= 152) || (((x >= 40 && x <= 42) || (x >= 150 && x <= 152)) && y >= 96 && y <= 170);
  const { units, run, slots } = await world(W, W, cup);
  const place = cellPos(96, 80);
  const start = cellPos(96, 120);
  units.usePlaces(fakePlaces({ 0: [place[0], place[1], 10], 1: [start[0], start[1], 10] }));
  const arrived = new Set<number>();
  const failed: [number, string][] = [];
  units.arrived.push((x) => arrived.add(x));
  units.orderFailed.push((x, why) => failed.push([x, why]));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: 1 }, 3);
  units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: 0 } });
  const trace: string[] = [];
  let frames = 0;
  const took = await run(TPS * 120, async () => {
    if (++frames % 60 === 0) {
      const [f] = await fieldsOf(units, 1);
      trace.push(`t${frames / TPS}: pages ${(await held(units, [f]))[0]} box ${await boxOf(units, f)}`);
    }
    return arrived.has(gid) || failed.length > 0;
  });
  const [f] = await fieldsOf(units, 1);
  const pages = (await held(units, [f]))[0];
  log(`U detour (192 x 192, ${slots} chunks): arrived ${arrived.has(gid)} in ${(took / TPS).toFixed(1)} s, failed ${JSON.stringify(failed)}, pages ${pages}\n  ${trace.join('\n  ')}`);
  expect(failed).toEqual([]);
  expect(arrived.has(gid)).toBe(true);
  expect(pages).toBeLessThan(slots);
  expect(g.takeErrors()).toEqual([]);
});

test('U2-FIELDREACH: a deep cup (the way round 9 chunks past the box) — the field grows a ring at a time until it reaches the members, never left FAR', async () => {
  const W = 256;
  const cup = (x: number, y: number) => (y >= 96 && y <= 98 && x >= 40 && x <= 216) || (((x >= 40 && x <= 42) || (x >= 214 && x <= 216)) && y >= 96 && y <= 236);
  const { units, run, slots } = await world(W, W, cup);
  const place = cellPos(128, 80);
  const start = cellPos(128, 120);
  units.usePlaces(fakePlaces({ 0: [place[0], place[1], 10], 1: [start[0], start[1], 10] }));
  const failed: [number, string][] = [];
  units.orderFailed.push((x, why) => failed.push([x, why]));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: 1 }, 3);
  units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: 0 } });
  let reached = -1;
  const took = await run(TPS * 10, async () => {
    const [f] = await fieldsOf(units, 1);
    if (f === 0xffffffff) return;
    const rd = units.agents.reader(f);
    await rd.refresh();
    const s = rd.sample(start[0], start[1]);
    if (s && s.dist < 1e8) reached = s.dist;
    return reached >= 0;
  });
  const [f] = await fieldsOf(units, 1);
  const pages = (await held(units, [f]))[0];
  log(`deep cup (256 x 256, ${slots} chunks): the members reached after ${took} frames at ${reached.toFixed(0)}, box ${await boxOf(units, f)}, pages ${pages}, failed ${JSON.stringify(failed)}`);
  expect(failed).toEqual([]);
  // (the way: down the cup 116, round an arm's end, up 156 and across: over 300)
  expect(reached).toBeGreaterThan(300);
  expect(pages).toBeLessThan(slots);
  expect(g.takeErrors()).toEqual([]);
});

test('U2-FIELDREACH: 40 groups to 40 destinations on a 320 x 320 map — all arrive, a few pages a field, none refused', async () => {
  const W = 320;
  const { units, run, slots } = await world(W, W);
  // (20 places on a 4 x 5 grid 80 x 64 apart; a group goes from one to its neighbour across (80 cells): 40 keys — each named with
  // one of two else-places — 40 fields seeded at once)
  const at = (n: number) => (n < 20 ? cellPos(40 + (n % 4) * 80, 32 + Math.floor(n / 4) * 64) : cellPos(8, n === 20 ? 8 : 312));
  const named: Record<number, [number, number, number]> = {};
  for (let n = 0; n < 22; n++) {
    const p = at(n);
    named[n] = [p[0], p[1], 10];
  }
  units.usePlaces(fakePlaces(named));
  const arrived = new Set<number>();
  const failed: [number, string][] = [];
  units.arrived.push((x) => arrived.add(x));
  units.orderFailed.push((x, why) => failed.push([x, why]));
  const gids: number[] = [];
  const to = (i: number): PlaceRef => ({ town: 0, place: (i % 20) ^ 1, else: { town: 0, place: 20 + (i < 20 ? 0 : 1) } });
  for (let i = 0; i < 40; i++) {
    const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: i % 20 }, 2);
    units.orderGroup!(gid, { kind: 'go', at: to(i) });
    gids.push(gid);
  }
  let frames = 0;
  let peak = 0;
  const trace: string[] = [];
  await run(TPS * 60, async () => {
    if (++frames % 60 === 0) {
      const fs = [...new Set(await fieldsOf(units, 40))].filter((f) => f !== 0xffffffff);
      const h = await held(units, fs);
      const st = await units.agents.fields.stats();
      peak = Math.max(peak, st.used);
      trace.push(`t${frames / TPS}: used ${st.used}/${st.pages} refused ${st.refused} pages a field ${Math.min(...h)}-${Math.max(...h)} (mean ${(h.reduce((a, b) => a + b, 0) / h.length).toFixed(1)}) arrived ${arrived.size}`);
    }
    return gids.every((x) => arrived.has(x) || failed.some(([f]) => f === x));
  });
  const fs = [...new Set(await fieldsOf(units, 40))].filter((f) => f !== 0xffffffff);
  const h = await held(units, fs);
  const st = await units.agents.fields.stats();
  peak = Math.max(peak, st.used);
  const mean = h.reduce((a, b) => a + b, 0) / h.length;
  log(`40 groups to 40 destinations (320 x 320, ${slots} chunks): fields ${fs.length}, arrived ${arrived.size}, failed ${failed.length}, refused ${st.refused}, pages a field ${Math.min(...h)}-${Math.max(...h)} (mean ${mean.toFixed(1)}), peak ${peak} of ${st.pages}\n  ${trace.join('\n  ')}`);
  expect(fs.length).toBe(40);
  expect(failed).toEqual([]);
  expect(st.refused).toBe(0);
  expect(arrived.size).toBe(40);
  // (a field's box: its place and its members' start, 80 cells apart, a chunk round them — not the window's 400)
  expect(Math.max(...h)).toBeLessThan(slots / 8);
  expect(g.takeErrors()).toEqual([]);
});
