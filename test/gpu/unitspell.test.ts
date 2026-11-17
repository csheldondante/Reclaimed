// (loop round 10, BACKLOG LS-94) Spells on the units in an area, on the GPU (agents/notice.ts spellArea,
// shaders/unitspell.wgsl, notice.wgsl SP_*): hidden — no foe takes it on (a hunter lets it go) and it is not drawn;
// berserk — two of one side that never fought turn on each other; setSide — a peaceful one that never looked joins a
// side and hunts. The area and the filter decide who: nothing is read back to choose.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import type { Agents } from '../../src/agents/agents';
import { BERSERK_SIDE, type CombatSpec } from '../../src/agents/notice';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const UF = 24;

async function world() {
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 28 });
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  return { agents, frame };
}

const slotOf = (id: number) => id % 8192;

async function targets(agents: Agents) {
  const u = new Uint32Array(await agents.readRaw('units'));
  return (id: number) => u[slotOf(id) * UF + 21];
}

test('hidden: a hunter lets its target go and takes no hidden one; the spell is the area\'s', async () => {
  const { agents, frame } = await world();
  const [hunter] = agents.spawn(1, 40, 50, { spread: 0 });
  const [a] = agents.spawn(1, 46, 50, { spread: 0 });
  const [b] = agents.spawn(1, 80, 50, { spread: 0 });
  frame(30);
  agents.notice.set(slotOf(hunter), { faction: 1, hostile: true, sight: 60 });
  const folk: CombatSpec = { faction: 2, hostile: false, sight: 0 };
  agents.notice.set(slotOf(a), folk);
  agents.notice.set(slotOf(b), folk);
  frame(1);
  let t = await targets(agents);
  expect(t(hunter), 'the nearer one').toBe(a + 1);
  // (a hidden round a: the hunter lets it go and takes b, out of the spell's reach)
  agents.notice.spellArea({ x: 46, y: 50, radius: 3, who: 'friends', hidden: true }, agents.size);
  frame(1);
  t = await targets(agents);
  expect(t(hunter), 'the one not hidden').toBe(b + 1);
  // (the filter: 'foes' over b takes no one — b is no foe)
  agents.notice.spellArea({ x: 80, y: 50, radius: 3, who: 'foes', hidden: true }, agents.size);
  frame(1);
  t = await targets(agents);
  expect(t(hunter)).toBe(b + 1);
  // (shown again: taken again, the nearer)
  agents.notice.spellArea({ x: 46, y: 50, radius: 3, who: 'any', hidden: false }, agents.size);
  agents.notice.set(slotOf(hunter), { faction: 1, hostile: true, sight: 60 });
  agents.notice.aim(slotOf(hunter), 0);
  frame(2);
  t = await targets(agents);
  expect(t(hunter)).toBe(a + 1);
  expect(g.takeErrors()).toEqual([]);
});

test('berserk: two of one side turn on each other; setSide: one who never looked hunts', async () => {
  const { agents, frame } = await world();
  const [x] = agents.spawn(1, 40, 60, { spread: 0 });
  const [y] = agents.spawn(1, 44, 60, { spread: 0 });
  const [far] = agents.spawn(1, 100, 60, { spread: 0 });
  const [walker] = agents.spawn(1, 100, 20, { spread: 0 });
  const [other] = agents.spawn(1, 106, 20, { spread: 0 });
  frame(30);
  const raider: CombatSpec = { faction: 1, hostile: true, sight: 20 };
  agents.notice.set(slotOf(x), raider);
  agents.notice.set(slotOf(y), raider);
  agents.notice.set(slotOf(far), raider);
  agents.notice.set(slotOf(walker), { faction: 2, hostile: false, sight: 0 });
  agents.notice.set(slotOf(other), { faction: 2, hostile: false, sight: 0 });
  frame(1);
  let t = await targets(agents);
  expect([t(x), t(y)], 'one side: nobody to fight').toEqual([0, 0]);
  agents.notice.spellArea({ x: 42, y: 60, radius: 6, who: 'foes', side: BERSERK_SIDE, all: true, sight: 24 }, agents.size);
  frame(1);
  t = await targets(agents);
  expect(t(x), 'x on y').toBe(y + 1);
  expect(t(y), 'y on x').toBe(x + 1);
  expect(t(far), 'out of the spell\'s reach').toBe(0);
  // (setSide: the walker joins side 3 and hunts — the nearest of another side, its old fellow)
  agents.notice.spellArea({ x: 100, y: 20, radius: 2, who: 'friends', side: 3, sight: 24 }, agents.size);
  frame(1);
  t = await targets(agents);
  expect(t(walker)).toBe(other + 1);
  expect(g.takeErrors()).toEqual([]);
});
