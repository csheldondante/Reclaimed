// (U2, docs/design/UNIT_MINDS_U2.md §6-§7) The GPU decides: the interface tests both tracks run through the Units contract,
// and UNIT_MINDS' seven failure modes at the GPU tier. Written before the implementation: each is `test.fails` until U2
// lands (vitest reports it passing while it fails). Every test touches a U2-only surface first (`jobDone`, `lost`, row g,
// `FieldPoolFull`), so today it fails at once, cheaply, and none can pass by accident on the CPU think(). When U2 lands,
// flip each to `test` as its part is built.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { Agents, UNIT_V } from '../../src/agents/agents';
import type { AgentUnits } from '../../src/units/agent-units';
import type { UnitId, UnitJob, UnitView, Units, V2 } from '../../src/api/contracts/units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const MID: V2 = [48, 40];
const TPS = 60;

// ---- the proposed U2 surface (UNIT_MINDS_U2.md §8) -----------------------------------------------------------------
type Why = 'arrived' | 'target-gone' | 'safe';
interface U2Units extends Units {
  readonly jobDone: ((u: UnitView, job: UnitJob, why: Why) => void)[];
  readonly lost: ((count: number) => void)[];
}
/** the U2 contract's optional members, required here: missing today, so each test fails at its first use */
function u2(units: AgentUnits): U2Units {
  const u = units as unknown as Partial<U2Units> & Units;
  if (!u.jobDone || !u.lost) throw new Error('U2: jobDone / lost not on the Units contract yet');
  return u as U2Units;
}

// ---- row g (UNIT_MINDS_U2.md §1): 7 vec4 a unit -----------------------------------------------------------------------
const UNIT_V2 = 7;
const UF2 = UNIT_V2 * 4;
const ST = { none: 0, chase: 1, swing: 2, tumble: 3, held: 4, flee: 5 } as const;
const JOB = { idle: 0, go: 1, guard: 2, patrol: 3, follow: 4, attack: 5, fleeFrom: 6, work: 7 } as const;
const GUARD = { walk: 0, posted: 1 } as const;
const GO = { walk: 0, there: 1 } as const;

/** one unit's override (info bits 12-14) and behaviour word (g.x) from a raw read of the 7-vec4 rows */
async function mind(agents: Agents, gpu: number) {
  if ((UNIT_V as number) !== UNIT_V2) throw new Error(`U2: the unit row is ${UNIT_V} vec4, not ${UNIT_V2} yet`);
  const raw = await agents.readRaw('units');
  const u = new Uint32Array(raw);
  const f = new Float32Array(raw);
  const s = gpu % 8192;
  const info = u[s * UF2 + 3];
  const word = u[s * UF2 + 24];
  return { state: (info >>> 12) & 7, job: word & 0xff, jobState: (word >>> 8) & 0xff, slot: u[s * UF2 + 25] & 0xff, hp: f[s * UF2 + 8], at: [f[s * UF2], f[s * UF2 + 1], f[s * UF2 + 2]] as const };
}

async function world() {
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const { AgentUnits } = await import('../../src/units/agent-units');
  const units = new AgentUnits(agents);
  /** n ticks; the adapter drains events each (it decides nothing after U2) */
  const run = async (n: number, until?: () => boolean) => {
    for (let i = 0; i < n; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
      units.update(1 / TPS);
      await g.device.queue.onSubmittedWorkDone();
      if (until?.()) return i + 1;
    }
    return n;
  };
  const gpuOf = (id: UnitId) => units.recs.get(id)!.gpu;
  return { w, agents, units, run, gpuOf };
}

// ---- §6: the interface tests (both tracks) --------------------------------------------------------------------------

