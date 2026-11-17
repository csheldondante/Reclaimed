// (card-table; docs/design/CARD_TABLE.md) The synergy half of the card table on the Realm: a live event resolved from
// the model with no scene (the raid, the dead), casts that change how it ends, the prediction agreeing with the
// result, rules that fire with their reason, and for a rule that does not fire the one thing missing.
import { describe, expect, it } from 'vitest';
import { idleState, mechState, type LiveDef } from '../../src/living/live';
import { RuleBook, type RuleDef, type Thing } from '../../src/living/rules';
import { pools } from '../../src/season/ledger';
import { Table } from '../../src/table/game';
import { whyNot } from '../../src/table/words';

const play = (t: Table, each: (t: Table) => void): void => {
  while (!t.over) {
    each(t);
    t.endSeason();
  }
};
const takeAll = (want: (template: string) => boolean) => (t: Table) => {
  for (;;) {
    const c = t.cards().find((x) => want(x.template) && !Object.keys(x.short).length);
    if (!c || !t.take(c.id)) break;
  }
};

describe('mechState: a live event with nobody playing it', () => {
  const def: LiveDef = {
    tag: 'x', title: 't', how: 'h', line: 'l', camera: { zoom: 1 },
    groups: [
      { id: 'foes', kind: 'raider', side: 'foe', n: 5, tags: ['raider'], from: { site: 'here' } },
      { id: 'walk', kind: 'worker', side: 'folk', n: 4, tags: ['crowd'], from: { site: 'here' }, order: { kind: 'go', at: { site: 'here' } } },
    ],
    hazard: { kind: 'fire', at: { site: 'here' }, points: 6, spread: 10, radius: 2, intensity: 1 },
    ends: [], result: [], tiers: [{ tier: 'success' }],
  };
  it('groups told to go arrive; a fight and a fire are left as they began', () => {
    const s = mechState(def, {});
    expect(s.groups.walk.arrived).toBe(true);
    expect(s.groups.foes.alive).toBe(5);
    expect(s.burned).toBe(6);
    expect(idleState(def, {}).groups.walk.arrived).toBe(false);
  });
  it('each cast does what its spell does, never below nothing', () => {
    const s = mechState(def, {}, { fire: 1, heatray: 1, rain: 2 });
    expect(s.groups.foes).toMatchObject({ alive: 2, dead: 3 });
    expect(s.burned).toBe(2);
    expect(mechState(def, {}, { heatray: 9, rain: 9 })).toMatchObject({ burned: 0, groups: { foes: { alive: 0, dead: 5 } } });
  });
});

describe('RuleBook.check: the one thing a rule lacks', () => {
  const things: Thing[] = [
    { id: 'f', name: 'the east fields', tags: ['field', 'standing'], at: [0, 0], town: 'h' },
    { id: 'k', name: 'the keep yard', tags: ['keep', 'standing', 'worked'], at: [500, 0], town: 'h' },
    { id: 's', name: 'the smithy', tags: ['workshop', 'standing', 'worked'], at: [0, 0], town: 'h' },
  ];
  const rules: RuleDef[] = [
    { id: 'grow', name: 'Rune-fed fields', on: 'turn', a: { tags: ['field', 'worked', 'growth-active'] }, effect: { pool: 'materials', n: 2 }, cap: 2, why: '+{n}' },
    { id: 'forge', name: 'Forge by the keep', on: { live: 'raid' }, a: { tags: ['workshop', 'worked'] }, b: { tags: ['keep', 'worked'], near: { of: 'a', cells: 90 } }, effect: { amount: 'stopped', op: 'add', n: 1 }, why: '{n}' },
    { id: 'calm', name: 'Calm', on: 'turn', a: { tags: ['keep'] }, need: { pool: 'unrest', lte: 0 }, effect: { pool: 'magic', n: 1 }, cap: 1, why: '+{n}' },
    { id: 'none', name: 'Temple', on: 'turn', a: { tags: ['temple'] }, effect: { pool: 'magic', n: 1 }, cap: 1, why: '+{n}' },
    { id: 'ok', name: 'Keep', on: 'turn', a: { tags: ['keep', 'worked'] }, effect: { pool: 'might', n: 1 }, cap: 1, why: '+{n}' },
  ];
  const book = new RuleBook(rules, { things: () => things, pool: (k) => (k === 'unrest' ? 3 : 0), gain: (_k, n) => n });
  const why = (id: string) => {
    const c = book.check(rules.find((r) => r.id === id)!);
    return c.ok ? 'ok' : whyNot(c.missing!);
  };
  it('names the closest thing and the tags it lacks', () => {
    expect(why('grow')).toBe('Missing: nothing in play is "field" + "worked" + "growth-active". Closest: the east fields lacks "worked" + "growth-active".');
  });
  it('says when the second thing exists but is too far', () => {
    expect(why('forge')).toBe('Missing: the keep yard is too far from the smithy. It must be next to it.');
  });
  it('says a pool level it needs and what it is', () => {
    expect(why('calm')).toBe('Missing: Unrest must be 0 or less. It is 3.');
  });
  it('says when nothing carries any of its tags', () => {
    expect(why('none')).toBe('Missing: nothing in play is "temple".');
  });
  it('a rule with everything is ready; once fired it has paid for the season; a preview changes nothing', () => {
    expect(why('ok')).toBe('ok');
    book.season(1);
    expect(book.preview({ on: 'turn' }).map((h) => h.rule)).toEqual(['ok']);
    expect(book.fired('ok')).toBe(0);
    expect(book.fire({ on: 'turn' }).map((h) => h.rule)).toEqual(['ok']);
    expect(why('ok')).toBe('It has paid this season.');
  });
});

