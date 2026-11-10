// (U2, docs/design/UNIT_MINDS_U2.md §5: the riskiest part first) The hunt field seeded on the GPU (Agents.gpuHunt,
// units.wgsl huntSet) from every hostile's target, relaxed over a front per field (FC10) — checked against a CPU
// breadth-first search from the same targets while they die: after each wave the field must come back to the BFS's
// distances, and how many frames that takes is the count-up (FRAMECOST FC4) this round measures.
//   HUNT_LOG=<file> appends the frames each wave took, per mode.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import type { Agents } from '../../src/agents/agents';
import { cellAt, cellPos, nbr } from '../../src/world/lattice';

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

/** a seeded random */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

type Mode = 'gpu' | 'cpu';

async function world(mode: Mode) {
  const map = tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 1000 });
  // (gpu: the hunt's seeds the GPU's; cpu: today's path — the CPU seeds the field each frame (Agents.seed: a seed gone
  // far starts the field over), the baseline)
  if (mode === 'gpu') agents.gpuHunt(HUNT);
  else agents.follow(3, HUNT);
  // (the hunters and their prey stand: groups following nothing)
  agents.follow(1, -1);
  agents.follow(2, -1);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  return { agents, frame };
}

/** hex steps from the seed cells over the flat map (each step costs 1 there: agents.wgsl stepCost) */
function bfs(seeds: [number, number][]): Float32Array {
  const d = new Float32Array(W * H).fill(Infinity);
  let q: [number, number][] = [];
  for (const [x, y] of seeds) {
    if (d[y * W + x] === 0) continue;
    d[y * W + x] = 0;
    q.push([x, y]);
  }
  while (q.length) {
    const next: [number, number][] = [];
    for (const [x, y] of q)
      for (let k = 0; k < 6; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || d[ny * W + nx] !== Infinity) continue;
        d[ny * W + nx] = d[y * W + x] + 1;
        next.push([nx, ny]);
      }
    q = next;
  }
  return d;
}

/** the hunters' targets now (unit ids), and where each stands */
async function targets(agents: Agents, hunters: number[]) {
  const u = new Float32Array(await agents.readRaw('units'));
  const w = new Uint32Array(u.buffer);
  const ids = new Set<number>();
  for (const h of hunters) {
    const t = w[slotOf(h) * UF + 21];
    if (t && !(t & 0x80000000)) ids.add(t - 1);
  }
  const at = (id: number): [number, number] => [u[slotOf(id) * UF], u[slotOf(id) * UF + 1]];
  return { ids, at };
}

/** the field against the BFS over every column within `r` of the middle: the worst gap, and how many are off by > 1 */
async function compare(agents: Agents, seeds: [number, number][]) {
  const reader = agents.reader(HUNT);
  await reader.refresh();
  const ref = bfs(seeds);
  let worst = 0;
  let off = 0;
  let n = 0;
  for (let y = 4; y < H - 4; y++)
    for (let x = 4; x < W - 4; x++) {
      const [px, py] = cellPos(x, y);
      const s = reader.sample(px, py);
      const got = s ? s.dist : Infinity;
      const want = seeds.length ? ref[y * W + x] : Infinity;
      n++;
      const gap = got === Infinity && want === Infinity ? 0 : Math.abs(got - want);
      if (gap > worst) worst = gap;
      if (gap > 1) off++;
    }
  return { worst, off, n };
}

/** prey across a band, hunters either side; waves of the hunters' targets killed; the frames each wave took to match the
 *  BFS again (-1: not within `most`), then the last prey killed (no seeds: the field must empty) */
async function scenario(mode: Mode) {
  const { agents, frame } = await world(mode);
  const r = rnd(11);
  const prey: number[] = [];
  const hunters: number[] = [];
  for (let i = 0; i < 60; i++) prey.push(agents.spawn(1, 20 + r() * 88, 45 + r() * 20, { kind: 0, group: 1, spread: 0 })[0]);
  for (let i = 0; i < 40; i++) hunters.push(agents.spawn(1, (i % 2 ? 15 : 110) + r() * 6, 20 + r() * 70, { kind: 1, group: 2, spread: 0 })[0]);
  frame(20);
  for (const id of prey) agents.notice.set(slotOf(id), { faction: 0, hostile: false, sight: 0 });
  for (const id of hunters) agents.notice.set(slotOf(id), { faction: 1, hostile: true, sight: 200 });
  const alive = new Set(prey);
  const waves: { wave: number; seeds: number; frames: number; worst: number }[] = [];
  const settle = async (wave: number, most: number, none = false) => {
    for (let f = 1; f <= most; f++) {
      // (the targets as the frame's relaxation sees them: the hunters' as the last frame left them — the GPU's seeds
      // then, and the CPU's here; a frame's order: seeds, relax, step, notice)
      const t0 = await targets(agents, hunters);
      if (mode === 'cpu') agents.seed(HUNT, [...t0.ids].map((id) => ({ x: t0.at(id)[0], y: t0.at(id)[1] })));
      frame(1);
      const seeds = [...t0.ids].map((id) => cellAt(...t0.at(id)));
      const c = await compare(agents, seeds);
      // (settled: the field is the BFS's from targets all living — not the dead ones it was seeded from a frame ago)
      const living = [...t0.ids].every((id) => alive.has(id)) && (none ? t0.ids.size === 0 : t0.ids.size > 0);
      if ((c.worst <= 1 && living) || f === most) {
        waves.push({ wave, seeds: seeds.length, frames: c.worst <= 1 && living ? f : -1, worst:Number.isFinite(c.worst) ? +c.worst.toFixed(2) : -1 });
        return;
      }
    }
  };
  await settle(0, 120);
  // waves: every target the hunters have now dies (their seeds vanish; the hunters take the next nearest)
  for (let wave = 1; wave <= 5; wave++) {
    const t = await targets(agents, hunters);
    expect(t.ids.size).toBeGreaterThan(0);
    for (const id of t.ids) {
      agents.hit({ unit: id, x: 0, y: 0, radius: 0, damage: 1000 });
      alive.delete(id);
    }
    await settle(wave, 120);
  }
  for (const id of alive) agents.hit({ unit: id, x: 0, y: 0, radius: 0, damage: 1000 });
  alive.clear();
  await settle(6, 240, true);
  expect(g.takeErrors()).toEqual([]);
  return waves;
}

const results: Partial<Record<Mode, Awaited<ReturnType<typeof scenario>>>> = {};

test('baseline: the CPU-seeded hunt field (today) matches the BFS after every wave', async () => {
  const waves = (results.cpu = await scenario('cpu'));
  log(`cpu ${JSON.stringify(waves)}`);
  for (const w of waves) expect(w.frames, `wave ${w.wave}: ${JSON.stringify(w)}`).toBeGreaterThan(0);
});

test("the GPU-seeded hunt field (each value keeps its seed: U2 §5b) matches the BFS as fast as today's, and empties", async () => {
  const waves = (results.gpu = await scenario('gpu'));
  log(`gpu ${JSON.stringify(waves)}`);
  for (const w of waves) expect(w.frames, `wave ${w.wave}: ${JSON.stringify(w)}`).toBeGreaterThan(0);
  // (no slower than the CPU's seeds by more than a few frames, wave by wave)
  const base = results.cpu;
  if (base) for (const w of waves) expect(w.frames, `wave ${w.wave}: gpu ${w.frames} vs cpu ${base[w.wave]?.frames}`).toBeLessThanOrEqual((base[w.wave]?.frames ?? 0) + 5);
});
