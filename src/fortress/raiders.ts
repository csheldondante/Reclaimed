// The attack wave on the fortress (round 128l, m4: fortress M5-lite; docs/DECISIONS.md round 128l "the attack wave").
// The rules are raid.ts's (the clock, the goal, the loot); this moves them through the game's own systems:
//  - a rider brings word a day ahead: a unit that walks the road in to the stores and out again; the bar shows the line
//    once it's there;
//  - at dusk the raiders walk in from the window's edge where the roads come nearest it (FortressLife.edgeWay) to the
//    wave's goal: the stores, through the gate. They walk on the units' goal fields (AgentUnits 'go': one field a place,
//    shared; the roads cost less on every field, so they come in along the road). They are the units' hostiles: they
//    fight who comes near on their side of the wall (AgentUnits.mayFight: not over a wall, not up on the wall-walk, not
//    people in at home);
//  - the gates shut when a raider comes near one, or when nobody is left outside (Fortress.setGatesShut: solid, drawn
//    shut). Walls and shut gates are in the way: the raiders bash the weakest that stands between them and the stores
//    (raid.ts raidGoal); a block whose health runs out breaks (Fortress.breakBlock: down with what's over it, rubble
//    poured where it stood) and is a planned block again, so the builders repair it when the stores can pay;
//  - at the stores each raider takes its loot; then they torch the houses (each house burns RAID.burnSec, then falls:
//    its timber left burning in the fire sim), then they ride out with what they carry. The wave runs early once
//    RAID.breakShare of it is down; a fallen raider's loot goes back to the stores;
//  - the villagers shelter at home while raiders are about (FortressLife.shelter).
// Its numbers are raid.ts RAID; what it says, words.ts.
import type { Good, Goods } from '../api/contracts/fortress';
import type { UnitId, UnitView, V2 } from '../api/contracts/units';
import { R } from '../settle/life';
import { G, type AgentUnits, type UnitRec } from '../units/agent-units';
import type { FxName } from '../api/fx';
import { blockHp, layoutOf, lootOf, RAID, RaidClock, raidGoal, raidSides, sideOf, waveBreaks, type RaidLayout, type RaidSides, type Side } from './raid';
import type { Fortress } from './fortress';
import type { FortressLife } from './life';
import { ECON } from './defs';
import { nameOf } from './follow';
import { FortressDefence, type Posts } from './defence';
import { raidArrivedLine, raidNowLine, raidOverLines, raidWarnLine } from './words';

/** the raiders' faction (no settlement's) */
export const RAID_FACTION = 'f-raiders';
/** how near a goal point counts as there (m) */
const THERE = 4.5;
/** how near the window's edge a unit leaving counts as gone (m) */
const GONE = 6;
/** sim seconds between the layout's looks (the sides of the wall, the goal) */
const LOOK_S = 1;

export interface RaidIO {
  units: AgentUnits;
  fort: Fortress;
  life: FortressLife;
  /** the stores now, and goods taken out (negative: put back) */
  stores(): Goods;
  take(good: Good, amount: number): void;
  /** the world: fire set to what burns, loose ground poured, solid put, particles */
  ignite(x: number, y: number, radius: number): void;
  pour(x: number, y: number, material: string, radius: number, layers: number): void;
  put(x: number, y: number, material: string, amount: number): void;
  burst(name: FxName, x: number, y: number, z: number, opts?: { count?: number; speed?: number; spread?: number; vel?: readonly [number, number, number] }): void;
  /** the ground's top at window world (x, y) */
  ground(x: number, y: number): number;
  /** the window (world units: x across, y down) */
  dims: { w: number; h: number };
}

type Phase = 'in' | 'bash' | 'looted' | 'out';
interface Raider {
  id: UnitId;
  phase: Phase;
  /** sim seconds to its next blow */
  t: number;
  loot: Goods;
  /** where it walks now (AgentUnits 'go': a goal field, roads cheaper on it), or null: it stands (bashing, waiting) */
  to: V2 | null;
}

type Stage = 'none' | 'breach' | 'stores' | 'houses' | 'out';

