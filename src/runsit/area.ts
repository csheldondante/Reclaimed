// ---- runsit/area.ts ---------------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG RS20-RS22, FO1, IT1) An area of a situation played live where the hero is: the
// outriders really chase (Units), the ambush really waits on the road, the message is carried to a real settlement's
// hall, the trader stands at the crossroads, and in the finale the horde really marches on the town, its people follow
// the hero when told, the hold's levy comes in from its side of the map, and the dead fire the houses through the
// world API's fire (the fire system spreads it on the timber and the fields; its heat brings them down).
// Everything goes through contracts: the world API (heights through the play world, fire.ignite), Units (spawn, order,
// query), the followers (contracts/orders.ts), the settlements' places (where the town's middle and doors are). The
// rules are finale.ts and state.ts (pure); this is their live half. Window coordinates (x cells, y world units).
// The user (round 120): "Have chases. Flee. Deliver a message before enemies arrive etc. the missions should not be
// disjoint levels they should be objectives and situations spawned into the active map with real consequences."

import type { Sim } from '../api/world';
import type { UnitId, Units } from '../api/contracts/units';
import type { SituationArea, SituationEnd } from '../api/contracts/situation';
import type { PlaySession } from '../play/session';
import type { Part, Voxels } from '../play/draw/shapes';
import { MAT } from '../world/materials';
import { FinaleRules, INSIDE, fireSite, FALL_AT, type FinaleStatus } from './finale';
import { totals, use } from './items';
import type { UnitFollowers } from './followers';
import type { AreaResult, FinaleSetup, SituationRun, V2 } from './state';

/** cells from where the hero comes in to the area's edge (the way on) */
export const EDGE_R = 110;
/** cells off the hall or the town where the hero comes in (it rides in, it isn't dropped at the door) */
export const ENTRY_R = 80;
/** cells to a goal that count as there */
export const THERE = 8;
/** outriders: cells a minute behind, at least, at most */
const BEHIND_CELLS: [number, number, number] = [60, 22, 110];

export interface TownPlaces {
  /** window coordinates */
  centre: V2;
  radius: number;
  doors: V2[];
}

export interface AreaDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  session: PlaySession;
  run: SituationRun;
  followers: UnitFollowers;
  /** world units → the window, as it is now */
  toWin: (p: V2) => V2;
  bounds: [number, number];
  /** the town's places in the window (the finale, a deliver's hall), once its plan is made; null: not yet */
  places: (settlement: string) => TownPlaces | null;
  /** the town's own people standing now (its settlement's units, not hostile) */
  townsfolk: (settlement: string) => UnitId[];
}

export type AreaEnd = { kind: 'area'; result: AreaResult } | { kind: 'finale'; end: SituationEnd; why: string; seconds: number };

export class AreaPlay {
  readonly area: SituationArea;
  t = 0;
  done = false;
  /** what the area's play is pointing the hero at (the arrow, the autopilot) */
  goal: V2 | null = null;
  goalName = '';
  readonly result: Promise<AreaEnd>;
  private resolve!: (e: AreaEnd) => void;
  readonly log: string[] = [];
  private pursuers: UnitId[] = [];
  private foes: UnitId[] = [];
  private allies: UnitId[] = [];
  private trader: UnitId | null = null;
  private entry: V2;
  // the finale
  setup: FinaleSetup | null = null;
  rules: FinaleRules | null = null;
  town: TownPlaces | null = null;
  private waitedTown = 0;
  private horde: UnitId[] = [];
  private hordeCame = false;
  private reinforced = false;
  private burning = new Set<number>();
  refuge: V2 | null = null;
  private led = 0;
  private lure: { at: V2; t: number } | null = null;
  // the HUD
  private banner: HTMLDivElement;
  private arrow: HTMLDivElement;
  private big: HTMLDivElement;
  private bar: HTMLDivElement;
  private barKey = '';

