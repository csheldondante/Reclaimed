// PQ4 (the owner, 2026-11-15: "the pieces don't crumble as easily when they collide after breaking which looks way
// less cool"): a broken piece thrown at the ground at the speed its parent came down with must break as its parent
// did — it expands, and it sheds voxels or comes apart. Measured here against the ground alone: the other pieces are
// taken out of the world first (on the heap of its fellows the outcome goes either way: BACKLOG PR7).
// Until the rule was changed this was an expected failure: the piece did not deform at all. The expand rule weighed
// the hardest single contact's energy, 1/2 stop^2 / k with k the contact's inverse effective mass, against threshold
// x the whole mass (engine_pairs.wgsl tfine): a box landing flat has a contact under its centre of mass (k = 1/m, the
// whole energy counts), an irregular piece lying on a few points has none. The contacts are now weighed together, as
// one resultant at their centroid (docs/design/PHYSICS_ENGINE.md "Pieces are bodies", item 2).
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-rebreak --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE, worldG } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

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
const ASLEEP = 2;
const DEFORM = 8;

/** stepped till something deformed and nothing deforms any more; false if nothing ever deformed in `most` ticks */
async function settleAll(R: BreakRig, most = 900): Promise<boolean> {
  let began = false;
  for (let t = 0; t < most; t++) {
    await R.step(1);
    const P = await R.pool();
    if (P[POOL.deforming] > 0) began = true;
    else if (began) return true;
  }
  return false;
}

for (const [name, mat, density] of [['stone', MAT.Stone, 2.7], ['brick', MAT.Brick, 0]] as [string, number, number][]) {
  test(`a ${name} block's largest piece, thrown down at the speed its parent landed with, breaks again`, async () => {
    const R = await breakRig(g, flat);
    R.e.holdParts = false;
    const FALL = 24;
    const cells = box(12, 12, 10 + FALL, 6, 6, 4, mat);
    R.e.add({ cells, mesh: modelMesh(cells) })!;
    expect(await settleAll(R)).toBe(true);
    await R.step(2);
    let P1 = await R.pool();
    const parts1 = (await R.rows()).filter((r) => r.row % 2 === 1).sort((a, c) => c.mass - a.mass);
    const big = parts1[0];
    const bigVox = (await R.model(big.model)).solid;
    log(`${name} 6x6x4 from ${FALL}: ${parts1.length} parts (largest ${bigVox} voxels of 144), ${P1[POOL.crumbs]} voxels to the ground`);
    // The piece lies in the heap of its fellows, which are bodies too now (PM4). This test is of a piece's hit on the
    // ground alone, so the others are taken out of the world (expanded and let go: a test's way to end a row), and the
    // piece comes down the cell or two onto the ground and sleeps there.
    for (const o of parts1.slice(1)) {
      R.e.expand({ row: o.row });
      await R.step(3);
      R.e.release({ row: o.row });
      await R.step(3);
    }
    R.e.wake({ row: big.row });
    await R.step(30);
    for (let t = 0; t < 600 && !((await R.row(big.row)).flags & ASLEEP); t += 10) await R.step(10);
    const lies = await R.row(big.row);
    const left = (await R.rows()).filter((r) => r.row !== big.row).length;
    log(`the largest piece alone on the ground at ${lies.pos.map((x) => x.toFixed(1))} (${left} other rows left), ${lies.flags & DEFORM ? 'deforming' : 'rigid'}`);
    expect(left).toBe(0);
    expect(lies.flags & (ASLEEP | DEFORM)).toBe(ASLEEP);
    const rows1 = (await R.rows()).length;
    P1 = await R.pool();
    // the parent's landing speed, given to the piece where it lies on the ground
    const v = Math.sqrt(2 * worldG() * FALL);
    R.e.impulse({ row: big.row }, [0, 0, -v]);
    let hit = false;
    for (let t = 0; t < 4 && !hit; t++) {
      await R.step(1);
      hit = ((await R.row(big.row)).flags & DEFORM) !== 0;
    }
    expect(hit, 'the piece deforms on its second hit').toBe(true);
    expect(await settleAll(R)).toBe(true);
    await R.step(2);
    const P2 = await R.pool();
    const parts2 = await R.rows();
    const shed = P2[POOL.crumbs] - P1[POOL.crumbs];
    const more = parts2.length - rows1;
    log(`its largest piece thrown down at ${v.toFixed(1)} cells/s: ${more} more parts, ${shed} more voxels to the ground (${((100 * shed) / bigVox).toFixed(1)} % of it; the parent lost ${((100 * P1[POOL.crumbs]) / 144).toFixed(1)} %)`);
    // it cracked: it came apart, or it shed voxels
    expect(more > 0 || shed > 0).toBe(true);
    void density;
    R.w.destroy();
  });
}
