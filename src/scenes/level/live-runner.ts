// (loop-skeleton round 6; docs/SYSTEMS.md recipe 6) The one runner of live events. It plays any `LiveDef`
// (living/live.ts) in the live city: makes its groups (at a named place of the town, at a site, or in by a road), sends
// them on their orders, sets its hazard going, follows it with the story camera, lets the player cast the spells it
// allows, and counts how it stands from what the units already tell (died, hurt, arrived) — no read of the units. An
// event goes on while the player is elsewhere; `finish` hands the realm its state (season/realm.ts finishLive), which
// reads the result, applies the synergy rules and resolves the template at the tier that fits.
// Made from the loop's two hand-written copies (`playDead`, and `beginAttack` / `nextRoad` / `watchFight` /
// `endAttack`), which it replaces: the raid, the dead, a parade, a fire and refugees are all data on this.
//
// What it reads back: a hazard's points, through the fire mirror's pages (a few KB, every HAZARD_READ seconds while a
// fire event runs, never at idle); nothing else.
// FIXED-CITY (BACKLOG LS-40): every place is the home town's (its place table's slot, its sites, its roads).
import { PLACE, type GroupId, type PlaceRef } from '../../api/contracts/townplaces';
import type { FieldTown } from '../../citygen/town';
import type { Offer } from '../../living/engine';
import { groupSize, liveEnded, liveRead, type LiveDef, type LiveGroup, type LiveState, type LiveVars, type LiveWhere } from '../../living/live';
import type { ForceKind } from '../../season/forces';
import type { LiveTold, Realm } from '../../season/realm';
import { roadLook } from '../../season/realm';
import type { SiteKey } from '../../season/realm-templates';
import type { Marker } from '../../season/run-ui';
import type { SeasonLoop } from '../../season/loop';
import { townHeart } from '../../season/war';
import type { StoryCamera, V3 } from '../../story/camera';
import { cellAt } from '../../world/lattice';
import { MAT } from '../../world/materials';
import type { LevelScene } from '../level';
import { REGION } from '../streamer/defs';
import type { Spring } from '../../flow/liquid';
import { EventKind } from '../../sim/globals';
import type { LiveFront } from '../../living/live';

/** the window slides when the camera comes within this many regions of its edge (scenes/streamer.ts update): the
 *  cells round the camera's target the window is sure to hold are half the window less that; and the margin kept
 *  inside it for the spawn point's crowd */
const SLIDE_REGIONS = 1.25;
const SURE_MARGIN = 12;
/** frames the window must be still before a group is brought in by a road: the place table's spawn points wake a solve
 *  at most every 120 frames (towncontracts/places.wgsl WET_GAP), and the solve lands a frame or two later */
const PLACE_SETTLE_FRAMES = 130;
/** frames after a spawn by which its refusal has been told (the units' events are read a frame or two behind) */
const SPAWN_TOLD_FRAMES = 20;
/** seconds a column must have stood on its road before the player may leave it (a refusal told late is past) */
const ENTRY_SURE = 3;
/** the camera's zoom down a road before a group comes in by it */
const ROAD_ZOOM = 4;
/** the camera's pitch on an event with figures to follow (radians): lower than the town's 60°, so a standing figure
 *  is taller on the screen */
const EVENT_PITCH = (40 * Math.PI) / 180;
/** the zoom the camera pulls back to when an event the player must stay at is over */
const AFTER_ZOOM = 5;
/** (loop round 11) the share of the screen's width an event's two framed sides span at most, and the zoom it never
 *  pulls back past for them (px a cell) */
const FIT_SHARE = 0.6;
const FIT_FLOOR = 16;
/** (loop round 11) how near an event's two framed sides come (cells) before the camera frames both; until then it is
 *  on the ones it follows (seen: a crew still crossing the river framed with the fighter pulled the camera out to 10) */
const FRAME_NEAR = 20;
/** seconds between reads of a hazard's points, and the seconds alight after which a point's lot has burned down */
const HAZARD_READ = 2;
const BURN_SECONDS = 12;
/** seconds after a hazard's stalls are put down that they are lit (the edit lands at the next tick, its chunk's surface
 *  word a tick or two after) */
const LIGHT_AFTER = 1;
/** (round 7) spots a stall is tried at, for each stall wanted */
const STALL_TRIES = 2;
/** (round 8) how far a group told to hold a site chases a foe from it (cells; tunable) */
const SITE_GUARD = 8;
/** an event's units' factions */
const FACTION = { town: 'f-town', foe: 'f-raiders', folk: 'f-town' } as const;
/** the units' kinds a group may be made of by place (season/forces.ts ForceKind) */
const BY_PLACE: Record<string, ForceKind> = { raider: 'raider', guard: 'soldier', soldier: 'soldier', worker: 'worker', cart: 'cart' };

interface RunGroup {
  def: LiveGroup;
  /** made by place: the forces' group; by a site: its units; 'squads': the war's own groups */
  force: GroupId | null;
  units: Set<number>;
  squads: boolean;
  made: number;
  /** dead when the event began (the squads': their groups' own count runs on) */
  dead0: number;
  dead: number;
  arrived: boolean;
  /** (round 8, LS-77) an entering group first marches in along its road's gate route in a column (`march` inward);
   *  at the gate its own order is given. The order waiting, with the road's place refs */
  leg?: { k: number; to?: PlaceRef } | null;
}

/** a group that comes in by a road */
const entering = (g: LiveGroup): boolean => typeof g.from === 'object' && 'place' in g.from && g.from.place === 'spawn' && g.from.road === 'entry';
/** (round 7) the time of day an event is played in: one begun at night is played from morning (figures at night are
 *  dark on dark ground; seen in round 6's parade). A first guess, tunable (BACKLOG LS-66) */
const LIVE_DAY = { from: 0.27, to: 0.7, start: 0.3 };
/** (round 7) watchers lining a road: on its points from this share of the way out of the town's middle to that, this
 *  far to each side of its middle line (cells) */
const LINE_FROM = 0.18;
const LINE_TO = 0.75;
const LINE_SIDE = 2.4;

export interface LiveRun {
  id: string;
  template: string;
  def: LiveDef;
  /** the site the card stands at, and its window point */
  site: SiteKey | null;
  t: number;
  groups: Map<string, RunGroup>;
  /** the group that comes in by a road: the road being tried, straight for the heart (no gate standing), and how far */
  entry: { road: number; tried: number; direct: boolean; step: 'look' | 'settle' | 'called' | 'in' | 'none'; calm: number } | null;
  /** the fire's stalls (before they are lit: every spot tried; `picking` while the ground under them is read) */
  hazard: { points: { at: [number, number]; alightFor: number; alight: boolean; burned: boolean }[]; lit: boolean; picking: boolean; read: number; told?: boolean } | null;
  /** (loop round 12) a front: its source, its points in the town and along its way, its spring while it pours */
  front: Front | null;
  casts: Record<string, number>;
  absent: Record<string, number>;
  fighting: boolean;
  unwatch: (() => void)[];
  /** where its marchers started and where they were last seen (window points): the way they took */
  from: V3 | null;
  last: V3 | null;
  fx: number;
  over: boolean;
  ending?: boolean;
  /** (round 7) seconds into its finale (LiveDef.finale); undefined: not begun */
  finale?: number;
}

