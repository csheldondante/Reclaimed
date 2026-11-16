// (loop-skeleton round 6) Live events as data (living/live.ts) and the tags-and-synergy rules (living/rules.ts), then
// both on the realm (season/realm-events.ts, realm-rules.ts): an event resolves from the state it is in through its
// template's tiered outcomes, and every rule fires once a season, up to its capacity, with its reason.
import { describe, expect, it } from 'vitest';
import { briarWorld } from '../../src/living/briar';
import { checkLive, idleState, liveDerive, liveEnded, liveRead, liveTier, type LiveDef, type LiveState } from '../../src/living/live';
import { RuleBook, type RuleDef, type Thing } from '../../src/living/rules';
import { grant, newLedger, nextSeason, pools, total, type SeasonLedger } from '../../src/season/ledger';
import { LIVE_TEMPLATES, MARKET_FIRE, PARADE, RAID } from '../../src/season/realm-events';
import { Realm, type Leader } from '../../src/season/realm';
import { RULES, SITE_TAGS } from '../../src/season/realm-rules';
import { siteId, SITES } from '../../src/season/realm-templates';
import { lint } from '../support/writing';

const def = (id: string): LiveDef => LIVE_TEMPLATES.find((t) => t.id === id)!.play!.event!;

describe('a live event as data (living/live.ts)', () => {
  it('every event of the run is well formed', () => {
    for (const t of LIVE_TEMPLATES) expect(checkLive(t.id, t.play!.event!, ['raid', 'soldiers', 'watchers'])).toEqual([]);
  });

  it('the raid: ends when no raider is left, or no soldier has stood for 5 s, or after its seconds', () => {
    const d = def(RAID);
    const s = idleState(d, { raid: 6, soldiers: 9 });
    expect(liveEnded(d, s)).toBe(false);
    expect(liveEnded(d, { ...s, groups: { ...s.groups, raiders: { ...s.groups.raiders, alive: 0, dead: 6 } } })).toBe(true);
    const none = { ...s, groups: { ...s.groups, soldiers: { ...s.groups.soldiers, alive: 0, dead: 9 } } };
    expect(liveEnded(d, { ...none, absent: { soldier: 3 } })).toBe(false);
    expect(liveEnded(d, { ...none, absent: { soldier: 5 } })).toBe(true);
    expect(liveEnded(d, { ...s, t: 150 })).toBe(true);
  });

  it('the raid read: each soldier standing holds a raider, the rest got in; a squad of 3 fallen is a Might', () => {
    const d = def(RAID);
    const at = (alive: number, soldiers: number, dead: number): LiveState => {
      const s = idleState(d, { raid: 6, soldiers: soldiers + dead });
      return { ...s, groups: { raiders: { ...s.groups.raiders, alive, dead: 6 - alive }, soldiers: { ...s.groups.soldiers, alive: soldiers, dead } } };
    };
    // (all dead: held)
    let v = liveDerive(d, liveRead(d, at(0, 5, 4)));
    expect(v).toMatchObject({ raiders: 6, left: 0, fallen: 4, mightLost: 2 });
    expect(liveTier(d, v)).toBe('success');
    // (sacked: no soldier left, 4 raiders up)
    v = liveDerive(d, liveRead(d, at(4, 0, 9)));
    expect(v).toMatchObject({ left: 4, mightLost: 3 });
    expect(liveTier(d, v)).toBe('failure');
    // (time up with both standing: 3 soldiers hold 3 of 5)
    v = liveDerive(d, liveRead(d, at(5, 3, 0)));
    expect(v.left).toBe(2);
    // (a rule stopped 2 more)
    v = liveDerive(d, { ...liveRead(d, at(5, 3, 0)), stopped: 2 });
    expect(v.left).toBe(0);
    // (nobody came: no road)
    expect(liveTier(d, liveDerive(d, liveRead(d, idleState(d, { raid: 0, soldiers: 0 }))))).toBe('cost');
  });

  it('a fire: unfought, every stall burns; it ends when nothing is alight after 20 s', () => {
    const d = def(MARKET_FIRE);
    const s = idleState(d, {});
    expect(liveRead(d, s)).toMatchObject({ lots: 6, burned: 6 });
    expect(liveTier(d, liveRead(d, s))).toBe('failure');
    expect(liveTier(d, liveRead(d, { ...s, burned: 2 }))).toBe('success');
    expect(liveTier(d, liveRead(d, { ...s, burned: 0 }))).toBe('triumph');
    expect(liveEnded(d, { ...s, t: 10, alight: 0 })).toBe(false);
    expect(liveEnded(d, { ...s, t: 21, alight: 0 })).toBe(true);
    expect(liveEnded(d, { ...s, t: 21, alight: 2 })).toBe(false);
  });

  it('a parade: the crowd is who stands at the market; unplayed, nobody', () => {
    const d = def(PARADE);
    const s = idleState(d, { watchers: 6 });
    expect(liveRead(d, s).crowd).toBe(0);
    const there = { ...s, groups: { marchers: { ...s.groups.marchers, arrived: true }, watchers: { ...s.groups.watchers, arrived: true } } };
    expect(liveRead(d, there).crowd).toBe(15);
    expect(liveEnded(d, there)).toBe(true);
    expect(liveTier(d, liveRead(d, there))).toBe('triumph');
    expect(liveTier(d, { crowd: 8 })).toBe('success');
    expect(liveTier(d, { crowd: 7 })).toBe('failure');
  });

  it('bad data is refused with its reason', () => {
    const d = def(RAID);
    expect(checkLive('x', { ...d, ends: [{ when: 'none', tag: 'ghost' }] }, ['raid', 'soldiers']).join(' ')).toContain('tag ghost');
    expect(checkLive('x', { ...d, tiers: [{ tier: 'success', when: [['left', '=', 0]] }] }, ['raid', 'soldiers']).join(' ')).toContain('last tier');
    expect(checkLive('x', d, []).join(' ')).toContain('not one of the run');
  });
});

