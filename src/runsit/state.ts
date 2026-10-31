// ---- runsit/state.ts --------------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG RS20-RS22) A situation run's state machine: where the hero is (an area played, its
// edge with the choices, a leg on the map, the end), the clock, the threat on its route, the pursuers behind, what the
// choices set going (the town warned, the people to be led out, the hold's levy on the march), the loadout — and, at
// the finale, what is spawned where (finaleSetup). Pure (no DOM, no GPU): unit-tested in Node, and the level's run
// (level-sit.ts) and the headless playthrough drive the same code.
// The user (round 120): "time pressure like pursuers or needing to reach your destination by some date"; "when the
// player reaches the boundary of an area they get the map and choices of where to go based on the actual situation".
//
// Time: the run's clock is in minutes. An area counts the seconds it was played; a leg counts its distance at the road
// pace (TRAVEL_PACE, hero-independent so a GM's clock is fair to every hero; a mount shortens it). The threat reaches
// the target at `threat.arrives` (+ delays); the finale starts the horde that many seconds in (capped), or with the
// town already burning when the hero is late.

import type { ItemDef, Loadout } from '../api/contracts/items';
import type { RegionId } from '../api/contracts/world';
import type { AreaPlay, Situation, SituationArea, SituationChoice, SituationEnd } from '../api/contracts/situation';
import { emptyLoadout, equip, totals } from './items.ts';

export type V2 = [number, number];

/** world units a run minute on the roads between areas (a hero's own speed counts inside an area, not between) */
export const TRAVEL_PACE = 500;
/** world units a run minute a levy marches */
export const LEVY_PACE = 260;
/** minutes every leg takes at least (setting out, the map) */
export const LEG_MIN = 0.25;
/** of each minute on the road, the share the pursuers close (a mount's pace closes less: pace × this) */
export const PURSUIT_CLOSE = 0.5;
/** the horde comes into the finale at most this many seconds in (an early hero doesn't wait minutes) */
export const HORDE_CAP_S = 60;
/** a late hero finds a fire set for each this many seconds the horde has been in the town, up to BURNING_MAX */
export const BURNING_EVERY_S = 40;
export const BURNING_MAX = 4;
/** the warned town's levy that stands with its guards */
export const MILITIA = 4;

/** where things are, for the run (world units on the torus): the areas, the route's regions */
export interface SituationMap {
  world: { w: number; h: number };
  areaAt(a: SituationArea): V2;
  regionCentre(r: RegionId): V2;
}

export type Phase = 'area' | 'edge' | 'travel' | 'ended';

/** how an area came out (the live play's report, or a test's) */
export interface AreaResult {
  seconds: number;
  /** its goal met (the message delivered, the trader reached, the edge reached) */
  won: boolean;
  heroDied?: boolean;
  /** outriders still hunting the hero when it left (0: lost or cut down) */
  pursuers?: number;
}

export interface ChoiceOption {
  choice: SituationChoice;
  to: SituationArea;
  /** minutes on the road */
  legMinutes: number;
  /** the run minute the hero would get there, and the threat's arrival at the target (with what this choice slows) */
  arriveAt: number;
  hordeAt: number;
  /** a line from the actual state: "you'd be there 3 min before the dead" */
  note: string;
}

export interface FinaleSetup {
  mode: 'defend' | 'evacuate';
  warned: boolean;
  /** the horde's size at the town */
  horde: number;
  role: string;
  faction: string;
  /** seconds into the finale it reaches the town; ≤ 0: it's been there that long */
  hordeIn: number;
  /** fires already set when the hero gets there */
  burning: number;
  /** the town's levy beside its guards (warned) */
  militia: number;
  /** the hold's levy and when it comes (seconds into the finale) */
  reinforce: { faction: string; role: string; count: number; in: number } | null;
  /** outriders still on the hero */
  pursuers: { count: number; role: string; behind: number } | null;
  /** the way the horde comes from (unit vector, world units: from the town toward the route's last region but one) */
  from: V2;
}

export class SituationRun {
  clock = 0;
  at: string;
  phase: Phase = 'area';
  readonly path: { area: string; won: boolean; seconds: number }[] = [];
  readonly taken: string[] = [];
  warned = false;
  evacuate = false;
  /** minutes the threat was slowed */
  delay = 0;
  /** the hold's levy on the march: the run minute it reaches the target */
  reinforce: { faction: string; role: string; count: number; arrives: number } | null = null;
  pursuers: { count: number; role: string; behind: number } | null;
  loadout: Loadout = emptyLoadout();
  /** items on offer at this area's edge (pick one, or none) */
  offers: string[] = [];
  leg: { choice: SituationChoice; from: SituationArea; to: SituationArea; minutes: number; path: V2[] } | null = null;
  end: SituationEnd | null = null;
  readonly log: string[] = [];

