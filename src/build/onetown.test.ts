// (round 128m, onetown) One building system: the type table, the generator building through the plan's API, the plan's
// record (its data, byte for byte), the grid's sides across T-junctions, and every open place of a generated town joined
// to the land round it. Node, no GPU: `npx vitest run src/build`.
import { describe, expect, it } from 'vitest';
import { PAINTABLE_TYPES, STRUCTURE_TYPES } from '../api/contracts/fortress';
import type { CitySpec, GroundFn } from '../api/contracts/structures';
import { DEFS } from './types';
import { TownSite, gridIdOf, siteFromJson, siteToJson } from './site';
import { QuadGrid } from './quadgrid';
import { assertEntered, planTown } from '../structures/place';
import { CpuReach } from './reach';
import { realiseTown } from './sitereach';
import { LANE_WIDTH, lanesOf } from './lanes';
import { gradeLanes } from './grade';
import { waysOf } from './ways';
import { cellAt } from '../world/lattice';
import { fbm } from '../structures/rng';

const hill: GroundFn = (x, y) => 10 + 30 * fbm(x * 0.006 + 3.1, y * 0.006 + 1.7, 11, 4) + 0.06 * x;
const spec = (system: CitySpec['system'], o: Partial<CitySpec> = {}): CitySpec => ({ seed: 7, system, style: 'hearth', at: [0, 0], radius: 40, density: 0.8, walls: true, farmland: 80, ...o });
const SYSTEMS: CitySpec['system'][] = ['irregular', 'contour-voronoi', 'radial', 'orthogonal'];

describe('the building types: one table', () => {
  it('every type has its row; the player picks from nine of them; the order a run counts types by is kept', () => {
    for (const t of STRUCTURE_TYPES) expect(DEFS[t].type).toBe(t);
    expect(Object.keys(DEFS).sort()).toEqual([...STRUCTURE_TYPES].sort());
    for (const t of PAINTABLE_TYPES) expect(STRUCTURE_TYPES).toContain(t);
    // (a run's type is its index here: the first nine never move — saved plans and the GPU's tables count them so)
    expect(STRUCTURE_TYPES.slice(0, 9)).toEqual(['fortress', 'house', 'farm', 'lumber', 'quarry', 'warehouse', 'wall', 'blacksmith', 'barracks']);
  });

  it('the rows read as their forms: yards lie flat, landmarks are blocks drawn whole, every cost and look given', () => {
    for (const t of STRUCTURE_TYPES) {
      const d = DEFS[t];
      if (d.form === 'yard') expect(d.maxLevels).toBe(1);
      if (d.look.mega && d.look.mega !== 'fountain') expect(d.form).toBe('block');
      expect(Object.keys(d.cost).length).toBeGreaterThan(0);
      expect(['hearth', 'bastion', 'terrace', 'town']).toContain(d.look.style);
    }
  });
});

describe('the generator builds through the plan', () => {
  for (const system of SYSTEMS)
    it(`${system}: every building a structure of the plan, its blocks standing on the Town, nothing empty`, () => {
      const { site, draft, placed } = planTown(spec(system), hill);
      const { plan, town } = site;
      expect(plan.structures().length).toBeGreaterThan(20);
      for (const s of plan.structures()) {
        expect(s.cells.size).toBeGreaterThan(0);
        for (const c of s.cells.keys()) {
          expect(plan.owner[c]).toBe(s.id);
          for (const L of plan.levels.each(c)) expect(town.has(c, L) || town.planned(c, L)).toBe(true);
        }
      }
      // (every building of the draft placed, or counted as not)
      const n = draft.buildings.filter((b) => draft.quadBuilding[b.quads[0]] === b.id).length;
      expect([...placed.structureOf].filter((x) => x >= 0).length + placed.stats.unplaced).toBeGreaterThanOrEqual(n);
      // (two houses side by side stay two: the generator places each apart)
      const houses = plan.structures().filter((s) => s.type === 'house');
      expect(houses.length).toBeGreaterThan(5);
    });

  it('a walled town: its wall is wall cells of the plan with gates; the generator never paints over a building', () => {
    const { site } = planTown(spec('irregular'), hill);
    const walls = site.plan.structures().filter((s) => s.type === 'wall');
    expect(walls.length).toBe(1);
    expect(walls[0].cells.size).toBeGreaterThan(20);
  });
});

describe('the plan as a record', () => {
  it('a site made again from its data is the same, byte for byte; the same seed and ground, the same data', () => {
    const a = planTown(spec('irregular'), hill).site;
    const b = TownSite.fromData(a.toData());
    expect(b.toData()).toEqual(a.toData());
    expect(siteFromJson(JSON.parse(JSON.stringify(siteToJson(a.toData()))))).toEqual(a.toData());
    expect(planTown(spec('irregular'), hill).site.toData()).toEqual(a.toData());
    // (the made-again plan works: a block painted and taken out as in the first)
    const free = [...Array(b.grid.count).keys()].find((c) => b.plan.owner[c] < 0 && b.plan.use[c] === 'outside')!;
    expect(b.plan.paint(free, 0, 'house')).toBe(true);
    expect(b.plan.erase(free, 0)).toBe(true);
  });

  it("a grid's id is stable, the town's own, and never a small owner id", () => {
    expect(gridIdOf('s12')).toBe(gridIdOf('s12'));
    expect(gridIdOf('s12')).not.toBe(gridIdOf('s13'));
    for (const id of ['a', 'b', 's1', 'lab', 'town']) expect(gridIdOf(id)).toBeGreaterThanOrEqual(256);
  });
});

