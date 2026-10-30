// The species table the GPU reads (inhabitants.wgsl SpeciesTable): fixed regions per species so a kernel indexes
// with no lookups. Mirrored in inhabitants.wgsl (sp*, pt*, sg* helpers) — keep both sides in step.
//
//   [MAX_SPECIES × HDR vec4 headers][MAX_SPECIES × MAX_POINTS × 2 vec4 points][MAX_SPECIES × MAX_SEGS × 2 vec4 segments]

import type { BodyPlan, SpeciesSpec } from '../api/contracts/inhabitants';
import { MAX_POINTS, MAX_SEGS, type Rig } from './rig';

export const MAX_SPECIES = 16;
export const HDR = 6;
export const TABLE_VEC4 = MAX_SPECIES * HDR + MAX_SPECIES * MAX_POINTS * 2 + MAX_SPECIES * MAX_SEGS * 2;

export const BEHAVIOUR_CODE = { herd: 0, flock: 1, stalker: 2, townsfolk: 3, wander: 4 } as const;
export const PLAN_CODE: Record<BodyPlan, number> = { biped: 0, quadruped: 1, bird: 2, serpent: 3, insect: 4, beast: 5, winged: 6 };

/** defaults by plan: walk, run (cells/s) */
const PACE: Record<BodyPlan, [number, number]> = { biped: [1.4, 4.5], quadruped: [1.5, 8], bird: [0.8, 9], serpent: [1.2, 4], insect: [1, 3], beast: [1.2, 6], winged: [1.6, 10] };

export interface Packed {
  /** species index → its rig's derived numbers the CPU needs */
  vertsPerAgent: number;
}

/** write species `sp` (its spec, rig, and the prey mask from other species' ids) into `table` (Float32Array of TABLE_VEC4 × 4) */
export function packSpecies(table: Float32Array, sp: number, spec: SpeciesSpec, rig: Rig, preyMask: number): void {
  if (sp < 0 || sp >= MAX_SPECIES) throw new Error(`inhabitants: species slot ${sp} (max ${MAX_SPECIES})`);
  const [walk, run] = PACE[spec.plan];
  const h = sp * HDR * 4;
  const mass = spec.mass ?? Math.max(0.2, rig.height * rig.height * (spec.plan === 'beast' ? 2 : 1));
  const threat = spec.threat ?? (spec.behaviour.kind === 'stalker' ? 0.8 : 0);
  table.set([spec.walk ?? walk, spec.run ?? run, spec.sight ?? 14, rig.height], h);
  table.set([BEHAVIOUR_CODE[spec.behaviour.kind], threat, mass, preyMask], h + 4);
  table.set([rig.stride, rig.stepTime, rig.lift, rig.flies ? Math.max(6, rig.height * 6) : 0], h + 8);
  table.set([rig.points.length, rig.segments.length, rig.vertsPerAgent, rig.flies ? 1 : 0], h + 12);
  table.set([rig.radius, rig.length, PLAN_CODE[spec.plan], spec.plan === 'winged' ? 1.6 : 5], h + 16);
  table.set([0, 0, 0, 0], h + 20);
  const P = (MAX_SPECIES * HDR + sp * MAX_POINTS * 2) * 4;
  table.fill(0, P, P + MAX_POINTS * 8);
  rig.points.forEach((pt, i) => {
    table.set([pt.rest[0], pt.rest[1], pt.rest[2], pt.role + (pt.parent + 1) * 16], P + i * 8);
    table.set(pt.p, P + i * 8 + 4);
  });
  const S = (MAX_SPECIES * HDR + MAX_SPECIES * MAX_POINTS * 2 + sp * MAX_SEGS * 2) * 4;
  table.fill(0, S, S + MAX_SEGS * 8);
  rig.segments.forEach((sg, i) => {
    table.set([sg.a, sg.b, sg.c, sg.kind === 'bone' ? 0 : 1], S + i * 8);
    table.set([sg.ra, sg.rb, sg.colour, 0], S + i * 8 + 4);
  });
}

/** the prey mask of `spec` over the defined species ids (bit i: species slot i is prey) */
export function preyMaskOf(spec: SpeciesSpec, ids: readonly string[]): number {
  if (spec.behaviour.kind !== 'stalker') return 0;
  let m = 0;
  for (const p of spec.behaviour.prey) {
    const i = ids.indexOf(p);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}
