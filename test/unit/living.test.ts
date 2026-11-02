// The template engine over the fact layer (src/living/; BACKLOG LW-F4..F8): predicates and bindings, the setup's
// lifecycle, the user's four templates and their mutations, the drought arc as instant mutations, emergent chains with
// no chaining by hand, the trait rules (one vocabulary with traits.ts), and oppcheck's living-world family.
import { describe, expect, test } from 'vitest';
import { briarEngine, briarWorld } from '../../src/living/briar';
import { enumerate, LivingEngine, type TemplateDef } from '../../src/living/engine';
import { describe as say, holds } from '../../src/living/dsl';
import { TEMPLATES } from '../../src/living/library';
import { pawnTraits, crewTurns } from '../../src/living/traits';
import { checkLiving, checkTemplates } from '../../src/gm/oppcheck';
import { lawAt } from '../../src/api/contracts/facts-rules';

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
/** deal, then commit the first offer of a template (it must be on the board) */
function take(e: LivingEngine, template: string) {
  const o = e.offers.find((x) => x.template === template && x.status === 'offered');
  if (!o) throw new Error(`${template} not offered: ${JSON.stringify(e.report?.notProposed.filter((n) => n.template === template))} dealt ${e.offers.map((x) => x.template)}`);
  return e.commit(o.id);
}
/** advance until a committed card resolves */
function until(e: LivingEngine, id: string, max = 8) {
  for (let i = 0; i < max; i++) {
    const p = e.past.find((x) => x.id === id);
    if (p) return p;
    e.advance();
  }
  throw new Error(`${id} never resolved`);
}
/** an engine on Briar Hollow with only these templates (the board not crowded by the rest) */
const only = (ids: string[], arc = false) => {
  const e = briarEngine(arc);
  return new LivingEngine(e.w, TEMPLATES.filter((t) => ids.includes(t.id)), arc ? e.arc : undefined);
};

describe('predicates and bindings', () => {
  test('bindings select real entities; the failing predicate is the why', () => {
    const w = briarWorld();
    const r = enumerate(w, tpl('build-burrows'));
    expect(r.ok).toEqual([{ cohort: 'cohort:briar-hollow:gnoll', town: 'briar-hollow' }]);
    const ab = enumerate(w, tpl('abolish-serfdom'));
    expect(ab.ok).toEqual([{ polity: 'briar-crown', serfs: 'cohort:briar-hollow:serf' }]);
    // (the Vell March has abolished serfdom: no binding there, and the reason says so)
    expect(enumerate(w, tpl('divert-river')).ok).toEqual([]);
    expect(enumerate(w, tpl('divert-river')).fails[0]).toMatch(/no town: no settlement with condition drought/);
  });
  test('predicates read the owners: quantities, derived control, effective law', () => {
    const w = briarWorld();
    const c = { w, b: { t: 'briar-hollow', l: 'house-aldren', g: 'cohort:briar-hollow:gnoll' }, cause: 'test' };
    expect(holds(c, { qty: ['$t', 'grain'], gte: 150 })).toBe(true);
    expect(holds(c, { rel: ['$l', 'controls', '$t'] })).toBe(true);
    expect(holds(c, { law: ['$g', 'serfdom'], is: 'legal' })).toBe(true);
    expect(holds(c, { trait: ['$g', 'regenerating'] })).toBe(true);
    expect(say(c, { qty: ['$t', 'inflow'], lte: 0.5 })).toBe("Briar Hollow's inflow ≤ 0.5 (now 1)");
  });
});