describe('tags and synergy rules (living/rules.ts)', () => {
  const things: Thing[] = [
    { id: 'field', name: 'the east fields', tags: ['field', 'worked', 'growth-active'], at: [0, 0], town: 'home' },
    { id: 'shrine', name: 'the shrine', tags: ['temple', 'standing'], at: [50, 10], town: 'home' },
    { id: 'far-shrine', name: 'the far shrine', tags: ['temple', 'standing'], at: [50, 400], town: 'home' },
    { id: 'p1', name: 'Ashby', tags: ['trade-partner', 'standing'], at: null, town: 'p1' },
    { id: 'p2', name: 'Brill', tags: ['trade-partner', 'standing'], at: null, town: 'p2' },
    { id: 'p3', name: 'Cole', tags: ['trade-partner', 'ruined'], at: null, town: 'p3' },
    { id: 'market', name: 'the market', tags: ['market', 'worked'], at: [10, 0], town: 'home' },
  ];
  const book = (rules: RuleDef[], list = things) => {
    const pool: Record<string, number> = { materials: 0, magic: 0, unrest: 0 };
    return { pool, book: new RuleBook(rules, { things: () => list, pool: (k) => pool[k] ?? 0, gain: (k, n) => ((pool[k] = (pool[k] ?? 0) + n), n) }) };
  };
  const field: RuleDef = { id: 'f', name: 'F', on: 'turn', a: { tags: ['field', 'worked', 'growth-active'] }, effect: { pool: 'materials', n: 2 }, why: '{a} gave {n}' };

  it('fires on its trigger when its tags match, once a season, with its reason', () => {
    const { pool, book: b } = book([field]);
    b.season(1);
    expect(b.fire({ on: { event: 'x' } })).toEqual([]);
    const hits = b.fire({ on: 'turn' });
    expect(hits).toMatchObject([{ rule: 'f', pool: 'materials', delta: 2, text: 'The east fields gave 2', things: ['field'] }]);
    expect(pool.materials).toBe(2);
    // (once a season: again only when the season turns)
    expect(b.fire({ on: 'turn' })).toEqual([]);
    b.season(2);
    expect(b.fire({ on: 'turn' }).length).toBe(1);
    expect(pool.materials).toBe(4);
  });

  it('a thing that lost its working tags stops its rules', () => {
    const { pool, book: b } = book([field], [{ ...things[0], tags: ['ruined', 'burned'] }]);
    b.season(1);
    expect(b.fire({ on: 'turn' })).toEqual([]);
    expect(pool.materials).toBe(0);
  });

  it('counts a second thing, up to its capacity', () => {
    const r: RuleDef = { id: 'm', name: 'M', on: 'turn', a: { tags: ['market', 'worked'] }, b: { tags: ['trade-partner', 'standing'] }, effect: { pool: 'materials', n: 1 }, per: 'b', cap: 3, why: '{count} towns sold at {a}: {n}' };
    const { pool, book: b } = book([r]);
    b.season(1);
    expect(b.fire({ on: 'turn' })[0].text).toBe('2 towns sold at the market: 2');
    expect(pool.materials).toBe(2);
    const many = [...things, ...['q1', 'q2', 'q3'].map((id) => ({ id, name: id, tags: ['trade-partner', 'standing'], at: null, town: id }))];
    const x = book([r], many);
    x.book.season(1);
    x.book.fire({ on: 'turn' });
    expect(x.pool.materials).toBe(3);
  });

  it('a relation of place: near the first thing, near the event, on the event\'s route', () => {
    const near: RuleDef = { id: 'n', name: 'N', on: 'turn', a: { tags: ['market'] }, b: { tags: ['field'], near: { of: 'a', cells: 20 } }, effect: { pool: 'materials', n: 1 }, why: 'x' };
    const far: RuleDef = { ...near, id: 'far', b: { tags: ['temple'], near: { of: 'a', cells: 20 } } };
    const { book: b } = book([near, far]);
    b.season(1);
    expect(b.fire({ on: 'turn' }).map((h) => h.rule)).toEqual(['n']);
    const route: RuleDef = { id: 'r', name: 'R', on: { live: 'parade' }, a: { tags: ['temple', 'standing'], near: { of: 'route', cells: 30 } }, effect: { pool: 'magic', n: 1 }, per: { amount: 'crowd', each: 6 }, cap: 2, why: 'passed {a}: {n}' };
    const y = book([route]);
    y.book.season(1);
    // (the route passes the near shrine, not the far one; 15 people: 2 sixes, capped at 2)
    const hits = y.book.fire({ on: { live: 'parade' }, vars: { crowd: 15 }, route: [[0, 0], [100, 0]] });
    expect(hits).toMatchObject([{ things: ['shrine'], delta: 2 }]);
    expect(y.pool.magic).toBe(2);
    const z = book([route]);
    z.book.season(1);
    expect(z.book.fire({ on: { live: 'parade' }, vars: { crowd: 15 }, route: [[0, 300], [5, 300]] })).toEqual([]);
    const ev: RuleDef = { id: 'e', name: 'E', on: { live: 'fire' }, a: { tags: ['temple'], near: { of: 'event', cells: 30 } }, effect: { amount: 'burned', op: 'mul', n: 0.5 }, why: 'saved {n}' };
    const q = book([ev]);
    q.book.season(1);
    const vars = { burned: 5 };
    expect(q.book.fire({ on: { live: 'fire' }, vars, at: [40, 0] })[0]).toMatchObject({ amount: 'burned', delta: -2, text: 'Saved 2' });
    expect(vars.burned).toBe(3);
  });

  it('a pool\'s level is a condition; a rule that changes nothing does not fire or use its season', () => {
    const r: RuleDef = { id: 'u', name: 'U', on: { live: 'parade' }, a: { tags: ['market'] }, need: { pool: 'unrest', gte: 1 }, effect: { amount: 'crowd', op: 'mul', n: 0.5 }, why: '{n} fewer' };
    const { pool, book: b } = book([r]);
    b.season(1);
    expect(b.fire({ on: { live: 'parade' }, vars: { crowd: 10 } })).toEqual([]);
    pool.unrest = 2;
    expect(b.fire({ on: { live: 'parade' }, vars: { crowd: 0 } })).toEqual([]);
    const v = { crowd: 10 };
    expect(b.fire({ on: { live: 'parade' }, vars: v })[0].delta).toBe(-5);
    expect(v.crowd).toBe(5);
  });

  it('no runaway: a book refuses a rule with no effect, and firing is bounded by the season\'s limit', () => {
    expect(() => new RuleBook([{ ...field, effect: { pool: 'materials', n: 0 } }], { things: () => [], pool: () => 0, gain: () => 0 })).toThrow(/changes nothing/);
    expect(() => new RuleBook([field, field], { things: () => [], pool: () => 0, gain: () => 0 })).toThrow(/twice/);
    expect(() => new RuleBook([{ ...field, effect: { amount: 'x', op: 'add', n: 1 } }], { things: () => [], pool: () => 0, gain: () => 0 })).toThrow(/only a live event/);
    const { pool, book: b } = book([{ ...field, perSeason: 2 }]);
    b.season(1);
    for (let k = 0; k < 50; k++) b.fire({ on: 'turn' });
    expect(pool.materials).toBe(4);
    // (saved and taken up: the count goes on)
    const c = book([{ ...field, perSeason: 2 }]);
    c.book.load(b.save());
    expect(c.book.fire({ on: 'turn' })).toEqual([]);
  });
});