  readonly sit: Situation;
  readonly map: SituationMap;

  // (no parameter properties: Node's type stripping runs this file for the validator, scripts/storycheck.mjs)
  constructor(sit: Situation, map: SituationMap) {
    this.sit = sit;
    this.map = map;
    this.at = sit.areas[0].id;
    const o = sit.threat.outriders;
    this.pursuers = o ? { count: o.count, role: o.role, behind: o.behind } : null;
  }

  area(id = this.at): SituationArea {
    const a = this.sit.areas.find((x) => x.id === id);
    if (!a) throw new Error(`situation ${this.sit.id}: no area ${id}`);
    return a;
  }

  item = (id: string): ItemDef => {
    const d = this.sit.items.find((x) => x.id === id);
    if (!d) throw new Error(`situation ${this.sit.id}: no item ${id}`);
    return d;
  };

  get finaleArea(): SituationArea {
    return this.sit.areas.find((a) => a.play.kind === 'town')!;
  }

  /** the run minute the threat reaches the target */
  hordeArrives(extraDelay = 0): number {
    return this.sit.threat.arrives + this.delay + extraDelay;
  }

  /** 0..1 along its route */
  hordeProgress(): number {
    return Math.max(0, Math.min(1, this.clock / this.hordeArrives()));
  }

  /** where the threat is now (world units), along its route's region centres */
  hordeAt(): V2 {
    const pts = this.sit.threat.route.map((r) => this.map.regionCentre(r));
    return along(pts, this.hordeProgress(), this.map.world);
  }

  private dist(a: V2, b: V2): number {
    const [dx, dy] = delta(a, b, this.map.world);
    return Math.hypot(dx, dy);
  }

  /** The area's play is over: its edge (the choices), or the end (the hero fell). */
  areaDone(r: AreaResult): void {
    if (this.phase !== 'area') throw new Error(`situation: areaDone in phase ${this.phase}`);
    const a = this.area();
    this.clock += areaMinutes(a.minutes, r.seconds);
    this.path.push({ area: a.id, won: r.won, seconds: r.seconds });
    this.log.push(`${a.id} (${a.play.kind}) ${r.won ? 'won' : 'lost'} in ${r.seconds.toFixed(0)} s; clock ${this.clock.toFixed(1)}`);
    if (r.heroDied) return this.finish('fell');
    if (this.pursuers) {
      const left = r.pursuers ?? this.pursuers.count;
      // (they leave the area right behind the hero, or are lost or cut down for good)
      this.pursuers = left > 0 ? { ...this.pursuers, count: left, behind: Math.min(this.pursuers.behind, 1) } : null;
    }
    const p = a.play;
    if (p.kind === 'deliver' && r.won) {
      const target = this.finaleArea;
      const march = this.dist(this.map.areaAt(a), this.map.areaAt(target)) / LEVY_PACE;
      this.reinforce = { ...p.sends, arrives: this.clock + march };
      this.log.push(`the levy of ${a.name} marches: at ${target.name} by minute ${this.reinforce.arrives.toFixed(1)}`);
      this.offers = [...(p.gives ?? [])];
    } else if (p.kind === 'trader' && r.won) this.offers = [...p.offers];
    else this.offers = [];
    if (p.kind === 'town') throw new Error('situation: the finale ends with finish(), not areaDone()');
    this.phase = 'edge';
  }

  /** take one of the offers (null: none); what it displaces is put down */
  take(id: string | null): void {
    if (id !== null) {
      if (!this.offers.includes(id)) throw new Error(`situation: ${id} isn't on offer here`);
      this.loadout = equip(this.loadout, this.item(id), this.item);
      this.log.push(`took ${id}`);
    }
    this.offers = [];
  }

  private legMinutes(from: SituationArea, to: SituationArea): number {
    const pace = totals(this.loadout, this.item).pace;
    return LEG_MIN + (this.dist(this.map.areaAt(from), this.map.areaAt(to)) / TRAVEL_PACE) * pace;
  }

