// The fact layer (api/contracts/facts.ts, facts-store.ts, facts-rules.ts; BACKLOG LW-F1..F3): entities with scoped tags,
// directed relations with history edges, claims kept apart from control, the append-only history, the invariants,
// the indexes, persistence through the world snapshot (and migration from a save without facts), and diplomacy merged
// in (its agreements are relations, its interactions events).
import { describe, expect, test } from 'vitest';
import { MemoryFacts, migrateFacts } from '../../src/api/contracts/facts-store';
import { checkInvariants, lawAt, polityOf } from '../../src/api/contracts/facts-rules';
import { importDiplomacy, MemoryDiplomacy } from '../../src/api/contracts/diplomacy-memory';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import type { Agreement } from '../../src/api/contracts/diplomacy';

function realm(): MemoryFacts {
  const f = new MemoryFacts();
  f.add({ id: 'kingdom', kind: 'polity', name: 'Kingdom', tags: [{ scope: 'law', key: 'serfdom', value: 'legal', since: 0 }, { scope: 'government', key: 'hereditary_nobility', value: true, since: 0 }] });
  f.add({ id: 'town', kind: 'settlement', name: 'Town', at: { region: 3 } });
  f.add({ id: 'serfs', kind: 'cohort', name: 'Serfs', at: { region: 3, settlement: 'town' }, tags: [{ scope: 'economy', key: 'labor', value: 'serf', since: 0 }] });
  f.add({ id: 'gnolls', kind: 'cohort', name: 'Gnolls', at: { region: 3, settlement: 'town' }, tags: [{ scope: 'custom', key: 'communal_housing', value: true, since: 0 }, { scope: 'biology', key: 'species', value: 'gnoll', since: 0 }] });
  f.relate({ type: 'part_of_polity', from: 'town', to: 'kingdom' });
  f.relate({ type: 'resident_at', from: 'serfs', to: 'town' });
  f.relate({ type: 'resident_at', from: 'gnolls', to: 'town' });
  return f;
}