/** What one wave did (the summary card's facts). */
export interface RaidReport {
  wave: number;
  size: number;
  /** goods carried away (by raiders who got out) */
  taken: Goods;
  /** blocks broken by type ('gate', 'wall', 'house' …) */
  broken: Record<string, number>;
  housesBurned: number;
  /** the fortress's fallen: their names, and whether each was a soldier */
  fallen: { name: string; soldier: boolean }[];
  raidersFallen: number;
  raidersOut: number;
}

export class FortressRaid {
  readonly clock: RaidClock;
  /** the wave now (null: none) */
  stage: Stage = 'none';
  readonly raiders = new Map<UnitId, Raider>();
  /** the rider bringing word (null: none on the road) */
  rider: UnitId | null = null;
  /** the line the bar shows: the warning, the raid, the summary (null: nothing) */
  lines: string[] = [];
  /** the last wave's summary, until the next */
  report: RaidReport | null = null;
  /** per wall cell the health it has left (the blows it took) */
  readonly hp = new Map<number, number>();
  /** the houses burning: a cell, sim seconds left; and the structures torched this wave */
  private burning: { cell: number; t: number; at: V2 }[] = [];
  private torched = new Set<number>();
  /** timber put where a house fell, set alight a moment later (after the claim is gone): sim seconds left */
  private embers: { at: V2; t: number }[] = [];
  private t = 0;
  private lookAt = -1e9;
  private sides: RaidSides | null = null;
  private layout: RaidLayout | null = null;
  private dirty = true;
  private goal: { kind: 'stores' } | { kind: 'breach'; cell: number } | null = null;
  private size = 0;
  private entry: V2 | null = null;
  /** the road's end nearest the edge they came in by: where those leaving ride to, and are gone */
  private exit: V2 | null = null;
  private side: Side = 'east';
  private warnPending: { size: number } | null = null;
  private now: RaidReport | null = null;
  readonly stats = { warned: 0, waves: 0, blows: 0, breaches: 0, looted: 0, torched: 0, burned: 0, escaped: 0, byArchers: 0, bySoldiers: 0 };
  private onChange = () => (this.dirty = true);
  private onDied = (u: UnitView, by: UnitId | string | null) => {
    const k = typeof by === 'number' ? this.io.units.get(by) : null;
    this.log.push(`${Math.round(this.t)}s ${u.role} ${this.sideAt([u.at[0], u.at[1]])} z${u.at[2].toFixed(1)} by ${k ? `${k.role} ${this.sideAt([k.at[0], k.at[1]])} z${k.at[2].toFixed(1)}` : String(by)}`);
    if (this.raiders.has(u.id) && typeof by === 'number') {
      const p = this.defence.posted.get(by);
      if (p?.role === 'archer') this.stats.byArchers++;
      else if (p) this.stats.bySoldiers++;
    }
    this.died(u);
  };
  /** (scripted checks) the deaths while raiders were about: who, where, by whom */
  readonly log: string[] = [];

  constructor(private io: RaidIO) {
    this.clock = new RaidClock(ECON.daySec);
    io.fort.onChange.push(this.onChange);
    io.units.died.push(this.onDied);
    io.units.mayFight = (u, foe) => this.mayFight(u, foe);
    io.life.raid = this;
    this.defence = new FortressDefence({ units: io.units, life: io.life, burst: io.burst, raiders: () => [...this.raiders.keys()] });
  }
  /** (part B) the soldiers on their posts, the archers' arrows */
  readonly defence: FortressDefence;
  /** the word has come (or the wave): the soldiers are on their posts till it's over */
  private alarmed = false;

  dispose(): void {
    const U = this.io.units;
    for (const id of this.raiders.keys()) U.remove(id);
    if (this.rider !== null) U.remove(this.rider);
    this.raiders.clear();
    this.rider = null;
    const i = this.io.fort.onChange.indexOf(this.onChange);
    if (i >= 0) this.io.fort.onChange.splice(i, 1);
    const j = U.died.indexOf(this.onDied);
    if (j >= 0) U.died.splice(j, 1);
    if (U.mayFight) U.mayFight = null;
    if (this.io.life.raid === this) this.io.life.raid = null;
    this.defence.release();
    this.io.fort.setGatesShut(false);
  }

