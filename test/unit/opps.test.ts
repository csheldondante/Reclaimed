// (round 120, opportunities) The dealer and slice A in Node: tiers (the most expensive you can afford), the forced
// opportunity dealt alone, the limits and the one-offer rule, the guarantees, reach and expiry; then runsit's horde run
// as opportunities on seed 1 — the outriders forced, the ways on as player opportunities, the levy won as an army
// agent, its opportunities dealt (or rejected, with why), committed, resolved over turns, expiring with their penalty —
// played through to saved and to burned, the world remembering the levy's tags into the next run; oppcheck on every deal.

import { describe, expect, it } from 'vitest';
import type { Holdings } from '../../src/api/contracts/opportunity';
import type { Situation } from '../../src/api/contracts/situation';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import { deal, type DealContext, type Proposal } from '../../src/opps/dealer';
import { OPP_TUNING, OPP_TUNE } from '../../src/opps/tune';
import { OppRun } from '../../src/opps/run';
import { CONFLICT_OPS } from '../../src/opps/horde';
import { finishOpps } from '../../src/opps/finish';
import { checkOpps, type OppWorld } from '../../src/gm/oppcheck';
import { fillSituation, situationMap } from '../../src/runsit/fill';
import { FinaleRules } from '../../src/runsit/finale';
import { along } from '../../src/runsit/state';
import { seed1, seed1Graph } from '../support/seed1';

// ---- the dealer, on proposals made here ---------------------------------------------------------------------------

const H = (armies: number, supplies = 5, tags: string[] = []): Holdings => ({
  agents: [{ id: 'player', kind: 'player', name: 'hero', count: 1, tags: [], statuses: [], at: { with: 'player' } }, ...Array.from({ length: armies }, (_, i) => ({ id: `army${i}`, kind: 'army' as const, name: `army ${i}`, count: 8, tags, statuses: [], at: { with: 'player' as const } }))],
  goods: { supplies },
  rules: [],
  bonuses: [],
});

function prop(o: Partial<Proposal> & { template: string }): Proposal {
  const res = o.tiers ? !o.tiers[0].requires.some((r) => r.kind === 'player') : false;
  return {
    offer: 'x', place: o.template, title: o.template, tiers: [{ requires: [{ kind: 'player', count: 1 }], costs: {} }], sense: [{ ok: true, why: 'it makes sense' }], parts: { theme: 0.5 }, at: [0, 0], hooks: [],
    make: () => ({
      template: o.template, offer: o.offer ?? 'x', title: o.template, pitch: '', location: { region: 1, at: [0, 0], name: o.place ?? o.template },
      duration: res ? { turns: 1 } : { minutes: 3 }, ...(res ? { odds: { success: 1 } } : { challenge: { system: 'character', play: 'flee', area: 'a', minutes: 3 } }),
      outcomes: { success: { text: 'ok', effects: [] } }, visibility: 'known', expires: { turn: 0 }, themes: [], hooks: o.hooks ?? [],
    }),
    ...o,
  };
}
const army = (n: number) => ({ requires: [{ kind: 'army' as const, count: n }], costs: { supplies: n } });
const ctx = (holdings: Holdings, o: Partial<DealContext> = {}): DealContext => ({ holdings, turn: 0, at: [0, 0], dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), conflictHooks: ['horde'], recent: [], tune: { ...OPP_TUNE.dealer }, ...o });

