// (card-table; docs/design/PACK_FORMAT.md) Several packs loaded together: what the validator finds only over the set,
// a rule of one pack reading a tag another pack puts in play (packs/cross-a.json + cross-b.json, the cross-pack
// example), and the world events a pack's rule can wait for (a card done, a card run out, a site's land change).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIVE_TEMPLATES, FIRE_TEMPLATE } from '../../src/season/realm-events';
import { RULES } from '../../src/season/realm-rules';
import { WORLD_TEMPLATES } from '../../src/season/realm-templates';
import { BASE_EVENT_KINDS, BASE_RULE_IDS, checkPack, checkTogether, LAND_KINDS, type Pack } from '../../src/packs/check';
import { thingEntity } from '../../src/packs/load';
import { Table } from '../../src/table/game';

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Pack;
const A = read('packs/cross-a.json');
const B = read('packs/cross-b.json');
const errs = (ps: { level: string; text: string }[]) => ps.filter((x) => x.level === 'error').map((x) => x.text);
const looks = (ps: { level: string; text: string }[]) => ps.filter((x) => x.level === 'warn').map((x) => x.text);

/** a small pack: one cheap card, and what the test adds */
const tiny = (id: string, more: Partial<Pack> = {}): Pack => ({
  pack: { id, name: id, version: 1 },
  cards: [{ id: `${id}-card`, title: 'A card', presenter: { role: 'reeve', at: 'site:fields' }, pitch: 'Give me a worker.', cost: { labor: 1 }, if_taken: [{ say: 'Done.' }], if_expires: [{ say: 'Gone.' }] }],
  ...more,
});

describe('the validator over several packs', () => {
  it('knows the base game\'s rule ids and the events its cards record', () => {
    expect(BASE_RULE_IDS).toEqual(RULES.map((r) => r.id));
    // (draft 8: no arc — the raiders' scouts and march are the standing threat card's own events)
    const written = new Set([...JSON.stringify([WORLD_TEMPLATES, LIVE_TEMPLATES, FIRE_TEMPLATE]).matchAll(/"event":"([a-z-]+)"/g)].map((m) => m[1]));
    for (const k of written) expect([...BASE_EVENT_KINDS, ...LAND_KINDS], k).toContain(k);
    expect(written.has('scouts-seen') && written.has('raiders-march')).toBe(true);
  });
  it('passes the cross-pack example, each alone and together', () => {
    expect(errs(checkPack(A))).toEqual([]);
    expect(errs(checkPack(B))).toEqual([]);
    expect(looks(checkPack(B))).toEqual([]);
    expect(checkTogether([A, B])).toEqual([]);
  });
  it('alone, the reading half is told its shared tag is not produced only by the set', () => {
    expect(looks(checkTogether([B])).some((x) => /No loaded pack produces this tag/.test(x))).toBe(true);
  });
  it('reports an id two packs share, and a rule id of the base game', () => {
    const p = tiny('one');
    const q = tiny('two');
    q.cards![0].id = 'one-card';
    expect(errs(checkTogether([p, q])).some((x) => /"one-card" is also used in the pack "one"/.test(x))).toBe(true);
    const r = tiny('three', { rules: [{ id: 'blessed-fields', name: 'x', on: 'turn', a: { tags: ['field'] }, effect: { pool: 'magic', n: 1 }, cap: 1, why: '+{n}' }] });
    expect(errs(checkPack(r)).some((x) => /already a rule of the base game/.test(x))).toBe(true);
  });
  it('reports a shared tag declared differently', () => {
    const p = tiny('one', { tags: [{ id: 'ashy', on: 'site', meaning: 'Ash.', timed: false, shared: true }] });
    const q = tiny('two', { tags: [{ id: 'ashy', on: 'site', meaning: 'Ash.', timed: true, shared: true }] });
    expect(errs(checkTogether([p, q])).some((x) => /declares the tag "ashy" with "timed": false; here it is true/.test(x))).toBe(true);
  });
  it('says to look at a crowded site and at too many threats', () => {
    const packs = ['a', 'b', 'c', 'd', 'e'].map((id) => {
      const p = tiny(id);
      p.cards![0].threat = true;
      return p;
    });
    const l = looks(checkTogether(packs));
    expect(l.some((x) => /5 cards stand at site:fields/.test(x))).toBe(true);
    expect(l.some((x) => /5 threats over the loaded packs/.test(x))).toBe(true);
  });
  it('a rule on an event kind or a card of another pack: a warning alone, fine together, an error if nobody has it', () => {
    const rule = (on: Pack['rules'] extends (infer R)[] | undefined ? (R extends { on: infer O } ? O : never) : never) => ({ id: 'two-rule', name: 'x', on, a: { tags: ['field'] }, effect: { pool: 'magic', n: 1 }, cap: 1, why: '+{n}' });
    const q = tiny('two', { rules: [rule({ event: 'pack-done:one-card' })] });
    expect(errs(checkPack(q))).toEqual([]);
    expect(looks(checkPack(q)).some((x) => /a card that is not in this pack/.test(x))).toBe(true);
    expect(errs(checkTogether([tiny('one'), q]))).toEqual([]);
    expect(errs(checkTogether([q])).some((x) => /no loaded pack has that card/.test(x))).toBe(true);
    const bad = tiny('two', { rules: [rule({ event: 'harvest-moon' })] });
    expect(errs(checkPack(bad)).some((x) => /Unknown event "harvest-moon"/.test(x))).toBe(true);
    const kind = tiny('two', { rules: [rule({ live: 'plague' })] });
    expect(errs(checkPack(kind))).toEqual([]);
    expect(errs(checkTogether([kind])).some((x) => /live event kind "plague", which no event of any loaded pack/.test(x))).toBe(true);
  });
});

