// (trackA-forces) The season's soldiers and raiders: the raid schedule, the fight settled into the pools, the adapter's
// calls and events over a fake Units with Track B's place orders, the squads posted, and the player's lines linted.
import { describe, expect, it } from 'vitest';
import { START_INCOME, START_POOLS } from '../../src/season/catalog';
import { grant, lose, newLedger, pools, total } from '../../src/season/ledger';
import { TownForces, unitsRef } from '../../src/season/forces';
import { MAX_SQUADS, raidPlaces, SeasonWar, settle, SQUAD, waveIn, waveSize } from '../../src/season/war';
import { fightLine, FORCES_FULL, NO_SOLDIERS, SOLDIERS_NO_PLACE, soldiersLine, WAVE_NO_ROAD, waveNowLine, waveSoonLine } from '../../src/season/words';
import { PLACE, type PlaceRef } from '../../src/api/contracts/townplaces';
import type { OrderFailure, PlaceOrder, PlaceRef as UPlaceRef, UnitId, Units, UnitView } from '../../src/api/contracts/units';
import { lint } from '../support/writing';

const start = () => newLedger(START_POOLS, START_INCOME);

type Status = OrderFailure | 'ok';

/**
 * Units with Track B's place orders on the CPU: each named place's status (default 'none'); a chain resolves to its
 * first choice valid with its partner, else fails with the last's status — told at update(), as the GPU's events are.
 * A spawn's failure removes its units. `fields`: how many distinct places may be ordered at once (pool-full past it).
 */
class FakeUnits {
  views = new Map<UnitId, UnitView>();
  readonly died: ((u: UnitView, by: UnitId | string | null) => void)[] = [];
  readonly hurt: ((u: UnitView, d: number, by: UnitId | string | null) => void)[] = [];
  readonly arrived: ((g: number) => void)[] = [];
  readonly orderFailed: ((g: number, why: OrderFailure) => void)[] = [];
  groups = new Map<number, { members: UnitId[]; at: number | null; order: PlaceOrder | null }>();
  spawns: { kind: string; at: UPlaceRef; n: number; g: number }[] = [];
  private queue: [number, OrderFailure, boolean][] = [];
  private n = 1;
  private ng = 100;
  constructor(public status: Record<number, Status>, public fields = 7) {}
  private resolve(r: UPlaceRef): { at: number | null; why: OrderFailure } {
    let why: OrderFailure = 'none';
    for (let q: UPlaceRef | undefined = r; q; q = q.else) {
      if (!('place' in q)) throw new Error('fake: named places only');
      const a = this.status[q.place] ?? 'none';
      const b = q.also && 'place' in q.also ? (this.status[q.also.place] ?? 'none') : 'ok';
      if (a === 'ok' && b === 'ok') return { at: q.place, why: 'none' };
      why = a !== 'ok' ? a : (b as OrderFailure);
    }
    return { at: null, why };
  }
  spawnAt(kind: string, faction: string | null, at: UPlaceRef, n: number): number {
    const g = this.ng++;
    const { at: p, why } = this.resolve(at);
    const members: UnitId[] = [];
    for (let i = 0; i < n; i++) {
      const id = this.n++;
      this.views.set(id, { id, kind, role: kind, faction, at: null, heading: 0, health: 3, maxHealth: 3, hostile: kind === 'raider', alive: true, job: { kind: 'idle' }, state: 'idle', colour: '#fff' });
      members.push(id);
    }
    this.groups.set(g, { members, at: p, order: null });
    this.spawns.push({ kind, at, n, g });
    if (p === null) this.queue.push([g, why, true]);
    return g;
  }
  orderGroup(g: number, o: PlaceOrder): void {
    const gr = this.groups.get(g);
    if (!gr) return;
    const key = (x: PlaceOrder | null) => JSON.stringify(x?.at);
    const keys = new Set([...this.groups.entries()].filter(([k, x]) => k !== g && x.order && this.members(k).length).map(([, x]) => key(x.order)));
    if (!keys.has(key(o)) && keys.size >= this.fields) {
      this.queue.push([g, 'pool-full', false]);
      return;
    }
    gr.order = o;
    const { at: p, why } = this.resolve(o.at);
    if (p === null) this.queue.push([g, why, false]);
    else gr.at = p;
  }
  members(g: number): UnitId[] {
    return (this.groups.get(g)?.members ?? []).filter((u) => this.views.get(u)?.alive);
  }
  get(id: UnitId) {
    return this.views.get(id) ?? null;
  }
  remove(id: UnitId) {
    this.views.delete(id);
  }
  kill(id: UnitId, by: UnitId | string | null = null) {
    const v = this.views.get(id)!;
    v.alive = false;
    for (const f of this.died) f(v, by);
  }
  update() {
    for (const [g, why, spawn] of this.queue.splice(0)) {
      if (spawn) for (const u of this.groups.get(g)!.members) this.views.delete(u);
      for (const f of this.orderFailed) f(g, why);
    }
  }
  arrive(g: number) {
    for (const f of this.arrived) f(g);
  }
  /** the place each living unit's group stands at or goes to now */
  placeOf(u: UnitId): number | null {
    for (const x of this.groups.values()) if (x.members.includes(u)) return x.at;
    return null;
  }
}

