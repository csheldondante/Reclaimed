// The trait system on Dawn (LW1): the core and the slice's rules over the real agents, on a tiny world. What a player
// would see, as numbers: a sanctuary heals the living and burns the undead; the fallen rise undead in the raiser's group
// keeping their kind; fire passes the fire_immune by; a petrified unit is rooted; a rule added later changes behaviour
// without the others being touched.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import type { Agents, AgentEvent, AgentState } from '../../src/agents/agents';
import { installTraits } from '../../src/traits/install';
import type { TraitSystem } from '../../src/traits/system';
import { registerSlice } from '../../src/game/traits/modules';
import { packTable } from '../../src/traits/registry';
import { traitMask } from '../../src/api/contracts/traits';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
const MID: [number, number] = [32, 27];

interface World {
  w: TinyWorld;
  agents: Agents;
  traits: TraitSystem;
  /** step n ticks, then a sync: the units and every event since the last */
  step(n: number): Promise<{ units: AgentState[]; events: AgentEvent[] }>;
}

async function world(corpseSeconds = 30): Promise<World> {
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const traits = installTraits(w.core, agents, { corpseSeconds });
  registerSlice(traits);
  const events: AgentEvent[] = [];
  const step = async (n: number) => {
    let units: AgentState[] = [];
    for (let i = 0; i < n; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'traits' || s.name === 'agents');
      // (a sync every few ticks, as a game does: the events buffer never fills)
      if (i % 8 === 7 || i === n - 1) {
        const r = await agents.sync();
        units = r.units;
        events.push(...r.events);
      }
    }
    await g.device.queue.onSubmittedWorkDone();
    expect(g.takeErrors()).toEqual([]);
    return { units, events: events.splice(0) };
  };
  return { w, agents, traits, step };
}

const byId = (us: AgentState[]) => new Map(us.map((u) => [u.id, u]));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

test('a healing field heals the living and harms the undead (hundreds at once)', async () => {
  const { traits, agents, step } = await world();
  const living = agents.spawn(150, MID[0], MID[1], { spread: 8 });
  const undead = agents.spawn(150, MID[0], MID[1], { spread: 8 });
  traits.assign(undead, ['undead']);
  // (64 assignments a tick)
  await step(6);
  // necrotic wounds the living (10 → 4) and mends the undead (they stay at 10)
  traits.apply({ op: 'damage', type: 'necrotic', amount: 6, at: MID, radius: 20 });
  let r = await step(2);
  let u = byId(r.units);
  expect(mean(living.map((id) => u.get(id)!.hp))).toBeCloseTo(4, 1);
  expect(mean(undead.map((id) => u.get(id)!.hp))).toBeCloseTo(10, 1);
  // a sanctuary: 2 hp/s for 2 s — the living to ~8, the undead lose 1.5 × as much (to ~4)
  const dt = 1 / 60;
  traits.apply({ op: 'heal', rate: 2, at: MID, radius: 20, seconds: 2 });
  r = await step(Math.round(2 / dt) + 2);
  u = byId(r.units);
  const lh = mean(living.map((id) => u.get(id)!.hp));
  const uh = mean(undead.map((id) => u.get(id)!.hp));
  expect(lh).toBeGreaterThan(7.5);
  expect(lh).toBeLessThanOrEqual(8.2);
  expect(uh).toBeGreaterThan(3.6);
  expect(uh).toBeLessThan(4.6);
  // nobody past their max, nobody dead
  expect(r.units.length).toBe(300);
  // the statuses the look shows: the living were healing, the undead harmed (read now: still within their glow)
  traits.apply({ op: 'heal', rate: 0.5, at: MID, radius: 20, seconds: 0.2 });
  await step(3);
  await traits.read();
  expect(traits.traitsOf(living[0])).toEqual(expect.arrayContaining(['living', 'healing']));
  expect(traits.traitsOf(undead[0])).toEqual(expect.arrayContaining(['undead', 'harmed']));
  expect(traits.traitsOf(undead[0])).not.toContain('healing');
});

