// (trackA-forces; docs/design/SEASON_LOOP.md "Soldiers and waves") The season's soldiers and raiders. Might becomes
// soldiers — a squad of SQUAD a free point of Might — raised at the barracks, else the muster yard, and guarding it;
// once the walls are built each squad guards a gate. Raiders come on a fixed schedule (FIRST_WAVE, then every
// WAVE_EVERY seasons), warned a season ahead, from a spawn point outside the wall toward its gate, else the keep, else
// the stores. At the next Next season the fight is settled into the pools: Might lost for soldiers fallen, and raiders
// still alive got in — Unrest +1 and the Materials they carry off. Every Units call goes through TownForces
// (season/forces.ts); this file holds the rules and the bookkeeping only (no GPU, no DOM).
import { GATE_SLOTS, PLACE, type GroupId, type PlaceRef } from '../api/contracts/townplaces';
import type { TownForces } from './forces';
import { lose, pools, type SeasonLedger } from './ledger';
import { fightLine, NO_SOLDIERS, SOLDIERS_NO_PLACE, soldiersLine, WAVE_NO_ROAD, waveNowLine, waveSoonLine } from './words';

/** soldiers a free point of Might (SEASON_LOOP.md: "a squad a point of Might") */
export const SQUAD = 3;
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

/** gate slot k, else the next slots round (the first standing gate from k on), else `last` */
export function gateFrom(town: number, k: number, last?: PlaceRef): PlaceRef {
  let ref = last;
  for (let j = GATE_SLOTS - 1; j >= 0; j--) ref = at(town, PLACE.gate0 + ((k + j) % GATE_SLOTS), ref);
  return ref!;
}

/**
 * A raid's places: from the first arterial from `a` on whose spawn point and gate both stand, along it to that gate;
 * with no such arterial, from arterial a's spawn point (else the first one's) to the keep, else the stores. (The two
 * chains pick the same arterial: each choice holds only with its partner valid — PlaceRef `also`.)
 */
export function raidPlaces(town: number, a: number): { from: PlaceRef; to: PlaceRef } {
  let from: PlaceRef = at(town, PLACE.spawn0 + a, at(town, PLACE.spawn0));
  let to: PlaceRef = at(town, PLACE.keep, at(town, PLACE.stores));
  for (let j = SPAWNS - 1; j >= 0; j--) {
    const k = (a + j) % SPAWNS;
    from = { town, place: PLACE.spawn0 + k, also: PLACE.gate0 + k, else: from };
    to = { town, place: PLACE.gate0 + k, also: PLACE.spawn0 + k, else: to };
  }
  return { from, to };
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
  /** the soldiers: a group a free point of Might */
  private squads: GroupId[] = [];
  private wave: { g: GroupId; n: number; atGate: boolean; failed: boolean } | null = null;
  private fallen = 0;
  private hooked: TownForces | null = null;
  private where: 'yard' | 'barracks' | 'gates' = 'yard';
  private noPlace = false;
  private soon = false;
  /** told when its line changes */
  readonly onChange: (() => void)[] = [];

  constructor(private host: WarHost) {}

  /** what the player reads about soldiers and raiders now (one or two short sentences each) */
  get lines(): string[] {
    const f = this.hooked;
    const out: string[] = [];
    if (f) {
      const alive = this.squads.reduce((s, g) => s + (f.report(g)?.alive ?? 0), 0);
      if (this.noPlace) out.push(SOLDIERS_NO_PLACE);
      else if (!this.squads.length) out.push(NO_SOLDIERS);
      else if (alive) out.push(soldiersLine(alive, this.where));
      if (this.wave) {
        const r = f.report(this.wave.g);
        if (this.wave.failed) out.push(WAVE_NO_ROAD);
        else if (r && r.size) out.push(waveNowLine(this.wave.n, r.alive, this.wave.atGate));
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
      if (this.wave?.g === g) this.wave.atGate = true;
      this.changed();
    });
    f.orderFailed.push((g, why, ref) => {
      console.warn(`[forces] group ${g}: its place ${JSON.stringify(ref)} isn't there (${why})`);
      if (this.squads.includes(g)) this.noPlace = true;
      if (this.wave?.g === g) this.wave.failed = true;
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
    f.placesMoved();
    this.noPlace = false;
    // (the squads to the free Might: the weakest sent home first, new ones raised at the barracks, else the yard)
    const want = pools(l).might;
    this.squads = this.squads.filter((g) => {
      const r = f.report(g);
      if (r && (r.alive > 0 || !r.size)) return true;
      f.disband(g);
      return false;
    });
    this.squads.sort((a, b) => (f.report(b)?.alive ?? 0) - (f.report(a)?.alive ?? 0));
    while (this.squads.length > want) f.disband(this.squads.pop()!);
    const raise = at(town, PLACE.barracks, at(town, PLACE.muster));
    while (this.squads.length < want) this.squads.push(f.spawnAt('soldier', TOWN_FACTION, raise, SQUAD));
    // (posts: squad j at the first standing gate from slot j on once the walls are built — the squads spread over the
    // gates there are; else where they were raised)
    const walls = l.built.includes('walls');
    this.where = walls ? 'gates' : 'yard';
    this.squads.forEach((g, j) => f.orderGroup(g, { kind: 'guard', at: walls ? gateFrom(town, j, raise) : raise }));
    // (a raid due this season: raidPlaces)
    const k = waveIn(l.season, this.host.firstWave);
    if (k !== null && !this.wave) {
      const a = k % SPAWNS;
      const n = waveSize(k);
      const { from, to } = raidPlaces(town, a);
      const g = f.spawnAt('raider', RAIDER_FACTION, from, n);
      f.orderGroup(g, { kind: 'attack', at: to });
      this.wave = { g, n, atGate: false, failed: false };
      console.log(`[forces] season ${l.season}: raid ${k} of ${n} from spawn point ${a}`);
    }
    const next = waveIn(l.season + 1, this.host.firstWave);
    this.soon = next !== null;
    this.nextIndex = next ?? 0;
    this.changed();
  }

  /** (scripts and shots) the groups now */
  debug(): { squads: unknown[]; wave: unknown } {
    const f = this.hooked;
    return { squads: this.squads.map((g) => f?.report(g)), wave: this.wave && { ...this.wave, report: f?.report(this.wave.g) } };
  }
}