/** a TownForces over FakeUnits with the given place statuses */
function forces(status: Record<number, Status>, fields = 7) {
  const units = new FakeUnits(status, fields);
  const f = new TownForces(units as unknown as Units);
  const tick = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      units.update();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { f, units, tick };
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

describe('TownForces (the adapter on Track B place orders)', () => {
  it('turns a townplaces ref into the Units contract shape: also a ref of the same town, else kept', () => {
    expect(unitsRef({ town: 2, place: PLACE.spawn0 + 1, also: PLACE.gate0 + 1, else: { town: 2, place: PLACE.keep } })).toEqual({ town: 2, place: PLACE.spawn0 + 1, also: { town: 2, place: PLACE.gate0 + 1 }, else: { town: 2, place: PLACE.keep } });
    expect(unitsRef({ town: 1, district: 3, kind: 2, rank: 0 })).toEqual({ town: 1, district: 3, kind: 2, rank: 0 });
  });

  it('spawns and orders through spawnAt / orderGroup, and passes arrived on once an order', async () => {
    const { f, units, tick } = forces({ [PLACE.muster]: 'ok', [PLACE.gate0]: 'ok' });
    const arrived: number[] = [];
    f.arrived.push((g) => arrived.push(g));
    const g = f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.barracks, else: { town: 0, place: PLACE.muster } }, 3);
    expect(f.report(g)).toMatchObject({ size: 3, alive: 3, arrived: false, failed: null });
    expect(units.spawns[0]).toMatchObject({ kind: 'guard', n: 3 });
    f.orderGroup(g, { kind: 'guard', at: { town: 0, place: PLACE.gate0 } });
    await tick();
    const ug = units.spawns[0].g;
    expect(units.groups.get(ug)!.order).toEqual({ kind: 'guard', at: { town: 0, place: PLACE.gate0 } });
    units.arrive(ug);
    units.arrive(ug);
    expect(arrived).toEqual([g]);
    expect(f.report(g)!.arrived).toBe(true);
    // (a new order: arrived again once)
    f.orderGroup(g, { kind: 'go', at: { town: 0, place: PLACE.muster } });
    units.arrive(ug);
    expect(arrived).toEqual([g, g]);
  });

  it('fails a spawn whose chain has no valid choice, naming the last status: none made', async () => {
    const { f, tick } = forces({ [PLACE.gate0]: 'rising' });
    const failed: string[] = [];
    f.orderFailed.push((_, why) => failed.push(why));
    const g = f.spawnAt('raider', 'f-raiders', { town: 0, place: PLACE.gate0 }, 2);
    await tick();
    expect(failed).toEqual(['rising']);
    expect(f.report(g)).toMatchObject({ size: 0, alive: 0, failed: 'rising' });
  });

  it('counts deaths from the died events, `by` passed on', () => {
    const { f, units } = forces({ [PLACE.muster]: 'ok' });
    const by: unknown[] = [];
    f.died.push((g, _u, b) => by.push([g, b]));
    const g = f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.muster }, 3);
    units.kill(units.members(units.spawns[0].g)[0], 77);
    expect(by).toEqual([[g, 77]]);
    expect(f.report(g)).toMatchObject({ size: 3, alive: 2, dead: 1 });
  });

  it('a full pool is told as pool-full, never dropped: past the fields, and past Track B order groups', async () => {
    const { f, tick } = forces({ [PLACE.gate0]: 'ok', [PLACE.gate0 + 1]: 'ok', [PLACE.muster]: 'ok' }, 1);
    const failed: [number, string][] = [];
    f.orderFailed.push((g, why) => failed.push([g, why]));
    const a = f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.muster }, 1);
    const b = f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.muster }, 1);
    f.orderGroup(a, { kind: 'guard', at: { town: 0, place: PLACE.gate0 } });
    f.orderGroup(b, { kind: 'guard', at: { town: 0, place: PLACE.gate0 + 1 } });
    await tick();
    expect(failed).toEqual([[b, 'pool-full']]);
    const many = forces({ [PLACE.muster]: 'ok' });
    const told: string[] = [];
    many.f.orderFailed.push((_, why) => told.push(why));
    const gs = Array.from({ length: TownForces.GROUP_ROOM + 1 }, () => many.f.spawnAt('soldier', 'f-town', { town: 0, place: PLACE.muster }, 1));
    await many.tick();
    expect(many.units.spawns.length).toBe(TownForces.GROUP_ROOM);
    expect(told).toEqual(['pool-full']);
    expect(many.f.report(gs.at(-1)!)).toMatchObject({ size: 0, failed: 'pool-full' });
  });

  it('a raid comes along an arterial whose spawn point and gate both stand (Muru: gate 0 over water, gate 2 up)', async () => {
    const { f, units, tick } = forces({ [PLACE.spawn0]: 'ok', [PLACE.spawn0 + 1]: 'ok', [PLACE.spawn0 + 2]: 'ok', [PLACE.gate0]: 'water', [PLACE.gate0 + 2]: 'ok', [PLACE.stores]: 'ok' });
    const { from, to } = raidPlaces(0, 0);
    const g = f.spawnAt('raider', 'f-raiders', from, 1);
    const u = units.members(units.spawns[0].g)[0];
    expect(units.placeOf(u)).toBe(PLACE.spawn0 + 2);
    f.orderGroup(g, { kind: 'attack', at: to });
    await tick();
    expect(units.placeOf(u)).toBe(PLACE.gate0 + 2);
    expect(units.groups.get(units.spawns[0].g)!.order!.kind).toBe('attack');
  });
});

