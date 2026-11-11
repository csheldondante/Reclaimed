// (trackA-forces) The season's soldiers and raiders: the raid schedule, the fight settled into the pools, the adapter's
// place chain and emulated events over a fake Units, the squads posted, and the player's lines linted.
import { describe, expect, it } from 'vitest';
import { START_INCOME, START_POOLS } from '../../src/season/catalog';
import { grant, lose, newLedger, pools, total } from '../../src/season/ledger';
import { decodeNamed, TownForces } from '../../src/season/forces';
import { raidPlaces, SeasonWar, settle, SQUAD, waveIn, waveSize } from '../../src/season/war';
import { fightLine, NO_SOLDIERS, SOLDIERS_NO_PLACE, soldiersLine, WAVE_NO_ROAD, waveNowLine, waveSoonLine } from '../../src/season/words';
import { NAMED_PLACES, PLACE, PLACE_STATUS } from '../../src/api/contracts/townplaces';
import type { UnitId, UnitJob, Units, UnitView, V2 } from '../../src/api/contracts/units';
import { lint } from '../support/writing';

const start = () => newLedger(START_POOLS, START_INCOME);

/** a place table slot: live, offset (10, 20), every named place `none` unless given (status, x, y) */
function table(given: Record<number, [number, number, number]>): Uint32Array {
  const u = new Uint32Array(16 + NAMED_PLACES * 8);
  const f = new Float32Array(u.buffer);
  u[0] = 1;
  f[4] = 10;
  f[5] = 20;
  for (let p = 0; p < NAMED_PLACES; p++) {
    const g = given[p];
    u[16 + p * 8 + 3] = g ? g[0] : PLACE_STATUS.none;
    if (g) [f[16 + p * 8], f[16 + p * 8 + 1]] = [g[1], g[2]];
  }
  return u;
}

/** Units on the CPU: spawn, order, states the test sets, deaths it calls */
class FakeUnits {
  views = new Map<UnitId, UnitView>();
  orders: { who: UnitId[]; job: UnitJob }[] = [];
  readonly died: ((u: UnitView, by: UnitId | string | null) => void)[] = [];
  readonly hurt: ((u: UnitView, d: number, by: UnitId | string | null) => void)[] = [];
  private n = 1;
  spawn(kind: string, at: V2, faction: string | null, o: { hostile?: boolean; job?: UnitJob } = {}): UnitId {
    const id = this.n++;
    this.views.set(id, { id, kind, role: kind, faction, at: [at[0], at[1], 0], heading: 0, health: 3, maxHealth: 3, hostile: !!o.hostile, alive: true, job: o.job ?? { kind: 'idle' }, state: 'idle', colour: '#fff' });
    return id;
  }
  get(id: UnitId) {
    return this.views.get(id) ?? null;
  }
  order(who: UnitId | UnitId[], job: UnitJob) {
    this.orders.push({ who: ([] as UnitId[]).concat(who), job });
  }
  setHostile(id: UnitId, h: boolean) {
    this.views.get(id)!.hostile = h;
  }
  remove(id: UnitId) {
    this.views.delete(id);
  }
  kill(id: UnitId) {
    const v = this.views.get(id)!;
    v.alive = false;
    for (const f of this.died) f(v, null);
  }
}

/** a TownForces over FakeUnits whose read is the given table */
function forces(t: Uint32Array) {
  const units = new FakeUnits();
  const f = new TownForces(units as unknown as Units, () => null);
  let reads = 0;
  (f as unknown as { read: () => Promise<unknown> }).read = async () => (reads++, decodeNamed(t));
  const tick = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      f.update();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { f, units, tick, reads: () => reads };
}