test('raise turns the dead living into undead in the raiser\'s group, keeping their kind and id', async () => {
  const { traits, agents, step } = await world();
  const workers = agents.spawn(60, MID[0], MID[1], { spread: 6, group: 1 });
  const raiders = agents.spawn(30, MID[0], MID[1], { spread: 6, group: 2, kind: 'raider' });
  const walkers = agents.spawn(10, MID[0], MID[1], { spread: 6, group: 3 });
  traits.assign(walkers, ['undead']);
  await step(4);
  traits.apply({ op: 'damage', type: 'physical', amount: 100, at: MID, radius: 20 });
  let r = await step(4);
  expect(r.events.filter((e) => e.type === 'death').length).toBe(100);
  expect(r.units.length).toBe(0);
  expect(agents.corpseCount).toBe(100);
  await traits.read();
  expect(traits.traitsOf(workers[0])).toEqual(expect.arrayContaining(['living', 'corpse']));
  // the lich raises them into its group (9)
  traits.apply({ op: 'raise', group: 9, at: MID, radius: 20 });
  r = await step(4);
  const raised = r.events.filter((e) => e.type === 'raised');
  // the living rose; the walking dead (undead already) stayed down
  expect(raised.length).toBe(90);
  const u = byId(r.units);
  for (const id of workers) expect(u.get(id)?.kind).toBe('worker');
  for (const id of raiders) expect(u.get(id)?.kind).toBe('raider');
  for (const id of walkers) expect(u.get(id)).toBeUndefined();
  expect(r.units.every((x) => x.group === 9)).toBe(true);
  expect(r.units.every((x) => x.hp > 5 && x.hp < 7)).toBe(true);
  await traits.read();
  const t = traits.traitsOf(raiders[0])!;
  expect(t).toEqual(expect.arrayContaining(['undead', 'raised']));
  expect(t).not.toContain('living');
  expect(t).not.toContain('corpse');
  expect(agents.corpseCount).toBe(10);
});

test('corpses decay: their slots are freed for new units', async () => {
  const { traits, agents, step } = await world(1);
  agents.spawn(20, MID[0], MID[1], { spread: 4 });
  await step(3);
  traits.apply({ op: 'damage', type: 'physical', amount: 100, at: MID, radius: 20 });
  await step(4);
  expect(agents.corpseCount).toBe(20);
  const r = await step(70);
  expect(r.events.filter((e) => e.type === 'decayed').length).toBe(20);
  expect(agents.corpseCount).toBe(0);
  const size = agents.size;
  agents.spawn(20, MID[0], MID[1], { spread: 4 });
  expect(agents.size).toBe(size);
});

test('fire_immune ignores fire damage, and the world\'s fire', async () => {
  const { traits, agents, step } = await world();
  const plain = agents.spawn(40, MID[0], MID[1], { spread: 6 });
  const immune = agents.spawn(40, MID[0], MID[1], { spread: 6 });
  traits.assign(immune, ['fire_immune']);
  await step(4);
  traits.apply({ op: 'damage', type: 'fire', amount: 3, at: MID, radius: 20 });
  let r = await step(2);
  let u = byId(r.units);
  expect(mean(plain.map((id) => u.get(id)!.hp))).toBeCloseTo(7, 1);
  expect(mean(immune.map((id) => u.get(id)!.hp))).toBeCloseTo(10, 1);
  // set alight by a burning blow: the plain burn (2 hp/s), the immune never catch
  agents.hit({ x: MID[0], y: MID[1], radius: 20, fire: true });
  r = await step(60);
  u = byId(r.units);
  expect(plain.filter((id) => u.get(id)?.alight).length).toBeGreaterThan(30);
  expect(immune.filter((id) => u.get(id)?.alight).length).toBe(0);
  expect(mean(plain.map((id) => u.get(id)?.hp ?? 0))).toBeLessThan(6);
  expect(mean(immune.map((id) => u.get(id)!.hp))).toBeCloseTo(10, 1);
});

test('petrified: rooted — a blow that throws the others leaves the statues standing', async () => {
  const { traits, agents, step } = await world();
  const free = agents.spawn(30, MID[0] - 4, MID[1], { spread: 2 });
  const stone = agents.spawn(30, MID[0] + 4, MID[1], { spread: 2 });
  let r = await step(6);
  const before = byId(r.units);
  traits.apply({ op: 'status', status: 'petrified', lasts: 10, at: [MID[0] + 4, MID[1]], radius: 3.5 });
  await step(3);
  agents.hit({ x: MID[0], y: MID[1], radius: 20, push: 14, outward: true, lift: 6 });
  r = await step(20);
  const after = byId(r.units);
  const moved = (ids: number[]) => mean(ids.map((id) => Math.hypot(after.get(id)!.x - before.get(id)!.x, after.get(id)!.y - before.get(id)!.y)));
  expect(moved(free)).toBeGreaterThan(2);
  expect(moved(stone)).toBeLessThan(0.3);
});

