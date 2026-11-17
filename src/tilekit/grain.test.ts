import { describe, expect, it } from 'vitest';
import lotsMuru from '../../data/lab/lots-muru.json';
import { cornerAngle, valences } from './grid';
import { famOf, grainGrid, lotsOf, roadSteps, squareness, valenceZones } from './grain';
import { labPlan, lotsAnchor, STEP3_GRID, windowAt } from './grainplan';

const words = new Uint32Array((lotsMuru as { lots: number[] }).lots);
const L = lotsOf(words);
const anchor = lotsAnchor(words);
const base = { ...windowAt(anchor), anchor, radius: 30, relax: 20, fair: 0 };
const irregular = (h: Record<number, number>) => Object.entries(h).reduce((s, [v, n]) => s + (Number(v) === 4 ? 0 : n), 0);

describe('grain grid', () => {
  it('no grain: the hashed pairing (the GPU grid) — valences as measured on the GPU grid', () => {
    const g = grainGrid(L, { ...base, grain: false, plan: { roads: [], plazas: [] } });
    const h = Object.fromEntries([...valences(g.mesh).entries()].sort((a, b) => a[0] - b[0]));
    console.log('no grain', g.mesh.nc, 'cells', JSON.stringify(h));
    // (step 1 on the GPU grid lab, 3 × 3 chunks: 3: 230, 4: 1963, 5: 169, 6: 21 — the same rules, so similar shares)
    const tot = Object.values(h).reduce((a, b) => a + b, 0);
    expect(h[4] / tot).toBeGreaterThan(0.75);
    expect(h[4] / tot).toBeLessThan(0.88);
  });

  it('grain without roads: every interior vertex of the district 4-valent', () => {
    const g = grainGrid(L, { ...base, grain: true, plan: { roads: [], plazas: [] } });
    const z = valenceZones(g.mesh, g.info);
    console.log('grain, no roads', JSON.stringify(z.zones), 'blocks', JSON.stringify(g.info.blocks));
    expect(Object.keys(z.zones.plots).map(Number)).toEqual([4]);
  });

  it('grain with the traced roads, plaza, alley and seam: singularities where the construction puts them', () => {
    const plan = labPlan(anchor);
    const g = grainGrid(L, { ...base, grain: true, plan, ...STEP3_GRID });
    const z = valenceZones(g.mesh, g.info);
    console.log('grain + roads', JSON.stringify(z.zones), 'blocks', JSON.stringify(g.info.blocks), 'square', JSON.stringify(squareness(g.mesh, g.info, cornerAngle)));
    // every block bounded by two lattice families only (the seam does that for the south block), each with its grain
    for (const b of g.info.blocks) expect(b.fams[b.grain]).toBe(0);
    // built ground of the district: all 4-valent
    expect(Object.keys(z.zones.plots).map(Number)).toEqual([4]);
    // on the open ground: exactly the plaza's centre (3) and the kept bend at the seam (5)
    expect(z.zones.open[3]).toBe(1);
    expect(z.zones.open[5]).toBe(1);
    expect(Object.keys(z.zones.open).map(Number).sort()).toEqual([3, 4, 5]);
    // without the seam the south block is bounded by all three families: more irregular vertices where it meets the road
    const g2 = grainGrid(L, { ...base, grain: true, plan: labPlan(anchor, 2), ...STEP3_GRID });
    const z2 = valenceZones(g2.mesh, g2.info);
    expect(g2.info.blocks.some((b) => b.fams.every((n) => n > 0))).toBe(true);
    expect(irregular(z2.zones.edge) + irregular(z2.zones.open)).toBeGreaterThan(irregular(z.zones.edge) + irregular(z.zones.open) - 1);
  });

  it('roads lie on grid lines: consecutive chain vertices share an edge, and the chain runs straight on through every vertex but its bends', () => {
    const plan = labPlan(anchor);
    const g = grainGrid(L, { ...base, grain: true, plan, ...STEP3_GRID });
    const m = g.mesh;
    const edges = new Set<string>();
    const cellsAt = new Map<number, number[]>();
    for (let c = 0; c < m.nc; c++) {
      for (let k = 0; k < 4; k++) {
        const a = m.cells[c * 4 + k];
        const b = m.cells[c * 4 + ((k + 1) % 4)];
        edges.add(a < b ? `${a},${b}` : `${b},${a}`);
        if (!cellsAt.has(a)) cellsAt.set(a, []);
        cellsAt.get(a)!.push(c);
      }
    }
    plan.roads.forEach((r, ri) => {
      const ch = g.info.chains[ri];
      const steps = roadSteps(r);
      expect(ch.length).toBe(steps.length * 2 + 1);
      // the chain's lattice points where the polyline turns (index 2s)
      const bends = new Set<number>();
      for (let s = 1; s < steps.length; s++) {
        const d0 = famOf(steps[s - 1][1][0] - steps[s - 1][0][0], steps[s - 1][1][1] - steps[s - 1][0][1]);
        const d1 = famOf(steps[s][1][0] - steps[s][0][0], steps[s][1][1] - steps[s][0][1]);
        if (d0 !== d1) bends.add(2 * s);
      }
      for (let i = 0; i + 1 < ch.length; i++) {
        const a = ch[i];
        const b = ch[i + 1];
        expect(edges.has(a < b ? `${a},${b}` : `${b},${a}`), `${r.name} step ${i}`).toBe(true);
      }
      for (let i = 1; i + 1 < ch.length; i++) {
        if (bends.has(i)) continue;
        // straight on: no cell holds the vertex before, this one and the one after (they'd make a corner of it)
        const v = ch[i];
        const turns = (cellsAt.get(v) ?? []).some((c) => {
          const q = [0, 1, 2, 3].map((k) => m.cells[c * 4 + k]);
          return q.includes(ch[i - 1]) && q.includes(ch[i + 1]);
        });
        expect(turns, `${r.name} turns at chain vertex ${i}`).toBe(false);
      }
    });
  });

  it('the squaring: GPU-like 20 steps leave the grain rhombic, the long relaxation squares it', () => {
    const plan = labPlan(anchor);
    const s20 = squareness(grainGrid(L, { ...base, grain: true, plan, relax: 20 }).mesh, grainGrid(L, { ...base, grain: true, plan, relax: 20 }).info, cornerAngle);
    const g = grainGrid(L, { ...base, grain: true, plan, ...STEP3_GRID });
    const sLong = squareness(g.mesh, g.info, cornerAngle);
    console.log('square 20', JSON.stringify(s20), 'square long', JSON.stringify(sLong));
    expect(s20.median).toBeGreaterThan(20);
    expect(sLong.median).toBeLessThan(8);
  });
});
