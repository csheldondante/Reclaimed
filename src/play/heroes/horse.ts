// ---- play/heroes/horse.ts ---------------------------------------------------------------------------------------
// (round 128, the user) The horse as a play hero: a rider on a mount. Its root motion is the shared physical drive on
// foot (core/foot.ts stepFoot with core/drive.ts HORSE_DRIVE: a running start carries it up a slope, it stops when
// let go), the stick through the mount's assist first (core/mount.ts: it follows bends, goes round small things, slows
// into dead ends and stops short of walls; a hard steer is the rider's own). Drawn as the generator's quadruped posed
// on the CPU (draw/rigpose.ts: walk, trot, canter, gallop by its pace) with the knight's body on its back.

import type { HeroCamera } from '../../api/contracts/hero';
import type { V2, V3 } from '../../api/contracts/units';
import { HORSE_BODY, HORSE_CAMERA, HORSE_DEFAULTS, type HorseParams } from '../controllers/horse';
import { KNIGHT_BODY } from '../controllers/knight';
import { HORSE_DRIVE } from '../core/drive';
import { FOOT, makeFoot, speedOf, stepFoot, type Foot, type FootTuning } from '../core/foot';
import type { Pt } from '../core/gestures';
import { mountSteer, type MountOut } from '../core/mount';
import { PosedBody } from '../draw/rigpose';
import type { Part } from '../draw/shapes';
import type { Pad, PlayInput } from '../input/types';
import type { PlayWorld } from '../world';
import { PlayHero, type Hit } from './base';

export class HorseHero extends PlayHero {
  readonly camera: HeroCamera = HORSE_CAMERA;
  readonly pad: Pad = {
    move: 'stick',
    buttons: [],
    hint: 'Push the stick the way you want to go. The horse finds the path. Push hard across its way to steer yourself.',
  };
  private f: Foot;
  private horse = new PosedBody(HORSE_BODY);
  private rider = new PosedBody(KNIGHT_BODY);
  private phase = 0;
  /** the assist's last say (the lab's readout and the tests) */
  last: MountOut = { dir: [0, 0], bend: 0, cap: 1 };

  constructor(world: PlayWorld, at: V2, params: HorseParams = { ...HORSE_DEFAULTS }) {
    super('horse', world, params, 20);
    this.f = makeFoot(at[0], at[1], world.floor);
  }

  private get p(): HorseParams {
    return this.params as HorseParams;
  }
  private foot(): FootTuning {
    return { ...FOOT, speed: HORSE_DRIVE.vMax, step: this.p.step, gravity: this.p.gravity, wade: 1.6, wadeMul: 0.5 };
  }

  position(): V3 {
    return [this.f.x, this.f.y, this.f.z];
  }
  heading(): number {
    return this.f.heading;
  }
  speed(): number {
    return speedOf(this.f);
  }
  fast(): number {
    return Math.min(1, speedOf(this.f) / HORSE_DRIVE.vMax);
  }
  profileClimb(): number {
    return 1;
  }
  place(at: V2): void {
    Object.assign(this.f, makeFoot(at[0], at[1], this.world.floor));
  }
  shift(dx: number, dy: number, dz: number): void {
    this.f.x += dx;
    this.f.y += dy;
    this.f.z += dz;
  }

  protected step(input: PlayInput, dt: number, _hits: Hit[]): void {
    const f = this.f;
    const p = this.p;
    const t = this.foot();
    const climb = 1;
    this.last = mountSteer(input.dir as Pt, [f.x, f.y], [f.vx, f.vy], this.world.floor, climb, HORSE_DRIVE, { assist: p.assist, look: p.look, minLook: 8, cone: p.cone, strong: p.strong, margin: p.margin, small: 2 });
    const s = this.last.dir;
    stepFoot(f, [s[0] * HORSE_DRIVE.vMax, s[1] * HORSE_DRIVE.vMax], dt, this.world.floor, this.world.depth, this.world.bounds, t, null, HORSE_DRIVE);
    const sp = speedOf(f);
    // (it turns to the way it goes, the faster the more firmly)
    if (sp > 0.4) {
      const want = Math.atan2(f.vy, f.vx);
      const d = Math.atan2(Math.sin(want - f.heading), Math.cos(want - f.heading));
      f.heading += d * Math.min(1, dt * 8);
    }
    this.phase += (dt * Math.min(sp, HORSE_DRIVE.vMax)) / Math.max(0.3, this.horse.rig.stride * 0.6);
  }

  protected knock(from: V2, damage: number): void {
    const dx = this.f.x - from[0];
    const dy = this.f.y - from[1];
    const l = Math.hypot(dx, dy) || 1;
    this.f.vx += (dx / l) * 2 * damage;
    this.f.vy += (dy / l) * 2 * damage;
  }

  parts(): Part[] {
    const f = this.f;
    const sp = speedOf(f);
    const pace = Math.min(1, sp / HORSE_DRIVE.vMax);
    const flash = this.hurtT < 0.12 ? 1 : 0;
    this.horse.pose({ at: [f.x, f.y, f.z], heading: f.heading, pace, phase: this.phase, vel: [f.vx, f.vy, f.vz], floor: this.world.floor });
    const out = this.horse.parts(flash);
    // (the rider on its back: the knight's body sat over the horse's middle, its legs hanging either side)
    const back = this.horse.rig.height * 1.05;
    const seat: V3 = [f.x - Math.cos(f.heading) * 0.2, f.y - Math.sin(f.heading) * 0.2, f.z + back];
    const legs = this.rider.rig.height * 0.55;
    this.rider.pose({ at: [seat[0], seat[1], seat[2] - legs * 0.6], heading: f.heading, pace: 0, phase: 0, vel: [f.vx, f.vy, 0], floor: () => seat[2] - legs * 0.75, lean: 0.15 * pace, flash });
    out.push(...this.rider.parts(flash));
    return out;
  }

  status(): string {
    const g = speedOf(this.f);
    const gait = g < 0.3 ? 'still' : g / HORSE_DRIVE.vMax < 0.25 ? 'walk' : g / HORSE_DRIVE.vMax < 0.5 ? 'trot' : g / HORSE_DRIVE.vMax < 0.8 ? 'canter' : 'gallop';
    return `🐎 ${gait} · ${g.toFixed(1)} c/s`;
  }
}
