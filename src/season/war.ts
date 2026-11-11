// (trackA-forces; docs/design/SEASON_LOOP.md "Soldiers and waves") The season's soldiers and raiders. Might becomes
// soldiers — a squad of SQUAD a free point of Might — raised at the barracks, else the muster yard, else the market,
// and drilling there
// in a column; once the walls are built each squad guards a gate in a line (or, with ?man=1, mans the wall-walk), and
// one squad marches out through a standing gate and back each season (the patrol). Raiders come on a fixed schedule
// (FIRST_WAVE, then every WAVE_EVERY seasons), warned a season ahead: with a ring of walls from a spawn point outside it
// toward its gate; without one from a spawn point on an arterial to the keep, else the stores, else the market — the
// squads then stand in a line there. At the next Next season the fight is settled into the pools: Might lost for
// soldiers fallen, and raiders still alive got in — Unrest +1 and the Materials they carry off. Every Units call goes
// through TownForces (season/forces.ts); this file holds the rules and the bookkeeping only (no GPU, no DOM).
import { GATE_SLOTS, PLACE, PLACE_CHAIN, type GroupId, type PlaceRef } from '../api/contracts/townplaces';
import type { OrderFailure } from '../api/contracts/units';
import type { TownForces } from './forces';
import { lose, pools, type SeasonLedger } from './ledger';
import { fightLine, FORCES_FULL, NO_SOLDIERS, SOLDIERS_NO_PLACE, soldiersLine, WAVE_NO_ROAD, waveNowLine, waveSoonLine } from './words';

/** soldiers a free point of Might (SEASON_LOOP.md: "a squad a point of Might") */
export const SQUAD = 3;
/** squads at most (Track B's 8 order groups: a raid, 6 squads, a spare) — Might past 6 raises no more. Track B's round 7
 *  removes the group caps: delete this then (BACKLOG SF-10) */
export const MAX_SQUADS = 6;
/** the first raid's season (a walls card started in season 1 is up by season 4), and the seasons between raids */
export const FIRST_WAVE = 4;
export const WAVE_EVERY = 3;
/** the arterials' spawn points (townplaces ARTERIAL_ROOM) a wave may come from */
const SPAWNS = 8;
const TOWN_FACTION = 'f-town';
const RAIDER_FACTION = 'f-raiders';
/** a march's failures that say the gate can't be marched (try the next); the others (busy, no-town, pool-full) say no
 *  march can go now */
const GATE_REASONS: readonly OrderFailure[] = ['none', 'rising', 'water', 'failed'];

/** the k-th raid's size: 4, 6, 8 … */
export const waveSize = (k: number): number => 4 + 2 * k;

/** the raid due in this season (its index), or null; `first` 0: no raids */
export function waveIn(season: number, first = FIRST_WAVE): number | null {
  if (first <= 0 || season < first || (season - first) % WAVE_EVERY) return null;
  return (season - first) / WAVE_EVERY;
}

/** the fight settled at the season's end: Might lost for the fallen (a point for each SQUAD, rounded up), and raiders
 *  still alive got in — Unrest +1 and a Material each carried off (what's there) */
export function settle(l: SeasonLedger, f: { raiders: number; left: number; fallen: number }): { ledger: SeasonLedger; lost: { might: number; materials: number; unrest: number } } {
  const have = pools(l);
  const might = Math.min(Math.ceil(f.fallen / SQUAD), l.holdings.agents.filter((a) => a.kind === 'army').length);
  const materials = f.left ? Math.min(f.left, have.materials) : 0;
  const unrest = f.left ? 1 : 0;
  return { ledger: lose(l, { might, materials, unrest }), lost: { might, materials, unrest } };
}

const at = (town: number, place: number, orElse?: PlaceRef): PlaceRef => ({ town, place, ...(orElse ? { else: orElse } : {}) });

