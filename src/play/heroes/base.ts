// ---- play/heroes/base.ts ----------------------------------------------------------------------------------------
// What every play hero shares (round 117): the engine's Hero contract (contracts/hero.ts — so a run, the GM's story
// or a sandbox drives any of them the same), health, the blows it deals going to the units as AreaHits, and the units
// near it as targets with a velocity (read back positions differenced: the Units contract has none). Each hero is a
// controller (its drive: core/bike.ts, core/levitate.ts …) plus its abilities; its live parameters are a flat
// Params record the sandbox's sliders write into.

import type { Hero, HeroAbility, HeroCamera, HeroIntent } from '../../api/contracts/hero';
import type { Params } from '../../api/contracts/play';
import type { Actor, AreaHit, UnitId, V2, V3 } from '../../api/contracts/units';
import type { PlayWorld } from '../world';
import { NO_INPUT, type ButtonLook, type Pad, type PlayInput } from '../input/types';
import type { Part } from '../draw/shapes';

/** HeroIntent plus the frame's PlayInput (the play controls' gestures; absent: none this frame) */
export interface PlayIntent extends HeroIntent {
  input?: PlayInput;
}

/** A blow a hero deals (play coordinates); `lift` throws, `cone` radians either side of `axis` (or `dir`). */
export type Hit = AreaHit;

/** A unit as a target: its feet, velocity, how tall and wide (cells). */
export interface Target {
  id: UnitId;
  at: V3;
  vel: V3;
  height: number;
  radius: number;
}

/** how tall the GPU agents' people stand (cells: units.wgsl's figures) */
export const UNIT_HEIGHT = 1.6;

export abstract class PlayHero implements Hero {
  readonly id = 'hero';
  readonly actor: Actor;
  readonly abilities: HeroAbility[] = [];
  abstract readonly camera: HeroCamera;
  abstract readonly pad: Pad;
  readonly goesTo = false;
  readonly hurt: ((damage: number, by: string) => void)[] = [];
  readonly died: (() => void)[] = [];
  hp: number;
  hurtT = 99;
  /** seconds in play */
  t = 0;
  /** a jolt for the camera, 0..1 (a hit landed, a hard landing, a slam), decaying: the sandbox shakes the view by it */
  shake = 0;
  readonly params: Params;
  private fell = false;
  private seen = new Map<UnitId, { at: V3; vel: V3; t: number }>();

  constructor(
    readonly role: string,
    protected world: PlayWorld,
    /** its live parameters (a controller's numbers: controllers/*.ts): the sandbox's sliders write here, read each step */
    params: object,
    readonly maxHealth: number,
  ) {
    this.params = params as Params;
    this.hp = maxHealth;
    this.actor = {
      id: this.id,
      faction: null,
      position: () => (this.alive ? this.position() : null),
      alive: () => this.alive,
      hurt: (damage, by) => this.take(damage, [by.at[0], by.at[1]]),
    };
  }

  get health(): number {
    return Math.max(0, this.hp);
  }
  get alive(): boolean {
    return this.hp > 0;
  }
  abstract position(): V3;
  abstract heading(): number;
  abstract speed(): number;
  abstract place(at: V2): void;
  abstract shift(dx: number, dy: number, dz: number): void;
  /** one step of its controller and abilities; the blows it deals go in `hits` */
  protected abstract step(input: PlayInput, dt: number, hits: Hit[]): void;
  /** knocked by a blow from `from` (a hover's shoved; the lich isn't) */
  protected abstract knock(from: V2, damage: number): void;
  /** its voxels this frame (draw/shapes.ts parts) */
  abstract parts(): Part[];
  /** a line for the HUD (speed, air, mode) */
  abstract status(): string;
  /** 0..1: how fast, as a share of its top speed (the camera pulls back with it) */
  abstract fast(): number;
  /** its buttons' gauges and lights */
  looks(): ButtonLook[] {
    return [];
  }
  /** lines drawn over the world while out (a rope, a bolt), none by default */
  beams(): { from: V3; to: V3 }[] {
    return [];
  }

  update(dt: number, intent: PlayIntent): void {
    const hits: Hit[] = [];
    this.t += dt;
    this.hurtT += dt;
    this.shake = Math.max(0, this.shake - dt * 4);
    this.step(this.alive && intent.input ? intent.input : NO_INPUT, dt, hits);
    for (const h of hits) this.world.units.strike(h);
  }

  /** an enemy's blow */
  take(damage: number, from: V2): void {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - damage);
    this.hurtT = 0;
    this.shake = Math.max(this.shake, 0.4);
    this.knock(from, damage);
    for (const cb of this.hurt) cb(damage, 'unit');
    if (!this.alive && !this.fell) {
      this.fell = true;
      for (const cb of this.died) cb();
    }
  }

  /** whole again (the sandbox's respawn) */
  heal(): void {
    this.hp = this.maxHealth;
    this.fell = false;
  }

  /** every tap is its own mechanics (a run never walks it or opens a talk on one) */
  claims(): boolean {
    return true;
  }

  /** the living units within `r` of (x, y), as targets with their velocity (differenced between reads) */
  protected targets(x: number, y: number, r: number): Target[] {
    const out: Target[] = [];
    for (const u of this.world.units.near(x, y, r)) {
      const s = this.seen.get(u.id);
      let vel: V3 = [0, 0, 0];
      if (s) {
        const dt = this.t - s.t;
        const moved = u.at[0] !== s.at[0] || u.at[1] !== s.at[1];
        if (moved && dt > 1e-3) vel = [(u.at[0] - s.at[0]) / dt, (u.at[1] - s.at[1]) / dt, (u.at[2] - s.at[2]) / dt];
        else vel = s.vel;
        if (!moved) {
          out.push({ id: u.id, at: [...u.at], vel, height: UNIT_HEIGHT, radius: 0.45 });
          continue;
        }
      }
      this.seen.set(u.id, { at: [...u.at], vel, t: this.t });
      out.push({ id: u.id, at: [...u.at], vel, height: UNIT_HEIGHT, radius: 0.45 });
    }
    return out;
  }
}
