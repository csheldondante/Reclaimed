// (loop round 12, docs/design/FRONTS.md) A front and a shield on the model side: the ages pack's lava event becomes a
// front (lava poured uphill of the shrine's town, its points reached read as `reached`), the Fire ward is a shield in
// the mechanics the 3D game casts with, the validator knows both words, and at the card table the eruption the
// wizards' first working starts is answered by the ward (no street lost) or not (every street lost).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPack, type Pack } from '../../src/packs/check';
import { liveDef, packMech } from '../../src/packs/load';
import { checkLive, idleState, liveRead, liveTier, mechState } from '../../src/living/live';
import { loadRunPacks } from '../../src/season/run-packs';
import { grant } from '../../src/season/ledger';
import { Table } from '../../src/table/game';

const AGES = JSON.parse(fs.readFileSync('packs/ages.json', 'utf8')) as Pack;
const errs = (p: Pack) => checkPack(p).filter((x) => x.level === 'error').map((x) => x.text);
const EVENT = AGES.events!.find((e) => e.id === 'ages-lava-front')!;

describe('a front and a shield', () => {
  it('the ages pack loads: its lava event is a front, the Fire ward a shield', () => {
    const got = loadRunPacks([AGES]);
    expect(got.report).toEqual([]);
    // (loop round 14: the ward's store and recharge; the vent far up the slope)
    expect(packMech(got.packs)['ages-ward']).toEqual({ shield: 26, seconds: 75, energy: 300, regen: 5 });
    const def = liveDef(EVENT);
    expect(def.hazard).toEqual({ kind: 'front', liquid: 'lava', at: { site: 'here' }, far: 160, rate: 200, pour: 60, points: 8, spread: 26, mutate: 'melted' });
    expect(checkLive('ages-lava-front', def)).toEqual([]);
    expect(def.result).toEqual([{ as: 'reached', read: 'reached' }]);
  });

  it('nobody there: the front reaches every point; a ward cast: none', () => {
    const def = liveDef(EVENT);
    const idle = idleState(def, {});
    expect(liveRead(def, idle).reached).toBe(8);
    expect(liveTier(def, liveRead(def, idle))).toBe('failure');
    const mech = { 'ages-ward': { shield: 26, seconds: 75 } };
    const warded = mechState(def, {}, { 'ages-ward': 1 }, mech);
    expect(liveRead(def, warded).reached).toBe(0);
    expect(liveTier(def, liveRead(def, warded))).toBe('success');
    // (a shield in a fight does nothing to it)
    const fight = { ...def, hazard: undefined };
    expect(mechState(fight, {}, { 'ages-ward': 1 }, mech).burned).toBe(0);
  });

  it('the validator: hazards lava and flood, "reached" with them only, a shield word alone', () => {
    const bad = (f: (p: Pack) => void) => {
      const p = JSON.parse(JSON.stringify(AGES)) as Pack;
      f(p);
      return errs(p).join(' | ');
    };
    expect(errs(AGES)).toEqual([]);
    expect(bad((p) => (p.events![p.events!.length - 1].hazard!.kind = 'magma'))).toMatch(/The hazard "magma" is not supported yet\. The hazards are fire, lava, flood\./);
    expect(bad((p) => (p.events![p.events!.length - 1].hazard!.far = 10))).toMatch(/must lie past its points/);
    expect(bad((p) => (p.events![p.events!.length - 1].hazard!.kind = 'fire'))).toMatch(/The amount "reached" needs a "hazard" of kind "lava" or "flood"\./);
    expect(bad((p) => (p.abilities![0].in_event = { kinds: ['eruption'], shield: 26, kills: 1 }))).toMatch(/exactly one of/);
    expect(bad((p) => (p.abilities![0].in_event = { kinds: ['eruption'], kills: 1, seconds: 30 }))).toMatch(/"seconds" goes with "shield" only/);
    // (a flood front is the same words with water)
    const flood = liveDef({ ...EVENT, hazard: { ...EVENT.hazard!, kind: 'flood' } });
    expect(flood.hazard).toMatchObject({ kind: 'front', liquid: 'water', mutate: 'flooded' });
  });

  it('at the table: the wizards\' first working starts the eruption; the ward keeps every street', () => {
    const outcome = (ward: boolean): { seen: string[]; now: string[] } => {
      const t1 = new Table({ seed: 7, leader: 'dunstan', seasons: 16, packs: [AGES] });
      while (!t1.over) {
        t1.realm.ledger = grant(t1.realm.ledger, { materials: 10, intel: 3, magic: 2 });
        for (const c of t1.cards().filter((x) => ['ages-peace', 'ages-crown', 'relieve-neighbour'].includes(x.template))) t1.take(c.id);
        t1.endSeason();
      }
      const t2 = t1.next('ilveth');
      const seen: string[] = [];
      while (!t2.over) {
        t2.realm.ledger = grant(t2.realm.ledger, { materials: 10, intel: 3, magic: 2 });
        // (a pack ability is the player's for the run that learned it: the ward is learned in this run, the court standing)
        for (const c of t2.cards().filter((x) => x.template === 'ages-invite-wizards' || (ward && x.template === 'ages-ward-lesson'))) t2.take(c.id);
        for (const e of t2.liveEvents().filter((x) => x.template === 'ages-mountain-stirs')) {
          if (ward) expect(t2.cast('ages-ward', e.id)).toBe(true);
          seen.push(t2.liveEvents().find((x) => x.id === e.id)!.tier);
          t2.resolveNow(e.id);
        }
        t2.endSeason();
      }
      // (the next run's start tells what the front left on the town)
      return { seen, now: t2.next('ysolt').worldNow() };
    };
    const warded = outcome(true);
    expect(warded.seen).toEqual(['success']);
    expect(warded.now).toContain('Run 2: lava came down on the town. A shield kept it out of the town.');
    const open = outcome(false);
    expect(open.seen).toEqual(['failure']);
    expect(open.now).toContain('Run 2: lava came down on the town. It took 8 of its streets. Black rock lies where it ran.');
  }, 30000);
});