/** (loop round 12, docs/design/FRONTS.md) a point a front may reach: its window point, the depth read there first (a
 *  river's water is not a flood), and whether the front has reached it */
interface FrontPoint {
  at: [number, number];
  base: number | null;
  reached: boolean;
}
interface Front {
  /** the target's window point, and the source's (null until the ground round the target has been read) */
  target: [number, number];
  src: [number, number, number] | null;
  picking: boolean;
  /** the town's points (the result), and points along the way from the source (the camera's head, the land changed) */
  points: FrontPoint[];
  way: FrontPoint[];
  /** the spring poured into the liquid (removed when the pour is over or the event closes) */
  spring: Spring | null;
  read: number;
  awake: number;
}

/** (loop round 12) a front's reads: seconds between them; the depth over a point's first that is the front there; the
 *  points along its way; the seconds it keeps running after the pour stops (the event's `out` waits for them); the
 *  chunks kept awake round its way (cells), and how long each touch keeps them (s) */
const FRONT_READ = 2;
const FRONT_DEPTH = { lava: 0.15, water: 0.3 };
const FRONT_WAY = 10;
const FRONT_SETTLE = 15;
const FRONT_AWAKE_R = 18;
const FRONT_AWAKE_S = 3;
/** the ways round the target the source is looked for on */
const FRONT_WAYS = 16;
/** (loop round 12) once a lava front's event is over: its way kept awake this many seconds more while its lava cools
 *  this many times faster and sets (a pool 4 cells deep otherwise glows ~100 s, and in a sleeping chunk for good) */
const FRONT_SET_S = 20;
const FRONT_QUENCH = 25;

/** (round 7) an event's people walking off after it is over: let go when the seconds are up */
interface Leaving {
  forces: GroupId[];
  units: number[];
  left: number;
}

export interface LiveHost {
  scene: LevelScene;
  cam: StoryCamera;
  season: SeasonLoop;
  realm(): Realm | null;
  town(): FieldTown | undefined;
  /** a site's window point */
  spot(site: SiteKey): [number, number] | null;
  z(x: number, y: number): number;
  changed(): void;
  /** an event has ended by itself (its `ends`, its seconds, or no road for it): the host resolves it (`told`) */
  ended(run: LiveRun): void;
}

export class LiveRunner {
  readonly runs: LiveRun[] = [];
  /** the event the player is at (the camera on it, its spells on the sheet); null: in the town */
  focus: LiveRun | null = null;
  private speed0 = 1;
  private pitch0 = Math.PI / 3;
  private hooked = false;
  /** the road the last entering column came in by (0: none yet, or the first) */
  private roadTaken = 0;
  /** a unit of an event → its run and group */
  private ofUnit = new Map<number, [LiveRun, RunGroup]>();
  /** (round 7) people of events that are over, walking off */
  private leaving: Leaving[] = [];
  /** (loop round 12) lava fronts whose events are over, setting: their way kept awake, the lava's cooling quickened */
  private setting: { f: Front; left: number; awake: number }[] = [];

  constructor(private h: LiveHost) {}

  private hook(): void {
    const units = this.h.scene.units;
    const forces = this.h.scene.townForces;
    if (this.hooked || !units || !forces) return;
    this.hooked = true;
    units.died.push((v) => {
      const hit = this.ofUnit.get(v.id as number);
      if (!hit) return;
      hit[1].units.delete(v.id as number);
      if (!hit[1].force && !hit[1].squads) hit[1].dead++;
      this.ofUnit.delete(v.id as number);
    });
    // (a blow on anyone of an event: its fight has begun)
    forces.hurt.push((g) => {
      for (const r of this.runs) if (!r.fighting && [...r.groups.values()].some((x) => x.force === g || (x.squads && this.h.season.war?.squadGroups.includes(g)))) r.fighting = true;
    });
    units.hurt.push((v) => {
      const hit = this.ofUnit.get(v.id as number);
      if (hit) hit[0].fighting = true;
    });
    forces.arrived.push((g) => {
      for (const r of this.runs)
        for (const x of r.groups.values()) {
          if (x.force !== g) continue;
          // (round 8: in at the gate by the road — now the group's own order, from the gate)
          if (x.leg) this.onward(r, x, 'at the gate');
          else x.arrived = true;
        }
    });
    forces.orderFailed.push((g, why) => {
      for (const r of this.runs) for (const x of r.groups.values()) if (x.force === g && x.leg) this.onward(r, x, `no march in (${why})`);
    });
  }

  /** (round 8) a group's march in along its road ended (at the gate, or it could not march): its own order now */
  private onward(run: LiveRun, rg: RunGroup, why: string): void {
    const leg = rg.leg!;
    rg.leg = null;
    console.log(`[live] ${run.template}: ${rg.def.id} ${why}; on to its place`);
    this.order(run, rg, leg.k, leg.to);
  }

  /** the world's fire, particles and ground: a level without them cannot play an event (said, not skipped) */
  private get api() {
    const a = this.h.scene.worldApi;
    if (!a?.fire || !a.fx || !a.terrain) throw new Error('live events: this level has no world API for fire, particles and ground');
    return { fire: a.fire, fx: a.fx, terrain: a.terrain };
  }

  private get townIndex(): number {
    const s = this.h.scene;
    return this.h.season.town !== null && s.townContracts ? s.townContracts.townIndex(this.h.season.town) : -1;
  }

  /** a place of the town's table for an order or a spawn; `k`: the road an entering group came by */
  private ref(w: LiveWhere, k: number): PlaceRef {
    const town = this.townIndex;
    if ('site' in w) throw new Error('live event: a group made by place cannot be sent to a site (a point); name a place of the town');
    if (w.place === 'heart') return townHeart(town);
    if ('road' in w) return { town, place: (w.place === 'gate' ? PLACE.gate0 : PLACE.spawn0) + (w.road === 'entry' ? k : w.road) };
    return { town, place: PLACE[w.place], ...(w.else ? { else: this.ref(w.else, k) } : {}) };
  }

  /** a site's window point ('here': the card's own site) */
  private point(run: LiveRun, w: LiveWhere): [number, number] | null {
    if (!('site' in w)) return null;
    const key = w.site === 'here' ? run.site : (w.site as SiteKey);
    return key ? this.h.spot(key) : null;
  }

