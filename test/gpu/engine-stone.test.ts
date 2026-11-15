// The owner on the rigid lab (2026-11-15): "Rigid lab looks good for steel reinforced concrete but the stone is too
// rubbery (it should probably have very little elasticity)". DESIGN §10: "Rock shatters … Masonry has no tension",
// "deflect and topple, don't bounce". What stone does today on the engine route, measured in both its states, with
// the bounds it has to keep (BACKLOG PE35 has the diagnosis and what is left to do).
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-stone --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE } from '../../src/tune/params';
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
const ASLEEP = 2;

test('deforming stone: a block from 24 cells barely rebounds, is still soon, and no bond it keeps is stretched far', async () => {
  const R = await breakRig(g, flat);
  T.stillT = 1e9;
  const cells = box(12, 12, 34, 6, 6, 4);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  const m = await R.model(b.model.id);
  let hit = -1;
  let low = Infinity;
  let rebound = 0;
  let stillAt = -1;
  let run = 0;
  let strain = 0;
  let squash = 0;
  for (let t = 0; t < 420; t++) {
    await R.step(1);
    if (!((await R.row(b.row)).flags & DEFORM)) continue;
    if (hit < 0) hit = t;
    const p = await R.particles(b.row);
    let z = 0;
    let n = 0;
    let sp = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < p.cells; k++) {
      if (p.x[k * 4 + 3] < 0) continue;
      n++;
      z += p.x[k * 4 + 2];
      lo = Math.min(lo, p.x[k * 4 + 2]);
      hi = Math.max(hi, p.x[k * 4 + 2]);
      sp += Math.hypot(p.v[k * 4], p.v[k * 4 + 1], p.v[k * 4 + 2]);
      // every bond it still holds, by its length against its rest length (the 13 neighbours ahead: each bond once)
      for (let q = 13; q < 26; q++) {
        if (!(p.bonds[k] & (1 << q))) continue;
        const j = q + 1;
        const o = (j % 3) - 1 + 6 * ((Math.floor(j / 3) % 3) - 1) + 36 * (Math.floor(j / 9) - 1);
        const kk = k + o;
        if (kk < 0 || kk >= p.cells || p.x[kk * 4 + 3] < 0) continue;
        const d = Math.hypot(p.x[k * 4] - p.x[kk * 4], p.x[k * 4 + 1] - p.x[kk * 4 + 1], p.x[k * 4 + 2] - p.x[kk * 4 + 2]);
        const r = Math.hypot(m.recs[k * 4] - m.recs[kk * 4], m.recs[k * 4 + 1] - m.recs[kk * 4 + 1], m.recs[k * 4 + 2] - m.recs[kk * 4 + 2]);
        strain = Math.max(strain, Math.abs(d / r - 1));
      }
    }
    z /= n;
    if (z < low) low = z;
    else rebound = Math.max(rebound, z - low);
    // (how far its height, top voxel to bottom, is squeezed under the 3 cells it has at rest)
    if (t > hit + 2) squash = Math.max(squash, 3 - (hi - lo));
    run = sp / n < 0.4 ? run + 1 : 0;
    if (run >= 30 && stillAt < 0) stillAt = (t - 29 - hit) / 60;
  }
  log(`deforming stone 6x6x4 from 24 cells: mean rebound ${rebound.toFixed(3)} cells, still ${stillAt.toFixed(2)} s after the hit, the most a kept bond was stretched or squeezed ${(strain * 100).toFixed(1)} % (stone's break strain 4 %), its height squeezed at most ${squash.toFixed(2)} cells`);
  // the bounds today (measured 0.26 to 0.34 cells, 0.45 to 1.8 s): the owner's "very little elasticity" wants them lower
  expect(rebound).toBeLessThan(0.5);
  expect(stillAt).toBeGreaterThanOrEqual(0);
  expect(stillAt).toBeLessThan(2.5);
  // (a bond past the break strain snaps within the substep it is judged in: none is kept far beyond it)
  expect(strain).toBeLessThan(0.08);
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
});

test('rigid stone: a block landing under its break threshold — how far it sinks, how far it comes back up', async () => {
  const R = await breakRig(g, flat);
  const cells = box(12, 12, 20, 6, 6, 4);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  // (at rest its centre is 2 cells over the ground at 10)
  let low = Infinity;
  let back = 0;
  let asleep = -1;
  let touched = -1;
  for (let t = 0; t < 400 && asleep < 0; t++) {
    await R.step(1);
    const r = await R.row(b.row);
    expect(r.flags & DEFORM).toBe(0);
    if (r.pos[2] < 12.3 && touched < 0) touched = t;
    if (r.pos[2] < low) low = r.pos[2];
    else back = Math.max(back, r.pos[2] - low);
    if (r.flags & ASLEEP) asleep = t;
  }
  const rest = (await R.row(b.row)).pos[2];
  log(`rigid stone 6x6x4 from 10 cells: sank to ${(12 - low).toFixed(3)} cells into the ground at the lowest, came back up ${back.toFixed(3)} cells, rests ${(12 - rest).toFixed(3)} in; asleep ${((asleep - touched) / 60).toFixed(2)} s after it touched`);
  expect(asleep).toBeGreaterThan(0);
  // the bounds today; a rise of more than a few hundredths of a cell after the landing is what reads as rubber
  expect(back).toBeLessThan(0.5);
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
});
