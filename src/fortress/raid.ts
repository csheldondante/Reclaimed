// The attack wave's rules (round 128l, m4: fortress M5-lite, docs/DECISIONS.md round 128l "the attack wave"). Pure: no
// GPU, no units — tested (raid.test.ts). The runtime (raiders.ts FortressRaid) moves the raiders and the defenders with
// these answers.
//  - The clock: waves are timed and announced. A rider brings word a day ahead ("Raiders from the east, tomorrow at
//    dusk."), the wave walks in at dusk from the window's edge along a road, and every wave is bigger than the last.
//    "Call raiders now" (the bar, for testing) brings one at once.
//  - The goal: the stores, then the houses. Walls and shut gates are in the way: the raiders bash the weakest of the
//    wall cells (a gate is weaker than a wall) that stand between the outside and the stores.
//  - The loot: each raider takes what it can carry out of the stores, the dearest goods first.
import type { Good, Goods } from '../api/contracts/fortress';
import type { Fortress } from './fortress';

type V2 = [number, number];

/** The wave's numbers (all untuned: the user tunes once it's playable; the DEVLOG lists them). */
export const RAID = {
  /** waves come on their own by the clock below; off (round 128m, the user: "For now just make raids button based only"):
   *  a wave comes only from "Call raiders now" */
  timed: false,
  /** the first wave comes at dusk on this economy day (ECON.daySec a day) */
  firstDay: 3,
  /** a wave every this many days after */
  everyDays: 3,
  /** dusk: this share of the day */
  dusk: 0.8,
  /** the rider sets out this many days before the wave (he takes a while to walk in: about a day ahead by the time he
   *  reaches the stores) */
  warnLead: 1.5,
  /** raiders in the first wave, and more each wave after, up to `most` */
  size0: 4,
  grow: 2,
  most: 16,
  /** a raider's health and what a blow of its takes off (a soldier's health is ECON.soldierHealth 5, a villager's 3;
   *  everyone else's blow takes 1): one raider is worth several villagers */
  raiderHealth: 8,
  raiderDamage: 2,
  /** cells a raider notices someone to fight within */
  raiderSight: 3.5,
  /** goods a raider carries away */
  loot: 4,
  /** a block's health against the raiders' blows: a gate's, and a wall's each level */
  gateHp: 24,
  wallHp: 30,
  /** sim seconds between a raider's blows on a block (the agents' raider swings every 1.1 s) */
  bashSec: 1.1,
  /** how near a block's middle a raider stands to bash it (m: a cell is ~5 across) */
  bashReach: 3.4,
  /** the gates shut when a raider comes this near one (m), or once nobody is left outside */
  shutAt: 30,
  /** sim seconds a torched house burns before it falls */
  burnSec: 8,
  /** the wave runs when this share of it is down */
  breakShare: 0.6,
};

/** The goods raiders take first. */
export const LOOT_ORDER: Good[] = ['weapons', 'ore', 'grain', 'log', 'stone'];

/** Raiders in wave n (0: the first). */
export function waveSize(n: number): number {
  return Math.min(RAID.most, RAID.size0 + RAID.grow * Math.max(0, n));
}

export type Side = 'north' | 'south' | 'east' | 'west';

/** The side of the window a point at its edge is on (y grows south on the screen). */
export function sideOf(at: V2, dims: { w: number; h: number }): Side {
  const d: [Side, number][] = [
    ['west', at[0]],
    ['east', dims.w - at[0]],
    ['north', at[1]],
    ['south', dims.h - at[1]],
  ];
  return d.sort((a, b) => a[1] - b[1])[0][0];
}

export type ClockEvent = { kind: 'warn'; wave: number; size: number } | { kind: 'arrive'; wave: number; size: number };

/**
 * The waves' clock (sim seconds since the fortress started building). A wave's warning a day before its dusk; its
 * arrival at dusk. `call()` brings the next wave at once (no warning) and the clock goes on from there.
 */
export class RaidClock {
  /** waves that have come */
  wave = 0;
  /** the next wave's dusk (sim s) */
  next: number;
  /** whether the next wave was warned of */
  warned = false;

  constructor(private daySec: number) {
    this.next = (RAID.firstDay + RAID.dusk) * daySec;
  }

  /** the next wave's size */
  size(): number {
    return waveSize(this.wave);
  }

  /** when the next warning sets out (sim s) */
  warnAt(): number {
    return this.next - RAID.warnLead * this.daySec;
  }

  /** what happens by time t (each at most once) */
  update(t: number): ClockEvent[] {
    const out: ClockEvent[] = [];
    if (!RAID.timed) return out;
    if (!this.warned && t >= this.warnAt()) {
      this.warned = true;
      out.push({ kind: 'warn', wave: this.wave, size: this.size() });
    }
    if (t >= this.next) out.push(this.come(t));
    return out;
  }

  /** the next wave now (the test button) */
  call(t: number): ClockEvent {
    return this.come(t);
  }

  private come(t: number): ClockEvent {
    const e: ClockEvent = { kind: 'arrive', wave: this.wave, size: this.size() };
    this.wave++;
    this.warned = false;
    // (the next one's dusk: everyDays on from this one's day — a called wave moves the clock too)
    const day = Math.floor(t / this.daySec);
    this.next = (day + RAID.everyDays + RAID.dusk) * this.daySec;
    return e;
  }
}

/** What the raiders see of the fortress's ground plan (the box's cells). */
export interface RaidGrid {
  count: number;
  /** per cell its neighbour across edge e (4 a cell), -1: off the box (outside) */
  nbr: Int32Array | number[];
  centre(c: number): V2;
}

