// (loop round 10, LS-94) The arena pack's two spell cards: the hedge witch comes only while the pit stands (its `pit`
// tag on the dam), and taking her card unlocks the ability, which the pack's bouts list; the abilities' reach is in the
// mechanics the 3D game casts with (packMech).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { packMech } from '../../src/packs/load';
import { loadRunPacks } from '../../src/season/run-packs';
import { grant } from '../../src/season/ledger';
import { Table } from '../../src/table/game';

const ARENA = JSON.parse(fs.readFileSync('packs/arena.json', 'utf8')) as Pack;

describe('the arena\'s spell cards', () => {
  it('load with no error; Red mist turns, the Veil hides', () => {
    const got = loadRunPacks([ARENA]);
    expect(got.report).toEqual([]);
    expect(packMech(got.packs)['arena-red-mist']).toEqual({ berserk: 8 });
    expect(packMech(got.packs)['arena-veil']).toEqual({ hides: 6 });
  });

  it('the witch comes once the pit is dug, never before', () => {
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 12, packs: [ARENA] });
    const before = new Set<string>();
    const after = new Set<string>();
    let dug = false;
    while (!t.over) {
      t.realm.ledger = grant(t.realm.ledger, { materials: 6, labor: 1 });
      for (const c of t.cards()) (dug ? after : before).add(c.template);
      const pit = t.cards().find((c) => c.template === 'arena-dig-the-pit');
      if (pit && t.take(pit.id)) dug = true;
      t.endSeason();
    }
    expect(dug).toBe(true);
    expect([...before].some((x) => x.startsWith('arena-red-mist') || x.startsWith('arena-veil'))).toBe(false);
    expect([...after].some((x) => x === 'arena-red-mist-card' || x === 'arena-veil-card')).toBe(true);
  });
});