describe('SeasonWar (squads and raids through the adapter)', () => {
  it('raises a squad a free Might at the yard, posts them at the gates after the walls, raids on schedule and settles', async () => {
    const { f, units, tick } = forces({ [PLACE.muster]: 'ok', [PLACE.gate0]: 'ok', [PLACE.gate0 + 1]: 'ok', [PLACE.spawn0]: 'ok', [PLACE.keep]: 'ok' });
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
    // (spawn point 0 and gate 0 stand: from the one, attacking the other)
    expect(units.placeOf(raiders[0].id)).toBe(PLACE.gate0);
    // (two soldiers and all but one raider fall)
    const guards = [...units.views.values()].filter((v) => v.kind === 'guard');
    units.kill(guards[0].id, raiders[0].id);
    units.kill(guards[1].id, raiders[0].id);
    for (const r of raiders.slice(1)) units.kill(r.id, guards[2].id);
    const s = war.resolve(l)!;
    expect(s.line).toBe(fightLine({ raiders: 4, left: 1, fallen: 2, might: 1, materials: 1, unrest: 1 }));
    expect(total(s.ledger, 'might')).toBe(total(l, 'might') - 1);
    expect(units.views.has(raiders[0].id)).toBe(false);
  });

  it('searches the gates and arterials a window of three at a time (chains of 3: the next window on orderFailed)', async () => {
    const { f, units, tick } = forces({ [PLACE.muster]: 'ok', [PLACE.gate0 + 7]: 'ok', [PLACE.spawn0 + 7]: 'ok' });
    const l = { ...grant(start(), { might: 1 }), season: 4, built: ['walls'] };
    const war = new SeasonWar({ forces: () => f, town: () => 0, firstWave: 4, ledger: () => l });
    war.season(l);
    await tick(8);
    const guards = [...units.views.values()].filter((v) => v.kind === 'guard');
    expect(guards.length).toBe(SQUAD * 2);
    // (every squad's order: gate 7, found in its third or fourth window)
    for (const v of guards) expect(units.placeOf(v.id)).toBe(PLACE.gate0 + 7);
    const raiders = [...units.views.values()].filter((v) => v.kind === 'raider');
    expect(raiders.length).toBe(waveSize(0));
    // (spawned at spawn point 7 — the earlier windows' spawns failed and made none — attacking gate 7)
    expect(units.spawns.filter((s) => s.kind === 'raider').length).toBe(3);
    expect(units.placeOf(raiders[0].id)).toBe(PLACE.gate0 + 7);
    expect(war.lines[0]).toBe(soldiersLine(SQUAD * 2, 'gates'));
  });

  it('caps the squads at MAX_SQUADS, and a chain past three choices throws', async () => {
    const { f, units, tick } = forces({ [PLACE.muster]: 'ok' });
    const l = grant(start(), { might: 10 });
    const war = new SeasonWar({ forces: () => f, town: () => 0, firstWave: 0, ledger: () => l });
    war.season(l);
    await tick();
    expect(units.views.size).toBe(SQUAD * MAX_SQUADS);
    const deep: PlaceRef = { town: 0, place: 0, else: { town: 0, place: 1, else: { town: 0, place: 2, else: { town: 0, place: 3 } } } };
    expect(() => f.spawnAt('soldier', 'f-town', deep, 1)).toThrow(/at most 3/);
  });

  it('with no yard and no barracks, says so', async () => {
    const { f, tick } = forces({});
    const l = start();
    const war = new SeasonWar({ forces: () => f, town: () => 0, firstWave: 0, ledger: () => l });
    war.season(l);
    await tick();
    expect(war.lines).toEqual([SOLDIERS_NO_PLACE]);
  });

  it('a full field pool shows on the sheet', async () => {
    const { f, tick } = forces({ [PLACE.muster]: 'ok', [PLACE.gate0]: 'ok', [PLACE.gate0 + 1]: 'ok', [PLACE.gate0 + 2]: 'ok' }, 1);
    const l = { ...grant(start(), { might: 1 }), built: ['walls'] };
    const war = new SeasonWar({ forces: () => f, town: () => 0, firstWave: 0, ledger: () => l });
    war.season(l);
    await tick();
    expect(war.lines).toContain(FORCES_FULL);
  });

  it('every line the player reads passes the writing lint', () => {
    const lines = [SOLDIERS_NO_PLACE, NO_SOLDIERS, WAVE_NO_ROAD, FORCES_FULL, soldiersLine(1, 'yard'), soldiersLine(6, 'gates'), soldiersLine(3, 'barracks'), waveSoonLine(4), waveNowLine(6, 4, 'coming'), waveNowLine(6, 2, 'there'), waveNowLine(6, 3, 'fighting'), waveNowLine(6, 0, 'fighting'), fightLine({ raiders: 6, left: 2, fallen: 4, might: 2, materials: 2, unrest: 1 }), fightLine({ raiders: 6, left: 0, fallen: 0, might: 0, materials: 0, unrest: 0 })];
    expect(lines.flatMap((t) => lint(t).map((p) => `${p} — ${t}`))).toEqual([]);
  });
});
