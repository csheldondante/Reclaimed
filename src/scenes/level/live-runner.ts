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
import type { LevelScene } from '../level';
import { REGION } from '../streamer/defs';

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
/** seconds between reads of a hazard's points, and the seconds alight after which a point's lot has burned down */
const HAZARD_READ = 2;
const BURN_SECONDS = 12;
/** seconds after a hazard's stalls are put down that they are lit (the edit lands at the next tick) */
const LIGHT_AFTER = 0.6;
/** a group sent somewhere that has not moved (its middle, within HALT_CELLS) for this many seconds stands where it
 *  was going, as near as it could get: counted as arrived. The units' own word for it (`arrived(g)`: every member on
 *  its slot at the place) does not come for a column sent to a building's place among houses — seen: refugees stood by
 *  the stores for 4 minutes (BACKLOG LS-72) */
const HALT_SECONDS = 8;
const HALT_CELLS = 1.2;
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
  /** where its middle was when last looked at, and the seconds it has not moved since */
  was: V3 | null;
  still: number;
  look: number;
}

/** a group that comes in by a road */
const entering = (g: LiveGroup): boolean => g.from !== 'squads' && 'place' in g.from && g.from.place === 'spawn' && g.from.road === 'entry';

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
  hazard: { points: { at: [number, number]; alightFor: number; alight: boolean; burned: boolean }[]; lit: boolean; read: number } | null;
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
      for (const r of this.runs) for (const x of r.groups.values()) if (x.force === g) x.arrived = true;
    });
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
    const run: LiveRun = { id: o.id, template: o.template, def, site, t: 0, groups: new Map(), entry: null, hazard: null, casts: {}, absent: {}, fighting: false, unwatch: [], from: null, last: null, fx: 0, over: false };
    const numbers = this.h.realm()!.runNumbers();
    const units = this.h.scene.units!;
    const forces = this.h.scene.townForces!;
    for (const g of def.groups) {
      const n = groupSize(g, numbers);
      const rg: RunGroup = { def: g, force: null, units: new Set(), squads: g.from === 'squads', made: 0, dead0: 0, dead: 0, arrived: false, was: null, still: 0, look: 0 };
      run.groups.set(g.id, rg);
      if (g.from === 'squads') {
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
        run.unwatch.push(units.observe([...rg.units]));
      } else if (g.from.place === 'spawn' && g.from.road === 'entry') {
        run.entry ??= { road: -1, tried: 0, direct: false, step: 'none', calm: 0 };
      } else this.make(run, rg, n, this.ref(g.from, 0), 0);
    }
    if (def.hazard) {
      const c = this.point(run, def.hazard.at) ?? this.h.town()!.centreInWindow();
      const hz = def.hazard;
      const terrain = this.api.terrain;
      const points = Array.from({ length: hz.points }, (_, k) => {
        const a = (k / hz.points) * Math.PI * 2 + 0.4;
        const r = hz.spread * (0.45 + 0.55 * ((k * 7) % 3) / 2);
        const at: [number, number] = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
        // (what burns: a stall's canvas at each spot — the fire system burns canvas, timber and plants, and the
        // generated buildings are meshes it does not know; BACKLOG LS-63)
        terrain.build(at[0], at[1], 'canvas', { radius: 1.6, layers: 2 });
        return { at, alightFor: 0, alight: false, burned: false };
      });
      run.hazard = { points, lit: false, read: 0 };
    }
    this.runs.push(run);
    this.goTo(run);
    // (the road that took the last column is tried first: a road whose spawn point is in water stays so)
    if (run.entry && this.roadTaken > 0) run.entry.road = this.roadTaken - 1;
    if (run.entry) this.nextRoad(run);
    console.log(`[live] ${run.template} begun: ${[...run.groups.values()].map((g) => `${g.def.id} ${g.made}`).join(', ')}${run.hazard ? `, fire at ${run.hazard.points.length} spots` : ''}`);
    return run;
  }

  /** a group made at a place of the town and sent on its order */
  private make(run: LiveRun, rg: RunGroup, n: number, from: PlaceRef, k: number, to?: PlaceRef): void {
    const forces = this.h.scene.townForces!;
    const kind = BY_PLACE[rg.def.kind];
    if (!kind) throw new Error(`live event ${run.template}: no units of kind ${rg.def.kind} can be made by place`);
    rg.force = forces.spawnAt(kind, FACTION[rg.def.side], from, n);
    rg.made = n;
    const o = rg.def.order;
    if (o) forces.orderGroup(rg.force, { kind: o.kind, at: to ?? this.ref(o.at, k), ...(o.formation ? { formation: o.formation } : {}), ...(o.discipline !== undefined ? { discipline: o.discipline } : {}) });
    else rg.arrived = true;
    rg.was = null;
    rg.still = 0;
    // (its people's places read while the event runs: the camera follows them, and a halt is seen)
    run.unwatch.push(this.h.scene.units!.observe(forces.members(rg.force)));
  }

  /** the player taken to an event (its camera, its spells) */
  goTo(run: LiveRun): void {
    if (this.focus === run) return;
    if (!this.focus) this.pitch0 = this.h.scene.core.camera.elevation;
    this.focus = run;
    const at = this.where(run);
    if (at && (!run.entry || run.entry.step === 'in')) void this.h.cam.look(at, { zoom: run.def.camera.zoom, ease: 1.2, place: [0.5, 0.36] }).then(() => this.follow(run));
    void this.h.cam.release(0.2);
    this.h.changed();
  }

  /** the camera after an event's figures (the tag it follows), once it is on them */
  private follow(run: LiveRun): void {
    if (this.focus !== run || run.over || !run.def.camera.follow) return;
    this.h.cam.follow(() => this.mid(run, run.def.camera.follow!));
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
  get canLeave(): boolean {
    const r = this.focus;
    return !!r && !r.def.stay && (!r.entry || (r.entry.step === 'in' && r.t > ENTRY_SURE));
  }

  /** where an event is (a window point): the middle of what its camera follows, else its place */
  where(run: LiveRun): V3 | null {
    const f = run.def.camera.follow;
    const m = f ? this.mid(run, f) : null;
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
        this.make(run, g, groupSize(g.def, numbers), from, k, to);
      }
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
        groups[id] = { tags: g.def.tags, made: r?.size ?? 0, alive: r?.alive ?? 0, dead: r?.dead ?? 0, arrived: g.arrived };
      } else groups[id] = { tags: g.def.tags, made: g.made, alive: g.units.size, dead: g.dead, arrived: g.arrived };
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
      this.halts(run, dt);
      this.hazard(run, dt);
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
      if (liveEnded(run.def, this.state(run))) this.end(run);
    }
    const run = this.focus;
    if (run && !run.over && !this.h.cam.busy && (!run.entry || run.entry.step === 'in')) {
      const cam = scene.core.camera;
      if (run.def.camera.follow) {
        const want = run.fighting && run.def.camera.fightZoom ? run.def.camera.fightZoom : run.def.camera.zoom;
        cam.zoom *= Math.exp(Math.log(want / cam.zoom) * Math.min(1, dt * 1.2));
        cam.elevation += (EVENT_PITCH - cam.elevation) * Math.min(1, dt * 1.2);
      }
    }
  }

  /** a group on its way that has stopped moving stands where it was going (HALT_SECONDS) */
  private halts(run: LiveRun, dt: number): void {
    const forces = this.h.scene.townForces;
    const units = this.h.scene.units;
    for (const g of run.groups.values()) {
      if (g.force === null || g.arrived || !g.def.order || g.def.order.kind === 'attack' || (g.look += dt) < 1) continue;
      let n = 0;
      const m: V3 = [0, 0, 0];
      for (const id of forces?.members(g.force) ?? []) {
        const p = units?.get(id)?.at;
        if (!p) continue;
        n++;
        for (let k = 0; k < 3; k++) m[k] += p[k] / 1;
      }
      if (!n) continue;
      const at: V3 = [m[0] / n, m[1] / n, m[2] / n];
      g.still = g.was && Math.hypot(at[0] - g.was[0], at[1] - g.was[1]) < HALT_CELLS ? g.still + g.look : 0;
      if (g.still === 0) g.was = at;
      g.look = 0;
      if (g.still >= HALT_SECONDS && run.t > HALT_SECONDS + 4) {
        g.arrived = true;
        console.log(`[live] ${run.template}: ${g.def.id} halted at ${at.map((v) => Math.round(v))}: counted as arrived`);
      }
    }
  }

  /** a hazard's fire: its stalls lit once they are down, then its points read through the fire mirror's pages */
  private hazard(run: LiveRun, dt: number): void {
    const hz = run.hazard;
    const def = run.def.hazard;
    if (!hz || !def) return;
    const fire = this.api.fire;
    if (!hz.lit && run.t >= LIGHT_AFTER) {
      hz.lit = true;
      for (const p of hz.points) fire.ignite(p.at[0], p.at[1], { radius: def.radius, intensity: def.intensity });
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
    run.over = true;
    const forces = this.h.scene.townForces;
    const units = this.h.scene.units;
    for (const g of run.groups.values()) {
      if (g.force !== null) forces?.disband(g.force);
      for (const id of g.units) {
        units?.remove(id);
        this.ofUnit.delete(id);
      }
    }
    for (const u of run.unwatch) u();
    if (run.entry && run.def.marchSpeed) this.h.scene.speed = this.speed0;
    this.runs.splice(this.runs.indexOf(run), 1);
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
    for (const [tag, name] of run.def.marks ?? []) {
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
        n++;
        sx += x;
        top = Math.min(top, y);
        low = Math.max(low, y);
      }
      // (the foes' name above their figures, the town's below theirs: the two never lie on each other)
      // (people who take no part in a fight wear the town's colour, their name above them)
      if (n) out.push({ id: side === 'foe' ? 'theirs' : side === 'town' ? 'ours' : 'folk', label: `${name} ${ids.length}`, kind: 'side', x: sx / n, y: side === 'town' ? low : top });
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
