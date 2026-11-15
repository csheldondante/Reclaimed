// Break faces shaped by the grain (the owner, 2026-11-15: "close the gap so that the shape resembles whole bricks or
// whatever the material grain is"; docs/design/PHYSICS_ENGINE.md "Look round 3"). The field is the parts' labels, and
// where it crosses an edge is where the grain's joint crosses it (engine_settle.wgsl cornerAt), so:
//  - a broken brick section's break faces lie on the bricks' joints — a brick's end, its side or its bed, each a plane
//    — not on the lattice's hex steps, and the outer faces end on them (every part closed);
//  - what is drawn carries its place in the grain's frame (the lattice of the body it first was): the same for a
//    vertex whether the body is rigid, deforming or settled into parts, so the look drawn there neither swims nor
//    jumps, and the two sides of a break carry one pattern.
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-grainface --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, openEdges, trisOf, type BreakRig } from './engine-rig';

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
const ROW_H = Math.sqrt(3) / 2;
const BREAK = 1 << 29;

async function settled(R: BreakRig): Promise<void> {
  let began = false;
  for (let t = 0; t < 900; t++) {
    await R.step(1);
    const n = (await R.pool())[POOL.deforming];
    if (n > 0) began = true;
    else if (began) return;
  }
  throw new Error('never settled');
}
/** how far a place in the grain's frame is from the nearest brick joint across each axis (the panel's bricks) */
function jointDist(p: number[]): number[] {
  const len = T.grainBrickLength;
  const k = Math.floor(p[2] / T.grainBrickCourse + 1e-3);
  const off = (z: number) => {
    const u = (p[0] + 0.25) / len + T.grainBrickOffset * z;
    return Math.abs(u - Math.round(u)) * len;
  };
  const v = p[1] / (T.grainBrickDepth * ROW_H);
  const w = p[2] / T.grainBrickCourse;
  // (a vertex on a bed joint is an end of the course under it or the one over it)
  return [Math.min(off(k), off(k - 1)), Math.abs(v - Math.round(v)) * T.grainBrickDepth * ROW_H, Math.abs(w - Math.round(w)) * T.grainBrickCourse];
}

test('a broken brick section: its break faces lie on the bricks\' joints, each a plane; every part is closed', async () => {
  const R = await breakRig(g, flat);
  const cells = box(8, 14, 32, 8, 3, 3, MAT.Brick);
  R.e.add({ cells, mesh: modelMesh(cells) })!;
  await settled(R);
  await R.step(2);
  const d = await R.drawn();
  let faces = 0;
  let onJoint = 0;
  let worst = 0;
  for (let t = 0; t < d.tris; t++) {
    if (!(d.word[t] & BREAK)) continue;
    const v = [0, 1, 2].map((c) => [...d.grain.subarray(t * 9 + c * 3, t * 9 + c * 3 + 3)]);
    if (Math.hypot(d.p[t * 9 + 3] - d.p[t * 9], d.p[t * 9 + 4] - d.p[t * 9 + 1], d.p[t * 9 + 5] - d.p[t * 9 + 2]) < 1e-6) continue;
    faces++;
    // the triangle lies on one joint plane: across some axis all three of its corners are on a joint
    const dist = v.map(jointDist);
    const off = Math.min(...[0, 1, 2].map((a) => Math.max(dist[0][a], dist[1][a], dist[2][a])));
    worst = Math.max(worst, off);
    if (off < 0.1) onJoint++;
  }
  const rows = await R.rows();
  log(`brick 8x3x3 from 22 cells: ${rows.length} parts, ${faces} break triangles, ${onJoint} of them on a joint's plane within 0.1 cells (the furthest ${worst.toFixed(3)})`);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(faces).toBeGreaterThan(20);
  // (brick's roughness is 0.03 cells; before the grain shaped the faces a brick's end followed the hex zigzag, 0.25
  // cells either side of the joint, and about a third of the break triangles lay on a joint's plane)
  expect(onJoint / faces).toBeGreaterThan(0.9);
  // each part closed: the outer faces end on the break faces (welded at 0.02 cells, no edge with an odd count)
  let open = 0;
  for (const r of rows) open += openEdges(trisOf(d, r.row));
  expect(open).toBe(0);
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
});

test('a vertex keeps its place in the grain\'s frame: rigid, the tick it expands, deforming, settled into parts', async () => {
  const R = await breakRig(g, flat);
  const cells = box(10, 12, 34, 6, 6, 4);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  await R.step(2);
  const rigid = await R.drawn();
  // rigid: the grain's frame is the lattice the cells were given in — a vertex stands within its body's box there
  for (let v = 0; v < rigid.tris * 3; v++) {
    const p = rigid.grain.subarray(v * 3, v * 3 + 3);
    expect(p[0]).toBeGreaterThan(9.9);
    expect(p[0]).toBeLessThan(17.1);
    expect(p[2]).toBeGreaterThan(33.9);
    expect(p[2]).toBeLessThan(38.1);
  }
  const key = (q: ArrayLike<number>, o: number) => `${Math.round(q[o] * 50)},${Math.round(q[o + 1] * 50)},${Math.round(q[o + 2] * 50)}`;
  const had = new Set<string>();
  for (let v = 0; v < rigid.tris * 3; v++) had.add(key(rigid.grain, v * 3));
  // deforming, then settled: every vertex of an outer face that no break runs through is drawn at a grain place the
  // rigid body had (the pattern goes with the piece); break faces lie inside the body's box
  await settled(R);
  await R.step(2);
  const after = await R.drawn();
  let outer = 0;
  let kept = 0;
  let far = 0;
  for (let t = 0; t < after.tris; t++) {
    if (after.row[t] === b.row) continue;
    for (let c = 0; c < 3; c++) {
      const o = (t * 3 + c) * 3;
      expect(after.grain[o]).toBeGreaterThan(9.4);
      expect(after.grain[o]).toBeLessThan(17.6);
      expect(after.grain[o + 2]).toBeGreaterThan(33.4);
      expect(after.grain[o + 2]).toBeLessThan(38.6);
      if (after.word[t] & BREAK) continue;
      outer++;
      if (had.has(key(after.grain, o))) {
        kept++;
        continue;
      }
      // (on a break's line: moved along the surface to the grain's joint, never further than a cell's corner is from
      // its middle from where a vertex of the rigid body stood)
      let near = Infinity;
      for (let v = 0; v < rigid.tris * 3; v++) near = Math.min(near, Math.hypot(rigid.grain[v * 3] - after.grain[o], rigid.grain[v * 3 + 1] - after.grain[o + 1], rigid.grain[v * 3 + 2] - after.grain[o + 2]));
      far = Math.max(far, near);
    }
  }
  log(`stone 6x6x4 from 24 cells: ${rigid.tris} triangles rigid; settled, ${outer} outer vertices, ${kept} of them at a grain place the rigid body had (the rest stand on a break's line, the furthest ${far.toFixed(3)} cells from where a vertex of the rigid body stood)`);
  expect(outer).toBeGreaterThan(300);
  expect(kept / outer).toBeGreaterThan(0.4);
  expect(far).toBeLessThan(0.6);
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
});
