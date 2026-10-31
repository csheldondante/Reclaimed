// (round 120, runsit) The situation run in Node: the template filled from seed 1's world, the state machine (areas,
// choices, the clock, pursuers, the finale's setup), the finale's rules (fires, the fall, saved, evacuated), followers'
// orders over the Units contract, items in slots, the validator, and the burned town remembered by the world state —
// so the next run's template won't send the dead for it again.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import type { Situation } from '../../src/api/contracts/situation';
import type { UnitId, UnitJob, Units, UnitView } from '../../src/api/contracts/units';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import { fillSituation, situationMap } from '../../src/runsit/fill';
import { SituationRun, HORDE_CAP_S, PURSUIT_CLOSE, pathEstimates } from '../../src/runsit/state';
import { FinaleRules, fireSite, FIRE_EVERY, FALL_AT, HOLD_S } from '../../src/runsit/finale';
import { UnitFollowers } from '../../src/runsit/followers';
import { ITEMS, emptyLoadout, equip, use, totals, displaced, carried } from '../../src/runsit/items';
import { finishSituation } from '../../src/runsit/finish';
import { checkSituation, situationWorldFrom } from '../../src/gm/situationcheck';
import { seed1, seed1Graph, seed1World } from '../support/seed1';

const fill = (world = seed1().wiki.snapshot) => fillSituation({ graph: seed1Graph(), world, seed: 1, from: seed1().wiki.spawn.region, at: seed1().wiki.spawn.at as [number, number] });
const runOf = (sit: Situation, world = seed1().wiki.snapshot) => new SituationRun(sit, situationMap(seed1Graph(), world));
const def = (id: string) => ITEMS[id];

