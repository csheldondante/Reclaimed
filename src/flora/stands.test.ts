// The map's flora pass (round 128, treegen): conifers in stands and glades in the canopy (vegplan.wgsl treeSpecies, its
// CPU port api/plants.ts treeSpeciesAt — test/gpu/flora-plan.test.ts checks the two agree column by column).
import { describe, expect, it } from 'vitest';
import { inGlade, planTree } from '../api/plants';

const N = 900;
const org: [number, number] = [3100, -2200];

describe('stands and glades', () => {
  // the tree slots of a big window of woodland (succession 4.2: woods, no lone giants)
  const at = new Map<string, string>();
  let slots = 0;
  let glades = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const t = planTree(x, y, 4.2, N, N, org);
      if (t) {
        slots++;
        at.set(`${x},${y}`, t.species);
      } else if (inGlade(x, y, 4.2, N, N, org)) {
        slots++;
        glades++;
      }
    }
  const trees = [...at.values()];
  const share = (s: string) => trees.filter((t) => t === s).length / trees.length;

  it('about the same mix as before over the land (the old hash: conifers 42%)', () => {
    expect(trees.length).toBeGreaterThan(1500);
    expect(share('conifer')).toBeGreaterThan(0.25);
    expect(share('conifer')).toBeLessThan(0.55);
    expect(share('birch')).toBeGreaterThan(0.1);
    expect(share('broadleaf')).toBeGreaterThan(0.15);
  });
  it('glades: some slots left empty, not most', () => {
    expect(glades / slots).toBeGreaterThan(0.03);
    expect(glades / slots).toBeLessThan(0.25);
  });
  it('conifers stand together: a conifer’s nearest trees are conifers far more often than the land’s share', () => {
    const pts = [...at.entries()].map(([k, s]) => {
      const [x, y] = k.split(',').map(Number);
      return { x, y, s };
    });
    let same = 0;
    let n = 0;
    for (const p of pts) {
      if (p.s !== 'conifer') continue;
      for (const q of pts) {
        if (q === p) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d > 40) continue;
        n++;
        if (q.s === 'conifer') same++;
      }
      if (n > 20000) break;
    }
    expect(same / n).toBeGreaterThan(share('conifer') + 0.15);
  });
});