describe('the four templates', () => {
  test('build communal burrows: a structure placed, the cohort can shelter refugees', () => {
    const e = only(['build-burrows']);
    e.deal();
    const o = take(e, 'build-burrows');
    expect(o.resolvesTurn).toBe(4);
    const r = until(e, o.id);
    expect(e.w.settlement('briar-hollow')!.buildings.map((b) => b.use)).toEqual([['burrows', 'nursery', 'housing']]);
    expect(e.w.facts.tag('cohort:briar-hollow:gnoll', 'capability', 'shelter_refugees')?.value).toBe(true);
    expect(r.result).toEqual(expect.arrayContaining([expect.stringMatching(/^\+ building the communal burrows/), expect.stringMatching(/shelter_refugees = true/), expect.stringMatching(/building burrows \(burrows, nursery, housing\) placed/)]));
    // (stone spent at commitment, from the real store)
    expect(o.spent).toEqual(expect.arrayContaining([expect.stringMatching(/stone 80 → 60/)]));
  });
  test('abolish serfdom: the law changes in the jurisdiction, serfs become free tenants, the lords take a grievance', () => {
    const e = only(['abolish-serfdom']);
    e.deal();
    const o = take(e, 'abolish-serfdom');
    const r = until(e, o.id);
    expect(lawAt(e.w.facts, 'cohort:briar-hollow:serf', 'serfdom')?.value).toBe('abolished');
    expect(e.w.facts.tag('cohort:briar-hollow:serf', 'economy', 'labor')?.value).toBe('free_tenant');
    // (the gnolls' customs untouched: scopes kept apart)
    expect(e.w.facts.tag('cohort:briar-hollow:gnoll', 'custom', 'communal_childcare')?.value).toBe(true);
    expect(r.result).toEqual(expect.arrayContaining(['~ The Briar Crown: law.serfdom legal → abolished', expect.stringMatching(/House Aldren grievance_against The Briar Crown \(0.4\)/), expect.stringMatching(/House Aldren: power 0.55 → 0.45/)]));
    expect(e.w.holdings.goods.influence).toBe(2);
  });
  test('open a trade corridor: a route, a trade agreement (a relation), the guild grows', () => {
    const e = only(['open-corridor']);
    e.deal();
    const o = e.offers.find((x) => x.template === 'open-corridor')!;
    expect(o.bind.to).toBe('vellford');
    e.commit(o.id);
    const r = until(e, o.id);
    expect(e.w.facts.entity('route:briar-hollow-vellford')?.kind).toBe('route');
    expect(e.w.facts.relations({ type: 'trades_with', from: 'vell-march', to: 'lantern-guild' })).toHaveLength(1);
    expect(e.w.qty('lantern-guild', 'power')).toBeCloseTo(0.7);
    expect(r.result).toEqual(expect.arrayContaining([expect.stringMatching(/relation: The Lantern Guild trades_with ⇄ The Vell March/)]));
  });
  test('arbitrate a contested holding: the setup presses a real claim when shown; control moves to the stronger right', () => {
    const e = only(['arbitrate-holding']);
    expect(e.w.facts.claims()).toEqual([]);
    e.deal();
    const o = e.offers.find((x) => x.template === 'arbitrate-holding')!;
    expect(o.setup).toEqual(expect.arrayContaining([expect.stringMatching(/claim: House Aldren claims Thornfield, ancestral, 0.6/)]));
    e.commit(o.id);
    until(e, o.id);
    expect(e.w.controllerOf('thornfield')).toBe('house-aldren');
    expect(e.w.facts.claims({ target: 'thornfield' })).toMatchObject([{ claimant: 'house-morrow', basis: 'ancestral' }]);
    expect(e.w.facts.relations({ type: 'grievance_against', from: 'house-morrow', to: 'house-aldren' })[0].strength).toBeCloseTo(0.3);
    // (the ruling is in diplomacy's memory too: one history)
    expect(e.w.diplomacy.opinion({ faction: 'house-morrow' }, { player: true }).value).toBeLessThan(0);
  });
});

describe('setup lifecycle', () => {
  test('an incident is made only when its card is shown, once per binding; a lapsed card rests and its incident stays', () => {
    const e = only(['arbitrate-holding']);
    // (a dry run makes nothing in the real world)
    e.dryRun(tpl('arbitrate-holding'), { site: 'thornfield', holder: 'house-morrow', rival: 'house-aldren', arbiter: 'briar-crown' });
    expect(e.w.facts.claims()).toEqual([]);
    e.deal();
    expect(e.w.facts.events({ kind: 'claim-pressed' })).toHaveLength(1);
    e.advance();
    e.advance();
    // (lapsed: its expiry's feud happened, its binding rests, the incident is not made again)
    expect(e.past.map((x) => x.status)).toEqual(['expired']);
    expect(e.w.facts.events({ kind: 'feud' })).toHaveLength(1);
    expect(e.report!.notProposed.some((n) => n.template === 'arbitrate-holding' && n.step === 'cooldown')).toBe(true);
    for (let i = 0; i < 4; i++) e.advance();
    expect(e.offers.filter((x) => x.template === 'arbitrate-holding')).toHaveLength(1);
    expect(e.w.facts.events({ kind: 'claim-pressed' })).toHaveLength(1);
  });
  test('one card a location, finite subjects, dedup', () => {
    const e = briarEngine(false);
    const r = e.deal();
    const places = r.dealt.map((o) => o.place);
    expect(new Set(places).size).toBe(places.length);
    e.advance();
    expect(e.report!.notProposed.some((n) => n.step === 'dedup' || n.step === 'place')).toBe(true);
  });
});

