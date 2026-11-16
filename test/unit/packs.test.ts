// (card-table; docs/design/PACK_FORMAT.md) Outside-authored packs: the validator's vocabularies are the engine's own,
// the sample pack (packs/sample.json: every block of the format) passes, each kind of mistake is reported in words an
// author can act on, and a loaded pack plays on the Realm mixed with the base cards.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTATORS, SIGNS } from '../../src/mutate';
import { POOLS, POOL_ROLE, pools } from '../../src/season/ledger';
import { SITES } from '../../src/season/realm-templates';
import { LEADERS } from '../../src/season/run-words';
import { BASE_CARD_IDS, checkPack, FAR_KINDS, GOODS, LAND_KINDS, LEADER_IDS, PEOPLE, POOL_NAMES, SIGN_KINDS, SITE_KEYS, type Pack } from '../../src/packs/check';
import { loadPack, thingEntity } from '../../src/packs/load';
import { baseCards, Table } from '../../src/table/game';

const SAMPLE = JSON.parse(fs.readFileSync('packs/sample.json', 'utf8')) as Pack;
const copy = (): Pack => structuredClone(SAMPLE);
const errors = (p: Pack) => checkPack(p).filter((x) => x.level === 'error').map((x) => `${x.where}: ${x.text}`);
const card = (p: Pack, id: string) => p.cards!.find((c) => c.id === id)!;

describe('the pack validator', () => {
  it('knows the engine\'s own words', () => {
    expect(POOL_NAMES).toEqual([...POOLS]);
    expect(PEOPLE).toEqual(POOLS.filter((k) => POOL_ROLE[k] === 'people').reverse());
    expect([...GOODS].sort()).toEqual(POOLS.filter((k) => POOL_ROLE[k] === 'goods').sort());
    expect(SITE_KEYS).toEqual(SITES.map((s) => s.key));
    expect(LAND_KINDS).toEqual(MUTATORS.filter((m) => m.group === 'land').map((m) => m.kind));
    expect([...FAR_KINDS].sort()).toEqual(MUTATORS.filter((m) => m.group === 'state').map((m) => m.kind).sort());
    expect(SIGN_KINDS).toEqual(SIGNS.map((s) => s.kind));
    expect(LEADER_IDS).toEqual(LEADERS.map((l) => l.id));
    expect([...BASE_CARD_IDS].sort()).toEqual(baseCards().sort());
  });

  it('passes the sample pack', () => {
    expect(errors(SAMPLE)).toEqual([]);
  });

  const cases: [string, (p: Pack) => void, RegExp][] = [
    ['an unknown tag', (p) => void p.rules![0].a.tags.push('silo'), /Unknown tag "silo"/],
    ['an unknown pool', (p) => void ((card(p, 'sample-build-granary').cost as Record<string, number>).gold = 2), /Unknown pool "gold"/],
    ['an unknown site', (p) => void (card(p, 'sample-build-granary').presenter.at = 'site:barn'), /Unknown place "site:barn"/],
    ['an unknown effect', (p) => void card(p, 'sample-build-granary').if_taken!.push({ teleport: 'home' } as never), /Unknown effect/],
    ['an unknown condition', (p) => void (card(p, 'sample-build-granary').appears_when = [{ weather: 'rain' } as never]), /Unknown condition/],
    ['an unknown ability', (p) => void (p.events![0].abilities = ['blizzard']), /Unknown ability "blizzard"/],
    ['an id used twice', (p) => void (p.cards![1].id = p.cards![0].id), /used twice/],
    ['an id of the base game', (p) => void (p.cards![1].id = 'mend-dam'), /already a card of the base game/],
    ['a number in a sentence that the data has not', (p) => void (card(p, 'sample-take-in-neighbours').if_expires![2] = { say: 'Their hungry walk to your gate. 60 people sleep in the road.' }), /says 60/],
    ['a number in a pitch that the data has not', (p) => void (card(p, 'sample-build-granary').pitch = 'Give me 5 workers.'), /pitch says 5/],
    ['a rule that adds to a pool with no cap', (p) => void delete p.rules![0].cap, /no "cap"/],
    ['a threat with no if_expires', (p) => void delete card(p, 'sample-mill-fire').if_expires, /A threat needs "if_expires"/],
    ['a card that waits for a thing nobody puts', (p) => void (card(p, 'sample-build-granary').if_taken = [{ say: 'Done.' }]), /can never appear: it waits for the thing "sample-granary"/],
    ['cards that wait for each other', (p) => void (card(p, 'sample-build-granary').appears_when = [{ resolved: 'sample-take-in-neighbours' }]), /wait for it in turn/],
    ['a season past the run\'s end', (p) => void (card(p, 'sample-mill-fire').appears_when = [{ season_gte: 20 }]), /can never appear: a run has 16 seasons/],
    ['an event tier that can never be reached', (p) => void (p.events![0].tiers[1] = { tier: 'cost', when: [{ amount: 'burned', lte: 0 }] }), /can never be reached/],
    ['an event tier after an open one', (p) => void p.events![0].tiers.push({ tier: 'failure' }), /every result after it can never be reached/],
    ['an effect not built yet', (p) => void card(p, 'sample-build-granary').if_taken!.push({ units: 'soldier', add: 4 } as never), /not supported yet. Add soldiers with/],
    ['a land change that does not exist', (p) => void (card(p, 'sample-mill-fire').if_expires![0] = { mutate: 'overgrown', where: 'site:mill' }), /Unknown land change "overgrown"/],
    ['a far place other than the neighbour', (p) => void (card(p, 'sample-take-in-neighbours').if_taken![0] = { far: 'vassal', where: 'far:capital' }), /"far:capital" is not supported yet/],
    ['a cost in Unrest', (p) => void ((card(p, 'sample-build-granary').cost as Record<string, number>).unrest = 1), /Unrest cannot be paid/],
    ['a live card with no if_tier', (p) => void delete card(p, 'sample-thresh-fire').if_tier, /needs "if_tier"/],
  ];
  for (const [name, breakIt, want] of cases)
    it(`reports ${name}`, () => {
      const p = copy();
      breakIt(p);
      const e = errors(p);
      expect(e.some((x) => want.test(x)), e.join('\n') || 'no errors').toBe(true);
    });

  it('warns of a tag nothing produces and a tag nothing reads', () => {
    const p = copy();
    p.tags!.push({ id: 'haunted', on: 'site', meaning: 'Ghosts walk here.' });
    const w = checkPack(p).filter((x) => x.level === 'warn').map((x) => x.text);
    expect(w.some((x) => /Nothing produces this tag/.test(x))).toBe(true);
    expect(w.some((x) => /Nothing reads this tag/.test(x))).toBe(true);
  });
});