  constructor(
    private d: AreaDeps,
    /** where the hero came from (world units: the last area), for where it rides in */
    from: V2 | null,
  ) {
    this.area = d.run.area();
    this.result = new Promise((res) => (this.resolve = res));
    this.banner = div(d.ui, 'position:absolute;left:50%;transform:translateX(-50%);top:calc(max(8px, env(safe-area-inset-top)) + 4px);max-width:min(78vw,440px);padding:6px 12px;border-radius:9px;background:rgba(18,16,12,0.8);color:#f3e8cf;font:600 13px/1.3 system-ui,sans-serif;text-align:center;pointer-events:none;z-index:7;');
    this.arrow = div(d.ui, 'position:absolute;width:0;height:0;border-left:13px solid transparent;border-right:13px solid transparent;border-bottom:26px solid #ffd35a;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7));pointer-events:none;z-index:7;display:none;');
    this.big = div(d.ui, 'position:absolute;left:50%;top:30%;transform:translate(-50%,-50%);color:#fff3c4;font:800 34px system-ui,sans-serif;text-align:center;text-shadow:0 3px 12px rgba(0,0,0,.8);pointer-events:none;z-index:7;max-width:90vw;');
    // (orders and items: a column on the right, over the play controls' empty middle)
    this.bar = div(d.ui, 'position:absolute;right:calc(max(8px, env(safe-area-inset-right)));top:28%;display:flex;flex-direction:column;gap:6px;z-index:8;pointer-events:auto;');
    this.bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    // where the hero comes in: the area's own spot (the start, a road), or a ride off a hall or a town
    const here = d.toWin(d.run.map.areaAt(this.area));
    const p = this.area.play;
    if ((p.kind === 'deliver' || p.kind === 'town' || p.kind === 'trader') && from) {
      const f = d.toWin(from);
      const [ux, uy] = unit([f[0] - here[0], f[1] - here[1]]);
      this.entry = this.inside([here[0] + ux * ENTRY_R, here[1] + uy * ENTRY_R]);
    } else this.entry = this.inside(here);
    this.entry = d.session.dryNear(this.entry);
    d.session.warped(this.entry);
    d.session.damageTaken = totals(d.run.loadout, d.run.item).guard;
    this.setUp(here);
  }

  private get hero() {
    return this.d.session.hero;
  }
  private heroAt(): V2 {
    const p = this.hero.position();
    return [p[0], p[1]];
  }

  /** a point kept inside the window, `m` cells in from its edges */
  private inside(p: V2, m = 24): V2 {
    const [W, H] = this.d.bounds;
    return [Math.max(m, Math.min(W - m, p[0])), Math.max(m, Math.min(H - m, p[1]))];
  }

  /** the way on: toward the areas the choices lead to (window direction) */
  private wayOn(): V2 {
    const run = this.d.run;
    const here = run.map.areaAt(this.area);
    const tos = run.sit.choices.filter((c) => c.from === this.area.id).map((c) => run.map.areaAt(run.area(c.to)));
    let x = 0;
    let y = 0;
    for (const t of tos) {
      const [dx, dy] = unit(delta(here, t, run.map.world));
      x += dx;
      y += dy;
    }
    return unit([x || 1, y]);
  }

  private spawnAround(at: V2, n: number, r0: number, r1: number, kind: string, faction: string | null, o: { hostile: boolean; sight: number; speed: number; health?: number; role?: string; name?: string; colour?: string; job?: import('../api/contracts/units').UnitJob }): UnitId[] {
    const out: UnitId[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / Math.max(1, n) + i * 0.37;
      const r = r0 + ((i * 7919) % 97) / 97 * (r1 - r0);
      const p = this.d.session.dryNear(this.inside([at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r], 8));
      out.push(this.d.units.spawn(kind, p, faction, { hostile: o.hostile, sight: o.sight, speed: o.speed, health: o.health ?? 3, role: o.role ?? kind, name: o.name, colour: o.colour, job: o.job }));
    }
    return out;
  }

  /** the outriders, `behind` minutes back along the way the hero came (or behind it, at the start) */
  private spawnPursuers(away: V2): void {
    const P = this.d.run.pursuers;
    if (!P || P.count <= 0) return;
    const cells = Math.max(BEHIND_CELLS[1], Math.min(BEHIND_CELLS[2], BEHIND_CELLS[0] * Math.max(0, P.behind)));
    const c = this.inside([this.entry[0] - away[0] * cells, this.entry[1] - away[1] * cells], 10);
    const th = this.d.run.sit.threat;
    this.pursuers = this.spawnAround(c, P.count, 2, 6, th.role, th.faction, { hostile: true, sight: 70, speed: 4.2, health: 3, job: { kind: 'attack', target: 'hero' } });
    this.log.push(`${P.count} outriders ${cells.toFixed(0)} cells behind`);
  }

