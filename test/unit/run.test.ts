// (loop-skeleton; docs/design/LOOP_SKELETON.md) The run record's rules: a played card commits its cost, an expiry's
// effect is applied once, the threat's countdown ends in a raid, a world change is recorded once and read back, the
// leaders differ by something real, and every line the skeleton shows passes the writing lint.
import { describe, expect, it } from 'vitest';
import { newLedger, nextSeason, pools, total } from '../../src/season/ledger';
import { decodeWorld, deckFor, encode, endSeason, comesHome, CRIME_UNREST, signsNow, fought, HAND_SIZE, mutate, newRun, REFUGEES, tribute, WAGONS, newWorld, play, raidDue, shortOf, startLedger, threatDone, type Petition, type RunRecord } from '../../src/season/run';
import { attackLine, costText, expiredLine, LEADERS, leader, leftText, PETITIONS, playedLine, presenterLine, RAIDERS, resultLines, bringsLine, changeLine, placeLine, tributeLine, homeLines, SIGN_NAME } from '../../src/season/run-words';
import { lint } from '../support/writing';

const pet = (id: string): Petition => PETITIONS.find((p) => p.id === id)!;
const begin = (who = 'dunstan', seed = 7) => {
  const l = leader(who);
  const { run, world } = newRun(l, PETITIONS, newWorld(), seed);
  return { run, world, ledger: startLedger(l, null, newLedger) };
};
/** a run with these cards in the hand (the threat kept) */
const holding = (run: RunRecord, ids: string[]): RunRecord => ({ ...run, hand: [...run.hand.filter((h) => pet(h.id).threat), ...ids.map((id) => ({ id, left: pet(id).seasons }))] });

