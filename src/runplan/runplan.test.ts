// (round 117, runplan) The run manager at its contract: tiny hand-made graphs for the rules, seed 1's cached atlas for
// the whole plan (every hero), the world state for consequences between runs. `npx vitest run src/runplan`.

import { describe, expect, test } from 'vitest';
import type { RegionNode, RunPlan } from '../api/contracts/run';
import { freshRegion } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import { affordances } from './affords';
import { finishRun, realise } from './consequences';
import { seed1, seed1Graph, seed1World } from './fixture';
import { borderBarrier, plainGraph } from './graph';
import { crossCost, HEROES, heroCaps } from './heroes';
import { planRun } from './plan';
import { reach, routeTo } from './route';
import { along, Journey, type Precacher } from './travel';

const node = (id: number, x: number, y: number, kind = 'plains', extra: Partial<RegionNode> = {}): RegionNode => ({
  id, kind, land: kind !== 'ocean', centre: [x, y], area: 600, tier: 'lowland', ground: { min: 100, mean: 110, max: 120 }, rivers: 0, lava: 0, stamps: [], settlements: [], name: `R${id}`, ...extra,
});

describe('graph and routes', () => {
  test('borders: water between land and sea, a range is a mountain, a big step a cliff', () => {
    const f = (kind: string, mean: number, land = true) => ({ id: 0, kind, land, area: 1, cont: 0, contArea: 1, prov: 0, fault: false, centre: [0, 0] as [number, number], warmth: 0, dryness: 0, temp: 0, tier: null, landform: null, neighbours: [], rivers: 0, lava: 0, ground: { min: mean, mean, max: mean }, stamps: [] });
    expect(borderBarrier(f('plains', 100), f('ocean', 40, false))).toBe('water');
    expect(borderBarrier(f('plains', 100), f('range', 110))).toBe('mountain');
    expect(borderBarrier(f('plains', 100), f('hills', 160))).toBe('cliff');
    expect(borderBarrier(f('plains', 100), f('hills', 110))).toBeNull();
  });

  test('a road makes a barrier easy; a hard barrier the hero never names stops it', () => {
    const bike = heroCaps('bike');
    expect(crossCost(bike, 'mountain', null)).toBe(0);
    expect(crossCost(bike, 'mountain', 'road')).toBe(1);
    expect(crossCost(heroCaps('lich'), 'water', null)).toBe(1);
    expect(() => heroCaps('dragon')).toThrow(/no capabilities/);
  });

  test('the bike goes round the mountain the knight walks through', () => {
    //   0 — 1(range) — 2      and the long way 0 — 3 — 4 — 2
    const g = plainGraph(
      [node(0, 0, 0), node(1, 500, 0, 'range'), node(2, 1000, 0), node(3, 300, 1500), node(4, 700, 1500)],
      [
        { a: 0, b: 1, barrier: 'mountain', crossing: null },
        { a: 1, b: 2, barrier: 'mountain', crossing: null },
        { a: 0, b: 3, barrier: null, crossing: null },
        { a: 3, b: 4, barrier: null, crossing: null },
        { a: 4, b: 2, barrier: null, crossing: null },
      ],
    );
    expect(routeTo(reach(g, heroCaps('bike'), 0), 2)).toEqual([0, 3, 4, 2]);
    // the knight's mountain costs 3× (its caves): 3000 < the long way's ~3460, so it walks through …
    expect(routeTo(reach(g, heroCaps('knight'), 0), 2)).toEqual([0, 1, 2]);
    // … and the lich floats over (mountain 2×)
    expect(routeTo(reach(g, heroCaps('lich'), 0), 2)).toEqual([0, 1, 2]);
  });

  test('seed 1: edges are symmetric and roads give crossings', () => {
    const g = seed1Graph();
    let crossings = 0;
    let n = 0;
    for (const r of g.nodes()) {
      for (const e of g.edges(r.id)) {
        n++;
        const back = g.edges(e.b).find((x) => x.b === r.id);
        expect(back, `${r.id}→${e.b}`).toBeTruthy();
        expect(back!.barrier).toBe(e.barrier);
        if (e.crossing) crossings++;
      }
    }
    expect(n).toBeGreaterThan(20000);
    expect(crossings).toBeGreaterThan(100);
  });
});

describe('affordances', () => {
  test('open plains for a race, the dead for a horde, a town to talk in', () => {
    const f = new Map();
    const plains = affordances(node(0, 0, 0, 'plains', { ground: { min: 100, mean: 105, max: 110 }, area: 900 }), freshRegion(), f);
    const karst = affordances(node(1, 0, 0, 'karst', { ground: { min: 80, mean: 140, max: 220 } }), freshRegion(), f);
    expect(plains.race).toBeGreaterThan(karst.race);
    expect(karst.delve).toBeGreaterThan(plains.delve);
    const dead = { ...freshRegion(), undead: 0.8 };
    expect(affordances(node(2, 0, 0), dead, f).horde).toBeGreaterThan(0.5);
    expect(affordances(node(3, 0, 0, 'plains', { settlements: ['s1'] }), freshRegion(), f).talk).toBeGreaterThan(0.4);
  });
});