describe('the dealer (dealer.ts)', () => {
  it('deals the largest tier the holdings meet — "the most expensive cards you can afford"', () => {
    const p = [prop({ template: 'ford', tiers: [army(1), army(2), army(3)], hooks: ['horde'] })];
    expect(deal(p, ctx(H(1))).dealt[0].opp).toMatchObject({ tier: 1, tiers: 3, requires: [{ kind: 'army', count: 1 }], affordable: true });
    expect(deal(p, ctx(H(2))).dealt[0].opp.tier).toBe(2);
    expect(deal(p, ctx(H(3, 2))).dealt[0].opp.tier).toBe(2);
    expect(deal(p, ctx(H(3))).dealt[0].opp.tier).toBe(3);
    // (nothing met: not dealt unless an unaffordable slot is open, then shown with what's missing)
    const none = deal(p, ctx(H(0)));
    expect(none.dealt).toEqual([]);
    expect(none.rejected[0]).toMatchObject({ template: 'ford', step: 'limits' });
    expect(none.rejected[0].why).toMatch(/1 army: 0 free/);
    const shown = deal(p, ctx(H(0), { tune: { ...OPP_TUNE.dealer, unaffordable: 1 } }));
    expect(shown.dealt[0].opp).toMatchObject({ affordable: false, missing: ['1 army: 0 free', '1 supplies: 0 held'.replace('0 held', '5 held')].slice(0, 1) });
    // (the tier above as a goal)
    const goal = deal(p, ctx(H(1), { tune: { ...OPP_TUNE.dealer, nextTier: 1 } }));
    expect(goal.dealt.map((d) => [d.opp.tier, d.opp.affordable])).toEqual([[1, true], [2, false]]);
  });
  it('a forced opportunity is dealt alone among the player\'s; resource ones are dealt beside it', () => {
    const r = deal([prop({ template: 'a' }), prop({ template: 'outriders', forced: true }), prop({ template: 'b' }), prop({ template: 'ford', tiers: [army(1)], hooks: ['horde'] })], ctx(H(1)));
    expect(r.dealt.map((d) => d.opp.template).sort()).toEqual(['ford', 'outriders']);
    expect(r.rejected.filter((x) => x.step === 'forced').map((x) => x.template).sort()).toEqual(['a', 'b']);
  });
  it('one option a turn when only one makes sense; the limits are limits, not targets', () => {
    const one = deal([prop({ template: 'a', towardClimax: true, hooks: ['horde'] }), prop({ template: 'b', sense: [{ ok: false, why: 'not a way on from here' }] })], ctx(H(0)));
    expect(one.dealt.map((d) => d.opp.template)).toEqual(['a']);
    expect(one.rejected[0]).toMatchObject({ template: 'b', step: 'sense', why: 'not a way on from here' });
    const many = deal('abcdef'.split('').map((t, i) => prop({ template: t, parts: { theme: i / 10 } })), ctx(H(0), { tune: { ...OPP_TUNE.dealer, playerMax: 2 } }));
    expect(many.dealt.map((d) => d.opp.template)).toEqual(['f', 'e']);
    expect(many.rejected.filter((x) => x.step === 'limits')).toHaveLength(4);
  });
  it('one offer of a template at a place: the better-scoring one', () => {
    const r = deal([prop({ template: 'ride', offer: 'slow', place: 'town', parts: { theme: 0.1 } }), prop({ template: 'ride', offer: 'fast', place: 'town', parts: { theme: 0.9 } })], ctx(H(0)));
    expect(r.dealt.map((d) => d.opp.offer)).toEqual(['fast']);
    expect(r.rejected[0]).toMatchObject({ offer: 'slow', step: 'one' });
  });
  it('keeps the guarantees: a way toward the climax, something tied to the conflict', () => {
    const tune = { ...OPP_TUNE.dealer, playerMax: 1 };
    const r = deal([prop({ template: 'detour', parts: { theme: 1 } }), prop({ template: 'onward', parts: { theme: 0 }, towardClimax: true })], ctx(H(0), { tune, conflictHooks: [] }));
    expect(r.dealt.map((d) => d.opp.template)).toEqual(['onward']);
    expect(r.guarantees[0]).toMatch(/"onward" dealt by the guarantee/);
    expect(r.rejected[0]).toMatchObject({ template: 'detour' });
    const t = deal([prop({ template: 'x', parts: { theme: 1 } }), prop({ template: 'res', tiers: [army(1)], parts: { theme: 0 }, hooks: ['horde'] })], ctx(H(1), { tune: { ...OPP_TUNE.dealer, resourceMax: 0 } }));
    expect(t.dealt.map((d) => d.opp.template).sort()).toEqual(['res', 'x']);
    expect(t.guarantees.at(-1)).toMatch(/tied to the conflict: "res"/);
  });
  it('reach: a resource opportunity only near where the player is; variety: the same template scores less again', () => {
    const far = deal([prop({ template: 'ford', tiers: [army(1)], at: [5000, 0], hooks: ['horde'] })], ctx(H(1)));
    expect(far.rejected[0]).toMatchObject({ step: 'reach' });
    const fresh = deal([prop({ template: 'a' })], ctx(H(0), { turn: 2 })).dealt[0].score;
    const again = deal([prop({ template: 'a' })], ctx(H(0), { turn: 2, recent: [{ template: 'a', place: 'a', turn: 1 }] })).dealt[0].score;
    expect(again).toBeLessThan(fresh);
  });
  it('every weight and limit is a tuning slider (OPP_TUNING)', () => {
    for (const k of ['wTheme', 'wForeshadow', 'wVariety', 'wSynergy', 'wDifficulty', 'wHero', 'wTier', 'playerMax', 'resourceMax', 'unaffordable', 'nextTier', 'reach', 'minScore', 'variety']) expect(OPP_TUNING.byId.has(`dealer.${k}`)).toBe(true);
    const before = OPP_TUNE.dealer.playerMax;
    OPP_TUNING.set('dealer.playerMax', 1);
    expect(OPP_TUNE.dealer.playerMax).toBe(1);
    OPP_TUNING.reset();
    expect(OPP_TUNE.dealer.playerMax).toBe(before);
  });
});

