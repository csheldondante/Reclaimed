// (loop round 10, LS-93) A run's start, one copy for both front ends (season/run-packs.ts leaderChoices, startLines;
// season/realm-home.ts): the leader screen lists the base leaders, the packs' leaders the world fits — one who plays
// from a far town with that town, while one fits and the front end can play from it — and the locked ones with their
// hint (never pickable); what a town built is written on it and read back; the last run's home is the record's.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { builtOn, keepBuilt, lastHome, moveHome } from '../../src/season/realm-home';
import { leaderChoices } from '../../src/season/run-packs';
import { LEADERS } from '../../src/season/run-words';
import { HOME, Table } from '../../src/table/game';
import { worldOf } from '../../src/season/run-packs';

const FRONTIER = JSON.parse(fs.readFileSync('packs/frontier.json', 'utf8')) as Pack;

describe('a run\'s start, shared by the card table and the 3D loop', () => {
  it('lists the leaders the world offers, the locked ones with their hint, and a far town to play from', () => {
    // (a world after one short run: the player and the raiders are in it)
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 2, packs: [FRONTIER] });
    while (!t.over) t.endSeason();
    const w = t.realm.w;
    const first = leaderChoices(w, [FRONTIER], LEADERS, HOME);
    expect(first.filter((l) => l.locked === null).map((l) => l.id)).toEqual(['ysolt', 'dunstan', 'ilveth']);
    const corsair = first.find((l) => l.id === 'frontier-corsair')!;
    expect(corsair.locked).toBe('Find out where the black sails come from.');
    expect(corsair.home).toBeNull();
    // (a far town made yours: the steward is offered, to play from it — unless the front end cannot play from it)
    const far = t.realm.selectTowns('far:nearest:1')[0];
    w.facts.relate({ type: 'controls', from: 'player', to: far, cause: 'test' });
    const steward = leaderChoices(w, [FRONTIER], LEADERS, HOME).find((l) => l.id === 'frontier-steward')!;
    expect(steward.locked).toBeNull();
    expect(steward.home).not.toBeNull();
    expect(leaderChoices(w, [FRONTIER], LEADERS, HOME, () => false).some((l) => l.id === 'frontier-steward')).toBe(false);
    // (the table lists the open ones from the same function)
    expect(Table.leaders(w.ws.snapshot(), [FRONTIER]).map((l) => l.id)).toEqual(['ysolt', 'dunstan', 'ilveth', 'frontier-steward']);
  });

  it('a town\'s buildings are written on it at a run\'s end and read back; a move of home; the last home', () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 2 });
    while (!t.over) t.endSeason();
    expect(lastHome(t.realm.w)).toBe(HOME);
    keepBuilt(t.realm.w, HOME, ['quarry', 'walls']);
    expect(builtOn(t.realm.w, HOME).sort()).toEqual(['quarry', 'walls']);
    const far = t.realm.selectTowns('far:all')[0];
    const moved = moveHome(t.realm.snapshot(), HOME, far);
    expect(moved.built).toEqual([]);
    const w2 = worldOf(moved.world);
    expect(w2.facts.events({ kind: 'home-moved' }).length).toBe(1);
    expect(builtOn(w2, HOME).sort()).toEqual(['quarry', 'walls']);
  });
});