  /** a live event begun: its groups made (those that come in by a road once the camera is down it), its hazard set
   *  going, the player taken there */
  start(o: Offer, def: LiveDef, site: SiteKey | null): LiveRun {
    this.hook();
    const run: LiveRun = { id: o.id, template: o.template, def, site, t: 0, groups: new Map(), entry: null, hazard: null, front: null, casts: {}, absent: {}, fighting: false, unwatch: [], from: null, last: null, fx: 0, over: false };
    const numbers = this.h.realm()!.runNumbers();
    const units = this.h.scene.units!;
    const forces = this.h.scene.townForces!;
    for (const g of def.groups) {
      const n = groupSize(g, numbers);
      const rg: RunGroup = { def: g, force: null, units: new Set(), squads: g.from === 'squads', made: 0, dead0: 0, dead: 0, arrived: false };
      run.groups.set(g.id, rg);
      if (g.from === 'lining') {
        // (made with the entering group, along its road: enter)
      } else if (g.from === 'squads') {
        const war = this.h.season.war;
        const gs = war?.squadGroups ?? [];
        rg.made = gs.reduce((s, x) => s + (forces.report(x)?.alive ?? 0), 0);
        rg.dead0 = gs.reduce((s, x) => s + (forces.report(x)?.dead ?? 0), 0);
        run.unwatch.push(units.observe(gs.flatMap((x) => forces.members(x))));
      } else if ('site' in g.from) {
        // (at a site: in two clumps `spread` apart, as the dead of round 3 were)
        const at = this.point(run, g.from) ?? this.h.town()!.centreInWindow();
        const spread = g.spread ?? 4;
        for (let k = 0; k < n; k++) {
          const clump = k < Math.ceil(n / 2) ? -1 : 1;
          const id = units.spawn(g.kind, [at[0] + clump * spread * 0.5 + (k % 3) * 1.4, at[1] + clump * 2 + (k % 2) * 1.6], g.side === 'foe' ? null : FACTION[g.side], { hostile: g.side === 'foe' }) as number;
          rg.units.add(id);
          this.ofUnit.set(id, [run, rg]);
        }
        rg.made = n;
        // (people who stand where they were put are where they are going)
        rg.arrived = !g.order;
        // (round 8: ordered to hold their own site — a pack bout's fighter: they hold it, chasing foes near it)
        if (g.order && 'site' in g.order.at) {
          const p = this.point(run, g.order.at) ?? at;
          for (const id of rg.units) units.order(id, { kind: 'guard', at: p, radius: SITE_GUARD });
          rg.arrived = true;
        }
        run.unwatch.push(units.observe([...rg.units]));
      } else if (g.from.place === 'spawn' && g.from.road === 'entry') {
        run.entry ??= { road: -1, tried: 0, direct: false, step: 'none', calm: 0 };
      } else this.make(run, rg, n, this.ref(g.from, 0), 0);
    }
    if (def.hazard?.kind === 'front') this.startFront(run, def.hazard);
    else if (def.hazard) {
      const c = this.point(run, def.hazard.at) ?? this.h.town()!.centreInWindow();
      const hz = def.hazard;
      const terrain = this.api.terrain;
      // (round 7: twice as many spots as stalls; once the canvas is down, the stalls are the first spots whose ground
      // took it — water, a building's lot or a paved square does not, and a stall there never caught: LS-63)
      const points = Array.from({ length: hz.points * STALL_TRIES }, (_, k) => {
        const a = (k / hz.points) * Math.PI * 2 + 0.4 + (k >= hz.points ? Math.PI / hz.points : 0);
        const r = hz.spread * (k >= hz.points ? 1.25 : 0.45 + (0.55 * ((k * 7) % 3)) / 2);
        const at: [number, number] = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
        // (what burns: a stall's canvas at each spot — the fire system burns canvas, timber and plants, and the
        // generated buildings are meshes it does not know)
        terrain.build(at[0], at[1], 'canvas', { radius: 1.6, layers: 2 });
        return { at, alightFor: 0, alight: false, burned: false };
      });
      run.hazard = { points, lit: false, picking: false, read: 0 };
    }
    this.runs.push(run);
    // (round 7: played by day, and the day held while it runs — the sim's speed on the march ran a parade into night)
    const day = this.h.scene.core.dayNight;
    if (day.timeOfDay < LIVE_DAY.from || day.timeOfDay > LIVE_DAY.to) day.timeOfDay = LIVE_DAY.start;
    day.held = true;
    this.goTo(run);
    // (the road that took the last column is tried first: a road whose spawn point is in water stays so)
    if (run.entry && this.roadTaken > 0) run.entry.road = this.roadTaken - 1;
    if (run.entry) this.nextRoad(run);
    console.log(`[live] ${run.template} begun: ${[...run.groups.values()].map((g) => `${g.def.id} ${g.made}`).join(', ')}${run.hazard ? `, fire at ${run.hazard.points.length} spots` : ''}${run.front ? `, a ${run.def.hazard!.kind === 'front' ? (run.def.hazard as LiveFront).liquid : ''} front on ${run.front.points.length} points` : ''}`);
    return run;
  }

  // ---- a front (loop round 12, docs/design/FRONTS.md) ------------------------------------------------------------------

  /**
   * A front set going: its points round the target (the town's, as a fire's stalls are placed) and the ground round the
   * target read once — the highest of FRONT_WAYS points `far` cells out is the source, uphill of the town (FIXED-CITY: the
   * target is a place of the live town; BACKLOG LS-121: a CPU read of 16 heights, not a GPU pass). The spring is poured
   * there; the liquid runs down the ground as it lies.
   */
  private startFront(run: LiveRun, hz: LiveFront): void {
    const c = this.point(run, hz.at) ?? this.h.town()!.centreInWindow();
    const target: [number, number] = [c[0], c[1]];
    const points: FrontPoint[] = Array.from({ length: hz.points }, (_, k) => {
      const a = (k / hz.points) * Math.PI * 2 + 0.4;
      // (within 0.9 of the spread: a shield as wide as the spread, cast on the target, covers every point)
      const r = hz.spread * (0.3 + (0.6 * ((k * 7) % 4)) / 3);
      return { at: [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r], base: null, reached: false };
    });
    const f: Front = { target, src: null, picking: true, points, way: [], spring: null, read: 0, awake: 0 };
    run.front = f;
    const terrain = this.api.terrain;
    const R = hz.far + 4;
    void terrain.load(c[0] - R, c[1] - R, c[0] + R, c[1] + R).then(
      () => {
        if (run.over) return;
        let best: [number, number, number] | null = null;
        for (let k = 0; k < FRONT_WAYS; k++) {
          const a = (k / FRONT_WAYS) * Math.PI * 2;
          const x = f.target[0] + Math.cos(a) * hz.far;
          const y = f.target[1] + Math.sin(a) * hz.far;
          if (!terrain.inWindow(x, y)) continue;
          const z = terrain.surfaceAt(x, y)?.z;
          if (z !== undefined && (!best || z > best[2])) best = [x, y, z];
        }
        f.picking = false;
        if (!best) {
          console.error(`[live] ${run.template}: no ground ${hz.far} cells round the target was read; the front has no source`);
          return;
        }
        f.src = best;
        for (let k = 1; k <= FRONT_WAY; k++) {
          const t = k / (FRONT_WAY + 1);
          f.way.push({ at: [best[0] + (f.target[0] - best[0]) * t, best[1] + (f.target[1] - best[1]) * t], base: null, reached: false });
        }
        const L = this.h.scene.core.flow[hz.liquid];
        L.addSpring(best[0], best[1], best[2] + 1, hz.rate);
        f.spring = L.springs[L.springs.length - 1];
        this.wakeFront(f);
        console.log(`[live] ${run.template}: ${hz.liquid} poured at ${best.map((v) => v.toFixed(0)).join(', ')} (${hz.far} cells from the target, the highest of ${FRONT_WAYS} ways; the target's ground ${(terrain.surfaceAt(f.target[0], f.target[1])?.z ?? NaN).toFixed(1)}), ${hz.rate} a second for ${hz.pour} s`);
        if (this.focus === run) this.lookFront(run);
      },
      (e) => console.error(`[live] ${run.template}: the ground round its target could not be read: ${e}`),
    );
  }

