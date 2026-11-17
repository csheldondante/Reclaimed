// (card-table, docs/design/TURN_PUZZLE.md) The turn as a puzzle: pieces posted on things, instant uses, the preview,
// no undo; the works pack loads and checks; old data's Labor and Might are pieces.
import { describe, expect, it } from 'vitest';
import { checkPack } from '../../src/packs/check';
import { pools } from '../../src/season/ledger';
import { WORKS } from '../../src/season/works';
import { replay, Table } from '../../src/table/game';

const mk = (leader = 'dunstan') => new Table({ seed: 7, leader, works: true });
const pool = (t: Table) => pools(t.realm.ledger);
const mine = 'thing:works-mine';

describe('the works (draft 10)', () => {
  it('the works pack checks with no errors', () => {
    const errs = checkPack(WORKS, {}).filter((p) => p.level === 'error');
    expect(errs, JSON.stringify(errs)).toEqual([]);
  });

  it('starts with the mine, the stalls and the shrine in play, and a bigger board', () => {
    const t = mk();
    expect(t.works().map((w) => w.id).sort()).toEqual(['thing:works-mine', 'thing:works-shrine', 'thing:works-stalls']);
    expect(t.cards().length).toBeGreaterThanOrEqual(5);
  });

  it('a crew posted on the mine is not free, gives Materials at the season end, and comes back when recalled', () => {
    const t = mk();
    const crews = pool(t).labor;
    expect(t.post('crew', mine)).toBe(true);
    expect(pool(t).labor).toBe(crews - 1);
    expect(t.pieces().filter((p) => p.where === 'posted' && p.on === mine)).toHaveLength(1);
    expect(t.realm.things().find((x) => x.id === mine)!.tags).toContain('crewed');
    // (a piece moves once a season: the same crew cannot be called back this season)
    expect(t.recall('crew', mine)).toBe(false);
    t.endSeason();
    expect(t.log.some((l) => l.kind === 'rule' && /crew\(s\) on The mine: \+1 Materials/.test(l.text)), t.log.map((l) => l.text).join('\n')).toBe(true);
    const free = pool(t).labor;
    expect(t.recall('crew', mine)).toBe(true);
    expect(pool(t).labor).toBe(free + 1);
  });

  it('order matters: dig deep after posting crews gives more than before', () => {
    const a = mk();
    const b = mk();
    const m0 = pool(a).materials;
    // (a: post two crews, then dig; b: dig, then post)
    expect(a.post('crew', mine) && a.post('crew', mine) && a.use('works-dig-deep', mine)).toBe(true);
    expect(b.use('works-dig-deep', mine) && b.post('crew', mine) && b.post('crew', mine)).toBe(true);
    expect(pool(a).materials).toBe(m0 + 2);
    expect(pool(b).materials).toBe(m0);
    // (once a season)
    expect(a.use('works-dig-deep', mine)).toBe(false);
  });

  it('a use is instant and counts its times; the market sells twice, then no more', () => {
    const t = mk();
    const stalls = 'thing:works-stalls';
    const p0 = pool(t);
    expect(t.use('works-sell-stone', stalls)).toBe(true);
    expect(pool(t).materials).toBe(p0.materials - 2);
    expect(pool(t).intel).toBe(p0.intel + 2);
    t.realm.ledger = { ...t.realm.ledger, holdings: { ...t.realm.ledger.holdings, goods: { ...t.realm.ledger.holdings.goods, materials: 10 } } };
    expect(t.use('works-sell-stone', stalls)).toBe(true);
    expect(t.use('works-sell-stone', stalls)).toBe(false);
    t.endSeason();
    expect(t.use('works-sell-stone', stalls)).toBe(true);
  });

  it('the preview says what a card ties up and when it comes back, and changes nothing', () => {
    const t = mk();
    const c = t.cards().find((x) => (x.locks.labor ?? 0) > 0 && !Object.keys(x.short).length)!;
    expect(c).toBeTruthy();
    const before = pool(t);
    const p = t.preview(c.id);
    expect(pool(t)).toEqual(before);
    expect(p.tied.crew).toBe(c.locks.labor);
    expect(p.after.labor).toBe(before.labor - c.locks.labor!);
    expect(p.back).toBe(t.season + c.turns);
  });

  it('a run with pieces and uses replays from its moves and survives a save', () => {
    const t = mk();
    t.post('crew', mine);
    t.use('works-dig-deep', mine);
    t.endSeason();
    t.post('crew', mine);
    const again = replay({ seed: 7, leader: 'dunstan', works: true }, t.moves);
    expect(pool(again)).toEqual(pool(t));
    const back = new Table({ seed: 7, leader: 'dunstan', works: true, resume: t.save() });
    expect(back.pieces()).toEqual(t.pieces());
    expect(back.realm.uses().map((u) => u.left)).toEqual(t.realm.uses().map((u) => u.left));
  });

  it('old data: Labor and Might are pieces (n Labor locked = n crews tied up on the project)', () => {
    const t = mk();
    const c = t.cards().find((x) => (x.locks.labor ?? 0) > 0 && !Object.keys(x.short).length)!;
    expect(t.take(c.id)).toBe(true);
    expect(t.pieces().filter((p) => p.where === 'project' && p.kind === 'crew')).toHaveLength(c.locks.labor!);
  });
});
