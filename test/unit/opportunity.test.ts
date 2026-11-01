// (round 120, opportunities) The opportunity contract's rules in Node: what's available, meeting requirements (kinds,
// counts, tags), affording costs, committing (agents locked, costs spent, the roll), resolving (losses, tags and
// bonuses for the survivors, goods and agents gained, the effects passed on), bonuses (negate lifts a tier, instant
// resolves at once), and the CharacterRecord's tags persisting through the world state.

import { describe, expect, it } from 'vitest';
import { affords, available, commit, emptyHoldings, meet, outcomeAt, resolve, rollTier, scaleOf, type Agent, type Holdings, type Opportunity } from '../../src/api/contracts/opportunity';
import { MemoryWorldState } from '../../src/api/contracts/world-state';

const agent = (id: string, kind: Agent['kind'], o: Partial<Agent> = {}): Agent => ({ id, kind, name: id, count: 1, tags: [], statuses: [], at: { with: 'player' }, ...o });

const hold = (...agents: Agent[]): Holdings => ({ ...emptyHoldings(), agents, goods: { supplies: 3 } });

const fordOpp = (o: Partial<Opportunity> = {}): Opportunity => ({
  id: 'ford', template: 'ford', offer: 'hold', title: 'Hold the ford', pitch: '', location: { region: 1, at: [0, 0], name: 'the ford' },
  requires: [{ kind: 'army', count: 1 }], tier: 1, tiers: 3, costs: { supplies: 1 }, duration: { turns: 1 },
  odds: { success: 0.6, cost: 0.25, failure: 0.15 },
  outcomes: {
    success: { text: 'held', effects: [{ kind: 'conflict', op: 'delay', amount: 2 }, { kind: 'tag', add: ['veteran'] }], losses: 0.25 },
    cost: { text: 'held dearly', effects: [{ kind: 'conflict', op: 'delay', amount: 1 }, { kind: 'tag', add: ['veteran'] }], losses: 0.5 },
    failure: { text: 'broke', effects: [], losses: 0.75 },
  },
  visibility: 'known', expires: { turn: 0 }, themes: ['fight'], hooks: ['horde'], because: [], affordable: true, missing: [],
  ...o,
});

describe('availability (the user: "they must be available to your character")', () => {
  it('with the player, or stationed where the character rules; not committed, not wounded', () => {
    const h = hold(agent('p', 'player'), agent('a', 'army', { count: 8 }), agent('k', 'knight', { at: { settlement: 's-bumku' } }), agent('w', 'knight', { statuses: ['wounded'] }), agent('c', 'army', { committed: 'k1' }));
    expect(available(h).map((a) => a.id)).toEqual(['p', 'a']);
    expect(available({ ...h, rules: ['s-bumku'] }).map((a) => a.id)).toEqual(['p', 'a', 'k']);
  });
  it('meets kinds, counts and tags — fewest-tagged first, so a veteran is kept for what needs one', () => {
    const h = hold(agent('a', 'army', { tags: ['veteran'] }), agent('b', 'army'));
    expect(meet([{ kind: 'army', count: 1 }], h)).toEqual({ ok: true, agents: ['b'] });
    expect(meet([{ kind: 'army', count: 1, tags: ['veteran'] }, { kind: 'army', count: 1 }], h)).toEqual({ ok: true, agents: ['a', 'b'] });
    const no = meet([{ kind: 'army', count: 3 }], h);
    expect(no.ok).toBe(false);
    expect(!no.ok && no.missing[0]).toMatch(/3 army: 2 free/);
    expect(affords(fordOpp({ costs: { supplies: 5 } }), h)).toEqual({ ok: false, missing: ['5 supplies: 3 held'] });
  });
  it('the scale is derived: lone, party, ruler, empire', () => {
    expect(scaleOf(hold(agent('p', 'player')))).toBe('lone');
    expect(scaleOf(hold(agent('p', 'player'), agent('a', 'army')))).toBe('party');
    expect(scaleOf({ ...hold(agent('p', 'player')), rules: ['s1'] })).toBe('ruler');
    expect(scaleOf({ ...hold(agent('p', 'player')), rules: ['s1', 's2'] })).toBe('empire');
  });
});