// ---- slice A on seed 1 ---------------------------------------------------------------------------------------------

const snap = () => seed1().wiki.snapshot;
const fill = (world = snap()) => fillSituation({ graph: seed1Graph(), world, seed: 1, from: seed1().wiki.spawn.region, at: seed1().wiki.spawn.at as [number, number] });
const graph = seed1Graph();
const oppWorld = (sit: Situation, world = snap()): OppWorld => ({ region: (id) => !!graph.node(id), settlement: (id) => world.settlements.some((s) => s.id === id), situation: sit, ops: CONFLICT_OPS });
/** a run with oppcheck on every deal (a problem throws) */
const make = (sit = fill(), w?: MemoryWorldState) => new OppRun(sit, situationMap(graph, snap()), { seed: 1, hero: 'hoverbike', character: w ? (id) => w.character(id) : undefined, check: (rep, h) => checkOpps(rep, oppWorld(sit), h, OPP_TUNE.dealer) });
const checked = (r: OppRun) => expect(r.reports.length).toBeGreaterThan(0);
const way = (r: OppRun, choice: string) => r.forPlayer.find((o) => o.offer === choice)!.id;
/** the finale played by its rules: `kill` the hero cuts the host down, else they stand in the town setting fires */
function finale(r: OppRun, kill: boolean): void {
  const setup = r.sr.finaleSetup();
  const rules = new FinaleRules(setup);
  let left = setup.horde;
  for (let t = 0; t < 900 && rules.status.state === 'playing'; t++) {
    const came = t >= Math.max(0, setup.hordeIn);
    if (kill && came && t % 4 === 0) left = Math.max(0, left - 1);
    rules.step(1, { t, heroAlive: true, hordeCame: came, hordeLeft: left, hordeInside: came && !kill ? Math.min(left, 6) : 0 });
  }
  if (rules.status.state !== 'ended') throw new Error('the finale never ended');
  r.finish(rules.status.end, 120);
}