  /** whether raiders are about */
  get active(): boolean {
    return this.stage !== 'none';
  }

  /** the bar shows the last wave's summary as a card (until it's closed) */
  summary = false;
  /** the summary card closed */
  closeSummary(): void {
    if (!this.summary) return;
    this.summary = false;
    this.lines = [];
  }

  /** "Call raiders now" (the bar's test button): the next wave at once */
  callNow(): void {
    if (this.active) return;
    this.arrive(this.clock.call(this.t));
  }

  // ---- the routine (AgentUnits steps the raiders and the rider through FortressLife) -------------------------

  takes(u: UnitRec): boolean {
    return (u.v.job.kind === 'work' && this.raiders.has(u.v.id)) || this.defence.takes(u);
  }

  /** a raider standing (bashing, or waiting with its loot), each think: its pose (the walking is AgentUnits' 'go') */
  step(u: UnitRec, _dt: number): void {
    if (this.defence.takes(u)) return this.defence.step(u);
    const U = this.io.units;
    const r = this.raiders.get(u.v.id);
    if (r?.phase === 'bash') {
      U.regroup(u, R.working);
      u.v.state = 'swing';
    } else {
      U.regroup(u, G.stand);
      u.v.state = 'idle';
    }
  }

  drop(_u: UnitRec): void {}

  // ---- each frame (sim seconds) ------------------------------------------------------------------------------

  update(dt: number): void {
    if (dt <= 0) return;
    this.t += dt;
    for (const e of this.clock.update(this.t)) {
      if (e.kind === 'warn') this.warn(e.size);
      else if (!this.active) this.arrive(e);
    }
    this.stepRider();
    this.burn(dt);
    if (this.alarmed) {
      // (soldiers trained since, and the wall cell they'll go for as it changes: the posts again)
      if (this.t - this.manAt >= LOOK_S) this.alarm();
      this.defence.update(dt);
    }
    if (!this.active) return;
    if (this.dirty || this.t - this.lookAt >= LOOK_S) this.look();
    this.shutGates();
    for (const r of [...this.raiders.values()]) this.stepRaider(r, dt);
    this.advance();
    this.say();
  }

  /** the bar's line while the raid goes on (from the gates shutting) */
  private say(): void {
    if (!this.active || (this.stage === 'breach' && !this.io.fort.gatesShut) || (this.stage === 'stores' && !this.lastBroke && !this.io.fort.gatesShut)) return;
    const alive = [...this.raiders.values()].filter((r) => this.io.units.get(r.id)?.alive).length;
    if (!alive) return;
    this.lines = [raidNowLine(this.stage, alive, this.lastBroke)];
  }
  /** what they broke last ('gate', 'wall'), for the line */
  private lastBroke: string | null = null;

  // ---- the rider ----------------------------------------------------------------------------------------------

  private warn(size: number): void {
    const L = this.io.life;
    const way = L.edgeWay();
    const at = way?.edge ?? null;
    this.stats.warned++;
    this.warnPending = { size };
    this.entry = at;
    this.exit = way?.node ?? null;
    if (at) this.side = sideOf(at, this.io.dims);
    // (no road in from the edge: the word comes all the same — the bar says it now)
    if (!at) return this.told();
    this.rider = this.io.units.spawn('rider', at, this.io.life.faction, { name: 'Rider', role: 'rider', health: 3, job: { kind: 'go', to: L.heap() } });
  }

  private stepRider(): void {
    if (this.rider === null) return;
    const v = this.io.units.get(this.rider);
    if (!v?.alive) return void (this.rider = null);
    const at: V2 = [v.at[0], v.at[1]];
    if (this.warnPending) {
      const h = this.io.life.heap();
      if (Math.hypot(h[0] - at[0], h[1] - at[1]) < THERE) {
        this.told();
        if (this.exit) this.io.units.order(this.rider, { kind: 'go', to: this.exit });
      }
    } else if (this.exit && Math.hypot(this.exit[0] - at[0], this.exit[1] - at[1]) < GONE) {
      this.io.units.remove(this.rider);
      this.rider = null;
    }
  }

