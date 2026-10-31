// Round 120 (the user: "the mesh changes appearance and sometimes turns into blocks during falling"). A falling rock on
// the node solver is drawn from one pose from its break to its rest: its mesh skinned to the solver's nodes while its
// parent's mesh is split between the pieces (a ghost) and after, its own; never its CPU readback's matrix (a tick or two
// behind — its cells cast their shadow from there and darkened it in blocks). The browser probe (scripts/drawpath.mjs)
// checks the same on the rock lab, frame by frame; this is the rule.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { rockDrawFor } from '../../src/game/rockdraw';
import { bodyCatalogue, LINEUP } from '../../src/physics/shapes';
import { MODELS } from '../../src/world/models';
import { MAT } from '../../src/world/materials';

const sb = { slot: 3, restCom: [10, 11, 12] as [number, number, number], nodes: 17 };
const matrix = () => [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7];
const source = (d: ReturnType<typeof rockDrawFor>) => (d.skin ? `skin:${d.skin.slot}` : 'matrix');

describe('a falling rock on the node solver is drawn from one pose, break to rest', () => {
  test('split from its parent (no mesh of its own yet), then its own: skinned to the same nodes throughout', () => {
    const life = [rockDrawFor(-1, sb, matrix), rockDrawFor(-1, sb, matrix), rockDrawFor(42, sb, matrix), rockDrawFor(42, sb, matrix)];
    expect(new Set(life.map(source))).toEqual(new Set(['skin:3']));
    expect(life[0].skin).toEqual({ slot: 3, com: [10, 11, 12], nodes: 17 });
    expect(life[2].slot).toBe(42);
  });
  test('without the solver (the baseline) its CPU matrix throughout', () => {
    expect(new Set([rockDrawFor(-1, null, matrix), rockDrawFor(42, null, matrix)].map(source))).toEqual(new Set(['matrix']));
  });
});

describe('the rock mesh shader', () => {
  const wgsl = readFileSync(new URL('../../src/shaders/rockmesh.wgsl', import.meta.url), 'utf8');
  test("a ghost's vertex left out is marked gone, not sent off the clip volume (the streaks into the sky)", () => {
    const vs = wgsl.slice(wgsl.indexOf('fn vsRock'), wgsl.indexOf('@fragment'));
    const ghost = vs.slice(vs.indexOf('if (sh.w > 0.5 && sh.w < 1.5)'), vs.indexOf('var wp'));
    expect(ghost.length).toBeGreaterThan(100);
    expect(ghost).not.toMatch(/return o;/);
    expect(ghost).toMatch(/o\.gone = 1\.0/);
  });
  test("the sun's pass discards what the look does (gone, torn)", () => {
    expect(wgsl).toMatch(/fn fsRockZ\(in: ROut\)[\s\S]*?in\.gone > 0\.02 \|\| st > 1\.6/);
  });
});

describe('the drop tool', () => {
  test("drop all's line-up is in the catalogue: the tanker, the cars, the bus, a girder, the pylon, a house", () => {
    const ids = new Set(bodyCatalogue(MODELS, MAT).map((b) => b.id));
    for (const id of LINEUP) expect(ids.has(id), id).toBe(true);
    expect(LINEUP).toEqual(expect.arrayContaining(['model:tankertruck', 'model:car', 'model:bus', 'girder', 'model:pylon', 'model:house']));
  });
  test('the girder is an I: flanges top and bottom, a web between', () => {
    const g = bodyCatalogue(MODELS, MAT).find((b) => b.id === 'girder')!.make();
    const [w, d, h] = g.size;
    const at = (x: number, y: number, z: number) => g.vox[x + w * (y + d * z)];
    expect(at(0, 0, 0)).toBe(MAT.Steel);
    expect(at(0, 0, h - 1)).toBe(MAT.Steel);
    expect(at(0, 0, 1)).toBe(0);
    expect(at(0, 1, 1)).toBe(MAT.Steel);
  });
});
