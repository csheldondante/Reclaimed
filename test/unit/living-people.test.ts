// The living world's people and the player's attachment (src/living/people.ts, attachment.ts; BACKLOG LW-F15..F18):
// cards presented by named people from the cast (or made, real, when no one is free); the player's answer as
// relationship facts; the dealer's stakes (what the player made or chose) and locus (the run's centre and cast); the
// mechanical rewards on every card; species traits from the creature generator.
import { describe, expect, test } from 'vitest';
import { briarEngine } from '../../src/living/briar';
import { LivingEngine, rewardValue } from '../../src/living/engine';
import { TEMPLATES } from '../../src/living/library';
import { attachment, hops, stakes } from '../../src/living/attachment';
import { pawnTraits, unitTraits } from '../../src/living/traits';
import { SPECIES, speciesTraits } from '../../src/inhabitants/species';

const only = (ids: string[], arc = false) => {
  const e = briarEngine(arc);
  return new LivingEngine(e.w, TEMPLATES.filter((t) => ids.includes(t.id)), arc ? e.arc : undefined, 'briar-hollow');
};
const offer = (e: LivingEngine, t: string) => e.offers.find((o) => o.template === t && o.status === 'offered')!;

describe('named presenters', () => {
  test('a card is presented by a named member of its group, with a line', () => {
    const e = only(['build-burrows', 'abolish-serfdom', 'open-corridor']);
    e.deal();
    expect(offer(e, 'build-burrows').presenter).toBe('matron-grisk');
    expect(offer(e, 'build-burrows').opp.pitch).toMatch(/^Matron Grisk petitions: “The pups sleep three to a hollow/);
    expect(offer(e, 'abolish-serfdom').presenter).toBe('ada-thorne');
    expect(offer(e, 'open-corridor').presenter).toBe('guildmaster-pell');
  });
  test('when the cast has no one free, a real person is made: a character the world remembers, with species and membership', () => {
    const e = only(['build-burrows']);
    e.w.ws.applyCharacter({ kind: 'die', id: 'matron-grisk', text: 'died in the winter' });
    e.deal();
    const r = offer(e, 'build-burrows');
    expect(r.presenter).not.toBe('matron-grisk');
    expect(e.w.ws.character(r.presenter)).toMatchObject({ role: 'matron', alive: true });
    expect(e.w.facts.tag(r.presenter, 'biology', 'species')?.value).toBe('gnoll');
    expect(e.w.facts.relations({ type: 'member_of', from: r.presenter, to: 'cohort:briar-hollow:gnoll' })).toHaveLength(1);
    expect(r.setup.join(' | ')).toMatch(/\+ person /);
    expect(r.opp.pitch).toMatch(/^Rukk petitions/);
  });
  test('committing, refusing and ignoring are relationship facts with the presenter that persist in their record', () => {
    const e = only(['build-burrows', 'abolish-serfdom', 'open-corridor']);
    e.deal();
    e.commit(offer(e, 'build-burrows').id);
    e.refuse(offer(e, 'abolish-serfdom').id);
    e.advance();
    e.advance();
    const f = e.w.facts;
    expect(f.relations({ type: 'owes_favor_to', from: 'matron-grisk', to: 'player' })[0].strength).toBeCloseTo(0.3);
    expect(f.relations({ type: 'grievance_against', from: 'ada-thorne', to: 'player' })[0].strength).toBeCloseTo(0.3);
    // (the corridor lapsed unanswered)
    expect(f.relations({ type: 'grievance_against', from: 'guildmaster-pell', to: 'player' })[0].strength).toBeCloseTo(0.15);
    expect(e.w.ws.character('matron-grisk')!.relationships.player).toBeCloseTo(0.3);
    expect(e.w.ws.character('ada-thorne')!.history.at(-1)!.text).toMatch(/turned them away/);
    // (and diplomacy's opinion reads the same history)
    expect(e.w.diplomacy.opinion({ who: 'ada-thorne' }, { player: true }).value).toBeLessThan(0);
    // (a save between runs keeps them)
    const s = JSON.parse(JSON.stringify(e.w.ws.snapshot()));
    expect(s.characters.find((c: { id: string }) => c.id === 'matron-grisk').relationships.player).toBeCloseTo(0.3);
  });
});

