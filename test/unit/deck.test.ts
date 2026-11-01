// (round 124, opportunities) The card lab's loop in Node (src/opps/deck.ts over data/cards/lab.json): no rolls — a
// committed card resolves to its one outcome after its turns (travel at `pace` + work), one let go fires its onExpire;
// the deck grows by unlocks; effects (relics) owned by agents and buildings fire on their triggers and go with their
// owners; world consequences are real WorldState changes; the climax; the simulator's report.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkDeck, DeckRun, simulate, type LabDeck } from '../../src/opps/deck';
import { OPP_TUNE, OPP_TUNING } from '../../src/opps/tune';

const LAB: LabDeck = JSON.parse(readFileSync(new URL('../../data/cards/lab.json', import.meta.url), 'utf8'));
const deck = (): LabDeck => structuredClone(LAB);
const take = (r: DeckRun, id: string) => {
  const o = r.offered.find((x) => x.template === id);
  if (!o) throw new Error(`${id} isn't offered (${r.offered.map((x) => x.template).join(', ')})`);
  return r.commit(o.id);
};
const until = (r: DeckRun, f: () => boolean, max = 30) => {
  for (let i = 0; i < max && !f(); i++) r.nextTurn();
};

describe('the card lab (deck.ts)', () => {
  it('the deck checks out, and a broken one is refused', () => {
    expect(checkDeck(deck())).toEqual([]);
    const bad = deck();
    bad.cards[0].reward.unlock = ['NOPE'];
    bad.cards[1].place = 'P99';
    const p = checkDeck(bad);
    expect(p.some((x) => /unlocks no card NOPE/.test(x)) && p.some((x) => /no place P99/.test(x))).toBe(true);
    expect(() => new DeckRun(bad)).toThrow(/problems/);
  });
  it('several to choose from; a committed card resolves to its one outcome after travel + work, the player moved there', () => {
    const r = new DeckRun(deck());
    expect(r.affordable().length).toBeGreaterThanOrEqual(2);
    const c = take(r, 'O');
    // (Place 1 to Place 2: 8.5 units at pace 4: 3 turns, + 1 work)
    expect(c.resolvesTurn).toBe(r.travel('P2') + 1);
    const coin = r.holdings.goods.coin;
    until(r, () => r.resolutions.length > 0);
    expect(r.holdings.goods.coin).toBe(coin + 3);
    expect(r.at).toBe('P2');
  });
  it('the deck grows: A unlocks B and K; B gives its army a tag and an effect it carries', () => {
    const r = new DeckRun(deck());
    take(r, 'A');
    until(r, () => r.holdings.agents.some((a) => a.kind === 'army'));
    expect(r.pool.has('B') && r.pool.has('K')).toBe(true);
    until(r, () => r.offered.some((o) => o.template === 'B'));
    take(r, 'B');
    until(r, () => r.holdings.agents.some((a) => a.tags.includes('veteran')));
    const army = r.holdings.agents.find((a) => a.kind === 'army')!;
    expect(r.owned({ agent: army.id }).map((b) => b.why)).toEqual(['Drilled']);
  });
  it('effects fire on their triggers: the granary each turn, the walls hold the threat (cooling down)', () => {
    OPP_TUNING.set('lab.startSupplies', 10);
    OPP_TUNING.set('dealer.playerMax', 6);
    try {
      const r = new DeckRun(deck());
      take(r, 'E');
      until(r, () => r.holdings.buildings.length === 1);
      until(r, () => r.offered.some((o) => o.template === 'D'));
      take(r, 'D');
      until(r, () => r.holdings.buildings.length === 2);
      const s = r.holdings.goods.supplies;
      const doom = r.doom;
      r.nextTurn();
      void s;
      expect(r.firedCount['Granary']).toBeGreaterThan(0);
      expect(r.log.some((l) => /✦ Granary: \+1 supplies/.test(l.text))).toBe(true);
      expect(r.firedCount['Walls']).toBeGreaterThan(0);
      // (the walls fired: doom held that turn, or cooling down since)
      expect(r.doom - doom).toBeLessThanOrEqual(OPP_TUNE.lab.doomPerTurn);
    } finally {
      OPP_TUNING.reset();
    }
  });
  it('a sacrifice is a card: the army lost, the threat pushed back, and the champion\'s vow fires on the loss', () => {
    const r = new DeckRun(deck());
    r.holdings.agents.push({ id: 'army9', kind: 'army', name: 'Militia', count: 6, tags: [], statuses: [], at: { with: 'player' } });
    r.holdings.agents.push({ id: 'k9', kind: 'knight', name: 'Knight', count: 1, tags: ['named'], statuses: [], at: { with: 'player' } });
    r.holdings.bonuses.push({ why: "Champion's vow", on: 'agent-lost', effect: { kind: 'gain', goods: { strength: 2 } }, holder: 'k9' });
    r.pool.add('K');
    r.doom = 5;
    r.deal();
    const str = r.holdings.goods.strength ?? 0;
    take(r, 'K');
    until(r, () => r.resolutions.length > 0);
    expect(r.holdings.agents.some((a) => a.id === 'army9')).toBe(false);
    expect(r.holdings.goods.strength).toBe(str + 2);
    expect(r.resolutions[0].out).toContainEqual({ kind: 'conflict', op: 'doom', amount: -3 });
  });
  it('let go, a card fires its onExpire: the Empire occupies Town 2 — and the granary there is lost with it', () => {
    OPP_TUNING.set('dealer.playerMax', 6);
    const r = new DeckRun(deck());
    OPP_TUNING.reset();
    take(r, 'E');
    until(r, () => r.holdings.buildings.length === 1);
    expect(r.holdings.bonuses.some((b) => b.why === 'Granary')).toBe(true);
    until(r, () => r.world.settlements.find((s) => s.id === 'P2')!.faction === 'f-empire', 20);
    const t2 = r.world.settlements.find((s) => s.id === 'P2')!;
    expect(t2).toMatchObject({ faction: 'f-empire', condition: 'besieged' });
    expect(r.world.settlements.find((s) => s.id === 'P1')!.people.some((p) => p.role === 'refugee')).toBe(true);
    expect(r.holdings.buildings).toEqual([]);
    expect(r.holdings.bonuses.some((b) => b.why === 'Granary')).toBe(false);
    expect(r.worldLog.some((w) => w.world?.some((l) => /held by The Empire/.test(l)))).toBe(true);
  });
  it('the climax: forced when doom reaches it, always on the board; unmet, the run is lost and Town 1 falls', () => {
    const r = new DeckRun(deck());
    until(r, () => !!r.end, 60);
    expect(r.end).toBe('lost');
    expect(r.world.settlements.find((s) => s.id === 'P1')).toMatchObject({ condition: 'ruined', faction: 'f-host' });
  });
  it('the simulator: win rate, run length, choices, cards never or always taken, effects fired, world change', () => {
    const g = simulate(deck(), { runs: 30, seed: 1, policy: 'greedy' });
    const rnd = simulate(deck(), { runs: 30, seed: 1, policy: 'random' });
    for (const s of [g, rnd]) {
      expect(s.runs).toBe(30);
      expect(s.meanTurns).toBeGreaterThan(0);
      expect(s.meanChoices).toBeGreaterThan(0);
      expect(s.cards).toHaveLength(LAB.cards.length);
      expect(s.world.meanEvents).toBeGreaterThan(0);
    }
    expect(g.relics.length).toBeGreaterThan(0);
    // (no rolls: the same seed and policy, the same report)
    expect(simulate(deck(), { runs: 30, seed: 1, policy: 'greedy' }).winRate).toBe(g.winRate);
    console.log(JSON.stringify({ greedy: { win: g.winRate, turns: g.meanTurns, choices: g.meanChoices, never: g.never, always: g.always, relics: g.relics, world: g.world }, random: { win: rnd.winRate, turns: rnd.meanTurns } }));
  });
});
