// (card-table; docs/design/PACK_FORMAT.md) The format's later words: a thing's upkeep each season, a card's weight, a
// pack ability cast into a live event, and unlocked abilities kept in the run's history.
import { describe, expect, it } from 'vitest';
import { checkPack, type Pack } from '../../src/packs/check';
import { loadPack, thingEntity, UNLOCKED } from '../../src/packs/load';
import { Table } from '../../src/table/game';

const PACK: Pack = {
  pack: { id: 'more', name: 'More', version: 1 },
  tags: [{ id: 'drilled', on: 'town', meaning: 'Archers drill on the green.', timed: false }],
  things: [{ id: 'more-butts', name: 'Archery butts', kind: 'building', at: 'town', tags: ['drilled'], upkeep: { materials: 2 }, text: 'Archers drill here. It costs 2 Materials each season.' }],
  cards: [
    {
      id: 'more-raise-butts', title: 'Raise archery butts', presenter: { role: 'fletcher', at: 'site:keep' }, pitch: 'Give me 1 worker and I will train archers.', weight: 5,
      cost: { labor: 1 }, if_taken: [{ put: 'more-butts' }, { unlock: 'more-volley' }, { say: 'Archers drill on the green.' }], if_expires: [{ say: 'The fletcher goes back to his bench.' }],
    },
    { id: 'more-late', title: 'A late card', presenter: { role: 'reeve', at: 'site:fields' }, pitch: 'Later.', weight: 1, cost: { labor: 1 }, if_taken: [{ say: 'Done.' }], if_expires: [{ say: 'Gone.' }] },
  ],
  rules: [{ id: 'more-drilled', name: 'Drilled archers', on: { live: 'raid' }, a: { tags: ['home', 'drilled'] }, effect: { amount: 'stopped', op: 'add', n: 1 }, why: 'your archers stopped {n} raider' }],
  abilities: [{ id: 'more-volley', name: 'Call a volley', cost: { magic: 2 }, in_event: { kinds: ['raid'], kills: 3 }, text: 'Cast it into a raid. It puts down 3 raiders.' }],
};
const errs = (p: Pack) => checkPack(p).filter((x) => x.level === 'error').map((x) => x.text);

describe('upkeep, weight, an ability cast into an event, unlocks kept', () => {
  it('passes the validator; mistakes in the new words are said', () => {
    expect(errs(PACK)).toEqual([]);
    const a = structuredClone(PACK);
    a.things![0].upkeep = { labor: 1 };
    expect(errs(a).some((x) => /Upkeep can be paid in materials, magic, intel only/.test(x))).toBe(true);
    const b = structuredClone(PACK);
    b.cards![0].weight = 9;
    expect(errs(b).some((x) => /"weight" is a whole number from 1/.test(x))).toBe(true);
    const c = structuredClone(PACK);
    c.abilities![0].in_event = { kinds: ['raid'], kills: 3, douses: 1 };
    expect(errs(c).some((x) => /exactly one of "kills"/.test(x))).toBe(true);
    const d = structuredClone(PACK);
    d.abilities![0].text = 'It puts down 5 raiders.';
    expect(errs(d).some((x) => /The text says 5/.test(x))).toBe(true);
  });

  it('upkeep becomes a rule; weight becomes the dealer\'s score', () => {
    const l = loadPack(PACK);
    expect(l.rules.map((r) => r.id)).toEqual(['more-drilled', 'upkeep:more-butts:materials']);
    expect(l.templates[0].parts).toEqual({ ev: 0.9 });
    expect(l.templates[1].parts).toEqual({ ev: 0.1 });
  });

  it('in play: the thing costs its upkeep each season, the unlock is in the history, the ability is cast into the raid', () => {
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 8, packs: [PACK] });
    // (weight 5 against 1: the heavy card is dealt in the first season, the light one is not)
    expect(t.cards().map((c) => c.template)).toContain('more-raise-butts');
    expect(t.cards().map((c) => c.template)).not.toContain('more-late');
    expect(t.take('more-raise-butts')).toBe(true);
    expect(t.unlocked).toEqual([]);
    t.endSeason();
    expect(t.realm.w.facts.entity(thingEntity('more-butts'))).toBeTruthy();
    expect(t.unlocked).toEqual(['more-volley']);
    expect(t.realm.history().some((e) => e.kind === `${UNLOCKED}more-volley`)).toBe(true);
    expect(t.realm.snapshot().facts?.events.some((e) => e.kind === `${UNLOCKED}more-volley`)).toBe(true);
    const butts = t.things().find((x) => x.name === 'Archery butts')!;
    expect(butts.tags).toEqual(['drilled']);
    expect(t.things().find((x) => x.id === 'briar-hollow')!.tags).toContain('drilled');
    const before = t.hits.length;
    t.endSeason();
    expect(t.hits.slice(before).find((h) => h.hit.rule === 'upkeep:more-butts:materials')?.hit).toMatchObject({ pool: 'materials', delta: -2 });
    expect(t.log.some((l) => l.kind === 'rule' && /Archery butts cost you 2 Materials/.test(l.text))).toBe(true);
    while (!t.over && !t.liveEvents().some((e) => e.template === 'raid')) t.endSeason();
    const raid = t.liveEvents().find((e) => e.template === 'raid')!;
    // (the pack's rule about its own tag is on the raid's card before anything is cast)
    expect(raid.rules.some((r) => /Drilled archers/.test(r))).toBe(true);
    const volley = t.abilities().find((a) => a.id === 'more-volley')!;
    expect(volley.targets).toEqual([raid.id]);
    const magic = t.poolViews().find((p) => p.pool === 'magic')!.have;
    expect(t.cast('more-volley', raid.id)).toBe(true);
    expect(t.poolViews().find((p) => p.pool === 'magic')!.have).toBe(magic - 2);
    expect(t.liveEvents()[0].groups.find((g) => g.side === 'foe')).toMatchObject({ n: 6, alive: 3 });
    expect(t.cast('more-volley', raid.id)).toBe(true);
    expect(t.liveEvents()[0]).toMatchObject({ tier: 'success' });
    t.endSeason();
    expect(t.realm.fight).toMatchObject({ held: true, left: 0 });
    // (the next run in this world: the ability was that run's)
    expect(t.next('ilveth').unlocked).toEqual([]);
  });
});
