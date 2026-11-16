// (card-table: chains) Rules that act and chain: a result trigger after the tier is picked, acts (offer, start, tag),
// a chain stopped by perSeason, the budget's error naming the chain, and — on the Realm, with packs/arena.json — a
// win starting the next challenger, read back as a chain, saved and taken up mid-chain, the same every time.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACT_BUDGET, RuleBook, type RuleAct, type RuleDef, type RuleOccasion, type Thing } from '../../src/living/rules';
import { chainCycles, checkPack, checkTogether, type Pack } from '../../src/packs/check';
import { thingEntity } from '../../src/packs/load';
import { Table } from '../../src/table/game';

const ARENA = JSON.parse(fs.readFileSync('packs/arena.json', 'utf8')) as Pack;
const errs = (ps: { level: string; text: string }[]) => ps.filter((x) => x.level === 'error').map((x) => x.text);

describe('the rule book: results, acts, chains', () => {
  const world = (rules: RuleDef[], tags: string[] = ['pit']) => {
    const things: Thing[] = [{ id: 'p', name: 'the pit', tags, at: [0, 0], town: 'h' }];
    const acts: RuleAct[] = [];
    const book = new RuleBook(rules, {
      things: () => things,
      pool: () => 0,
      gain: (_k, n) => n,
      act: (fx) => {
        acts.push(fx);
        if ('tag' in fx) {
          if (things[0].tags.includes(fx.tag)) return false;
          things[0] = { ...things[0], tags: [...things[0].tags, fx.tag] };
        }
        return true;
      },
    });
    book.season(1);
    return { book, acts, things };
  };
  const win: RuleDef = { id: 'win', name: 'Win', on: { live: 'bout', tier: ['success', 'triumph'] }, a: { tags: ['pit'] }, effect: { offer: 'next' }, why: 'a challenger comes to {a}' };
  const amount: RuleDef = { id: 'amt', name: 'Amount', on: { live: 'bout' }, a: { tags: ['pit'] }, effect: { amount: 'x', op: 'add', n: 1 }, why: '{n}' };

  it('a rule about a result fires after the tier is picked, on its tiers only; a rule about numbers only before', () => {
    const { book, acts } = world([win, amount]);
    expect(book.fire({ on: { live: 'bout' }, vars: { x: 0 } }).map((h) => h.rule)).toEqual(['amt']);
    expect(book.fire({ on: { live: 'bout', tier: ['failure'] } })).toEqual([]);
    const hits = book.fire({ on: { live: 'bout', tier: ['success'] }, what: 'The bout: good result', after: 'Word of the pit' });
    expect(hits.map((h) => h.rule)).toEqual(['win']);
    expect(hits[0]).toMatchObject({ act: { offer: 'next' }, delta: 1, what: 'The bout: good result', after: 'Word of the pit' });
    expect(acts).toEqual([{ offer: 'next' }]);
  });
  it('a tag a rule sets is read by the rule after it, in the same firing', () => {
    const tag: RuleDef = { id: 'tag', name: 'Tag', on: 'turn', a: { tags: ['pit'] }, effect: { tag: 'champion', on: 'a' }, why: '{a} has a champion' };
    const reads: RuleDef = { id: 'reads', name: 'Reads', on: 'turn', a: { tags: ['pit', 'champion'] }, effect: { pool: 'magic', n: 1 }, cap: 1, why: '+{n}' };
    const { book } = world([tag, reads]);
    expect(book.fire({ on: 'turn' }).map((h) => h.rule)).toEqual(['tag', 'reads']);
  });
  it('an act that changes nothing is no firing; a chain stops at perSeason', () => {
    const tag: RuleDef = { id: 'tag', name: 'Tag', on: 'turn', a: { tags: ['pit'] }, effect: { tag: 'champion', on: 'a' }, why: 'x' };
    const again: RuleDef = { ...win, perSeason: 2 };
    const { book } = world([tag, again]);
    expect(book.fire({ on: 'turn' }).length).toBe(1);
    expect(book.fire({ on: 'turn' })).toEqual([]);
    const result: RuleOccasion = { on: { live: 'bout', tier: ['success'] } };
    expect(book.fire(result).length).toBe(1);
    expect(book.fire(result).length).toBe(1);
    expect(book.fire(result)).toEqual([]);
    book.season(2);
    expect(book.fire(result).length).toBe(1);
  });
  it('past the budget the book stops with an error that names the chain', () => {
    const many = Array.from({ length: 9 }, (_, i): RuleDef => ({ ...win, id: `r${i}`, perSeason: 3 }));
    const { book } = world(many);
    const result: RuleOccasion = { on: { live: 'bout', tier: ['success'] } };
    book.fire(result);
    book.fire(result);
    expect(() => book.fire(result)).toThrow(new RegExp(`more than ${ACT_BUDGET} acting rules fired in one season\\. The chain: r0 -> r1 -> `));
  });
  it('refuses an acting rule that asks for too many firings, and a result rule that changes an amount', () => {
    expect(() => world([{ ...win, perSeason: 4 }])).toThrow(/at most 3 times a season/);
    expect(() => world([{ ...amount, on: { live: 'bout', tier: ['success'] } }])).toThrow(/cannot change one/);
  });
  it('the firings and the chain are saved and loaded', () => {
    const { book } = world([{ ...win, perSeason: 2 }]);
    const result: RuleOccasion = { on: { live: 'bout', tier: ['success'] } };
    book.fire(result);
    const saved = book.save();
    expect(saved.acted).toEqual(['win']);
    const { book: b2 } = world([{ ...win, perSeason: 2 }]);
    b2.load(saved);
    expect(b2.fire(result).length).toBe(1);
    expect(b2.fire(result)).toEqual([]);
  });
});

