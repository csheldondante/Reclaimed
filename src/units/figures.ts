// ---- units/figures.ts -----------------------------------------------------------
// The hero and the units drawn as little voxel figures (round 88): a few cubes each, written from the CPU
// every frame into an instance buffer the renderer draws like a physics body's voxels (Renderer.addVoxels:
// lit, shadowed, the hurt flash through the body glow bits) — the same form the GPU agents' units.wgsl writes.
// Readable first: legs that stride, a torso in its faction's colour, a head, a weapon that swings; a wind-up
// leans in; the dead lie down. Up to MAX figures.

import type { UnitView, V3 } from '../api/contracts/units';
import type { Renderer } from '../render/renderer';
import { MAT } from '../world/materials';

const MAX = 96;
const PER = 8;
/** units.wgsl's: a body voxel that glows (the hurt flash), its heat in bits 16–23 */
const PHYS_BIT = 0x40000000;

/** a figure to draw */
export interface FigurePose {
  at: V3;
  heading: number;
  /** cells tall */
  height: number;
  /** materials: torso, head, legs, weapon (0: none) */
  torso: number;
  head: number;
  legs: number;
  weapon: number;
  /** the walk cycle 0..1 and how fast it's going (0: standing) */
  phase: number;
  moving: boolean;
  /** −1..1 the weapon's swing across the front (0: held up); null: at rest */
  swing: number | null;
  /** 0..1: a wind-up's lean */
  lean: number;
  /** 0..1 the hurt flash */
  flash: number;
  dead: boolean;
}

/** a unit's figure: its faction's colours (see FACTION_MATS), its state */
export function unitPose(u: UnitView, t: number): FigurePose {
  const m = materialsFor(u);
  const swinging = u.state === 'swing';
  return {
    at: u.at,
    heading: u.heading,
    height: u.role.includes('lich') ? 2.8 : 2.2,
    ...m,
    phase: (t * 1.6 + u.id * 0.37) % 1,
    moving: u.state === 'walk' || u.state === 'chase',
    swing: swinging ? -0.9 : null,
    lean: swinging ? 1 : 0,
    flash: u.state === 'hurt' ? 1 : 0,
    dead: !u.alive,
  };
}

/** the materials a unit is drawn in: by faction, the dead in bone */
function materialsFor(u: UnitView): Pick<FigurePose, 'torso' | 'head' | 'legs' | 'weapon'> {
  if (u.role.includes('dead') || u.role.includes('lich')) return { torso: MAT.Bone, head: MAT.Bone, legs: MAT.Basalt, weapon: u.role.includes('lich') ? MAT.Rust : 0 };
  const f = u.faction ?? '';
  const torso = f.includes('choir') ? MAT.Grass : f.includes('ash') ? MAT.Rust : f.includes('kuharm') ? MAT.Brick : f.includes('court') ? MAT.Basalt : MAT.Wood;
  return { torso, head: MAT.Canvas, legs: MAT.Asphalt, weapon: u.hostile ? MAT.Steel : 0 };
}

export class Figures {
  private inst: GPUBuffer;
  private indirect: GPUBuffer;
  private data = new ArrayBuffer(MAX * PER * 32);
  private f = new Float32Array(this.data);
  private u = new Uint32Array(this.data);

