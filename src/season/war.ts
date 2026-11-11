// (trackA-forces; docs/design/SEASON_LOOP.md "Soldiers and waves") The season's soldiers and raiders. Might becomes
// soldiers — a squad of SQUAD a free point of Might — raised at the barracks, else the muster yard, and guarding it;
// once the walls are built each squad guards a gate. Raiders come on a fixed schedule (FIRST_WAVE, then every
// WAVE_EVERY seasons), warned a season ahead, from a spawn point outside the wall toward its gate, else the keep, else
// the stores. At the next Next season the fight is settled into the pools: Might lost for soldiers fallen, and raiders
// still alive got in — Unrest +1 and the Materials they carry off. Every Units call goes through TownForces
// (season/forces.ts); this file holds the rules and the bookkeeping only (no GPU, no DOM).
import { GATE_SLOTS, PLACE, PLACE_CHAIN, type GroupId, type PlaceRef } from '../api/contracts/townplaces';
import type { TownForces } from './forces';
import { lose, pools, type SeasonLedger } from './ledger';
import { fightLine, FORCES_FULL, NO_SOLDIERS, SOLDIERS_NO_PLACE, soldiersLine, WAVE_NO_ROAD, waveNowLine, waveSoonLine } from './words';

/** soldiers a free point of Might (SEASON_LOOP.md: "a squad a point of Might") */
export const SQUAD = 3;
/** squads at most (Track B's 8 order groups: a raid, 6 squads, a spare) — Might past 6 raises no more */
export const MAX_SQUADS = 6;
/** the first raid's season (a walls card started in season 1 is up by season 4), and the seasons between raids */
export const FIRST_WAVE = 4;
export const WAVE_EVERY = 3;
/** the arterials' spawn points (townplaces ARTERIAL_ROOM) a wave may come from */
const SPAWNS = 8;
const TOWN_FACTION = 'f-town';
const RAIDER_FACTION = 'f-raiders';

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

/**
 * A raid's places over arterials a, a+1, a+2 (a window of PLACE_CHAIN): from the first whose spawn point and gate both
 * stand, along it to that gate — the two chains pick the same arterial, each choice holding only with its partner valid
 * (PlaceRef `also`). Past the last window (`last`): from arterial a's spawn point (else the first one's) to the keep,
 * else the stores.
 */
export function raidPlaces(town: number, a: number, last = false): { from: PlaceRef; to: PlaceRef } {
  if (last) return { from: at(town, PLACE.spawn0 + a, at(town, PLACE.spawn0)), to: at(town, PLACE.keep, at(town, PLACE.stores)) };
  let from: PlaceRef | undefined;
  let to: PlaceRef | undefined;
  for (let j = PLACE_CHAIN - 1; j >= 0; j--) {
    const k = (a + j) % SPAWNS;
    from = { town, place: PLACE.spawn0 + k, also: PLACE.gate0 + k, ...(from ? { else: from } : {}) };
    to = { town, place: PLACE.gate0 + k, also: PLACE.spawn0 + k, ...(to ? { else: to } : {}) };
  }
  return { from: from!, to: to! };
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
}

