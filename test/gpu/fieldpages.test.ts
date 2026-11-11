// (U2 round 7, docs/design/UNIT_MINDS_U2.md §9b) The agents' fields on pages (gpu/pagepool.ts, fieldseam.wgsl): a
// field's values against a CPU breadth-first search on three maps (open, a wall with one gap, an S-bend) after its seed
// moved far; the 40 cells round the new seed right within 10 frames of 2 sweeps; memory following reach (the pages a
// field holds against the window's chunks); a field let go gives its pages back, and a page let go and handed out
// again is told from the old one by its generation.
//   PAGES_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { cellPos, nbr } from '../../src/world/lattice';
import { PP_HEADER } from '../../src/gpu/pagepool';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const H = 128;
const LOG = process.env.PAGES_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

type MapKind = 'open' | 'wall' | 'sbend';
/** a wall column 12 above the ground (no link up) */
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

async function setup(kind: MapKind) {
  const map = tinyMap(W, H, 32, (x: number, y: number) => [{ z0: 0, z1: walled(kind, x, y) ? 22 : 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  // (a unit so the agents peel the surfaces the fields relax over; the whole map kept in the fields' scope)
  agents.spawn(1, ...cellPos(4, 4), { kind: 0, group: 0, spread: 0 });
  agents.keepInScope('test', [cellPos(0, 0), cellPos(W - 1, H - 1)]);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  frame(10);
  await g.device.queue.onSubmittedWorkDone();
  return { agents, frame };
}

/** the field against the BFS: the worst gap and how many are under it, over the ground within `r` of `c` (all: r 0) */
async function compare(agents: ReturnType<typeof installAgents>, f: number, kind: MapKind, from: [number, number], r = 0) {
  const reader = agents.reader(f);
  await reader.refresh();
  const ref = bfs(kind, from);
  let worst = 0;
  let under = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      if (walled(kind, x, y)) continue;
      if (r > 0 && Math.hypot(x - from[0], y - from[1]) > r) continue;
      const [px, py] = cellPos(x, y);
      const s = reader.sample(px, py);
      const got = s ? s.dist : Infinity;
      const want = ref[y * W + x];
      const gap = got === Infinity && want === Infinity ? 0 : Math.abs(got - want);
      if (got < want - 1e-3) under++;
      if (gap > worst) worst = gap;
    }
  return { worst, under };
}

for (const kind of ['open', 'wall', 'sbend'] as MapKind[])
  test(`fields on pages match the BFS (${kind}): a seed moved far, right round it within 10 frames, everywhere after`, async () => {
    const { agents, frame } = await setup(kind);
    const f = agents.newField()!;
    const P = PLACES[kind];
    const at = (c: [number, number]) => {
      const [x, y] = cellPos(c[0], c[1]);
      return { x, y, z: 10 };
    };
    agents.seed(f, [at(P.a)]);
    frame(60);
    const a = await compare(agents, f, kind, P.a);
    log(`${kind} settled at A: ${JSON.stringify(a)}`);
    expect(a.worst).toBeLessThanOrEqual(1);
    agents.seed(f, [at(P.b)]);
    let near = -1;
    let all = -1;
    for (let fr = 1; fr <= 60 && all < 0; fr++) {
      frame(1);
      if (near < 0 && (await compare(agents, f, kind, P.b, 20)).worst <= 1) near = fr;
      if (near >= 0 && (await compare(agents, f, kind, P.b)).worst <= 1) all = fr;
    }
    const st = await agents.fields.stats();
    log(`${kind} moved to B: near ${near} frames, all ${all}; pages ${st.used} of ${st.pages}, refused ${st.refused}`);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThanOrEqual(10);
    expect(all).toBeGreaterThan(0);
    expect((await compare(agents, f, kind, P.b)).under).toBe(0);
    expect(st.refused).toBe(0);
  });

test('memory follows reach; a field let go gives its pages back; a page handed out again has a new generation', async () => {
  const { agents, frame } = await setup('open');
  const fs = [agents.newField()!, agents.newField()!, agents.newField()!];
  fs.forEach((f, i) => {
    agents.reach(f, 20);
    const [x, y] = cellPos(20 + 40 * i, 64);
    agents.seed(f, [{ x, y, z: 10 }]);
  });
  frame(40);
  const s1 = await agents.fields.stats();
  const slots = (W / 16) * (H / 16);
  log(`three fields reaching 20: ${s1.used} pages (${((s1.used * agents.fields.o.pageWords * 4) / 1024).toFixed(0)} KB) against ${3 * slots} for three whole-window fields`);
  expect(s1.used).toBeGreaterThan(0);
  expect(s1.used).toBeLessThan(slots);
  // (field 0's first page and its generation, then the field let go, another seeded where it was)
  const before = await agents.fields.readAll();
  const L = agents.fields.layout;
  const row = [...before.ctl.subarray(L.table + fs[0] * slots, L.table + (fs[0] + 1) * slots)];
  const pg1 = row.find((v) => v > 0)!;
  const gen0 = before.ctl[L.gen + pg1 - 1];
  agents.freeField(fs[0]);
  agents.seed(fs[1], []);
  frame(2);
  const f4 = agents.newField()!;
  expect(f4).toBe(fs[0]);
  agents.reach(f4, 20);
  const [x, y] = cellPos(20, 64);
  agents.seed(f4, [{ x, y, z: 10 }]);
  frame(40);
  const after = await agents.fields.readAll();
  const s2 = await agents.fields.stats();
  log(`a field let go, one seeded where it was: ${s2.used} pages, refused ${s2.refused}, the pool's end ${after.ctl[PP_HEADER.end]}`);
  // (no more pages handed out off the pool's end than the first time: the let-go ones came back first)
  expect(after.ctl[PP_HEADER.end]).toBeLessThanOrEqual(before.ctl[PP_HEADER.end] + 2);
  // (the old page id read again: its generation moved on — a reader holding (page, generation) sees it's stale)
  expect(after.ctl[L.gen + pg1 - 1]).toBeGreaterThan(gen0);
});
