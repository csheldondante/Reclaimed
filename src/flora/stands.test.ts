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
      const t = planTree(x, y, 4.2, N, N, org, () => 10);
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

describe('conifers on the slopes and the high ground (round 128: groundOf, vegplan.wgsl groundAt)', () => {
  const share = (top: (x: number, y: number) => number) => {
    let c = 0;
    let n = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const t = planTree(x, y, 4.2, N, N, org, top);
        if (!t) continue;
        n++;
        if (t.species === 'conifer') c++;
      }
    return c / n;
  };
  it('a steep hillside (a rise of 2 a column) is mostly conifers; flat land keeps the stands’ mix', () => {
    const flat = share(() => 10);
    const steep = share((x) => 10 + x * 2);
    expect(steep).toBeGreaterThan(0.75);
    expect(steep).toBeGreaterThan(flat + 0.3);
  });
  it('knolls: tops standing 8 over the land round them are mostly conifers', () => {
    // (a bump every 24 columns: the slot's own top high, the land GROUND_R out low — gentle, not steep, near the top)
    const knolls = (x: number, y: number) => 10 + 8 * Math.max(0, 1 - Math.hypot(((x % 24) - 12) / 6, ((y % 24) - 12) / 6) ** 2);
    let c = 0;
    let n = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (Math.hypot((x % 24) - 12, (y % 24) - 12) > 1.5) continue;
        const t = planTree(x, y, 4.2, N, N, org, knolls);
        if (!t) continue;
        n++;
        if (t.species === 'conifer') c++;
      }
    expect(n).toBeGreaterThan(5);
    expect(c / n).toBeGreaterThan(0.7);
  });
});
