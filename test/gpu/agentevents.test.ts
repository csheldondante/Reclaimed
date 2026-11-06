// (round 128o, DA-B2) The agents' events as a ring read a window at a time (agents.ts sync, units.wgsl emit): more
// events in one tick than a sync reads come over the next syncs, none lost, none twice; more than the ring holds
// unread are counted lost, not read as old ones; a sync's read is its window (8 KB) and the units, not the 64 KB block.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { Agents, ROAD_FIELD, type AgentEvent } from '../../src/agents/agents';
import { graphOf } from '../../src/agents/roadgraph';
import { packRoadShapes } from '../../src/agents/roads';
import { installTraits } from '../../src/traits/install';
import { registerSlice } from '../../src/game/traits/modules';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
const MID: [number, number] = [32, 27];

async function world() {
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const traits = installTraits(w.core, agents, { corpseSeconds: 0 });
  registerSlice(traits);
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'traits' || s.name === 'agents');
  };
  return { agents, traits, tick };
}

test('600 deaths in one tick: read over three syncs, every one once', async () => {
  const { agents, traits, tick } = await world();
  const ids = agents.spawn(600, MID[0], MID[1], { spread: 10 });
  tick(4);
  await agents.sync();
  traits.apply({ op: 'damage', type: 'physical', amount: 100, at: MID, radius: 30 });
  tick(3);
  const events: AgentEvent[] = [];
  let syncs = 0;
  for (; syncs < 8; syncs++) {
    const r = await agents.sync();
    expect(r.dropped).toBe(0);
    events.push(...r.events);
    if (events.filter((e) => e.type === 'death').length >= 600) break;
  }
  const deaths = events.filter((e) => e.type === 'death').map((e) => e.id);
  expect(new Set(deaths).size).toBe(600);
  expect(deaths.length).toBe(600);
  expect(new Set(deaths)).toEqual(new Set(ids));
  // (256 a sync)
  expect(syncs).toBeGreaterThanOrEqual(2);
  // (nothing more to read)
  const after = await agents.sync();
  expect(after.events.filter((e) => e.type === 'death')).toEqual([]);
  expect(g.takeErrors()).toEqual([]);
});

test('more unread than the ring holds: the overflow counted lost, never read as old events', async () => {
  const { agents, traits, tick } = await world();
  // (the ring holds Agents.EVENT_CAP unread; one sync's window first, then one burst bigger than the ring)
  const n = Agents.EVENT_CAP + 300;
  agents.spawn(n, MID[0], MID[1], { spread: 14 });
  tick(4);
  await agents.sync();
  traits.apply({ op: 'damage', type: 'physical', amount: 100, at: MID, radius: 40 });
  tick(3);
  let deaths = 0;
  let lost = 0;
  for (let k = 0; k < 20; k++) {
    const r = await agents.sync();
    deaths += r.events.filter((e) => e.type === 'death').length;
    lost += r.dropped;
  }
  expect(deaths + lost).toBeGreaterThanOrEqual(n);
  expect(lost).toBeGreaterThan(0);
  expect(deaths).toBeLessThanOrEqual(Agents.EVENT_CAP);
  expect(g.takeErrors()).toEqual([]);
});

// ---- (round 128o, DA-B2a, DA-B2b) the engine's prerequisites for a game built on events ----

test('arrived: each unit told once when it comes within its field\'s radius, not again while it stands there', async () => {
  const { agents, tick } = await world();
  const ids = agents.spawn(10, 16, 20, { group: 1, spread: 2 });
  const goal = { x: 44, y: 30 };
  agents.seed(0, [goal]);
  agents.follow(1, 0);
  agents.arrivals(0, 3, 6);
  const arrived = new Map<number, AgentEvent & { type: 'arrived' }>();
  let twice = 0;
  for (let k = 0; k < 60 && arrived.size < ids.length; k++) {
    tick(30);
    for (const e of (await agents.sync()).events) {
      if (e.type !== 'arrived') continue;
      if (arrived.has(e.id)) twice++;
      arrived.set(e.id, e);
    }
  }
  expect([...arrived.keys()].sort()).toEqual([...ids].sort());
  expect(twice).toBe(0);
  for (const e of arrived.values()) {
    expect(e.field).toBe(0);
    expect(e.dist).toBeLessThanOrEqual(3);
    expect(Math.hypot(e.x - goal.x, e.y - goal.y)).toBeLessThan(6);
  }
  // (standing round the goal: nothing more)
  tick(120);
  expect((await agents.sync()).events.filter((e) => e.type === 'arrived')).toEqual([]);
  // (no arrivals asked for the field: none)
  agents.arrivals(0, 0);
  agents.seed(0, [{ x: 16, y: 20 }]);
  tick(600);
  expect((await agents.sync()).events.filter((e) => e.type === 'arrived')).toEqual([]);
  expect(g.takeErrors()).toEqual([]);
});

