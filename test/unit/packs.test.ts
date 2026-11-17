// (card-table; docs/design/PACK_FORMAT.md) Outside-authored packs: the validator's vocabularies are the engine's own,
// the sample pack (packs/sample.json: every block of the format) passes, each kind of mistake is reported in words an
// author can act on, and a loaded pack plays on the Realm mixed with the base cards.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTATORS, SIGNS } from '../../src/mutate';
import { POOLS, POOL_ROLE, pools } from '../../src/season/ledger';
import { SITES } from '../../src/season/realm-templates';
import { LEADERS } from '../../src/season/run-words';
import { SPELL_MECH } from '../../src/living/live';
import { FIRE_TEMPLATE, LIVE_TEMPLATES } from '../../src/season/realm-events';
import { RUIN, RULES, SITE_TAGS, TIMED } from '../../src/season/realm-rules';
import { BASE_CARD_IDS, checkPack, EVENT_ABILITIES, FAR_KINDS, GOODS, KNOWN_TAGS, LAND_KINDS, LEADER_IDS, LIVE_AMOUNTS, LIVE_KINDS, LIVE_NEEDS, PEOPLE, POOL_NAMES, SIGN_KINDS, SITE_KEYS, type Pack } from '../../src/packs/check';
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
    // (loop round 7's `camp` sign needs a cell, which a pack's `sign` cannot give: it is the realm's `camp` helper's
    // only, so a pack may not name it — merge round 8)
    expect(SIGN_KINDS).toEqual(SIGNS.map((s) => s.kind).filter((k) => k !== 'camp'));
    expect(LEADER_IDS).toEqual(LEADERS.map((l) => l.id));
    expect([...BASE_CARD_IDS].sort()).toEqual(baseCards().sort());
    // (the tags the rules read: what a site is, the ruin words, the timed states; and the spells an event can take)
    for (const t of [...Object.values(SITE_TAGS).flatMap((s) => s.is), ...RUIN, ...TIMED, ...RULES.flatMap((r) => [...r.a.tags, ...(r.b?.tags ?? [])])]) expect(KNOWN_TAGS, t).toContain(t);
    expect(EVENT_ABILITIES.map((a) => a.replace('-', '')).sort()).toEqual(Object.keys(SPELL_MECH).sort());
    expect(LIVE_KINDS).toEqual(expect.arrayContaining(LIVE_TEMPLATES.map((t) => t.play!.event!.tag)));
    for (const t of [...LIVE_TEMPLATES, FIRE_TEMPLATE]) expect(LIVE_AMOUNTS[t.play!.event!.tag], t.id).toEqual(t.play!.event!.result.map((r) => r.as));
    for (const r of RULES) {
      if (typeof r.on === 'string' || !('live' in r.on)) continue;
      const names = [...('amount' in r.effect ? [r.effect.amount] : []), ...(typeof r.per === 'object' ? [r.per.amount] : [])];
      for (const a of names) expect(LIVE_NEEDS[r.on.live], `${r.id} changes ${a}`).toContain(a);
    }
  });

  const more: [string, (p: Pack) => void, RegExp][] = [
    ['a result of the event with no if_tier', (p) => void delete card(p, 'sample-thresh-fire').if_tier!.cost, /can end in "cost", but "if_tier" has no "cost"/],
    ['a crowd with nobody tagged crowd', (p) => void p.events![0].amounts.push('crowd'), /Give a group the tag "crowd"/],
    ['an ability that does nothing in an event', (p) => void (p.events![0].abilities = ['growth-rune']), /does nothing when cast into an event/],
    ['a fire event without the amount the base rules change', (p) => void (p.events![0].amounts = ['alive:bucket-line']), /A "fire" event must list the amount "burned"/],
    ['a rule naming an amount a base event has not', (p) => void (p.rules![2].effect = { amount: 'crowd', op: 'add', n: 1 }), /A "fire" event of the base game has no amount "crowd"/],
    ['a game tag set by an effect', (p) => void card(p, 'sample-build-granary').if_taken!.push({ tag: 'worked', on: 'site:fields' }), /is set by the game itself/],
  ];
  for (const [name, breakIt, want] of more)
    it(`reports ${name}`, () => {
      const p = copy();
      breakIt(p);
      const e = errors(p);
      expect(e.some((x) => want.test(x)), e.join('\n') || 'no errors').toBe(true);
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
    // (a rule needs no cap any more: the owner's ruling, engines are not bounded — test/unit/chains.test.ts)
    ['a rule whose effect changes nothing', (p) => void ((p.rules![0].effect as { n: number }).n = 0), /a number "n" that is not 0/],
    ['a threat with no if_expires', (p) => void delete card(p, 'sample-mill-fire').if_expires, /A threat needs "if_expires"/],
    ['a card that waits for a thing nobody puts', (p) => void (card(p, 'sample-build-granary').if_taken = [{ say: 'Done.' }]), /can never appear: it waits for the thing "sample-granary"/],
    ['cards that wait for each other', (p) => void (card(p, 'sample-build-granary').appears_when = [{ resolved: 'sample-take-in-neighbours' }]), /wait for it in turn/],
    ['a season past the run\'s end', (p) => void (card(p, 'sample-mill-fire').appears_when = [{ season_gte: 20 }]), /can never appear: a run has 16 seasons/],
    ['an event tier that can never be reached', (p) => void (p.events![0].tiers[1] = { tier: 'cost', when: [{ amount: 'burned', lte: 0 }] }), /can never be reached/],
    ['an event tier after an open one', (p) => void p.events![0].tiers.push({ tier: 'failure' }), /every result after it can never be reached/],
    ['an effect not built yet', (p) => void card(p, 'sample-build-granary').if_taken!.push({ units: 'soldier', add: 4 } as never), /not supported yet. Add soldiers with/],
    ['a land change that does not exist', (p) => void (card(p, 'sample-mill-fire').if_expires![0] = { mutate: 'overgrown', where: 'site:mill' }), /Unknown land change "overgrown"/],
    ['a far place that is no selector', (p) => void (card(p, 'sample-take-in-neighbours').if_taken![0] = { far: 'vassal', where: 'far:capital' }), /Unknown far place "far:capital"/],
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
  it('becomes templates whose words carry the data\'s numbers; a live card carries its event and a result for each tier', () => {
    const l = loadPack(SAMPLE, { cards: baseCards() });
    expect(l.templates.map((t) => t.id)).toEqual(['sample-build-granary', 'sample-bless-harvest', 'sample-night-watch-card', 'sample-mill-fire', 'sample-take-in-neighbours', 'sample-thresh-fire']);
    expect(l.left).toEqual([]);
    const live = l.templates[5];
    expect(live.play!.event).toMatchObject({ tag: 'fire', spells: ['rain'], hazard: { kind: 'fire', points: 5 }, tiers: [{ tier: 'triumph', when: [['burned', '<=', 0]] }, { tier: 'cost', when: [['burned', '<=', 2]] }, { tier: 'disaster' }] });
    expect(Object.keys(live.outcomes!)).toEqual(['triumph', 'cost', 'disaster']);
    expect(live.outcomes!.cost!.text).toBe('You lose 2 Materials of grain. -2 Materials.');
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
        // (the pack's rule reads the pack's tags: ready now, and it pays at the season's end)
        expect(t.rules().find((r) => r.id === 'sample-blessed-granary')!.ready).toBe(true);
        const before = t.hits.length;
        t.endSeason();
        expect(t.hits.slice(before).find((h) => h.hit.rule === 'sample-blessed-granary')?.hit).toMatchObject({ pool: 'materials', delta: 2 });
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
    expect(mill.tags.slice(0, 2)).toEqual(['ruined', 'burned']);
  });

  it('a pack\'s event plays: rain cast into it, the pack\'s rule about its own policy changes the result, its tier\'s effects apply', () => {
    // (the sample's fire, held back a few seasons so the granary and the night watch are both in play when it comes)
    const p = copy();
    card(p, 'sample-thresh-fire').appears_when!.push({ season_gte: 7 });
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 16, packs: [p] });
    const want = ['sample-build-granary', 'sample-night-watch-card', 'sample-thresh-fire', 'build:quarry', 'build:lumber'];
    let done = false;
    for (let s = 0; s < 14 && !t.over && !done; s++) {
      for (const id of want) {
        const c = t.cards().find((x) => x.template === id);
        if (c && !Object.keys(c.short).length) t.take(c.id);
      }
      const e = t.liveEvents().find((x) => x.template === 'sample-thresh-fire');
      if (e) {
        expect(e.hazard).toEqual({ points: 5, burned: 5 });
        // (the night watch is in play: the pack's rule takes one burning lot off, said on the card before anything is cast)
        expect(t.things().find((x) => x.id === 'briar-hollow')!.tags).toContain('night-watch');
        expect(e.rules.some((r) => /Lanterns at the fire/.test(r))).toBe(true);
        expect(e.tier).toBe('disaster');
        expect(t.cast('spell:rain', e.id)).toBe(true);
        expect(t.liveEvents()[0]).toMatchObject({ tier: 'cost', hazard: { burned: 3 } });
        expect(t.cast('spell:rain', e.id)).toBe(true);
        expect(t.liveEvents()[0]).toMatchObject({ tier: 'triumph', hazard: { burned: 1 } });
        const unrest = pools(t.realm.ledger).unrest;
        const before = t.hits.length;
        t.endSeason();
        expect(t.events.at(-1)).toMatchObject({ template: 'sample-thresh-fire', tier: 'triumph' });
        expect(t.hits.slice(before).some((h) => h.hit.rule === 'sample-watch-on-fire' && h.hit.delta === -1)).toBe(true);
        expect(t.realm.w.facts.entity(thingEntity('sample-granary'))).toBeTruthy();
        expect(unrest === 0 || pools(t.realm.ledger).unrest < unrest + 2).toBe(true);
        done = true;
        continue;
      }
      t.endSeason();
    }
    expect(done, `taken ${t.taken.join(',')}; seen ${[...t.seen].join(',')}`).toBe(true);
  });
});