/** gate slots k, k+1, k+2 round (a chain of PLACE_CHAIN): the first standing; the next window on orderFailed */
export function gateWindow(town: number, k: number): PlaceRef {
  let ref: PlaceRef | undefined;
  for (let j = PLACE_CHAIN - 1; j >= 0; j--) ref = at(town, PLACE.gate0 + ((k + j) % GATE_SLOTS), ref);
  return ref!;
}

/** the heart of the town a raid with no wall to break goes for: the keep, else the stores, else the market */
export function townHeart(town: number): PlaceRef {
  return at(town, PLACE.keep, at(town, PLACE.stores, at(town, PLACE.market)));
}

/**
 * A raid's places over arterials a, a+1, a+2 (a window of PLACE_CHAIN).
 * - `ring` (the walls built): from the first whose spawn point and gate both stand, along it to that gate — the two
 *   chains pick the same arterial, each choice holding only with its partner valid (PlaceRef `also`). Past the last
 *   window (`last`): from arterial a's spawn point (else the first one's) to the keep, else the stores, else the market.
 * - no ring: from the first spawn point of the window that stands (no `also`: there are no gates) to the keep, else the
 *   stores, else the market.
 */
export function raidPlaces(town: number, a: number, o: { ring: boolean; last?: boolean } = { ring: true }): { from: PlaceRef; to: PlaceRef } {
  if (o.ring && o.last) return { from: at(town, PLACE.spawn0 + a, at(town, PLACE.spawn0)), to: townHeart(town) };
  let from: PlaceRef | undefined;
  let to: PlaceRef | undefined;
  for (let j = PLACE_CHAIN - 1; j >= 0; j--) {
    const k = (a + j) % SPAWNS;
    if (!o.ring) {
      from = at(town, PLACE.spawn0 + k, from);
      continue;
    }
    from = { town, place: PLACE.spawn0 + k, also: PLACE.gate0 + k, ...(from ? { else: from } : {}) };
    to = { town, place: PLACE.gate0 + k, also: PLACE.spawn0 + k, ...(to ? { else: to } : {}) };
  }
  return { from: from!, to: to ?? townHeart(town) };
}

export interface WarHost {
  /** the adapter, once the town contracts are up (null before) */
  forces(): TownForces | null;
  /** the town's slot in the place table (−1: not live) */
  town(): number;
  /** the first raid's season (?wave=N; 0 none) */
  firstWave: number;
  /** the ledger now (a season begun before the town's contracts were up is posted once they are) */
  ledger(): SeasonLedger;
  /** (?man=1, off by default) after the walls, squads man the wall-walk instead of guarding the gates — it needs the
   *  walls' baked routes (trackA-wallstair) and Track B's route riding; a squad whose man order fails guards a gate */
  man?: boolean;
}

/** where a squad is sent: its post */
type Post =
  /** drilling in a column round the muster yard (else the barracks) */
  | { kind: 'yard' }
  /** a raid and no ring: standing in a line at the town's heart (the keep, else the stores, else the market) */
  | { kind: 'heart' }
  /** guarding a gate window from slot `gate` (`tried` slots tried before) in a line */
  | { kind: 'gate'; gate: number; tried: number }
  /** manning the wall-walk, run `side` (?man=1); `home` the gate slot it guards if that fails */
  | { kind: 'man'; side: number; home: number }
  /** marching out of gate slot `gate` (`tried` slots tried before), then back to its gate post from `home` */
  | { kind: 'patrol'; gate: number; tried: number; home: number };

export class SeasonWar {
  /** the soldiers: a group a free point of Might (MAX_SQUADS at most) */
  private squads: GroupId[] = [];
  private posts = new Map<GroupId, Post>();
  private wave: { g: GroupId; n: number; stage: 'coming' | 'there' | 'fighting'; failed: boolean; a: number; tried: number } | null = null;
  private town = -1;
  /** the walls built this season: a ring with gates (raids come at a gate; squads guard them; the patrol) */
  private ring = false;
  private fallen = 0;
  private hooked: TownForces | null = null;
  private noPlace = false;
  /** an order or a spawn found no group or field free (Track B's order groups, fields): shown, never dropped */
  private full = false;
  private soon = false;
  /** told when its line changes */
  readonly onChange: (() => void)[] = [];

