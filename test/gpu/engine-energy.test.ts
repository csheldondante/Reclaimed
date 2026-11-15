// The owner's physics rule: "Lose energy, never gain it." A break adds no speed: when bonds snap each part keeps the
// momentum its own voxels had, contacts between the new parts stop them closing and never push, and what a snapped
// bond lets go is drawn as chips and dust, never as speed (docs/design/PHYSICS_ENGINE.md, the look brief's item 1: the
// `burst` of PE37 is gone). Measured over a whole drop — rigid, the tick it expands, deforming, settled — tick by tick:
// the body's mechanical energy (its voxels' kinetic energy and their height against gravity) never rises, and its
// kinetic energy after the hit is never above what it had coming in.
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-energy --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE, worldG } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const log = (s: string) => {
  if (process.env.BREAK_LOG) console.log(s);
};
const DEFORM = 8;
const FLOOR = 10;

// (the last number: the most of what came in that may be moving sideways after the hit — a flat drop comes in with none.
// What is there is the landing's own: voxels sliding off each other as parts lean. With PE37's `burst` it was 0.29,
// 0.17 and 0.14 % for these three; without, 0.14, 0.07 and 0.04 %.)
for (const [name, mat, w, d, h, from, sideMax] of [
  ['stone 6x6x4 from 24 cells', MAT.Stone, 6, 6, 4, 24, 0.0021],
  ['stone 4x4x3 from 48 cells', MAT.Stone, 4, 4, 3, 48, 0.0012],
  ['brick 8x3x3 from 22 cells', MAT.Brick, 8, 3, 3, 22, 0.0009],
] as const) {
  test(`a break gains no energy: ${name}, every tick of the drop`, async () => {
    const R = await breakRig(g, flat);
    const cells = box(12, 12, FLOOR + from, w, d, h, mat);
    const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
    const G = worldG();
    const GV = G * (TUNE.voxels as Record<string, number>).gravity;
    let last = Infinity;
    let worst = 0;
    let worstAt = -1;
    let keIn = 0;
    let keAfter = 0;
    let keSide = 0;
    let hit = -1;
    let done = false;
    let scale = 1;
    for (let t = 0; t < 900 && !done; t++) {
      await R.step(1);
      const row = await R.row(b.row);
      let ke = 0;
      let pe = 0;
      let side = 0;
      if (row.flags & DEFORM) {
        if (hit < 0) hit = t;
        const p = await R.particles(b.row);
        for (let k = 0; k < p.cells; k++) {
          if (p.x[k * 4 + 3] <= 0) continue;
          const m = 1 / p.x[k * 4 + 3];
          ke += 0.5 * m * (p.v[k * 4] ** 2 + p.v[k * 4 + 1] ** 2 + p.v[k * 4 + 2] ** 2);
          pe += m * GV * (p.x[k * 4 + 2] - FLOOR);
          side += 0.5 * m * (p.v[k * 4] ** 2 + p.v[k * 4 + 1] ** 2);
        }
        if (t > hit) keSide = Math.max(keSide, side);
        // (the tick it expands its voxels have the row's speed: what it came in with)
        if (t === hit) keIn = ke;
        else keAfter = Math.max(keAfter, ke);
      } else if (hit < 0) {
        ke = 0.5 * row.mass * (row.v[0] ** 2 + row.v[1] ** 2 + row.v[2] ** 2);
        pe = row.mass * G * (row.pos[2] - FLOOR);
        scale = Math.max(scale, ke + pe);
      } else {
        // settled: its parts are rows asleep (no speed), what crumbled lies on the ground
        for (const r of await R.rows()) pe += r.mass * G * (r.pos[2] - FLOOR);
        done = (await R.pool())[POOL.deforming] === 0;
      }
      const e = ke + pe;
      if (process.env.ENERGY_TRACE && hit >= 0 && t < hit + 30) log(`  tick ${t}: kinetic ${ke.toFixed(1)}, height ${pe.toFixed(1)}, sum ${e.toFixed(1)} (${(e - last).toFixed(2)})`);
      // (how far it stands above the least it has had so far: a rise over any stretch of ticks, not only one)
      last = Math.min(last, e);
      if (e - last > worst) {
        worst = e - last;
        worstAt = t;
      }
    }
    log(`${name}: kinetic energy coming in ${keIn.toFixed(1)}, the most at any tick after ${keAfter.toFixed(1)}, of it sideways ${keSide.toFixed(1)} (${((100 * keSide) / keIn).toFixed(3)} %); the most its mechanical energy ever stood above an earlier tick's ${worst.toFixed(2)} (${((100 * worst) / keIn).toFixed(3)} % of what came in; tick ${worstAt}, the hit at ${hit}); at the top of the fall ${scale.toFixed(0)}`);
    expect(hit).toBeGreaterThan(0);
    expect(done).toBe(true);
    expect(keAfter).toBeLessThanOrEqual(keIn);
    expect(keSide).toBeLessThan(sideMax * keIn);
    // What is not in this sum is the strain its bonds hold: brittle bonds give 1 % before they snap, and a body squeezed
    // by the landing comes back by that (measured: its voxels' mean height 0.014 cells, 0.06 % of what came in).
    // The bound is that give, five times over.
    expect(worst).toBeLessThan(0.003 * keIn);
    expect(g.takeErrors()).toEqual([]);
    R.w.destroy();
  });
}
