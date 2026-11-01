// (round 124, opportunities) The card lab's loop in Node (src/opps/deck.ts, src/opps/kingdom.ts over data/cards/lab.json):
// kingdoms (the world picks the stacks, each card made at a real place with its specifics); no rolls — a committed card
// resolves to its one outcome after its turns (travel at `pace` + work), one let go fires its onExpire; the deck grows by
// unlocks; effects (relics) owned by agents and buildings fire on their triggers and go with their owners; world
// consequences are real WorldState changes; the climax; expected value a turn; the bots and the tournament.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkDeck, DeckRun, simulate, tournament, type LabDeck } from '../../src/opps/deck';
import { generateKingdom, placesFor, stackCards, type LabLibrary } from '../../src/opps/kingdom';
import { OPP_TUNE, OPP_TUNING } from '../../src/opps/tune';

const LIB: LabLibrary = JSON.parse(readFileSync(new URL('../../data/cards/lab.json', import.meta.url), 'utf8'));
/** every stack in: the whole library as one deck */
const all = (): LabDeck => generateKingdom(structuredClone(LIB), 1, 99).deck;
const take = (r: DeckRun, stack: string, place?: string) => {
  const o = r.offered.find((x) => x.template.startsWith(`${stack}@`) && (!place || x.template.endsWith(`@${place}`)));
  if (!o) throw new Error(`${stack} isn't offered (${r.offered.map((x) => x.template).join(', ')})`);
  return r.commit(o.id);
};
const until = (r: DeckRun, f: () => boolean, max = 30) => {
  for (let i = 0; i < max && !f(); i++) r.nextTurn();
};
const wide = <T,>(f: () => T): T => {
  OPP_TUNING.set('dealer.playerMax', 6);
  OPP_TUNING.set('dealer.resourceMax', 6);
  try {
    return f();
  } finally {
    OPP_TUNING.reset();
  }
};

describe('kingdoms (kingdom.ts)', () => {
  it('a stack makes one card at each place that fits, with that place in it', () => {
    const raid = LIB.stacks.find((s) => s.id === 'raid')!;
    expect(placesFor(raid, LIB).map((p) => p.id).sort()).toEqual(['P4', 'P5']);
    const cards = stackCards(raid, LIB);
    expect(cards.map((c) => c.title)).toEqual(expect.arrayContaining(['Raid Fort 4 (+influence +power by its size)', 'Raid City 5 (+influence +power by its size)']));
    // (not uniform: the city's stores are bigger than the fort's)
    const city = cards.find((c) => c.place === 'P5')!;
    const fort = cards.find((c) => c.place === 'P4')!;
    expect(city.reward.goods!.influence).toBeGreaterThan(fort.reward.goods!.influence);
    expect(city.reward.world!.find((w) => w.kind === 'condition')).toMatchObject({ settlement: 'P5' });
  });
  it('a kingdom: the core stacks and ten more, from the seed; another seed, another kingdom; it checks out', () => {
    const a = generateKingdom(LIB, 1).kingdom.stacks.map((s) => s.id);
    const b = generateKingdom(LIB, 2).kingdom.stacks.map((s) => s.id);
    expect(a).toEqual(generateKingdom(LIB, 1).kingdom.stacks.map((s) => s.id));
    expect(a).toEqual(expect.arrayContaining(['forage', 'climax', 'arm', 'muster', 'raiders']));
    expect(a.length).toBe(5 + 10);
    expect(a).not.toEqual(b);
    for (const k of [1, 2, 3, 4, 5]) expect(checkDeck(generateKingdom(LIB, k).deck), `kingdom ${k}`).toEqual([]);
  });
});