  /** the rider's word on the bar; the soldiers to their posts */
  private told(): void {
    if (!this.warnPending) return;
    this.summary = false;
    this.lines = [raidWarnLine(this.side, this.warnPending.size)];
    this.warnPending = null;
    this.alarm();
  }

  private manAt = -1e9;
  /** the soldiers to their posts (the word has come, or the wave) */
  private alarm(): void {
    this.alarmed = true;
    this.manAt = this.t;
    this.defence.man(this.postsNow());
  }

  /**
   * Where the soldiers stand: the wall cell the raiders will go for with the gates shut (raidGoal from where they come
   * in) — swordsmen on its inside, archers on the wall beside it (the one nearest where they come in). No wall between
   * the stores and the outside: everyone at the stores.
   */
  postsNow(): Posts {
    const f = this.io.fort;
    const heap = this.io.life.heap();
    const L0 = layoutOf(f, heap, (c) => this.hpOf(c));
    const L: RaidLayout = { ...L0, solid: (c) => L0.solid(c) || (!!f.plan.gate[c] && f.town.has(c, 0)) };
    const sides = raidSides(L);
    const from = this.entry ?? this.io.life.edgeEntry() ?? heap;
    const g = this.stage === 'breach' && this.goal?.kind === 'breach' ? this.goal : raidGoal(L, from, sides);
    if (!g || g.kind !== 'breach') return { archers: null, swords: heap };
    const b = g.cell;
    const [bx, by] = f.centre(b);
    let swords: V2 = heap;
    let beside = -1;
    let bd = Infinity;
    for (let e = 0; e < 4; e++) {
      const n = f.grid.nbr[b * 4 + e];
      if (n < 0) continue;
      if (sides.inside[n]) {
        const [nx, ny] = f.centre(n);
        const d = Math.hypot(nx - bx, ny - by) || 1;
        swords = [bx + ((nx - bx) / d) * 3, by + ((ny - by) / d) * 3];
      }
      if (L.wall(n) && !f.plan.gate[n]) {
        const [nx, ny] = f.centre(n);
        const d = Math.hypot(nx - from[0], ny - from[1]);
        if (d < bd) {
          bd = d;
          beside = n;
        }
      }
    }
    const up = beside >= 0 ? beside : f.plan.gate[b] ? -1 : b;
    return { archers: up >= 0 ? f.centre(up) : null, swords };
  }


  // ---- the wave -----------------------------------------------------------------------------------------------

  private arrive(e: { wave: number; size: number }): void {
    const L = this.io.life;
    const way = L.edgeWay();
    if (way) {
      this.entry = way.edge;
      this.exit = way.node;
    }
    if (!this.entry) return;
    this.side = sideOf(this.entry, this.io.dims);
    this.size = e.size;
    this.stats.waves++;
    this.torched.clear();
    this.lastBroke = null;
    this.now = { wave: e.wave, size: e.size, taken: {}, broken: {}, housesBurned: 0, fallen: [], raidersFallen: 0, raidersOut: 0 };
    this.report = null;
    const U = this.io.units;
    for (let i = 0; i < e.size; i++) {
      const a = (i / e.size) * Math.PI * 2;
      const at: V2 = [this.entry[0] + Math.cos(a) * 1.5, this.entry[1] + Math.sin(a) * 1.5];
      const id = U.spawn('raider', at, RAID_FACTION, { hostile: true, role: 'raider', health: RAID.raiderHealth, damage: RAID.raiderDamage, sight: RAID.raiderSight, job: { kind: 'work', at, what: 'raid' } });
      this.raiders.set(id, { id, phase: 'in', t: 0, loot: {}, to: null });
    }
    // (the rider still on his way: the raiders came first)
    this.warnPending = null;
    if (this.rider !== null) {
      U.remove(this.rider);
      this.rider = null;
    }
    this.stage = 'breach';
    this.dirty = true;
    this.summary = false;
    this.lines = [raidArrivedLine(this.side, e.size)];
    L.shelter = true;
    this.alarm();
  }