  constructor(private host: WarHost) {}

  /** what the player reads about soldiers and raiders now (one or two short sentences each) */
  get lines(): string[] {
    const f = this.hooked;
    const out: string[] = [];
    if (f) {
      const alive = (...kinds: Post['kind'][]) => this.squads.filter((g) => kinds.includes(this.posts.get(g)?.kind ?? 'yard')).reduce((s, g) => s + (f.report(g)?.alive ?? 0), 0);
      if (this.full) out.push(FORCES_FULL);
      const standing = alive('gate', 'man', 'patrol', 'heart', 'yard');
      if (this.noPlace && !standing) out.push(SOLDIERS_NO_PLACE);
      else if (!standing) out.push(NO_SOLDIERS);
      else {
        const where = [
          [alive('gate'), 'gates'],
          [alive('man'), 'walls'],
          [alive('patrol'), 'patrol'],
          [alive('heart'), 'heart'],
          [alive('yard'), 'yard'],
        ] as const;
        for (const [n, w] of where) if (n) out.push(soldiersLine(n, w));
      }
      if (this.wave) {
        const r = f.report(this.wave.g);
        if (this.wave.failed) out.push(WAVE_NO_ROAD);
        else if (r && r.size) out.push(waveNowLine(this.wave.n, r.alive, this.wave.stage));
      }
    }
    if (this.soon) out.push(waveSoonLine(waveSize(this.nextIndex)));
    return out;
  }
  private nextIndex = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  private changed(): void {
    for (const f of this.onChange) f();
  }

  /** the adapter's events, once */
  private hook(f: TownForces): void {
    if (this.hooked === f) return;
    this.hooked = f;
    f.died.push((g) => {
      if (this.squads.includes(g)) this.fallen++;
      this.changed();
    });
    f.arrived.push((g) => {
      if (this.wave?.g === g && this.wave.stage === 'coming') this.wave.stage = 'there';
      // (the patrol at its route's end: back to its gate post)
      const p = this.posts.get(g);
      if (p?.kind === 'patrol' && this.squads.includes(g)) this.post(f, g, p.home, 0);
      this.changed();
    });
    // (a blow on either side while a raid is on: the fight has begun)
    f.hurt.push((g) => {
      if (!this.wave || this.wave.stage === 'fighting' || (g !== this.wave.g && !this.squads.includes(g))) return;
      this.wave.stage = 'fighting';
      this.changed();
    });
    // (a whole chain failed: the next window of gates or arterials, else the yard / the keep — the season issues the
    // longer search a window at a time: Track B's chains hold PLACE_CHAIN choices)
    f.orderFailed.push((g, why, ref) => {
      console.warn(`[forces] group ${g}: no place in ${JSON.stringify(ref)} (${why})`);
      const r = f.report(g);
      if (this.squads.includes(g)) this.squadFailed(f, g, why, !!r?.size);
      if (this.wave?.g === g) {
        const w = this.wave;
        if (why === 'pool-full') this.full = true;
        else if (r?.size || w.tried >= SPAWNS || (!this.ring && w.tried + PLACE_CHAIN >= SPAWNS)) w.failed = true;
        else {
          f.disband(g);
          this.raid(f, w.n, w.a, w.tried + PLACE_CHAIN);
        }
      }
      this.changed();
    });
  }

