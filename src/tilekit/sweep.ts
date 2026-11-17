// (tilekit, TILEKIT.md §5) The panel sweep on the CPU — the same formula as tilekit.wgsl's vertex stage, for the
// tests and the instance packing. A module point (x with its anchor, w out, z up) on the panel a → b with mitres mA, mB
// at its ends:  along = anchored(x, L), s = along / L,  P = a + (b − a)·s + w·lerp(mA, mB, s),  z = z0 + z.

import { along } from './kit';
import type { Joint, Panel, GridMesh } from './grid';

/** floats an instance: ax ay bx by | mAx mAy mBx mBy | z0 mirror 0 0 | r g b seed */
export const IF = 16;

export function packInstance(out: number[], m: GridMesh, p: Panel, z0: number, mirror: boolean, tint: [number, number, number], seed: number, start?: Joint, end?: Joint): void {
  const s = start ?? p.start;
  const e = end ?? p.end;
  out.push(m.xy[p.a * 2], m.xy[p.a * 2 + 1], m.xy[p.b * 2], m.xy[p.b * 2 + 1], s.mx, s.my, e.mx, e.my, z0, mirror ? 1 : 0, 0, 0, tint[0], tint[1], tint[2], seed);
}

/** (step 2) an instance on any segment a → b (a facade bay) with mitres ma, mb */
export function packSeg(out: number[], a: [number, number], b: [number, number], ma: [number, number], mb: [number, number], z0: number, mirror: boolean, tint: [number, number, number], seed: number): void {
  out.push(a[0], a[1], b[0], b[1], ma[0], ma[1], mb[0], mb[1], z0, mirror ? 1 : 0, 0, 0, tint[0], tint[1], tint[2], seed);
}

/** a module point placed by an instance (IF floats at `o`) */
export function sweepPoint(inst: ArrayLike<number>, o: number, x: number, anchor: number, w: number, z: number): [number, number, number] {
  const ax = inst[o];
  const ay = inst[o + 1];
  const bx = inst[o + 2];
  const by = inst[o + 3];
  const L = Math.hypot(bx - ax, by - ay);
  let al = along(x, anchor, L);
  if (inst[o + 9] > 0.5) al = L - al;
  const s = al / L;
  const mx = inst[o + 4] + (inst[o + 6] - inst[o + 4]) * s;
  const my = inst[o + 5] + (inst[o + 7] - inst[o + 5]) * s;
  return [ax + (bx - ax) * s + w * mx, ay + (by - ay) * s + w * my, inst[o + 8] + z];
}
