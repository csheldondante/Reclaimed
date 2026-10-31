// (round 117, flora) The contract's placement and passability on made-up fields: a meadow, a thicket, a wood.
import { describe, expect, it } from 'vitest';
import { FloraWorld, type FloraSource } from './index';
import { fit } from './placement';
import { coverage, passage, MUST_CUT } from './passability';
import { SPECIES } from './species';
import type { FloraCaps } from '../api/contracts/flora';

const ROW_H = Math.sqrt(3) / 2;
const field = (v: (cx: number, cy: number) => number, w = 96, h = 96): FloraSource => ({
  dims: () => ({ w, h }),
  origin: () => [0, 0],
  veg: (cx, cy) => v(cx, cy),
});
const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0: y0 * ROW_H, x1, y1: y1 * ROW_H });
const walker: FloraCaps = { mass: 1, speed: 4, cuts: false, flies: false, height: 2 };
const knight: FloraCaps = { mass: 3, speed: 8, cuts: true, flies: false, height: 2.5 };
const swordsman: FloraCaps = { mass: 1, speed: 4, cuts: true, flies: false, height: 2 };
const bird: FloraCaps = { mass: 0, speed: 10, cuts: false, flies: true, height: 0.5 };

describe('fit (niches)', () => {
  it('reeds on a wet bank, ferns in the shade, birch in an open wood, moss on wet rock, nothing on bare dry rock', () => {
    expect(fit({ veg: 1.5, moisture: 0.9, light: 0.9, altitude: 1, slope: 0.2, host: 'bank' })[0].id).toBe('reed');
    expect(fit({ veg: 4, moisture: 0.7, light: 0.2, altitude: 10, slope: 0.3, host: 'cave' })[0].id).toBe('fern');
    expect(fit({ veg: 4.5, moisture: 0.55, light: 0.8, altitude: 30, slope: 0.2, host: 'ground' }).map((f) => f.id)).toContain('birch');
    expect(fit({ veg: 1, moisture: 0.7, light: 0.4, altitude: 20, slope: 3, host: 'rock' })[0].id).toBe('moss');
    expect(fit({ veg: 0, moisture: 0, light: 1, altitude: 20, slope: 0.1, host: 'ground' })).toEqual([]);
  });
  it('a wall carries ivy and moss only', () => {
    const ids = fit({ veg: 3, moisture: 0.6, light: 0.6, altitude: 10, slope: 50, host: 'wall' }).map((f) => f.id).sort();
    expect(ids).toEqual(['ivy', 'moss']);
  });
});

describe('passability model', () => {
  const shrub = { barrier: SPECIES.shrub.barrier, radius: 1.4, height: 2, trunkOnly: false };
  const grass = { barrier: SPECIES.tallgrass.barrier, radius: 0.5, height: 1.2, trunkOnly: false };
  it('coverage rises with plants and never passes 1', () => {
    expect(coverage([], 10)).toBe(0);
    const few = coverage([shrub], 50);
    const many = coverage(Array(40).fill(shrub), 50);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThan(1);
  });
  it('grass below the waist slows a tall walker less than a short one', () => {
    const g = Array(30).fill(grass);
    expect(coverage(g, 30, 4)).toBeLessThan(coverage(g, 30, 1));
  });
  it('a thicket: a walker without a blade is blocked, a swordsman cuts slowly, a knight breaks through, a bird flies over', () => {
    const t = Array(40).fill(shrub);
    const w = passage(t, 30, walker);
    expect(w.density).toBeGreaterThan(MUST_CUT);
    expect(w.blocked).toBe(true);
    expect(w.cost).toBe(Infinity);
    const s = passage(t, 30, swordsman);
    expect(s.mustCut).toBe(true);
    expect(s.blocked).toBe(false);
    expect(s.speed).toBeLessThanOrEqual(0.35);
    const k = passage(t, 30, knight);
    expect(k.mustCut).toBe(false);
    expect(k.speed).toBeGreaterThan(s.speed);
    expect(passage(t, 30, bird)).toEqual({ density: 0, speed: 1, mustCut: false, blocked: false, cost: 1 });
  });
  it('open ground is free', () => {
    expect(passage([], 30, walker)).toMatchObject({ density: 0, speed: 1, blocked: false, cost: 1 });
  });
});