  private setUp(here: V2): void {
    const p = this.area.play;
    const way = this.wayOn();
    const edge = (): V2 => this.inside([this.entry[0] + way[0] * EDGE_R, this.entry[1] + way[1] * EDGE_R]);
    switch (p.kind) {
      case 'flee':
        this.goal = edge();
        this.goalName = 'the way on';
        this.spawnPursuers(way);
        break;
      case 'ambush': {
        this.goal = edge();
        this.goalName = 'the way on';
        const mid: V2 = [(this.entry[0] + this.goal[0]) / 2, (this.entry[1] + this.goal[1]) / 2];
        this.foes = this.spawnAround(mid, p.foes, 6, 22, p.role, p.faction, { hostile: true, sight: 24, speed: 3.6, health: 3 });
        this.spawnPursuers(way);
        break;
      }
      case 'deliver': {
        const pl = this.d.places(p.settlement);
        this.goal = pl ? this.inside(pl.centre) : this.inside(here);
        this.goalName = `the hall of ${this.area.name}`;
        const [ux, uy] = unit([this.entry[0] - this.goal[0], this.entry[1] - this.goal[1]]);
        this.spawnPursuers([-ux, -uy]);
        break;
      }
      case 'trader': {
        this.goal = this.inside(here);
        this.goalName = 'the trader';
        this.trader = this.d.units.spawn('trader', this.goal, null, { name: 'the trader', role: 'trader', hostile: false, health: 5, colour: '#e8c66a', job: { kind: 'guard', at: this.goal, radius: 1 } });
        const [ux, uy] = unit([this.entry[0] - this.goal[0], this.entry[1] - this.goal[1]]);
        this.spawnPursuers([-ux, -uy]);
        break;
      }
      case 'town':
        this.setup = this.d.run.finaleSetup();
        this.rules = new FinaleRules(this.setup);
        this.goalName = this.area.name;
        this.goal = this.inside(here);
        break;
    }
    this.log.push(`${this.area.id} ${p.kind}: in at ${this.entry.map((v) => v.toFixed(0))}, goal ${this.goal?.map((v) => v.toFixed(0))}`);
  }

  /** the finale's town in place (its plan made: the places known) */
  private townReady(): boolean {
    if (this.town) return true;
    const sid = this.area.settlement!;
    const pl = this.d.places(sid);
    this.waitedTown += 1 / 60;
    if (!pl) return false;
    const setup = this.setup!;
    this.town = { ...pl, centre: this.inside(pl.centre) };
    this.goal = this.town.centre;
    const c = this.town.centre;
    // the refuge: out toward its region, past the town's edge
    const run = this.d.run;
    const rc = run.map.regionCentre(run.sit.refuge.region);
    const [rx, ry] = run.sit.refuge.region === run.sit.target.region ? [-setup.from[0], -setup.from[1]] : unit(delta(run.map.areaAt(this.area), rc, run.map.world));
    this.refuge = this.d.session.dryNear(this.inside([c[0] + rx * (this.town.radius + 70), c[1] + ry * (this.town.radius + 70)]));
    // the town's levy (warned), with its guards
    if (setup.militia > 0) this.allies.push(...this.spawnAround(c, setup.militia, 3, 8, 'guard', this.d.units.query(c, this.town.radius * 2).find((u) => u.settlement === sid)?.faction ?? null, { hostile: false, sight: 18, speed: 3.2, health: 5, role: 'guard', job: { kind: 'guard', at: c, radius: 10 } }));
    // its people: everyone the town has out now (the evacuation's count)
    this.led = this.d.townsfolk(sid).length;
    // a town the dead reached first is burning already
    for (let i = 0; i < setup.burning; i++) this.setFire(this.town.centre);
    if (setup.hordeIn <= 0) this.hordeComes(true);
    this.log.push(`town ${sid}: centre ${c.map((v) => v.toFixed(0))} r ${this.town.radius}, ${this.town.doors.length} doors, ${this.led} people out, refuge ${this.refuge.map((v) => v.toFixed(0))}; horde in ${setup.hordeIn.toFixed(0)} s, ${setup.burning} burning`);
    this.renderBar(true);
    return true;
  }