describe('two packs at the table', () => {
  it('refuses a set that clashes, with the report', () => {
    const q = tiny('two');
    q.cards![0].id = 'one-card';
    expect(() => new Table({ seed: 7, leader: 'ysolt', packs: [tiny('one'), q] })).toThrow(/also used in the pack "one"/);
  });

  it('pack B\'s rule and card read the tag pack A\'s thing lends to the east fields, with a base tag', () => {
    const t = new Table({ seed: 7, leader: 'dunstan', seasons: 16, packs: [A, B] });
    expect(t.packs.map((p) => p.id)).toEqual(['cross-a', 'cross-b']);
    const rule = () => t.rules().find((r) => r.id === 'cross-b-blessed-seed')!;
    expect(rule().ready).toBe(false);
    expect(rule().why).toMatch(/Closest: the east fields lacks "seed-stored"/);
    let seenRiteBefore = false;
    for (let s = 0; s < 10 && !t.realm.w.facts.entity(thingEntity('cross-a-seed-store')); s++) {
      seenRiteBefore ||= t.cards().some((c) => c.template === 'cross-b-spring-rite');
      const c = t.cards().find((x) => x.template === 'cross-a-build-seed-store');
      if (c && !Object.keys(c.short).length) t.take(c.id);
      t.endSeason();
    }
    expect(seenRiteBefore, 'the rite waits for the seed store').toBe(false);
    expect(t.realm.w.facts.entity(thingEntity('cross-a-seed-store'))).toBeTruthy();
    const fields = t.things().find((x) => x.name === 'the east fields')!;
    expect(fields.tags).toEqual(expect.arrayContaining(['field', 'seed-stored']));
    expect(rule().ready).toBe(true);
    const before = t.hits.length;
    const magic = t.poolViews().find((p) => p.pool === 'magic')!;
    t.endSeason();
    const hit = t.hits.slice(before).find((h) => h.hit.rule === 'cross-b-blessed-seed');
    expect(hit?.hit).toMatchObject({ pool: 'magic', delta: 1 });
    expect(t.poolViews().find((p) => p.pool === 'magic')!.have).toBe(magic.have + magic.income + 1);
    // (and pack B's card, gated on the same two tags, comes up now)
    let rite = false;
    for (let s = 0; s < 6 && !rite && !t.over; s++) {
      rite = t.cards().some((c) => c.template === 'cross-b-spring-rite');
      if (!rite) t.endSeason();
    }
    expect(rite).toBe(true);
  });
});

describe('the world events a pack\'s rule can wait for', () => {
  const rule = (id: string, event: string, pool: string) => ({ id, name: id, on: { event }, a: { tags: ['home'] }, effect: { pool, n: 1 }, cap: 1, why: `${id}: +{n}` });
  const pack: Pack = {
    pack: { id: 'ev', name: 'Events', version: 1 },
    cards: [
      { id: 'ev-take', title: 'Taken', presenter: { role: 'reeve', at: 'site:fields' }, pitch: 'Give me a worker.', cost: { labor: 1 }, if_taken: [{ say: 'Done.' }], if_expires: [{ say: 'Gone.' }] },
      { id: 'ev-leave', title: 'Left', presenter: { role: 'miller', at: 'site:mill' }, pitch: 'The mill will burn.', offer_seasons: 1, cost: { materials: 1 }, if_taken: [{ say: 'Safe.' }], if_expires: [{ mutate: 'burned', where: 'site:mill' }, { say: 'The mill burns.' }] },
    ],
    rules: [rule('ev-on-done', 'pack-done:ev-take', 'intel'), rule('ev-on-lapsed', 'pack-lapsed:ev-leave', 'magic'), rule('ev-on-burned', 'burned', 'might')],
  };
  it('passes the validator', () => {
    expect(errs(checkPack(pack))).toEqual([]);
  });
  it('a card done, a card run out and a site burned each fire their rule once, when it happens', () => {
    const t = new Table({ seed: 7, leader: 'dunstan', seasons: 16, packs: [pack] });
    const fired = () => t.hits.map((h) => h.hit.rule).filter((r) => r.startsWith('ev-'));
    for (let s = 0; s < 8 && fired().length < 3; s++) {
      const c = t.cards().find((x) => x.template === 'ev-take');
      if (c && !Object.keys(c.short).length) t.take(c.id);
      t.endSeason();
    }
    expect(fired().sort()).toEqual(['ev-on-burned', 'ev-on-done', 'ev-on-lapsed']);
    expect(t.lapsed).not.toContain('ev-take');
    expect(t.things().find((x) => x.name === 'the mill street')!.tags.slice(0, 2)).toEqual(['ruined', 'burned']);
    for (let s = 0; s < 3; s++) t.endSeason();
    expect(fired().length).toBe(3);
  });
});