describe('the run record (season/run.ts)', () => {
  it('every card has exactly a cost, an effect if played, an effect if it expires, and a named presenter', () => {
    for (const p of PETITIONS) {
      expect(p.presenter.name.length).toBeGreaterThan(1);
      expect(costText(p).length).toBeGreaterThan(0);
      expect(p.played.text.length).toBeGreaterThan(0);
      expect(p.expires.text.length).toBeGreaterThan(0);
      expect(p.seasons).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(PETITIONS.map((p) => p.id)).size).toBe(PETITIONS.length);
  });

  it('a new run has the threat in the hand from season 1 with its countdown, and a full hand beside it', () => {
    const { run, world } = begin();
    expect(run.season).toBe(1);
    expect(world.runs).toBe(1);
    expect(run.hand.find((h) => h.id === 'raiders')).toEqual({ id: 'raiders', left: 3 });
    expect(run.hand.filter((h) => !pet(h.id).threat).length).toBe(HAND_SIZE);
    expect(leftText(pet('raiders'), 3)).toBe('They come in 3 seasons.');
  });

  it('playing a project card commits its cost: people locked, goods spent, the card out of the hand', () => {
    const s = begin();
    const run = holding(s.run, ['forge']);
    const r = play(run, s.ledger, PETITIONS, 'forge');
    expect(pools(r.ledger).labor).toBe(pools(s.ledger).labor - 3);
    expect(total(r.ledger, 'labor')).toBe(total(s.ledger, 'labor'));
    expect(pools(r.ledger).materials).toBe(pools(s.ledger).materials - 3);
    expect(r.ledger.projects.map((p) => p.card.id)).toEqual(['workshops']);
    expect(r.run.hand.some((h) => h.id === 'forge')).toBe(false);
    expect(r.run.played).toEqual([{ id: 'forge', season: 1 }]);
    // (committed is committed: it can't be played again, and the given records are untouched)
    expect(() => play(r.run, r.ledger, PETITIONS, 'forge')).toThrow(/not in the hand/);
    expect(s.ledger.projects.length).toBe(0);
    // (the locked people come back when it's built, with what it gives)
    let l = r.ledger;
    for (let k = 0; k < 2; k++) l = nextSeason(l).ledger;
    expect(pools(l).labor).toBe(pools(s.ledger).labor);
    expect(l.income.materials).toBe((s.ledger.income.materials ?? 0) + 2);
  });

  it('a card whose cost is not free can not be played, and says what is short', () => {
    const s = begin('ysolt');
    const run = holding(s.run, ['forge']);
    const poor = { ...s.ledger, holdings: { ...s.ledger.holdings, goods: { ...s.ledger.holdings.goods, materials: 1 } } };
    expect(shortOf(poor, pet('forge'))).toEqual({ materials: 2 });
    expect(() => play(run, poor, PETITIONS, 'forge')).toThrow(/short/);
  });

  it('a spend card spends at once; a card that gives a spell unlocks it once', () => {
    const s = begin('ilveth');
    const run = holding(s.run, ['tower', 'archive']);
    const a = play(run, s.ledger, PETITIONS, 'archive');
    expect(pools(a.ledger).intel).toBe(pools(s.ledger).intel - 1);
    expect(pools(a.ledger).materials).toBe(pools(s.ledger).materials + 2);
    const t = play(a.run, a.ledger, PETITIONS, 'tower');
    expect(t.run.spells).toEqual(['heatray']);
    expect(pools(t.ledger).magic).toBe(pools(s.ledger).magic - 1);
  });

  it('an unplayed card ages a season at a time and expires with its effect, once', () => {
    const s = begin();
    const run = holding(s.run, ['forge']);
    const e1 = endSeason({ ...run, deck: [] }, s.ledger, PETITIONS, s.world);
    expect(e1.expired).toEqual([]);
    expect(e1.run.hand.find((h) => h.id === 'forge')).toEqual({ id: 'forge', left: 1 });
    expect(pools(e1.ledger).unrest).toBe(0);
    const e2 = endSeason(e1.run, e1.ledger, PETITIONS, s.world);
    expect(e2.expired.map((p) => p.id)).toContain('forge');
    expect(pools(e2.ledger).unrest).toBe(1);
    expect(e2.run.expired.filter((x) => x.id === 'forge')).toEqual([{ id: 'forge', season: 2 }]);
    // (gone for good: later seasons don't apply it again, and it isn't dealt again)
    const e3 = endSeason({ ...e2.run, hand: e2.run.hand.filter((h) => pet(h.id).threat) }, e2.ledger, PETITIONS, s.world);
    expect(pools(e3.ledger).unrest).toBe(1);
    expect(e3.run.hand.some((h) => h.id === 'forge')).toBe(false);
    expect(e3.run.deck.includes('forge')).toBe(false);
  });

  it("the threat's countdown: 3, 2, 1, then the raid is due the season after it expires", () => {
    let { run, ledger } = begin();
    const left: number[] = [];
    for (let k = 0; k < 3; k++) {
      left.push(run.hand.find((h) => h.id === 'raiders')!.left);
      expect(raidDue(run, run.season)).toBe(null);
      expect(threatDone(run, PETITIONS)).toBe(false);
      ({ run, ledger } = endSeason(run, ledger, PETITIONS, newWorld()));
    }
    expect(left).toEqual([3, 2, 1]);
    expect(run.season).toBe(4);
    expect(run.raid).toEqual({ n: RAIDERS, season: 4 });
    expect(raidDue(run, 4)).toBe(RAIDERS);
    expect(raidDue(run, 5)).toBe(null);
    const after = fought(run, { raiders: RAIDERS, left: 2, fallen: 3 }, pet('raiders'));
    expect(after.fight?.held).toBe(false);
    // (broken through: the threat's world change is due; held: none)
    expect(after.due.filter((d) => !run.due.includes(d)).map((d) => [d.id, d.mutation.kind, d.mutation.where])).toEqual([['raiders:1:4', 'burned', 'the east district']]);
    expect(fought(run, { raiders: RAIDERS, left: 0, fallen: 1 }, pet('raiders')).due).toEqual(run.due);
    expect(raidDue(after, 4)).toBe(null);
    expect(threatDone(after, PETITIONS)).toBe(true);
    expect(fought(run, { raiders: RAIDERS, left: 0, fallen: 1 }).fight?.held).toBe(true);
  });

  it('paying the tribute spends it and no raid comes', () => {
    const s = begin('dunstan');
    const r = play(s.run, s.ledger, PETITIONS, 'raiders');
    expect(pools(r.ledger).materials).toBe(pools(s.ledger).materials - 6);
    let { run, ledger } = r;
    for (let k = 0; k < 4; k++) ({ run, ledger } = endSeason(run, ledger, PETITIONS, newWorld()));
    expect(run.raid).toBe(null);
    expect(threatDone(run, PETITIONS)).toBe(true);
  });

  it('a world change is recorded once, survives the store, and a new run in that world still has it', () => {
    const s = begin();
    // (the dam card left unplayed: its expiry names the flood, due once)
    const e = endSeason(holding(s.run, ['dam']), s.ledger, PETITIONS, s.world);
    expect(e.run.due).toEqual([{ id: 'dam:1:1', mutation: pet('dam').expires.mutation, text: 'The dam breaks. The lower town floods.' }]);
    const place = { town: 'Muru', at: [120, 80] as [number, number], radius: 30 };
    const m1 = mutate(e.run, s.world, 'dam:1:1', place);
    expect(m1.added).toBe(true);
    expect(m1.run.due).toEqual([]);
    expect(m1.world.changes.length).toBe(1);
    expect(m1.world.changes[0]).toMatchObject({ kind: 'flooded', where: 'the lower town', near: { town: 'Muru', at: [120, 80] }, run: 1, season: 2, leader: 'dunstan' });
    expect(m1.run.mutations).toEqual(['dam:1:1']);
    expect(changeLine(m1.world.changes[0])).toBe('The dam breaks. The lower town floods. Flooded. The lower town, Muru.');
    // (the same change asked again — a replay: not added twice)
    const m2 = mutate({ ...m1.run, due: e.run.due }, m1.world, 'dam:1:1', place);
    expect(m2.added).toBe(false);
    expect(m2.world.changes.length).toBe(1);
    expect(() => mutate(m1.run, m1.world, 'dam:1:1', place)).toThrow(/no world change/);
    const back = decodeWorld(encode(m2.world));
    expect(back).toEqual(m2.world);
    const again = newRun(leader('ysolt'), PETITIONS, back, 11);
    expect(again.world.runs).toBe(2);
    expect(again.run.n).toBe(2);
    expect(again.world.changes.map((c) => c.id)).toEqual(['dam:1:1']);
    expect(again.run.mutations).toEqual([]);
    expect(() => decodeWorld(encode({ ...back, v: 2 as 1 }))).toThrow(/version 2/);
  });

  it('a card about a far place is in the first hand; played, its place is founded at once and pays tribute each season', () => {
    const s = begin('ysolt');
    expect(s.run.hand.map((h) => h.id)).toEqual(expect.arrayContaining(['raiders', 'mine', 'relief']));
    const r = play(s.run, s.ledger, PETITIONS, 'mine');
    expect(r.run.due.map((d) => d.id)).toEqual(['mine:1:1']);
    // (far: no place in the town is needed — it is recorded wherever the camera is)
    const m = mutate(r.run, s.world, 'mine:1:1');
    expect(m.world.places).toEqual([{ id: 'copper-hollow', name: 'Copper Hollow', owner: 'you', status: 'founded', tribute: { materials: 1 } }]);
    expect(m.world.changes[0]).toMatchObject({ kind: 'founded', far: 'copper-hollow', where: 'Copper Hollow' });
    expect(tribute(m.world)).toEqual({ materials: 1 });
    expect(comesHome(m.world)).toEqual({ people: 0, wagons: WAGONS });
    // (lost later: the wagons stop and the income with them)
    const lost = { ...m.world, places: m.world.places.map((p) => ({ ...p, owner: 'raiders' as const, status: 'captured' as const, tribute: {} })) };
    expect(comesHome(lost).wagons).toBe(0);
    expect(tribute(lost)).toEqual({});
    const e = endSeason({ ...m.run, hand: [] , deck: [] }, r.ledger, PETITIONS, m.world);
    expect(e.tribute).toEqual({ materials: 1 });
    expect(pools(e.ledger).materials).toBe(pools(r.ledger).materials + 1);
    // (a near change can't be recorded without its place in the town)
    const d = endSeason(holding(s.run, ['dam']), s.ledger, PETITIONS, s.world);
    expect(() => mutate(d.run, s.world, 'dam:1:1')).toThrow(/needs its place/);
  });

  it('a far town left to fall is captured at once, and then sends a worse card; helped, it is a vassal that pays', () => {
    const s = begin('dunstan');
    // (unplayed: Harrowgate's card lasts one season)
    const e = endSeason(s.run, s.ledger, PETITIONS, s.world);
    expect(e.expired.map((p) => p.id)).toContain('relief');
    const m = mutate(e.run, s.world, 'relief:1:1');
    expect(m.world.places.find((p) => p.id === 'harrowgate')).toMatchObject({ owner: 'raiders', status: 'captured' });
    expect(tribute(m.world)).toEqual({});
    // (it comes home: refugees in your town, Unrest up, and a named refugee's card next season)
    expect(comesHome(m.world)).toEqual({ people: REFUGEES, wagons: 0 });
    expect(pools(e.ledger).unrest).toBe(pools(s.ledger).unrest + 1);
    expect(m.run.hand.some((h) => h.id === 'toll')).toBe(false);
    const e2 = endSeason({ ...m.run, hand: m.run.hand.filter((h) => pet(h.id).threat) }, e.ledger, PETITIONS, m.world);
    expect(e2.run.hand.map((h) => h.id)).toEqual(expect.arrayContaining(['refugees', 'toll']));
    expect(e2.run.hand.some((h) => h.id === 'levy')).toBe(false);
    // (helped instead: a vassal, paying; its own card comes, and a later run in this world still has the place)
    const y = begin('ysolt');
    const r = play(y.run, y.ledger, PETITIONS, 'relief');
    expect(pools(r.ledger).might).toBe(pools(y.ledger).might - 1);
    const v = mutate(r.run, y.world, 'relief:1:1');
    expect(tribute(v.world)).toEqual({ materials: 1 });
    const next = newRun(leader('ilveth'), PETITIONS, v.world, 3);
    expect(next.world.places.map((p) => p.status)).toEqual(['vassal']);
    expect(next.run.hand.some((h) => h.id === 'levy')).toBe(true);
    expect(placeLine(v.world.places[0])).toBe('Harrowgate. Your vassal. Pays you +1 Materials each season.');
  });

  it('signs: a card warns while it is in the hand, an expiry leaves signs for some seasons, high Unrest shows as crime', () => {
    const s = begin('ilveth');
    const run = { ...holding(s.run, ['shrine']), deck: [] };
    expect(signsNow(run, s.ledger, PETITIONS)).toEqual(['ashfall']);
    expect(signsNow({ ...run, hand: [] }, s.ledger, PETITIONS)).toEqual([]);
    // (unfed for its two seasons: the mountain breaks — ash and darkness for three seasons after)
    const e1 = endSeason(run, s.ledger, PETITIONS, s.world);
    const e2 = endSeason(e1.run, e1.ledger, PETITIONS, s.world);
    expect(e2.run.due.map((d) => d.mutation.kind)).toContain('melted');
    const quiet = { ...e2.run, hand: [] };
    expect(signsNow(quiet, s.ledger, PETITIONS).sort()).toEqual(['ashfall', 'darkness']);
    expect(signsNow({ ...quiet, season: quiet.season + 2 }, s.ledger, PETITIONS).sort()).toEqual(['ashfall', 'darkness']);
    expect(signsNow({ ...quiet, season: quiet.season + 3 }, s.ledger, PETITIONS)).toEqual([]);
    const angry = { ...s.ledger, holdings: { ...s.ledger.holdings, goods: { ...s.ledger.holdings.goods, unrest: CRIME_UNREST } } };
    expect(signsNow({ ...run, hand: [] }, angry, PETITIONS)).toEqual(['crime']);
  });

  it('a new run keeps what the town built and starts from the new leader pools', () => {
    const l0 = { ...startLedger(leader('dunstan'), null, newLedger), built: ['houses', 'walls'], season: 6 };
    const l1 = startLedger(leader('ysolt'), l0, newLedger);
    expect(l1.season).toBe(1);
    expect(l1.built).toEqual(['houses', 'walls']);
    expect(pools(l1).might).toBe(3);
    expect(l1.projects).toEqual([]);
  });

  it('leaders differ by something real: their pools, and which suit comes up first', () => {
    const start = LEADERS.map((l) => JSON.stringify(pools(startLedger(l, null, newLedger))));
    expect(new Set(start).size).toBe(LEADERS.length);
    for (const l of LEADERS) {
      let first = 0;
      const N = 400;
      for (let seed = 1; seed <= N; seed++) if (pet(deckFor(l, PETITIONS, seed)[0]).suit === l.suit) first++;
      const town = PETITIONS.filter((p) => !p.threat && !p.first && !p.when);
      const own = town.filter((p) => p.suit === l.suit).length;
      const all = town.length;
      expect(first / N).toBeGreaterThan(own / all + 0.1);
      expect(deckFor(l, PETITIONS, 5).slice().sort()).toEqual(PETITIONS.filter((p) => !p.threat && !p.when).map((p) => p.id).sort());
    }
  });

  it("every line the skeleton shows passes the writing lint (docs/WRITING.md)", () => {
    const lines: string[] = [];
    for (const l of LEADERS) lines.push(l.name, l.line);
    for (const p of PETITIONS) {
      lines.push(p.title, p.ask, presenterLine(p), costText(p), p.played.text, p.expires.text, playedLine(p), expiredLine(p, p.expires), leftText(p, 1), leftText(p, 3));
      if (p.threat) lines.push(p.threat.helps, p.threat.broke, bringsLine(p));
    }
    for (const st of ['coming', 'there', 'fighting'] as const) lines.push(attackLine(6, 4, 3, st), attackLine(6, 0, 0, st), attackLine(6, 6, 1, st));
    lines.push(...resultLines({ raiders: 6, left: 2, fallen: 3, held: false }, { might: 1, materials: 2, unrest: 1 }), ...resultLines({ raiders: 6, left: 0, fallen: 1, held: true }, { might: 1, materials: 0, unrest: 0 }));
    lines.push(...Object.values(SIGN_NAME), ...homeLines({ people: 40, wagons: 14 }), tributeLine({ materials: 2 }), placeLine({ id: 'x', name: 'Harrowgate', owner: 'raiders', status: 'captured', tribute: {} }));
    const bad = lines.flatMap((t) => lint(t).map((why) => `${why}: ${t}`));
    expect(bad).toEqual([]);
  });
});