describe('slice A: the horde run as opportunities (run.ts, horde.ts)', () => {
  it('starts with the outriders forced, dealt alone; then the ways on are the player\'s opportunities', () => {
    const r = make();
    expect(r.offered.map((o) => o.template)).toEqual(['outriders']);
    expect(r.offered[0]).toMatchObject({ forced: true, challenge: { play: 'flee', area: 'a-start' } });
    expect(r.play(r.offered[0].id)).toEqual({ travel: false });
    r.areaDone({ seconds: 120, won: true, pursuers: 0 });
    expect(r.resolutions[0].tier).toBe('triumph');
    expect(r.forPlayer.map((o) => o.offer).sort()).toEqual(['c-hold', 'c-road']);
    // (a lone hero: no resource opportunity; the dealer says why of each)
    expect(r.forResources).toEqual([]);
    const why = r.report!.rejected.find((x) => x.template === 'harvest')!;
    expect(why.why).toMatch(/army|reach/);
    checked(r);
  });
  it('the hold: the levy won as an army agent; on seed 1 its only sense is the harvest (the ford out of its reach, with why) and one way on', () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    const levy = r.holdings.agents.find((a) => a.id === 'levy')!;
    expect(levy).toMatchObject({ kind: 'army', count: 8, character: expect.stringMatching(/^levy:/) });
    expect(r.holdings.goods.supplies).toBe(OPP_TUNE.horde.holdSupplies);
    expect(r.sr.reinforce).toBeNull();
    expect(r.forPlayer.map((o) => o.offer)).toEqual(['c-levy']);
    expect(r.forResources.map((o) => [o.template, o.tier, o.affordable])).toEqual([['harvest', 1, true]]);
    expect(r.report!.rejected.find((x) => x.template === 'ford')!.why).toMatch(/can't reach the host's road before it passes/);
    checked(r);
  });
  it('committing the levy to the harvest locks it, it resolves at the climax, and the supplies feed the town\'s defenders', () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    const h = r.forResources[0];
    const c = r.commitResources(h.id);
    expect(c.agents).toEqual(['levy']);
    expect(r.running()).toEqual([{ c, turnsLeft: 1 }]);
    expect(() => r.commitResources(h.id)).toThrow(/isn't offered/);
    r.play(way(r, 'c-levy'));
    r.arrive();
    expect(r.climaxed).toBe(true);
    expect(r.running()).toEqual([]);
    const res = r.resolutions.find((x) => x.commitment === c.id)!;
    expect(['success', 'cost']).toContain(res.tier);
    expect(r.holdings.goods.supplies).toBeGreaterThan(OPP_TUNE.horde.holdSupplies);
    const s = r.sr.finaleSetup();
    expect(s.warned).toBe(true);
    expect(r.sr.provisioned).toBe(Math.floor(r.holdings.goods.supplies * OPP_TUNE.horde.perSupply));
    expect(r.harvest).toBe('taken');
  });
  it("let go, the harvest rots: the host comes on sooner", () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    const before = r.sr.hordeArrives();
    r.play(way(r, 'c-levy'));
    r.arrive();
    expect(r.harvest).toBe('rotted');
    expect(r.expired.map((e) => e.opp.template)).toEqual(['harvest']);
    expect(r.sr.hordeArrives()).toBeCloseTo(before - OPP_TUNE.horde.rot, 6);
    // (the levy wasn't committed: it marches in from the hold)
    expect(r.sr.reinforce).toMatchObject({ count: 8 });
  });
});

/** seed 1's situation with the hold moved beside the host's road and the clock eased: where the ford makes sense */
function fordWorld(): Situation {
  const sit = fill();
  const m = situationMap(graph, snap());
  const pts = sit.threat.route.map((r) => m.regionCentre(r));
  const p = along(pts, 0.7, m.world);
  const hold = sit.areas.find((a) => a.play.kind === 'deliver')!;
  hold.at = [p[0] + 120, p[1]];
  sit.threat.arrives += 12;
  return sit;
}

describe('slice A where the ford makes sense (the hold by the host\'s road)', () => {
  const toHold = (r: OppRun) => {
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 0 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
  };
  it('deals the ford at the tier the levy meets, with its odds; committed, it resolves the next turn: the host delayed, the survivors veterans', () => {
    const r = make(fordWorld());
    toHold(r);
    const ford = r.forResources.find((o) => o.template === 'ford')!;
    expect(ford).toMatchObject({ tier: 1, tiers: 3, affordable: true, duration: { turns: 1 } });
    expect(Object.values(ford.odds!).reduce((s, v) => s + v!, 0)).toBeCloseTo(1, 9);
    const before = r.sr.hordeArrives();
    r.commitResources(ford.id);
    r.play(way(r, 'c-levy'));
    r.arrive();
    const res = r.resolutions.find((x) => x.opp === ford.id)!;
    expect(res).toBeTruthy();
    const levy = r.holdings.agents.find((a) => a.id === 'levy');
    // (the host: the ford's delay at its tier, less the rot of the harvest let go at the climax)
    const delay = res.out.reduce((s, e) => s + (e.kind === 'conflict' && e.op === 'delay' ? e.amount : 0), 0);
    const rotted = r.expired.some((e) => e.opp.template === 'harvest') ? OPP_TUNE.horde.rot : 0;
    expect(r.sr.hordeArrives()).toBeCloseTo(before + delay - rotted, 6);
    if (res.tier !== 'failure') {
      expect(delay).toBeGreaterThan(0);
      expect(levy?.tags).toContain('veteran');
    }
    // (it came back from the ford, a share lost: it marches for the town from there)
    expect(res.returns.length + res.lost.length).toBeGreaterThan(0);
    checked(r);
  });
  it('two armies held: the two-army tier is dealt', () => {
    const r = make(fordWorld());
    toHold(r);
    r.holdings.agents.push({ id: 'second', kind: 'army', name: 'a second army', count: 8, tags: [], statuses: [], at: { with: 'player' } });
    const rep = r.deal();
    expect(rep.dealt.find((d) => d.opp.template === 'ford')!.opp.tier).toBe(2);
  });
});