  constructor(
    private device: GPUDevice,
    renderer: Renderer,
  ) {
    this.inst = device.createBuffer({ label: 'figures', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.indirect = device.createBuffer({ label: 'figuresIndirect', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    renderer.addVoxels(this.inst, this.indirect);
  }

  /** Each frame: these figures. */
  draw(poses: FigurePose[]): void {
    let n = 0;
    const put = (c: V3, size: number, mat: number, q: [number, number, number, number], flash: number) => {
      if (n >= MAX * PER || !mat) return;
      const o = n * 8;
      this.f[o] = c[0];
      this.f[o + 1] = c[1];
      this.f[o + 2] = c[2];
      this.u[o + 3] = mat | (Math.min(63, Math.round(size * 16)) << 24) | (flash > 0 ? PHYS_BIT | (Math.round(flash * 255) << 16) : 0);
      this.f[o + 4] = q[0];
      this.f[o + 5] = q[1];
      this.f[o + 6] = q[2];
      this.f[o + 7] = q[3];
      n++;
    };
    for (const p of poses.slice(0, MAX)) {
      const h = p.height;
      // its frame: forward (fx, fy), right, up; lying down the dead turn up into forward
      const fx = Math.cos(p.heading);
      const fy = Math.sin(p.heading);
      const q = qz(p.heading);
      const at = (fwd: number, side: number, up: number): V3 => {
        if (p.dead) [fwd, up] = [up, 0.25 * h * 0.4 + fwd * 0.2];
        return [p.at[0] + fx * fwd - fy * side, p.at[1] + fy * fwd + fx * side, p.at[2] + up];
      };
      const qq = p.dead ? qmul(q, qy(-Math.PI / 2)) : q;
      const leg = h * 0.2;
      const torso = h * 0.36;
      const head = h * 0.24;
      const stride = p.moving ? Math.sin(p.phase * Math.PI * 2) * leg * 0.7 : 0;
      const bob = p.moving ? Math.abs(Math.sin(p.phase * Math.PI * 2)) * 0.08 * h : 0;
      const lean = p.lean * h * 0.12;
      put(at(stride, leg * 0.55, leg * 0.5), leg, p.legs, qq, p.flash);
      put(at(-stride, -leg * 0.55, leg * 0.5), leg, p.legs, qq, p.flash);
      put(at(lean * 0.5, 0, leg * 1.1 + torso * 0.5 + bob), torso, p.torso, qq, p.flash);
      put(at(lean + 0.04 * h, 0, leg * 1.1 + torso + head * 0.5 + bob), head, p.head, qq, p.flash);
      if (p.weapon) {
        // (the weapon: three cubes out from the right hand; a swing sweeps it across the front)
        const a = p.swing === null ? -0.25 : p.swing * 1.3;
        const reach = p.swing === null ? 0.2 : 1;
        const hand: [number, number, number] = [torso * 0.35, torso * 0.65, leg * 1.1 + torso * 0.55 + bob];
        const wq = qmul(q, qz(-a));
        for (let k = 1; k <= 3; k++) {
          const r = k * h * 0.16;
          const dfwd = Math.cos(-a) * r * reach + (1 - reach) * 0.05 * k;
          const dside = Math.sin(-a) * r * reach;
          const up = p.swing === null ? hand[2] + r * 0.9 : hand[2] + r * 0.12;
          put(at(hand[0] + dfwd, -(hand[1] + dside), up), h * 0.1, p.weapon, wq, 0);
        }
      }
    }
    if (n) this.device.queue.writeBuffer(this.inst, 0, this.data, 0, n * 32);
    this.device.queue.writeBuffer(this.indirect, 4, new Uint32Array([n]));
  }

  dispose(): void {
    // (the renderer keeps drawing its sources: what's left is no figures)
    this.device.queue.writeBuffer(this.indirect, 4, new Uint32Array([0]));
  }
}

function qz(a: number): [number, number, number, number] {
  return [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
}
function qy(a: number): [number, number, number, number] {
  return [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
}
function qmul(p: [number, number, number, number], q: [number, number, number, number]): [number, number, number, number] {
  return [
    p[3] * q[0] + q[3] * p[0] + (p[1] * q[2] - p[2] * q[1]),
    p[3] * q[1] + q[3] * p[1] + (p[2] * q[0] - p[0] * q[2]),
    p[3] * q[2] + q[3] * p[2] + (p[0] * q[1] - p[1] * q[0]),
    p[3] * q[3] - (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]),
  ];
}