describe('commitment and resolution', () => {
  it('locks the agents, spends the costs, rolls the tier — and never changes what it was given', () => {
    const h = hold(agent('p', 'player'), agent('levy', 'army', { count: 8 }));
    const before = structuredClone(h);
    const { holdings, commitment } = commit(h, fordOpp(), { id: 'k1', now: 3, turn: 2, u: 0.1 });
    expect(h).toEqual(before);
    expect(holdings.agents.find((a) => a.id === 'levy')!.committed).toBe('k1');
    expect(holdings.goods.supplies).toBe(2);
    expect(available(holdings).map((a) => a.id)).toEqual(['p']);
    expect(commitment).toMatchObject({ agents: ['levy'], rolled: 'success', resolvesTurn: 3, start: 3, turn: 2 });
    expect(() => commit(holdings, fordOpp(), { id: 'k2', now: 3, turn: 2, u: 0.1 })).toThrow(/1 army: 0 free/);
  });
  it('resolves: survivors back with their losses and new tags; the conflict effects passed on', () => {
    const h = hold(agent('levy', 'army', { count: 8 }));
    const { holdings, commitment } = commit(h, fordOpp(), { id: 'k1', now: 0, turn: 0, u: 0.7 });
    expect(commitment.rolled).toBe('cost');
    const { holdings: after, resolution } = resolve(holdings, commitment, { now: 2, turn: 1 });
    const levy = after.agents.find((a) => a.id === 'levy')!;
    expect(levy).toMatchObject({ count: 4, tags: ['veteran'] });
    expect(levy.committed).toBeUndefined();
    expect(resolution).toMatchObject({ tier: 'cost', returns: [{ agent: 'levy', count: 4 }], lost: [{ agent: 'levy', count: 4 }], out: [{ kind: 'conflict', op: 'delay', amount: 1 }] });
  });
  it('a group wiped out is gone; goods and agents gained are held', () => {
    const o = fordOpp({ outcomes: { success: { text: 'won', effects: [{ kind: 'goods', goods: { supplies: 4 } }, { kind: 'agent', agent: agent('ally', 'knight') }] }, failure: { text: 'lost', effects: [], losses: 1 } } });
    const h = hold(agent('levy', 'army', { count: 8 }));
    const a = commit(h, { ...o, odds: { success: 0.5, failure: 0.5 } }, { id: 'k1', now: 0, turn: 0, u: 0.9 });
    const lost = resolve(a.holdings, a.commitment, { now: 1, turn: 1 });
    expect(lost.holdings.agents).toEqual([]);
    const b = commit(h, { ...o, odds: { success: 0.5, failure: 0.5 } }, { id: 'k1', now: 0, turn: 0, u: 0.1 });
    const won = resolve(b.holdings, b.commitment, { now: 1, turn: 1 });
    expect(won.holdings.goods.supplies).toBe(2 + 4);
    expect(won.holdings.agents.map((x) => x.id)).toEqual(['levy', 'ally']);
  });
  it("bonuses: a veteran's negate lifts a disaster on a fight; an instant resolves on the turn it's committed", () => {
    const o = fordOpp({ odds: { disaster: 1 }, outcomes: { success: { text: 'ok', effects: [] }, failure: { text: 'broke', effects: [], losses: 0.5 }, disaster: { text: 'gone', effects: [], losses: 1 } } });
    const h: Holdings = { ...hold(agent('levy', 'army', { count: 8, tags: ['veteran'] })), bonuses: [{ kind: 'negate', themes: ['fight'], tier: 'disaster', holder: 'levy', why: 'veterans hold' }] };
    const c = commit(h, o, { id: 'k1', now: 0, turn: 0, u: 0.5 });
    const r = resolve(c.holdings, c.commitment, { now: 1, turn: 1 });
    expect(r.resolution).toMatchObject({ rolled: 'disaster', tier: 'failure', bonuses: ['veterans hold: disaster → failure'] });
    expect(r.holdings.agents[0].count).toBe(4);
    // (held by another agent, it doesn't apply)
    const other: Holdings = { ...h, bonuses: [{ ...h.bonuses[0], holder: 'someone' }] };
    const c2 = commit(other, o, { id: 'k1', now: 0, turn: 0, u: 0.5 });
    expect(resolve(c2.holdings, c2.commitment, { now: 1, turn: 1 }).resolution.tier).toBe('disaster');
    const inst: Holdings = { ...h, bonuses: [{ kind: 'instant', themes: ['fight'], why: 'sappers' }] };
    expect(commit(inst, fordOpp(), { id: 'k1', now: 0, turn: 4, u: 0.1 }).commitment.resolvesTurn).toBe(4);
  });
  it('a challenge iff the player is required; the player resolves from the challenge, never by a share', () => {
    const play = fordOpp({ requires: [{ kind: 'player', count: 1 }], odds: undefined, duration: { minutes: 3 }, challenge: { system: 'character', play: 'flee', area: 'a-start', minutes: 2.5, encounter: { kind: 'flee', foes: 0, pursuers: 3, text: '' } }, outcomes: { success: { text: 'away', effects: [], losses: 1 }, failure: { text: 'caught', effects: [] } } });
    const h = hold(agent('p', 'player'));
    const c = commit(h, play, { id: 'k1', now: 0, turn: 0 });
    expect(c.commitment.rolled).toBeUndefined();
    expect(() => resolve(c.holdings, c.commitment, { now: 1, turn: 0 })).toThrow(/no tier/);
    const r = resolve(c.holdings, c.commitment, { now: 1, turn: 0, tier: 'success' });
    expect(r.holdings.agents[0]).toMatchObject({ id: 'p', count: 1 });
    expect(() => commit(h, { ...play, challenge: undefined }, { id: 'k1', now: 0, turn: 0 })).toThrow(/challenge iff/);
  });
  it('rolls by the odds; an outcome missing for a tier falls to the nearest worse one', () => {
    const odds = { triumph: 0.1, success: 0.5, cost: 0.25, failure: 0.15 };
    expect([0, 0.05, 0.1, 0.59, 0.6, 0.84, 0.85, 0.999, 1].map((u) => rollTier(odds, u))).toEqual(['triumph', 'triumph', 'success', 'success', 'cost', 'cost', 'failure', 'failure', 'failure']);
    expect(outcomeAt(fordOpp(), 'triumph').text).toBe('held');
    expect(outcomeAt(fordOpp(), 'disaster').text).toBe('broke');
  });
});

describe('persistence (the user: "Yes I think that we want them to persist")', () => {
  it("a character's tags and bonuses go into the world state and survive a save", () => {
    const w = new MemoryWorldState(1);
    w.applyCharacter({ kind: 'meet', character: { id: 'levy:s1', name: 'the levy', role: 'army', faction: null, hero: false, alive: true, region: 1, motivation: 'serve' } });
    w.applyCharacter({ kind: 'tags', id: 'levy:s1', add: ['veteran'], bonuses: [{ kind: 'negate', themes: ['fight'], tier: 'disaster', why: 'veterans hold' }] });
    w.applyCharacter({ kind: 'tags', id: 'levy:s1', add: ['veteran'], bonuses: [{ kind: 'negate', themes: ['fight'], tier: 'disaster', why: 'veterans hold' }] });
    const back = MemoryWorldState.restore(JSON.parse(JSON.stringify(w.snapshot())));
    expect(back.character('levy:s1')).toMatchObject({ tags: ['veteran'], bonuses: [{ kind: 'negate', why: 'veterans hold' }] });
    expect(back.character('levy:s1')!.bonuses).toHaveLength(1);
  });
});