describe('raids and losses (season/war.ts)', () => {
  it('raids come from FIRST_WAVE every WAVE_EVERY seasons, and grow', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((s) => waveIn(s))).toEqual([null, null, null, 0, null, null, 1, 2]);
    expect(waveIn(1, 1)).toBe(0);
    expect(waveIn(9, 0)).toBe(null);
    expect([0, 1, 2].map(waveSize)).toEqual([4, 6, 8]);
  });

  it('the fight settles: Might a squad fallen (rounded up), raiders left take Materials and stir Unrest', () => {
    const l = grant(start(), { might: 2 });
    const { ledger, lost } = settle(l, { raiders: 6, left: 2, fallen: 4 });
    expect(lost).toEqual({ might: 2, materials: 2, unrest: 1 });
    expect(total(ledger, 'might')).toBe(total(l, 'might') - 2);
    expect(pools(ledger).materials).toBe(pools(l).materials - 2);
    expect(pools(ledger).unrest).toBe(1);
    const won = settle(l, { raiders: 6, left: 0, fallen: 0 });
    expect(won.lost).toEqual({ might: 0, materials: 0, unrest: 0 });
  });

  it('lose takes free soldiers before ones tied up, and never below nothing', () => {
    const l = lose(grant(start(), { might: 1 }), { might: 5, materials: 99 });
    expect(total(l, 'might')).toBe(0);
    expect(pools(l).materials).toBe(0);
  });
});

describe('TownForces (the adapter, interim read)', () => {
  it('decodes the named places into the window (the slot offset added)', () => {
    const named = decodeNamed(table({ [PLACE.muster]: [PLACE_STATUS.ok, 1, 2] }));
    expect(named[PLACE.muster]).toEqual({ status: PLACE_STATUS.ok, at: [11, 22] });
    expect(named[PLACE.keep].status).toBe(PLACE_STATUS.none);
  });

  it('spawns at the first valid place of a chain, orders, and tells arrival from the states', async () => {
    const { f, units, tick, reads } = forces(table({ [PLACE.muster]: [PLACE_STATUS.ok, 1, 2], [PLACE.gate0]: [PLACE_STATUS.ok, 5, 5] }));
    const arrived: number[] = [];
    f.arrived.push((g) => arrived.push(g));
    const g = f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.barracks, else: { town: 0, place: PLACE.muster } }, 3);
    f.orderGroup(g, { kind: 'guard', at: { town: 0, place: PLACE.gate0 } });
    await tick();
    expect(f.report(g)).toMatchObject({ size: 3, alive: 3, arrived: false, failed: null });
    expect(reads()).toBe(1);
    expect(units.orders.at(-1)!.job).toEqual({ kind: 'guard', at: [15, 25], radius: 5 });
    for (const v of units.views.values()) v.state = 'walk';
    await tick(1);
    for (const v of units.views.values()) v.state = 'idle';
    await tick(1);
    expect(arrived).toEqual([g]);
    await tick(1);
    expect(arrived).toEqual([g]);
  });

  it('fails an order whose last choice is not valid, naming its status', async () => {
    const { f, tick } = forces(table({ [PLACE.gate0]: [PLACE_STATUS.rising, 5, 5] }));
    const failed: string[] = [];
    f.orderFailed.push((_, why) => failed.push(why));
    const g = f.spawnAt('raider', 'f-raiders', { town: 0, place: PLACE.gate0 }, 2);
    await tick();
    expect(failed).toEqual(['rising']);
    expect(f.report(g)!.size).toBe(0);
  });

  it('an attack makes the group hostile and sends it to the place', async () => {
    const { f, units, tick } = forces(table({ [PLACE.spawn0]: [PLACE_STATUS.ok, 0, 0], [PLACE.keep]: [PLACE_STATUS.ok, 3, 3] }));
    const g = f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.spawn0 }, 2);
    f.orderGroup(g, { kind: 'attack', at: { town: 0, place: PLACE.gate0, else: { town: 0, place: PLACE.keep } } });
    await tick();
    expect([...units.views.values()].every((v) => v.hostile)).toBe(true);
    expect(units.orders.at(-1)!.job).toEqual({ kind: 'go', to: [13, 23] });
  });

  it('a raid comes along an arterial whose spawn point and gate both stand (Muru: gate 0 over water, gate 2 up)', async () => {
    const t = table({ [PLACE.spawn0]: [PLACE_STATUS.ok, 0, 0], [PLACE.spawn0 + 1]: [PLACE_STATUS.ok, 1, 0], [PLACE.spawn0 + 2]: [PLACE_STATUS.ok, 2, 0], [PLACE.gate0]: [PLACE_STATUS.water, 9, 9], [PLACE.gate0 + 2]: [PLACE_STATUS.ok, 7, 7], [PLACE.stores]: [PLACE_STATUS.ok, 4, 4] });
    const { f, units, tick } = forces(t);
    const { from, to } = raidPlaces(0, 0);
    const g = f.spawnAt('raider', 'f-raiders', from, 1);
    f.orderGroup(g, { kind: 'attack', at: to });
    await tick();
    expect([...units.views.values()][0].at!.slice(0, 2)).toEqual([12, 20]);
    expect(units.orders.at(-1)!.job).toEqual({ kind: 'go', to: [17, 27] });
    // (no gate standing: from its own spawn point to the stores)
    const none = forces(table({ [PLACE.spawn0 + 1]: [PLACE_STATUS.ok, 1, 0], [PLACE.stores]: [PLACE_STATUS.ok, 4, 4] }));
    const p = raidPlaces(0, 1);
    const g2 = none.f.spawnAt('raider', 'f-raiders', p.from, 1);
    none.f.orderGroup(g2, { kind: 'attack', at: p.to });
    await none.tick();
    expect([...none.units.views.values()][0].at!.slice(0, 2)).toEqual([11, 20]);
    expect(none.units.orders.at(-1)!.job).toEqual({ kind: 'go', to: [14, 24] });
  });
});

