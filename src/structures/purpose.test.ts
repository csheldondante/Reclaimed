// The purposes in the plan, the dressing and the lights (round 120, `cities`; BACKLOG STR30, STR32, STR33, STR36), at the
// structures contract on made-up ground (vitest, Node; no GPU). `npx vitest run src/structures/purpose`.
import { describe, expect, it } from 'vitest';
import type { CityPlan, CityPurpose, CitySpec, GroundFn } from '../api/contracts/structures';
import { planCity, standingPlan } from './plan';
import { piecesOf, PIECE_FLOATS, LOOK_BURNED, SPIN, WIND, shipPieces } from './pieces';
import { columnsOf } from './columns';
import { library } from './modules';
import { dressModules } from './dressmodules';
import { SHIP_DRAFT } from './purpose';
import { quadCentre } from './tiles/builder';
import { fbm } from './rng';
import { resample } from './linear';

const R = 40;
const SEA = 11;
// the viewer's grounds (structures/viewer/main.ts): a coast, a river, a mountain, a plain
const coast: GroundFn = (x, y) => {
  const shore = R * 0.5 + 10 * (fbm(y * 0.012, 3.3, 21, 3) - 0.5);
  const g = 12.4 + 2 * fbm(x * 0.02, y * 0.02, 5, 3);
  return x > shore ? g - Math.min(9, (x - shore) * 0.32) : g;
};
const river: GroundFn = (x, y) => {
  const cx = R * 0.55 + 7 * Math.sin(y * 0.025);
  const d = Math.abs(x - cx);
  return 12.2 + 1.5 * fbm(x * 0.02, y * 0.02, 5, 3) - 4 * Math.max(0, 1 - (d / 8) ** 2);
};
const mountain: GroundFn = (x, y) => 10 + 1.5 * fbm(x * 0.02, y * 0.02, 5, 3) + Math.max(0, x - R * 0.95) * 0.95;
const plain: GroundFn = () => 10;
const waterOf = (g: GroundFn): GroundFn => (x, y) => Math.max(0, SEA - g(x, y));

const spec = (purpose: CityPurpose | undefined, o: Partial<CitySpec> = {}): CitySpec => ({ seed: 7, system: 'irregular', style: 'hearth', at: [0, 0], radius: R, purpose, ...o });
const plans = new Map<string, CityPlan>();
const plan = (p: CityPurpose | undefined, g: GroundFn, wet: boolean, o: Partial<CitySpec> = {}) => {
  const k = `${p}:${g === coast ? 'c' : g === river ? 'r' : g === mountain ? 'm' : 'p'}:${JSON.stringify(o)}`;
  if (!plans.has(k)) plans.set(k, planCity(spec(p, o), g, wet ? waterOf(g) : undefined));
  return plans.get(k)!;
};
const names = (pl: CityPlan) => {
  const p = piecesOf(pl);
  const lib = library();
  return Array.from(p.module, (m) => lib.modules[m].name);
};

describe('a port', () => {
  const pl = plan('port', coast, true);
  const depth = waterOf(coast);

  it('finds its harbour on the water and builds its quay on the shore', () => {
    expect(pl.works).toBeTruthy();
    const quay = pl.tiles.use.map((u, q) => [u, q] as const).filter(([u]) => u === 'quay');
    expect(quay.length).toBeGreaterThan(4);
    // (a quay tile is dry land by the water)
    for (const [, q] of quay) expect(depth(...quadCentre(pl.tiles, q))).toBeLessThan(0.3);
  });

  it('runs its piers out to water a ship can lie in', () => {
    const piers = pl.linear.filter((f) => f.kind === 'pier');
    expect(piers.length).toBeGreaterThanOrEqual(2);
    for (const f of piers) {
      const end = f.points[f.points.length - 1];
      expect(depth(end[0], end[1])).toBeGreaterThanOrEqual(SHIP_DRAFT);
      // (the deck stands over the water all the way out)
      for (const s of resample(f, 2)) expect(s.p[2]).toBeGreaterThan(Math.max(SEA, coast(s.p[0], s.p[1])));
    }
  });

  it('moors its ships on deep enough water, bow to stern', () => {
    expect(pl.berths.length).toBeGreaterThanOrEqual(2);
    for (const b of pl.berths)
      for (const f of [-0.45, 0, 0.45]) {
        const x = b.at[0] + Math.cos(b.heading) * b.length * f;
        const y = b.at[1] + Math.sin(b.heading) * b.length * f;
        expect(depth(x, y)).toBeGreaterThanOrEqual(SHIP_DRAFT);
      }
  });

  it('has warehouses by the quay and a lighthouse on dry ground, its beacon a light', () => {
    expect(pl.buildings.filter((b) => b.kind === 'warehouse').length).toBeGreaterThanOrEqual(2);
    const lh = pl.megas.find((m) => m.kind === 'lighthouse');
    expect(lh).toBeTruthy();
    const c: [number, number] = [(lh!.frame[0][0] + lh!.frame[2][0]) / 2, (lh!.frame[0][1] + lh!.frame[2][1]) / 2];
    expect(depth(...c)).toBeLessThan(0.3);
    expect(pl.lights.some((l) => l.kind === 'beacon')).toBe(true);
    const ns = names(pl);
    for (const m of ['lhtower', 'lhtop', 'pierdeck', 'pierpiles', 'quayedge', 'ship:cog', 'prop:crane']) expect(ns).toContain(m);
  });

  it('is the same port every time (deterministic)', () => {
    const again = planCity(spec('port'), coast, waterOf(coast));
    expect(again.berths).toEqual(pl.berths);
    expect(again.props).toEqual(pl.props);
    expect(Array.from(again.tiles.use)).toEqual(Array.from(pl.tiles.use));
  });

  it('says so when the land has no water for it', () => {
    const dry = planCity(spec('port'), plain, undefined);
    expect(dry.works).toBeNull();
    expect(dry.berths.length).toBe(0);
  });

  it('claims its piers and its lighthouse as columns (the sims see them)', () => {
    const cols = columnsOf(pl);
    const pierIds = new Set(pl.linear.map((f, k) => (f.kind === 'pier' ? -2 - k : 0)).filter((x) => x < 0));
    expect(cols.some((c) => pierIds.has(c.building))).toBe(true);
  });
});