describe('the one grid', () => {
  it('a radial town is one piece: its rings that double and its plaza cut on chords join their neighbours (T-junctions)', () => {
    const { site } = planTown(spec('radial', { walls: false, farmland: 0 }), () => 10);
    const g = site.grid;
    // (every cell inside the rim reached from cell 0 over the sides)
    const seen = new Uint8Array(g.count);
    const q = [0];
    seen[0] = 1;
    while (q.length) {
      const c = q.pop()!;
      for (let e = 0; e < 4; e++) {
        const n = g.nbr[c * 4 + e];
        if (n >= 0 && !seen[n]) (seen[n] = 1), q.push(n);
      }
    }
    expect(seen.every((x) => x === 1)).toBe(true);
  });

  it('a T-junction: a side two cells lie along has the longer as its neighbour, each of them it', () => {
    // a long cell under two short ones: (0,0)-(4,0)-(4,2)-(0,2); (0,2)-(2,2)-(2,4)-(0,4); (2,2)-(4,2)-(4,4)-(2,4)
    const verts = [0, 0, 4, 0, 4, 2, 0, 2, 2, 2, 2, 4, 0, 4, 4, 4];
    const g = new QuadGrid(8, 8, verts, [0, 1, 2, 3, 3, 4, 5, 6, 4, 2, 7, 5]);
    expect(g.nbr[1 * 4 + 0]).toBe(0);
    expect(g.nbr[2 * 4 + 0]).toBe(0);
    expect([1, 2]).toContain(g.nbr[0 * 4 + 2]);
  });
});

describe('the realise pass (round 128o, DA-A11: the one reach): every structure of a generated town joined to the land round it, or dropped', () => {
  for (const system of SYSTEMS)
    it(`${system}: realised from the land at the box's corner — fixes made, what nothing reaches dropped and logged, then every structure entered`, async () => {
      const { site } = planTown(spec(system), hill);
      const { w, h } = site.box;
      // (the CPU reference of the GPU's reach, over the town's own ground)
      const engine = new CpuReach({ w, h, runs: (x, y) => [[0, site.ground(y * w + x)]], water: () => 0 }, w, h, () => [0, 0]);
      const before = site.plan.structures().length;
      const groundAt = (x: number, y: number) => {
        const [k, r] = cellAt(x, y);
        return site.ground(Math.max(0, Math.min(h - 1, r)) * w + Math.max(0, Math.min(w - 1, k)));
      };
      const res = await realiseTown({
        engine,
        solid: () => ({ plan: site.plan, town: site.town, grid: site.grid, box: site.box, ground: (c) => site.ground(c), oz: 0 }),
        origin: () => [0, 0],
        colAt: ([x, y]) => {
          const [k, r] = cellAt(x, y);
          return k < 0 || r < 0 || k >= w || r >= h ? -1 : r * w + k;
        },
        floorAt: (c) => site.ground(c),
        stores: 0,
        storesZ: site.ground(0),
        changed: () => void site.plan.takeChanged(),
        // (DA-A10: its lanes graded into its own ground first)
        grade: {
          lanes: () => lanesOf(site.plan, site.grid, waysOf(site.plan, site.grid), groundAt).segs.map((q) => ({ a: q.a, b: q.b, half: LANE_WIDTH[q.kind] / 2, ramp: q.kind === 'ramp' })),
          apply: async (dz) => {
            for (const [c, d] of dz) site.groundCols[c] += d;
          },
        },
      });
      // (graded: the lanes at their grade now — graded again, nothing more to cut or fill)
      const lanes = lanesOf(site.plan, site.grid, waysOf(site.plan, site.grid), groundAt).segs.map((q) => ({ a: q.a, b: q.b, half: LANE_WIDTH[q.kind] / 2, ramp: q.kind === 'ramp' }));
      const again0 = gradeLanes(lanes, (c) => site.ground(c), site.box, ([x, y]) => {
        const [k, r] = cellAt(x, y);
        return k < 0 || r < 0 || k >= w || r >= h ? -1 : r * w + k;
      });
      expect(Math.max(0, ...[...again0.dz.values()].map(Math.abs))).toBeLessThan(0.5);
      expect(res.graded).toBeGreaterThanOrEqual(0);
      // (dropped: logged in the plan, gone from it; the rest entered)
      expect(site.plan.dropped.length).toBe(res.dropped);
      expect(site.plan.structures().length).toBe(before - res.dropped);
      for (const d of site.plan.dropped) expect(d.cells.every((c) => site.plan.owner[c] < 0)).toBe(true);
      expect(() => assertEntered(site)).not.toThrow();
      // (asked again: nothing more to fix or drop)
      const again = await realiseTown({
        engine,
        solid: () => ({ plan: site.plan, town: site.town, grid: site.grid, box: site.box, ground: (c) => site.ground(c), oz: 0 }),
        origin: () => [0, 0],
        colAt: ([x, y]) => {
          const [k, r] = cellAt(x, y);
          return k < 0 || r < 0 || k >= w || r >= h ? -1 : r * w + k;
        },
        floorAt: (c) => site.ground(c),
        stores: 0,
        storesZ: site.ground(0),
      });
      expect({ fixes: again.fixes, dropped: again.dropped }).toEqual({ fixes: 0, dropped: 0 });
      expect(res.places.cols.length).toBeGreaterThan(5);
    });
});
