// (U2 round 7, docs/design/UNIT_MINDS_U2.md §9b: the riskiest part first) Relax over pages with block relaxation
// (agents/pages.ts, shaders/pages.wgsl), beside the planes, over the agents' own surfaces: against a CPU breadth-first
// search on three maps (open, a wall with one gap, an S-bend), the reaction to a seed moved far (the field right 40
// cells round its new seed, in frames of 2 sweeps), and memory (the pages a field holds against a whole-window plane).
//   PAGES_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { FieldPages } from '../../src/agents/pages';
import { cellPos, nbr } from '../../src/world/lattice';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const H = 128;
const NAV_K = 4;
const LOG = process.env.PAGES_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

type MapKind = 'open' | 'wall' | 'sbend';
/** huntreact.test.ts's maps: a wall column 12 above the ground (no link up) */
function walled(kind: MapKind, x: number, y: number): boolean {
  if (kind === 'wall') return x >= 62 && x <= 64 && !(y >= 60 && y <= 64);
  if (kind === 'sbend') return (y >= 40 && y <= 42 && !(x >= 100 && x <= 108)) || (y >= 84 && y <= 86 && !(x >= 20 && x <= 28));
  return false;
}
const PLACES: Record<MapKind, { a: [number, number]; b: [number, number] }> = {
  open: { a: [24, 68], b: [110, 64] },
  wall: { a: [24, 68], b: [110, 64] },
  sbend: { a: [70, 122], b: [64, 10] },
};

function bfs(kind: MapKind, from: [number, number]): Float32Array {
  const ref = new Float32Array(W * H).fill(Infinity);
  ref[from[1] * W + from[0]] = 0;
  let q: [number, number][] = [from];
  while (q.length) {
    const next: [number, number][] = [];
    for (const [x, y] of q)
      for (let k = 0; k < 6; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || walled(kind, nx, ny) || ref[ny * W + nx] !== Infinity) continue;
        ref[ny * W + nx] = ref[y * W + x] + 1;
        next.push([nx, ny]);
      }
    q = next;
  }
  return ref;
}

