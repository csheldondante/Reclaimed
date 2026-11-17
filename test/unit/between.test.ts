// (card-table, PACK_FORMAT draft 8) The owner: "We should not have a separate raid mechanism it should be a card" and "I
// would not have factions act outside of cards as it controls the pacing", then: "At least during the run it being
// gamified is good. Between runs is another lever for balance." DURING a run only cards (taken or run out) move the
// world; BETWEEN runs one deterministic step does (season/realm-between.ts), each change a line in the record.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { grant } from '../../src/season/ledger';
import { BETWEEN } from '../../src/season/realm-between';
import { RAIDERS_ID } from '../../src/season/realm';
import { stanceOf } from '../../src/living/stance';
import { Table } from '../../src/table/game';

const FRONTIER = JSON.parse(fs.readFileSync('packs/frontier.json', 'utf8')) as Pack;

/** a run played to its end: each season every card it can pay for is taken (threats first), or none (`idle`) */
function play(t: Table, o: { idle?: boolean; rich?: boolean; want?: (template: string) => boolean } = {}): void {
  while (!t.over) {
    if (o.rich) t.realm.ledger = grant(t.realm.ledger, { materials: 6, intel: 2, magic: 1 });
    if (!o.idle) for (const c of t.cards().sort((a, b) => Number(b.threat) - Number(a.threat))) if ((!o.want || o.want(c.template)) && !Object.keys(c.short).length) t.take(c.id);
    t.endSeason();
  }
}

/** the kinds of fact event that move the world: places taken, sworn, founded, ruined; stances; land and signs */
const MOVES = ['captured', 'vassal', 'destroyed', 'abandoned', 'founding', 'revealed', 'stance', 'flooded', 'burned', 'melted', 'buried', 'dried', 'withered', 'greened', 'ashfall', 'darkness', 'deadrise', 'crime', 'migration', 'fell', 'relieved'];

describe('between runs: the one step where the world moves on its own', () => {
  it('during a run nothing moves the world but cards: every change has a card (an offer) as its cause', () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 12, packs: [FRONTIER] });
    play(t, { rich: true });
    const r = t.realm;
    const offers = new Set([...r.engine.offers, ...r.engine.past].map((o) => o.id));
    const moved = r.history().filter((e) => MOVES.includes(e.kind) && e.kind !== 'run-began');
    expect(moved.length).toBeGreaterThan(3);
    // (a change's cause is an offer — its outcome, its expiry or its setup — or one of its own steps "<offer>:…")
    const outside = moved.filter((e) => {
      const cause = e.about?.opp ?? '';
      return ![...offers].some((id) => cause === id || cause.startsWith(`${id}:`));
    });
    expect(outside.map((e) => `${e.kind}: ${e.note} (${e.about?.opp ?? 'no cause'})`)).toEqual([]);
    // (and no between-runs line was written while the run was played)
    expect(r.history().filter((e) => e.kind === BETWEEN)).toEqual([]);
  }, 120000);

  it('runs once as the next run begins, never during it and never when a saved run is taken up; the same world gives the same step', () => {
    const one = (): Table => {
      const t = new Table({ seed: 7, leader: 'ysolt', seasons: 6 });
      // (the tribute paid: the raiders keep a truce for this run)
      play(t, { rich: true, want: (x) => x === 'pay-raiders' });
      return t;
    };
    const a = one();
    expect(a.realm.history().some((e) => e.kind === 'tribute-paid')).toBe(true);
    expect(stanceOf(a.realm.w, RAIDERS_ID, 'player')).toBe('truce');
    const a2 = a.next('dunstan');
    const b2 = one().next('dunstan');
    const lines = (t: Table) => t.realm.w.facts.events({ kind: BETWEEN }).map((e) => `${e.turn} ${e.about?.thing}: ${e.note}`);
    expect(lines(a2)).toEqual(lines(b2));
    // (the truce lapsed while nobody played: the raiders are on the road again, and the run's start says so)
    expect(lines(a2).some((l) => l.includes('raiders-truce-ends'))).toBe(true);
    expect(stanceOf(a2.realm.w, RAIDERS_ID, 'player')).toBe('hostile');
    expect(a2.worldNow().some((l) => /^While you were gone: the raiders spent your tribute/.test(l))).toBe(true);
    // (written before the run began: at the turn the last run ended)
    const began = a2.realm.w.facts.events({ kind: 'run-began' }).at(-1)!;
    for (const e of a2.realm.w.facts.events({ kind: BETWEEN })) expect(e.turn).toBeLessThan(began.turn);
    // (a run played on writes none; a saved run taken up writes none)
    const n = lines(a2).length;
    a2.endSeason();
    a2.endSeason();
    expect(lines(a2).length).toBe(n);
    const c = new Table({ seed: 7, leader: 'dunstan', seasons: 6, resume: a2.save() });
    expect(lines(c).length).toBe(n);
  }, 120000);

  it('a sign a run left fades between runs; a raid that broke in leaves thieves for its run only', () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 4 });
    play(t, { idle: true });
    expect(t.realm.fight?.held).toBe(false);
    expect(t.realm.w.facts.tag(t.home, 'condition', 'crime')?.value).toBe(true);
    const n = t.next('ysolt');
    expect(n.realm.w.facts.tag(n.home, 'condition', 'crime')?.value).toBeFalsy();
    expect(n.worldNow().some((l) => /^While you were gone: years passed/.test(l))).toBe(true);
  }, 120000);
});
