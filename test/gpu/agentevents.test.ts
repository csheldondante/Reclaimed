// (round 128o, DA-B2) The agents' events as a ring read a window at a time (agents.ts sync, units.wgsl emit): more
// events in one tick than a sync reads come over the next syncs, none lost, none twice; more than the ring holds
// unread are counted lost, not read as old ones; a sync's read is its window (8 KB) and the units, not the 64 KB block.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { Agents, type AgentEvent } from '../../src/agents/agents';
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