describe('FloraWorld (the contract on a made-up field)', () => {
  // west third bare, middle a meadow (2.2), east a wood (4.6)
  const src = field((cx) => (cx < 32 ? 0 : cx < 64 ? 2.2 : 4.6));
  const fw = new FloraWorld(src);
  it('lists its species and makes meshes', () => {
    expect(fw.library.species().map((s) => s.id)).toContain('birch');
    expect(fw.library.mesh('birch', 1).tris).toBeGreaterThan(100);
    expect(fw.library.variants('birch')).toBeGreaterThan(1);
    expect(() => fw.library.mesh('triffid', 1)).toThrow();
  });
  it('finds trees in the wood and none in the meadow', () => {
    expect(fw.placement.plantsIn(rect(66, 4, 94, 90)).filter((p) => p.species !== 'shrub').length).toBeGreaterThan(10);
    expect(fw.placement.plantsIn(rect(34, 4, 62, 90)).filter((p) => ['oak', 'pine', 'birch', 'giant'].includes(p.species))).toEqual([]);
  });
  it('bare ground is open; the meadow slows; the wood is passable (under the canopy) but slower', () => {
    const bare = fw.passability.passage(rect(2, 4, 30, 90), walker);
    const meadow = fw.passability.passage(rect(34, 4, 62, 90), walker);
    const wood = fw.passability.passage(rect(66, 4, 94, 90), walker);
    expect(bare.speed).toBe(1);
    expect(meadow.speed).toBeLessThan(1);
    expect(meadow.blocked).toBe(false);
    expect(wood.blocked).toBe(false);
    expect(fw.passability.density(rect(34, 4, 62, 90))).toBeGreaterThan(fw.passability.density(rect(2, 4, 30, 90)));
  });
  it('a shrub thicket (succession 3.2: shrubs, no trees) stops a walker without a blade', () => {
    const t = new FloraWorld(field(() => 3.2));
    const p = t.passability.passage(rect(10, 10, 60, 60), walker);
    expect(p.density).toBeGreaterThan(MUST_CUT);
    expect(p.blocked).toBe(true);
    expect(t.passability.passage(rect(10, 10, 60, 60), swordsman).blocked).toBe(false);
  });
});

describe('viewer scenes', () => {
  it('every biome builds, deterministically, with instances in range', async () => {
    const { buildScene, BIOMES } = await import('./scene');
    for (const b of BIOMES) {
      const s = buildScene(b.id, 3);
      const t = buildScene(b.id, 3);
      expect(Array.from(s.instances)).toEqual(Array.from(t.instances));
      const n = s.instances.length / 16;
      expect(n, b.id).toBeGreaterThan(10);
      expect(s.ranges.reduce((a, r) => a + r.count, 0)).toBe(n);
      for (let i = 0; i < n; i++) expect(s.instances[i * 16 + 12]).toBeLessThan(s.kinds.length);
      // each range's instances name its own kind
      s.ranges.forEach((r, k) => {
        for (let i = r.first; i < r.first + r.count; i++) expect(s.instances[i * 16 + 12]).toBe(k);
      });
    }
  });
  it('the birch wood is birches with leaves to fall from', async () => {
    const { buildScene } = await import('./scene');
    const s = buildScene('birchwood', 1);
    expect(s.crowns.length).toBeGreaterThan(50);
    expect(s.crowns.every((c) => c.species === 'birch')).toBe(true);
    expect(s.ground).toBe(1);
  });
  it('the ruin carries ivy on its walls and moss on its stones', async () => {
    const { buildScene } = await import('./scene');
    const s = buildScene('ruin', 2);
    const count = (sp: string) => s.ranges.filter((_, k) => s.kinds[k].species === sp).reduce((a, r) => a + r.count, 0);
    expect(count('ivy')).toBeGreaterThan(10);
    expect(count('moss')).toBeGreaterThan(10);
    expect(count('host')).toBeGreaterThan(5);
  });
});