  /** a squad's spawn or order failed: its next post, or the sheet told */
  private squadFailed(f: TownForces, g: GroupId, why: OrderFailure, made: boolean): void {
    // (no group or field free: the squad stays as it is — told on the sheet; the next season posts again)
    if (why === 'pool-full') {
      this.full = true;
      return;
    }
    // (the town's slot not live — its window slid away: no other place of it would do; the next season posts again)
    if (why === 'no-town') return;
    const p = this.posts.get(g);
    // (none made — no barracks, no yard: said, and the squad let go — its failure sticks, so its orders would fail the
    // same; the next season raises it again)
    if (!made || !p) {
      this.noPlace = true;
      this.squads = this.squads.filter((x) => x !== g);
      this.posts.delete(g);
      f.disband(g);
      return;
    }
    if (p.kind === 'gate') this.post(f, g, p.gate + PLACE_CHAIN, p.tried + PLACE_CHAIN);
    else if (p.kind === 'man') this.post(f, g, p.home, 0);
    else if (p.kind === 'patrol') {
      if (GATE_REASONS.includes(why) && p.tried + 1 < GATE_SLOTS) this.patrol(f, g, p.home, p.gate + 1, p.tried + 1);
      else this.post(f, g, p.home, 0);
    } else if (p.kind === 'heart') this.drill(f, g);
    else this.noPlace = true;
  }

  /**
   * At Next season, before the ledger moves on: the fight settled into the pools. The raiders still alive leave with
   * what they took; the soldiers fallen count against Might. Null: nothing to settle.
   */
  resolve(l: SeasonLedger): { ledger: SeasonLedger; line: string } | null {
    const f = this.hooked;
    if (!f || (!this.wave && !this.fallen)) return null;
    const w = this.wave;
    const r = w ? f.report(w.g) : null;
    const fight = { raiders: r?.size ?? 0, left: r?.alive ?? 0, fallen: this.fallen };
    const { ledger, lost } = settle(l, fight);
    if (w) f.disband(w.g);
    this.wave = null;
    this.fallen = 0;
    const line = fightLine({ ...fight, ...lost });
    console.log(`[forces] season ${l.season} settled: ${JSON.stringify({ ...fight, ...lost })}`);
    return { ledger, line };
  }

  /**
   * A season begun (its stages landed; and at the start): the squads to the free Might, their posts, a raid if due, and
   * the patrol in a season with walls and no raid.
   */
  season(l: SeasonLedger): void {
    const f = this.host.forces();
    const town = this.host.town();
    if (!f || town < 0) {
      // (the town's place table not up yet — its first frames: the season posted once it is)
      if (!this.retry) this.retry = setTimeout(() => ((this.retry = null), this.season(this.host.ledger())), 500);
      return;
    }
    this.hook(f);
    this.noPlace = false;
    this.full = false;
    // (the squads to the free Might: the weakest sent home first, new ones raised at the barracks, else the yard. A squad
    // with none left — all fallen, or its spawn failed (Track B's failure sticks: its orders would fail the same) — is let
    // go and raised again)
    const want = Math.min(MAX_SQUADS, pools(l).might);
    this.squads = this.squads.filter((g) => {
      if ((f.report(g)?.alive ?? 0) > 0) return true;
      f.disband(g);
      this.posts.delete(g);
      return false;
    });
    this.squads.sort((a, b) => (f.report(b)?.alive ?? 0) - (f.report(a)?.alive ?? 0));
    while (this.squads.length > want) {
      const g = this.squads.pop()!;
      f.disband(g);
      this.posts.delete(g);
    }
    this.town = town;
    this.ring = l.built.includes('walls');
    while (this.squads.length < want) this.squads.push(f.spawnAt('soldier', TOWN_FACTION, this.raise(), SQUAD));
    const k = waveIn(l.season, this.host.firstWave);
    const raidNow = k !== null || !!this.wave;
    // (posts: with the walls, squad j guards the first standing gate from slot j on — a window of gates a call, the next
    // on orderFailed — so the squads spread over the gates there are (or mans run j, ?man=1); the last squad marches
    // out on patrol in a season with no raid. No walls: drilling in the yard, or in a raid at the town's heart)
    const patrol = this.ring && !raidNow ? this.squads.length - 1 : -1;
    this.squads.forEach((g, j) => {
      if (!this.ring) return raidNow ? this.heart(f, g) : this.drill(f, g);
      if (j === patrol) return this.patrol(f, g, j, j, 0);
      if (this.host.man) return this.man(f, g, j);
      this.post(f, g, j, 0);
    });
    // (a raid due this season: raidPlaces)
    if (k !== null && !this.wave) {
      const a = k % SPAWNS;
      const n = waveSize(k);
      this.raid(f, n, a, 0);
      console.log(`[forces] season ${l.season}: raid ${k} of ${n}, arterials from ${a}${this.ring ? '' : ' (no walls: at the keep)'}`);
    }
    const next = waveIn(l.season + 1, this.host.firstWave);
    this.soon = next !== null;
    this.nextIndex = next ?? 0;
    this.changed();
  }

