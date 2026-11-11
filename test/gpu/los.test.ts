// (FC12 stage 2, UNIT_MINDS_U2.md §9f) Line of sight on the obstacle JFA's clearance (units.wgsl aimTick), ranged kinds
// (the fire() placeholder: a delayed hit in the target's accumulator, REPLACE: GPU physics rigid bodies), and melee
// steering straight at a target in sight. The page's flags are read as the agents module loads: ?los=1 is set first.
//   LOS_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';

Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/?los=1'), configurable: true });
const { MAT } = await import('../../src/world/materials');
const { tinyMap } = await import('../support/tinymap');
const { tinyWorld } = await import('./world');
const { installAgents } = await import('../../src/agents/install');
const { BY_UNIT } = await import('../../src/agents/agents');
const { cellPos } = await import('../../src/world/lattice');

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const H = 96;
const UF = 24;
const HUNT = 7;
const slotOf = (id: number) => id % 8192;
const LOG = process.env.LOS_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

/** a wall (12 above the ground) across x 46-48, but a gap at rows 24-44 */
const wallAt = (x: number, y: number) => x >= 46 && x <= 48 && !(y >= 24 && y <= 44);

async function world(walled: boolean) {
  const map = tinyMap(W, H, 32, (x: number, y: number) => [{ z0: 0, z1: walled && wallAt(x, y) ? 22 : 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 1000 });
  agents.gpuHunt(HUNT);
  agents.los = true;
  // (kind 3: an archer — reach 0, it never swings — range 16; kind 4: a melee hunter)
  agents.defineKind(3, { name: 'archer', height: 1.3, mass: 1, hp: 10, speed: 2.5, reach: 0, damage: 1, swingPeriod: 1, notice: 1000, range: 16 });
  agents.defineKind(4, { name: 'hunter', height: 1.2, mass: 1, hp: 10, speed: 3, reach: 1.2, damage: 1, swingPeriod: 1, notice: 1000 });
  agents.follow(1, -1);
  agents.follow(2, HUNT);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  const at = (c: [number, number]) => cellPos(c[0], c[1]);
  /** a target (a worker, standing) and a hostile of `kind` at cells */
  const pair = (kind: number, from: [number, number], to: [number, number], group = 2) => {
    const [t] = agents.spawn(1, ...at(to), { kind: 0, group: 1, spread: 0 });
    const [h] = agents.spawn(1, ...at(from), { kind, group, spread: 0 });
    return { t, h };
  };
  const arm = (t: number, hunters: number[]) => {
    agents.notice.set(slotOf(t), { faction: 0, hostile: false, sight: 0 });
    for (const h of hunters) agents.notice.set(slotOf(h), { faction: 1, hostile: true, sight: 400 });
  };
  const row = async (id: number) => {
    const u = new Float32Array(await agents.readRaw('units'));
    const o = slotOf(id) * UF;
    return { at: [u[o], u[o + 1]] as const, vel: [u[o + 4], u[o + 5]] as const, hp: u[o + 8] };
  };
  return { agents, frame, pair, arm, row };
}

test('an archer with a clear line fires within a few frames of seeing its target, and the arrow lands naming it', async () => {
  const { agents, frame, pair, arm } = await world(false);
  const { t, h } = pair(3, [30, 40], [42, 40], 1);
  frame(10);
  arm(t, [h]);
  await agents.benchCounters();
  const hurts: { by: number; damage: number }[] = [];
  let firstShot = -1;
  for (let f = 1; f <= 90 && hurts.length === 0; f++) {
    frame(1);
    const c = await agents.benchCounters();
    if (firstShot < 0 && c.shots > 0) firstShot = f;
    for (const e of (await agents.sync()).events) if (e.type === 'hurt' && e.id === t && typeof e.hit === 'number') hurts.push({ by: e.hit, damage: e.damage });
  }
  log(`archer clear: first shot ${firstShot}, hurts ${JSON.stringify(hurts)}`);
  // (notice's frame, then the aim's: the line seen; then the step shoots on its cooldown)
  expect(firstShot).toBeGreaterThan(0);
  expect(firstShot).toBeLessThanOrEqual(4);
  expect(hurts[0]).toEqual({ by: BY_UNIT | h, damage: 1 });
  expect(g.takeErrors()).toEqual([]);
});

test('an archer behind a wall holds fire, walks round it, then fires', async () => {
  const { agents, frame, pair, arm, row } = await world(true);
  // (the archer west of the wall, its target east; the gap north of both)
  const { t, h } = pair(3, [38, 66], [56, 66]);
  frame(10);
  arm(t, [h]);
  // (U2 §9f, seen-only on by default: a target never seen is hunted only when the unit is told of it — an order; this
  // archer is ordered at its target, so it walks round the wall to it. Noticed alone it would stand: the next test)
  agents.tell(slotOf(h), t + 1);
  await agents.benchCounters();
  let heldFor = 0;
  let firstShot = -1;
  for (let f = 1; f <= 900 && firstShot < 0; f++) {
    frame(1);
    const c = await agents.benchCounters();
    if (c.shots > 0) firstShot = f;
    else heldFor = f;
  }
  const r = await row(h);
  log(`archer walled: held ${heldFor} frames, first shot ${firstShot} at ${r.at.map((v) => v.toFixed(1))}`);
  expect(heldFor).toBeGreaterThan(30);
  expect(firstShot).toBeGreaterThan(0);
  expect(g.takeErrors()).toEqual([]);
});

test('seen-only: an archer behind a wall that only noticed its target (never saw it, not told) does not hunt it', async () => {
  const { agents, frame, pair, arm, row } = await world(true);
  const { t, h } = pair(3, [38, 66], [56, 66]);
  frame(10);
  arm(t, [h]);
  const r0 = await row(h);
  await agents.benchCounters();
  let shots = 0;
  for (let f = 1; f <= 300; f++) {
    frame(1);
    if (f % 30 === 0) shots = (await agents.benchCounters()).shots;
  }
  const r1 = await row(h);
  const moved = Math.hypot(r1.at[0] - r0.at[0], r1.at[1] - r0.at[1]);
  log(`archer noticed-only: shots ${shots}, moved ${moved.toFixed(1)}`);
  // (no seed for the hunt field: it wanders, slowly — never round the wall to its target)
  expect(shots).toBe(0);
  expect(moved).toBeLessThan(8);
  expect(g.takeErrors()).toEqual([]);
});

test('two arrows on one target in one tick both count: the accumulator sums them, the target applies both', async () => {
  const { agents, frame, arm, row } = await world(false);
  const at = (c: [number, number]) => cellPos(c[0], c[1]);
  const [t] = agents.spawn(1, ...at([40, 40]), { kind: 0, group: 1, spread: 0 });
  // (two archers the same distance off, either side, armed together, and standing still — speed 0, so no wander moves
  // either: their first arrows fly the same time and land in the same tick)
  agents.defineKind(5, { name: 'post archer', height: 1.3, mass: 1, hp: 10, speed: 0, reach: 0, damage: 1, swingPeriod: 1, notice: 1000, range: 16 });
  const [a] = agents.spawn(1, ...at([30, 40]), { kind: 5, group: 1, spread: 0 });
  const [b] = agents.spawn(1, ...at([50, 40]), { kind: 5, group: 1, spread: 0 });
  frame(10);
  arm(t, [a, b]);
  const hp0 = (await row(t)).hp;
  const hurts: { by: number; damage: number }[] = [];
  for (let f = 1; f <= 90 && hurts.length === 0; f++) {
    frame(1);
    for (const e of (await agents.sync()).events) if (e.type === 'hurt' && e.id === t && typeof e.hit === 'number') hurts.push({ by: e.hit, damage: e.damage });
  }
  const hp1 = (await row(t)).hp;
  log(`two arrows: hurts ${JSON.stringify(hurts)}, hp ${hp0} → ${hp1}`);
  // (one hurt with both arrows' damage, named for the higher id; the hp down by both)
  expect(hurts.length).toBe(1);
  expect(hurts[0].damage).toBe(2);
  expect([BY_UNIT | a, BY_UNIT | b]).toContain(hurts[0].by);
  expect(hp0 - hp1).toBeCloseTo(2, 3);
  expect(g.takeErrors()).toEqual([]);
});

test('melee with a clear line turns toward its target without waiting on the field (the fields frozen)', async () => {
  const out: Record<string, { turned: number; toward: number; direct: number }> = {};
  for (const los of [true, false]) {
    const { agents, frame, pair, arm, row } = await world(false);
    agents.los = los;
    // (no field to follow: relax not dispatched — only the line of sight can steer it)
    agents.benchFrozen = true;
    const { t, h } = pair(4, [30, 40], [50, 40]);
    frame(10);
    arm(t, [h]);
    // (the first frame it moves toward its target, and the share of 40 frames it does: with sight it closes in; without,
    // only a wander's chance heading points it that way now and then)
    let turned = -1;
    let toward = 0;
    await agents.benchCounters();
    for (let f = 1; f <= 40; f++) {
      frame(1);
      const r = await row(h);
      const tp = cellPos(50, 40);
      const dx = tp[0] - r.at[0];
      const dy = tp[1] - r.at[1];
      const sp = Math.hypot(r.vel[0], r.vel[1]);
      const ok = sp > 0.5 && (r.vel[0] * dx + r.vel[1] * dy) / (sp * Math.hypot(dx, dy)) > 0.9;
      if (ok) {
        toward++;
        if (turned < 0) turned = f;
      }
    }
    // (the steps taken straight at a target in sight: units.wgsl's direct-step counter)
    out[los ? 'los' : 'off'] = { turned, toward: toward / 40, direct: (await agents.benchCounters()).direct };
  }
  log(`melee: ${JSON.stringify(out)}`);
  expect(out.los.turned).toBeGreaterThan(0);
  expect(out.los.turned).toBeLessThanOrEqual(12);
  expect(out.los.toward).toBeGreaterThan(0.7);
  // (without sight no step goes straight at it — what moves it is a wander's heading, logged as the control)
  expect(out.los.direct).toBeGreaterThan(0);
  expect(out.off.direct).toBe(0);
  expect(g.takeErrors()).toEqual([]);
});

// ---- (U2 round 5, DA-B32) melee on the GPU: a blow lands in the target's accumulator, the target's step applies it
// naming the striker; a unit that can fight turns on who struck it; no swing event for a unit target (the CPU applies
// none) ------------------------------------------------------------------------------------------------------------------

test('a melee blow on a unit lands on the GPU naming the striker, with no swing event; a guard struck strikes back', async () => {
  const { agents, frame, arm } = await world(false);
  const at = (c: [number, number]) => cellPos(c[0], c[1]);
  // (kind 6: a guard — a reach and a blow, no notice: it never looks, but struck it fights back)
  agents.defineKind(6, { name: 'guard', height: 1.4, mass: 1, hp: 10, speed: 0, reach: 1.2, damage: 2, swingPeriod: 1, notice: 0 });
  const [t] = agents.spawn(1, ...at([40, 40]), { kind: 6, group: 1, spread: 0 });
  const [h] = agents.spawn(1, ...at([42, 40]), { kind: 4, group: 2, spread: 0 });
  frame(10);
  arm(t, [h]);
  agents.notice.set(slotOf(t), { faction: 0, hostile: false, sight: 0 });
  const hurtT: number[] = [];
  const hurtH: number[] = [];
  let swings = 0;
  let noticed = -1;
  for (let f = 1; f <= 240 && hurtH.length === 0; f++) {
    frame(1);
    for (const e of (await agents.sync()).events) {
      if (e.type === 'swing') swings++;
      if (e.type === 'hurt' && e.id === t && typeof e.hit === 'number') hurtT.push(e.hit);
      if (e.type === 'hurt' && e.id === h && typeof e.hit === 'number') hurtH.push(e.hit);
      if (e.type === 'noticed' && e.id === t && noticed < 0) noticed = e.target;
    }
  }
  log(`melee gpu: guard hurt by ${hurtT.map((x) => x - BY_UNIT)}, hunter hurt by ${hurtH.map((x) => x - BY_UNIT)}, swings ${swings}, noticed ${noticed}`);
  expect(hurtT[0]).toBe(BY_UNIT | h);
  // (struck, it took its striker as its target — told as notice tells it — and its blow landed back)
  expect(noticed).toBe(h + 1);
  expect(hurtH[0]).toBe(BY_UNIT | t);
  expect(swings).toBe(0);
  expect(g.takeErrors()).toEqual([]);
});
