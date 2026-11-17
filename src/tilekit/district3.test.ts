import { describe, expect, it } from 'vitest';
import lotsMuru from '../../data/lab/lots-muru.json';
import { buildDistrict, planDistrict } from './district';
import { grainGrid, lotsOf } from './grain';
import { labPlan, lotsAnchor, STEP3_BUILD, STEP3_GRID, STEP3_PLAN, windowAt } from './grainplan';
import { patch, sideBend, stripCells } from './strips';
import { THEMES } from './theme';

const words = new Uint32Array((lotsMuru as { lots: number[] }).lots);
const anchor = lotsAnchor(words);
const g = grainGrid(lotsOf(words), { ...windowAt(anchor), anchor, ...STEP3_GRID, grain: true, plan: labPlan(anchor) });
const m = g.mesh;

describe('step 3 district on the grained grid', () => {
  for (const t of THEMES) {
    it(`${t.name}: long strips, the roof rule, the roof union`, () => {
      const plan = planDistrict(m, t, { anchor, seed: 1, ...STEP3_PLAN });
      const seen = new Set<number>();
      for (const s of plan.strips) {
        expect(patch(m, s.at[0][0], s.a, s.b)).not.toBeNull();
        for (const c of stripCells(s)) {
          expect(seen.has(c)).toBe(false);
          seen.add(c);
        }
      }
      const d = buildDistrict(m, t, plan, { roof: 'strip', straighten: 0, sag: 0, wonk: 0, groundR: 40, ...STEP3_BUILD, checkUnion: true });
      expect(d.roofRule, String(d.stats.roofRuleBroken)).toBeLessThanOrEqual(1e-9);
      // nothing of one roof left inside another's solid (1 cm: the clipping's epsilon and the checker's sampling)
      expect(Number(d.stats.unionInside)).toBeLessThanOrEqual(0.01);
      expect(d.turrets.length).toBeLessThanOrEqual(2);
      // the main ranges: their longest side (metres) and its worst bend
      const mains = plan.strips.map((s, i) => ({ s, r: plan.role[i] })).filter((x) => x.r === 'main');
      const lens = mains.map(({ s }) => {
        let L = 0;
        for (let i = 0; i < s.a; i++) {
          const f = s.at[0][i];
          const a = m.cells[f.c * 4 + f.k];
          const b = m.cells[f.c * 4 + ((f.k + 1) % 4)];
          L += Math.hypot(m.xy[b * 2] - m.xy[a * 2], m.xy[b * 2 + 1] - m.xy[a * 2 + 1]);
        }
        let W = 0;
        for (let j = 0; j < s.b; j++) {
          const f = s.at[j][0];
          const a = m.cells[f.c * 4 + ((f.k + 3) % 4)];
          const b = m.cells[f.c * 4 + f.k];
          W += Math.hypot(m.xy[b * 2] - m.xy[a * 2], m.xy[b * 2 + 1] - m.xy[a * 2 + 1]);
        }
        return { long: +Math.max(L, W).toFixed(1), bend: +sideBend(m, s).toFixed(1), cells: s.a * s.b };
      });
      console.log(t.name, JSON.stringify(d.stats));
      console.log(t.name, 'mains', JSON.stringify(lens));
      console.log(t.name, 'strips', plan.strips.length, plan.strips.map((s, i) => `${s.a}x${s.b}${plan.role[i][0]}`).join(' '));
    });
  }
});