test.fails('interface: an order for group g produces an arrival event for each of its units', async () => {
  const { units, run } = await world();
  const U = u2(units);
  const ids = Array.from({ length: 12 }, (_, i) => units.spawn('soldier', [20 + (i % 4), 30 + Math.floor(i / 4)], 'f-town', { role: 'guard' }));
  const p: V2 = [60, 40];
  const arrived = new Map<UnitId, number>();
  U.jobDone.push((u, job, why) => {
    if (why === 'arrived' && job.kind === 'go') arrived.set(u.id, (arrived.get(u.id) ?? 0) + 1);
  });
  units.order(ids, { kind: 'go', to: p });
  await run(30 * TPS, () => arrived.size === ids.length);
  expect([...arrived.keys()].sort()).toEqual([...ids].sort());
  // (once each: an arrival is an event, not a poll)
  expect([...arrived.values()].every((n) => n === 1)).toBe(true);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('interface: a hit in the step produces hurt and death naming `by`', async () => {
  const { units, run } = await world();
  u2(units);
  const guard = units.spawn('guard', [MID[0] - 0.8, MID[1]], 'f-town', { role: 'guard', health: 3, damage: 1 });
  const raider = units.spawn('raider', [MID[0] + 0.8, MID[1]], 'f-raid', { role: 'raider', hostile: true, health: 3, damage: 1 });
  const hurts: [UnitId, UnitId | string | null][] = [];
  const deaths: [UnitId, UnitId | string | null][] = [];
  units.hurt.push((u, _d, by) => hurts.push([u.id, by]));
  units.died.push((u, by) => deaths.push([u.id, by]));
  // (no CPU `hit` anywhere: the blows are the step's)
  await run(20 * TPS, () => deaths.length > 0);
  expect(deaths.length).toBe(1);
  const [dead, killer] = deaths[0];
  expect([guard, raider]).toContain(dead);
  expect(killer).toBe(dead === guard ? raider : guard);
  // every hurt names a unit: the other one
  expect(hurts.length).toBeGreaterThan(0);
  for (const [who, by] of hurts) expect(by).toBe(who === guard ? raider : guard);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('interface: a soldier ordered to guard p, knocked down, returns to p', async () => {
  const { units, run } = await world();
  const U = u2(units);
  const p: V2 = [MID[0], MID[1]];
  const s = units.spawn('guard', [p[0] - 10, p[1]], 'f-town', { role: 'guard' });
  let arrivals = 0;
  U.jobDone.push((u, job, why) => {
    if (u.id === s && job.kind === 'guard' && why === 'arrived') arrivals++;
  });
  units.order(s, { kind: 'guard', at: p });
  await run(15 * TPS, () => arrivals === 1);
  expect(arrivals).toBe(1);
  // knocked 6 cells off with a throw
  units.strike!({ at: [p[0] - 1, p[1]], radius: 2, damage: 0, push: 14, dir: [1, 0], lift: 6, stun: 0.5 }, null);
  await run(2 * TPS);
  expect((await units.query(p, 1.6)).map((v) => v.id)).not.toContain(s);
  await run(15 * TPS, () => arrivals === 2);
  expect(arrivals).toBe(2);
  expect((await units.query(p, 1.6)).map((v) => v.id)).toContain(s);
  expect(g.takeErrors()).toEqual([]);
});

// ---- §7: UNIT_MINDS' failure modes ------------------------------------------------------------------------------------

test.fails('F1: an override preempts a job; the job resumes from its state byte', async () => {
  const { agents, units, run, gpuOf } = await world();
  u2(units);
  // a worker going 40 cells; a blow to below its kind's flee fraction mid-walk
  const h = units.spawn('townsman', [20, 40], 'f-town', { role: 'hauler', health: 10 });
  units.order(h, { kind: 'go', to: [70, 40] });
  await run(2 * TPS);
  const before = await mind(agents, gpuOf(h));
  expect([before.job, before.jobState]).toEqual([JOB.go, GO.walk]);
  units.hit(h, 8, null);
  await run(3);
  const fleeing = await mind(agents, gpuOf(h));
  expect(fleeing.state).toBe(ST.flee);
  // (the override never touched the job's state)
  expect([fleeing.job, fleeing.jobState]).toEqual([JOB.go, GO.walk]);
  // no threat in sight: FLEE clears after its timer, the walk resumes where it was
  await run(6 * TPS);
  const after = await mind(agents, gpuOf(h));
  expect(after.state).toBe(ST.none);
  expect([after.job, after.jobState]).toEqual([JOB.go, GO.walk]);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('F2: a threat reaches a worker within 2 ticks of being noticed', async () => {
  const { agents, units, run, gpuOf } = await world();
  u2(units);
  const wk = units.spawn('townsman', MID, 'f-town', { role: 'farmer' });
  await run(10);
  expect((await mind(agents, gpuOf(wk))).state).toBe(ST.none);
  const raider = units.spawn('raider', [MID[0] + 6, MID[1]], 'f-raid', { role: 'raider', hostile: true, sight: 12 });
  let noticedAt = -1;
  let tick = 0;
  units.noticed.push((u, t) => {
    if (u.id === raider && t === wk && noticedAt < 0) noticedAt = tick;
  });
  // (a frame at a time, its row read each: the FLEE bits within two frames of the notice, which the GPU made in the
  // frame `noticedAt` — the event read a frame later is not the reaction's clock)
  let fledAt = -1;
  for (tick = 0; tick < 30 && fledAt < 0; tick++) {
    await run(1);
    if ((await mind(agents, gpuOf(wk))).state === ST.flee) fledAt = tick;
  }
  expect(noticedAt).toBeGreaterThanOrEqual(0);
  expect(fledAt).toBeGreaterThanOrEqual(0);
  expect(fledAt - noticedAt).toBeLessThanOrEqual(2);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('F3: event ring overflow is counted and surfaced, never thrown or dropped silently', async () => {
  const { units, run } = await world();
  const U = u2(units);
  let lost = 0;
  U.lost.push((n) => (lost += n));
  const n = Agents.EVENT_CAP + 400;
  for (let i = 0; i < n; i++) units.spawn('townsman', [MID[0] + ((i % 40) - 20) * 0.5, MID[1] + (Math.floor(i / 40) - 30) * 0.5], 'f-town');
  await run(4);
  let deaths = 0;
  units.died.push(() => deaths++);
  units.strike!({ at: MID, radius: 60, damage: 100 }, null);
  // (one step makes > EVENT_CAP deaths; the adapter reads until the ring is empty)
  await expect(run(40)).resolves.toBe(40);
  expect(deaths + lost).toBe(n);
  expect(lost).toBeGreaterThan(0);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('F4: a target removed with no event read is let go on the GPU; no swing lands on the empty slot', async () => {
  const { agents, units, run, gpuOf } = await world();
  const U = u2(units);
  const guard = units.spawn('guard', [MID[0] - 3, MID[1]], 'f-town', { role: 'guard', sight: 10 });
  const victim = units.spawn('raider', [MID[0] + 3, MID[1]], 'f-raid', { role: 'raider', hostile: true });
  const ends: Why[] = [];
  U.jobDone.push((u, _j, why) => u.id === guard && ends.push(why));
  units.order(guard, { kind: 'attack', target: victim });
  await run(30);
  // removed between syncs (no death event: a despawn)
  units.remove(victim);
  await run(3);
  const m = await mind(agents, gpuOf(guard));
  expect(m.state === ST.chase || m.state === ST.swing).toBe(false);
  expect(m.job).toBe(JOB.idle);
  expect(ends).toEqual(['target-gone']);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('F5: a guard knocked off its post walks back (GUARD WALK → POSTED after DOWNED clears)', async () => {
  const { agents, units, run, gpuOf } = await world();
  u2(units);
  const p: V2 = [MID[0], MID[1]];
  const s = units.spawn('guard', p, 'f-town', { role: 'guard' });
  units.order(s, { kind: 'guard', at: p });
  await run(TPS);
  expect((await mind(agents, gpuOf(s))).jobState).toBe(GUARD.posted);
  units.strike!({ at: [p[0] - 1, p[1]], radius: 2, damage: 0, push: 14, dir: [1, 0], lift: 6 }, null);
  await run(5);
  const down = await mind(agents, gpuOf(s));
  expect(down.state).toBe(ST.tumble);
  // (the override doesn't touch the job: still its post)
  expect(down.job).toBe(JOB.guard);
  await run(3 * TPS);
  const up = await mind(agents, gpuOf(s));
  expect(up.state).toBe(ST.none);
  expect(up.jobState).toBe(GUARD.walk);
  await run(10 * TPS);
  const back = await mind(agents, gpuOf(s));
  expect(back.jobState).toBe(GUARD.posted);
  expect(Math.hypot(back.at[0] - p[0], back.at[1] - p[1])).toBeLessThan(1.6);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('F6: all pool fields held — the next order throws FieldPoolFull; the held orders still walk', async () => {
  const { units, run } = await world();
  const U = u2(units);
  const ids = Array.from({ length: 9 }, (_, i) => units.spawn('townsman', [10 + i * 2, 20], 'f-town'));
  // 8 distinct places (more than 2 cells apart: their own keys), one slot each
  for (let i = 0; i < 8; i++) units.order(ids[i], { kind: 'go', to: [20 + i * 6, 60] });
  expect(() => units.order(ids[8], { kind: 'go', to: [80, 80] })).toThrow(/FieldPoolFull/);
  // the ninth was not half-ordered: it keeps its job
  expect(units.get(ids[8])!.job.kind).toBe('guard');
  const done = new Set<UnitId>();
  U.jobDone.push((u, _j, why) => why === 'arrived' && done.add(u.id));
  await run(40 * TPS, () => done.size === 8);
  expect(done.size).toBe(8);
  expect(g.takeErrors()).toEqual([]);
});

test.fails('F7: a slot reused during an in-flight event — the events name the old id, the new unit is untouched', async () => {
  const { agents, units, run, gpuOf } = await world();
  u2(units);
  const a = units.spawn('raider', [MID[0] - 0.8, MID[1]], 'f-raid', { role: 'raider', hostile: true, damage: 5 });
  const b = units.spawn('townsman', [MID[0] + 0.8, MID[1]], 'f-town', { health: 1 });
  const bSlot = gpuOf(b) % 8192;
  const died: [UnitId, UnitId | string | null][] = [];
  units.died.push((u, by) => died.push([u.id, by]));
  // (stepped without draining events: B dies on the GPU, its death unread)
  for (let i = 0; i < 4 * TPS; i++) {
    const before = (await mind(agents, gpuOf(b))).hp;
    if (before <= 0) break;
    await run(1);
  }
  units.remove(b);
  const c = units.spawn('townsman', [MID[0] + 0.8, MID[1]], 'f-town', { health: 3 });
  expect(gpuOf(c) % 8192).toBe(bSlot);
  await run(TPS);
  // B's death names A; C is a new id in B's slot, at full health, not struck by A's in-flight swing
  expect(died.filter(([id]) => id === b).map(([, by]) => by)).toEqual([a]);
  expect(units.get(c)!.alive).toBe(true);
  expect((await mind(agents, gpuOf(c))).hp).toBeCloseTo(3 * 3, 3);
  expect(g.takeErrors()).toEqual([]);
});