test("arrived on a ride: each rider told once, standing at its group's goal; not for a group it was moved to that tick", async () => {
  const { agents, tick } = await world();
  // (a road along y = 27 from x 8 to 56: two pieces meeting at x 32)
  const a: [number, number] = [8, 27];
  const m: [number, number] = [32, 27];
  const b: [number, number] = [56, 27];
  agents.setRoads(packRoadShapes([{ a, b, half: 1.2 }]), 0, 0);
  agents.setRoadGraph(graphOf([{ a, b: m, cell: 0, cost: 1 }, { a: m, b, cell: 1, cost: 1 }]), 0, 0);
  const G = 9;
  const ids = agents.spawn(4, 14, 27, { group: G, spread: 0.5 });
  expect(agents.ride(G, [[52, 27]])).toBe(true);
  agents.follow(G, ROAD_FIELD);
  const got: (AgentEvent & { type: 'arrived' })[] = [];
  for (let k = 0; k < 80 && new Set(got.map((e) => e.id)).size < ids.length; k++) {
    tick(30);
    for (const e of (await agents.sync()).events) if (e.type === 'arrived') got.push(e);
  }
  expect(new Set(got.map((e) => e.id))).toEqual(new Set(ids));
  // (once each, the ride's: its group, by the goal)
  expect(got.length).toBe(ids.length);
  for (const e of got) {
    expect(e.ride).toBe(G);
    expect(e.field).toBeUndefined();
    expect(Math.hypot(e.x - 52, e.y - 27)).toBeLessThan(2);
  }
  // (standing there: nothing more)
  tick(120);
  expect((await agents.sync()).events.filter((e) => e.type === 'arrived')).toEqual([]);
  // (moved to another riding group whose goal is elsewhere: no arrival for it until they stand at its goal)
  const H = 10;
  expect(agents.ride(H, [[12, 27]])).toBe(true);
  agents.follow(H, ROAD_FIELD);
  for (const id of ids) agents.regroup(id, H);
  tick(2);
  expect((await agents.sync()).events.filter((e) => e.type === 'arrived')).toEqual([]);
  const back: (AgentEvent & { type: 'arrived' })[] = [];
  for (let k = 0; k < 80 && back.length < ids.length; k++) {
    tick(30);
    for (const e of (await agents.sync()).events) if (e.type === 'arrived') back.push(e);
  }
  expect(back.map((e) => e.ride)).toEqual(ids.map(() => H));
  for (const e of back) expect(Math.hypot(e.x - 12, e.y - 27)).toBeLessThan(2);
  expect(g.takeErrors()).toEqual([]);
});

test('arrived on a ride from where it stands: sent to a goal it is already at (off the roads), it is told', async () => {
  const { agents, tick } = await world();
  const a: [number, number] = [8, 27];
  const b: [number, number] = [56, 27];
  agents.setRoads(packRoadShapes([{ a, b, half: 1.2 }]), 0, 0);
  agents.setRoadGraph(graphOf([{ a, b, cell: 0, cost: 1 }]), 0, 0);
  const G = 9;
  // (2.4 m off the road, at the goal: the field onto the roads would take it away first)
  const ids = agents.spawn(1, 12.3, 29.4, { group: G, spread: 0 });
  expect(agents.ride(G, [[12, 29]])).toBe(true);
  agents.follow(G, ROAD_FIELD);
  const got: AgentEvent[] = [];
  for (let k = 0; k < 6 && !got.length; k++) {
    tick(10);
    got.push(...(await agents.sync()).events.filter((e) => e.type === 'arrived'));
  }
  expect(got.map((e) => e.type === 'arrived' && e.ride)).toEqual([G]);
  expect(got[0].type === 'arrived' && got[0].id).toBe(ids[0]);
  expect(g.takeErrors()).toEqual([]);
});

test('watched: a sync reads only the units asked for, as a full sync has them', async () => {
  const { agents, tick } = await world();
  const ids = agents.spawn(40, MID[0], MID[1], { spread: 8 });
  tick(10);
  const all = await agents.sync();
  const watch = [ids[3], ids[17], ids[30]];
  const w = await agents.sync({ watch });
  expect(w.units.map((u) => u.id).sort()).toEqual([...watch].sort());
  for (const u of w.units) {
    const f = all.units.find((a) => a.id === u.id)!;
    expect([u.x, u.y, u.z]).toEqual([f.x, f.y, f.z]);
  }
  // (a watched unit that's gone is left out)
  agents.remove([ids[17]]);
  tick(2);
  const w2 = await agents.sync({ watch });
  expect(w2.units.map((u) => u.id).sort()).toEqual([ids[3], ids[30]].sort());
  expect(g.takeErrors()).toEqual([]);
});