describe('the other purposes', () => {
  it('a mine: a headframe by the hill, rails into it, spoil heaps and ore carts', () => {
    const pl = plan('mining', mountain, false);
    expect(pl.works!.dir[0]).toBeGreaterThan(0.5);
    expect(pl.megas.some((m) => m.kind === 'headframe')).toBe(true);
    const rail = pl.linear.find((f) => f.kind === 'rail')!;
    expect(rail).toBeTruthy();
    // (the rails run toward the mountain, ending where the ground has risen)
    const a = rail.points[0];
    const b = rail.points[rail.points.length - 1];
    expect(b[0]).toBeGreaterThan(a[0]);
    expect(pl.props.filter((p) => p.kind === 'spoil').length).toBeGreaterThanOrEqual(2);
    expect(pl.props.some((p) => p.kind === 'cart')).toBe(true);
  });

  it('a lumber camp: a sawmill by the river, its waterwheel, log piles, logs floating on the river', () => {
    const pl = plan('lumber', river, true);
    const depth = waterOf(river);
    expect(pl.buildings.some((b) => b.kind === 'sawmill')).toBe(true);
    expect(pl.props.some((p) => p.kind === 'waterwheel')).toBe(true);
    expect(pl.props.filter((p) => p.kind === 'logpile').length).toBeGreaterThanOrEqual(3);
    const logs = pl.props.filter((p) => p.kind === 'log');
    expect(logs.length).toBeGreaterThanOrEqual(4);
    for (const l of logs) expect(depth(l.at[0], l.at[1])).toBeGreaterThan(0.5);
  });

  it('a farming town: granaries by the plaza and a windmill on the high ground, its sails turning', () => {
    const pl = plan('farming', plain, false, { farmland: R * 2.2 });
    expect(pl.buildings.filter((b) => b.kind === 'granary').length).toBe(2);
    expect(pl.megas.some((m) => m.kind === 'windmill')).toBe(true);
    const p = piecesOf(pl);
    const lib = library();
    const sails = Array.from(p.module).findIndex((m) => lib.modules[m].name === 'prop:millsails');
    expect(sails).toBeGreaterThanOrEqual(0);
    expect(p.data[sails * PIECE_FLOATS + 15] & SPIN).toBeTruthy();
  });

  it('a trading post: a wider market with stalls, caravan yards with wagons, stables', () => {
    const plainTown = plan(undefined, plain, false);
    const pl = plan('trading', plain, false);
    const plaza = (x: CityPlan) => x.tiles.use.filter((u) => u === 'plaza').length;
    expect(plaza(pl)).toBeGreaterThan(plaza(plainTown));
    expect(pl.props.filter((p) => p.kind === 'stall').length).toBeGreaterThanOrEqual(3);
    expect(pl.props.filter((p) => p.kind === 'wagon').length).toBeGreaterThanOrEqual(3);
    expect(pl.buildings.filter((b) => b.kind === 'stable').length).toBeGreaterThanOrEqual(1);
  });

  it('a hold: walled, its keep and towers flying banners in the wind', () => {
    const pl = plan('hold', plain, false, { system: 'radial', style: 'bastion', walls: true });
    expect(pl.megas.some((m) => m.kind === 'keep')).toBe(true);
    const banners = pl.props.filter((p) => p.kind === 'banner');
    expect(banners.length).toBeGreaterThanOrEqual(1);
    const p = piecesOf(pl);
    const lib = library();
    const k = Array.from(p.module).findIndex((m) => lib.modules[m].name === 'prop:banner');
    expect(p.data[k * PIECE_FLOATS + 15] & WIND).toBeTruthy();
  });

  it('a town with no purpose is planned as before (no works, no purpose buildings)', () => {
    const pl = plan(undefined, plain, false);
    expect(pl.works).toBeNull();
    expect(pl.buildings.every((b) => b.kind === 'house' || b.kind === 'hut' || b.kind === 'farmhouse' || b.kind === 'barn')).toBe(true);
  });
});

