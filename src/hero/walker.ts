// ---- hero/walker.ts -------------------------------------------------------------
// A hero on foot (round 88; contracts/hero.ts `Hero`): the simplest one — walks the ground the world API
// reports (heightAt, smooth: the drawn mesh, so it glides rather than stepping hex to hex), refuses a climb of
// more than STEP cells a stride (sliding along the face), drops down anything lower; swings a sword.
// - The swing (its one ability, `attack`): a 0.25 s arc in front of it; every hostile unit within REACH and
//   inside the arc takes a blow (Units.hit by its id). With a hostile near it turns to the nearest first, so a
//   tap on a phone hits what's there without aiming.
// - Hurt by a unit (its Actor), it flashes and is knocked back; out of a fight for REGEN_AFTER s it heals a
//   point every REGEN_EVERY s. At 0 it's dead: `died` (the run ends: lost).

import type { Hero, HeroAbility, HeroCamera, HeroIntent, HeroWorld } from '../api/contracts/hero';
import type { Actor, UnitView, V2, V3 } from '../api/contracts/units';

const SPEED = 5.5;
const STEP = 1.6;
const REACH = 2.2;
/** the arc's half-angle's cosine (about 70° either side) */
const ARC = 0.33;
const SWING = 0.25;
const COOLDOWN = 0.5;
const DAMAGE = 1;
const HEALTH = 20;
const REGEN_AFTER = 6;
const REGEN_EVERY = 3;

export interface WalkerOpts {
  id?: string;
  health?: number;
  faction?: string | null;
}

export class Walker implements Hero {
  readonly id: string;
  readonly role = 'wanderer';
  readonly actor: Actor;
  readonly camera: HeroCamera = { zoom: 11, behind: (35 * Math.PI) / 180, firm: (80 * Math.PI) / 180 };
  readonly hurt: ((damage: number, by: string) => void)[] = [];
  readonly died: (() => void)[] = [];
  readonly abilities: HeroAbility[];
  health: number;
  readonly maxHealth: number;
  /** 0..1 through a swing (0: not swinging): the figure's sword */
  swingT = 0;
  /** seconds of the hurt flash left */
  flash = 0;
  /** moving this frame (the figure's stride) */
  pace = 0;
  /** the walk cycle's phase */
  phase = 0;
  private pos: V3 = [0, 0, 0];
  private head = Math.PI / 2;
  private cool = 0;
  private sinceHurt = 99;
  private regen = 0;
  private push: V2 = [0, 0];
  private goal: V2 | null = null;
  private faction: string | null;

  constructor(
    private world: HeroWorld,
    at: V2,
    o: WalkerOpts = {},
  ) {
    this.id = o.id ?? 'hero';
    this.health = this.maxHealth = o.health ?? HEALTH;
    this.faction = o.faction === undefined ? 'player' : o.faction;
    this.place(at);
    const self = this;
    this.actor = {
      id: this.id,
      faction: this.faction,
      position: () => (self.alive ? self.pos : null),
      alive: () => self.alive,
      hurt: (d: number, by: UnitView) => self.takeHit(d, by),
    };
    this.abilities = [{ id: 'attack', name: 'Swing', cooldown: () => this.cool }];
  }

  get alive(): boolean {
    return this.health > 0;
  }

  position(): V3 {
    return this.pos;
  }

  heading(): number {
    return this.head;
  }

  speed(): number {
    return this.pace;
  }

  place(at: V2): void {
    const z = this.world.ground.heightAt(at[0], at[1], { smooth: true });
    if (z === null) throw new Error(`hero: (${at}) is outside the world`);
    this.pos = [at[0], at[1], z];
    this.goal = null;
  }

  shift(dx: number, dy: number, dz: number): void {
    this.pos[0] += dx;
    this.pos[1] += dy;
    this.pos[2] += dz;
    if (this.goal) this.goal = [this.goal[0] + dx, this.goal[1] + dy];
  }