describe('the card lab (deck.ts)', () => {
  it('several to choose from; a committed card resolves to its one outcome after travel + work, the player moved there', () => {
    const r = new DeckRun(all());
    expect(r.affordable().length).toBeGreaterThanOrEqual(2);
    const o = r.offered.find((x) => x.template === 'forage@P2') ?? r.offered.find((x) => x.template.startsWith('forage@'))!;
    const def = r.card(o.template);
    const c = r.commit(o.id);
    expect(c.resolvesTurn).toBe(r.travel(def.place) + def.work);
    const s = r.holdings.goods.labor;
    until(r, () => r.resolutions.length > 0);
    expect(r.holdings.goods.labor).toBeGreaterThan(s);
    expect(r.at).toBe(def.place);
  });
  it('the deck grows: muster unlocks drill (by stack); drill gives its army a tag and an effect it carries', () => {
    wide(() => {
      const r = new DeckRun(all());
      take(r, 'muster', 'P1');
      until(r, () => r.holdings.agents.some((a) => a.kind === 'army'));
      expect(r.pool.has('drill') && r.pool.has('sacrifice')).toBe(true);
      until(r, () => r.offered.some((o) => o.template.startsWith('drill@')));
      take(r, 'drill');
      until(r, () => r.holdings.agents.some((a) => a.tags.includes('veteran')));
      const army = r.holdings.agents.find((a) => a.kind === 'army')!;
      expect(r.owned({ agent: army.id }).map((b) => b.why)).toEqual(['Drilled']);
    });
  });
  it('effects fire on their triggers: the granary each turn; lost with Village 2 when the Host burns it (its fields let go)', () => {
    wide(() => {
      const r = new DeckRun(all());
      take(r, 'granary', 'P2');
      until(r, () => r.holdings.buildings.length === 1);
      r.nextTurn();
      expect(r.firedCount['Granary']).toBeGreaterThan(0);
      expect(r.log.some((l) => /✦ Granary: \+1 labor/.test(l.text))).toBe(true);
      until(r, () => r.world.settlements.find((s) => s.id === 'P2')!.condition === 'ruined', 20);
      expect(r.world.settlements.find((s) => s.id === 'P2')).toMatchObject({ condition: 'ruined' });
      expect(r.holdings.buildings.some((b) => b.place === 'P2')).toBe(false);
      expect(r.holdings.bonuses.some((b) => b.why === 'Granary')).toBe(false);
      expect(r.worldLog.some((w) => w.world?.some((l) => /Village 2 burned/.test(l)))).toBe(true);
      expect(r.log.some((l) => /lost: Granary at Village 2/.test(l.text))).toBe(true);
    });
  });
  it("a sacrifice is a card: the army lost, the threat pushed back, and the champion's vow fires on the loss", () => {
    const r = new DeckRun(all());
    r.holdings.agents.push({ id: 'army9', kind: 'army', name: 'Militia', count: 6, tags: [], statuses: [], at: { with: 'player' } });
    r.holdings.agents.push({ id: 'k9', kind: 'knight', name: 'Knight', count: 1, tags: ['named'], statuses: [], at: { with: 'player' } });
    r.holdings.bonuses.push({ why: "Champion's vow", on: 'agent-lost', effect: { kind: 'gain', goods: { power: 2 } }, holder: 'k9' });
    r.pool.add('sacrifice');
    r.doom = 5;
    wide(() => r.deal());
    const str = r.holdings.goods.power ?? 0;
    take(r, 'sacrifice');
    until(r, () => r.resolutions.length > 0);
    expect(r.holdings.agents.some((a) => a.id === 'army9')).toBe(false);
    expect(r.holdings.goods.power).toBe(str + 2);
    expect(r.resolutions[0].out).toContainEqual({ kind: 'conflict', op: 'doom', amount: -3 });
  });
  it('the climax: forced when doom reaches it, always on the board; unmet, the run is lost and Town 1 falls', () => {
    const r = new DeckRun(all());
    until(r, () => !!r.end, 60);
    expect(r.end).toBe('lost');
    expect(r.world.settlements.find((s) => s.id === 'P1')).toMatchObject({ condition: 'ruined', faction: 'f-host' });
  });
  it('expected value a turn: the need for power makes arming worth more as the climax nears; unlocks are engine value; a threat is worth dealing with', () => {
    const r = new DeckRun(all());
    const arm = r.deck.cards.find((c) => c.stack === 'arm')!;
    const early = r.ev(arm).perTurn;
    r.doom = OPP_TUNE.lab.climaxAt - 3;
    expect(r.ev(arm).perTurn).toBeGreaterThan(early);
    const muster = r.deck.cards.find((c) => c.stack === 'muster')!;
    r.doom = 0;
    expect(r.ev(muster).engine).toBeGreaterThan(0);
    const festival = r.deck.cards.find((c) => c.stack === 'festival')!;
    expect(r.ev(festival).engine).toBe(0);
  });
});

describe('the bots and the tournament', () => {
  it('each bot plays a kingdom to an end; across kingdoms no one strategy is the only viable one everywhere', () => {
    const deck = generateKingdom(LIB, 4).deck;
    for (const p of ['ev', 'bigmoney', 'engine', 'greedy'] as const) {
      const s = simulate(deck, { runs: 1, seed: 4, policy: p });
      expect(s.meanTurns).toBeGreaterThan(0);
      expect(s.world.meanEvents).toBeGreaterThan(0);
    }
    const t = tournament((k) => generateKingdom(LIB, k).deck, { kingdoms: [1, 2, 3, 4, 5, 6], runs: 5 });
    for (const p of ['ev', 'bigmoney', 'engine', 'greedy']) expect(t.every((r) => r.viable.length === 1 && r.viable[0] === p), p).toBe(false);
    console.log(t.map((r) => `${r.kingdom}: ${r.results.map((x) => `${x.policy} ${Math.round(x.winRate * 100)}%/${x.meanScore}`).join(' ')} → ${r.viable.join(',')}`).join('\n'));
  });
});

describe('three resources and threats (round 124: "Labor, influence, power")', () => {
  it('every card costs and gives only labor, influence and power; a deck with another resource is refused', () => {
    const d = all();
    expect(checkDeck(d)).toEqual([]);
    d.cards[0].reward.goods = { coin: 2 };
    expect(checkDeck(d).some((x) => /coin isn't a resource/.test(x))).toBe(true);
  });
  it('a threat dealt with scores, one let fire costs and changes the world', () => {
    OPP_TUNING.set('dealer.playerMax', 6);
    try {
      const r = new DeckRun(all());
      r.doom = 2;
      r.holdings.goods.power = 3;
      r.deal();
      const t = r.offered.find((o) => o.template.startsWith('raiders@'))!;
      r.commit(t.id);
      until(r, () => r.handled > 0);
      expect(r.handled).toBe(1);
      expect(r.score()).toBeGreaterThanOrEqual(2);
      until(r, () => r.missed > 0);
      expect(r.missed).toBeGreaterThan(0);
      expect(r.worldLog.length).toBeGreaterThan(0);
    } finally {
      OPP_TUNING.reset();
    }
  });
});
