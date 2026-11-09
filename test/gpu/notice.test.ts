// (round 128p, DA-B22 (c)(3)) Combat targeting on the GPU (agents/notice.ts, shaders/notice.wgsl): each hunter's
// target is the nearest unit it may fight within its sight — the ring search over the buckets matches a brute-force
// reference over every unit — and the game's rules hold: factions, sides of the wall (and open), posts, the no-fight,
// height; a target is kept while allowed and let go past the leash; a new one is told as a `noticed` event.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import type { Agents, AgentEvent } from '../../src/agents/agents';
import { NO_FACTION, type CombatSpec } from '../../src/agents/notice';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const UF = 24;

async function world(col?: (x: number, y: number) => { z0: number; z1: number; mat: number }[]) {
  const map = tinyMap(W, W, 32, col ?? (() => [{ z0: 0, z1: 10, mat: MAT.Stone }]));
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 28 });
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  return { agents, frame };
}

const slotOf = (id: number) => id % 8192;

async function state(agents: Agents) {
  const u = new Float32Array(await agents.readRaw('units'));
  const w = new Uint32Array(u.buffer);
  return {
    pos: (id: number) => [u[slotOf(id) * UF], u[slotOf(id) * UF + 1], u[slotOf(id) * UF + 2]] as const,
    target: (id: number) => w[slotOf(id) * UF + 21],
    hunted: (id: number) => u[slotOf(id) * UF + 22],
  };
}

/** a seeded random */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('the ring search finds what a brute force over every unit finds', async () => {
  const { agents, frame } = await world();
  const r = rnd(7);
  const specs = new Map<number, CombatSpec>();
  const ids: number[] = [];
  for (let i = 0; i < 400; i++) {
    const [id] = agents.spawn(1, 8 + r() * 110, 8 + r() * 95, { spread: 0 });
    ids.push(id);
  }
  // (on their feet, nobody looking yet)
  frame(30);
  for (const id of ids) {
    const hostile = r() < 0.3;
    const spec: CombatSpec = { faction: Math.floor(r() * 3), hostile, guard: !hostile && r() < 0.3, sight: hostile || r() < 0.3 ? 5 + r() * 40 : 0 };
    specs.set(id, spec);
    agents.notice.set(slotOf(id), spec);
  }
  frame(1);
  const s = await state(agents);
  let checked = 0;
  for (const h of ids) {
    const hs = specs.get(h)!;
    if (!(hs.hostile || hs.guard) || hs.sight <= 0) continue;
    const p = s.pos(h);
    let best = hs.sight;
    let want = 0;
    for (const x of ids) {
      if (x === h) continue;
      const xs = specs.get(x)!;
      const foe = hs.hostile ? !xs.hostile && xs.faction !== hs.faction : xs.hostile;
      if (!foe) continue;
      const q = s.pos(x);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) {
        best = d;
        want = x + 1;
      }
    }
    expect(s.target(h), `hunter ${h}`).toBe(want);
    checked++;
  }
  expect(checked).toBeGreaterThan(100);
  // (the hunt's candidates: each unit's distance to the nearest hostile with a target that may fight it within its
  // sight — or whose target it is)
  let marked = 0;
  for (const x of ids) {
    const xs = specs.get(x)!;
    const q = s.pos(x);
    let want = Infinity;
    for (const h of ids) {
      const hs = specs.get(h)!;
      if (h === x || !hs.hostile || s.target(h) === 0) continue;
      const p = s.pos(h);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if ((!xs.hostile && xs.faction !== hs.faction && d < hs.sight) || s.target(h) === x + 1) want = Math.min(want, d);
    }
    if (want < Infinity) marked++;
    expect(s.hunted(x), `hunted ${x}`).toBeCloseTo(want === Infinity ? Infinity : want, 4);
  }
  expect(marked).toBeGreaterThan(50);
  expect(g.takeErrors()).toEqual([]);
});