describe('slice A played through: saved and burned, and what lasts', () => {
  it('saved: the straight road, warned, the host cut down — the town stands', () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 120, won: true, pursuers: 0 });
    r.play(way(r, 'c-road'));
    r.arrive();
    r.areaDone({ seconds: 100, won: true });
    r.play(way(r, 'c-stand'));
    r.arrive();
    finale(r, true);
    expect(r.sr.end).toBe('saved');
    const w = MemoryWorldState.restore(structuredClone(snap()));
    const rec = finishOpps(w, r, 'hoverbike');
    expect(rec.end).toBe('won');
    expect(w.settlements.find((s) => s.id === r.sit.target.settlement)!.condition).toBe('thriving');
    checked(r);
  });
  it('burned: the hold\'s way, late — the town falls; the levy that never came in is no veteran', () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    r.play(way(r, 'c-levy'));
    r.arrive();
    finale(r, false);
    expect(r.sr.end).toBe('burned');
    const w = MemoryWorldState.restore(structuredClone(snap()));
    finishOpps(w, r, 'hoverbike');
    expect(w.settlements.find((s) => s.id === r.sit.target.settlement)!.condition).toBe('ruined');
    const levy = w.character(r.holdings.agents.find((a) => a.id === 'levy')!.character!)!;
    expect(levy.alive).toBe(true);
    expect(levy.tags ?? []).not.toContain('veteran');
    checked(r);
  });
  it("the levy that stands in a saved town comes back veteran — and is one in the next run (its CharacterRecord), which opens the veterans' opportunity", () => {
    const w = MemoryWorldState.restore(structuredClone(snap()));
    const r = make(fordWorld(), w);
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 0 });
    r.play(way(r, 'c-hold'));
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    r.play(way(r, 'c-levy'));
    r.arrive();
    expect(r.sr.reinforce).not.toBeNull();
    finale(r, true);
    expect(r.sr.end).toBe('saved');
    finishOpps(w, r, 'hoverbike');
    const id = r.holdings.agents.find((a) => a.id === 'levy')!.character!;
    const save = MemoryWorldState.restore(JSON.parse(JSON.stringify(w.snapshot())));
    expect(save.character(id)).toMatchObject({ alive: true, tags: ['veteran'], bonuses: [{ kind: 'negate', tier: 'disaster' }] });
    // the next run, the same hold: the levy comes with its record
    const next = make(fordWorld(), save);
    next.play(next.offered[0].id);
    next.areaDone({ seconds: 150, won: true, pursuers: 0 });
    next.play(way(next, 'c-hold'));
    next.arrive();
    next.areaDone({ seconds: 170, won: true });
    expect(next.holdings.agents.find((a) => a.id === 'levy')!.tags).toContain('veteran');
    expect(next.holdings.bonuses.some((b) => b.holder === 'levy' && b.kind === 'negate')).toBe(true);
    expect(next.forResources.map((o) => o.template)).toContain('vanguard');
    checked(next);
  });
});

describe('oppcheck (gm/oppcheck.ts)', () => {
  it('passes the deals above and finds what makes a deal unsound', () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    const rep = structuredClone(r.report!);
    const o = rep.dealt[0].opp;
    o.location.region = 999999;
    o.challenge = undefined;
    o.outcomes.success!.effects.push({ kind: 'conflict', op: 'teleport', amount: 1 });
    o.tier = 4;
    rep.dealt.push(structuredClone(rep.dealt[0]));
    const p = checkOpps(rep, oppWorld(r.sit), r.holdings, OPP_TUNE.dealer);
    for (const m of [/region 999999 isn't on the map/, /a challenge iff the player/, /no operation teleport/, /tier 4 of 1/, /dealt twice/]) expect(p.some((x) => m.test(x)), String(m)).toBe(true);
  });
  it('deals in well under 5 ms a turn', () => {
    const r = make();
    for (let i = 0; i < 20; i++) r.deal();
    const ms = r.reports.slice(1).map((x) => x.ms).sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length / 2)]).toBeLessThan(5);
  });
});