  /** the layout read again: the two sides of the wall, the goal, the wave's ride */
  private look(): void {
    this.lookAt = this.t;
    this.dirty = false;
    this.layout = layoutOf(this.io.fort, this.io.life.heap(), (c) => this.hpOf(c));
    this.sides = raidSides(this.layout);
    if (this.stage === 'breach' || this.stage === 'stores') {
      const g = raidGoal(this.layout, this.middle(), this.sides);
      this.goal = g;
      // (nothing they can break gets them to the stores: they go)
      if (!g) return this.flee();
      this.stage = g.kind === 'stores' ? 'stores' : 'breach';
    }
    this.setGoals();
  }

  private hpOf(c: number): number {
    const f = this.io.fort;
    return this.hp.get(c) ?? blockHp(!!f.plan.gate[c], [...f.town.built.each(c)].length);
  }

  /** where the raiders are, on the whole */
  private middle(): V2 {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const r of this.raiders.values()) {
      const v = this.io.units.get(r.id);
      if (!v?.alive) continue;
      x += v.at[0];
      y += v.at[1];
      n++;
    }
    return n ? [x / n, y / n] : (this.entry ?? [0, 0]);
  }

  /** the wave's goal points now (window world) */
  private goals(): V2[] {
    switch (this.stage) {
      case 'breach': {
        if (this.goal?.kind !== 'breach') return [];
        return [this.standOutside(this.goal.cell)];
      }
      case 'stores':
        return [this.io.life.heap()];
      case 'houses':
        return this.houses()
          .filter((h) => !this.torched.has(h.id))
          .map((h) => h.door);
      default:
        return this.exit ? [this.exit] : [];
    }
  }

  /** a wall cell's outside face: its middle moved toward its neighbour on the outside */
  private standOutside(c: number): V2 {
    const f = this.io.fort;
    const [x, y] = f.centre(c);
    for (let e = 0; e < 4; e++) {
      const n = f.grid.nbr[c * 4 + e];
      if (n >= 0 && !this.sides?.outside[n]) continue;
      if (n < 0) return [x, y];
      const [nx, ny] = f.centre(n);
      const d = Math.hypot(nx - x, ny - y) || 1;
      return [x + ((nx - x) / d) * 2.5, y + ((ny - y) / d) * 2.5];
    }
    return [x, y];
  }

  /** the fortress's houses built: their doors */
  private houses(): { id: number; door: V2; cells: number[] }[] {
    const f = this.io.fort;
    const out: { id: number; door: V2; cells: number[] }[] = [];
    for (const s of f.plan.structures()) {
      if (s.type !== 'house') continue;
      const cells = [...s.cells.keys()].filter((c) => f.town.has(c, 0));
      const door = f.doorOf(s.id);
      if (cells.length && door) out.push({ id: s.id, door, cells });
    }
    return out;
  }

  /** the raiders walking in: each to the nearest of the wave's goals (one goal field a place, shared) */
  private setGoals(): void {
    const goals = this.goals();
    for (const r of this.raiders.values()) if (r.phase === 'in') this.walkTo(r, goals);
  }

  private walkTo(r: Raider, goals: V2[]): void {
    const U = this.io.units;
    const v = U.get(r.id);
    if (!v?.alive) return;
    const to = goals.length ? goals.slice().sort((a, b) => Math.hypot(a[0] - v.at[0], a[1] - v.at[1]) - Math.hypot(b[0] - v.at[0], b[1] - v.at[1]))[0] : null;
    if (to && r.to && Math.hypot(to[0] - r.to[0], to[1] - r.to[1]) < 1) return;
    this.stand(r, to);
  }

  /** a raider walks to `to` (AgentUnits 'go'), or stands where it is (null: the raid's routine poses it) */
  private stand(r: Raider, to: V2 | null): void {
    const U = this.io.units;
    const v = U.get(r.id);
    if (!v?.alive) return;
    if (!to && !r.to) return;
    r.to = to;
    U.order(r.id, to ? { kind: 'go', to } : { kind: 'work', at: [v.at[0], v.at[1]], what: 'raid' });
  }

  /** the gates shut when a raider comes near one, or once nobody of the fortress is left outside */
  private shutGates(): void {
    const f = this.io.fort;
    if (f.gatesShut || !this.sides) return;
    const gates = [...f.plan.structures()].flatMap((s) => [...s.cells.keys()].filter((c) => f.plan.gate[c] && f.town.has(c, 0)));
    if (!gates.length) return;
    const U = this.io.units;
    const near = [...this.raiders.values()].some((r) => {
      const v = U.get(r.id);
      return v?.alive && gates.some((c) => {
        const [x, y] = f.centre(c);
        return Math.hypot(x - v.at[0], y - v.at[1]) < RAID.shutAt;
      });
    });
    const outside = this.io.life.people().some((id) => {
      const v = U.get(id);
      return v?.alive && this.sideAt([v.at[0], v.at[1]]) === 'out';
    });
    if (near || !outside) {
      this.log.push(`${Math.round(this.t)}s gates shut: ${near ? 'raiders near' : 'nobody outside'}; raiders ${[...this.raiders.values()].map((r) => {
        const v = U.get(r.id);
        return v ? `${this.sideAt([v.at[0], v.at[1]])}@${v.at[0].toFixed(0)},${v.at[1].toFixed(0)}` : '-';
      }).join(' ')}; gates ${gates.map((c) => f.centre(c).map(Math.round).join(',')).join(' ')}`);
      f.setGatesShut(true);
      this.dirty = true;
    }
  }

  /** which side of the wall a point is on: out (joined to the edge), in (joined to the stores), or neither */
  sideAt(p: V2): 'out' | 'in' | 'other' {
    const f = this.io.fort;
    const c = f.cellAt(p[0], p[1]);
    if (c < 0) return 'out';
    if (!this.sides) return 'other';
    if (this.sides.outside[c]) return 'out';
    if (this.sides.inside[c]) return 'in';
    return 'other';
  }

  /**
   * (AgentUnits.mayFight) who may take on whom while raiders are about: a raider and its foe on the same side of the
   * wall (both outside, or both in once it's broken) and on the same ground (not one up on the wall-walk).
   */
  mayFight(u: UnitView, foe: UnitView): boolean {
    // (an archer on its post shoots: it never closes in)
    if (this.defence.holds(u.id)) return false;
    if (!this.active || (u.role !== 'raider' && foe.role !== 'raider')) return true;
    // (a cart is a wagon: it neither fights nor is fought)
    if (u.role === 'cart' || foe.role === 'cart') return false;
    // (in at home: the house keeps them — the raiders burn houses instead)
    const inside = this.io.life.inside;
    if (inside.has(u.id) || inside.has(foe.id)) return false;
    if (Math.abs(u.at[2] - foe.at[2]) > 1.6) return false;
    const a = this.sideAt([u.at[0], u.at[1]]);
    const b = this.sideAt([foe.at[0], foe.at[1]]);
    return a === b || this.sides?.open === true;
  }

  private stepRaider(r: Raider, dt: number): void {
    const U = this.io.units;
    const v = U.get(r.id);
    if (!v?.alive) return;
    const at: V2 = [v.at[0], v.at[1]];
    const near = (p: V2, d = THERE) => Math.hypot(p[0] - at[0], p[1] - at[1]) < d;
    if (r.phase === 'out') {
      if (this.exit && near(this.exit, GONE)) this.escaped(r);
      return;
    }
    if (r.phase === 'bash') {
      const g = this.goal;
      if (this.stage !== 'breach' || g?.kind !== 'breach' || !this.io.fort.town.has(g.cell, 0)) return void (r.phase = 'in');
      r.t -= dt;
      if (r.t > 0) return;
      r.t = RAID.bashSec;
      this.blow(g.cell, at);
      return;
    }
    if (r.phase === 'looted') {
      if (this.stage !== 'stores') r.phase = 'in';
      return;
    }
    // in: to the wave's goal
    if (this.stage === 'breach' && this.goal?.kind === 'breach') {
      const c = this.io.fort.centre(this.goal.cell);
      if (near(c, RAID.bashReach)) {
        r.phase = 'bash';
        r.t = RAID.bashSec * Math.random();
        this.stand(r, null);
      }
    } else if (this.stage === 'stores') {
      if (near(this.io.life.heap())) this.loot(r, at);
    } else if (this.stage === 'houses') {
      for (const h of this.houses()) if (!this.torched.has(h.id) && near(h.door)) this.torch(h, at);
    }
  }

  /** a raider's blow on a wall cell: chips fly; at no health left it breaks */
  private blow(cell: number, from: V2): void {
    this.stats.blows++;
    const left = this.hpOf(cell) - 1;
    const f = this.io.fort;
    const [x, y] = f.centre(cell);
    const z = this.io.ground(x, y) + 1.2;
    this.io.burst('chips', (x + from[0]) / 2, (y + from[1]) / 2, z, { count: 3, speed: 3 });
    if (left > 0) return void this.hp.set(cell, left);
    this.hp.delete(cell);
    const what = f.plan.gate[cell] ? 'gate' : (f.plan.typeAt(cell) ?? 'wall');
    const down = f.breakBlock(cell, 0);
    if (!down.length) return;
    this.stats.breaches++;
    if (this.now) this.now.broken[what] = (this.now.broken[what] ?? 0) + 1;
    this.lastBroke = what === 'fortress' ? 'keep' : what;
    // (rubble where it stood, dust)
    this.io.pour(x, y, 'rubble', 2.2, Math.min(2, down.length));
    this.io.burst('dust', x, y, z, { count: 60, speed: 5, spread: 2 });
    this.io.burst('chips', x, y, z + 1, { count: 24, speed: 6 });
    this.dirty = true;
    for (const q of this.raiders.values()) if (q.phase === 'bash') q.phase = 'in';
    this.setGoals();
  }

  private loot(r: Raider, _at: V2): void {
    const st = this.io.stores();
    const got = lootOf(st, 1);
    for (const [g, n] of Object.entries(got) as [Good, number][]) this.io.take(g, n);
    r.loot = got;
    r.phase = 'looted';
    this.stand(r, null);
    this.stats.looted++;
    const rec = this.io.units.recs.get(r.id);
    if (rec && Object.keys(got).length) this.io.units.carry(rec, got.weapons ? 'steel' : got.grain ? 'sand' : got.log ? 'log' : 'stone', 0.3);
  }

  /** a house set alight: its cell nearest its door burns, then falls */
  private torch(h: { id: number; door: V2; cells: number[] }, _at: V2): void {
    this.torched.add(h.id);
    this.stats.torched++;
    const f = this.io.fort;
    const cell = h.cells.slice().sort((a, b) => Math.hypot(f.centre(a)[0] - h.door[0], f.centre(a)[1] - h.door[1]) - Math.hypot(f.centre(b)[0] - h.door[0], f.centre(b)[1] - h.door[1]))[0];
    this.burning.push({ cell, t: RAID.burnSec, at: f.centre(cell) });
    // (those in it run to another house)
    this.io.life.unsafe = [...this.io.life.unsafe, h.door];
    this.dirty = true;
  }

  /** the houses burning: flames and smoke over them; at the end the block falls and its timber burns on the ground */
  private burn(dt: number): void {
    const f = this.io.fort;
    for (const b of this.burning) {
      b.t -= dt;
      const [x, y] = b.at;
      const top = this.io.ground(x, y) + 3 + Math.random() * 2;
      if (Math.random() < dt * 4) this.io.burst('flame', x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3, top, { count: 10 });
      if (Math.random() < dt * 2) this.io.burst('smoke', x, y, top + 2, { count: 8 });
      if (b.t > 0) continue;
      const down = f.breakBlock(b.cell, 0);
      this.stats.burned++;
      if (this.now && down.length) {
        this.now.broken.house = (this.now.broken.house ?? 0) + 1;
        this.now.housesBurned++;
      }
      this.io.burst('embers', x, y, top, { count: 30 });
      this.embers.push({ at: [x, y], t: 0.5 });
    }
    this.burning = this.burning.filter((b) => b.t > 0);
    for (const e of this.embers) {
      e.t -= dt;
      if (e.t > 0) continue;
      // (the house's timber on the ground, alight: the fire sim burns it down to ash)
      const [x, y] = e.at;
      for (const [dx, dy] of [[0, 0], [1.5, 0.8], [-1.4, -0.9], [1.2, -1.3], [-1.3, 1.1]]) this.io.put(x + dx, y + dy, 'log', 2);
      this.io.ignite(x, y, 2);
    }
    this.embers = this.embers.filter((e) => e.t > 0);
  }

  private escaped(r: Raider): void {
    this.stats.escaped++;
    if (this.now) {
      this.now.raidersOut++;
      for (const [g, n] of Object.entries(r.loot) as [Good, number][]) this.now.taken[g] = (this.now.taken[g] ?? 0) + n;
    }
    this.raiders.delete(r.id);
    this.io.units.remove(r.id);
  }

  /** the wave's stages on: stores looted → houses; houses torched (or none) → out; broken → out; none left → over */
  private advance(): void {
    const alive = [...this.raiders.values()].filter((r) => this.io.units.get(r.id)?.alive);
    // (over once they're gone and what they set alight has fallen)
    if (!alive.length) {
      if (!this.burning.length && !this.embers.length) this.over();
      return;
    }
    if (this.stage !== 'out' && waveBreaks(this.size, alive.length + (this.now?.raidersOut ?? 0))) return this.flee();
    if (this.stage === 'stores') {
      const looted = alive.filter((r) => r.phase === 'looted').length;
      const empty = !Object.values(lootOf(this.io.stores(), 1)).some((n) => (n ?? 0) > 0);
      if (looted * 2 >= alive.length || (empty && looted > 0)) {
        this.stage = 'houses';
        for (const r of alive) if (r.phase === 'looted') r.phase = 'in';
        this.setGoals();
      }
    } else if (this.stage === 'houses') {
      if (!this.goals().length) this.flee();
      else this.setGoals();
    }
  }

  private flee(): void {
    this.stage = 'out';
    for (const r of this.raiders.values()) {
      r.phase = 'out';
      this.stand(r, this.exit);
    }
  }

  /** the wave is over: the summary, the gates open, the villagers back to work */
  private over(): void {
    for (const r of this.raiders.values()) if (!this.io.units.get(r.id)?.alive) this.raiders.delete(r.id);
    this.stage = 'none';
    this.io.fort.setGatesShut(false);
    this.io.life.shelter = false;
    this.io.life.inside.clear();
    this.io.life.unsafe = [];
    this.defence.release();
    this.alarmed = false;
    // (what was battered and still stands is mended with the rest)
    this.hp.clear();
    if (this.now) {
      this.report = this.now;
      this.lines = raidOverLines(this.now);
      this.summary = true;
    }
    this.now = null;
  }

  private died(u: UnitView): void {
    if (!this.now) return;
    const r = this.raiders.get(u.id);
    if (r) {
      this.now.raidersFallen++;
      // (what it carried goes back to the stores)
      for (const [g, n] of Object.entries(r.loot) as [Good, number][]) this.io.take(g, -n);
      r.loot = {};
      return;
    }
    const L = this.io.life;
    if (u.settlement !== L.settlementId || (u.role !== 'guard' && u.role !== 'villager')) return;
    this.now.fallen.push({ name: u.name ?? nameOf(u.id), soldier: u.role === 'guard' });
  }

  /** (scripted checks) the wave now */
  state(): { stage: Stage; raiders: { id: UnitId; phase: Phase; at: [number, number, number] | null; hp: number; to: V2 | null }[]; gatesShut: boolean; goal: unknown; hp: [number, number][]; lines: string[]; report: RaidReport | null; stats: FortressRaid['stats']; next: number; t: number; burning: number; log: string[]; defence: unknown } {
    return {
      stage: this.stage,
      raiders: [...this.raiders.values()].map((r) => {
        const v = this.io.units.get(r.id);
        return { id: r.id, phase: r.phase, at: v?.alive ? v.at : null, hp: v?.health ?? 0, to: r.to };
      }),
      gatesShut: this.io.fort.gatesShut,
      goal: this.goal,
      hp: [...this.hp],
      lines: this.lines,
      report: this.report,
      stats: this.stats,
      next: this.clock.next,
      t: this.t,
      burning: this.burning.length,
      defence: { ...this.defence.stats, posted: [...this.defence.posted].map(([id, p]) => ({ id, role: p.role, up: p.up, at: this.io.units.get(id)?.at ?? null })) },
      log: this.log.slice(-20),
    };
  }
}