test('the rules: sides, open, posts, no-fight, height; leash; noticed told once', async () => {
  // (a step 4 high across x 60-63: the raider below, a defender up on it)
  const { agents, frame } = await world((x) => [{ z0: 0, z1: x >= 60 && x < 64 ? 14 : 10, mat: MAT.Stone }]);
  const [raider] = agents.spawn(1, 40, 50, { spread: 0 });
  const [near] = agents.spawn(1, 44, 50, { spread: 0 });
  const [up] = agents.spawn(1, 61.5, 52, { spread: 0 });
  frame(30);
  const hostile: CombatSpec = { faction: 1, hostile: true, raider: true, sight: 40 };
  const peaceful: CombatSpec = { faction: 2, hostile: false, sight: 0 };
  agents.notice.set(slotOf(raider), hostile);
  agents.notice.set(slotOf(near), peaceful);
  agents.notice.set(slotOf(up), peaceful);
  // (sides: x < 42 out, the rest in — the raider out, both foes in)
  const sides = new Uint32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) sides[y * W + x] = x < 42 ? 1 : 2;
  agents.notice.setSides(sides);
  agents.notice.setRules({ on: true, open: false, heightLimit: 1.6, leash: 28 });
  frame(1);
  let s = await state(agents);
  expect(s.target(raider), 'across the wall: no one').toBe(0);
  // (the wall broken: the nearer, on its ground)
  agents.notice.setRules({ on: true, open: true, heightLimit: 1.6, leash: 28 });
  frame(1);
  s = await state(agents);
  expect(s.target(raider)).toBe(near + 1);
  const { events } = await agents.sync();
  expect(events.filter((e: AgentEvent) => e.type === 'noticed' && e.id === raider).map((e) => (e as { target: number }).target)).toEqual([near + 1]);
  // (the near one in at home: not fought; the one up on the step too high to reach)
  agents.notice.set(slotOf(near), { ...peaceful, noFight: true });
  frame(1);
  s = await state(agents);
  expect(s.target(raider), 'in at home, and the other up high').toBe(0);
  // (a height limit past the step: the one up on it)
  agents.notice.setRules({ on: true, open: true, heightLimit: 10, leash: 28 });
  frame(1);
  s = await state(agents);
  expect(s.target(raider)).toBe(up + 1);
  // (a posted defender never takes anyone on; given a target by the game it's let go)
  const [archer] = agents.spawn(1, 41, 54, { spread: 0 });
  frame(20);
  agents.notice.setRules({ on: true, open: true, heightLimit: 1.6, leash: 28 });
  agents.notice.set(slotOf(archer), { faction: 2, hostile: false, guard: true, posted: true, sight: 30 });
  agents.notice.aim(slotOf(archer), raider + 1);
  frame(1);
  s = await state(agents);
  expect(s.target(archer), 'posted').toBe(0);
  // (unposted and given the raider, a guard with its post far off: past the leash from its post, let go — a guard
  // that doesn't look, so it isn't taken again at once, as the CPU's guards weren't either: they look again next sync)
  agents.notice.set(slotOf(archer), { faction: 2, hostile: false, guard: true, sight: 0, home: [100, 100] });
  agents.notice.aim(slotOf(archer), raider + 1);
  frame(1);
  s = await state(agents);
  expect(s.target(archer), 'past its leash').toBe(0);
  agents.notice.set(slotOf(archer), { faction: 2, hostile: false, guard: true, sight: 0, home: [41, 54] });
  agents.notice.aim(slotOf(archer), raider + 1);
  frame(2);
  s = await state(agents);
  expect(s.target(archer), 'kept within its leash').toBe(raider + 1);
  // (no faction: the same rule as a faction of its own — a hostile of no faction hunts the peaceful of any)
  agents.notice.set(slotOf(raider), { ...hostile, faction: NO_FACTION });
  frame(1);
  s = await state(agents);
  expect(s.target(raider)).not.toBe(0);
  expect(g.takeErrors()).toEqual([]);
});