describe('dressing and lights', () => {
  const pl = plan(undefined, plain, false);

  it('lamps line the streets about 12 m apart, each a light with its pool', () => {
    const lamps = pl.props.filter((p) => p.kind === 'lamp');
    expect(lamps.length).toBeGreaterThan(5);
    for (let i = 0; i < lamps.length; i++)
      for (let j = i + 1; j < lamps.length; j++) expect(Math.hypot(lamps[i].at[0] - lamps[j].at[0], lamps[i].at[1] - lamps[j].at[1])).toBeGreaterThan(11.5);
    expect(pl.lights.filter((l) => l.kind === 'lamp').length).toBe(lamps.length);
    // (every lamp and torch has its pool among the pieces; ships' lanterns glow alone)
    const pools = names(pl).filter((n) => n === 'pool').length;
    expect(pools).toBe(pl.lights.filter((l) => l.kind !== 'lantern').length);
  });

  it('torches stand by front doors, a light each; kerbs line the streets', () => {
    const torches = pl.props.filter((p) => p.kind === 'torch');
    expect(torches.length).toBeGreaterThan(0);
    expect(pl.lights.filter((l) => l.kind === 'torch').length).toBe(torches.length);
    expect(names(pl)).toContain('kerb');
  });

  it('a light pool lies on the ground under its light', () => {
    for (const l of pl.lights) expect(l.at[2]).toBeGreaterThan(l.foot);
  });
});

describe('history in the fabric', () => {
  it('a burned quarter: its houses gutted (a storey gone, no roof, soot); new walls in fresh stone', () => {
    const base = plan(undefined, plain, false, { walls: true });
    const pl = plan(undefined, plain, false, { walls: true, marks: [{ kind: 'burned', at: [-12, 8], r: 14 }, { kind: 'newwalls' }] });
    const burned = pl.buildings.filter((b) => b.wear === 'burned');
    expect(burned.length).toBeGreaterThan(2);
    for (const b of burned) expect(b.storeys).toBeLessThanOrEqual(Math.max(1, base.buildings[b.id].storeys));
    const p = piecesOf(standingPlan(pl, pl.buildings.map((b) => b.storeys)));
    const lib = library();
    for (let i = 0; i < p.count; i++) {
      const b = p.building[i];
      if (b < 0 || pl.buildings[b].wear !== 'burned') continue;
      expect(lib.modules[p.module[i]].name.startsWith('roof:')).toBe(false);
      expect(p.data[i * PIECE_FLOATS + 13] & LOOK_BURNED).toBeTruthy();
    }
  });

  it('a flood: the buildings below its level abandoned', () => {
    const pl = plan(undefined, river, true, { marks: [{ kind: 'flooded', level: 13 }] });
    const low = pl.buildings.filter((b) => !b.mega && b.base < 13);
    expect(low.length).toBeGreaterThan(0);
    for (const b of low) expect(b.wear).toBe('flooded');
  });
});

describe('the new modules', () => {
  it('are wound outward (closed ones enclose a positive volume; thin ones are two-sided)', () => {
    for (const m of dressModules()) {
      let vol = 0;
      for (let i = 0; i < m.index.length; i += 3) {
        const a = m.index[i] * 4;
        const b = m.index[i + 1] * 4;
        const c = m.index[i + 2] * 4;
        const v = m.verts;
        vol += (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
      }
      expect(vol, m.name).toBeGreaterThan(-1e-4);
    }
  });

  it('ships as moving pieces: affine, one a ship', () => {
    const p = shipPieces([{ at: [10, 20, 11], heading: 1, length: 12, kind: 'cog', seed: 0.3 }], 'hearth');
    expect(p.count).toBe(1);
    expect(p.data[15] & 2).toBeTruthy();
    expect(p.data[3]).toBeCloseTo(10);
    expect(p.data[7]).toBeCloseTo(20);
  });
});