  /** the chunks between the front's source and its target kept awake (sleeping chunks freeze liquid, and the hybrid
   *  wakes only chunks an event has touched: hybrid.edit) */
  private wakeFront(f: Front): void {
    if (!f.src) return;
    const scene = this.h.scene;
    const now = performance.now() / 1000;
    const along = [[f.src[0], f.src[1]] as [number, number], ...f.way.map((p) => p.at), f.target];
    for (const [x, y] of along) {
      scene.hybrid?.edit(x, y, FRONT_AWAKE_R, EventKind.Ripple);
      scene.sleep?.wake(x, y, FRONT_AWAKE_R, FRONT_AWAKE_S, now);
    }
  }

  /** where a front is: its head (the farthest point along its way it has reached), the source before it reaches any */
  private frontAt(f: Front): [number, number] | null {
    if (!f.src) return null;
    const head = [...f.way].reverse().find((p) => p.reached);
    const at: [number, number] = head ? head.at : [f.src[0], f.src[1]];
    // (a shield raised, or the town reached: the town as the front meets it — halfway between the head and the target)
    if (f.points.some((p) => p.reached) || this.h.scene.worldApi?.shields?.list.length) return [(at[0] + f.target[0]) / 2, (at[1] + f.target[1]) / 2];
    return at;
  }

  /** the camera on the front: its source as it opens, its head as it comes, the town once it is there */
  private lookFront(run: LiveRun): void {
    const at = run.front && this.frontAt(run.front);
    if (!at) return;
    void this.h.cam.look([at[0], at[1], this.h.z(at[0], at[1])], { zoom: run.def.camera.zoom, ease: 1.2, place: [0.5, 0.4] }).then(() => {
      if (this.focus !== run || run.over) return;
      this.h.cam.follow(() => {
        const p = run.front && this.frontAt(run.front);
        return p ? [p[0], p[1], this.h.z(p[0], p[1])] : null;
      });
    });
  }

  /** a front each frame: the pour stopped when its seconds are up, its way kept awake, its points read */
  private front(run: LiveRun, dt: number): void {
    const f = run.front;
    const hz = run.def.hazard;
    if (!f || !f.src || hz?.kind !== 'front') return;
    if (f.spring && run.t >= hz.pour) this.stopPour(run);
    if ((f.awake -= dt) <= 0 && run.t < hz.pour + FRONT_SETTLE) {
      f.awake = 1;
      this.wakeFront(f);
    }
    if ((f.read += dt) < FRONT_READ) return;
    f.read = 0;
    const api = this.h.scene.worldApi;
    const depthAt = hz.liquid === 'lava' ? (x: number, y: number) => api?.fire?.flowLavaAt(x, y) ?? null : (x: number, y: number) => api?.water?.depthAt(x, y) ?? null;
    let fresh = 0;
    for (const p of [...f.points, ...f.way]) {
      // (the page holding the point is asked for and read a frame later: this is the value of the read before)
      const d = depthAt(p.at[0], p.at[1]);
      if (d === null) continue;
      if (p.base === null) p.base = d;
      if (!p.reached && d - p.base > FRONT_DEPTH[hz.liquid]) {
        p.reached = true;
        fresh++;
      }
    }
    if (fresh) console.log(`[live] ${run.template}: the front reached ${f.points.filter((p) => p.reached).length} of ${f.points.length} points in the town, ${f.way.filter((p) => p.reached).length} of ${f.way.length} on its way (t ${run.t.toFixed(0)} s)`);
  }

  /** (loop round 12) lava fronts over: their way kept awake while their lava sets, quickly (FRONT_SET_S, FRONT_QUENCH) */
  private setFronts(dt: number): void {
    for (const s of [...this.setting]) {
      if ((s.left -= dt) <= 0) {
        this.setting.splice(this.setting.indexOf(s), 1);
        continue;
      }
      if ((s.awake -= dt) <= 0) {
        s.awake = 1;
        this.wakeFront(s.f);
      }
    }
    this.h.scene.core.flow.lava.quench = this.setting.length ? FRONT_QUENCH : 1;
  }

  private stopPour(run: LiveRun): void {
    const f = run.front;
    const hz = run.def.hazard;
    if (!f?.spring || hz?.kind !== 'front') return;
    const L = this.h.scene.core.flow[hz.liquid];
    const k = L.springs.indexOf(f.spring);
    if (k >= 0) L.springs.splice(k, 1);
    f.spring = null;
    console.log(`[live] ${run.template}: the pour is over (${run.t.toFixed(0)} s)`);
  }

  /** a group made at a place of the town and sent on its order */
  private make(run: LiveRun, rg: RunGroup, n: number, from: PlaceRef, k: number, to?: PlaceRef): void {
    const forces = this.h.scene.townForces!;
    const kind = BY_PLACE[rg.def.kind];
    if (!kind) throw new Error(`live event ${run.template}: no units of kind ${rg.def.kind} can be made by place`);
    rg.force = forces.spawnAt(kind, FACTION[rg.def.side], from, n);
    rg.made = n;
    // (its people's places read while the event runs: the camera follows them)
    run.unwatch.push(this.h.scene.units!.observe(forces.members(rg.force)));
    // (round 8, LS-77: a group in by a road marches in along the road's gate route in a column first; round 9, LS-89:
    // walled or not — without a wall gate slot k is the arterial's road route, from the central square out, so the
    // column comes down the main street to the square. No route (not traced yet, the pool full): told as a failed
    // order, and it goes on to its place by its field. `?marchin=0`: straight to its place, as before)
    if (rg.def.order && k >= 0 && entering(rg.def) && this.h.scene.host.params.get('marchin') !== '0') {
      rg.leg = { k, to };
      forces.orderGroup(rg.force, { kind: 'march', town: this.townIndex, gate: k, inward: true });
      return;
    }
    this.order(run, rg, k, to);
  }

  /** a group's own order (its def's), or `to` */
  private order(run: LiveRun, rg: RunGroup, k: number, to?: PlaceRef): void {
    const forces = this.h.scene.townForces!;
    if (rg.force === null) return;
    const o = rg.def.order;
    // (round 8: a pack event's group sent to a site — "the event", the card's own place — has no place of the town's
    // table to be ordered to as a group: each of its people is told to hold that point, chasing foes near it. LS-85)
    const point = o && !to && 'site' in o.at ? (this.point(run, o.at) ?? (this.h.town()!.centreInWindow() as [number, number])) : null;
    if (o && point) for (const id of forces.members(rg.force)) this.h.scene.units!.order(id, { kind: 'guard', at: point, radius: SITE_GUARD });
    else if (o) forces.orderGroup(rg.force, { kind: o.kind, at: to ?? this.ref(o.at, k), ...(o.formation ? { formation: o.formation } : {}), ...(o.discipline !== undefined ? { discipline: o.discipline } : {}) });
    else rg.arrived = true;
  }