test('a module added later changes behaviour without the others being touched (modularity)', async () => {
  const { traits, agents, step } = await world();
  const before = traits.modules().slice();
  const regen = agents.spawn(40, MID[0], MID[1], { spread: 6 });
  const plain = agents.spawn(40, MID[0], MID[1], { spread: 6 });
  traits.assign(regen, ['living', 'regenerating']);
  await step(4);
  traits.apply({ op: 'damage', type: 'physical', amount: 5, at: MID, radius: 20 });
  let r = await step(30);
  let u = byId(r.units);
  // no rule says what regenerating does yet: nothing
  expect(mean(regen.map((id) => u.get(id)!.hp))).toBeCloseTo(5, 1);
  // a new rule — regenerating units knit 3 hp/s — registered alone
  traits.register({
    name: 'regen',
    table: packTable([[{ u: traitMask(['regenerating']) }, 3]]),
    wgsl: `fn module_main(u: u32) {
  if (!uAlive(u) || !hasAll(tWord(u), MT[0].x)) { return; }
  setHp(u, min(uHp(u) + bitcast<f32>(MT[0].y) * G.dt, uMaxHp(u)));
}`,
  });
  expect(traits.modules().filter((n) => n !== 'regen')).toEqual(before);
  r = await step(60);
  u = byId(r.units);
  expect(mean(regen.map((id) => u.get(id)!.hp))).toBeGreaterThan(7.5);
  expect(mean(plain.map((id) => u.get(id)!.hp))).toBeCloseTo(5, 1);
  // the other rules still do as they did: a sanctuary heals the plain living as before
  traits.apply({ op: 'heal', rate: 2, at: MID, radius: 20, seconds: 1 });
  r = await step(62);
  u = byId(r.units);
  expect(mean(plain.map((id) => u.get(id)!.hp))).toBeCloseTo(7, 0);
  // and taken out again, it stops
  traits.unregister('regen');
  traits.apply({ op: 'damage', type: 'physical', amount: 5, at: MID, radius: 20 });
  r = await step(30);
  u = byId(r.units);
  expect(mean(regen.map((id) => u.get(id)!.hp))).toBeCloseTo(5, 1);
});

test('a sanctuary mends cracked structure through the structure system (the Mend event), with no agent about', async () => {
  const blk = (x: number, y: number) => x >= 28 && x < 36 && y >= 28 && y < 36;
  const map = tinyMap(W, W, 32, (x, y) => [{ z0: 0, z1: 10, mat: MAT.Stone }, ...(blk(x, y) ? [{ z0: 10, z1: 16, mat: MAT.Concrete }] : [])]);
  const w = await tinyWorld(g, map, ['surface', 'structure']);
  const agents = installAgents(w.core);
  const traits = installTraits(w.core, agents);
  registerSlice(traits);
  const run = (n: number) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => ['surface', 'structure', 'traits', 'agents'].includes(s.name));
  };
  const damage = async () => {
    const u = new Uint32Array((await w.read('layers')).buffer);
    let d = 0;
    for (let i = 0; i < u.length; i += 4) if ((u[i + 2] & 0xff) === MAT.Concrete) d += (u[i + 2] >> 8) & 15;
    return d;
  };
  run(2);
  // crack it: a light lightning strike's damage (structure.wgsl)
  const [cx, cy] = [32.5, 32 * 0.8660254];
  w.core.globals.events.push({ kind: 1, x: cx, y: cy, radius: 8, strength: 3 });
  run(3);
  const cracked = await damage();
  expect(cracked).toBeGreaterThan(20);
  traits.apply({ op: 'heal', rate: 2, at: [cx, cy], radius: 10, seconds: 6, world: { mend: true, every: 1 } });
  run(Math.round(6 * 60) + 4);
  await g.device.queue.onSubmittedWorkDone();
  expect(g.takeErrors()).toEqual([]);
  const mended = await damage();
  if (process.env.TRAITS_LOG) console.log({ cracked, mended });
  expect(mended).toBeLessThan(cracked * 0.5);
});

test('the Units contract on the agents: a raised unit is alive again, keeps its role, and is its raiser\'s', async () => {
  const { w, traits, agents } = await world();
  const { AgentUnits } = await import('../../src/units/agent-units');
  const units = new AgentUnits(agents);
  traits.kindTraits('shambler', ['undead']);
  const smith = units.spawn('townsman', [MID[0], MID[1]], 'f-town', { role: 'smith' });
  const ghoul = units.spawn('walking dead', [MID[0] + 1, MID[1]], 'f-hollow', { hostile: true, speed: 1.5 });
  const rose: [string, number][] = [];
  units.raised.push((u, grp) => rose.push([u.role, grp]));
  const tick = async (n: number) => {
    for (let i = 0; i < n; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'traits' || s.name === 'agents');
      units.update(1 / 60);
      await g.device.queue.onSubmittedWorkDone();
    }
  };
  await tick(10);
  traits.apply({ op: 'damage', type: 'physical', amount: 100, at: MID, radius: 10 });
  await tick(10);
  expect(units.get(smith)!.alive).toBe(false);
  expect(units.get(ghoul)!.alive).toBe(false);
  traits.apply({ op: 'raise', group: 14, at: MID, radius: 10 });
  await tick(10);
  // the smith rose (living), the walking dead (undead) stayed down
  expect(rose).toEqual([['smith', 14]]);
  expect(units.get(smith)!.alive).toBe(true);
  expect(units.get(smith)!.role).toBe('smith');
  expect(units.get(ghoul)!.alive).toBe(false);
  expect(g.takeErrors()).toEqual([]);
});