  /** the horde arrives: at the town's edge from its road, or (late) already in its streets */
  private hordeComes(inside: boolean): void {
    if (this.hordeCame || !this.town) return;
    const s = this.setup!;
    const c = this.town.centre;
    const at: V2 = inside ? c : this.inside([c[0] + s.from[0] * (this.town.radius + 60), c[1] + s.from[1] * (this.town.radius + 60)], 12);
    this.horde = this.spawnAround(at, s.horde, inside ? this.town.radius * 0.2 : 2, inside ? this.town.radius * 0.7 : 14, s.role, s.faction, { hostile: true, sight: 14, speed: 3.0, health: 3, job: { kind: 'go', to: c } });
    this.hordeCame = true;
    this.say(inside ? 'The dead are in the streets!' : 'The dead are at the gates!');
    this.log.push(`horde of ${s.horde} at ${at.map((v) => v.toFixed(0))} (t ${this.t.toFixed(0)} s)`);
  }

  /** a house set alight near `near`: the door nearest it not burning and outside the hero's ward; false: none */
  private setFire(near: V2, dead: V2[] = [near]): boolean {
    const T = this.town!;
    const ward = totals(this.d.run.loadout, this.d.run.item).ward;
    const i = fireSite(T.doors, this.burning, dead, this.hero.alive ? this.heroAt() : null, ward);
    if (i === null) {
      if (!T.doors.length) {
        // (no doors known: the town's middle and round it)
        const a = this.burning.size * 2.4;
        const p: V2 = [T.centre[0] + Math.cos(a) * T.radius * 0.4, T.centre[1] + Math.sin(a) * T.radius * 0.4];
        this.burning.add(this.burning.size);
        this.d.api.fire!.ignite(p[0], p[1], { radius: 5, intensity: 1 });
        return true;
      }
      return false;
    }
    this.burning.add(i);
    const [x, y] = T.doors[i];
    this.d.api.fire!.ignite(x, y, { radius: 5, intensity: 1 });
    this.d.session.world.burst('dust', x, y, this.d.session.world.top(x, y) + 2);
    return true;
  }

  /** an item used now (the bar's buttons, a script) */
  useItem(id: string): boolean {
    const run = this.d.run;
    const u = use(run.loadout, id, run.item);
    if (!u) return false;
    run.loadout = u.loadout;
    const me = this.heroAt();
    const e = u.effect;
    if (e.kind === 'call-allies') {
      // (the levy's own if it's marching, else the folk round here)
      const fac = run.reinforce?.faction ?? this.d.units.query(me, 400).find((x) => !x.hostile && !!x.faction && !!x.settlement)?.faction ?? null;
      this.allies.push(...this.spawnAround(me, e.count, 4, 10, 'guard', fac, { hostile: false, sight: 20, speed: 3.6, health: 5, role: 'guard', job: { kind: 'follow', target: 'hero', distance: 4 } }));
      this.say(`${run.item(id).name}: ${e.count} come running`);
    } else if (e.kind === 'lure') {
      this.lure = { at: me, t: e.seconds };
      const ids = this.d.units.query(me, e.radius, { hostile: true }).map((x) => x.id);
      this.d.units.order(ids, { kind: 'go', to: me });
      this.say(`${run.item(id).name}: ${ids.length} turn to the sound`);
    }
    this.log.push(`used ${id} (${e.kind}) at t ${this.t.toFixed(0)}`);
    this.renderBar(true);
    return true;
  }

  /** "Follow me": the town's people near the hero take the order; "Hold here": the followers stay */
  orderFollow(): number {
    const sid = this.area.settlement;
    const me = this.heroAt();
    const near = sid ? this.d.townsfolk(sid).filter((id) => {
      const u = this.d.units.get(id);
      return u && Math.hypot(u.at[0] - me[0], u.at[1] - me[1]) < 30;
    }) : [];
    this.d.followers.recruit(near);
    this.d.followers.order({ kind: 'follow', distance: 3 });
    this.log.push(`follow me: ${near.length} near, ${this.d.followers.members().length} following`);
    return near.length;
  }

  orderHold(): void {
    const me = this.heroAt();
    this.d.followers.order({ kind: 'hold', at: me });
    this.log.push(`hold here: ${this.d.followers.members().length}`);
  }