export class SeasonWar {
  /** the soldiers: a group a free point of Might (MAX_SQUADS at most) */
  private squads: GroupId[] = [];
  /** each squad's post: the gate window tried (its first slot, slots tried) or where it was raised */
  private posts = new Map<GroupId, { gate: number; tried: number } | 'raised'>();
  private wave: { g: GroupId; n: number; stage: 'coming' | 'there' | 'fighting'; failed: boolean; a: number; tried: number } | null = null;
  private town = -1;
  private fallen = 0;
  private hooked: TownForces | null = null;
  private noPlace = false;
  /** an order or a spawn found no group or field free (Track B's 8 order groups, 7 fields): shown, never dropped */
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
      const alive = (gate: boolean) => this.squads.filter((g) => (this.posts.get(g) !== 'raised') === gate).reduce((s, g) => s + (f.report(g)?.alive ?? 0), 0);
      if (this.full) out.push(FORCES_FULL);
      if (this.noPlace) out.push(SOLDIERS_NO_PLACE);
      else if (!this.squads.length) out.push(NO_SOLDIERS);
      else {
        if (alive(true)) out.push(soldiersLine(alive(true), 'gates'));
        if (alive(false)) out.push(soldiersLine(alive(false), 'yard'));
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
      this.changed();
    });
    // (a blow on either side while a raid is on: the fight has begun)
    f.hurt.push((g) => {
      if (!this.wave || this.wave.stage === 'fighting' || (g !== this.wave.g && !this.squads.includes(g))) return;
      this.wave.stage = 'fighting';
      this.changed();
    });
    // (a whole chain failed: the next window of gates or arterials, else where they were raised / the keep — the
    // season issues the longer search a window at a time: Track B's chains hold PLACE_CHAIN choices)
    f.orderFailed.push((g, why, ref) => {
      console.warn(`[forces] group ${g}: no place in ${JSON.stringify(ref)} (${why})`);
      // (no group or field free: the group stays as it is — told on the sheet; the next season posts again)
      if (why === 'pool-full') {
        this.full = true;
        this.changed();
        return;
      }
      const r = f.report(g);
      if (this.squads.includes(g)) {
        const post = this.posts.get(g);
        if (!r?.size || post === 'raised' || !post) this.noPlace = true;
        else this.post(f, g, post.gate + PLACE_CHAIN, post.tried + PLACE_CHAIN);
      }
      if (this.wave?.g === g) {
        const w = this.wave;
        if (r?.size || w.tried >= SPAWNS) w.failed = true;
        else {
          f.disband(g);
          this.raid(f, w.n, w.a, w.tried + PLACE_CHAIN);
        }
      }
      this.changed();
    });
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

  /** A season begun (its stages landed; and at the start): the squads to the free Might, their posts, a raid if due. */
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
    // (the squads to the free Might: the weakest sent home first, new ones raised at the barracks, else the yard)
    const want = Math.min(MAX_SQUADS, pools(l).might);
    this.squads = this.squads.filter((g) => {
      const r = f.report(g);
      if (r && (r.alive > 0 || !r.size)) return true;
      f.disband(g);
      return false;
    });
    this.squads.sort((a, b) => (f.report(b)?.alive ?? 0) - (f.report(a)?.alive ?? 0));
    while (this.squads.length > want) {
      const g = this.squads.pop()!;
      f.disband(g);
      this.posts.delete(g);
    }
    this.town = town;
    while (this.squads.length < want) this.squads.push(f.spawnAt('soldier', TOWN_FACTION, this.raise(), SQUAD));
    // (posts: squad j at the first standing gate from slot j on once the walls are built — a window of gates a call,
    // the next on orderFailed — so the squads spread over the gates there are; else where they were raised)
    const walls = l.built.includes('walls');
    this.squads.forEach((g, j) => (walls ? this.post(f, g, j, 0) : this.post(f, g, -1, 0)));
    // (a raid due this season: raidPlaces)
    const k = waveIn(l.season, this.host.firstWave);
    if (k !== null && !this.wave) {
      const a = k % SPAWNS;
      const n = waveSize(k);
      this.raid(f, n, a, 0);
      console.log(`[forces] season ${l.season}: raid ${k} of ${n}, arterials from ${a}`);
    }
    const next = waveIn(l.season + 1, this.host.firstWave);
    this.soon = next !== null;
    this.nextIndex = next ?? 0;
    this.changed();
  }

  /** the barracks, else the muster yard */
  private raise(): PlaceRef {
    return at(this.town, PLACE.barracks, at(this.town, PLACE.muster));
  }

  /** a squad to a gate window from slot `gate` (`tried` slots tried before), or past every slot (or gate < 0) where
   *  it was raised */
  private post(f: TownForces, g: GroupId, gate: number, tried: number): void {
    if (gate < 0 || tried >= GATE_SLOTS) {
      this.posts.set(g, 'raised');
      f.orderGroup(g, { kind: 'guard', at: this.raise() });
      return;
    }
    this.posts.set(g, { gate: gate % GATE_SLOTS, tried });
    f.orderGroup(g, { kind: 'guard', at: gateWindow(this.town, gate % GATE_SLOTS) });
  }

  /** a raid of n over the arterials' window from a + tried (`tried` arterials tried before); past them all, the
   *  keep's way */
  private raid(f: TownForces, n: number, a: number, tried: number): void {
    const { from, to } = raidPlaces(this.town, (a + tried) % SPAWNS, tried >= SPAWNS);
    const g = f.spawnAt('raider', RAIDER_FACTION, from, n);
    f.orderGroup(g, { kind: 'attack', at: to });
    this.wave = { g, n, stage: this.wave?.stage ?? 'coming', failed: false, a, tried };
  }

  /** (scripts and shots) the groups now */
  debug(): { squads: unknown[]; wave: unknown } {
    const f = this.hooked;
    return { squads: this.squads.map((g) => f?.report(g)), wave: this.wave && { ...this.wave, report: f?.report(this.wave.g) } };
  }
}