  /** the barracks, else the muster yard, else the market (a town with no walls and no keep: its soldiers gather in the
   *  market square — trackA-forces3) */
  private raise(): PlaceRef {
    return at(this.town, PLACE.barracks, at(this.town, PLACE.muster, at(this.town, PLACE.market)));
  }

  /** a squad drilling in a column round the muster yard, else the barracks, else the market */
  private drill(f: TownForces, g: GroupId): void {
    this.posts.set(g, { kind: 'yard' });
    f.orderGroup(g, { kind: 'drill', at: at(this.town, PLACE.muster, at(this.town, PLACE.barracks, at(this.town, PLACE.market))), formation: 'column' });
  }

  /** a squad in a line at the town's heart (a raid and no walls) */
  private heart(f: TownForces, g: GroupId): void {
    this.posts.set(g, { kind: 'heart' });
    f.orderGroup(g, { kind: 'guard', at: townHeart(this.town), formation: 'line' });
  }

  /** a squad to a gate window from slot `gate` (`tried` slots tried before) in a line, or past every slot drilling */
  private post(f: TownForces, g: GroupId, gate: number, tried: number): void {
    if (tried >= GATE_SLOTS) return this.drill(f, g);
    this.posts.set(g, { kind: 'gate', gate: gate % GATE_SLOTS, tried });
    f.orderGroup(g, { kind: 'guard', at: gateWindow(this.town, gate % GATE_SLOTS), formation: 'line' });
  }

  /** (?man=1) a squad manning wall run j; its gate post from slot j if that fails */
  private man(f: TownForces, g: GroupId, j: number): void {
    this.posts.set(g, { kind: 'man', side: j, home: j });
    f.orderGroup(g, { kind: 'man', town: this.town, side: j });
  }

  /** the patrol: a squad marching out of gate slot `gate` (the next on a gate's failure), then back to its post */
  private patrol(f: TownForces, g: GroupId, home: number, gate: number, tried: number): void {
    this.posts.set(g, { kind: 'patrol', gate: gate % GATE_SLOTS, tried, home });
    f.orderGroup(g, { kind: 'march', town: this.town, gate: gate % GATE_SLOTS });
  }

  /** a raid of n over the arterials' window from a + tried (`tried` arterials tried before); with walls, past them all
   *  the keep's way; without, past them all none came */
  private raid(f: TownForces, n: number, a: number, tried: number): void {
    const { from, to } = raidPlaces(this.town, (a + tried) % SPAWNS, { ring: this.ring, last: tried >= SPAWNS });
    const g = f.spawnAt('raider', RAIDER_FACTION, from, n);
    f.orderGroup(g, { kind: 'attack', at: to });
    this.wave = { g, n, stage: this.wave?.stage ?? 'coming', failed: false, a, tried };
  }

  /** (scripts and shots) the groups now */
  debug(): { squads: unknown[]; wave: unknown } {
    const f = this.hooked;
    return { squads: this.squads.map((g) => ({ ...f?.report(g), post: this.posts.get(g) })), wave: this.wave && { ...this.wave, report: f?.report(this.wave.g) } };
  }
}
