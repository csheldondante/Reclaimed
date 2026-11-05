// (round 128m, quarry) The world's floor (layout.ts WORLD_FLOOR): a column's bottom goes on down to it as a rule, not
// data — a window cut under z 0 holds stone there, and nothing of it is kept outside the window.
import { describe, expect, it } from 'vitest';
import { joinColumn, splitColumn, WORLD_FLOOR, type Interval } from './layout';
import { MAT } from './materials';

const Z = 504;
const iv = (z0: number, z1: number, mat: number = MAT.Stone): Interval => ({ z0, z1, mat });
const plain = (c: Interval[]) => c.map((v) => [v.z0, v.z1, v.mat]);

describe('the world floor', () => {
  it('a window from z 0 up: as before, nothing kept under it', () => {
    const cut = splitColumn([iv(0, 50), iv(50, 52, MAT.Sand)], 0, Z);
    expect(plain(cut.inside)).toEqual([[0, 50, MAT.Stone], [50, 52, MAT.Sand]]);
    expect(cut.outside).toEqual([]);
  });

  it('a window higher up keeps what lies under it from z 0, as before', () => {
    const cut = splitColumn([iv(0, 50), iv(50, 52, MAT.Sand)], 32, Z);
    expect(plain(cut.outside)).toEqual([[0, 32, MAT.Stone]]);
    expect(plain(cut.inside)).toEqual([[0, 18, MAT.Stone], [18, 20, MAT.Sand]]);
  });

  it('a window under z 0 holds the floor’s stone (down to WORLD_FLOOR at most), nothing kept outside', () => {
    const cut = splitColumn([iv(0, 50)], -64, Z);
    expect(plain(cut.inside)).toEqual([[0, 114, MAT.Stone]]);
    expect(cut.outside).toEqual([]);
    const deepest = splitColumn([iv(0, 50)], WORLD_FLOOR, Z);
    expect(plain(deepest.inside)).toEqual([[0, 350, MAT.Stone]]);
  });

  it('a loose bottom: stone under it', () => {
    const cut = splitColumn([iv(0, 3, MAT.Sand)], -10, Z);
    expect(plain(cut.inside)).toEqual([[0, 10, MAT.Stone], [10, 13, MAT.Sand]]);
    expect(splitColumn([iv(0, 3, MAT.Sand)], 32, Z).outside.map((v) => v.mat)).toEqual([MAT.Sand]);
  });

  it('a pit dug under z 0 keeps its depth through slides up and back down', () => {
    // (the window at -64; the column dug to world -50)
    const dug = [iv(0, 14)];
    const world = joinColumn(dug, -64, []);
    expect(plain(world)).toEqual([[-64, -50, MAT.Stone]]);
    // (the window back at 0: the column is out of it, kept as a metre of stone under its top)
    const up = splitColumn(world, 0, Z);
    expect(up.inside).toEqual([]);
    expect(plain(up.outside)).toEqual([[-51, -50, MAT.Stone]]);
    // (and down again: the floor under it, the top where it was)
    const again = splitColumn(joinColumn(up.inside, 0, up.outside), -64, Z);
    expect(plain(again.inside)).toEqual([[0, 14, MAT.Stone]]);
    expect(again.outside).toEqual([]);
  });

  it('a pit floor with sand on it: the sand the bottom once out of the window, the floor under it again', () => {
    const world = joinColumn([iv(0, 14), iv(14, 15, MAT.Sand)], -64, []);
    const up = splitColumn(world, 0, Z);
    expect(plain(up.outside)).toEqual([[-50, -49, MAT.Sand]]);
    const again = splitColumn(joinColumn(up.inside, 0, up.outside), -64, Z);
    expect(plain(again.inside)).toEqual([[0, 14, MAT.Stone], [14, 15, MAT.Sand]]);
  });

  it('a column that starts above z 0 isn’t taken down', () => {
    const cut = splitColumn([iv(5, 9)], -20, Z);
    expect(plain(cut.inside)).toEqual([[25, 29, MAT.Stone]]);
  });
});