describe('the template (fill.ts)', () => {
  it('fills a situation from seed 1 that the validator passes, the same every time', () => {
    const a = fill();
    const b = fill();
    expect(a).toEqual(b);
    expect(checkSituation(a, situationWorldFrom(seed1().wiki))).toEqual([]);
    expect(a.threat.faction).toBe('f-hollow-court');
    expect(a.threat.role).toBe('walking dead');
    expect(a.threat.route.at(-1)).toBe(a.target.region);
  });
  it('makes the fork real: the straight road is in time, the hold is late', () => {
    const sit = fill();
    const est = pathEstimates(sit, situationMap(seed1Graph(), seed1().wiki.snapshot));
    const straight = est.find((p) => p.areas.join() === 'a-start,a-road,a-town')!;
    const hold = est.find((p) => p.areas.includes('a-hold'))!;
    expect(straight.minutes).toBeLessThan(sit.threat.arrives);
    expect(hold.minutes).toBeGreaterThan(straight.minutes);
    expect(sit.choices.filter((c) => c.from === 'a-start').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the run (state.ts)', () => {
  it('plays the straight road with a warning and an evacuation into the finale', () => {
    const r = runOf(fill());
    expect(r.phase).toBe('area');
    r.areaDone({ seconds: 90, won: true, pursuers: 0 });
    expect(r.phase).toBe('edge');
    expect(r.pursuers).toBeNull();
    const opts = r.options();
    expect(opts.map((o) => o.choice.id).sort()).toEqual(['c-hold', 'c-road']);
    expect(opts.find((o) => o.choice.id === 'c-road')!.note).toMatch(/before the dead/);
    r.choose('c-road');
    r.arrive();
    expect(r.at).toBe('a-road');
    r.areaDone({ seconds: 80, won: true });
    r.choose('c-flee');
    expect(r.warned && r.evacuate).toBe(true);
    r.arrive();
    const f = r.finaleSetup();
    expect(f.mode).toBe('evacuate');
    expect(f.hordeIn).toBeGreaterThan(0);
    expect(f.hordeIn).toBeLessThanOrEqual(HORDE_CAP_S);
    expect(f.militia).toBeGreaterThan(0);
    expect(f.reinforce).toBeNull();
    expect(Math.hypot(...f.from)).toBeCloseTo(1, 5);
  });
  it('the hold: the message delivered sends the levy (later than the hero), and the dead are in the town first', () => {
    const r = runOf(fill());
    r.areaDone({ seconds: 180, won: true, pursuers: 2 });
    r.choose('c-hold');
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    expect(r.reinforce).not.toBeNull();
    expect(r.offers).toEqual(['war-horn', 'fresh-mount']);
    r.take('war-horn');
    expect(carried(r.loadout)).toEqual(['war-horn']);
    r.choose('c-levy');
    r.arrive();
    const f = r.finaleSetup();
    expect(f.mode).toBe('defend');
    expect(f.reinforce!.count).toBe(8);
    expect(f.reinforce!.in).toBeGreaterThan(8);
    // (late: the dead got there first — fires already burning)
    expect(f.hordeIn).toBeLessThan(0);
    expect(f.burning).toBeGreaterThan(0);
  });
  it('a delay slows the threat; a hero who dies ends the run fell', () => {
    const sit = fill();
    sit.choices.find((c) => c.id === 'c-road')!.effects.push({ kind: 'delay', minutes: 2 });
    const r = runOf(sit);
    const before = r.hordeArrives();
    r.areaDone({ seconds: 60, won: true });
    r.choose('c-road');
    expect(r.hordeArrives()).toBeCloseTo(before + 2, 6);
    r.arrive();
    r.areaDone({ seconds: 10, won: false, heroDied: true });
    expect(r.phase).toBe('ended');
    expect(r.end).toBe('fell');
  });
  it('pursuers close on the road, less with a fresh mount', () => {
    const go = (mount: boolean) => {
      const r = runOf(fill());
      r.areaDone({ seconds: 60, won: true, pursuers: 3 });
      if (mount) r.loadout = equip(r.loadout, def('fresh-mount'), def);
      const behind = r.pursuers!.behind;
      const leg = r.choose('c-road');
      r.arrive();
      return { closed: behind - r.pursuers!.behind, minutes: leg.minutes };
    };
    const on = go(false);
    const mounted = go(true);
    expect(on.closed).toBeCloseTo(on.minutes * PURSUIT_CLOSE, 6);
    expect(mounted.minutes).toBeLessThan(on.minutes);
    expect(mounted.closed).toBeLessThan(on.closed);
  });
});

describe('the finale (finale.ts)', () => {
  const setup = (mode: 'defend' | 'evacuate' = 'defend', burning = 0) => ({ mode, warned: true, horde: 16, role: 'walking dead', faction: 'f-hollow-court', hordeIn: 30, burning, militia: 4, reinforce: null, pursuers: null, from: [1, 0] as [number, number] });
  it('the dead inside set fires; enough fires and the town has burned', () => {
    const f = new FinaleRules(setup());
    let fires = 0;
    for (let t = 0; t < 200 && f.status.state === 'playing'; t++) fires += f.step(1, { t, heroAlive: true, hordeCame: true, hordeLeft: 10, hordeInside: 3 });
    expect(fires).toBe(FALL_AT);
    expect(f.status).toMatchObject({ state: 'ended', end: 'burned' });
    // (three inside: a fire every FIRE_EVERY / 3 s)
    expect(FIRE_EVERY / 3).toBeLessThan(5);
  });
  it('broken before it falls: saved; the hero down: fell; held long enough: saved', () => {
    const a = new FinaleRules(setup());
    a.step(1, { t: 40, heroAlive: true, hordeCame: true, hordeLeft: 0, hordeInside: 0 });
    expect(a.status).toMatchObject({ end: 'saved' });
    const b = new FinaleRules(setup());
    b.step(1, { t: 40, heroAlive: false, hordeCame: true, hordeLeft: 5, hordeInside: 0 });
    expect(b.status).toMatchObject({ end: 'fell' });
    const c = new FinaleRules(setup());
    c.step(1, { t: 30 + HOLD_S + 1, heroAlive: true, hordeCame: true, hordeLeft: 3, hordeInside: 0 });
    expect(c.status).toMatchObject({ end: 'saved' });
  });
  it('evacuation: half the people at the refuge is the end, and the town still burns behind them', () => {
    const f = new FinaleRules(setup('evacuate', 2));
    expect(f.fires).toBe(2);
    f.step(1, { t: 10, heroAlive: true, hordeCame: false, hordeLeft: 16, hordeInside: 0, refugees: { led: 10, safe: 4 } });
    expect(f.status.state).toBe('playing');
    f.step(1, { t: 11, heroAlive: true, hordeCame: false, hordeLeft: 16, hordeInside: 0, refugees: { led: 10, safe: 5 } });
    expect(f.status).toMatchObject({ end: 'evacuated' });
    // (after the end the dead still fire it)
    expect(f.step(FIRE_EVERY, { t: 40, heroAlive: true, hordeCame: true, hordeLeft: 16, hordeInside: 1 })).toBe(1);
  });
  it('a fire goes where the dead are, never inside the ward', () => {
    const houses: [number, number][] = [[0, 0], [10, 0], [40, 0]];
    expect(fireSite(houses, new Set(), [[9, 1]], null, 0)).toBe(1);
    expect(fireSite(houses, new Set([1]), [[9, 1]], null, 0)).toBe(0);
    expect(fireSite(houses, new Set(), [[9, 1]], [5, 0], 20)).toBe(2);
    expect(fireSite(houses, new Set(), [[9, 1]], [20, 0], 30)).toBeNull();
  });
});

describe('items (items.ts)', () => {
  it('a slot holds one: the bell displaces the horn; the banner takes the hand and the back', () => {
    let l = equip(emptyLoadout(), def('war-horn'), def);
    l = equip(l, def('ash-cloak'), def);
    expect(displaced(l, def('lure-bell'))).toEqual(['war-horn']);
    const l2 = equip(l, def('lure-bell'), def);
    expect(carried(l2).sort()).toEqual(['ash-cloak', 'lure-bell']);
    expect(displaced(l, def('levy-banner')).sort()).toEqual(['ash-cloak', 'war-horn']);
    const l3 = equip(l, def('levy-banner'), def);
    expect(carried(l3)).toEqual(['levy-banner']);
    expect(l3.slots.cape).toBe('levy-banner');
  });
  it('uses are spent; worn items add up', () => {
    let l = equip(emptyLoadout(), def('lure-bell'), def);
    l = equip(l, def('fresh-mount'), def);
    l = equip(l, def('ash-cloak'), def);
    const t = totals(l, def);
    expect(t.pace).toBeCloseTo(0.67);
    expect(t.ward).toBe(30);
    expect(t.usable).toEqual([{ id: 'lure-bell', name: 'Lure bell', uses: 2, kind: 'lure' }]);
    const a = use(l, 'lure-bell', def)!;
    const b = use(a.loadout, 'lure-bell', def)!;
    expect(b.effect.kind).toBe('lure');
    expect(use(b.loadout, 'lure-bell', def)).toBeNull();
    expect(use(l, 'war-horn', def)).toBeNull();
  });
});

describe('followers (followers.ts)', () => {
  class FakeUnits {
    jobs = new Map<UnitId, UnitJob>();
    views = new Map<UnitId, UnitView>();
    add(id: UnitId, hostile = false) {
      const job: UnitJob = { kind: 'work', at: [id, 0], what: 'farm' };
      this.jobs.set(id, job);
      this.views.set(id, { id, kind: 'villager', role: 'farmer', faction: null, at: [id, 0, 0], heading: 0, health: 3, maxHealth: 3, hostile, alive: true, job, state: 'idle', colour: '#fff' });
    }
    get(id: UnitId) {
      const v = this.views.get(id);
      return v ? { ...v, job: this.jobs.get(id)! } : null;
    }
    order(who: UnitId | UnitId[], job: UnitJob) {
      for (const id of Array.isArray(who) ? who : [who]) this.jobs.set(id, job);
    }
  }
  it("follow, hold, go and release become the units' jobs; the hostile are not taken on", () => {
    const U = new FakeUnits();
    for (const id of [1, 2, 3]) U.add(id);
    U.add(4, true);
    const F = new UnitFollowers(U as unknown as Units, 'hero');
    F.recruit([1, 2, 3, 4]);
    expect(F.members().length).toBe(3);
    F.order({ kind: 'follow' });
    expect(U.jobs.get(1)).toEqual({ kind: 'follow', target: 'hero', distance: 3 });
    F.order({ kind: 'hold', at: [5, 5] }, [2]);
    expect(U.jobs.get(2)).toEqual({ kind: 'guard', at: [5, 5], radius: 2 });
    F.order({ kind: 'go', to: [9, 9] }, [3]);
    expect(U.jobs.get(3)).toEqual({ kind: 'go', to: [9, 9] });
    F.dismiss([1]);
    expect(U.jobs.get(1)).toEqual({ kind: 'work', at: [1, 0], what: 'farm' });
    expect(F.members().map((m) => m.unit.id).sort()).toEqual([2, 3]);
  });
});

describe('the validator (situationcheck.ts)', () => {
  const W = () => situationWorldFrom(seed1().wiki);
  it('finds what makes a situation unplayable', () => {
    const s = structuredClone(fill());
    s.choices = s.choices.filter((c) => c.id !== 'c-hold' && c.id !== 'c-cross' && c.id !== 'c-flee' && c.id !== 'c-stand');
    s.choices.find((c) => c.id === 'c-on')!.effects = [{ kind: 'evacuate' }];
    s.threat.route = [s.threat.route[0], s.target.region];
    s.endings.burned.outcome.atlas = s.endings.burned.outcome.atlas!.filter((e) => e.kind !== 'burn');
    (s.areas[3].play as { offers: string[] }).offers = ['no-such-thing'];
    const p = checkSituation(s, W()).join('\n');
    expect(p).toMatch(/no fork/);
    expect(p).toMatch(/'evacuate' needs 'warn'/);
    expect(p).toMatch(/doesn't border/);
    expect(p).toMatch(/a burned town burns/);
    expect(p).toMatch(/isn't one of the situation's items/);
    expect(p).toMatch(/no choice leads here/);
  });
  it('no path in time is refused', () => {
    const s = structuredClone(fill());
    s.threat.arrives = 1;
    expect(checkSituation(s, W()).join('\n')).toMatch(/no path is in time/);
  });
  it("the GM's situations for seed 1 pass (data/situations)", () => {
    const dir = new URL('../../data/situations/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect([f, checkSituation(JSON.parse(readFileSync(new URL(f, dir), 'utf8')), W())]).toEqual([f, []]);
  });
});

describe('what lasts (finish.ts)', () => {
  it("a burned town is ruined in the world, survives a save, and is not the next run's target", () => {
    const w = seed1World();
    const sit = fill(w.snapshot());
    const r = runOf(sit, w.snapshot());
    r.areaDone({ seconds: 60, won: true });
    r.choose('c-road');
    r.arrive();
    r.areaDone({ seconds: 60, won: true });
    r.choose('c-stand');
    r.arrive();
    r.finish('burned', 200);
    const rec = finishSituation(w, r, 'hoverbike');
    expect(rec.end).toBe('lost');
    expect(rec.events.some((e) => e.kind === 'burn' && e.regions.includes(sit.target.region))).toBe(true);
    const saved = MemoryWorldState.restore(structuredClone(w.snapshot()));
    expect(saved.region(sit.target.region).ruin).toBeGreaterThan(0.3);
    expect(saved.settlements.find((s) => s.id === sit.target.settlement)!.condition).toBe('ruined');
    expect(saved.region(sit.target.region).marks.some((m) => /burned town/.test(m.name))).toBe(true);
    expect(saved.character('hoverbike')!.history.at(-1)!.text).toMatch(/burned/);
    const next = fill(saved.snapshot());
    expect(next.target.settlement).not.toBe(sit.target.settlement);
    expect(next.from.run).toBe(1);
  });
  it('an evacuation leaves the town abandoned and a refuge marked', () => {
    const w = seed1World();
    const sit = fill(w.snapshot());
    const r = runOf(sit, w.snapshot());
    r.areaDone({ seconds: 60, won: true });
    r.choose('c-road');
    r.arrive();
    r.areaDone({ seconds: 60, won: true });
    r.choose('c-flee');
    r.arrive();
    r.finish('evacuated', 120);
    const rec = finishSituation(w, r, 'lich');
    expect(rec.end).toBe('won');
    expect(w.settlements.find((s) => s.id === sit.target.settlement)!.condition).toBe('abandoned');
    expect(w.region(sit.refuge.region).marks.some((m) => /refuge/.test(m.name))).toBe(true);
  });
});