  /** the voxels drawn with the hero: the goal's flag, the refuge's */
  parts(): Part[] {
    const out: Part[] = [];
    const w = this.d.session.world;
    if (this.goal && this.area.play.kind !== 'town' && !this.done) out.push({ voxels: GOAL, at: [this.goal[0], this.goal[1], w.top(this.goal[0], this.goal[1])], q: Q0, size: 0.5 });
    if (this.refuge) out.push({ voxels: REFUGE, at: [this.refuge[0], this.refuge[1], w.top(this.refuge[0], this.refuge[1])], q: Q0, size: 0.5 });
    return out;
  }

  /** the window slid */
  shift(dx: number, dy: number): void {
    const mv = (p: V2 | null): V2 | null => (p ? [p[0] + dx, p[1] + dy] : null);
    this.goal = mv(this.goal);
    this.refuge = mv(this.refuge);
    this.entry = mv(this.entry)!;
    if (this.town) this.town = { ...this.town, centre: mv(this.town.centre)!, doors: this.town.doors.map((p) => mv(p)!) };
    if (this.lure) this.lure.at = mv(this.lure.at)!;
    this.d.followers.shift(dx, dy);
  }

  private alive(ids: UnitId[]): UnitId[] {
    return ids.filter((id) => this.d.units.get(id)?.alive);
  }

  /** Each frame, after the session stepped the hero. */
  update(dt: number): void {
    this.t += dt;
    const me = this.heroAt();
    const p = this.area.play;
    if (p.kind === 'town') return this.updateTown(dt, me);
    if (this.done) return;
    // the outriders keep after the hero
    if (!this.hero.alive) return this.finish({ seconds: this.t, won: false, heroDied: true, pursuers: this.alive(this.pursuers).length });
    const at = this.goal!;
    const dist = Math.hypot(at[0] - me[0], at[1] - me[1]);
    let won = false;
    let line = '';
    const chasing = this.alive(this.pursuers).length;
    switch (p.kind) {
      case 'flee':
        line = `⇢ Get away: ride for the way on · ${chasing} on your heels · ${dist.toFixed(0)} cells`;
        won = dist < THERE;
        break;
      case 'ambush': {
        const left = this.alive(this.foes).length;
        line = `⚔ Break through: ${left} of ${p.foes} in the road · ${dist.toFixed(0)} cells to the way on`;
        won = dist < THERE || left === 0;
        break;
      }
      case 'deliver': {
        const left = Math.max(0, p.limit - this.t);
        line = `✉ Carry the word to ${this.goalName} · ${dist.toFixed(0)} cells · ⏱ ${clock(left)}`;
        won = dist < THERE;
        if (!won && left <= 0) return this.finish({ seconds: this.t, won: false, pursuers: chasing });
        break;
      }
      case 'trader':
        line = `⚖ Reach the trader · ${dist.toFixed(0)} cells`;
        won = dist < THERE;
        break;
    }
    this.text(line);
    this.point(at, me);
    if (won) {
      // (outriders still close behind leave with the hero; ones far back have lost it)
      const still = this.alive(this.pursuers).filter((id) => {
        const u = this.d.units.get(id)!;
        return Math.hypot(u.at[0] - me[0], u.at[1] - me[1]) < 70;
      }).length;
      this.finish({ seconds: this.t, won: true, pursuers: still });
    }
  }