  update(dt: number, it: HeroIntent): void {
    this.cool = Math.max(0, this.cool - dt);
    this.flash = Math.max(0, this.flash - dt);
    this.sinceHurt += dt;
    if (!this.alive) {
      this.pace = 0;
      return;
    }
    // (out of a fight a while: it heals)
    if (this.sinceHurt > REGEN_AFTER && this.health < this.maxHealth) {
      this.regen += dt;
      if (this.regen >= REGEN_EVERY) {
        this.regen = 0;
        this.health++;
      }
    }
    // knocked back
    if (this.push[0] || this.push[1]) {
      this.stride(this.push[0] * dt, this.push[1] * dt);
      const k = Math.exp(-9 * dt);
      this.push = [this.push[0] * k, this.push[1] * k];
      if (Math.hypot(...this.push) < 0.2) this.push = [0, 0];
    }
    // where it's going: the stick, else a point it was sent to
    if (it.goTo !== undefined) this.goal = it.goTo;
    let [mx, my] = it.move;
    const tilt = Math.hypot(mx, my);
    if (tilt > 0.05) this.goal = null;
    else if (this.goal) {
      const dx = this.goal[0] - this.pos[0];
      const dy = this.goal[1] - this.pos[1];
      const d = Math.hypot(dx, dy);
      if (d < 0.8) this.goal = null;
      else [mx, my] = [dx / d, dy / d];
    }
    const m = Math.min(1, Math.hypot(mx, my));
    this.pace = 0;
    if (m > 0.05 && this.swingT === 0) {
      const s = SPEED * m * dt;
      this.head = turn(this.head, Math.atan2(my, mx), dt * 14);
      const ux = mx / Math.hypot(mx, my);
      const uy = my / Math.hypot(mx, my);
      if (this.stride(ux * s, uy * s)) this.pace = SPEED * m;
      else {
        // (a face too steep: along it, whichever way goes)
        const a = Math.atan2(uy, ux);
        for (const side of [1, -1]) {
          const b = a + side * Math.PI * 0.35;
          if (this.stride(Math.cos(b) * s * 0.7, Math.sin(b) * s * 0.7)) {
            this.pace = SPEED * m * 0.7;
            break;
          }
        }
        if (this.pace === 0 && this.goal) this.goal = null;
      }
      this.phase = (this.phase + (this.pace * dt) / 2.2) % 1;
    }
    // falls down what's lower; follows the ground up what it climbed
    const g = this.world.ground.heightAt(this.pos[0], this.pos[1], { smooth: true });
    if (g !== null) this.pos[2] = g < this.pos[2] ? Math.max(g, this.pos[2] - 18 * dt) : g;
    // the swing
    if (this.swingT > 0) {
      this.swingT += dt / SWING;
      if (this.swingT >= 1) this.swingT = 0;
    }
    if (it.attack && this.cool === 0) this.swing();
  }

  /** a swing: turn to the nearest hostile close by, then hit every hostile in the arc */
  private swing(): void {
    const u = this.world.units;
    const near = u.query([this.pos[0], this.pos[1]], REACH + 1.5, { hostile: true });
    if (near.length) this.head = Math.atan2(near[0].at[1] - this.pos[1], near[0].at[0] - this.pos[0]);
    this.cool = COOLDOWN;
    this.swingT = 1e-3;
    const fx = Math.cos(this.head);
    const fy = Math.sin(this.head);
    for (const v of u.query([this.pos[0], this.pos[1]], REACH + 0.4, { hostile: true })) {
      const dx = v.at[0] - this.pos[0];
      const dy = v.at[1] - this.pos[1];
      const d = Math.hypot(dx, dy) || 1;
      if ((dx * fx + dy * fy) / d >= ARC || d < 0.8) u.hit(v.id, DAMAGE, this.id);
    }
  }

  private takeHit(d: number, by: UnitView): void {
    if (!this.alive || this.flash > 0.1) return;
    this.health = Math.max(0, this.health - d);
    this.flash = 0.6;
    this.sinceHurt = 0;
    this.regen = 0;
    const dx = this.pos[0] - by.at[0];
    const dy = this.pos[1] - by.at[1];
    const l = Math.hypot(dx, dy) || 1;
    this.push = [(dx / l) * 6, (dy / l) * 6];
    for (const f of this.hurt) f(d, by.character ?? by.role);
    if (!this.alive) for (const f of this.died) f();
  }

  private stride(dx: number, dy: number): boolean {
    const z = this.world.ground.heightAt(this.pos[0] + dx, this.pos[1] + dy, { smooth: true });
    if (z === null || z - this.pos[2] > STEP) return false;
    this.pos[0] += dx;
    this.pos[1] += dy;
    return true;
  }
}

/** turn angle a toward b by at most `step` radians */
function turn(a: number, b: number, step: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + Math.max(-step, Math.min(step, d));
}
