// The settlements' planner on the structures contract (round 119, STR15): a settlement's record, its people's profile and
// its box's ground → its town and farmland as a structures plan, the record's buildings, the spots its people go to.
// Node, no GPU: `npx vitest run src/settle`.
import { describe, expect, it } from 'vitest';
import type { Settlement } from '../api/contracts/settlement';
import { planSettlement, rasterColumns, type PlanInput } from './plan';
import { civById } from './catalogue';
import { MAT } from '../world/materials';
import { cellPos, ROW_H } from '../world/lattice';
import { standingPlan } from '../structures/plan';
import { piecesOf } from '../structures/pieces';
import { library } from '../structures/modules';

const W = 256;
const H = 288;

function input(size: Settlement['size'], civ = 'river-guilds', seed = 5): PlanInput {
  const N = W * H;
  const ground = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [wx, wy] = cellPos(x, y);
      ground[y * W + x] = 20 + 6 * Math.sin(wx * 0.02) * Math.cos(wy * 0.017) + 0.03 * wx;
    }
  const rec: Settlement = { id: 's7', name: 'Testford', region: 0, faction: null, at: [W / 2, (H / 2) * ROW_H], radius: 30, size, condition: 'thriving', grids: [], buildings: [], people: [], stores: {}, needs: [] };
  return { rec, civ: civById(civ), camp: null, seed, setting: 'plains', ruin: false, box: { x0: 0, y0: 0, w: W, h: H }, ground, water: new Float32Array(N), top: new Uint8Array(N).fill(MAT.Soil), veg: new Float32Array(N), sea: -100 };
}

describe('settlements on the structures contract', () => {
  it('a town: its buildings are the plan’s, their records and doors; sites and room to grow; fields worked', () => {
    const p = planSettlement(input('town'));
    const city = p.city;
    expect(city.buildings.length).toBeGreaterThan(20);
    // every standing building a record (its cells the plan's tiles); sites and free ones not yet
    const houses = p.rec.buildings.filter((b) => b.id.includes(':b'));
    expect(houses.length).toBe(city.buildings.filter((b) => p.standing[b.id] > 0).length);
    for (const b of houses) {
      const id = Number(b.id.split(':b')[1]);
      expect(b.cells).toEqual(city.buildings[id].quads);
    }
    expect(p.sites.length).toBe(2);
    for (const s of p.sites) expect(p.standing[s.building]).toBe(0);
    expect(p.free.length).toBeGreaterThan(0);
    expect(p.spots.filter((s) => s.kind === 'home').length).toBeGreaterThan(10);
    expect(p.spots.some((s) => s.kind === 'post')).toBe(true);
    expect(p.spots.filter((s) => s.kind === 'farm').length).toBeGreaterThan(2);
    expect(p.rec.buildings.some((b) => b.use.includes('farm'))).toBe(true);
    // the hall and the granary given out
    expect([...p.lotUse.values()]).toContain('hall');
    expect([...p.lotUse.values()]).toContain('granary');
  });

  it('the land gets only the ground works (stalls, piles, the quarry); the buildings are pieces, the far raster told where', () => {
    const inp = input('town');
    const p = planSettlement(inp);
    for (const [col, cp] of p.columns) {
      const top = cp.ivs.length ? cp.ivs[cp.ivs.length - 1].z1 : cp.lo;
      // (nothing as tall as a house: a crane's mast at most)
      expect(top - inp.ground[col]).toBeLessThan(8);
    }
    const r = rasterColumns(p, MAT.Tile, MAT.Stone);
    const tall = (m: Map<number, { ivs: unknown[] }>) => [...m.values()].filter((c) => c.ivs.length).length;
    expect(tall(r)).toBeGreaterThan(tall(p.columns) + 200);
  });

  it('density by size: a hamlet is mostly huts, a city mostly town houses; the farmland has farmsteads', () => {
    const hamlet = planSettlement(input('hamlet', 'free-folk', 3)).city.buildings;
    const city = planSettlement(input('city', 'river-guilds', 3)).city.buildings;
    const share = (bs: typeof city, k: string) => bs.filter((b) => b.kind === k).length / bs.filter((b) => b.kind === 'house' || b.kind === 'hut').length;
    expect(share(hamlet, 'hut')).toBeGreaterThan(0.6);
    expect(share(city, 'house')).toBeGreaterThan(0.5);
    expect(city.some((b) => b.kind === 'farmhouse') || hamlet.some((b) => b.kind === 'farmhouse')).toBe(true);
  });

  it('a site raised storey by storey: its walls rise, its roof only when it’s done', () => {
    const p = planSettlement(input('town'));
    const s = p.sites[0];
    const b = p.city.buildings[s.building];
    const lib = library();
    const roofs = (st: Int32Array) => {
      const pc = piecesOf(standingPlan(p.city, st));
      let n = 0;
      for (let i = 0; i < pc.count; i++) if (pc.building[i] === b.id && lib.modules[pc.module[i]].name.startsWith('roof:')) n++;
      return n;
    };
    const st = p.standing.slice();
    st[b.id] = Math.max(1, b.storeys - 1);
    if (b.storeys > 1) expect(roofs(st)).toBe(0);
    st[b.id] = b.storeys;
    expect(roofs(st)).toBeGreaterThan(0);
  });

  it('the same seed and ground, the same settlement', () => {
    const a = planSettlement(input('village'));
    const c = planSettlement(input('village'));
    expect(c.rec.buildings.map((b) => b.id)).toEqual(a.rec.buildings.map((b) => b.id));
    expect(Array.from(c.standing)).toEqual(Array.from(a.standing));
  });
});
