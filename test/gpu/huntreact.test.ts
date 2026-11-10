// (U2 FC11, docs/design/UNIT_MINDS_U2.md §5b) Reaction latency, the acceptance number: frames from a target change to
// the hunter turning toward its new target, by the GPU-seeded hunt field. (FC11 (a), steering straight at a target
// within a radius, was measured and dropped: no faster near a target, where the field is fresh — DEVLOG, U2 §5b.)
//   HUNT_LOG=<file> appends the numbers; SWEEPS=N relax sweeps a tick (default the low tier's 2). FRONTCAP=N runs it with ?frontcap=N (FC11 (b)): the page's flags are read as
//   the agents module loads, so this file sets them first and imports the game's code after.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';

if (process.env.FRONTCAP) Object.defineProperty(globalThis, 'location', { value: new URL(`http://localhost/?frontcap=${process.env.FRONTCAP}`), configurable: true });
const { MAT } = await import('../../src/world/materials');
const { tinyMap } = await import('../support/tinymap');
const { tinyWorld } = await import('./world');
const { installAgents } = await import('../../src/agents/install');

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const H = 128;
const UF = 24;
const HUNT = 7;
const slotOf = (id: number) => id % 8192;
const LOG = process.env.HUNT_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

/**
 * One hunter between two prey on a flat 128² map: A nearer (its target), B the other way. Once the field has filled
 * and it walks toward A, A dies. The frames until notice gives it B (`retarget`); until its velocity has a part toward B
 * at all (`turning`: > 0.1 cells/s — braking alone never gets there; units.wgsl eases velocity at 6/s, so a unit
 * walking at 3 cells/s that wants B at once crosses in ~7 frames: the floor); until it moves toward B (`moving`: within
 * ~45° of B, faster than 0.5 cells/s). `gap`: cells from the hunter to A (B gap + 2 the other way); `y` its row.
 */
async function reaction(gap: number, y: number) {
  const map = tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 1000 });
  agents.gpuHunt(HUNT);
  agents.follow(1, -1);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  // (SWEEPS=N: relax sweeps a tick — the low tier's 2 by default, as the phone)
  if (process.env.SWEEPS) agents.sweeps = Number(process.env.SWEEPS);
  agents.defineKind(3, { name: 'hunter', height: 1.2, mass: 1, hp: 10, speed: 3, reach: 1.2, damage: 1, swingPeriod: 1, notice: 1000 });
  agents.follow(2, HUNT);
  const P: [number, number] = [64, y];
  const ta: [number, number] = [P[0] + gap, P[1]];
  const tb: [number, number] = [P[0] - gap - 2, P[1]];
  const [a] = agents.spawn(1, ta[0], ta[1], { kind: 0, group: 1, spread: 0 });
  const [b] = agents.spawn(1, tb[0], tb[1], { kind: 0, group: 1, spread: 0 });
  const [h] = agents.spawn(1, P[0], P[1], { kind: 3, group: 2, spread: 0 });
  frame(20);
  agents.notice.set(slotOf(a), { faction: 0, hostile: false, sight: 0 });
  agents.notice.set(slotOf(b), { faction: 0, hostile: false, sight: 0 });
  agents.notice.set(slotOf(h), { faction: 1, hostile: true, sight: 400 });
  const row = async () => {
    const u = new Float32Array(await agents.readRaw('units'));
    const wd = new Uint32Array(u.buffer);
    const o = slotOf(h) * UF;
    return { at: [u[o], u[o + 1]] as const, vel: [u[o + 4], u[o + 5]] as const, target: wd[o + 21] };
  };
  const along = (r: Awaited<ReturnType<typeof row>>, t: readonly [number, number]) => {
    const dx = t[0] - r.at[0];
    const dy = t[1] - r.at[1];
    return (r.vel[0] * dx + r.vel[1] * dy) / Math.hypot(dx, dy);
  };
  const toward = (r: Awaited<ReturnType<typeof row>>, id: number, t: readonly [number, number]) => {
    const sp = Math.hypot(r.vel[0], r.vel[1]);
    return r.target === id + 1 && sp > 0.5 && along(r, t) / sp > 0.7;
  };
  // settled: the field filled (a hostile chases only once the field at its feet is within its notice — units.wgsl
  // WANDER → CHASE), then walking toward A
  frame(30);
  let settled = -1;
  for (let f = 0; f < 240 && settled < 0; f++) {
    frame(1);
    if (toward(await row(), a, ta)) settled = f;
  }
  expect(settled, 'the hunter never walked toward A').toBeGreaterThanOrEqual(0);
  agents.hit({ unit: a, x: 0, y: 0, radius: 0, damage: 1000 });
  let retarget = -1;
  let turning = -1;
  let moving = -1;
  for (let f = 1; f <= 240 && moving < 0; f++) {
    frame(1);
    const r = await row();
    if (retarget < 0 && r.target === b + 1) retarget = f;
    if (turning < 0 && r.target === b + 1 && along(r, tb) > 0.1) turning = f;
    if (toward(r, b, tb)) moving = f;
  }
  expect(g.takeErrors()).toEqual([]);
  return { gap, y, retarget, turning, moving };
}

test('reaction latency: frames from a target change to the hunter turning toward its new target, by the field', async () => {
  const out = [];
  for (const gap of [6, 40]) for (const y of [40, 60, 80]) out.push(await reaction(gap, y));
  log(`reaction cap ${process.env.FRONTCAP ?? 32} sweeps ${process.env.SWEEPS ?? 2} ${JSON.stringify(out)}`);
  for (const r of out) {
    expect(r.retarget, JSON.stringify(r)).toBeGreaterThan(0);
    expect(r.turning, JSON.stringify(r)).toBeGreaterThan(0);
  }
  // (near its new target: notice's frame, then the steering's own easing — the floor, ~7–9 frames — and the field's
  // first sweeps round the new seed: ≤ 13 frames at the low tier's 2 sweeps)
  for (const r of out.filter((x) => x.gap === 6)) expect(r.turning, JSON.stringify(r)).toBeLessThanOrEqual(13);
  // (40 cells off: the field's change must cross them, about a cell or two a sweep — 11–27 frames at 2 sweeps, 9–12 at
  // 8–16: the propagation, not the front's cap (U2 §5b). Bounded here so a regression shows; the target is the floor)
  for (const r of out.filter((x) => x.gap === 40)) expect(r.turning, JSON.stringify(r)).toBeLessThanOrEqual(30);
});
