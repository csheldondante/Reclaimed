// (merge124) The run on the living world: the fact layer seeded from the atlas world (seed 1), the locus and its cast,
// the run's cards as living templates with presenters and rewards, the world model holding the agents (where they are,
// what they're committed to) through a save, and the settlement condition's one owner.

import { describe, expect, it } from 'vitest';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import type { Situation } from '../../src/api/contracts/situation';
import { OppRun } from '../../src/opps/run';
import { finishOpps } from '../../src/opps/finish';
import { checkLiving } from '../../src/gm/oppcheck';
import { fillSituation, situationMap } from '../../src/runsit/fill';
import { FinaleRules } from '../../src/runsit/finale';
import { castAt } from '../../src/living/seed';
import { HORDE_TEMPLATES } from '../../src/living/horde';
import { checkTemplates } from '../../src/gm/oppcheck';
import { seed1, seed1Graph } from '../support/seed1';

const snap = () => seed1().wiki.snapshot;
const graph = seed1Graph();
const fill = (world = snap()): Situation => fillSituation({ graph, world, seed: 1, from: seed1().wiki.spawn.region, at: seed1().wiki.spawn.at as [number, number] });
const fresh = () => MemoryWorldState.restore(structuredClone(snap()));
const make = (w = fresh(), sit = fill(w.snapshot())) => new OppRun(sit, situationMap(graph, w.snapshot()), { seed: 1, hero: 'hoverbike', world: w, check: (rep, e) => checkLiving(e, rep, { region: (id) => !!graph.node(id), situation: sit }) });
const way = (r: OppRun, choice: string) => r.forPlayer.find((o) => o.offer === choice)!.id;
const toHold = (r: OppRun) => {
  r.play(r.offered[0].id);
  r.areaDone({ seconds: 150, won: true, pursuers: 0 });
  r.play(way(r, 'c-hold'));
  r.arrive();
  r.areaDone({ seconds: 170, won: true });
};

describe('the fact layer seeded from the atlas world', () => {
  it('a run seeds its locus: its cohorts, a cast of 5-8 named people living there, the factions\' standing', () => {
    const w = fresh();
    const r = make(w);
    const f = r.w.facts;
    expect(r.w.settlement(r.locus)).toBeTruthy();
    expect(r.cast.length).toBeGreaterThanOrEqual(5);
    expect(r.cast.length).toBeLessThanOrEqual(8);
    for (const id of r.cast) {
      expect(f.entity(id)?.kind).toBe('person');
      expect(w.character(id)?.alive).toBe(true);
      expect(f.relations({ type: 'resident_at', from: id, to: r.locus })).toHaveLength(1);
    }
    // (a cohort a role of its people — the atlas world's records have none until the settlements system plans the town:
    // BACKLOG M124-6)
    expect(f.find({ kind: 'cohort' }).filter((c) => c.id.startsWith(`cohort:${r.locus}:`)).length).toBe(r.w.settlement(r.locus)!.people.filter((p) => !p.hostile && p.count > 0).length);
    expect(f.events({ kind: 'seeded-standing' })).toHaveLength(1);
  });
  it('the cast persists through the snapshot: the next run meets the same people, none made again', () => {
    const w = fresh();
    const r = make(w);
    const saved = MemoryWorldState.restore(JSON.parse(JSON.stringify(w.snapshot())));
    const next = make(saved);
    expect(next.locus).toBe(r.locus);
    expect(castAt(next.w, next.locus)).toEqual(r.cast);
    expect(saved.characters().length).toBe(w.characters().length);
  });
});

