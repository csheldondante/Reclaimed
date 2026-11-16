// The mutators' bridge to the fact layer (src/mutate/facts.ts, outcomes.ts; docs/design/MUTATORS.md "Conformance"):
// a place's state lives in the fact world (the settlement's record, relations, condition tags, events), places() is a
// read of it, and a template's outcome can name a mutator.
import { expect, test } from 'vitest';
import { apply, type Ctx } from '../../src/living/dsl';
import { placeState, placeStates, recordMutation, recordSign, type FactSpec } from '../../src/mutate/facts';
import '../../src/mutate/outcomes';
import { ROW_H } from '../../src/world/lattice';
import { mutWorld } from '../support/mutworld';

const places = [
  { id: 'muru', name: 'Muru', at: [100, 200 * ROW_H] as const, radius: 30, size: 'town', faction: 'locals' },
  { id: 'kaud', name: 'Kaudru', at: [5000, 900 * ROW_H] as const, radius: 20, size: 'village', faction: null },
];
const spec = (s: Partial<FactSpec> & Pick<FactSpec, 'kind'>): FactSpec => ({ place: null, cell: [0, 0], radius: 20, strength: 1, ...s });

test('an untouched place stands, held by its record’s faction; places() lists only what was touched', () => {
  const w = mutWorld(places);
  expect(placeState(w, 'muru')).toMatchObject({ owner: 'locals', status: 'standing', tribute: 0, population: 1, conditions: [], restless: false, at: [100, 200] });
  expect(placeStates(w)).toEqual([]);
  expect(placeState(w, 'nowhere')).toBeNull();
});

test('vassal: relations and tribute, the record’s holder kept; a land change by area tags the place it covers', () => {
  const w = mutWorld(places);
  const ev = recordMutation(w, spec({ kind: 'vassal', place: 'muru', by: 'player', tribute: 3 }), { cause: 'opp-7' });
  expect(w.facts.relations({ type: 'vassal_of', from: 'muru', to: 'player' }).length).toBe(1);
  expect(w.facts.relations({ type: 'pays_tribute_to', from: 'muru' })[0].meta).toEqual({ perSeason: 3 });
  expect(w.settlement('muru')!.faction).toBe('locals');
  expect(w.facts.events({ kind: 'vassal' })[0]).toMatchObject({ id: ev, by: ['player'], to: ['muru'], about: { opp: 'opp-7' } });
  recordMutation(w, spec({ kind: 'burned', cell: [105, 200], radius: 20 }));
  expect(w.facts.tag('muru', 'condition', 'burned')?.value).toBe(true);
  expect(w.facts.tag('kaud', 'condition', 'burned')).toBeUndefined();
  const p = placeState(w, 'muru')!;
  expect(p).toMatchObject({ owner: 'player', status: 'vassal', tribute: 3, conditions: ['burned'], restless: true });
  expect(p.population).toBeCloseTo(0.5, 5);
  expect(p.history.length).toBe(2);
  // (the same again: one relation, the tribute replaced)
  recordMutation(w, spec({ kind: 'vassal', place: 'muru', by: 'iron-league', tribute: 5 }));
  expect(w.facts.relations({ type: 'vassal_of', from: 'muru', historic: false }).map((r) => r.to)).toEqual(['iron-league']);
  expect(placeState(w, 'muru')!.tribute).toBe(5);
});

test('captured: occupation and, for a faction, the record’s holder; abandoned after it empties the place', () => {
  const w = mutWorld(places);
  recordMutation(w, spec({ kind: 'captured', place: 'kaud', by: 'iron-league' }));
  expect(w.settlement('kaud')!.faction).toBe('iron-league');
  expect(w.facts.tag('kaud', 'condition', 'occupied')?.value).toBe(true);
  expect(placeState(w, 'kaud')).toMatchObject({ owner: 'iron-league', status: 'occupied', restless: true });
  // (a holder the world does not know is refused: no invented owners)
  expect(() => recordMutation(w, spec({ kind: 'captured', place: 'kaud', by: 'Nobody Inc' }))).toThrow(/entity of the fact world/);
  recordMutation(w, spec({ kind: 'abandoned', place: 'kaud' }));
  expect(w.settlement('kaud')!.condition).toBe('abandoned');
  expect(placeState(w, 'kaud')).toMatchObject({ status: 'abandoned', population: 0, restless: false });
  expect(placeStates(w).map((q) => q.id)).toEqual(['kaud']);
});

test('founded: a settlement record, its entity and a founding event; dried lowers the region’s river inflow', () => {
  const w = mutWorld(places);
  recordMutation(w, spec({ kind: 'founded', place: 'deep-cut', cell: [700, 300], name: 'Deep Cut', size: 'camp', by: 'locals' }), { regionAt: () => 0 });
  expect(w.settlement('deep-cut')).toMatchObject({ name: 'Deep Cut', size: 'camp', faction: 'locals', at: [700, 300 * ROW_H] });
  expect(w.facts.events({ kind: 'founding' })[0]).toMatchObject({ by: ['locals'], to: ['deep-cut'] });
  expect(placeState(w, 'deep-cut')).toMatchObject({ status: 'founded', owner: 'locals', at: [700, 300] });
  recordMutation(w, spec({ kind: 'destroyed', place: 'deep-cut' }));
  expect(placeState(w, 'deep-cut')).toMatchObject({ status: 'destroyed', population: 0 });
  expect(w.qty('muru', 'inflow')).toBe(1);
  recordMutation(w, spec({ kind: 'dried', place: 'muru', cell: [100, 200], strength: 0.8 }));
  expect(w.qty('muru', 'inflow')).toBeCloseTo(0.2, 5);
  expect(w.facts.events({ kind: 'river-inflow' }).length).toBe(1);
  expect(w.facts.events({ kind: 'dried' })[0].about?.atlas?.length).toBe(1);
});

test('a sign is a condition tag while it is on, and one event when it starts', () => {
  const w = mutWorld(places);
  expect(recordSign(w, 'ashfall', 'muru', true, 'opp-9')).not.toBeNull();
  expect(recordSign(w, 'ashfall', 'muru', true)).toBeNull();
  expect(w.facts.tag('muru', 'condition', 'ashfall')?.value).toBe(true);
  expect(w.facts.events({ kind: 'ashfall' }).length).toBe(1);
  recordSign(w, 'ashfall', 'muru', false);
  expect(w.facts.tag('muru', 'condition', 'ashfall')).toBeUndefined();
});

test('a template’s outcome names a mutator or a sign: the facts change on its world, the opportunity is the cause', () => {
  const w = mutWorld(places);
  const c: Ctx = { w, b: { town: 'muru', rival: 'iron-league' }, cause: 'opp-42', dry: true };
  apply(c, [
    { helper: 'mutate', args: ['flooded', '$town', 0.7, 3] },
    { helper: 'mutate', args: ['captured', '$town', 1, 1, '$rival'] },
    { helper: 'sign', args: ['darkness', '$town', 0.5, 2] },
  ]);
  expect(placeState(w, 'muru')).toMatchObject({ status: 'occupied', owner: 'iron-league', conditions: ['flooded'] });
  expect(w.facts.events({ kind: 'flooded' })[0].about).toEqual({ opp: 'opp-42' });
  expect(w.facts.tag('muru', 'condition', 'darkness')?.value).toBe(true);
  expect(() => apply(c, [{ helper: 'mutate', args: ['frozen', '$town'] }])).toThrow(/no mutator/);
});
