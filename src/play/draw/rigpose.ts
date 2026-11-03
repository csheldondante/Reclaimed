// ---- play/draw/rigpose.ts ---------------------------------------------------------------------------------------
// (knight, round 128) A body from the character generator (src/inhabitants/rig.ts buildRig: the same rig the GPU
// creatures are built from — plan, proportions, palette, gear) posed on the CPU for a hero, and drawn as voxels along
// its bones (draw/voxels.ts, beside the other heroes' parts). Why here and not in src/inhabitants: the generator's
// animation runs on the GPU for groups its behaviours drive (inhabitants.wgsl animate); a hero is one body the player
// drives frame by frame, whose hands the hero places (a sword swung, a bow drawn). What the generator lacks for that
// is listed in DEVLOG round 128 (a CPU pose of a rig; hand targets; a held-item slot that isn't a rigid bone).
//
// The pose is the generator's roles, simply: the root over the feet, rigid parts turned with the heading (the chest
// leaning into the run), feet stepping in a walk cycle (gait groups opposite), knees and elbows by two-bone IK, arms
// swinging with the gait unless a hand is placed, cape links hanging and trailing the way it moves. Pure: no GPU.

import type { SpeciesSpec } from '../../api/contracts/inhabitants';
import { buildRig, Role, type Rig } from '../../inhabitants/rig';
import { MATERIALS } from '../../world/materials';
import type { Part, V3, Voxels } from './shapes';

export interface Pose {
  /** its feet (cells) */
  at: V3;
  heading: number;
  /** 0..1: how hard it's running (the stride's size and the arms' swing) */
  pace: number;
  /** the walk cycle (radians) */
  phase: number;
  /** its velocity (the cape trails it) */
  vel: V3;
  /** the ground's height (feet plant on it) */
  floor: (x: number, y: number) => number;
  /** where a hand is put (world), or null: swinging with the gait */
  handR?: V3 | null;
  handL?: V3 | null;
  /** extra lean forward (radians: a lunge, a draw) and a turn of the upper body from the heading (radians: a swing) */
  lean?: number;
  twist?: number;
  /** how much lower the root sits (cells: a crouch on landing, a dodge) */
  crouch?: number;
  /** the hurt flash 0..1 */
  flash?: number;
}

/** A rig built once, with what's derived from it for posing and drawing. */
export class PosedBody {
  readonly rig: Rig;
  /** each point's material (its segments' colours, nearest in the world's material table) */
  private mats: number[];
  readonly handR: number;
  readonly handL: number;
  readonly shoulderR: number;
  readonly shoulderL: number;
  /** the arm's length (shoulder to hand) */
  readonly arm: number;
  /** the world positions of the last pose */
  readonly pts: V3[];

  /** (round 128, the horse) a four-legged body's feet by leg (fl, fr, bl, br): their gait offsets; null for a biped */
  private readonly legs: (string | null)[] | null;

  constructor(spec: SpeciesSpec) {
    if (spec.plan !== 'biped' && spec.plan !== 'quadruped') throw new Error(`rigpose: a hero's body is a biped or a quadruped (got "${spec.plan}")`);
    this.rig = buildRig(spec);
    const idx = (name: string) => {
      const i = this.rig.points.findIndex((p) => p.name === name);
      if (i < 0) throw new Error(`rigpose: the ${spec.plan} rig has no "${name}"`);
      return i;
    };
    const biped = spec.plan === 'biped';
    this.handR = biped ? idx('handR') : -1;
    this.handL = biped ? idx('handL') : -1;
    this.shoulderR = biped ? idx('shoulderR') : -1;
    this.shoulderL = biped ? idx('shoulderL') : -1;
    const h = biped ? this.rig.points[this.handR].rest : [0, 0, 0];
    this.arm = Math.hypot(h[0], h[1], h[2]);
    this.legs = biped ? null : this.rig.points.map((p) => (p.role === Role.Foot ? p.name.split('.')[0] : null));
    this.mats = this.rig.segments.map((s) => nearestMat(s.colour));
    this.pts = this.rig.points.map(() => [0, 0, 0] as V3);
    this.chestLean = this.rig.points.find((p) => p.name === 'chest')?.p[0] ?? 0;
  }

  /** the chest's lean into a run (radians at a full run: the rig's own) */
  private readonly chestLean: number;

  /** the height of its head over its feet (cells) */
  get height(): number {
    return this.rig.height * 1.9;
  }

