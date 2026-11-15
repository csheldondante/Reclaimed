// The owner on the rigid lab (2026-11-15): "Rigid lab looks good for steel reinforced concrete but the stone is too
// rubbery (it should probably have very little elasticity)". DESIGN §10: "Rock shatters … Masonry has no tension",
// "deflect and topple, don't bounce". What stone does today on the engine route, measured in both its states, with
// the bounds it has to keep (BACKLOG PE35 has the diagnosis and what is left to do).
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-stone --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
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
  log(`deforming stone 6x6x4 from 24 cells: mean rebound ${rebound.toFixed(3)} cells, still ${stillAt.toFixed(2)} s after the hit, the most a kept bond was stretched or squeezed ${(strain * 100).toFixed(1)} % (stone's give ${(T.giveRock * 100).toFixed(1)} %), its voxels' spread in height changed by at most ${squash.toFixed(2)} cells (its parts lie apart)`);
  // The owner's "very little elasticity" (PE35). Before: rebound 0.25 to 0.34 cells, still 0.45 to 1.9 s after the hit,
  // kept bonds strained to 4 %. Now (no bounce, full ring damping, a give of 1 %, parting along the grain): 0.02 to
  // 0.03 cells, 0.05 s, 1.0 %. The lattice route is still in 0.33 to 0.82 s.
  expect(rebound).toBeLessThan(0.08);
  expect(stillAt).toBeGreaterThanOrEqual(0);
  expect(stillAt).toBeLessThan(0.5);
  // (a bond past its give snaps within the substep it is judged in: none is kept beyond it — nothing visibly flexes)
  expect(strain).toBeLessThan(0.015);
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
});

test('rigid stone: a block landing under its break threshold — how far it sinks, how far it comes back up', async () => {
  const R = await breakRig(g, flat);
  const cells = box(12, 12, 16, 6, 6, 4);
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
  log(`rigid stone 6x6x4 from 6 cells: sank to ${(12 - low).toFixed(3)} cells into the ground at the lowest, came back up ${back.toFixed(3)} cells, rests ${(12 - rest).toFixed(3)} in; asleep ${((asleep - touched) / 60).toFixed(2)} s after it touched`);
  expect(asleep).toBeGreaterThan(0);
  // the bounds today; a rise of more than a few hundredths of a cell after the landing is what reads as rubber
  expect(back).toBeLessThan(0.5);
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
});

// The lab's button "stone from three heights" (levels/playground.ts: a 4 x 4 x 3 block from 8, 24 and 48 cells): the
// owner's stone does not flex, it breaks — whole from the lowest, cracked into a few parts from the middle one,
// shattered into many from the highest. Each height in a world of its own (bodies do not meet each other yet).
test('stone from three heights: whole, cracked, many parts', async () => {
  const parts: number[] = [];
  for (const h of [8, 24, 48]) {
    const R = await breakRig(g, flat);
    const cells = box(10, 12, 10 + h, 4, 4, 3);
    const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
    let expanded = false;
    let done = false;
    for (let t = 0; t < 900 && !done; t += 5) {
      await R.step(5);
      const f = (await R.row(b.row)).flags;
      if (f & DEFORM) expanded = true;
      const pool = await R.pool();
      done = t > 60 && pool[POOL.deforming] === 0 && (expanded || (f & ASLEEP) !== 0);
    }
    expect(done).toBe(true);
    const rows = await R.rows();
    const pool = await R.pool();
    parts.push(rows.length);
    log(`stone 4x4x3 from ${h} cells: ${expanded ? 'broke' : 'stayed rigid'}, ${rows.length} part${rows.length === 1 ? '' : 's'} of ${rows.map((r) => Math.round(r.mass / 2.7)).join(', ')} voxels, ${pool[POOL.crumbs]} voxels to the ground`);
    expect(g.takeErrors()).toEqual([]);
    R.w.destroy();
  }
  expect(parts[0]).toBe(1);
  expect(parts[1]).toBeGreaterThanOrEqual(2);
  expect(parts[1]).toBeLessThanOrEqual(6);
  // (a block of 48 voxels has few grain cells: 6 parts or more, and more than from the middle height)
  expect(parts[2]).toBeGreaterThanOrEqual(6);
  expect(parts[2]).toBeGreaterThan(parts[1]);
});

// The lab's button "brick section on its side" (an 8 x 3 x 3 section from 22 cells) and "stone slab across the post"
// laid flat (12 x 4 x 3 from 30): a brittle body breaks into parts, it does not go to the ground as rubble. (Found in
// the first stills of the brittle numbers: the brick section left nothing at all — every brick apart, each under the
// crumb size, and its struck side ground away by a crush speed under the landing's.)
test('a brick section and a stone slab break into parts: most of each stays a body', async () => {
  const { MAT } = await import('../../src/world/materials');
  for (const [name, cells, mass] of [
    ['brick 8x3x3 from 22 cells', box(8, 14, 32, 8, 3, 3, MAT.Brick), 1.9],
    ['stone 12x4x3 from 30 cells', box(8, 12, 40, 12, 4, 3), 2.7],
  ] as const) {
    const R = await breakRig(g, flat);
    const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
    let expanded = false;
    let done = false;
    for (let t = 0; t < 900 && !done; t += 5) {
      await R.step(5);
      if ((await R.row(b.row)).flags & DEFORM) expanded = true;
      done = t > 60 && expanded && (await R.pool())[POOL.deforming] === 0;
    }
    expect(done).toBe(true);
    const rows = await R.rows();
    const kept = rows.reduce((s2, r) => s2 + r.mass / mass, 0);
    log(`${name}: ${rows.length} parts of ${rows.map((r) => Math.round(r.mass / mass)).join(', ')} voxels; ${Math.round(kept)} of ${cells.length} voxels stay bodies`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(kept / cells.length).toBeGreaterThan(0.7);
    expect(g.takeErrors()).toEqual([]);
    R.w.destroy();
  }
});

// Steel and wood keep their give (the owner: the "Rigid lab looks good for steel reinforced concrete"): the table the
// engine's deforming voxels read is the lattice route's but for the brittle materials.
test('the brittle numbers touch only brittle materials: steel and wood keep the lattice route\'s', async () => {
  const { Engine } = await import('../../src/engine/engine');
  const { packPhysMats } = await import('../../src/physics/physics');
  const { MAT } = await import('../../src/world/materials');
  const a = Engine.lattice();
  const b = packPhysMats();
  for (const m of [MAT.Steel, MAT.Wood, MAT.Rust, MAT.Canvas, MAT.Trash]) expect([...a.subarray(m * 16, m * 16 + 16)].map((x) => +x.toFixed(4))).toEqual([...b.subarray(m * 16, m * 16 + 16)].map((x) => +x.toFixed(4)));
  for (const m of [MAT.Stone, MAT.Brick, MAT.Concrete]) {
    expect(a[m * 16 + 5]).toBeLessThanOrEqual(0.02);
    expect(a[m * 16 + 4]).toBeLessThanOrEqual(0.015);
    expect(a[m * 16 + 12]).toBe(1);
  }
});