  /**
   * (round 7) Watchers lining road k inside the town: n people stood in pairs, one each side of the road's middle line,
   * spread along it from LINE_FROM to LINE_TO of the way out of the town's middle (the road as the town laid it,
   * FieldTown.roadInWindow). They stand where they are put (a unit's own guard post); the column walks between them as
   * far as its way keeps to the road (a `go` takes the shortest walkable way: BACKLOG LS-64).
   */
  private line(run: LiveRun, rg: RunGroup, n: number, k: number): void {
    const units = this.h.scene.units!;
    const road = this.h.town()?.roadInWindow(k) ?? [];
    if (road.length < 2 || n <= 0) return;
    const acc = [0];
    for (let i = 1; i < road.length; i++) acc.push(acc[i - 1] + Math.hypot(road[i][0] - road[i - 1][0], road[i][1] - road[i - 1][1]));
    const len = acc[acc.length - 1];
    const pairs = Math.ceil(n / 2);
    for (let j = 0; j < n; j++) {
      const s = len * (LINE_FROM + ((LINE_TO - LINE_FROM) * (Math.floor(j / 2) + 0.5)) / pairs);
      let i = 1;
      while (i < road.length - 1 && acc[i] < s) i++;
      const [a, b] = [road[i - 1], road[i]];
      const seg = Math.max(acc[i] - acc[i - 1], 1e-6);
      const t = Math.min(1, Math.max(0, (s - acc[i - 1]) / seg));
      const side = j % 2 ? -1 : 1;
      // (across the road: its direction turned a quarter)
      const nx = -(b[1] - a[1]) / seg;
      const ny = (b[0] - a[0]) / seg;
      const at: [number, number] = [a[0] + (b[0] - a[0]) * t + nx * LINE_SIDE * side, a[1] + (b[1] - a[1]) * t + ny * LINE_SIDE * side];
      const id = units.spawn(rg.def.kind, at, FACTION[rg.def.side], { hostile: false }) as number;
      rg.units.add(id);
      this.ofUnit.set(id, [run, rg]);
    }
    rg.made = rg.units.size;
    rg.arrived = true;
    run.unwatch.push(units.observe([...rg.units]));
  }

  /** a group's own units taken out (a road refused after its watchers were stood along it) */
  private unmake(rg: RunGroup): void {
    for (const id of rg.units) {
      this.h.scene.units?.remove(id);
      this.ofUnit.delete(id);
    }
    rg.units.clear();
    rg.made = 0;
  }

  /**
   * (round 7, LS-63) The window slid (WorldCore.onShift: −d, the land's move): what the runner keeps in window points
   * moves with it — a hazard's points (lit, then read, seconds after they were placed: a slide between put the fire and
   * its reading on other ground), and where its marchers started and were last seen.
   */
  shift(dx: number, dy: number, dz: number): void {
    for (const s of this.setting) {
      const f = s.f;
      for (const p of f.way) p.at = [p.at[0] - dx, p.at[1] - dy];
      f.target = [f.target[0] - dx, f.target[1] - dy];
      if (f.src) f.src = [f.src[0] - dx, f.src[1] - dy, f.src[2] - dz];
    }
    for (const run of this.runs) {
      for (const p of run.hazard?.points ?? []) p.at = [p.at[0] - dx, p.at[1] - dy];
      const f = run.front;
      if (f) {
        for (const p of [...f.points, ...f.way]) p.at = [p.at[0] - dx, p.at[1] - dy];
        f.target = [f.target[0] - dx, f.target[1] - dy];
        if (f.src) f.src = [f.src[0] - dx, f.src[1] - dy, f.src[2] - dz];
        // (the spring is the liquid's, in window points too)
        if (f.spring) {
          f.spring.x -= dx;
          f.spring.y -= dy;
          f.spring.z -= dz;
        }
      }
      if (run.from) run.from = [run.from[0] - dx, run.from[1] - dy, run.from[2] - dz];
      if (run.last) run.last = [run.last[0] - dx, run.last[1] - dy, run.last[2] - dz];
    }
  }

  /** the player taken to an event (its camera, its spells) */
  goTo(run: LiveRun): void {
    if (this.focus === run) return;
    if (!this.focus) this.pitch0 = this.h.scene.core.camera.elevation;
    this.focus = run;
    const at = this.where(run);
    if (run.front) this.lookFront(run);
    else if (at && (!run.entry || run.entry.step === 'in')) void this.h.cam.look(at, { zoom: run.def.camera.zoom, ease: 1.2, place: [0.5, 0.36] }).then(() => this.follow(run));
    void this.h.cam.release(0.2);
    this.h.changed();
  }

  /** the camera after an event's figures (the tag it follows), once it is on them */
  private follow(run: LiveRun): void {
    if (this.focus !== run || run.over || !run.def.camera.follow) return;
    this.h.cam.follow(() => this.framed(run));
  }

