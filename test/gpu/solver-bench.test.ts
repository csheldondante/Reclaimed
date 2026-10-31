// The physics experiment's scaling run (round 120: "Performance batteries … what is improved vs the cost"):
// SOLVER_BENCH=1 — 10, 50 and 200 awake bodies on the node solver and on the voxel lattice (physics/physics.ts,
// phys.wgsl), the same shapes (rock blocks 4³, steel girders 16 × 2 × 2), falling then landed: the GPU's work a tick,
// timed as wall time of a batch of ticks on Dawn (this machine's GPU; relative — the browser battery has the
// profiler's numbers). Written to data/perf/solver/scaling.json. Skipped otherwise (the suite stays fast).
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { Solver } from '../../src/solver/solver';
import { Physics } from '../../src/physics/physics';
import type { SolverCell } from '../../src/api/contracts/solver';
import { cellPos } from '../../src/world/lattice';
import { tinyMap } from '../support/tinymap';
import { testGpu } from './dawn';
import { tinyWorld } from './world';

const box = (w0: number, d: number, h: number, x0: number, y0: number, z0: number, mat: number): SolverCell[] => {
  const out: SolverCell[] = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w0; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};

test.skipIf(!process.env.SOLVER_BENCH)('scaling: node solver vs voxel lattice', async () => {
  const g = await testGpu();
  const rows: Record<string, unknown>[] = [];
  for (const n of [10, 50, 200]) {
    for (const kind of ['nodes', 'lattice'] as const) {
      const w = await tinyWorld(g, tinyMap(256, 256, 64, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), []);
      const solver = kind === 'nodes' ? new Solver(g.device, w.core.world, w.core.host.profiler) : null;
      const phys = kind === 'lattice' ? new Physics(g.device, w.core.world, w.core.host.profiler) : null;
      w.core.sim.systems.push((solver ?? phys)!);
      let voxels = 0;
      for (let i = 0; i < n; i++) {
        const x0 = 8 + (i % 14) * 17;
        const y0 = 8 + Math.floor(i / 14) * 17;
        const cells = i % 2 ? box(16, 2, 2, x0, y0, 30, MAT.Steel) : box(4, 4, 4, x0, y0, 30, MAT.Stone);
        voxels += cells.length;
        if (solver) solver.add({ cells });
        else {
          const lo = [x0, y0, 30];
          const set = new Set(cells.map((c) => `${c.x - lo[0]},${c.y - lo[1]},${c.z - lo[2]}`));
          const mat = cells[0].mat;
          phys!.spawnLattice(
            i % 2 ? [16, 2, 2] : [4, 4, 4],
            (x, y, z) => (set.has(`${x},${y},${z}`) ? mat : 0),
            (x, y, z) => {
              const [px, py] = cellPos(lo[0] + x, lo[1] + y);
              return [px, py, lo[2] + z + 0.5];
            },
          );
        }
      }
      const name = kind === 'nodes' ? 'solver' : 'physics';
      const time = async (ticks: number) => {
        await g.device.queue.onSubmittedWorkDone();
        const t0 = performance.now();
        for (let k = 0; k < ticks; k++) w.core.sim.step(w.core.globals, (s) => s.name === name);
        await g.device.queue.onSubmittedWorkDone();
        return (performance.now() - t0) / ticks;
      };
      await time(10);
      const falling = await time(60);
      // (landed: two seconds on, a tick a frame as the game runs them — readbacks in, so the sleepers fall asleep)
      for (let k = 0; k < 120; k++) {
        w.core.sim.step(w.core.globals, (s) => s.name === name);
        await g.device.queue.onSubmittedWorkDone();
        await new Promise((r) => setTimeout(r, 0));
      }
      const landed = await time(60);
      await new Promise((r) => setTimeout(r, 30));
      const row = { kind, bodies: n, asleep: phys ? phys.asleep.size : [...solver!.bodies].filter((b) => solver!.read(b)?.asleep).length, voxels, nodes: solver ? [...solver.bodies].reduce((s, b) => s + b.nodes, 0) : voxels, fallingMs: +falling.toFixed(3), landedMs: +landed.toFixed(3) };
      rows.push(row);
      console.log(JSON.stringify(row));
      expect(g.takeErrors()).toEqual([]);
      await solver?.destroy();
      w.destroy();
    }
  }
  fs.mkdirSync('data/perf/solver', { recursive: true });
  fs.writeFileSync('data/perf/solver/scaling.json', JSON.stringify({ at: new Date().toISOString(), what: 'wall ms a tick on Dawn (D3D12), this machine; 4³ stone blocks and 16 × 2 × 2 steel girders alternating', rows }, null, 1));
}, 600_000);