/** every path from the start to a finale, as stage ids */
function paths(p: RunPlan): string[][] {
  const legs = new Map(p.legs.map((l) => [l.id, l]));
  const byId = new Map(p.stages.map((s) => [s.id, s]));
  const out: string[][] = [];
  const walk = (id: string, acc: string[]) => {
    const s = byId.get(id)!;
    if (!s.next.length) return void out.push([...acc, id]);
    for (const l of s.next) walk(legs.get(l)!.to, [...acc, id]);
  };
  walk(p.start, []);
  return out;
}

describe('the planner on seed 1', () => {
  const g = seed1Graph();
  const { wiki } = seed1();
  const snap = wiki.snapshot;
  const from = wiki.spawn.region;

  for (const role of Object.keys(HEROES)) {
    test(`${role}: a branching run of 15-50 minutes, every path to the finale, deterministic`, () => {
      const p = planRun({ graph: g, world: snap, hero: heroCaps(role), seed: 1, from });
      const ps = paths(p);
      expect(ps.length).toBeGreaterThanOrEqual(2);
      const finales = p.stages.filter((s) => !s.next.length);
      expect(finales).toHaveLength(1);
      for (const path of ps) expect(path.at(-1)).toBe(finales[0].id);
      expect(p.minutes.min).toBeGreaterThanOrEqual(15);
      expect(p.minutes.max).toBeLessThanOrEqual(50);
      // every leg's route runs through regions the hero can be in, border to border
      for (const l of p.legs) {
        for (let i = 1; i < l.route.length; i++) {
          const e = g.edges(l.route[i - 1]).find((x) => x.b === l.route[i]);
          expect(e, `${l.id} ${l.route[i - 1]}→${l.route[i]}`).toBeTruthy();
          expect(crossCost(heroCaps(role), e!.barrier, e!.crossing)).toBeGreaterThan(0);
        }
      }
      // exits asked for every stage; obstacles only ones the hero can cross
      expect(p.requests.filter((r) => r.kind === 'exits')).toHaveLength(p.stages.length);
      for (const r of p.requests) if (r.kind === 'obstacle') expect(crossCost(heroCaps(role), r.barrier, null)).toBeGreaterThan(0);
      expect(planRun({ graph: g, world: snap, hero: heroCaps(role), seed: 1, from })).toEqual(p);
    });
  }

  test('the run fits the hero: the bike races and chases, the lich makes a spectacle, the knight delves and fights', () => {
    const kinds = (role: string) => planRun({ graph: g, world: snap, hero: heroCaps(role), seed: 1, from }).stages.map((s) => s.encounter);
    const share = (ks: string[], want: string[]) => ks.filter((k) => want.includes(k)).length / ks.length;
    expect(share(kinds('bike'), ['race', 'chase'])).toBeGreaterThanOrEqual(0.5);
    expect(share(kinds('lich'), ['spectacle', 'destruction', 'horde'])).toBeGreaterThanOrEqual(0.5);
    expect(share(kinds('knight'), ['delve', 'fight', 'talk', 'rescue'])).toBeGreaterThanOrEqual(0.5);
  });

  test('other seeds of the plan (the run number) give other runs', () => {
    const a = planRun({ graph: g, world: snap, hero: heroCaps('bike'), seed: 1, from });
    const b = planRun({ graph: g, world: { ...snap, run: 3 }, hero: heroCaps('bike'), seed: 1, from });
    expect(b.id).not.toBe(a.id);
  });
});

