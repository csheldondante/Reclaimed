// (board, docs/design/BOARD.md) The board's pure parts: the town's layout (every site on dry land and reachable by
// road, the raiders' road passing the watch post and the gate), the looks (every scar and sign has one; an unknown tag
// shows as words), and the reading of a real run (every offer placed, every piece accounted for).
import { describe, expect, it } from 'vitest';
import { dist, idx, roadPath, T, townLayout } from '../../src/board/layout';
import { farLook, SCARS, signsOf, siteLook } from '../../src/board/looks';
import { readBoard } from '../../src/board/model';
import { RUIN } from '../../src/season/realm-rules';
import { SITES } from '../../src/season/realm-templates';
import { Table } from '../../src/table/game';

describe('the town layout', () => {
  const l = townLayout();
  it('puts every site on its own dry cell, the river crossing on the bridge', () => {
    const seen = new Set<number>();
    for (const s of SITES) {
      const c = l.sites[s.key];
      const t = l.tiles[idx(c.x, c.y)];
      if (s.key === 'river') expect(t).toBe(T.Bridge);
      else expect(t, s.key).not.toBe(T.Water);
      expect(seen.has(idx(c.x, c.y)), s.key).toBe(false);
      seen.add(idx(c.x, c.y));
    }
  });
  it('joins every site to the keep by road, and the raiders come in by the gate', () => {
    for (const s of SITES) {
      const p = roadPath(l, l.sites[s.key], l.sites.keep);
      expect(p.length, s.key).toBeGreaterThan(0);
      for (let i = 1; i < p.length; i++) expect(dist(p[i], p[i - 1]), `${s.key} step ${i}`).toBeLessThanOrEqual(2);
    }
    const raid = roadPath(l, l.entries.east, l.sites.keep);
    expect(raid.some((c) => dist(c, l.sites.gate) <= 1)).toBe(true);
  });
  it('has house plots near the keep, nearest first', () => {
    expect(l.plots.length).toBeGreaterThan(20);
    expect(dist(l.plots[0], l.sites.keep)).toBeLessThanOrEqual(dist(l.plots.at(-1)!, l.sites.keep));
  });
});

describe('the looks', () => {
  it('every ruin word of the model has a scar look', () => {
    for (const r of RUIN) expect(SCARS as readonly string[]).toContain(r);
  });
  it('a site: its scars, and what has no look as plain words', () => {
    const l = siteLook('market', ['ruined', 'burned', 'remains-of-market', 'festival', 'sea-raid']);
    expect(l.scars).toEqual(['burned']);
    expect(l.ruined).toBe(true);
    expect(l.marks).toEqual(['festival', 'sea raid']);
    // (what the site is, and what a pack thing on it is, are no marks)
    expect(siteLook('pit', ['workshop', 'ore', 'standing', 'mine', 'crewed'], ['mine']).marks).toEqual([]);
  });
  it('the town\'s signs', () => {
    expect(signsOf(['ashfall', 'deadrise', 'sheltered'])).toEqual(['ashfall', 'deadrise']);
  });
  it('a far place: kind, status, holder, and its words', () => {
    expect(farLook(['town', 'far-town', 'vassal', 'standing', 'yours'], [], [])).toMatchObject({ kind: 'town', status: 'vassal', yours: true, holder: null });
    expect(farLook(['town', 'far-town', 'standing'], ['flooded'], []).status).toBe('drowned');
    expect(farLook(['town', 'far-town', 'standing'], ['melted'], []).status).toBe('lava');
    expect(farLook(['town', 'far-town', 'occupied', 'ruined', 'frontier-league'], [], ['frontier-league'])).toMatchObject({ status: 'occupied', holder: 'frontier-league' });
    expect(farLook(['poi', 'camp', 'cleared', 'raiders'], [], [])).toMatchObject({ kind: 'camp', status: 'cleared', holder: 'raiders', marks: [] });
    expect(farLook(['town', 'far-town', 'standing', 'plague-town'], [], []).marks).toEqual(['plague town']);
  });
});

describe('the board reads a run', () => {
  it('places every offer, and accounts for every piece', () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 8, works: true });
    for (let s = 0; s < 4; s++) {
      const b = readBoard(t, []);
      expect(b.offers.length).toBe(t.cards().length);
      for (const o of b.offers) if ('site' in o.at) expect(SITES.some((x) => x.key === (o.at as { site: string }).site)).toBe(true);
      expect(b.pieces.length).toBe(t.pieces().length);
      expect(b.crews.all + b.soldiers.all).toBe(t.pieces().length);
      // (a posted piece stands at its thing's site)
      for (const p of b.pieces.filter((x) => x.where === 'posted')) expect(p.site).not.toBeNull();
      for (const c of t.cards().sort((a, b2) => Number(b2.threat) - Number(a.threat))) if (!Object.keys(c.short).length) t.take(c.id);
      const crewRoom = b.works.find((w) => w.slots.some((x) => x.kind === 'crew' && x.posted < x.n));
      if (crewRoom) t.post('crew', crewRoom.id);
      t.endSeason();
    }
    const b = readBoard(t, []);
    // (a project under way stands at its site with its progress)
    for (const sv of Object.values(b.sites)) if (sv.raising) expect(sv.raising.done).toBeGreaterThanOrEqual(0);
  });
});
