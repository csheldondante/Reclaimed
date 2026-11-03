// (round 128, M128-6) Units.holdThreats on the real agents (AgentUnits over agents.wgsl/units.wgsl, Dawn): while the game
// holds the threats — a talk it put up over the play — raiders on the field don't close on the hero or land a blow;
// let go, they come on (the control: the test isn't vacuous).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { AgentUnits } from '../../src/units/agent-units';
import type { Actor, V3 } from '../../src/api/contracts/units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

test('held, raiders stand and strike nothing; let go, they close in', async () => {
  const W = 64;
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const units = new AgentUnits(agents);
  const at: V3 = [32, 27, 10];
  let hits = 0;
  const hero: Actor = { id: 'hero', faction: 'player', position: () => at, alive: () => true, hurt: () => void hits++ };
  units.watch(hero);
  const ids = [0, 1, 2].map((i) => units.spawn('raider', [at[0] + 6 + i, at[1] + 2 * i], 'raiders', { hostile: true, health: 10 }));
  const dt = 1 / 60;
  const run = async (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
      units.update(dt);
      await (units as unknown as { syncing: Promise<void> | null }).syncing;
    }
    await g.device.queue.onSubmittedWorkDone();
    expect(g.takeErrors()).toEqual([]);
  };
  const dist = () => Math.min(...ids.map((id) => {
    const u = units.get(id)!;
    return Math.hypot(u.at[0] - at[0], u.at[1] - at[1]);
  }));
  await run(10);
  const d0 = dist();
  units.holdThreats(true);
  await run(240);
  const held = dist();
  expect(hits, 'no blow lands while held').toBe(0);
  expect(held, `held: they stand (${d0.toFixed(2)} → ${held.toFixed(2)})`).toBeGreaterThan(d0 - 0.5);
  units.holdThreats(false);
  await run(240);
  const free = dist();
  expect(free, `let go: they close in (${held.toFixed(2)} → ${free.toFixed(2)})`).toBeLessThan(held - 2);
}, 120_000);