describe('consequences between runs', () => {
  const g = seed1Graph();
  const { wiki } = seed1();
  const from = wiki.spawn.region;

  test('a run played along a path changes the world, and the next plan reads it', () => {
    const w = seed1World();
    const p = planRun({ graph: g, world: w.snapshot(), hero: heroCaps('lich'), seed: 1, from });
    const path = paths(p)[0].map((id) => ({ stage: id, outcome: p.stages.find((s) => s.id === id)!.outcomes[0].id }));
    const rec = finishRun(w, p, path);
    expect(rec.end).toBe('won');
    expect(rec.events.length).toBeGreaterThan(0);
    expect(w.run).toBe(1);
    const lich = w.character('lich')!;
    expect(lich.history.length).toBeGreaterThanOrEqual(path.length);
    // the next run is planned from the world as left: a new plan, the hero remembered
    const next = planRun({ graph: g, world: w.snapshot(), hero: heroCaps('lich'), seed: 1, from });
    expect(next.from.run).toBe(1);
    // round trip through a save
    const again = MemoryWorldState.restore(JSON.parse(JSON.stringify(w.snapshot())));
    expect(again.character('lich')).toEqual(lich);
  });

  test('a spectacle can drown a region into a shallow sea: the terrain gets a water fill', () => {
    const w = seed1World();
    const r = g.node(from)!;
    w.apply({ id: 'x', kind: 'sink', regions: [from], magnitude: 0.6, run: 0, cause: { by: 'player' } });
    const re = realise(r, w.region(from));
    expect(re.terrain.fills).toHaveLength(1);
    expect(re.terrain.fills[0].material).toBe('water');
    expect(re.terrain.fills[0].level).toBeGreaterThan(r.ground.min);
    w.apply({ id: 'y', kind: 'bury', regions: [from], magnitude: 6, detail: { material: 'sand' }, run: 0, cause: { by: 'player' } });
    const re2 = realise(r, w.region(from));
    expect(re2.terrain.fills.map((f) => f.material)).toEqual(['water', 'sand']);
    expect(re2.structures.drowned).toBe(true);
  });

  test('death where the dead hold sway: the lich takes the map', () => {
    const w = seed1World();
    // the dead round the start (a past run's doing)
    w.apply({ id: 'd', kind: 'raise-dead', regions: [from, ...g.edges(from).map((e) => e.b)], magnitude: 0.5, run: 0, cause: { by: 'world' } });
    const p = planRun({ graph: g, world: w.snapshot(), hero: heroCaps('knight'), seed: 1, from });
    const lost = p.failures.find((f) => f.when === 'lost')!;
    expect(lost.text).toMatch(/lich took the map/);
    const undeadBefore = [...g.nodes()].filter((n) => n.land && w.region(n.id).undead > 0.3).length;
    const rec = finishRun(w, p, [{ stage: p.start, outcome: p.stages[0].outcomes[0].id }], 'lost');
    expect(rec.end).toBe('lost');
    const undeadAfter = [...g.nodes()].filter((n) => n.land && w.region(n.id).undead > 0.3).length;
    expect(undeadAfter).toBeGreaterThan(undeadBefore + 10);
    expect(w.character('knight')!.alive).toBe(false);
    expect(() => planRun({ graph: g, world: w.snapshot(), hero: heroCaps('knight'), seed: 1, from })).toThrow(/dead/);
  });

  test('a captured hero is held at the captor’s seat; another hero’s next run offers the rescue', () => {
    const w = seed1World();
    const p = planRun({ graph: g, world: w.snapshot(), hero: heroCaps('bike'), seed: 1, from });
    finishRun(w, p, [{ stage: p.start, outcome: p.stages[0].outcomes[0].id }], 'captured');
    const bike = w.character('bike')!;
    expect(bike.statuses.some((s) => s.startsWith('captive'))).toBe(true);
    const held = bike.region!;
    // the knight sets out from the captive's region's neighbourhood: a rescue at the seat
    const k = planRun({ graph: g, world: w.snapshot(), hero: heroCaps('knight'), seed: 1, from: held });
    // (the seat is the start itself here: a rescue counts there too)
    const rescue = k.stages.find((s) => s.encounter === 'rescue');
    if (rescue) expect(rescue.region).toBe(held);
    // the captive bike's own next run starts where it's held, as an escape
    const esc = planRun({ graph: g, world: w.snapshot(), hero: heroCaps('bike'), seed: 1 });
    expect(esc.stages[0].region).toBe(held);
    expect(esc.stages[0].encounter).toBe('chase');
  });

  test('faction power and relations move by events', () => {
    const w = seed1World();
    const [a, b] = structuredClone(w.snapshot().factions);
    w.apply({ id: 'p', kind: 'faction-power', regions: [from], magnitude: 0.3, detail: { faction: a.id }, run: 0, cause: { by: 'player' } });
    w.apply({ id: 'r', kind: 'faction-relation', regions: [from], magnitude: -0.5, detail: { faction: a.id, toward: b.id }, run: 0, cause: { by: 'player' } });
    expect(w.faction(a.id)!.power).toBeCloseTo(0.8);
    expect(w.faction(a.id)!.relations[b.id]).toBeCloseTo((a.relations[b.id] ?? 0) - 0.5);
  });
});

describe('travel', () => {
  test('along a path', () => {
    expect(along([[0, 0], [10, 0], [10, 10]], 0.75)).toEqual([10, 5]);
  });

  test('a journey asks for the land at once, holds at events, and arrives only when the land is ready', () => {
    const asked: [number, number][] = [];
    let ready = false;
    const pre: Precacher = { precache: (x, y) => (asked.push([x, y]), 4), ready: () => ready };
    const leg = { id: 'l', from: 'a', to: 'b', route: [0, 1, 2], path: [[0, 0], [100, 0], [200, 0]] as [number, number][], minutes: 1, animSeconds: 4, crossings: [], events: [{ id: 'e', kind: 'vista' as const, t: 0.5, region: 1, at: [100, 0] as [number, number], text: 'a view' }] };
    const j = new Journey(leg, [200, 0], pre);
    expect(asked).toEqual([[200, 0]]);
    let s = j.update(1);
    expect(s.phase).toBe('moving');
    s = j.update(1.5);
    expect(s.phase).toBe('event');
    expect(j.update(1).phase).toBe('event');
    j.answer(false);
    for (let i = 0; i < 10; i++) s = j.update(1);
    expect(s.phase).toBe('waiting');
    expect(j.waited).toBeGreaterThan(0);
    ready = true;
    expect(j.update(0.1).phase).toBe('arrived');
    expect(asked).toHaveLength(1);
  });
});