  /** the ways on from here, each with what the actual state says of it */
  options(): ChoiceOption[] {
    const a = this.area();
    const target = this.finaleArea;
    return this.sit.choices
      .filter((c) => c.from === a.id)
      .map((choice) => {
        const to = this.area(choice.to);
        const legMinutes = this.legMinutes(a, to);
        const slows = choice.effects.reduce((s, e) => s + (e.kind === 'delay' ? e.minutes : 0), 0);
        const hordeAt = this.hordeArrives(slows);
        const arriveAt = this.clock + legMinutes;
        // (to the town: before or after the dead; elsewhere: how long the town has left when you get there)
        const after = to.id === target.id ? 0 : estimateOn(this, to, target);
        const there = arriveAt + after;
        const lead = hordeAt - there;
        const note =
          to.id === target.id
            ? lead >= 0
              ? `you'd reach ${target.name} ${fmt(lead)} before the dead`
              : `the dead would be in ${target.name} ${fmt(-lead)} before you`
            : lead >= 0
              ? `${target.name} by about minute ${there.toFixed(0)}, ${fmt(lead)} before the dead`
              : `${target.name} by about minute ${there.toFixed(0)}, ${fmt(-lead)} after the dead`;
        return { choice, to, legMinutes, arriveAt, hordeAt, note };
      });
  }

  /** take a way on: the leg to travel */
  choose(id: string): NonNullable<SituationRun['leg']> {
    if (this.phase !== 'edge') throw new Error(`situation: choose in phase ${this.phase}`);
    const choice = this.sit.choices.find((c) => c.id === id && c.from === this.at);
    if (!choice) throw new Error(`situation: no choice ${id} from ${this.at}`);
    this.offers = [];
    for (const e of choice.effects) {
      if (e.kind === 'warn') this.warned = true;
      else if (e.kind === 'evacuate') this.evacuate = true;
      else if (e.kind === 'delay') this.delay += e.minutes;
    }
    this.taken.push(id);
    const from = this.area();
    const to = this.area(choice.to);
    const a = this.map.areaAt(from);
    const [dx, dy] = delta(a, this.map.areaAt(to), this.map.world);
    this.leg = { choice, from, to, minutes: this.legMinutes(from, to), path: [a, [a[0] + dx, a[1] + dy]] };
    this.phase = 'travel';
    this.log.push(`chose ${id}: ${from.id} → ${to.id}, ${this.leg.minutes.toFixed(1)} min on the road`);
    return this.leg;
  }

  /** the leg's travel done: the clock on, the pursuers closer, the next area */
  arrive(): void {
    if (this.phase !== 'travel' || !this.leg) throw new Error(`situation: arrive in phase ${this.phase}`);
    const m = this.leg.minutes;
    this.clock += m;
    if (this.pursuers) {
      const pace = totals(this.loadout, this.item).pace;
      this.pursuers.behind -= m * PURSUIT_CLOSE * pace;
    }
    this.at = this.leg.to.id;
    this.leg = null;
    this.phase = 'area';
    this.log.push(`at ${this.at}, minute ${this.clock.toFixed(1)}${this.pursuers ? `; outriders ${this.pursuers.behind.toFixed(1)} min behind` : ''}`);
  }

  /** what the finale spawns where, from everything the run did */
  finaleSetup(): FinaleSetup {
    const a = this.area();
    if (a.play.kind !== 'town') throw new Error(`situation: the finale is played at the town, not ${a.id}`);
    const th = this.sit.threat;
    const left = (this.hordeArrives() - this.clock) * 60;
    const hordeIn = Math.min(HORDE_CAP_S, left);
    const route = th.route;
    const prev = route.length > 1 ? route[route.length - 2] : route[0];
    const town = this.map.areaAt(a);
    const [dx, dy] = delta(town, this.map.regionCentre(prev), this.map.world);
    const l = Math.hypot(dx, dy) || 1;
    return {
      mode: this.evacuate ? 'evacuate' : 'defend',
      warned: this.warned,
      horde: th.count,
      role: th.role,
      faction: th.faction,
      hordeIn,
      burning: hordeIn < 0 ? Math.min(BURNING_MAX, Math.ceil(-hordeIn / BURNING_EVERY_S)) : 0,
      militia: this.warned && hordeIn > 0 ? MILITIA : 0,
      reinforce: this.reinforce ? { faction: this.reinforce.faction, role: this.reinforce.role, count: this.reinforce.count, in: Math.max(8, (this.reinforce.arrives - this.clock) * 60) } : null,
      pursuers: this.pursuers && this.pursuers.count > 0 ? { ...this.pursuers } : null,
      from: [dx / l, dy / l],
    };
  }