  private updateTown(dt: number, me: V2): void {
    const s = this.setup!;
    const R = this.rules!;
    if (!this.townReady()) {
      this.text(`${this.area.name}: the town is being made…`);
      if (this.waitedTown > 30) throw new Error(`runsit: ${this.area.settlement}'s plan never came in (no places after 30 s)`);
      return;
    }
    const T = this.town!;
    if (!this.hordeCame && this.t >= s.hordeIn) this.hordeComes(false);
    if (s.reinforce && !this.reinforced && this.t >= s.reinforce.in) {
      this.reinforced = true;
      const run = this.d.run;
      const hold = run.sit.areas.find((a) => a.play.kind === 'deliver');
      const dir = hold ? unit(delta(run.map.areaAt(this.area), run.map.areaAt(hold), run.map.world)) : ([-s.from[0], -s.from[1]] as V2);
      const at = this.inside([T.centre[0] + dir[0] * (T.radius + 50), T.centre[1] + dir[1] * (T.radius + 50)], 12);
      this.allies.push(...this.spawnAround(at, s.reinforce.count, 2, 10, s.reinforce.role, s.reinforce.faction, { hostile: false, sight: 22, speed: 3.8, health: 6, role: 'guard', job: { kind: 'guard', at: T.centre, radius: 14 } }));
      this.say(`The levy of ${hold?.name ?? 'the hold'} is here!`);
      this.log.push(`levy of ${s.reinforce.count} at t ${this.t.toFixed(0)}`);
    }
    // the lure's pull wears off: back to the town
    if (this.lure) {
      this.lure.t -= dt;
      if (this.lure.t <= 0) {
        this.lure = null;
        this.d.units.order(this.alive(this.horde), { kind: 'go', to: T.centre });
      }
    }
    const horde = this.alive(this.horde);
    const inside: V2[] = [];
    for (const id of horde) {
      const u = this.d.units.get(id)!;
      if (Math.hypot(u.at[0] - T.centre[0], u.at[1] - T.centre[1]) < T.radius * INSIDE) inside.push([u.at[0], u.at[1]]);
    }
    let safe = 0;
    if (this.refuge) for (const m of this.d.followers.members()) if (Math.hypot(m.unit.at[0] - this.refuge[0], m.unit.at[1] - this.refuge[1]) < 14) safe++;
    const was = R.status.state;
    const fallen = R.fallen;
    const n = R.step(dt, { t: this.t, heroAlive: this.hero.alive, hordeCame: this.hordeCame, hordeLeft: horde.length, hordeInside: inside.length, refugees: s.mode === 'evacuate' ? { led: this.led, safe } : undefined });
    for (let i = 0; i < n; i++) if (!this.setFire(inside[i % Math.max(1, inside.length)] ?? T.centre, inside)) R.unset();
    if (!fallen && R.fallen) {
      // the town has fallen: the rest of it is fired (it burns down in the map)
      let k = 0;
      while (this.setFire(T.centre, [T.centre]) && k++ < 200);
      this.say(`${this.area.name} is burning!`);
      this.log.push(`fallen at t ${this.t.toFixed(0)}: ${this.burning.size} houses alight`);
    }
    if (this.done) {
      this.text(`${this.area.name}: ${R.status.state === 'ended' ? R.status.why : ''} · ${this.burning.size} houses burned`);
      return;
    }
    // the HUD
    const people = this.d.followers.members().length;
    const comes = !this.hordeCame ? `the dead in ${Math.max(0, s.hordeIn - this.t).toFixed(0)} s` : `${horde.length} of the dead left, ${inside.length} inside`;
    const goal = s.mode === 'evacuate' ? `☞ Lead them out: ${people} following, ${safe}/${Math.ceil(this.led / 2)} safe` : `⚔ Hold ${this.area.name}`;
    this.text(`${goal} · ${comes} · 🔥 ${R.fires}/${FALL_AT}`);
    const tgt = s.mode === 'evacuate' && people > 0 ? this.refuge : this.nearestFoe(me) ?? T.centre;
    this.point(tgt, me);
    this.goal = tgt;
    this.renderBar(false);
    const st = R.status as FinaleStatus;
    if (was === 'playing' && st.state === 'ended') {
      this.done = true;
      this.big.textContent = st.end === 'saved' ? 'SAVED' : st.end === 'evacuated' ? 'THEY LIVE' : st.end === 'burned' ? 'IT BURNS' : 'FALLEN';
      this.arrow.style.display = 'none';
      this.log.push(`finale ${st.end}: ${st.why} at t ${this.t.toFixed(0)}`);
      this.resolve({ kind: 'finale', end: st.end, why: st.why, seconds: this.t });
    }
  }

  private nearestFoe(me: V2): V2 | null {
    let best: V2 | null = null;
    let bd = Infinity;
    for (const id of this.horde) {
      const u = this.d.units.get(id);
      if (!u?.alive) continue;
      const dd = Math.hypot(u.at[0] - me[0], u.at[1] - me[1]);
      if (dd < bd) (bd = dd), (best = [u.at[0], u.at[1]]);
    }
    return best;
  }

  private finish(r: AreaResult): void {
    if (this.done) return;
    this.done = true;
    this.big.textContent = r.heroDied ? 'DOWN' : r.won ? '' : 'TOO LATE';
    this.arrow.style.display = 'none';
    this.log.push(`${this.area.id} done: ${JSON.stringify(r)}`);
    this.resolve({ kind: 'area', result: r });
  }