async function mapCase(kind: MapKind) {
  const map = tinyMap(W, H, 32, (x: number, y: number) => [{ z0: 0, z1: walled(kind, x, y) ? 22 : 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  // (a unit so the agents peel the surfaces the pages relax over)
  agents.spawn(1, ...cellPos(4, 4), { kind: 0, group: 0, spread: 0 });
  for (let i = 0; i < 10; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  await g.device.queue.onSubmittedWorkDone();
  const pages = new FieldPages(g.device, agents, { fields: 4, pages: 160 });
  const ring = (w.core.world as unknown as { ring: { idx(x: number, y: number): number } }).ring;
  const surf = (c: [number, number]) => ring.idx(c[0], c[1]) * NAV_K;
  const sweep = async (n: number) => {
    const enc = g.device.createCommandEncoder();
    pages.encode(enc, n);
    g.device.queue.submit([enc.finish()]);
    await g.device.queue.onSubmittedWorkDone();
  };
  const P = PLACES[kind];
  // (field 0 from A, settled)
  pages.seed([[0, surf(P.a)]]);
  await sweep(60);
  // (then its seed moved to B, far: the sweeps until the field is right within 40 cells of B, and everywhere)
  // (moved far: the field let go and refilled from its new seed — as the planes start a field over, FC4)
  pages.release(0);
  pages.seed([[0, surf(P.b)]]);
  const ref = bfs(kind, P.b);
  const cells: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (!walled(kind, x, y) && Number.isFinite(ref[y * W + x])) cells.push(y * W + x);
  const near = cells.filter((c) => ref[c] <= 40);
  const gap = async (set: number[]) => {
    const r = await pages.read();
    let worst = 0;
    let under = 0;
    for (const c of set) {
      const got = r.dist(0, ring.idx(c % W, Math.floor(c / W)) * NAV_K);
      worst = Math.max(worst, Math.abs(got - ref[c]));
      if (got < ref[c] - 0.01) under++;
    }
    return { worst, under, used: r.used, refused: r.refused };
  };
  let react = -1;
  let all = -1;
  let last = { worst: 0, under: 0, used: 0, refused: 0 };
  for (let s = 2; s <= 400 && all < 0; s += 2) {
    await sweep(2);
    if (react < 0 && (await gap(near)).worst <= 1) react = s;
    if (react >= 0) {
      last = await gap(cells);
      if (last.worst <= 1) all = s;
    }
  }
  // (memory: the pages field 0 holds, against a plane over the whole window)
  const planeKb = (W * H * NAV_K * 4) / 1024;
  const pagesKb = last.used * 4;
  pages.destroy();
  expect(g.takeErrors()).toEqual([]);
  return { kind, reactFrames: react / 2, allFrames: all / 2, worst: last.worst, under: last.under, pagesUsed: last.used, refused: last.refused, pagesKb, planeKb };
}

test('§9b: relax over pages matches a CPU BFS on open ground, round a wall and an S-bend; 40 cells react within the gate', async () => {
  const out = [];
  for (const kind of ['open', 'wall', 'sbend'] as MapKind[]) out.push(await mapCase(kind));
  log(`pages ${JSON.stringify(out)}`);
  for (const r of out) {
    expect(r.allFrames, JSON.stringify(r)).toBeGreaterThan(0);
    expect(r.under, JSON.stringify(r)).toBe(0);
    // (the planes' gate: a 40-cell reaction within 10 frames of 2 sweeps)
    expect(r.reactFrames, JSON.stringify(r)).toBeGreaterThan(0);
    expect(r.reactFrames, JSON.stringify(r)).toBeLessThanOrEqual(10);
    expect(r.refused, JSON.stringify(r)).toBe(0);
  }
});

test('§9b: a field holds pages only where it reaches — memory follows the ground it covers, freed pages are reused', async () => {
  const map = tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.spawn(1, ...cellPos(4, 4), { kind: 0, group: 0, spread: 0 });
  for (let i = 0; i < 10; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  await g.device.queue.onSubmittedWorkDone();
  // (three fields — three sides' — each reaching 20 cells round its own seed, in a pool of 48 pages)
  const pages = new FieldPages(g.device, agents, { fields: 3, pages: 48, reach: 20 });
  const ring = (w.core.world as unknown as { ring: { idx(x: number, y: number): number } }).ring;
  const surf = (x: number, y: number) => ring.idx(x, y) * NAV_K;
  const run = async (n: number) => {
    const enc = g.device.createCommandEncoder();
    pages.encode(enc, n);
    g.device.queue.submit([enc.finish()]);
    await g.device.queue.onSubmittedWorkDone();
  };
  pages.seed([[0, surf(20, 20)], [1, surf(100, 30)], [2, surf(60, 100)]]);
  await run(80);
  const a = await pages.read();
  // (field 1 let go and seeded elsewhere: its pages back to the pool, reused)
  pages.release(1);
  pages.seed([[0, surf(20, 20)], [1, surf(40, 70)], [2, surf(60, 100)]]);
  await run(80);
  const b = await pages.read();
  const at = (r: typeof a, f: number, x: number, y: number) => r.dist(f, surf(x, y));
  log(`reach: pages ${a.used} then ${b.used} (a plane each: ${3 * 64}), refused ${a.refused}/${b.refused}; f0 at 10 cells ${at(a, 0, 30, 20)}, at 30 ${at(a, 0, 50, 20)}; f1 at its new seed ${at(b, 1, 40, 70)}`);
  // (each field 20 cells round: a few chunks each, not the window's 64)
  expect(a.used).toBeLessThanOrEqual(48);
  expect(a.refused).toBe(0);
  expect(b.refused).toBe(0);
  expect(at(a, 0, 30, 20)).toBeCloseTo(10, 3);
  expect(at(a, 0, 50, 20)).toBe(Infinity);
  expect(at(b, 1, 40, 70)).toBe(0);
  expect(g.takeErrors()).toEqual([]);
  pages.destroy();
});