describe('the drought arc: instant mutations by stage', () => {
  test('the rivers fall by their inflow factor, the fields by their rate, unrest rises, migrants move', () => {
    const e = only([], true);
    e.deal();
    e.advance();
    expect(e.w.ws.region(11).wetness).toBeCloseTo(0.7);
    expect(e.w.facts.tag('briar-hollow', 'condition', 'drought')?.value).toBe(true);
    for (let i = 0; i < 6; i++) e.advance();
    expect(e.arcStage()).toBe(2);
    expect(e.w.ws.region(12).wetness).toBeCloseTo(0.4);
    expect(e.w.settlement('millbrook')!.condition).toBe('struggling');
    expect(e.w.qty('briar-hollow', 'refugee')).toBeGreaterThan(0);
    expect(e.w.facts.tag('cohort:briar-hollow:serf', 'condition', 'unrest')!.value).toBeCloseTo(0.6);
    const grain = e.w.qty('briar-hollow', 'grain')!;
    expect(grain).toBeLessThan(150);
  });
});

describe('emergent chains (no chaining by hand)', () => {
  test('the river diversion gives the downstream town a grievance and a water claim, so a treaty card becomes eligible', () => {
    const e = only(['divert-river', 'river-treaty'], true);
    e.deal();
    e.advance();
    expect(enumerate(e.w, tpl('river-treaty')).ok).toEqual([]);
    const o = take(e, 'divert-river');
    expect(o.unlocks).toEqual(['river-treaty']);
    until(e, o.id);
    expect(e.w.facts.claims({ claimant: 'millbrook-council', target: 'briar-river' })).toMatchObject([{ what: 'water_access', basis: 'ancestral' }]);
    expect(e.w.facts.relations({ type: 'grievance_against', from: 'millbrook-council', to: 'house-aldren' })[0].strength).toBeCloseTo(0.5);
    expect(e.w.diplomacy.opinion({ faction: 'millbrook-council' }, { faction: 'house-aldren' }).value).toBeLessThan(-0.4);
    expect(enumerate(e.w, tpl('river-treaty')).ok).toHaveLength(1);
    e.advance();
    expect(e.offers.some((x) => x.template === 'river-treaty')).toBe(true);
  });
  test('a corridor raises the guild power, so a toll dispute becomes eligible', () => {
    const e = only(['open-corridor', 'toll-dispute']);
    e.deal();
    expect(enumerate(e.w, tpl('toll-dispute')).fails.join(' ')).toMatch(/power ≥ 0.65 \(now 0.5\)/);
    const o = e.offers.find((x) => x.template === 'open-corridor')!;
    expect(o.unlocks).toEqual(['toll-dispute']);
    e.commit(o.id);
    until(e, o.id);
    expect(enumerate(e.w, tpl('toll-dispute')).ok.length).toBeGreaterThan(0);
  });
  test('abolition gives the lords a grievance, so a conspiracy becomes eligible', () => {
    const e = only(['abolish-serfdom', 'noble-conspiracy']);
    e.deal();
    expect(e.offers.find((x) => x.template === 'abolish-serfdom')!.unlocks).toEqual(['noble-conspiracy']);
  });
  test('burrows and the drought migrants together make the refugees card eligible', () => {
    const e = only(['build-burrows', 'integrate-refugees'], true);
    e.deal();
    const o = take(e, 'build-burrows');
    until(e, o.id);
    expect(enumerate(e.w, tpl('integrate-refugees')).ok).toEqual([]);
    for (let i = 0; i < 4; i++) e.advance();
    expect(e.w.qty('briar-hollow', 'refugee')).toBeGreaterThan(5);
    expect(enumerate(e.w, tpl('integrate-refugees')).ok).toHaveLength(1);
  });
});

describe('invariants hold through every batch', () => {
  test('a template that would break one is refused, the world restored', () => {
    const bad: TemplateDef = { ...tpl('abolish-serfdom'), id: 'half-abolish', outcome: [{ setTag: ['$polity', 'law', 'serfdom', 'abolished'] }] };
    const e = briarEngine(false);
    const ee = new LivingEngine(e.w, [bad]);
    // (a template bug: an error where it's used, never a silent fix)
    expect(() => ee.deal()).toThrow(/bondage-legal/);
    expect(lawAt(ee.w.facts, 'cohort:briar-hollow:serf', 'serfdom')?.value).toBe('legal');
  });
});