describe('scoped tags', () => {
  test('each scope only on the kinds that can carry it', () => {
    const f = realm();
    expect(() => f.setTag('gnolls', 'law', 'serfdom', 'legal')).toThrow(/can't carry a law tag/);
    expect(() => f.setTag('kingdom', 'biology', 'species', 'human')).toThrow(/biology/);
    f.setTag('town', 'law', 'curfew', true);
    expect(f.tag('town', 'law', 'curfew')?.value).toBe(true);
  });
  test('quantities are never tags, intensities are bounded', () => {
    const f = realm();
    expect(() => f.setTag('town', 'condition', 'food', true)).toThrow(/quantity/);
    expect(() => f.setTag('town', 'condition', 'unrest', 1.5)).toThrow(/0..1/);
    expect(() => f.setTag('town', 'condition', 'hunger', 0.4)).toThrow(/intensit/);
    expect(f.bump('serfs', 'unrest', 0.7)).toBeCloseTo(0.7);
    expect(f.bump('serfs', 'unrest', 0.7)).toBe(1);
  });
  test('a cohort custom is not its polity law: the law comes from the jurisdiction, a settlement may override', () => {
    const f = realm();
    expect(lawAt(f, 'gnolls', 'serfdom')).toEqual({ value: 'legal', from: 'kingdom' });
    expect(polityOf(f, 'serfs')).toBe('kingdom');
    expect(f.tag('kingdom', 'custom', 'communal_housing')).toBeUndefined();
    f.setTag('town', 'law', 'serfdom', 'abolished');
    expect(lawAt(f, 'serfs', 'serfdom')).toEqual({ value: 'abolished', from: 'town' });
  });
});

describe('invariants', () => {
  test('no legal serfdom where it is abolished, unless marked as an explicit exception', () => {
    const f = realm();
    expect(checkInvariants(f)).toEqual([]);
    f.setTag('kingdom', 'law', 'serfdom', 'abolished');
    const v = checkInvariants(f);
    expect(v.map((x) => x.rule)).toEqual(['bondage-legal']);
    expect(v[0].entity).toBe('serfs');
    f.setTag('serfs', 'condition', 'illegal_serfdom', true);
    expect(checkInvariants(f)).toEqual([]);
  });
  test('no mutually exclusive policies in one jurisdiction', () => {
    const f = realm();
    f.setTag('kingdom', 'government', 'authoritarian', true);
    f.setTag('kingdom', 'government', 'elected_offices', true);
    expect(checkInvariants(f).map((x) => x.rule)).toContain('exclusive-policies');
  });
  test('war and alliance at once is refused; a court needs nobility or an explicit pretender', () => {
    const f = realm();
    f.add({ id: 'a', kind: 'faction', name: 'A' });
    f.add({ id: 'b', kind: 'faction', name: 'B' });
    f.relate({ type: 'allied_with', from: 'a', to: 'b', symmetric: true });
    f.relate({ type: 'at_war_with', from: 'b', to: 'a', symmetric: true });
    expect(checkInvariants(f, ['a']).map((x) => x.rule)).toContain('war-is-explicit');
    f.add({ id: 'court', kind: 'faction', name: 'Court', at: { settlement: 'town' }, tags: [{ scope: 'government', key: 'hereditary_court', value: true, since: 0 }] });
    expect(checkInvariants(f, ['court'])).toEqual([]);
    f.setTag('kingdom', 'government', 'hereditary_nobility', false);
    expect(checkInvariants(f, ['court']).map((x) => x.rule)).toEqual(['court-needs-nobility']);
    f.setTag('court', 'condition', 'pretender', true);
    expect(checkInvariants(f, ['court'])).toEqual([]);
  });
});

describe('relations, claims, history', () => {
  test('directed, asymmetric allowed; symmetric ones hold both ways as one record', () => {
    const f = realm();
    f.add({ id: 'a', kind: 'faction', name: 'A' });
    f.add({ id: 'b', kind: 'faction', name: 'B' });
    f.relate({ type: 'grievance_against', from: 'a', to: 'b', strength: 0.4 });
    expect(f.relations({ type: 'grievance_against', from: 'b', to: 'a' })).toEqual([]);
    f.relate({ type: 'allied_with', from: 'a', to: 'b', symmetric: true });
    expect(f.relations({ type: 'allied_with', from: 'b', to: 'a' })).toHaveLength(1);
    expect(f.relations({ type: 'allied_with' })).toHaveLength(1);
  });
  test('an ended alliance leaves its history edge (former_ally_of)', () => {
    const f = realm();
    f.add({ id: 'a', kind: 'faction', name: 'A' });
    f.add({ id: 'b', kind: 'faction', name: 'B' });
    f.relate({ type: 'allied_with', from: 'a', to: 'b', symmetric: true });
    f.unrelate({ type: 'allied_with', from: 'a', to: 'b' });
    expect(f.relations({ type: 'allied_with' })).toEqual([]);
    expect(f.relations({ type: 'former_ally_of', from: 'b', to: 'a' })).toHaveLength(1);
    expect(f.relations({ from: 'a', historic: false })).toEqual([]);
  });
  test('a claim is kept apart from control, names real ends, may lapse', () => {
    const f = realm();
    f.add({ id: 'farm', kind: 'site', name: 'Farm', at: { settlement: 'town' } });
    f.add({ id: 'house', kind: 'faction', name: 'House' });
    f.relate({ type: 'controls', from: 'house', to: 'farm' });
    expect(() => f.claim({ claimant: 'house', target: 'nowhere', basis: 'ancestral', strength: 0.5 })).toThrow(/no entity/);
    f.claim({ claimant: 'house', target: 'farm', basis: 'ancestral', strength: 0.5 });
    expect(checkInvariants(f, ['house']).map((x) => x.rule)).toEqual(['claim-not-control']);
    const c = f.claim({ claimant: 'serfs', target: 'farm', basis: 'debt', strength: 0.3, recognisedBy: ['kingdom'], expires: 4 });
    expect(f.claims({ target: 'farm' })).toHaveLength(2);
    expect(c.recognisedBy).toEqual(['kingdom']);
  });
  test('the history is append-only, by turn, with real participants', () => {
    const f = realm();
    f.turn = 2;
    const e = f.record({ kind: 'founding', by: ['kingdom'], to: ['town'], note: 'the town founded' });
    expect(e.turn).toBe(2);
    expect(f.events({ involving: 'town' })).toEqual([e]);
    expect(() => f.record({ id: e.id, kind: 'x', by: [], to: [], note: '' })).toThrow(/already/);
  });
});

describe('indexes and changes', () => {
  test('find by kind, tag, place; changed entities drained', () => {
    const f = realm();
    expect(f.find({ kind: 'cohort' }).map((e) => e.id)).toEqual(['gnolls', 'serfs']);
    expect(f.find({ tag: { scope: 'custom', key: 'communal_housing' } }).map((e) => e.id)).toEqual(['gnolls']);
    expect(f.find({ tag: { scope: 'economy', key: 'labor', value: 'free' } })).toEqual([]);
    expect(f.find({ settlement: 'town', kind: 'cohort' })).toHaveLength(2);
    expect(f.find({ region: 3 })).toHaveLength(3);
    f.drainChanged();
    f.bump('gnolls', 'prosperity', 0.2);
    expect([...f.drainChanged()]).toEqual(['gnolls']);
  });
  test('1000 entities: a tag query is indexed (well under a millisecond each)', () => {
    const f = new MemoryFacts();
    for (let i = 0; i < 1000; i++) f.add({ id: `c${i}`, kind: 'cohort', name: `c${i}`, tags: i % 100 === 0 ? [{ scope: 'custom', key: 'rare', value: true, since: 0 }] : [] });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) f.find({ tag: { scope: 'custom', key: 'rare' } });
    expect((performance.now() - t0) / 1000).toBeLessThan(0.2);
    expect(f.find({ tag: { scope: 'custom', key: 'rare' } })).toHaveLength(10);
  });
});