  /** the run is over */
  finish(end: SituationEnd, seconds = 0): void {
    if (this.phase === 'ended') return;
    if (seconds) {
      this.clock += seconds / 60;
      this.path.push({ area: this.at, won: end === 'saved' || end === 'evacuated', seconds });
    }
    this.end = end;
    this.phase = 'ended';
    this.log.push(`ended ${end} at minute ${this.clock.toFixed(1)}`);
  }
}

/**
 * An area's minutes on the run's clock: its planned minutes (the GM's budget — what the fork's timing was written
 * against), more when it was played slower, up to half again (runplan/clock.ts's rule for a stage). Why not the played
 * seconds alone: round 120's first playthrough had the bike through a planned 2.5-minute area in 16 s, so the hold's
 * way — written late — arrived early and the fork meant nothing; the GM's clock is the situation's, the play is how
 * well it's met.
 */
export function areaMinutes(planned: number, seconds: number): number {
  return planned * Math.min(1.5, Math.max(1, seconds / 60 / Math.max(planned, 0.01)));
}

/** minutes from area `a` to the target along the quickest way on (its planned minutes and legs) */
function estimateOn(r: SituationRun, a: SituationArea, target: SituationArea, seen = new Set<string>()): number {
  if (a.id === target.id) return 0;
  if (seen.has(a.id)) return Infinity;
  seen.add(a.id);
  let best = Infinity;
  for (const c of r.sit.choices.filter((x) => x.from === a.id)) {
    const to = r.area(c.to);
    const [dx, dy] = delta(r.map.areaAt(a), r.map.areaAt(to), r.map.world);
    const m = a.minutes + LEG_MIN + (Math.hypot(dx, dy) / TRAVEL_PACE) * totals(r.loadout, r.item).pace;
    best = Math.min(best, m + estimateOn(r, to, target, new Set(seen)));
  }
  return best;
}

/** Every path's planned minutes from areas[0] to the finale (the GM's and the checker's estimate), as area ids. */
export function pathEstimates(sit: Situation, map: SituationMap): { areas: string[]; minutes: number; effects: string[]; /** the threat's arrival on this path (its delays counted) */ threat: number }[] {
  const out: { areas: string[]; minutes: number; effects: string[]; threat: number }[] = [];
  const byId = new Map(sit.areas.map((a) => [a.id, a]));
  const walk = (a: SituationArea, areas: string[], minutes: number, effects: string[], delay = 0) => {
    if (a.play.kind === 'town') return void out.push({ areas: [...areas, a.id], minutes, effects, threat: sit.threat.arrives + delay });
    if (areas.includes(a.id)) return;
    for (const c of sit.choices.filter((x) => x.from === a.id)) {
      const to = byId.get(c.to);
      if (!to) continue;
      const [dx, dy] = delta(map.areaAt(a), map.areaAt(to), map.world);
      walk(to, [...areas, a.id], minutes + a.minutes + LEG_MIN + Math.hypot(dx, dy) / TRAVEL_PACE, [...effects, ...c.effects.map((e) => e.kind)], delay + c.effects.reduce((m, e) => m + (e.kind === 'delay' ? e.minutes : 0), 0));
    }
  };
  walk(sit.areas[0], [], 0, []);
  return out;
}

export function delta(a: V2, b: V2, world: { w: number; h: number }): V2 {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  dx -= Math.round(dx / world.w) * world.w;
  dy -= Math.round(dy / world.h) * world.h;
  return [dx, dy];
}

/** a point 0..1 along a polyline of world points (each step the short way round the torus) */
export function along(pts: V2[], t: number, world: { w: number; h: number }): V2 {
  if (pts.length === 1) return [...pts[0]];
  const steps: V2[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = delta(pts[i - 1], pts[i], world);
    steps.push(d);
    total += Math.hypot(d[0], d[1]);
  }
  let want = Math.max(0, Math.min(1, t)) * total;
  let at: V2 = [...pts[0]];
  for (const d of steps) {
    const l = Math.hypot(d[0], d[1]);
    if (want <= l) {
      const k = l > 0 ? want / l : 0;
      return [at[0] + d[0] * k, at[1] + d[1] * k];
    }
    want -= l;
    at = [at[0] + d[0], at[1] + d[1]];
  }
  return at;
}

function fmt(m: number): string {
  return m < 1 ? `${Math.round(m * 60)} s` : `${m.toFixed(1)} min`;
}

/** the kinds of play, for a card */
export const PLAY_TITLE: Record<AreaPlay['kind'], string> = {
  flee: 'Outriders on your heels',
  ambush: 'An ambush on the road',
  deliver: 'The message',
  trader: 'A trader at the crossroads',
  town: 'The town',
};
