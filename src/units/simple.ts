// ---- units/simple.ts ------------------------------------------------------------
// The Units contract (api/contracts/units.ts) on the CPU (round 88): enough for a story's cast and a few
// dozen raiders — the simplest thing behind the interface, until the GPU agents (src/agents, branch
// `settlements`) implement it.
// - Walking: straight at the goal over the ground's height (the world API's `heightAt`), a step up of more
//   than STEP cells refused (it slides along the face instead); units push apart a little.
// - Fighting: a hostile unit with no attack order looks for an actor of another faction within its sight,
//   chases it, and swings: a wind-up (WINDUP s, the figure leans in, readable), then the blow lands if the
//   target's still within REACH. Hit, a unit flinches (HURT s) and is knocked back; at 0 health it dies
//   (`died`), lies there CORPSE s and is gone.
// - Guarding: a unit goes back to its guard point when its target's gone or out of LEASH of it.

import type { Actor, SpawnOpts, UnitId, UnitJob, UnitView, Units, V2, V3 } from '../api/contracts/units';
import type { FactionId } from '../api/contracts/world';

/** the ground under (x, y): the world API's Terrain does */
export interface Ground {
  heightAt(x: number, y: number): number | null;
}

/** cells: how near a blow lands from; how far a guard chases from its post */
export const REACH = 1.6;
const LEASH = 28;
/** cells a stride may climb */
const STEP = 1.6;
/** seconds: a swing's wind-up, between swings, a flinch, how long the dead lie */
const WINDUP = 0.45;
const COOLDOWN = 1.1;
const HURT = 0.3;
const CORPSE = 4;

interface Unit {
  v: UnitView;
  sight: number;
  speed: number;
  damage: number;
  /** what it's after now (a unit's id or an actor's) */
  target: UnitId | string | null;
  /** seconds: swing timer, cooldown, flinch, corpse */
  swing: number;
  cool: number;
  flinch: number;
  dead: number;
  /** knockback (cells/s) */
  push: V2;
  noticedOnce: Set<UnitId | string>;
}

const FACTION_COLOURS = ['#7c8a96', '#b0583a', '#5d8a4a', '#b89a4a', '#6a5a9a', '#4a8a8a'];

export class SimpleUnits implements Units {
  readonly died: ((u: UnitView, by: UnitId | string | null) => void)[] = [];
  readonly hurt: ((u: UnitView, damage: number, by: UnitId | string | null) => void)[] = [];
  readonly noticed: ((u: UnitView, target: UnitId | string) => void)[] = [];
  private units = new Map<UnitId, Unit>();
  private actors: Actor[] = [];
  private next = 1;
  private factionCol = new Map<string, string>();

  constructor(private ground: Ground) {}

  spawn(kind: string, at: V2, faction: FactionId | null, o: SpawnOpts = {}): UnitId {
    const id = this.next++;
    const z = this.ground.heightAt(at[0], at[1]);
    if (z === null) throw new Error(`units.spawn: ${kind} at ${at} is outside the world`);
    const hp = o.health ?? 3;
    const v: UnitView = {
      id,
      kind,
      role: o.role ?? kind,
      name: o.name,
      character: o.character,
      settlement: o.settlement,
      faction,
      at: [at[0], at[1], z],
      heading: Math.PI * 0.5,
      health: hp,
      maxHealth: hp,
      hostile: !!o.hostile,
      alive: true,
      job: o.job ?? { kind: 'guard', at: [at[0], at[1]] },
      state: 'idle',
      colour: o.colour ?? this.colourOf(faction),
    };
    this.units.set(id, { v, sight: o.sight ?? 10, speed: o.speed ?? 3, damage: o.damage ?? 1, target: null, swing: 0, cool: 0, flinch: 0, dead: 0, push: [0, 0], noticedOnce: new Set() });
    return id;
  }

  get(id: UnitId): UnitView | null {
    const u = this.units.get(id);
    return u ? copy(u.v) : null;
  }

  /** the live views, for a renderer (not copies: read only) */
  all(): readonly UnitView[] {
    return [...this.units.values()].map((u) => u.v);
  }

  query(near: V2, radius: number, o: { faction?: FactionId | null; hostile?: boolean; dead?: boolean } = {}): UnitView[] {
    const out: { d: number; v: UnitView }[] = [];
    for (const { v } of this.units.values()) {
      if (!v.alive && !o.dead) continue;
      if (o.faction !== undefined && v.faction !== o.faction) continue;
      if (o.hostile !== undefined && v.hostile !== o.hostile) continue;
      const d = Math.hypot(v.at[0] - near[0], v.at[1] - near[1]);
      if (d <= radius) out.push({ d, v });
    }
    return out.sort((a, b) => a.d - b.d).map((x) => copy(x.v));
  }

  byCharacter(character: string): UnitView | null {
    for (const { v } of this.units.values()) if (v.character === character) return copy(v);
    return null;
  }