describe("the run's cards are the living engine's", () => {
  it('slice A as templates: they pass the engine\'s checks; every dealt card is presented by a named person with a reward', () => {
    expect(checkTemplates(HORDE_TEMPLATES)).toEqual([]);
    const r = make();
    toHold(r);
    const offers = r.engine.offered;
    expect(offers.length).toBeGreaterThanOrEqual(3);
    for (const o of offers) {
      const who = r.w.name(o.presenter);
      expect(r.w.facts.entity(o.presenter)?.kind).toBe('person');
      // (dialog2: the presenter's line is said in their petition, not glued onto the pitch)
      expect(who.length).toBeGreaterThan(0);
      expect(o.line.length).toBeGreaterThan(0);
      expect(r.engine.template(o.template).reward.text.length).toBeGreaterThan(0);
    }
    // (the run's cards bind the run's real places: the hold is the world's settlement, the host an army in the facts)
    const muster = r.engine.past.find((o) => o.template === 'muster')!;
    expect(muster.opp.location.settlement).toBe(r.sit.areas.find((a) => a.id === 'a-hold')!.settlement);
    const ford = offers.find((o) => o.template === 'ford')!;
    expect(r.w.facts.entity(ford.bind.host)?.kind).toBe('army');
    // (the reward of the muster: the hold's levy, an agent the world remembers by its record id)
    expect(r.holdings.agents.find((a) => a.id === 'levy')).toMatchObject({ kind: 'army', character: `levy:${muster.opp.location.settlement}` });
  });
  it('the run\'s scaffolding (host, areas, ways) leaves the facts when it ends; what it did stays in the history', () => {
    const w = fresh();
    const r = make(w);
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 120, won: true, pursuers: 0 });
    r.play(way(r, 'c-road'));
    r.arrive();
    r.areaDone({ seconds: 100, won: true });
    r.play(way(r, 'c-stand'));
    r.arrive();
    const setup = r.sr.finaleSetup();
    const rules = new FinaleRules(setup);
    for (let t = 0; t < 900 && rules.status.state === 'playing'; t++) rules.step(1, { t, heroAlive: true, hordeCame: t >= Math.max(0, setup.hordeIn), hordeLeft: 0, hordeInside: 0 });
    if (rules.status.state !== 'ended') throw new Error('no end');
    r.finish(rules.status.end, 120);
    finishOpps(w, r, 'hoverbike');
    expect(r.w.facts.find({}).filter((e) => e.id.startsWith(r.stage.prefix))).toEqual([]);
    expect(r.w.facts.events({ kind: 'host-rises' })).toHaveLength(1);
    expect(r.w.facts.events({ kind: 'kept-faith' }).length).toBeGreaterThan(0);
  });
});

describe('the world model holds the agents (the user: "update the world model so all this data lives in it")', () => {
  it('an army committed in one run is still at its place and committed in the restored snapshot', () => {
    const w = fresh();
    const r = make(w);
    toHold(r);
    const harvest = r.forResources.find((o) => o.template === 'harvest')!;
    const c = r.commitResources(harvest.id);
    // (the run ends there: the hero falls on the road with the levy still in the fields)
    r.finish('fell', 10);
    const save = MemoryWorldState.restore(JSON.parse(JSON.stringify(w.snapshot())));
    const levy = save.holdings.agents.find((a) => a.id === 'levy')!;
    expect(levy).toMatchObject({ kind: 'army', committed: c.id });
    const rec = save.holdings.commitments!.find((x) => x.id === c.id)!;
    expect(rec).toMatchObject({ template: 'harvest', agents: ['levy'], location: { name: harvest.location.name } });
    expect(rec.location.at).toEqual(harvest.location.at);
    expect(rec.resolvesTurn).toBeGreaterThan(rec.turn);
  });
  it('an army on the march ends the run stationed where it went; the next run starts with it there', () => {
    const w = fresh();
    const r = make(w);
    toHold(r);
    expect(r.holdings.agents.find((a) => a.id === 'levy')!.march).toBeTruthy();
    r.play(way(r, 'c-levy'));
    r.arrive();
    r.finish('burned', 30);
    const save = MemoryWorldState.restore(JSON.parse(JSON.stringify(w.snapshot())));
    expect(save.holdings.agents.find((a) => a.id === 'levy')!.at).toEqual({ settlement: r.sit.target.settlement });
    const next = make(save, fill());
    expect(next.holdings.agents.find((a) => a.id === 'levy')!.at).toEqual({ settlement: r.sit.target.settlement });
  });
});

describe('one owner of a settlement\'s condition', () => {
  it('a burned town is ruined by the `settlement-condition` event (WorldState.apply), which the systems that realise it hear', () => {
    const w = fresh();
    const heard: string[] = [];
    w.onEvent.push((e) => heard.push(e.kind));
    const r = make(w);
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    r.play(way(r, 'c-levy'));
    r.arrive();
    r.finish('burned', 30);
    finishOpps(w, r, 'hoverbike');
    expect(w.settlements.find((s) => s.id === r.sit.target.settlement)!.condition).toBe('ruined');
    expect(w.history().some((e) => e.kind === 'settlement-condition' && e.detail?.settlement === r.sit.target.settlement)).toBe(true);
    expect(heard).toContain('settlement-condition');
  });
});