describe('a loaded pack', () => {
  it('becomes templates whose words carry the data\'s numbers; a live card is left out and said so', () => {
    const l = loadPack(SAMPLE, { cards: baseCards() });
    expect(l.templates.map((t) => t.id)).toEqual(['sample-build-granary', 'sample-bless-harvest', 'sample-night-watch-card', 'sample-mill-fire', 'sample-take-in-neighbours']);
    expect(l.left.map((x) => x.card)).toEqual(['sample-thresh-fire']);
    const g = l.templates[0];
    expect(g.requires).toEqual({ agents: [{ kind: 'workers', count: 2 }], goods: { materials: 3 } });
    expect(g.turns).toBe(2);
    expect(g.reward.text).toBe('The granary stands by the east fields. In play: Stone granary. +1 Materials each season.');
    expect(g.expireText).toBe('The grain rots. People go hungry. Unrest +1.');
    expect(l.rules.length).toBe(3);
  });

  it('refuses a pack with errors, with the report', () => {
    const p = copy();
    p.rules![0].a.tags.push('silo');
    expect(() => loadPack(p)).toThrow(/Unknown tag "silo"/);
  });

  it('plays on the Realm with the base cards: a thing put in play, an ability unlocked and cast, a threat left to burn', () => {
    const t = new Table({ seed: 7, leader: 'dunstan', seasons: 16, packs: [SAMPLE] });
    const seen = new Set<string>();
    const want = ['sample-build-granary', 'sample-bless-harvest', 'sample-night-watch-card'];
    let cast = false;
    let income0 = 0;
    for (let s = 0; s < 14 && !t.over; s++) {
      for (const c of t.cards()) {
        seen.add(c.template);
        if (want.includes(c.template) && !Object.keys(c.short).length) {
          if (c.template === 'sample-build-granary') income0 = t.realm.ledger.income.materials ?? 0;
          t.take(c.id);
        }
      }
      const a = t.abilities().find((x) => x.id === 'sample-harvest-blessing');
      if (a && a.can && a.targets.length && !cast) {
        const magic = pools(t.realm.ledger).magic;
        expect(t.cast(a.id, a.targets[0])).toBe(true);
        expect(pools(t.realm.ledger).magic).toBe(magic - 1);
        expect(t.things().find((x) => x.id === a.targets[0])!.tags).toEqual(['granary', 'blessed']);
        cast = true;
        t.endSeason();
        // (a timed tag: gone when the season it was set in is over)
        expect(t.things().find((x) => x.id === thingEntity('sample-granary'))!.tags).toEqual(['granary']);
        continue;
      }
      t.endSeason();
    }
    expect([...seen]).toEqual(expect.arrayContaining(['sample-build-granary', 'sample-mill-fire']));
    expect(t.taken).toEqual(expect.arrayContaining(['sample-build-granary', 'sample-bless-harvest']));
    expect(t.realm.w.facts.entity(thingEntity('sample-granary'))).toBeTruthy();
    expect(t.realm.ledger.income.materials).toBeGreaterThanOrEqual(income0 + 1);
    expect(cast).toBe(true);
    // (the mill fire was never answered: the mill street is ruined and shows it)
    expect(t.lapsed).toContain('sample-mill-fire');
    const mill = t.things().find((x) => x.name === 'the mill street')!;
    expect(mill.ruined).toBe(true);
    expect(mill.tags).toEqual(['ruined', 'burned']);
  });
});
