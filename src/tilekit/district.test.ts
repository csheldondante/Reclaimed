import { describe, expect, it } from 'vitest';
import { MURU_ANCHOR as anchor, muru } from './fixtures/muru';
import { buildDistrict, planDistrict } from './district';
import { patch, stripCells } from './strips';
import { THEMES } from './theme';

describe('district on the real grid', () => {
  for (const t of THEMES) {
    it(`${t.name}: plots, strips, facades and roofs`, () => {
      const m = muru();
      const plan = planDistrict(m, t, { anchor, radius: 24, seed: 1, plotCells: 18, alleyOdds: 0.45 });
      // every strip is a patch of the grid and the strips are disjoint
      const seen = new Set<number>();
      for (const s of plan.strips) {
        expect(patch(m, s.at[0][0], s.a, s.b)).not.toBeNull();
        for (const c of stripCells(s)) {
          expect(seen.has(c)).toBe(false);
          seen.add(c);
        }
      }
      for (const roof of ['strip', 'field'] as const) {
        const d = buildDistrict(m, t, plan, { roof, straighten: 0, sag: 0, wonk: 0, groundR: 30 });
        // the rule: no roof slope runs down into a taller wall (in the strip's own coordinates, exactly)
        if (roof === 'strip') expect(d.roofRule, String(d.stats.roofRuleBroken)).toBeLessThanOrEqual(1e-9);
        // every bay is a real piece of wall (no zero-length or inverted bays from the setback)
        for (const { bay } of d.bays) expect(bay.len).toBeGreaterThan(0.05);
        console.log(t.name, roof, JSON.stringify(d.stats), 'roofRule', d.roofRule.toFixed(4));
      }
      console.log(t.name, 'strips', plan.strips.map((s, i) => `${s.a}x${s.b}${plan.role[i][0]}`).join(' '), 'arches', plan.arches.length);
    });
  }
});