  /** Where its points are in this pose (world; also kept in `pts`). */
  pose(p: Pose): V3[] {
    const rig = this.rig;
    const c = Math.cos(p.heading);
    const sn = Math.sin(p.heading);
    // (rest offsets are (forward, left, up) in the body's frame)
    const turn = (r: readonly number[], h: number, pitch = 0): V3 => {
      // pitch: forward lean (about the left axis): up tips toward forward
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const f = r[0] * cp + r[2] * sp;
      const u = r[2] * cp - r[0] * sp;
      const ch = Math.cos(h);
      const sh = Math.sin(h);
      return [f * ch - r[1] * sh, f * sh + r[1] * ch, u];
    };
    const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const pace = Math.max(0, Math.min(1, p.pace));
    const bob = Math.abs(Math.sin(p.phase)) * 0.05 * pace;
    const lean = p.lean ?? 0;
    const twist = p.twist ?? 0;
    const out = this.pts;
    const upperOf: boolean[] = [];
    rig.points.forEach((pt, i) => {
      upperOf[i] = false;
      const parent = pt.parent >= 0 ? out[pt.parent] : null;
      switch (pt.role) {
        case Role.Root:
          out[i] = [p.at[0], p.at[1], p.at[2] + pt.p[0] - (p.crouch ?? 0) + bob];
          break;
        case Role.Foot: {
          const hip = parent!;
          // (a biped's feet opposite; a four-legged body's by its gait: walk, trot, canter, gallop by its pace)
          const g = this.legs ? gaitOffset(pace, this.legs[i] ?? '') : pt.p[0] ? Math.PI : 0;
          const swing = Math.sin(p.phase + g);
          const stride = rig.stride * 0.55 * pace;
          const x = hip[0] + c * swing * stride;
          const y = hip[1] + sn * swing * stride;
          const lift = Math.max(0, Math.cos(p.phase + g)) * rig.lift * 1.6 * pace;
          out[i] = [x, y, p.floor(x, y) + lift + 0.03];
          break;
        }
        case Role.Knee: {
          const end = out[pt.p[0]];
          out[i] = ik(parent!, end, pt.p[1], pt.p[2], pt.p[3] > 0 ? [c, sn, 0] : pt.p[3] < 0 ? [-c, -sn, 0] : [0, 0, 1]);
          break;
        }
        case Role.Swing: {
          const placed = i === this.handR ? p.handR : i === this.handL ? p.handL : null;
          if (placed) {
            // (the hand where it's put, within the arm's reach of the shoulder)
            const d: V3 = [placed[0] - parent![0], placed[1] - parent![1], placed[2] - parent![2]];
            const l = Math.hypot(d[0], d[1], d[2]);
            const k = l > this.arm * 0.98 ? (this.arm * 0.98) / l : 1;
            out[i] = [parent![0] + d[0] * k, parent![1] + d[1] * k, parent![2] + d[2] * k];
          } else {
            const a = pt.p[0] * Math.sin(p.phase + pt.p[1]) * pace;
            out[i] = add(parent!, turn(pt.rest, p.heading + twist, -a));
          }
          break;
        }
        case Role.Chain: {
          // (hangs from its parent, trailing the way it moves and fluttering a little)
          const r = Math.hypot(pt.rest[0], pt.rest[1], pt.rest[2]);
          const back = turn([pt.rest[0], pt.rest[1], 0], p.heading);
          const sp = Math.hypot(p.vel[0], p.vel[1]);
          const trail = Math.min(1.2, sp * 0.12);
          const flutter = Math.sin(p.phase * 2 + i) * 0.15 * Math.min(1, sp / 6);
          let d: V3 = [back[0] * 3 - (p.vel[0] / (sp || 1)) * trail, back[1] * 3 - (p.vel[1] / (sp || 1)) * trail, -1 + flutter];
          const l = Math.hypot(d[0], d[1], d[2]) || 1;
          d = [(d[0] / l) * r, (d[1] / l) * r, (d[2] / l) * r];
          out[i] = add(parent!, d);
          break;
        }
        default: {
          // Rigid and Head: turned with the body; the chest leans into the run (its p[0]) and the swing's twist
          // (what hangs off the chest leans and twists with it)
          const isChest = pt.name === 'chest';
          const upper = isChest || upperOf[pt.parent];
          upperOf[i] = upper;
          const h = upper ? p.heading + twist : p.heading;
          const pitch = upper ? (this.chestLean * pace * 0.5 + lean) : 0;
          out[i] = add(parent ?? p.at, turn(pt.rest, h, pitch));
        }
      }
    });
    return out;
  }