describe('the validator and chains', () => {
  it('passes the arena pack; alone and with nothing else it has nothing to look at', () => {
    expect(checkPack(ARENA)).toEqual([]);
    expect(checkTogether([ARENA])).toEqual([]);
  });
  it('says what is wrong with an acting rule', () => {
    const bad = (change: (p: Pack) => void) => {
      const p = structuredClone(ARENA);
      change(p);
      return errs(checkPack(p)).join('\n');
    };
    expect(bad((p) => void (p.rules![0].perSeason = 5))).toMatch(/may fire at most 3 times a season/);
    expect(bad((p) => void (p.rules![0].effect = { start: 'arena-dig-the-pit' }))).toMatch(/has no "live" event/);
    expect(bad((p) => void (p.cards![1].cost = { materials: 1 }))).toMatch(/cannot cost anything/);
    expect(bad((p) => void ((p.rules![3].on as { tier: string[] }).tier = ['win']))).toMatch(/Unknown result "win"/);
    expect(bad((p) => void (p.rules![3].effect = { tag: 'worked', on: 'a' }))).toMatch(/set by the game itself/);
    expect(bad((p) => void (p.rules![4].effect = { amount: 'alive:challenger', op: 'add', n: 1 }))).toMatch(/cannot change an amount/);
    const other = structuredClone(ARENA);
    other.rules![0].effect = { start: 'festival-duel' };
    expect(errs(checkPack(other))).toEqual([]);
    expect(errs(checkTogether([other])).join('\n')).toMatch(/no loaded pack has that card/);
  });
  it('sees a chain that comes back to itself, and says to look', () => {
    const p = structuredClone(ARENA);
    // (the third bout's win starts the first bout again, and the bouts may come back)
    p.rules!.push({ id: 'arena-again', name: 'Again', on: { event: 'pack-done:arena-bout-3' }, a: { tags: ['pit'] }, effect: { start: 'arena-bout-1' }, why: 'again at {a}' });
    expect(chainCycles([p]).map((c) => c.rule)).toContain('arena-second-challenger');
    expect(checkPack(p).filter((x) => x.level === 'warn').some((x) => /This chain comes back to itself: /.test(x.text))).toBe(true);
    expect(chainCycles([ARENA])).toEqual([]);
  });
});