  /** (loop round 11, LS-104) what the camera keeps on: the middle of the tag it follows, or with `camera.with` the
   *  point halfway between that middle and the other tag's (each side counted once: four challengers do not pull the
   *  frame off your one fighter); null when neither's places are read */
  private framed(run: LiveRun): V3 | null {
    const f = run.def.camera.follow;
    const a = f ? this.mid(run, f) : null;
    const w = run.def.camera.with;
    const b = w ? this.mid(run, w) : null;
    if (!a || !b) return a ?? b;
    // (only once they are near each other: on the way in, the camera stays on the ones coming)
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > FRAME_NEAR) return a;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }

  /** the player leaves an event: it goes on without them */
  leave(): void {
    const run = this.focus;
    if (!run || !this.canLeave) return;
    this.unfocus();
    this.h.changed();
  }
  private unfocus(): void {
    this.focus = null;
    this.h.cam.follow(null);
    this.h.scene.core.camera.elevation = this.pitch0;
  }
  /** the player may leave the event they are at: not one they must stay at, and not while its people are still being
   *  brought in by a road (the window must stay on that road) */
  /** (round 8) the event the player is at can be settled now: not one the player must stay at (the raid), and its
   *  column, if it comes by a road, has been called down it */
  get canSettle(): boolean {
    const r = this.focus;
    return !!r && !r.def.stay && (!r.entry || r.entry.step === 'called' || r.entry.step === 'in');
  }
  get canLeave(): boolean {
    const r = this.focus;
    return !!r && !r.def.stay && (!r.entry || (r.entry.step === 'in' && r.t > ENTRY_SURE));
  }

  /** where an event is (a window point): the middle of what its camera follows, else its place */
  where(run: LiveRun): V3 | null {
    const fa = run.front && this.frontAt(run.front);
    if (fa) return [fa[0], fa[1], this.h.z(fa[0], fa[1])];
    const m = this.framed(run);
    if (m) return m;
    const p = (run.def.camera.at ? this.point(run, run.def.camera.at) : null) ?? (run.site ? this.h.spot(run.site) : null);
    return p ? [p[0], p[1], this.h.z(p[0], p[1])] : null;
  }

  /** the living units of a tag, as the units know them */
  private ids(run: LiveRun, tag: string): number[] {
    const forces = this.h.scene.townForces;
    const out: number[] = [];
    for (const g of run.groups.values()) {
      if (!g.def.tags.includes(tag)) continue;
      if (g.squads) out.push(...((this.h.season.war?.squadGroups ?? []).flatMap((x) => forces?.members(x) ?? []) as number[]));
      else if (g.force !== null) out.push(...((forces?.members(g.force) ?? []) as number[]));
      else out.push(...g.units);
    }
    return out;
  }

  /** the middle of a tag's living units whose place is read (window point), or null */
  private mid(run: LiveRun, tag: string): V3 | null {
    const units = this.h.scene.units;
    let n = 0;
    const m: V3 = [0, 0, 0];
    for (const id of this.ids(run, tag)) {
      const p = units?.get(id)?.at;
      if (!p) continue;
      n++;
      for (let k = 0; k < 3; k++) m[k] += p[k];
    }
    return n ? [m[0] / n, m[1] / n, m[2] / n] : null;
  }

  // ---- in by a road -----------------------------------------------------------------------------------------------------

  /**
   * The camera down the next road into town (LS-16): a spawn point stands only on ground the world's window holds, and
   * the window is where the camera is. With walls and no road's gate standing, each road again straight for the
   * town's heart. None left: the event has nobody — it ends as it stands (the raid: "no raider reached the town").
   */
  private nextRoad(run: LiveRun): void {
    const e = run.entry!;
    const t = this.h.town();
    const roads = t?.roadCount ?? 0;
    const gated = [...run.groups.values()].some((g) => g.def.order?.at && 'place' in g.def.order.at && g.def.order.at.place === 'gate');
    // (each road once, from the one after the last tried, round again from the first)
    e.road = roads ? (e.road + 1) % roads : 0;
    e.tried++;
    if (e.tried > roads && gated && this.h.season.war?.walled && !e.direct) {
      e.direct = true;
      e.tried = 1;
    }
    if (!t || e.tried > roads) {
      console.error(`[live] ${run.template} found no road into ${t?.site.name ?? 'the town'}: ${roads} roads tried`);
      e.step = 'in';
      return this.end(run);
    }
    const { w, h } = this.h.scene.core.dims;
    const at = roadLook(t.roadInWindow(e.road), Math.min(w, h) / 2 - SLIDE_REGIONS * REGION - SURE_MARGIN);
    if (!at) return this.nextRoad(run);
    e.step = 'look';
    e.calm = 0;
    console.log(`[live] ${run.template}: the camera down road ${e.road}`);
    void this.h.cam.look([at[0], at[1], this.h.z(at[0], at[1])], { zoom: ROAD_ZOOM, ease: 1.2, place: [0.5, 0.4] }).then(() => {
      if (!run.over && e.step === 'look') e.step = 'settle';
    });
  }

  private enter(run: LiveRun, dt: number): void {
    const e = run.entry!;
    const forces = this.h.scene.townForces!;
    const units = this.h.scene.units!;
    const mine = [...run.groups.values()].filter((g) => entering(g.def));
    if (e.step === 'look' || e.step === 'settle') {
      // (the window still on the road: the land a slide brought is written and the place table has solved over it)
      e.calm = e.step === 'settle' && !this.h.scene.stream?.busy ? e.calm + 1 : 0;
      if (e.calm <= PLACE_SETTLE_FRAMES || this.townIndex < 0) return;
      const town = this.townIndex;
      const k = e.road;
      const numbers = this.h.realm()!.runNumbers();
      for (const g of mine) {
        // (to its gate with the walls built — each valid only with the other — else to where its order says, a gate
        // read as the town's heart)
        const toGate = !!g.def.order && 'place' in g.def.order.at && g.def.order.at.place === 'gate';
        const paired = toGate && !!this.h.season.war?.walled && !e.direct;
        const from: PlaceRef = paired ? { town, place: PLACE.spawn0 + k, also: PLACE.gate0 + k } : { town, place: PLACE.spawn0 + k };
        const to: PlaceRef | undefined = paired ? { town, place: PLACE.gate0 + k, also: PLACE.spawn0 + k } : toGate ? townHeart(town) : undefined;
        if (g.force !== null) forces.disband(g.force);
        // (round 8, the census's experiment: `?parade=N` draws N marchers — the crowd then counts them all, LS-92)
        // (round 9, the same experiment for a raid: `?raid=N` raiders — LS-92)
        const big = g.def.id === 'marchers' ? Number(this.h.scene.host.params.get('parade') ?? 0) : g.def.id === 'raiders' ? Number(this.h.scene.host.params.get('raid') ?? 0) : 0;
        this.make(run, g, big > 0 ? Math.min(big, 64) : groupSize(g.def, numbers), from, k, to);
      }
      for (const g of run.groups.values()) if (g.def.from === 'lining') this.line(run, g, groupSize(g.def, numbers), k);
      console.log(`[live] ${run.template}: called down road ${k}${e.direct ? ' for the heart of the town' : ''}`);
      e.step = 'called';
      e.calm = 0;
      void dt;
      return;
    }
    const first = mine[0];
    const rep = first.force !== null ? forces.report(first.force) : null;
    const ids = first.force !== null ? (forces.members(first.force) as number[]) : [];
    // (this road's spawn point was refused — water, or no gate on it: the next road. A refusal is told some frames
    // after the call, with the group's members gone — it may come after they were taken for standing, so it is looked
    // for as long as none of them has died or arrived)
    if (rep?.failed && !ids.length && !rep.dead && !first.arrived) {
      console.log(`[live] ${run.template}: road ${e.road} refused (${rep.failed})`);
      for (const g of mine) {
        if (g.force !== null) forces.disband(g.force);
        g.force = null;
        g.made = 0;
      }
      for (const g of run.groups.values()) if (g.def.from === 'lining') this.unmake(g);
      return this.nextRoad(run);
    }
    if (e.step !== 'called' || e.calm++ <= SPAWN_TOLD_FRAMES || !ids.length) return;
    e.step = 'in';
    this.roadTaken = e.direct ? 0 : e.road;
    run.unwatch.push(units.observe(mine.flatMap((g) => (g.force !== null ? (forces.members(g.force) as number[]) : []))));
    this.speed0 = this.h.scene.speed;
    const [road, direct] = [e.road, e.direct];
    const go = () => {
      // (not for a road that was refused after all)
      if (run.over || e.step !== 'in' || e.road !== road || e.direct !== direct) return;
      const p = this.mid(run, mine[0].def.tags[0]);
      if (!p) return void setTimeout(go, 100);
      run.from = p;
      if (this.focus === run) void this.h.cam.look(p, { zoom: run.def.camera.zoom, ease: 1, place: [0.5, 0.4] }).then(() => this.follow(run));
    };
    go();
    this.h.changed();
  }

  // ---- each frame ---------------------------------------------------------------------------------------------------------

  /** how an event stands, from what the units have told */
  state(run: LiveRun): LiveState {
    const forces = this.h.scene.townForces;
    const war = this.h.season.war;
    const groups: LiveState['groups'] = {};
    for (const [id, g] of run.groups) {
      if (g.squads) {
        const gs = war?.squadGroups ?? [];
        const alive = gs.reduce((s, x) => s + (forces?.report(x)?.alive ?? 0), 0);
        const dead = Math.max(0, gs.reduce((s, x) => s + (forces?.report(x)?.dead ?? 0), 0) - g.dead0);
        groups[id] = { tags: g.def.tags, made: g.made, alive, dead, arrived: true };
      } else if (g.force !== null) {
        const r = forces?.report(g.force);
        // (round 8: a group ordered made but not yet standing — its spawn resolves on the GPU — is all still there; a
        // bout settled the moment its challengers were called was read as won with none of them alive)
        const dead = r?.dead ?? 0;
        const made = Math.max(r?.size ?? 0, g.made);
        groups[id] = { tags: g.def.tags, made, alive: (r?.size ?? 0) < g.made ? made - dead : (r?.alive ?? 0), dead, arrived: g.arrived };
      } else if (entering(g.def) && g.made === 0) {
        // (round 8: still on its way in, not made yet: all of it)
        const n = groupSize(g.def, this.h.realm()?.runNumbers() ?? {});
        groups[id] = { tags: g.def.tags, made: n, alive: n, dead: 0, arrived: false };
      } else groups[id] = { tags: g.def.tags, made: g.made, alive: g.units.size, dead: g.dead, arrived: g.arrived };
    }
    const f = run.front;
    if (f) {
      // (a front: its town points reached are what it took; it is "alight" while it pours and settles after — LiveEnd 'out')
      const hz = run.def.hazard as LiveFront;
      return { t: run.t, groups, points: f.points.length, burned: f.points.filter((p) => p.reached).length, alight: f.picking || run.t < hz.pour + FRONT_SETTLE ? 1 : 0, casts: { ...run.casts }, absent: { ...run.absent }, fighting: run.fighting };
    }
    const pts = run.hazard?.points ?? [];
    return { t: run.t, groups, points: pts.length, burned: pts.filter((p) => p.burned).length, alight: pts.filter((p) => p.alight && !p.burned).length, casts: { ...run.casts }, absent: { ...run.absent }, fighting: run.fighting };
  }

  /** an event's numbers now (its sheet's line reads them) */
  numbers(run: LiveRun): LiveVars {
    return liveRead(run.def, this.state(run), this.h.realm()?.runNumbers() ?? {});
  }

  /** what the scene tells the realm of an event: its state, where it is, the way its marchers took, what burned */
  told(run: LiveRun): LiveTold {
    const S = this.h.scene.stream;
    const cell = (p: readonly number[]): [number, number] => {
      const [cx, cy] = cellAt(p[0], p[1]);
      return [(S?.origin[0] ?? 0) + cx, (S?.origin[1] ?? 0) + cy];
    };
    const at = this.where(run);
    return {
      state: this.state(run),
      ...(at ? { at: cell(at) } : {}),
      ...(run.from && run.last ? { route: [cell(run.from), cell(run.last)] as const } : {}),
      ...(run.hazard ? { burned: run.hazard.points.filter((p) => p.burned).map((p) => cell(p.at)) } : {}),
      // (loop round 12: a front's reached points — in the town, and along its way — as world cells: the land it changed)
      ...(run.front ? { burned: run.front.points.filter((p) => p.reached).map((p) => cell(p.at)), path: run.front.way.filter((p) => p.reached).map((p) => cell(p.at)) } : {}),
    };
  }

  update(dt: number): void {
    const scene = this.h.scene;
    for (const run of [...this.runs]) {
      if (run.over || run.ending) continue;
      if (run.entry) {
        this.enter(run, dt);
        if (run.over || run.entry.step !== 'in') continue;
      }
      run.t += dt;
      const s = this.state(run);
      // (seconds nobody of a tag has stood while the others are at their place or fighting: the raid's "no soldier
      // left for 5 s" — not while the raiders are still on the road, where the player may yet cast on them)
      for (const e of run.def.ends) {
        if (e.when !== 'absent') continue;
        const there = run.fighting || Object.values(s.groups).some((g) => g.tags.includes(e.while) && g.arrived && g.alive > 0);
        run.absent[e.tag] = !there || Object.values(s.groups).some((g) => g.tags.includes(e.tag) && g.alive > 0) ? 0 : (run.absent[e.tag] ?? 0) + dt;
      }
      this.hazard(run, dt);
      this.front(run, dt);
      const f = run.def.camera.follow;
      const m = f ? this.mid(run, f) : null;
      if (m) run.last = m;
      // (petals over a parade)
      const fx = run.def.fx;
      if (fx && (run.fx += dt) >= fx.every) {
        run.fx = 0;
        const p = this.mid(run, run.groups.get(fx.over)!.def.tags[0]);
        if (p) this.api.fx.burst(fx.burst as never, p[0], p[1], p[2] + 3, { count: fx.count });
      }
      // (the sim sped up while its people are still on the road)
      if (run.entry && run.def.marchSpeed) scene.speed = !run.fighting && ![...run.groups.values()].some((g) => entering(g.def) && g.arrived) ? Math.max(this.speed0, run.def.marchSpeed) : this.speed0;
      // (round 7: its finale — the camera stays on its people at their place, a burst over them each second — then
      // it ends)
      const fin = run.def.finale;
      if (run.finale !== undefined && fin) {
        const s0 = Math.floor(run.finale);
        run.finale += dt;
        const p = Math.floor(run.finale) > s0 ? this.mid(run, run.def.camera.follow!) : null;
        if (p) this.api.fx.burst(fin.burst as never, p[0] + (Math.random() - 0.5) * 4, p[1] + (Math.random() - 0.5) * 4, p[2] + 2.5, { count: fin.count });
        if (run.finale >= fin.seconds) this.end(run);
      } else if (liveEnded(run.def, this.state(run))) {
        if (fin && this.focus === run) {
          run.finale = 0;
          // (the watchers along the way come to where it ended)
          const m = this.mid(run, run.def.camera.follow!);
          const liners = [...run.groups.values()].filter((g) => g.def.from === 'lining').flatMap((g) => [...g.units]);
          if (m && liners.length) this.h.scene.units?.order(liners, { kind: 'guard', at: [m[0], m[1]] });
          console.log(`[live] ${run.template}: its finale, ${fin.seconds} s`);
        } else this.end(run);
      }
    }
    this.walkOff(dt);
    this.setFronts(dt);
    const run = this.focus;
    if (run && !run.over && !this.h.cam.busy && (!run.entry || run.entry.step === 'in')) {
      const cam = scene.core.camera;
      if (run.def.camera.follow) {
        let want = run.fighting && run.def.camera.fightZoom ? run.def.camera.fightZoom : run.def.camera.zoom;
        // (loop round 11: with a second tag in frame, no closer than both sides' middles fit in FIT_SHARE of the
        // screen's width — the bout's crew at its edge was half cut off at 24)
        const w = run.def.camera.with;
        const a = w ? this.mid(run, run.def.camera.follow) : null;
        const b = w ? this.mid(run, w) : null;
        const ab = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity;
        if (ab <= FRAME_NEAR) want = Math.max(FIT_FLOOR, Math.min(want, (FIT_SHARE * cam.viewportW) / Math.max(ab, 1)));
        cam.zoom *= Math.exp(Math.log(want / cam.zoom) * Math.min(1, dt * 1.2));
        const pitch = run.def.camera.pitch !== undefined ? (run.def.camera.pitch * Math.PI) / 180 : EVENT_PITCH;
        cam.elevation += (pitch - cam.elevation) * Math.min(1, dt * 1.2);
      }
    }
  }

  /** (round 7) the people of events that are over walking off: let go when their seconds are up */
  private walkOff(dt: number): void {
    for (const l of [...this.leaving]) {
      if ((l.left -= dt) > 0) continue;
      for (const g of l.forces) this.h.scene.townForces?.disband(g);
      for (const id of l.units) this.h.scene.units?.remove(id);
      this.leaving.splice(this.leaving.indexOf(l), 1);
    }
  }

  /** a hazard's fire: its stalls lit once they are down, then its points read through the fire mirror's pages */
  private hazard(run: LiveRun, dt: number): void {
    const hz = run.hazard;
    const def = run.def.hazard;
    if (!hz || !def || def.kind !== 'fire') return;
    const fire = this.api.fire;
    const terrain = this.api.terrain;
    if (!hz.lit && !hz.picking && run.t >= LIGHT_AFTER) {
      // (round 7, LS-63: the ground under every spot read once — its surface word's pages, 1 KB each — and the first
      // `points` whose top is the canvas put down are the stalls, lit; the rest let go. Read in window points that a
      // slide meanwhile moves: `shift`)
      hz.picking = true;
      const xs = hz.points.map((p) => p.at[0]);
      const ys = hz.points.map((p) => p.at[1]);
      void terrain.load(Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2).then(
        () => {
          if (run.over) return;
          // (and no water standing on it: wet ground puts a fire out at once — fire.wgsl `damp`. The water's pages are
          // asked for here and read a frame or two later)
          const water = this.h.scene.worldApi?.water;
          for (const p of hz.points) water?.depthAt(p.at[0], p.at[1]);
          setTimeout(() => {
            if (run.over) return;
            const took = hz.points.filter((p) => terrain.surfaceAt(p.at[0], p.at[1])?.mat === MAT.Canvas && (water?.depthAt(p.at[0], p.at[1]) ?? 0) < 0.05);
            hz.points = took.slice(0, def.points);
            hz.lit = true;
            for (const p of hz.points) fire.ignite(p.at[0], p.at[1], { radius: def.radius, intensity: def.intensity });
            console.log(`[live] ${run.template}: ${took.length} of ${xs.length} spots took the canvas on dry ground; ${hz.points.length} stalls lit`);
          }, 300);
        },
        (e) => console.error(`[live] ${run.template}: the ground under its stalls could not be read: ${e}`),
      );
    }
    if (!hz.lit || (hz.read += dt) < HAZARD_READ) return;
    for (const p of hz.points) {
      // (the page holding the point is asked for and read a frame later: this is the value of the read before)
      let hot = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) hot = Math.max(hot, fire.fireAt(p.at[0] + dx, p.at[1] + dy) ?? 0);
      p.alight = hot > 0.05;
      if (p.alight) p.alightFor += hz.read;
      if (p.alightFor >= BURN_SECONDS) p.burned = true;
    }
    // (once, the first read after they were lit: how each stall stands, for the log)
    if (!hz.told) {
      hz.told = true;
      console.log(`[live] ${run.template}: stalls ${hz.points.map((p) => `${p.at.map((v) => v.toFixed(0))} ${(fire.fireAt(p.at[0], p.at[1]) ?? -1).toFixed(2)}`).join('; ')}`);
    }
    hz.read = 0;
  }

  /** an event over by itself: the host resolves it */
  private end(run: LiveRun): void {
    if (run.over || run.ending) return;
    // (told once: a host that fails to resolve it is not asked again every frame)
    run.ending = true;
    this.h.ended(run);
  }

  /**
   * An event taken out of the city: what it tells (`told`) is taken first by the caller. Its people leave (the
   * squads stay: they are the town's), its camera and the sim's speed are given back.
   */
  close(run: LiveRun): V3 | null {
    const at = this.where(run);
    this.stopPour(run);
    if (run.front && run.def.hazard?.kind === 'front' && run.def.hazard.liquid === 'lava') this.setting.push({ f: run.front, left: FRONT_SET_S, awake: 0 });
    run.over = true;
    const forces = this.h.scene.townForces;
    const units = this.h.scene.units;
    // (round 7, LS-64: people who take no part in a fight walk off and are let go later — they do not vanish in view)
    const after = run.def.after;
    const off: Leaving = { forces: [], units: [], left: after?.seconds ?? 0 };
    for (const g of run.groups.values()) {
      const walks = !!after && g.def.side === 'folk';
      if (g.force !== null) {
        if (walks && forces) {
          forces.orderGroup(g.force, { kind: 'go', at: this.ref(after.go, 0), formation: 'loose' });
          off.forces.push(g.force);
        } else forces?.disband(g.force);
      }
      for (const id of g.units) {
        if (walks) off.units.push(id);
        else units?.remove(id);
        this.ofUnit.delete(id);
      }
    }
    if (off.forces.length || off.units.length) this.leaving.push(off);
    for (const u of run.unwatch) u();
    if (run.entry && run.def.marchSpeed) this.h.scene.speed = this.speed0;
    this.runs.splice(this.runs.indexOf(run), 1);
    if (!this.runs.length) this.h.scene.core.dayNight.held = false;
    if (this.focus === run) {
      this.unfocus();
      if (run.def.stay && at) void this.h.cam.look(at, { zoom: AFTER_ZOOM, ease: 1.5, place: [0.5, 0.36] });
    }
    return at;
  }

  // ---- the screen ---------------------------------------------------------------------------------------------------------

  /** the marks of the event the player is at: a ring round each fighter, and each side's name and count */
  marks(): Marker[] {
    const run = this.focus;
    const units = this.h.scene.units;
    if (!run || !units || (run.entry && run.entry.step !== 'in')) return [];
    const cam = this.h.scene.core.camera;
    const out: Marker[] = [];
    for (const [tag, name, ring] of run.def.marks ?? []) {
      const side = [...run.groups.values()].find((g) => g.def.tags.includes(tag))?.def.side ?? 'folk';
      const ids = this.ids(run, tag);
      let n = 0;
      let sx = 0;
      let top = Infinity;
      let low = -Infinity;
      for (const id of ids) {
        const at = units.get(id)?.at;
        if (!at) continue;
        const [x, y] = cam.project(at[0], at[1], at[2]);
        if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
        if (side !== 'folk') out.push({ id: String(id), label: '', kind: side === 'foe' ? 'raider' : 'soldier', x, y });
        else if (ring) out.push({ id: String(id), label: '', kind: 'folk', x, y });
        n++;
        sx += x;
        top = Math.min(top, y);
        low = Math.max(low, y);
      }
      // (the foes' name above their figures, the town's below theirs: the two never lie on each other)
      // (people who take no part in a fight wear the town's colour, their name above them)
      if (n && name) out.push({ id: side === 'foe' ? 'theirs' : side === 'town' ? 'ours' : `folk:${tag}`, label: `${name} ${ids.length}`, kind: 'side', x: sx / n, y: side === 'town' ? low : top });
    }
    return out;
  }

  /** (scripts) where a tag's figures of the event the player is at are on the screen (px) */
  figures(tag?: string): [number, number][] {
    const run = this.focus;
    const units = this.h.scene.units;
    if (!run || !units) return [];
    const cam = this.h.scene.core.camera;
    const t = tag ?? run.def.camera.follow ?? run.def.groups[0]?.tags[0];
    if (!t) return [];
    return this.ids(run, t).flatMap((id) => {
      const at = units.get(id)?.at;
      return at ? [cam.project(at[0], at[1], at[2]) as [number, number]] : [];
    });
  }

  /** the height the figures of the event the player is at stand at (a spell is aimed at their level); null: none read */
  figuresZ(): number | null {
    const run = this.focus;
    const f = run?.def.camera.follow;
    const m = run && f ? this.mid(run, f) : null;
    return m ? m[2] : null;
  }
}