  /**
   * The posed body as voxel parts (one a bone: its voxels' edge is the bone's thickness). In world coordinates under
   * the identity turn (draw/shapes.ts modelToWorld flips y: done here).
   */
  parts(flash = 0): Part[] {
    const out: Part[] = [];
    const pts = this.pts;
    const o = pts[0];
    this.rig.segments.forEach((sg, k) => {
      const mat = this.mats[k];
      const vox: Voxels = [];
      if (sg.kind === 'bone') {
        const a = pts[sg.a];
        const b = pts[sg.b];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const size = Math.max(0.09, Math.min(0.32, sg.ra + sg.rb));
        const n = Math.max(1, Math.ceil(len / (size * 0.7)));
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          vox.push({ at: [a[0] + (b[0] - a[0]) * f - o[0], -(a[1] + (b[1] - a[1]) * f - o[1]), a[2] + (b[2] - a[2]) * f - o[2]], mat });
        }
        out.push({ voxels: vox, at: o, q: [0, 0, 0, 1], flash, size });
      } else {
        // cloth: the triangle filled
        const a = pts[sg.a];
        const b = pts[sg.b];
        const cc = pts[sg.c];
        const size = 0.12;
        const n = Math.max(1, Math.ceil(Math.max(dist(a, b), dist(a, cc), dist(b, cc)) / (size * 0.8)));
        for (let i = 0; i <= n; i++)
          for (let j = 0; j <= n - i; j++) {
            const u = i / n;
            const v = j / n;
            const w = 1 - u - v;
            vox.push({ at: [a[0] * w + b[0] * u + cc[0] * v - o[0], -(a[1] * w + b[1] * u + cc[1] * v - o[1]), a[2] * w + b[2] * u + cc[2] * v - o[2]], mat });
          }
        out.push({ voxels: vox, at: o, q: [0, 0, 0, 1], flash, size });
      }
    });
    return out;
  }
}

const dist = (a: V3, b: V3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** (round 128, the horse) each leg's place in the stride (a share of the cycle) by gait: a four-beat walk, the trot's
 *  diagonal pairs, the canter's three beats, the gallop's near-paired hind then fore */
export const GAITS: Record<'walk' | 'trot' | 'canter' | 'gallop', Record<string, number>> = {
  walk: { fl: 0, br: 0.25, fr: 0.5, bl: 0.75 },
  trot: { fl: 0, br: 0, fr: 0.5, bl: 0.5 },
  canter: { bl: 0, br: 0.33, fl: 0.33, fr: 0.66 },
  gallop: { bl: 0, br: 0.1, fl: 0.5, fr: 0.6 },
};

/** the gait at a pace (0..1 of its top speed) */
export const gaitAt = (pace: number): keyof typeof GAITS => (pace < 0.25 ? 'walk' : pace < 0.5 ? 'trot' : pace < 0.8 ? 'canter' : 'gallop');

function gaitOffset(pace: number, leg: string): number {
  return (GAITS[gaitAt(pace)][leg] ?? 0) * Math.PI * 2;
}

/** Two-bone IK: the joint between `a` and `b` with these lengths, bent toward `pole`. */
export function ik(a: V3, b: V3, l1: number, l2: number, pole: V3): V3 {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  let len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return [a[0] + pole[0] * l1, a[1] + pole[1] * l1, a[2] + pole[2] * l1];
  const u: V3 = [d[0] / len, d[1] / len, d[2] / len];
  len = Math.min(len, (l1 + l2) * 0.999);
  const along = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  // (the pole's part across the bone)
  const pd = pole[0] * u[0] + pole[1] * u[1] + pole[2] * u[2];
  let bx = pole[0] - u[0] * pd;
  let by = pole[1] - u[1] * pd;
  let bz = pole[2] - u[2] * pd;
  const bl = Math.hypot(bx, by, bz);
  if (bl < 1e-6) [bx, by, bz] = [0, 0, 1];
  else [bx, by, bz] = [bx / bl, by / bl, bz / bl];
  return [a[0] + u[0] * along + bx * h, a[1] + u[1] * along + by * h, a[2] + u[2] * along + bz * h];
}

/** the world's material nearest a colour (0xrrggbb) by its albedo — the voxels are drawn by material */
const matCache = new Map<number, number>();
export function nearestMat(colour: number): number {
  const hit = matCache.get(colour);
  if (hit !== undefined) return hit;
  const r = ((colour >> 16) & 255) / 255;
  const g = ((colour >> 8) & 255) / 255;
  const b = (colour & 255) / 255;
  let best = 1;
  let bd = Infinity;
  MATERIALS.forEach((m, i) => {
    // (solid, opaque, unlit materials only: no air, liquids, glass or glow)
    if (i === 0 || m.state === undefined || m.glass || m.emissive > 0 || m.name === 'water' || m.name === 'oil' || m.name === 'external') return;
    const d = (m.albedo[0] - r) ** 2 + (m.albedo[1] - g) ** 2 + (m.albedo[2] - b) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  matCache.set(colour, best);
  return best;
}