describe('the fighting pit at the table: a win starts the next challenger', () => {
  const OPTS = { seed: 7, leader: 'ilveth', seasons: 16, packs: [ARENA] };
  /** play until the pit is dug, then each bout as it comes, casting what a bout needs; `stop`: seasons to play on */
  const play = (t: Table, seasons: number, cast = true): void => {
    for (let s = 0; s < seasons && !t.over; s++) {
      const dig = t.cards().find((c) => c.template === 'arena-dig-the-pit');
      if (dig && !Object.keys(dig.short).length) t.take(dig.id);
      if (cast) for (const e of t.liveEvents().filter((x) => x.template.startsWith('arena-'))) for (let i = 0; i < 6 && t.liveEvents().find((x) => x.id === e.id)!.tier !== 'success'; i++) if (!t.cast('spell:fire', e.id)) break;
      t.endSeason();
    }
  };
  const bouts = (t: Table) => t.events.filter((e) => e.template.startsWith('arena-')).map((e) => `${e.template}:${e.tier}@${e.season}`);

  it('three bouts in three seasons, each started by the win before; the chain is read back in the log', () => {
    const t = new Table(OPTS);
    play(t, 9);
    const b = bouts(t);
    expect(b.map((x) => x.split('@')[0])).toEqual(['arena-bout-1:success', 'arena-bout-2:success', 'arena-bout-3:success']);
    const at = b.map((x) => Number(x.split('@')[1]));
    expect([at[1] - at[0], at[2] - at[1]]).toEqual([1, 1]);
    // (a bout is not offered: it begins by itself, and is never on the board as a card)
    expect(t.taken.filter((x) => x.startsWith('arena-bout'))).toEqual([]);
    const fired = t.hits.map((h) => h.hit.rule).filter((r) => r.startsWith('arena-'));
    expect(fired.filter((r) => r.endsWith('challenger'))).toEqual(['arena-first-challenger', 'arena-second-challenger', 'arena-third-challenger']);
    expect(fired.filter((r) => r === 'arena-champion').length).toBe(3);
    expect(fired.filter((r) => r === 'arena-purse').length).toBe(3);
    const line = t.log.find((l) => l.kind === 'rule' && /The Red Wolf hears/.test(l.text))!.text;
    expect(line).toMatch(/^A name to beat → .* → Rule: The Red Wolf hears\. Two wins at .* reached the Red Wolf\.$/);
    expect(t.log.some((l) => l.kind === 'rule' && /^Word of the pit → A drover calls out your fighter: good result → Rule: Talk of the town\./.test(l.text))).toBe(true);
    // (the last win's reward: the Red Wolf's crew)
    expect(t.realm.w.facts.entity(thingEntity('arena-fighting-pit'))).toBeTruthy();
    // (nothing more comes: every bout was once)
    play(t, 3);
    expect(bouts(t).length).toBe(3);
  });

  it('a bout\'s card says what winning will set off, before anything is cast', () => {
    const t = new Table(OPTS);
    for (let s = 0; s < 8 && !t.liveEvents().some((e) => e.template === 'arena-bout-1'); s++) play(t, 1, false);
    const e = t.liveEvents().find((x) => x.template === 'arena-bout-1')!;
    expect(e.after.some((a) => /^If it ends in good result: Talk of the town\. .*Then it becomes "pit-champion" for the season\.$/.test(a))).toBe(true);
    expect(t.rules().find((r) => r.id === 'arena-second-challenger')!.says).toMatch(/Then this begins at once: "Two caravan guards call you out"\.$/);
  });

  it('a lost bout ends the chain: no champion, no next challenger', () => {
    const t = new Table({ ...OPTS, leader: 'ysolt' });
    // (no spell cast: the drover is beaten by the fighter alone, the two guards are not)
    play(t, 10, false);
    expect(bouts(t).map((x) => x.split('@')[0])).toEqual(['arena-bout-1:success', 'arena-bout-2:failure']);
  });

  it('saved after the second win and taken up again, the third challenger still comes; the same moves, the same run', () => {
    const a = new Table(OPTS);
    while (bouts(a).length < 2 && !a.over) play(a, 1);
    const saved = a.save();
    expect(saved.run.asked).toEqual([['arena-bout-3', 'The Red Wolf hears']]);
    const b = new Table({ ...OPTS, resume: saved });
    expect(b.liveEvents().map((e) => e.template)).toEqual(a.liveEvents().map((e) => e.template));
    play(a, 2);
    play(b, 2);
    expect(bouts(b).at(-1)).toBe(bouts(a).at(-1));
    expect(bouts(a).at(-1)).toMatch(/^arena-bout-3:success/);
    const c = new Table(OPTS);
    while (bouts(c).length < 2 && !c.over) play(c, 1);
    play(c, 2);
    expect(c.log).toEqual(a.log);
  });
});
