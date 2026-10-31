// What each material is to the node solver (solver.wgsl SM: 4 vec4 a material). Rock and what's built of it is rigid
// (the design: "rock never deforms, it shatters" — the host breaks it on hard impacts); metal and wood are deformable:
// they bend elastically, past their yield stress they stay bent (plastic), past their strength a bond snaps. Stresses
// are E × strain (tension along a bond, shear across it, the bend at the section's edge): the loads a bond carries, so
// a cantilever yields at its root, a girder under a weight at its middle. The deformables' numbers are tuning
// parameters (tune/params.ts `solver`: E, yield, tensile, shear, stiffness a material), read live.

import { MAT, MAX_MATERIALS } from '../world/materials';
import { TUNE } from '../tune/params';

export interface SolverMat {
  density: number;
  rigid: boolean;
  /** share of the way to its rest shape a substep (deformable) */
  stiffness: number;
  /** share of its bonds' relative speed taken out a substep */
  damping: number;
  /** stress = E × strain */
  E: number;
  yield: number;
  tensile: number;
  shear: number;
  friction: number;
  restitution: number;
  /** impact speed (cells/s) that breaks it (rock: the host's judge) */
  breakSpeed: number;
  /** share of the excess past the yield the rest shape takes a substep */
  plastic: number;
  /** share of a deformable's goal that is its whole part's rigid fit (solver.wgsl SM[3].x) */
  frame: number;
  /** energy a cell³ of dent (SM[3].y; 0 never dents) */
  dent: number;
}

const ROCK: SolverMat = { density: 2.5, rigid: true, stiffness: 1, damping: 0, E: 1, yield: 1e9, tensile: 1e9, shear: 1e9, friction: 0.7, restitution: 0, breakSpeed: 9, plastic: 0, frame: 1, dent: 0 };
const T = () => TUNE.solver;

/** the material's numbers now (the deformables' from the tuning) */
export function solverMat(m: number): SolverMat {
  const t = T();
  switch (m) {
    case MAT.Stone:
      return { ...ROCK, density: 2.7 };
    case MAT.Concrete:
      return { ...ROCK, density: 2.3 };
    case MAT.Brick:
      return { ...ROCK, density: 1.9 };
    case MAT.Ice:
      return { ...ROCK, density: 0.92 };
    case MAT.Steel:
      return { density: 7.8, rigid: false, stiffness: t.steelStiffness, damping: 0.2, E: t.steelE, yield: t.steelYield, tensile: t.steelTensile, shear: t.steelShear, friction: 0.4, restitution: 0, breakSpeed: 40, plastic: 0.9, frame: t.steelFrame, dent: t.steelDent };
    case MAT.Rust:
      return { density: 7, rigid: false, stiffness: t.steelStiffness * 0.85, damping: 0.25, E: t.steelE * 0.8, yield: t.steelYield * 0.8, tensile: t.rustTensile, shear: t.rustTensile * 0.6, friction: 0.6, restitution: 0, breakSpeed: 18, plastic: 0.9, frame: t.steelFrame, dent: t.steelDent * 0.6 };
    case MAT.Wood:
    case MAT.Log:
      return { density: 0.7, rigid: false, stiffness: t.woodStiffness, damping: 0.3, E: t.woodE, yield: t.woodYield, tensile: t.woodTensile, shear: t.woodShear, friction: 0.5, restitution: 0, breakSpeed: 22, plastic: 0.3, frame: t.woodFrame, dent: t.woodDent };
    case MAT.Canvas:
    case MAT.Trash:
      return { density: 0.5, rigid: false, stiffness: 0.3, damping: 0.2, E: 200, yield: 20, tensile: 80, shear: 60, friction: 0.8, restitution: 0, breakSpeed: 20, plastic: 0.4, frame: 0.1, dent: 0 };
    default:
      return ROCK;
  }
}

/** the table as solver.wgsl reads it (SM) */
export function packSolverMats(): Float32Array {
  const out = new Float32Array(MAX_MATERIALS * 16);
  for (let m = 0; m < MAX_MATERIALS; m++) {
    const p = solverMat(m);
    out.set([p.density, p.rigid ? 1 : 0, p.stiffness, p.damping, p.E, p.yield, p.tensile, p.shear, p.friction, p.restitution, p.breakSpeed, p.plastic, p.frame, p.dent, 0, 0], m * 16);
  }
  return out;
}

/** a body's kind by its main material */
export function kindOf(mat: number): 'rigid' | 'deformable' {
  return solverMat(mat).rigid ? 'rigid' : 'deformable';
}
