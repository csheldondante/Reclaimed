// (knight pass 2, round 128) The guard and the lunger on Dawn: the real agents' step and the trait system's caps, on a
// tiny flat world. The user: "add some enemies that dodge or block except when winding up to hit. Or where you have to
// wait until after they lung and then stay stunned a moment to get your hit in or else they dodge or block."
//   the guard   a hit is blocked (no damage, a 'blocked' event) but in its wind-up, when it lands; and from above
//   the lunger  a hit is dodged (a sidestep) while it stands, crouches or flies; once its lunge is down, it lands
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import type { Agents, AgentEvent, AgentState } from '../../src/agents/agents';
import { installTraits } from '../../src/traits/install';
import { registerSlice } from '../../src/game/traits/modules';
import { GUARDS } from '../../src/units/agent-units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
const DT = 1 / 60;
/** a hunting group following the targets' field (as AgentUnits' hunt) */
const HUNT = 6;
const FIELD = 7;

interface World {
  agents: Agents;
  /** step n ticks (a sync every tick: the windows are a few ticks wide), the units now and the events since the last */
  step(n: number): Promise<{ units: Map<number, AgentState>; events: AgentEvent[] }>;
  t(): number;
}

async function world(): Promise<World> {
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const traits = installTraits(w.core, agents);
  registerSlice(traits);
  agents.defineKind(7, GUARDS.blocker);
  agents.defineKind(1, GUARDS.lunger);
  traits.kindTraits(7, ['living', 'guarded']);
  traits.kindTraits(1, ['living', 'evasive']);
  agents.follow(HUNT, FIELD);
  let ticks = 0;
  const events: AgentEvent[] = [];
  let units = new Map<number, AgentState>();
  const step = async (n: number) => {
    for (let i = 0; i < n; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'traits' || s.name === 'agents');
      ticks++;
      const r = await agents.sync();
      units = new Map(r.units.map((u) => [u.id, u]));
      events.push(...r.events);
    }
    await g.device.queue.onSubmittedWorkDone();
    expect(g.takeErrors()).toEqual([]);
    return { units, events: events.splice(0) };
  };
  return { agents, step, t: () => ticks * DT };
}

/** a blow on unit u where it stands (as the knight's: a small circle on it, a shove along x) */
const blow = (a: Agents, u: AgentState, overhead = false) => a.hit({ x: u.x, y: u.y, z: u.z + 0.7, radius: 0.6, damage: 3, push: 7.8, dir: [1, 0], lift: 2, stun: 0.25, overhead });
const hurtOf = (ev: AgentEvent[], id: number) => ev.filter((e) => e.type === 'hurt' && e.id === id);
const turnedOf = (ev: AgentEvent[], id: number) => ev.filter((e): e is Extract<AgentEvent, { type: 'blocked' }> => e.type === 'blocked' && e.id === id);

test('the guard blocks a blow while it stands; in its wind-up the blow lands; from above it lands', async () => {
  const { agents, step } = await world();
  const [gd] = agents.spawn(1, 20, 20, { kind: 7, group: HUNT, spread: 0 });
  // (6 ticks: the traits' kind seed and the caps reach it)
  let r = await step(6);
  const u0 = r.units.get(gd)!;
  blow(agents, u0);
  r = await step(3);
  expect(hurtOf(r.events, gd)).toHaveLength(0);
  const b = turnedOf(r.events, gd);
  expect(b).toHaveLength(1);
  expect(b[0].dodged).toBe(false);
  expect(r.units.get(gd)!.hp).toBeCloseTo(u0.hp, 3);
  // (its shove back off the shield is a step, never a throw: it stays on its feet, so it stays shut)
  expect(r.units.get(gd)!.state).not.toBe('tumble');
  // a target in its reach: it winds up (0.7 s); a blow early in the wind-up lands
  const at = r.units.get(gd)!;
  agents.setTargets([{ x: at.x + 1.2, y: at.y, z: at.z, radius: 0.4, height: 1.6 }], FIELD);
  let wound: AgentEvent | undefined;
  for (let i = 0; i < 90 && !wound; i++) {
    r = await step(1);
    wound = r.events.find((e) => e.type === 'windup' && e.id === gd);
  }
  expect(wound).toBeDefined();
  expect((wound as Extract<AgentEvent, { type: 'windup' }>).lands).toBeCloseTo(GUARDS.blocker.windup, 3);
  r = await step(6);
  blow(agents, r.units.get(gd)!);
  r = await step(3);
  expect(hurtOf(r.events, gd)).toHaveLength(1);
  expect(turnedOf(r.events, gd)).toHaveLength(0);
  // knocked down by it, then up again: shut again — and from above, a blow lands even so
  agents.setTargets([], -1);
  agents.seed(FIELD, []);
  r = await step(150);
  const up = r.units.get(gd)!;
  expect(up.state).not.toBe('tumble');
  blow(agents, up);
  r = await step(3);
  expect(turnedOf(r.events, gd)).toHaveLength(1);
  r = await step(30);
  blow(agents, r.units.get(gd)!, true);
  r = await step(3);
  expect(hurtOf(r.events, gd)).toHaveLength(1);
});

test('the lunger dodges while it stands and while it lunges; down after its lunge, a blow lands', async () => {
  const { agents, step } = await world();
  const [ln] = agents.spawn(1, 20, 20, { kind: 1, group: HUNT, spread: 0 });
  let r = await step(6);
  const u0 = r.units.get(ln)!;
  blow(agents, u0);
  r = await step(3);
  const d = turnedOf(r.events, ln);
  expect(d).toHaveLength(1);
  expect(d[0].dodged).toBe(true);
  expect(hurtOf(r.events, ln)).toHaveLength(0);
  // (a sidestep: across the blow, which pushed along +x)
  r = await step(20);
  const side = r.units.get(ln)!;
  expect(Math.abs(side.y - u0.y)).toBeGreaterThan(0.25);
  // a target 3 cells off: it crouches (0.45 s), leaps — dodging a blow in flight — and lands past it
  const tgt = { x: side.x + 3, y: side.y, z: side.z, radius: 0.4, height: 1.6 };
  agents.setTargets([tgt], FIELD);
  let leapt = false;
  let flew = 0;
  let swung = false;
  let dodgedInFlight = false;
  for (let i = 0; i < 120; i++) {
    r = await step(1);
    const u = r.units.get(ln)!;
    if (r.events.some((e) => e.type === 'swing' && e.id === ln)) swung = true;
    if (turnedOf(r.events, ln).length) dodgedInFlight = true;
    if (!leapt && u.state === 'tumble') {
      leapt = true;
      blow(agents, u);
    }
    if (leapt) flew++;
    if (leapt && u.state === 'tumble' && Math.hypot(u.vx, u.vy, u.vz) < 0.3 && flew > 12) break;
  }
  expect(leapt).toBe(true);
  expect(dodgedInFlight).toBe(true);
  // (its blow landed on the target it leapt at, in flight)
  expect(swung).toBe(true);
  const down = r.units.get(ln)!;
  expect(down.x).toBeGreaterThan(tgt.x - 1);
  agents.setTargets([], -1);
  agents.seed(FIELD, []);
  // down a moment (it settled): a blow lands now
  r = await step(8);
  expect(r.units.get(ln)!.state).toBe('tumble');
  blow(agents, r.units.get(ln)!);
  r = await step(3);
  expect(hurtOf(r.events, ln)).toHaveLength(1);
});
