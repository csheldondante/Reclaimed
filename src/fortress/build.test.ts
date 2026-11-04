// Fortress slice 1, milestone 2 and round 128d's fixes (Node, no GPU): a tap's face picks the cell beside it at the same
// height, the builders' order, a block's cost paid makes it stand and the stores go down by it, the fortress's power
// grows with its blocks and its height, farms read (ripe, fenced), blocks still to build drawn see-through.
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import { STRUCTURE_TYPES, type Goods } from '../api/contracts/fortress';
import { buildOrder } from '../agents/buildcrew';
import { LEVEL_H, Town } from '../build/town';
import { TownGrid } from '../build/towngrid';
import { library } from '../structures/modules';
import { DEFS, POWER_RISE } from './defs';
import { pickFace, placeFor } from './pick';
import { fortressPieces, LOOK_GHOST } from './pieces';
import { FortressPlan } from './plan';
import { BuildBook } from './work';
import { buildingLine, storesLine, typeCard } from './words';

const grid = new TownGrid(80, 92, { seed: 7 });
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
const inner = (() => {
  for (let c = 0; c < grid.count; c++) {
    const ok = [0, 1, 2, 3].every((e) => nbr(c, e) >= 0 && [0, 1, 2, 3].every((f) => nbr(nbr(c, e), f) >= 0));
    const [x, y] = grid.centre(c);
    if (ok && x > 30 && y > 30) return c;
  }
  throw new Error('no inner cell');
})();
const GROUND = 5;
const newTown = () => new Town(80, 92, { ground: () => GROUND, stamp: () => {}, zMax: Infinity }, { grid });

describe('a tap picks a face (the user: "clicking on the side to build next to it")', () => {
  const town = newTown();
  town.plan(inner, 0, true);
  town.plan(inner, 1, true);
  const has = (c: number, L: number) => town.occupied(c, L);
  const any = (c: number) => town.built.any(c) || town.plans.any(c);
  const floor = (c: number) => town.base[c];

  it('a ray into a side face gives the neighbouring cell at the same level', () => {
    for (let e = 0; e < 4; e++) {
      const n = nbr(inner, e);
      const [cx, cy] = grid.centre(inner);
      const [nx, ny] = grid.centre(n);
      for (const level of [0, 1]) {
        // a level ray from the neighbour's middle toward the block's, at that level's middle height
        const z = GROUND + 0.2 + (level + 0.5) * LEVEL_H;
        const d = [cx - nx, cy - ny, 0];
        const l = Math.hypot(d[0], d[1]);
        const hit = pickFace(grid, has, any, floor, [nx, ny, z], [d[0] / l, d[1] / l, 0], 20)!;
        expect(hit).not.toBeNull();
        expect(hit.face).toBe('side');
        expect(hit.cell).toBe(inner);
        expect(hit.level).toBe(level);
        expect(placeFor(hit)).toEqual({ cell: n, level });
      }
    }
  });

  it('a ray down onto the top stacks; a slanted one through a side still lands beside', () => {
    const [cx, cy] = grid.centre(inner);
    const top = pickFace(grid, has, any, floor, [cx, cy, 60], [0, 0, -1], 100)!;
    expect(top.face).toBe('top');
    expect(placeFor(top)).toEqual({ cell: inner, level: 2 });
    // (the game's camera looks down at about 30 degrees)
    const n = nbr(inner, 1);
    const [nx, ny] = grid.centre(n);
    const dx = cx - nx;
    const dy = cy - ny;
    const l = Math.hypot(dx, dy);
    const dz = -Math.tan(Math.PI / 6);
    const dl = Math.hypot(1, dz);
    const z = GROUND + 0.2 + 0.5 * LEVEL_H;
    // start back along the ray so it crosses the side at the bottom level's middle
    const back = 3;
    const o = [nx - (dx / l) * back, ny - (dy / l) * back, z - dz * back];
    const hit = pickFace(grid, has, any, floor, o, [dx / l / dl, dy / l / dl, dz / dl], 30)!;
    expect(hit.face).toBe('side');
    expect(placeFor(hit)!.level).toBe(hit.level);
  });

  it('a ray that meets no block picks nothing (the ground is the GPU pick\'s)', () => {
    expect(pickFace(grid, has, any, floor, [5, 5, 60], [0, 0, -1], 100)).toBeNull();
  });
});

