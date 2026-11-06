// The settlements' planner on the structures contract (round 119, STR15): a settlement's record, its people's profile and
// its box's ground → its town and farmland as a structures plan, the record's buildings, the spots its people go to.
// Node, no GPU: `npx vitest run src/settle`.
import { describe, expect, it } from 'vitest';
import type { Settlement } from '../api/contracts/settlement';
import { planSettlement, rasterColumns, type PlanInput } from './plan';
import { civById } from './catalogue';
import { MAT } from '../world/materials';
import { cellPos, ROW_H } from '../world/lattice';
import { library } from '../structures/modules';
import { townPieces } from '../build/view';
import { typeIndex } from '../build/plan';

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
    // (onetown) every building that stands a record, its cells a structure's cells in the town's one plan; the sites are
    // structures planned with nothing built yet; the room to grow isn't in the plan yet
    const houses = p.rec.buildings.filter((b) => b.id.includes(':b'));
    expect(houses.length).toBeGreaterThan(20);
    const plan = p.site.plan;
    for (const b of houses) {
      const owners = new Set(b.cells.map((c) => plan.owner[c]));
      expect(owners.size).toBe(1);
      const sid = [...owners][0];
      expect(sid).toBeGreaterThan(0);
      expect(b.cells.every((c) => p.site.town.built.any(c))).toBe(true);
    }
    expect(p.sites.length).toBe(2);
    for (const s of p.sites) {
      const st = plan.structure(s.structure)!;
      expect(st.type).toMatch(/house|hut/);
      expect([...st.cells.keys()].some((c) => p.site.town.built.any(c))).toBe(false);
      expect([...st.cells.keys()].every((c) => p.site.town.plans.any(c))).toBe(true);
    }
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

  it('a site raised level by level: its walls rise, its roof only when it’s done (onetown: its blocks built in the plan)', () => {
    const p = planSettlement(input('town'));
    const s = p.sites[0];
    const site = p.site;
    const st = site.plan.structure(s.structure)!;
    const lib = library();
    const cells = new Set(st.cells.keys());
    const roofs = () => {
      const pc = townPieces(site, { ground: (x, y) => site.groundAt(x, y), ghost: (c, l) => !site.town.has(c, l) });
      let n = 0;
      for (let i = 0; i < pc.count; i++) {
        const o = i * 16;
        const c = site.grid.cellAtWorld((pc.data[o] + pc.data[o + 2] + pc.data[o + 4] + pc.data[o + 6]) / 4, (pc.data[o + 1] + pc.data[o + 3] + pc.data[o + 5] + pc.data[o + 7]) / 4);
        if (cells.has(c) && lib.modules[pc.module[i]].name.startsWith('roof:')) n++;
      }
      return n;
    };
    const raise = (n: number) => {
      for (const c of cells) for (const L of site.plan.levels.each(c)) if (L < n && !site.town.has(c, L)) site.town.add(c, L, st.id, typeIndex(st.type));
    };
    expect(roofs()).toBe(0);
    raise(Math.max(1, s.storeys - 1));
    if (s.storeys > 1) expect(roofs()).toBe(0);
    raise(s.storeys);
    expect(roofs()).toBeGreaterThan(0);
  });

  it('(merge124) a structure the world placed (a card\'s outcome) is raised as a landmark tower through the structures contract, with its uses', () => {
    const plain = planSettlement(input('town'));
    const p = planSettlement({ ...input('town'), placed: [{ id: 'burrows', name: 'the communal burrows', use: ['burrows', 'housing'] }] });
    expect(p.city.placed).toHaveLength(1);
    const b = p.city.buildings[p.city.placed![0].building];
    expect(b.mega).toBe('tower');
    const towers = (c: typeof p.city) => c.buildings.filter((x) => x.mega === 'tower').length;
    expect(towers(p.city)).toBe(towers(plain.city) + 1);
    const rec = p.rec.buildings.find((x) => x.use.includes('burrows'))!;
    expect(rec.use).toEqual(expect.arrayContaining(['burrows', 'housing']));
  });

  it('the same seed and ground, the same settlement', () => {
    const a = planSettlement(input('village'));
    const c = planSettlement(input('village'));
    expect(c.rec.buildings.map((b) => b.id)).toEqual(a.rec.buildings.map((b) => b.id));
    // (onetown: the town's one plan and what stands of it, the same byte for byte)
    expect(c.site.toData()).toEqual(a.site.toData());
  });
});