describe("the player's attachment", () => {
  test('stakes come from provenance: what the player made, chose and answered', () => {
    const e = only(['build-burrows']);
    e.deal();
    const o = e.commit(offer(e, 'build-burrows').id);
    for (let i = 0; i < 5 && !e.past.includes(o); i++) e.advance();
    const st = stakes(e.w);
    expect(st.get('building:briar-hollow:burrows')).toBeGreaterThanOrEqual(1);
    expect(st.get('cohort:briar-hollow:gnoll')).toBeGreaterThanOrEqual(1);
    expect(st.get('matron-grisk')).toBeGreaterThan(0);
    expect(st.get('vellford') ?? 0).toBe(0);
    expect(e.w.facts.events({ kind: 'player-made' })[0].to).toContain('building:briar-hollow:burrows');
  });
  test('the locus: hops from the run centre and its cast; near beats far', () => {
    const e = briarEngine(false);
    const d = hops(e.w, 'briar-hollow', []);
    expect(d.get('briar-hollow')).toBe(0);
    expect(d.get('millbrook')).toBe(1);
    expect(d.get('vellford')!).toBeGreaterThan(d.get('millbrook')!);
    expect(attachment(['millbrook'], new Map(), d).locus).toBeGreaterThan(attachment(['vellford'], new Map(), d).locus);
  });
  test('a threat to what the player made outranks the same threat to a place they never touched', () => {
    const e = briarEngine(false);
    const st = new Map([['millbrook', 2]]);
    const d = hops(e.w, 'briar-hollow', st.keys());
    const mine = attachment(['millbrook'], st, d);
    const theirs = attachment(['vellford'], st, d);
    expect(mine.stakes).toBe(1);
    expect(theirs.stakes).toBe(0);
    expect(mine.stakes + mine.locus).toBeGreaterThan(theirs.stakes + theirs.locus);
  });
});

describe('mechanical rewards', () => {
  test('every template pays the player something besides its world change', () => {
    for (const t of TEMPLATES) {
      expect(t.reward.text.length, t.id).toBeGreaterThan(10);
      expect(rewardValue(t.reward), t.id).toBeGreaterThan(0);
    }
  });
  test('burrows: diggers join (regenerating gnolls) and the burrows unlock in the city builder', () => {
    const e = only(['build-burrows']);
    e.deal();
    const o = e.commit(offer(e, 'build-burrows').id);
    for (let i = 0; i < 5 && !e.past.includes(o); i++) e.advance();
    const d = e.w.holdings.agents.find((a) => a.name === 'Burrow-born diggers')!;
    expect(d).toMatchObject({ kind: 'workers', count: 4 });
    expect(pawnTraits(d)).toEqual(['living', 'regenerating']);
    expect(e.w.facts.tag('player', 'capability', 'city:communal burrows')?.value).toBe(true);
  });
  test('an engine piece: the caravans pay coin each turn; the weir shortens later water work', () => {
    const e = only(['open-corridor']);
    e.deal();
    const o = e.commit(offer(e, 'open-corridor').id);
    for (let i = 0; i < 5 && !e.past.includes(o); i++) e.advance();
    const coin = e.w.holdings.goods.coin;
    e.advance();
    expect(e.w.holdings.goods.coin).toBe(coin + 3);
    const d = only(['divert-river', 'ration-grain'], true);
    d.w.holdings.bonuses.push(TEMPLATES.find((t) => t.id === 'divert-river')!.reward.bonuses![0]);
    d.deal();
    d.advance();
    const c = d.commit(offer(d, 'divert-river').id);
    expect(c.resolvesTurn! - d.turn).toBe(2);
    expect(c.crew!.join(' ')).toMatch(/Weir-cut channels/);
  });
});

describe('species traits from the creature generator', () => {
  test('one source: the species spec carries its traits, the fact layer reads them', () => {
    expect(SPECIES.gnoll.traits).toEqual(['living', 'regenerating']);
    expect(speciesTraits('skeleton')).toEqual(['undead']);
    expect(unitTraits({ creature: 'gnoll', training: ['knight'] })).toEqual(['living', 'regenerating']);
    // (the unit builder's seam: a mount lends its movement)
    expect(unitTraits({ creature: 'human', mount: 'griffin' })).toEqual(['living', 'flying']);
  });
});