describe('the card table: live events and rules on the Realm', () => {
  it('the raid begins by itself in the last season and resolves from the model; doing nothing loses', () => {
    // (a raid of 6, whatever the game's own number: these two tests are about how a raid is read, not how hard it is)
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 8, raiders: 6 });
    while (!t.over && !t.liveEvents().some((e) => e.template === 'raid')) t.endSeason();
    const raid = t.liveEvents().find((e) => e.template === 'raid')!;
    expect(raid.groups.find((g) => g.side === 'foe')).toMatchObject({ n: 6, alive: 6 });
    expect(raid.tier).toBe('failure');
    t.endSeason();
    expect(t.over).toBe(true);
    expect(t.realm.fight).toMatchObject({ raiders: 6, held: false });
    expect(t.result!.title).toBe('The raiders broke through');
    expect(t.events.at(-1)).toMatchObject({ template: 'raid', tier: 'failure' });
  });

  it('casts into the raid change how it ends, cost Magic, and the prediction is the result', () => {
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 8, raiders: 6 });
    while (!t.over && !t.liveEvents().some((e) => e.template === 'raid')) t.endSeason();
    const magic = pools(t.realm.ledger).magic;
    expect(magic).toBeGreaterThanOrEqual(6);
    const fire = t.abilities().find((a) => a.id === 'spell:fire')!;
    const raid = t.liveEvents()[0];
    expect(fire.targets).toEqual([raid.id]);
    for (let i = 0; i < 6; i++) expect(t.cast('spell:fire', raid.id)).toBe(true);
    expect(pools(t.realm.ledger).magic).toBe(magic - 6);
    const now = t.liveEvents()[0];
    expect(now.groups.find((g) => g.side === 'foe')!.alive).toBe(0);
    expect(now.tier).toBe('success');
    expect(t.useful('spell:fire', raid.id)).toBe(false);
    t.endSeason();
    expect(t.realm.fight).toMatchObject({ raiders: 6, left: 0, held: true });
    expect(t.events.at(-1)!.tier).toBe('success');
  });

  it('a growth rune on worked fields pays at the season\'s end, with its reason in the log; before, the rules list says what is missing', () => {
    const t = new Table({ seed: 7, leader: 'dunstan', seasons: 16 });
    const rule = () => t.rules().find((r) => r.id === 'blessed-fields')!;
    expect(rule().ready).toBe(false);
    expect(rule().why).toMatch(/^Missing: nothing in play is "field" \+ "worked" \+ "growth-active"\. Closest: the east fields lacks "worked" \+ "growth-active"\.$/);
    let paid = false;
    play(t, (x) => {
      takeAll((id) => id === 'build:farms' || id === 'build:quarry' || id === 'build:lumber')(x);
      const g = x.abilities().find((a) => a.id === 'spell:growth')!;
      const field = x.things().find((th) => th.tags.includes('field'))!;
      if (!paid && field.tags.includes('worked') && g.can && g.targets.includes(field.id)) {
        const before = x.hits.length;
        expect(x.cast('spell:growth', field.id)).toBe(true);
        expect(x.things().find((th) => th.id === field.id)!.tags).toContain('growth-active');
        expect(rule().ready).toBe(true);
        x.endSeason();
        const hit = x.hits.slice(before).find((h) => h.hit.rule === 'blessed-fields');
        expect(hit, 'the rule fired').toBeTruthy();
        expect(hit!.hit).toMatchObject({ pool: 'materials', delta: 2 });
        expect(x.log.some((l) => l.kind === 'rule' && /Rune-fed fields/.test(l.text) && /\+2 Materials/.test(l.text))).toBe(true);
        expect(rule().fired.length).toBe(1);
        paid = true;
      }
    });
    expect(paid, `farms built: ${t.built().join(',')}`).toBe(true);
    expect(t.ruleCounts()['Rune-fed fields']).toBe(1);
  });

  it('the same moves, with casts, make the same run', async () => {
    const { replay } = await import('../../src/table/game');
    const a = new Table({ seed: 7, leader: 'ilveth', seasons: 8 });
    play(a, (x) => {
      takeAll(() => true)(x);
      for (const e of x.liveEvents()) for (const ab of x.abilities()) while (ab.targets.includes(e.id) && x.useful(ab.id, e.id) && x.cast(ab.id, e.id));
    });
    const b = replay({ seed: 7, leader: 'ilveth', seasons: 8 }, a.moves);
    expect(b.log).toEqual(a.log);
    expect(b.events).toEqual(a.events);
  });
});