describe('the builders', () => {
  it('build lowest first, then nearest the heap; a level only once the one under it stands', () => {
    const town = newTown();
    const far = nbr(nbr(nbr(inner, 0), 0), 0);
    for (const [c, l] of [[inner, 0], [inner, 1], [far, 0]] as const) town.plan(c, l, true);
    const at = grid.centre(inner);
    let order = buildOrder(town, at).map((d) => d.block);
    expect(order).toEqual([{ cell: inner, level: 0 }, { cell: far, level: 0 }]);
    town.add(inner, 0);
    order = buildOrder(town, at).map((d) => d.block);
    expect(order).toEqual([{ cell: far, level: 0 }, { cell: inner, level: 1 }]);
  });

  it('a block stands when its cost is in, and the stores go down by the cost', () => {
    const b = { cell: inner, level: 0 };
    const book = new BuildBook(() => DEFS.house.cost);
    const stores: Goods = { log: 100, stone: 100 };
    let built = false;
    let loads = 0;
    while (!built) {
      const load = book.fetch(b, stores, 3)!;
      expect(load).not.toBeNull();
      // (a second builder isn't sent for what's already on its way)
      built = book.pay(b, load);
      loads++;
    }
    expect(loads).toBe(2 + 1);
    expect(stores).toEqual({ log: 100 - DEFS.house.cost.log!, stone: 100 - DEFS.house.cost.stone! });
  });

  it('loads on their way count: two builders fetch the cost between them, not twice; short stores wait', () => {
    const b = { cell: inner, level: 0 };
    const book = new BuildBook(() => ({ stone: 6 }));
    const stores: Goods = { stone: 100 };
    const a = book.fetch(b, stores, 3)!;
    const c = book.fetch(b, stores, 3)!;
    expect(book.fetch(b, stores, 3)).toBeNull();
    expect(stores.stone).toBe(94);
    expect(book.pay(b, a)).toBe(false);
    expect(book.pay(b, c)).toBe(true);
    const empty: Goods = { stone: 0 };
    expect(new BuildBook(() => ({ stone: 6 })).fetch(b, empty, 3)).toBeNull();
    // (a load not needed after all goes back)
    const book2 = new BuildBook(() => ({ stone: 6 }));
    const st: Goods = { stone: 10 };
    const l = book2.fetch(b, st, 3)!;
    book2.giveBack(b, l, st);
    expect(st.stone).toBe(10);
  });
});