describe('persistence', () => {
  test('the facts ride in the world snapshot and restore the same', () => {
    const w = new MemoryWorldState(1, [{ id: 3, name: 'Vale', kind: 'valley' }]);
    w.facts = realm();
    w.facts.claim({ claimant: 'serfs', target: 'town', basis: 'ancestral', strength: 0.2 });
    const s = JSON.parse(JSON.stringify(w.snapshot()));
    const r = MemoryWorldState.restore(s);
    expect(r.facts.snapshot()).toEqual(w.facts.snapshot());
    expect(lawAt(r.facts, 'serfs', 'serfdom')?.value).toBe('legal');
  });
  test('a save without facts migrates: its factions, settlements and characters become entities that refer to them', () => {
    const w = new MemoryWorldState(1, [], [{ id: 'iron', name: 'Iron', ethos: '', era: 'medieval', attitude: 0, relations: {} }]);
    w.settlements.push({ id: 'oak', name: 'Oak', region: 2, faction: 'iron', at: [0, 0], radius: 10, size: 'town', condition: 'thriving', grids: [], buildings: [], people: [], stores: {}, needs: [] });
    const s = w.snapshot();
    delete s.facts;
    const f = MemoryWorldState.restore(s).facts;
    expect(f.entity('iron')).toMatchObject({ kind: 'faction', ref: { faction: 'iron' } });
    expect(f.entity('oak')).toMatchObject({ kind: 'settlement', ref: { settlement: 'oak' }, at: { region: 2 } });
    expect(migrateFacts(s).snapshot()).toEqual(f.snapshot());
  });
});

describe('diplomacy merged into the facts', () => {
  const trade: Agreement = { id: 'deal', kind: 'trade', parties: [{ faction: 'a' }, { faction: 'b' }], flows: [{ from: 0, to: 1, what: 'grain', perDay: 2 }], since: { run: 0 }, status: 'active' };
  test('an agreement in force is a relation; ending it leaves history and an event', () => {
    const f = new MemoryFacts();
    const d = new MemoryDiplomacy(f);
    d.agree({ id: 'ally', kind: 'alliance', parties: [{ faction: 'a' }, { faction: 'b' }], since: { run: 0 }, status: 'active' });
    expect(f.relations({ type: 'allied_with', from: 'b', to: 'a' })).toHaveLength(1);
    expect(d.opinion({ faction: 'a' }, { faction: 'b' }).stance).toBe('allied');
    d.end('ally', 'ended');
    expect(f.relations({ type: 'allied_with' })).toEqual([]);
    expect(f.relations({ type: 'former_ally_of' })).toHaveLength(1);
    expect(f.events({ kind: 'agreement-ended' })).toHaveLength(1);
    expect(d.agreements({ faction: 'a' })).toEqual([]);
  });
  test('interactions are events with a weight: one history, opinions read off it', () => {
    const f = new MemoryFacts();
    const d = new MemoryDiplomacy(f);
    d.agree(trade);
    d.note({ id: 'i1', run: 0, by: { who: 'bran', faction: 'b' }, to: { faction: 'a' }, kind: 'gift', weight: 0.4, halfLife: Infinity, note: 'a gift of salt' });
    expect(f.events({ kind: 'gift' })[0]).toMatchObject({ by: ['bran'], to: ['a'], weight: 0.4 });
    expect(f.events({ kind: 'gift' })[0].halfLife).toBeUndefined();
    expect(f.relations({ type: 'member_of', from: 'bran', to: 'b' })).toHaveLength(1);
    const o = d.opinion({ faction: 'a' }, { faction: 'b' });
    expect(o.value).toBeCloseTo(0.15 + 0.2);
    expect(o.because[0].halfLife).toBe(Infinity);
    d.end('deal', { brokenBy: { faction: 'b' }, note: 'stopped the grain' });
    expect(d.opinion({ faction: 'a' }, { faction: 'b' }).value).toBeCloseTo(0.2 - 0.6);
  });
  test('an old record imports into a fact store and reads the same', () => {
    const old = new MemoryDiplomacy();
    old.agree(trade);
    old.note({ id: 'i1', run: 0, by: { faction: 'b' }, to: { faction: 'a' }, kind: 'insult', weight: -0.3, halfLife: 2, note: 'mocked' });
    const f = new MemoryFacts();
    const d = importDiplomacy(f, { interactions: old.interactions, deals: old.deals });
    expect(d.opinion({ faction: 'a' }, { faction: 'b' }).value).toBeCloseTo(old.opinion({ faction: 'a' }, { faction: 'b' }).value);
    expect(d.deals).toEqual(old.deals);
  });
});
