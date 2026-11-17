// (card-table, PACK_FORMAT draft 8) The owner: "it would be cool to have a meta progression from encountering or
// exploring to unlock new content for the next run." No new store: an unlock is a line in the world's record
// (`{ "unlock": "<content id>" }`), locked content (`"locked": true`) is never dealt or offered until a run of the world
// has unlocked it, and `met` reads what the record already knows. Three runs of one world with packs/frontier.json.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { hasMet, notYetFound } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { Table } from '../../src/table/game';

const FRONTIER = JSON.parse(fs.readFileSync('packs/frontier.json', 'utf8')) as Pack;

/** a run: each season the wanted cards are taken (rich enough to pay); returns every template seen on the board */
function play(t: Table, wanted: string[]): Set<string> {
  const seen = new Set<string>();
  while (!t.over) {
    t.realm.ledger = grant(t.realm.ledger, { materials: 6, intel: 3, might: 1 });
    for (const c of t.cards()) seen.add(c.template);
    for (const c of t.cards().filter((x) => wanted.includes(x.template))) t.take(c.id);
    t.endSeason();
  }
  return seen;
}

describe('unlocks: meeting and exploring open content for later runs', () => {
  it('run 1 meets the Reavers and finds ore; run 2 is dealt what that opened; run 3 is led by the corsair from their haven', () => {
    // ---- run 1 ----
    const t1 = new Table({ seed: 7, leader: 'ysolt', seasons: 12, packs: [FRONTIER] });
    expect(notYetFound(t1.realm.w, [FRONTIER]).map((x) => x.id).sort()).toEqual(['frontier-corsair', 'frontier-old-maps', 'frontier-reaver-pilot']);
    expect(t1.worldNow().some((l) => l.startsWith('Not yet found: ') && l.includes('Find out where the black sails come from.'))).toBe(true);
    expect(Table.leaders(undefined, [FRONTIER]).map((l) => l.id)).not.toContain('frontier-corsair');
    expect(hasMet(t1.realm.w, 'frontier-reavers')).toBe(false);
    const seen1 = new Set<string>();
    let unlockedAt = 0;
    while (!t1.over) {
      t1.realm.ledger = grant(t1.realm.ledger, { materials: 6, intel: 3 });
      // (the locked maps card is never on the board before the scouts bring a map)
      if (!t1.opened().length) expect(t1.cards().map((c) => c.template)).not.toContain('frontier-old-maps');
      for (const c of t1.cards()) seen1.add(c.template);
      for (const c of t1.cards().filter((x) => ['frontier-sea-lane', 'frontier-sails', 'frontier-scout-ore'].includes(x.template))) t1.take(c.id);
      t1.endSeason();
      if (!unlockedAt && t1.opened().length) unlockedAt = t1.season;
    }
    expect(unlockedAt).toBeGreaterThan(0);
    // (the end screen: what this run opened, and by which card)
    const later = t1.newForLater();
    expect(later).toEqual(expect.arrayContaining([
      'Captain Merrow as a leader, from "Strange sails off the point".',
      'The card "Hire a Reaver pilot", from "Strange sails off the point".',
      'The card "Copy the old survey maps", from "Send scouts over the ridge".',
    ]));
    expect(notYetFound(t1.realm.w, [FRONTIER])).toEqual([]);
    // (met: the record knows the Reavers now, a place found, and how the run ended)
    expect(hasMet(t1.realm.w, 'frontier-reavers')).toBe(true);
    expect(hasMet(t1.realm.w, 'place:frontier-redscar')).toBe(true);
    expect(hasMet(t1.realm.w, 'ending:stood')).toBe(true);

    // ---- run 2: what run 1 opened is dealt; "The world now" says what earlier runs opened ----
    const t2 = t1.next('dunstan');
    expect(t2.worldNow().some((l) => l.startsWith('Earlier runs opened: ') && l.includes('Copy the old survey maps'))).toBe(true);
    expect(t2.worldNow().some((l) => l.startsWith('Not yet found'))).toBe(false);
    expect(t2.newForLater()).toEqual([]);
    const seen2 = play(t2, ['frontier-old-maps', 'frontier-reaver-pilot']);
    expect(seen2.has('frontier-old-maps') || seen2.has('frontier-reaver-pilot')).toBe(true);

    // ---- run 3: the corsair, offered once unlocked, plays from the Reavers' haven ----
    const leaders = Table.leaders(t2.realm.snapshot(), [FRONTIER], t2.home).map((l) => l.id);
    expect(leaders).toContain('frontier-corsair');
    const t3 = t2.next('frontier-corsair');
    expect(t3.home).toBe('frontier-gullcove');
    expect(t3.worldNow()[0]).toMatch(/^Run 3 of this world\. Captain Merrow leads\./);
    expect(t3.opened().length).toBe(3);
  }, 240000);
});