const YSOLT: Leader = { id: 'ysolt', name: 'Marshal Ysolt', line: 'A soldier.', pools: { magic: 3, might: 3, labor: 4, materials: 6, intel: 1 }, income: { materials: 2, magic: 1 } };
const realm = (ledger: SeasonLedger, seasons = 16, where?: (s: string) => [number, number] | null): Realm =>
  new Realm({ world: briarWorld().ws.snapshot(), home: 'briar-hollow', seed: 7, leader: YSOLT, ledger, land: () => ({ left: 14, open: [] }), seasons, ...(where ? { where } : {}) });
const built = (...cards: string[]): SeasonLedger => ({ ...newLedger(YSOLT.pools, YSOLT.income), built: cards });
const season = (r: Realm): string[] => {
  const news = r.endSeason();
  r.afterSeason(nextSeason(r.ledger).ledger);
  return news;
};
const until = (r: Realm, template: string, n = 16) => {
  const find = () => r.offers().find((o) => o.template === template && o.status === 'offered');
  for (let k = 0; k < n && !find(); k++) season(r);
  const o = find();
  if (!o) throw new Error(`${template} was not offered`);
  return o;
};

describe('the run\'s rules and live events on the realm', () => {
  it('every site has its tags, and every rule and event text reads plainly', () => {
    for (const s of SITES) expect(SITE_TAGS[s.key].is.length).toBeGreaterThan(0);
    const texts = [...RULES.flatMap((r) => [r.name, r.why.replace(/\{\w+\}/g, 'two')]), ...LIVE_TEMPLATES.flatMap((t) => [t.title, t.pitch, t.presenter.line, t.reward.text, t.play!.event!.title, t.play!.event!.how, ...Object.values(t.outcomes ?? {}).map((o) => o.text)])];
    for (const t of texts) expect(lint(t.replace(/\{\w+\}/g, '2')), t).toEqual([]);
  });

  it('a growth rune on worked fields doubles their crop that season, once, and says why', () => {
    const r = realm(built('farms'));
    const before = pools(r.ledger);
    expect(r.cast('growth', 'fields')).toBe(true);
    expect(pools(r.ledger).magic).toBe(before.magic - 1);
    expect(r.things().find((t) => t.id === siteId(r.home, 'fields'))!.tags).toContain('growth-active');
    const news = r.endSeason();
    expect(news.join(' ')).toContain('The growth rune doubled the crop on the east fields: +2 Materials.');
    expect(pools(r.ledger).materials).toBe(before.materials + 2);
    expect(r.history().filter((e) => e.kind === 'rule-fired').length).toBe(1);
    r.afterSeason(nextSeason(r.ledger).ledger);
    // (the rune's season is over: nothing next season)
    const m = pools(r.ledger).materials;
    const next = r.endSeason();
    expect(next.join(' ')).not.toContain('growth rune');
    expect(pools(r.ledger).materials).toBe(m);
  });

  it('a rune on fields nobody works yields nothing; burned fields lose their tags', () => {
    const r = realm(built());
    r.cast('growth', 'fields');
    expect(r.endSeason().join(' ')).not.toContain('growth rune');
    const b = realm(built('farms'));
    b.w.facts.setTag(siteId(b.home, 'fields'), 'condition', 'burned', true, 'test');
    b.cast('growth', 'fields');
    expect(b.things().find((t) => t.id === siteId(b.home, 'fields'))!.tags).toEqual(['ruined', 'burned']);
    expect(b.endSeason().join(' ')).not.toContain('growth rune');
  });

  it('the raid through its template: walls with a garrison stop 2 raiders, and the town holds', () => {
    // (Might 1 behind walls: 3 soldiers hold 3 of 6; the rule stops 2; 1 gets in — and with Might 2 none does)
    const one = realm(grant(built('walls'), {}), 4);
    one.ledger = { ...one.ledger, holdings: { ...one.ledger.holdings, agents: one.ledger.holdings.agents.filter((a) => a.kind !== 'army').concat(one.ledger.holdings.agents.filter((a) => a.kind === 'army').slice(0, 1)) } };
    for (let k = 0; k < 3; k++) season(one);
    const a = one.playForced().find((x) => x.template === RAID)!;
    expect(a.vars).toMatchObject({ raiders: 6, soldiers: 3, stopped: 2, left: 1 });
    expect(a.tier).toBe('failure');
    expect(a.lines.join(' ')).toContain('Your walls and their garrison stopped 2 raiders at the gate.');
    expect(one.fight).toMatchObject({ raiders: 6, left: 1, held: false });
    expect(one.w.facts.tag(siteId(one.home, 'gate'), 'condition', 'burned')?.value).toBe(true);
    expect(pools(one.ledger).unrest).toBeGreaterThanOrEqual(1);

    const two = realm(built('walls'), 4);
    for (let k = 0; k < 3; k++) season(two);
    const might = total(two.ledger, 'might');
    const b = two.playForced().find((x) => x.template === RAID)!;
    expect(b).toMatchObject({ tier: 'success', vars: { left: 0 } });
    expect(two.fight?.held).toBe(true);
    expect(two.over).toBe(true);
    expect(total(two.ledger, 'might')).toBe(might);
    expect(two.history().some((e) => e.kind === 'raid-held')).toBe(true);
  });

  it('a parade: agreed, it is under way; the season\'s end resolves it from the state it is in, the rules changing its crowd', () => {
    const r = realm(grant(built('farms'), { unrest: 2 }));
    const o = until(r, PARADE);
    r.commit(o.id);
    expect(r.liveRunning().map((x) => x.template)).toEqual([PARADE]);
    // (as the scene would tell it: all 9 marchers and 6 watchers at the market; with unrest in the town half stay in)
    const d = r.liveOf(o)!;
    const s = idleState(d, r.runNumbers());
    for (const g of Object.values(s.groups)) g.arrived = true;
    const unrest = pools(r.ledger).unrest;
    const rep = r.finishLive(o.id, { state: s });
    expect(rep.hits.map((h) => h.rule)).toEqual(['sullen-festival']);
    // (9 marchers and 4 watchers; half stay in: 7, under the 8 a parade needs)
    expect(rep.vars.crowd).toBe(7);
    expect(rep.tier).toBe('failure');
    expect(rep.lines).toEqual(['Only 7 people came out for the parade. It changed nothing.', 'With unrest in the town, 6 fewer people came out for the parade.']);
    expect(pools(r.ledger).unrest).toBe(unrest);
    expect(r.liveRunning()).toEqual([]);
    expect(r.history().some((e) => e.kind === 'parade-thin')).toBe(true);
  });

  it('an event left running is resolved at the end of the season, from the state the scene last told (none: as nobody played it)', () => {
    const r = realm(built());
    const o = until(r, PARADE);
    r.commit(o.id);
    const news = r.endSeason();
    expect(news.join(' ')).toContain('Only 0 people came out for the parade. It changed nothing.');
    expect(r.liveRunning()).toEqual([]);
    expect(r.history().some((e) => e.kind === 'parade-thin')).toBe(true);
  });

  it('a fire nobody fights burns the market; water close by saves half of it', () => {
    const cells: Record<string, [number, number]> = { market: [5000, 3000], river: [5040, 3000], dam: [9000, 9000], harbour: [9000, 9000] };
    const r = realm(built(), 16, (s) => cells[s] ?? [7000, 7000]);
    const o = until(r, MARKET_FIRE);
    r.commit(o.id);
    const rep = r.finishLive(o.id);
    expect(rep.vars).toMatchObject({ lots: 6, burned: 3 });
    expect(rep.tier).toBe('failure');
    expect(rep.lines.join(' ')).toContain('The river crossing is close: bucket lines saved 3 of the burning lots.');
    expect(r.w.facts.tag(siteId(r.home, 'market'), 'condition', 'burned')?.value).toBe(true);
    // (the market burned: a later rule about it finds only a ruin)
    expect(r.things().find((t) => t.id === siteId(r.home, 'market'))!.tags).toEqual(['ruined', 'burned']);
  });
});