  private say(s: string): void {
    this.big.textContent = s;
    const k = s;
    setTimeout(() => {
      if (this.big.textContent === k) this.big.textContent = '';
    }, 2600);
  }

  private text(s: string): void {
    if (this.banner.textContent !== s) this.banner.textContent = s;
  }

  /** the buttons: Follow me / Hold here in the town, and the items that can be used */
  private renderBar(force: boolean): void {
    const run = this.d.run;
    const usable = totals(run.loadout, run.item).usable.filter((u) => u.uses > 0);
    const town = this.area.play.kind === 'town' && !!this.town;
    const key = `${town}|${usable.map((u) => `${u.id}:${u.uses}`).join(',')}`;
    if (!force && key === this.barKey) return;
    this.barKey = key;
    this.bar.innerHTML = '';
    const btn = (label: string, f: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'min-height:44px;min-width:96px;padding:6px 10px;border-radius:9px;border:1px solid #6b5b3e;background:rgba(42,36,26,0.92);color:#f3e8cf;font:600 13px system-ui,sans-serif;';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      this.bar.appendChild(b);
    };
    if (town) {
      btn('☞ Follow me', () => void this.orderFollow());
      btn('✋ Hold here', () => this.orderHold());
    }
    for (const u of usable) btn(`${u.kind === 'lure' ? '🔔' : '📯'} ${u.name} (${u.uses})`, () => void this.useItem(u.id));
  }

  /** the arrow at the screen's edge toward a point off screen */
  private point(tgt: V2 | null, me: V2): void {
    if (!tgt) {
      this.arrow.style.display = 'none';
      return;
    }
    const w = this.d.session.world;
    const [sx, sy] = w.project(tgt[0], tgt[1], w.top(tgt[0], tgt[1]));
    const W = innerWidth;
    const H = innerHeight;
    const pad = 40;
    const on = sx > pad && sy > pad + 40 && sx < W - pad && sy < H - pad;
    if (on && Math.hypot(tgt[0] - me[0], tgt[1] - me[1]) < 50) {
      this.arrow.style.display = 'none';
      return;
    }
    let dx = sx - W / 2;
    let dy = sy - H / 2;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const k = Math.min(Math.abs((W / 2 - pad) / (dx || 1e-6)), Math.abs((H / 2 - pad) / (dy || 1e-6)));
    const ax = on ? sx : W / 2 + dx * k;
    const ay = on ? sy - 30 : H / 2 + dy * k;
    this.arrow.style.display = '';
    this.arrow.style.left = `${ax - 13}px`;
    this.arrow.style.top = `${ay - 13}px`;
    this.arrow.style.transform = `rotate(${Math.atan2(dy, dx) + Math.PI / 2}rad)`;
  }

  /** the area's units gone (a finale's town keeps its fires and its dead: what the run left in the map) */
  dispose(): void {
    this.banner.remove();
    this.arrow.remove();
    this.big.remove();
    this.bar.remove();
    for (const id of [...this.pursuers, ...this.foes, ...this.allies, ...this.horde]) this.d.units.remove(id);
    if (this.trader !== null) this.d.units.remove(this.trader);
    this.d.followers.dismiss(this.d.followers.members().map((m) => m.unit.id));
  }
}

const Q0: [number, number, number, number] = [0, 0, 0, 1];

function flag(cloth: number, pole = MAT.Wood, h = 8): Voxels {
  const v: Voxels = [];
  for (let u = 0; u < h; u++) v.push({ at: [0, 0, u * 0.5 + 0.25], mat: pole });
  for (let f = 0; f < 4; f++) for (let u = h - 3; u < h; u++) v.push({ at: [f * 0.5 + 0.5, 0, u * 0.5 + 0.25], mat: cloth });
  return v;
}
const GOAL = flag(MAT.Lava, MAT.Wood, 10);
const REFUGE = flag(MAT.Leaves, MAT.Wood, 10);

function div(parent: HTMLElement, css: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  parent.appendChild(d);
  return d;
}

function unit(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

function delta(a: V2, b: V2, world: { w: number; h: number }): V2 {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  dx -= Math.round(dx / world.w) * world.w;
  dy -= Math.round(dy / world.h) * world.h;
  return [dx, dy];
}

function clock(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