describe('the fortress gives power (the user: "building your fortress should add to your magic power")', () => {
  it('grows with its blocks and with its height', () => {
    const p = new FortressPlan(grid);
    p.paint(inner, 0, 'fortress');
    const s = p.structureAt(inner)!;
    const one = p.power(s);
    expect(one).toBe(DEFS.fortress.perBlock.power);
    p.paint(nbr(inner, 0), 0, 'fortress');
    const wider = p.power(s);
    expect(wider).toBe(2 * one);
    p.paint(inner, 1, 'fortress');
    const taller = p.power(s);
    // (a block a level up gives more than one on the ground)
    expect(taller - wider).toBeCloseTo(one * (1 + POWER_RISE));
    expect(taller - wider).toBeGreaterThan(one);
    // only built blocks count toward what comes in
    expect(p.power(s, (c, l) => l === 0)).toBe(wider);
    expect(p.gives(s).power).toBe(taller);
    // (houses give none)
    p.paint(nbr(nbr(inner, 2), 2), 0, 'house');
    expect(p.power(p.structureAt(nbr(nbr(inner, 2), 2))!)).toBe(0);
  });

  it('its keep is solid stone with towers at its corners; a wall runs into it', () => {
    const town = newTown();
    const plan = new FortressPlan(grid);
    const paint = (c: number, l: number, t: Parameters<FortressPlan['paint']>[2]) => {
      expect(plan.paint(c, l, t)).toBe(true);
      town.plan(c, l, true);
    };
    paint(inner, 0, 'fortress');
    paint(inner, 1, 'fortress');
    const w = nbr(inner, 0);
    paint(w, 0, 'wall');
    paint(nbr(w, 0), 0, 'wall');
    // (the wall's cell by the keep joins it: a run, not an end)
    expect(plan.wallJoins(w, 0).filter(Boolean).length).toBe(2);
    const p = fortressPieces({ plan, town, grid, ground: () => GROUND, zOff: 0 });
    const lib = library();
    const n = new Map<string, number>();
    for (let i = 0; i < p.count; i++) n.set(lib.modules[p.module[i]].name, (n.get(lib.modules[p.module[i]].name) ?? 0) + 1);
    // a lone keep cell: a tower at each of its four corners; the wall run's far end one more (its turn by the keep may too)
    expect(n.get('tower')).toBeGreaterThanOrEqual(4 + 1);
    expect(n.get('rampart')).toBeGreaterThan(0);
  });
});

describe('farms read; blocks still to build drawn see-through while building', () => {
  const lib = library();
  it('a farm is ripe crop (not a green that reads as grass) inside a fence', () => {
    const town = newTown();
    const plan = new FortressPlan(grid);
    for (const c of [inner, nbr(inner, 0)]) {
      plan.paint(c, 0, 'farm');
      town.plan(c, 0, true);
    }
    const p = fortressPieces({ plan, town, grid, ground: () => GROUND, zOff: 0 });
    let crops = 0;
    let fences = 0;
    for (let i = 0; i < p.count; i++) {
      const name = lib.modules[p.module[i]].name;
      if (name === 'fence') fences++;
      if (name !== 'crop') continue;
      crops++;
    }
    expect(crops).toBe(2);
    // (round the two cells: three sides each)
    expect(fences).toBe(6);
  });

  it('planning: drawn whole; building: what isn\'t built yet is see-through, what stands isn\'t', () => {
    const town = newTown();
    const plan = new FortressPlan(grid);
    for (const l of [0, 1]) {
      plan.paint(inner, l, 'house');
      town.plan(inner, l, true);
    }
    const ghosts = (ghost?: (c: number, l: number) => boolean) => {
      const p = fortressPieces({ plan, town, grid, ground: () => GROUND, zOff: 0, ghost });
      let g = 0;
      for (let i = 0; i < p.count; i++) if ((p.data[i * 16 + 13] | 0) & LOOK_GHOST) g++;
      return { g, n: p.count };
    };
    expect(ghosts().g).toBe(0);
    const all = ghosts((c, l) => !town.has(c, l));
    expect(all.g).toBeGreaterThan(0);
    town.add(inner, 0);
    const half = ghosts((c, l) => !town.has(c, l));
    expect(half.g).toBeGreaterThan(0);
    expect(half.g).toBeLessThan(all.g);
    town.add(inner, 1);
    expect(ghosts((c, l) => !town.has(c, l)).g).toBe(0);
  });
});

describe('the compact lines read plainly (docs/WRITING.md)', () => {
  it('every type\'s card, the building and stores lines pass the lint', () => {
    const lines = STRUCTURE_TYPES.map((t) => typeCard(DEFS[t]));
    lines.push(buildingLine(3, 10), buildingLine(10, 10), buildingLine(0, 0), storesLine({ log: 120, stone: 80, grain: 150, power: 3 }, 6));
    for (const l of lines) expect(lint(l), l).toEqual([]);
    expect(typeCard(DEFS.farm)).toBe('Farms: 1 wood a block. Makes 2 grain a day. 1 worker a block. Flat.');
  });
});
