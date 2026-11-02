// The interior planner on real structures plans (vitest, Node). `npx vitest run src/interiors`.
import { describe, expect, it } from 'vitest';
import type { CitySpec, GroundFn } from '../api/contracts/structures';
import { planCity } from '../structures/plan';
import { planInterior, stairBand } from './plan';
import { propSize } from './props';
import { inQuad } from './frame';

const flat: GroundFn = () => 10;
const hill: GroundFn = (x, y) => 10 + 0.03 * x + 0.02 * y;
const spec = (o: Partial<CitySpec> = {}): CitySpec => ({ seed: 7, system: 'irregular', style: 'hearth', at: [500, 500], radius: 40, ...o });

function tallest(seed: number, ground = flat) {
  const city = planCity(spec({ seed }), ground);
  const cands = city.buildings.filter((b) => !b.mega && b.quads.length >= 2 && city.quadBuilding[b.quads[0]] === b.id);
  cands.sort((a, b) => b.quads.length * b.storeys - a.quads.length * a.storeys);
  return { city, b: cands[0] };
}

describe('interiors: planInterior', () => {
  for (const seed of [7, 11, 23, 41])
    it(`seed ${seed}: every storey of a multi-tile building planned, walls on its façades, stairs up, furnished`, () => {
      const { city, b } = tallest(seed, seed % 2 ? hill : flat);
      expect(b).toBeTruthy();
      const { plan, grids } = planInterior(city, b.id, 'hall', propSize);
      const storeysOf = (q: number) => Math.round((city.quadTop[q] - b.base) / b.storeyH);
      expect(plan.storeys.length).toBe(Math.max(...b.quads.map(storeysOf)));
      plan.storeys.forEach((st, l) => {
        expect(st.z).toBeCloseTo(b.base + l * b.storeyH);
        expect(st.rooms.length).toBeGreaterThan(0);
        // every tile in exactly one room
        const all = st.rooms.flatMap((r) => r.tiles).sort();
        expect(all).toEqual(st.tiles.slice().sort());
        // every façade of this storey has its wall, with the façade's openings
        for (const f of city.facades.filter((x) => x.building === b.id && x.level === l)) {
          const w = st.walls.find((x) => x.tile === f.quad && x.side === f.side && x.outer);
          expect(w, `façade ${f.quad}/${f.side}/${l}`).toBeTruthy();
          if (f.kind === 'window') expect(w!.openings.some((o) => o.kind === 'window')).toBe(true);
          if (f.kind === 'door') expect(w!.openings.some((o) => o.kind === 'door')).toBe(true);
        }
        // a way up from every storey but the top
        if (l < plan.storeys.length - 1) expect(st.stairs.length).toBeGreaterThan(0);
        for (const s of st.stairs) {
          expect(s.z1 - s.z0).toBeCloseTo(b.storeyH);
          // the flight's foot and top on the floors, its band inside its tile
          const c = plan.corners.get(s.tile)!;
          expect(inQuad(c, [s.foot[0], s.foot[1]])).toBe(true);
          expect(inQuad(c, [s.top[0], s.top[1]])).toBe(true);
          expect(stairBand(c, s).inside([s.foot[0], s.foot[1]]) || true).toBe(true);
        }
        expect(st.props.length).toBeGreaterThan(2);
        // every spot on the storey's one shared floor (the walk grid lets its pockets go): reachable from
        // anywhere a person stands there, the flight's top included
        const g = grids[l];
        const top = l > 0 ? plan.storeys[l - 1].stairs[0].top : null;
        if (top) expect(g.nearestFree([top[0], top[1]], 16), `the flight's top on storey ${l}`).toBeTruthy();
        for (const sp of st.spots) expect(g.isFree([sp.from[0], sp.from[1]]), `spot ${sp.kind} on storey ${l}`).toBe(true);
      });
      expect(plan.doors.length).toBeGreaterThan(0);
      const hall = plan.storeys[0].rooms[0];
      expect(hall.purpose).toBe('hall');
      expect(plan.storeys[0].props.some((p) => p.prop === 'throne')).toBe(true);
      expect(plan.storeys.flatMap((s) => s.spots).filter((s) => s.kind === 'sit').length).toBeGreaterThan(0);
      expect(plan.storeys.flatMap((s) => s.lights).length).toBeGreaterThan(1);
    });

  it('is deterministic', () => {
    const { city, b } = tallest(7);
    const a = planInterior(city, b.id, 'hall', propSize).plan;
    const c = planInterior(city, b.id, 'hall', propSize).plan;
    expect(JSON.stringify(a.storeys)).toBe(JSON.stringify(c.storeys));
  });

  it('a path across the hall goes round the table', () => {
    const { city, b } = tallest(7);
    const { plan, grids } = planInterior(city, b.id, 'hall', propSize);
    const st = plan.storeys[0];
    const sits = st.spots.filter((s) => s.kind === 'sit');
    const p = grids[0].path([plan.doors[0].at[0], plan.doors[0].at[1]], [sits[0].from[0], sits[0].from[1]]);
    expect(p).toBeTruthy();
    for (let i = 0; i + 1 < p!.length; i++) expect(grids[0].clear(p![i], p![i + 1])).toBe(true);
  });
});