describe('traits: one vocabulary with the agents', () => {
  test("a pawn's traits come from its species, tags and parts", () => {
    expect(pawnTraits({ tags: ['species:gnoll', 'knight'] })).toEqual(['living', 'regenerating']);
    expect(pawnTraits({ tags: ['species:skeleton'] })).toEqual(['undead']);
    expect(pawnTraits({ tags: ['species:human'], parts: { gear: ['fire_immune'] } })).toEqual(['living', 'fire_immune']);
    expect(crewTurns(4, 'travel', [{ tags: ['species:griffin'] }]).turns).toBe(2);
  });
  test('an undead labour crew finishes a build in fewer turns than a living one, eats nothing, and the living object', () => {
    const living = only(['build-burrows']);
    living.deal();
    const a = take(living, 'build-burrows');
    const dead = only(['build-burrows']);
    dead.w.holdings.agents = dead.w.holdings.agents.filter((x) => x.kind !== 'workers');
    dead.w.holdings.agents.push({ id: 'bone-crew', kind: 'workers', name: 'The bone crew', count: 10, tags: ['species:skeleton'], statuses: [], at: { settlement: 'briar-hollow' } });
    dead.deal();
    const b = take(dead, 'build-burrows');
    expect(a.resolvesTurn).toBe(4);
    expect(b.resolvesTurn).toBe(2);
    expect(b.crew).toEqual(expect.arrayContaining([expect.stringMatching(/undead work through the night: 4 → 2/), expect.stringMatching(/eat nothing/)]));
    expect(dead.w.qty('briar-hollow', 'grain')).toBe(150);
    expect(living.w.qty('briar-hollow', 'grain')).toBe(140);
    expect(dead.w.facts.tag('cohort:briar-hollow:serf', 'condition', 'unrest')!.value).toBeCloseTo(0.35);
    until(dead, b.id);
    expect(dead.w.settlement('briar-hollow')!.buildings).toHaveLength(1);
  });
  test('a regenerating gnoll knight band returns at full strength after a costly card', () => {
    const ford: TemplateDef = {
      id: 'hold-the-ford',
      title: 'Hold the ford at {town}',
      pitch: '',
      themes: ['war'],
      bind: [{ as: 'town', kind: 'settlement', where: [{ same: ['$town', 'briar-hollow'] }] }],
      at: 'town',
      requires: { agents: [{ kind: 'knight', count: 1 }] },
      turns: 1,
      work: 'travel',
      losses: 0.5,
      outcome: [{ event: 'battle', by: ['$town'], to: ['$town'], note: 'the ford held' }],
      outcomeText: 'held, at a cost',
    };
    const run = (tags: string[]) => {
      const base = briarEngine(false);
      const e = new LivingEngine(base.w, [ford]);
      e.w.holdings.agents.push({ id: 'knights', kind: 'knight', name: 'Knights', count: 4, tags, statuses: [], at: { settlement: 'briar-hollow' } });
      e.deal();
      const o = take(e, 'hold-the-ford');
      e.advance();
      const after = e.w.holdings.agents.find((x) => x.id === 'knights')?.count;
      e.advance();
      return [after, e.w.holdings.agents.find((x) => x.id === 'knights')?.count];
      void o;
    };
    expect(run(['species:human', 'knight'])).toEqual([2, 2]);
    expect(run(['species:gnoll', 'knight'])).toEqual([2, 4]);
  });
});

describe('oppcheck: the living world family', () => {
  test('every dealt card passes over ten turns of the full library and the drought', () => {
    const e = briarEngine(true);
    let n = 0;
    for (let t = 0; t < 10; t++) {
      const r = t === 0 ? e.deal() : e.advance();
      expect(checkLiving(e, r)).toEqual([]);
      n += r.dealt.length;
      // (commit what can be met, cheapest first, so the world moves)
      for (const o of e.offers.filter((x) => x.status === 'offered' && x.opp.affordable)) {
        try {
          e.commit(o.id);
        } catch {
          /* (a store spent by an earlier commitment this turn) */
        }
      }
    }
    expect(n).toBeGreaterThan(8);
  });
  test('a setup that fabricates a prerequisite relationship or capability is refused', () => {
    const cheat: TemplateDef = { ...tpl('build-burrows'), id: 'cheat', setup: [{ relate: ['$cohort', 'allied_with', 'vell-march'], symmetric: true }, { setTag: ['$cohort', 'capability', 'necromancy', true] }] };
    expect(checkTemplates([cheat]).join(' | ')).toMatch(/fabricates allied_with[\s\S]*fabricates capability necromancy/);
    expect(checkTemplates(TEMPLATES)).toEqual([]);
    expect(() => new LivingEngine(briarWorld(), [cheat])).toThrow(/fabricates/);
  });
});