  order(who: UnitId | UnitId[], job: UnitJob): void {
    for (const id of Array.isArray(who) ? who : [who]) {
      const u = this.must(id);
      u.v.job = job;
      u.target = job.kind === 'attack' ? job.target : null;
    }
  }

  setHostile(id: UnitId, hostile: boolean): void {
    const u = this.must(id);
    u.v.hostile = hostile;
    if (!hostile) u.target = null;
  }

  hit(id: UnitId, damage: number, by: UnitId | string | null): void {
    const u = this.must(id);
    if (!u.v.alive) return;
    u.v.health = Math.max(0, u.v.health - damage);
    u.flinch = HURT;
    u.swing = 0;
    // (knocked back, away from what hit it)
    const from = by === null ? null : this.posOf(by);
    if (from) {
      const dx = u.v.at[0] - from[0];
      const dy = u.v.at[1] - from[1];
      const d = Math.hypot(dx, dy) || 1;
      u.push = [(dx / d) * 7, (dy / d) * 7];
    }
    // (struck, it fights back: whoever hit it)
    if (by !== null && u.v.hostile) u.target = by;
    for (const f of this.hurt) f(copy(u.v), damage, by);
    if (u.v.health <= 0) {
      u.v.alive = false;
      u.v.state = 'dead';
      u.dead = CORPSE;
      for (const f of this.died) f(copy(u.v), by);
    }
  }

  remove(id: UnitId): void {
    this.units.delete(id);
  }

  watch(actor: Actor): void {
    this.actors.push(actor);
  }

  shift(dx: number, dy: number, dz: number): void {
    for (const { v } of this.units.values()) {
      v.at[0] += dx;
      v.at[1] += dy;
      v.at[2] += dz;
      const j = v.job;
      if (j.kind === 'guard') j.at = [j.at[0] + dx, j.at[1] + dy];
      else if (j.kind === 'go') j.to = [j.to[0] + dx, j.to[1] + dy];
      else if (j.kind === 'patrol') j.around = [j.around[0] + dx, j.around[1] + dy];
      else if (j.kind === 'flee') j.from = [j.from[0] + dx, j.from[1] + dy];
      else if (j.kind === 'work') j.at = [j.at[0] + dx, j.at[1] + dy];
    }
  }

  update(dt: number): void {
    for (const [id, u] of this.units) {
      const v = u.v;
      if (!v.alive) {
        u.dead -= dt;
        if (u.dead <= 0) this.units.delete(id);
        continue;
      }
      u.cool = Math.max(0, u.cool - dt);
      // knocked back
      if (u.push[0] || u.push[1]) {
        this.stride(u, u.push[0] * dt, u.push[1] * dt);
        const k = Math.exp(-8 * dt);
        u.push = [u.push[0] * k, u.push[1] * k];
        if (Math.hypot(u.push[0], u.push[1]) < 0.2) u.push = [0, 0];
      }
      if (u.flinch > 0) {
        u.flinch -= dt;
        v.state = 'hurt';
        continue;
      }
      // a hostile one looks for a target
      if (v.hostile && u.target === null) u.target = this.look(u);
      let tp = u.target !== null ? this.posOf(u.target) : null;
      const home = guardPoint(v.job);
      if (tp && (!this.aliveOf(u.target!) || (home && Math.hypot(tp[0] - home[0], tp[1] - home[1]) > LEASH))) {
        u.target = null;
        tp = null;
      }
      if (tp) {
        const d = Math.hypot(tp[0] - v.at[0], tp[1] - v.at[1]);
        v.heading = Math.atan2(tp[1] - v.at[1], tp[0] - v.at[0]);
        if (u.swing > 0) {
          // winding up: the blow lands at the end, if it's still in reach
          u.swing -= dt;
          v.state = 'swing';
          if (u.swing <= 0) {
            u.cool = COOLDOWN;
            if (d <= REACH + 0.4) this.land(u, u.target!);
          }
        } else if (d <= REACH) {
          v.state = 'swing';
          if (u.cool <= 0) u.swing = WINDUP;
          else v.state = 'idle';
        } else {
          v.state = 'chase';
          this.walkTo(u, tp, u.speed * 1.25, dt, REACH * 0.8);
        }
        continue;
      }
      // the job
      const j = v.job;
      let goal: V2 | null = null;
      if (j.kind === 'guard') goal = j.at;
      else if (j.kind === 'go') goal = j.to;
      else if (j.kind === 'work') goal = j.at;
      else if (j.kind === 'follow') {
        const p = this.posOf(j.target);
        if (p && Math.hypot(p[0] - v.at[0], p[1] - v.at[1]) > (j.distance ?? 3)) goal = [p[0], p[1]];
      } else if (j.kind === 'patrol') {
        const t = performance.now() / 1000 / (j.radius * 0.6) + id;
        goal = [j.around[0] + Math.cos(t) * j.radius, j.around[1] + Math.sin(t) * j.radius];
      } else if (j.kind === 'flee') {
        const dx = v.at[0] - j.from[0];
        const dy = v.at[1] - j.from[1];
        const d = Math.hypot(dx, dy) || 1;
        goal = [v.at[0] + (dx / d) * 4, v.at[1] + (dy / d) * 4];
      }
      if (goal && Math.hypot(goal[0] - v.at[0], goal[1] - v.at[1]) > 0.6) {
        v.state = 'walk';
        this.walkTo(u, goal, u.speed, dt, 0.5);
      } else v.state = 'idle';
    }
    this.separate(dt);
  }