export interface RaidLayout {
  grid: RaidGrid;
  /** whether a cell stands in the way at the ground (a built block, a wall, a shut gate) */
  solid(c: number): boolean;
  /** whether a cell is a wall (or gate) the raiders may bash */
  wall(c: number): boolean;
  /** a wall cell's health left */
  hp(c: number): number;
  /** the stores' cell (where the raiders loot) */
  stores: number;
}

/** The cells reached from `from` through free ground (not solid). */
function flood(L: RaidLayout, from: number[]): Uint8Array {
  const seen = new Uint8Array(L.grid.count);
  const q: number[] = [];
  for (const c of from)
    if (c >= 0 && !L.solid(c) && !seen[c]) {
      seen[c] = 1;
      q.push(c);
    }
  while (q.length) {
    const c = q.pop()!;
    for (let e = 0; e < 4; e++) {
      const n = L.grid.nbr[c * 4 + e];
      if (n < 0 || seen[n] || L.solid(n)) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return seen;
}

export interface RaidSides {
  /** free cells joined to the box's edge (the outside) */
  outside: Uint8Array;
  /** free cells joined to the stores */
  inside: Uint8Array;
  /** whether the stores are open to the outside */
  open: boolean;
}

/** Which free cells are outside (joined to the box's edge) and which are joined to the stores. */
export function raidSides(L: RaidLayout): RaidSides {
  const { grid } = L;
  const edge: number[] = [];
  for (let c = 0; c < grid.count; c++) for (let e = 0; e < 4; e++) if (grid.nbr[c * 4 + e] < 0) edge.push(c);
  const outside = flood(L, edge);
  // (the stores' cell may be the warehouse's own: its free neighbours are where it's looted from)
  const seeds = [L.stores];
  if (L.stores >= 0 && L.solid(L.stores)) for (let e = 0; e < 4; e++) seeds.push(grid.nbr[L.stores * 4 + e]);
  const inside = flood(L, seeds);
  let open = false;
  for (let c = 0; c < grid.count && !open; c++) if (inside[c] && outside[c]) open = true;
  return { outside, inside, open };
}

export type RaidGoal = { kind: 'stores' } | { kind: 'breach'; cell: number };

/**
 * Where the raiders go: the stores when nothing stands between them and the outside; else the wall cell to break —
 * among the walls with the outside on one side and the stores' side on another, the one with the least health left
 * (a gate is weaker than a wall), the nearest to the raiders on a tie. Walls two deep (none touches both): the outer
 * wall cell nearest the stores. Null: the stores can't be reached by breaking one wall (nothing to bash).
 */
export function raidGoal(L: RaidLayout, raidersAt: V2, sides: RaidSides = raidSides(L)): RaidGoal | null {
  if (sides.open) return { kind: 'stores' };
  const { grid } = L;
  const touches = (c: number, set: Uint8Array) => {
    for (let e = 0; e < 4; e++) {
      const n = grid.nbr[c * 4 + e];
      if (n >= 0 && set[n]) return true;
    }
    return false;
  };
  const dist = (c: number, p: V2) => {
    const [x, y] = grid.centre(c);
    return Math.hypot(x - p[0], y - p[1]);
  };
  let best = -1;
  let bh = Infinity;
  let bd = Infinity;
  for (let c = 0; c < grid.count; c++) {
    if (!L.wall(c) || !touches(c, sides.outside) || !touches(c, sides.inside)) continue;
    const h = L.hp(c);
    const d = dist(c, raidersAt);
    if (h < bh - 1e-6 || (Math.abs(h - bh) <= 1e-6 && d < bd)) {
      best = c;
      bh = h;
      bd = d;
    }
  }
  if (best >= 0) return { kind: 'breach', cell: best };
  // (walls two deep: the outer one nearest the stores first)
  const s = L.stores >= 0 ? grid.centre(L.stores) : raidersAt;
  for (let c = 0; c < grid.count; c++) {
    if (!L.wall(c) || !touches(c, sides.outside)) continue;
    const d = dist(c, s);
    if (d < bd) {
      best = c;
      bd = d;
    }
  }
  return best >= 0 ? { kind: 'breach', cell: best } : null;
}

/** A block's full health against the raiders: a gate's, or a wall's for its levels built. */
export function blockHp(gate: boolean, levels: number): number {
  return gate ? RAID.gateHp : RAID.wallHp * Math.max(1, levels);
}

/** What `n` raiders carry out of `stores`: the dearest goods first, RAID.loot each. */
export function lootOf(stores: Goods, n: number): Goods {
  let room = n * RAID.loot;
  const out: Goods = {};
  for (const g of LOOT_ORDER) {
    if (room <= 0) break;
    const take = Math.min(room, Math.floor(stores[g] ?? 0));
    if (take <= 0) continue;
    out[g] = take;
    room -= take;
  }
  return out;
}

/** Whether the wave breaks: this share of it is down. */
export function waveBreaks(size: number, alive: number): boolean {
  return size > 0 && size - alive >= Math.ceil(size * RAID.breakShare);
}

/**
 * The fortress as the raiders see it (window world): a built block at the ground stands in the way (a farm's or a
 * quarry's yard doesn't, an open gate doesn't); a built wall cell may be bashed, with `hp` left; the stores at `stores`.
 */
export function layoutOf(f: Fortress, stores: V2, hp: (c: number) => number): RaidLayout {
  return {
    grid: { count: f.grid.count, nbr: f.grid.nbr, centre: (c) => f.centre(c) },
    solid: (c) => {
      if (!f.town.has(c, 0)) return false;
      const t = f.plan.typeAt(c);
      if (t === 'farm' || t === 'quarry') return false;
      return !(f.plan.gate[c] && !f.gatesShut);
    },
    wall: (c) => f.plan.typeAt(c) === 'wall' && f.town.has(c, 0),
    hp,
    stores: f.cellAt(stores[0], stores[1]),
  };
}