describe('SeasonWar (squads and raids through the adapter)', () => {
  it('raises a squad a free Might at the yard, posts them at the gates after the walls, raids on schedule and settles', async () => {
    const t = table({ [PLACE.muster]: [PLACE_STATUS.ok, 1, 1], [PLACE.gate0]: [PLACE_STATUS.ok, 5, 5], [PLACE.gate0 + 1]: [PLACE_STATUS.ok, 6, 6], [PLACE.spawn0]: [PLACE_STATUS.ok, 30, 30], [PLACE.keep]: [PLACE_STATUS.ok, 2, 2] });
    const { f, units, tick } = forces(t);
    let l = grant(start(), { might: 1 });
    const war = new SeasonWar({ forces: () => f, town: () => 0, firstWave: 2, ledger: () => l });
    war.season(l);
    await tick();
    expect([...units.views.values()].filter((v) => v.kind === 'guard').length).toBe(SQUAD * pools(l).might);
    expect(war.lines[0]).toBe(soldiersLine(SQUAD * 2, 'yard'));
    expect(war.lines).toContain(waveSoonLine(waveSize(0)));
    // (season 2: the walls built, a raid)
    l = { ...l, season: 2, built: ['walls'] };
    war.season(l);
    await tick();
    expect(war.lines[0]).toBe(soldiersLine(SQUAD * 2, 'gates'));
    const raiders = [...units.views.values()].filter((v) => v.kind === 'raider');
    expect(raiders.length).toBe(waveSize(0));
    expect(units.orders.at(-1)!.job).toEqual({ kind: 'go', to: [15, 25] });
    // (two soldiers and all but one raider fall)
    const guards = [...units.views.values()].filter((v) => v.kind === 'guard');
    units.kill(guards[0].id);
    units.kill(guards[1].id);
    for (const r of raiders.slice(1)) units.kill(r.id);
    const s = war.resolve(l)!;
    expect(s.line).toBe(fightLine({ raiders: 4, left: 1, fallen: 2, might: 1, materials: 1, unrest: 1 }));
    expect(total(s.ledger, 'might')).toBe(total(l, 'might') - 1);
    expect(units.views.has(raiders[0].id)).toBe(false);
  });

  it('with no yard and no barracks, says so', async () => {
    const { f, tick } = forces(table({}));
    const l = start();
    const war = new SeasonWar({ forces: () => f, town: () => 0, firstWave: 0, ledger: () => l });
    war.season(l);
    await tick();
    expect(war.lines).toEqual([SOLDIERS_NO_PLACE]);
  });

  it('every line the player reads passes the writing lint', () => {
    const lines = [SOLDIERS_NO_PLACE, NO_SOLDIERS, WAVE_NO_ROAD, soldiersLine(1, 'yard'), soldiersLine(6, 'gates'), soldiersLine(3, 'barracks'), waveSoonLine(4), waveNowLine(6, 4, false), waveNowLine(6, 2, true), waveNowLine(6, 0, true), fightLine({ raiders: 6, left: 2, fallen: 4, might: 2, materials: 2, unrest: 1 }), fightLine({ raiders: 6, left: 0, fallen: 0, might: 0, materials: 0, unrest: 0 })];
    expect(lines.flatMap((t) => lint(t).map((p) => `${p} — ${t}`))).toEqual([]);
  });
});