  // ---- inside ----

  private must(id: UnitId): Unit {
    const u = this.units.get(id);
    if (!u) throw new Error(`units: no unit ${id}`);
    return u;
  }

  private colourOf(f: FactionId | null): string {
    if (f === null) return '#8a8070';
    let c = this.factionCol.get(f);
    if (!c) this.factionCol.set(f, (c = FACTION_COLOURS[this.factionCol.size % FACTION_COLOURS.length]));
    return c;
  }

  private posOf(t: UnitId | string): V3 | null {
    if (typeof t === 'string') return this.actors.find((a) => a.id === t)?.position() ?? null;
    return this.units.get(t)?.v.at ?? null;
  }

  private aliveOf(t: UnitId | string): boolean {
    if (typeof t === 'string') return this.actors.find((a) => a.id === t)?.alive() ?? false;
    return this.units.get(t)?.v.alive ?? false;
  }

  /** the nearest actor of another faction within sight */
  private look(u: Unit): string | null {
    let best: string | null = null;
    let bd = u.sight;
    for (const a of this.actors) {
      if (!a.alive() || a.faction === u.v.faction) continue;
      const p = a.position();
      if (!p) continue;
      const d = Math.hypot(p[0] - u.v.at[0], p[1] - u.v.at[1]);
      if (d < bd) {
        bd = d;
        best = a.id;
      }
    }
    if (best !== null && !u.noticedOnce.has(best)) {
      u.noticedOnce.add(best);
      for (const f of this.noticed) f(copy(u.v), best);
    }
    return best;
  }

  private land(u: Unit, t: UnitId | string): void {
    if (typeof t === 'string') {
      const a = this.actors.find((x) => x.id === t);
      if (a?.alive()) a.hurt(u.damage, copy(u.v));
    } else if (this.units.has(t)) this.hit(t, u.damage, u.v.id);
  }

  private walkTo(u: Unit, to: V2 | V3, speed: number, dt: number, stop: number): void {
    const v = u.v;
    const dx = to[0] - v.at[0];
    const dy = to[1] - v.at[1];
    const d = Math.hypot(dx, dy);
    if (d <= stop) return;
    const s = Math.min(d - stop, speed * dt);
    v.heading = Math.atan2(dy, dx);
    if (!this.stride(u, (dx / d) * s, (dy / d) * s)) {
      // (blocked: slide along the face, either way)
      const a = v.heading + Math.PI / 2;
      if (!this.stride(u, Math.cos(a) * s, Math.sin(a) * s)) this.stride(u, -Math.cos(a) * s, -Math.sin(a) * s);
    }
  }

  /** step by (dx, dy) if the ground there isn't too steep a climb → moved */
  private stride(u: Unit, dx: number, dy: number): boolean {
    const v = u.v;
    const z = this.ground.heightAt(v.at[0] + dx, v.at[1] + dy);
    if (z === null || z - v.at[2] > STEP) return false;
    v.at[0] += dx;
    v.at[1] += dy;
    v.at[2] = z;
    return true;
  }

  /** units push apart (and off the actors) */
  private separate(dt: number): void {
    const live = [...this.units.values()].filter((u) => u.v.alive);
    const others = this.actors.map((a) => a.position()).filter((p): p is V3 => !!p);
    for (let i = 0; i < live.length; i++) {
      const a = live[i].v;
      let px = 0;
      let py = 0;
      const near = (p: V3, r: number) => {
        const dx = a.at[0] - p[0];
        const dy = a.at[1] - p[1];
        const d = Math.hypot(dx, dy);
        if (d > 0.01 && d < r) {
          px += (dx / d) * (r - d);
          py += (dy / d) * (r - d);
        }
      };
      for (let k = 0; k < live.length; k++) if (k !== i) near(live[k].v.at, 1.2);
      for (const p of others) near(p, 1.1);
      if (px || py) this.stride(live[i], px * Math.min(1, dt * 6), py * Math.min(1, dt * 6));
    }
  }
}

const guardPoint = (j: UnitJob): V2 | null => (j.kind === 'guard' ? j.at : j.kind === 'patrol' ? j.around : j.kind === 'work' ? j.at : null);

function copy(v: UnitView): UnitView {
  return { ...v, at: [...v.at] as V3, job: structuredClone(v.job) };
}
