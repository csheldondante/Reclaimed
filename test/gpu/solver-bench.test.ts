// The node solver's cost (BACKLOG AR4's budget: about 50 awake bodies at 60 fps on the phone). Run with SOLVER_BENCH=1:
// wall time of the GPU's work a tick (Dawn on this machine's GPU; a relative number, the browser's profiler gives
// the absolute), for rigid blocks and stiff metal bodies, falling and resting. Skipped otherwise (the suite stays fast).
import { expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { Solver } from '../../src/solver/solver';
import type { SolverCell } from '../../src/api/contracts/solver';
import { tinyMap } from '../support/tinymap';
import { testGpu } from './dawn';
import { tinyWorld } from './world';

const box = (w0: number, d: number, h: number, x0: number, y0: number, z0: number, mat: number): SolverCell[] => {
  const out: SolverCell[] = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w0; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};

test.skipIf(!process.env.SOLVER_BENCH)('cost a tick', async () => {
  const g = await testGpu();
  const w = await tinyWorld(g, tinyMap(128, 128, 64, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), []);
  const s = new Solver(g.device, w.core.world, w.core.host.profiler);
  w.core.sim.systems.push(s);
  const run = async (label: string, n: number) => {
    for (let i = 0; i < 10; i++) w.core.sim.step(w.core.globals, (x) => x.name === 'solver');
    await g.device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (x) => x.name === 'solver');
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 20));
    const asleep = [...s.bodies].filter((b) => s.read(b)?.asleep).length;
    console.log(`${label}: ${((performance.now() - t0) / n).toFixed(3)} ms a tick (${s.used} slots, ${asleep} asleep)`);
  };
  await run('empty', 60);
  for (let i = 0; i < 25; i++) s.add({ cells: box(4, 4, 4, 8 + (i % 5) * 20, 8 + Math.floor(i / 5) * 20, 30, MAT.Stone) });
  await run('25 rigid 4³ falling', 60);
  for (let i = 0; i < 25; i++) s.add({ cells: box(16, 2, 2, 4 + (i % 5) * 22, 14 + Math.floor(i / 5) * 20, 40, MAT.Steel) });
  await run('+25 steel girders falling', 60);
  await run('the 50, later', 120);
  await run('the 50, later still', 240);
  // (a pinned steel frame standing: woken whole, resting)
  for (let i = 0; i < 10; i++) s.add({ cells: box(2, 2, 20, 10 + i * 10, 110, 10, MAT.Steel), pinned: (c) => c.z === 10 });
  await run('+10 standing pinned steel posts', 240);
  expect(g.takeErrors()).toEqual([]);
  await s.destroy();
  w.destroy();
}, 120_000);
