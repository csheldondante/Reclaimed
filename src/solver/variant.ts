// The physics experiment (the user, round 120: "Can we treat this as an experiment and test each approach side by
// side? Performance batteries and feel tests so I can see what is improved vs the cost?"). Which representation moves
// what the collapse judge frees — chosen per page (`?solver=`, the tuning panel's picker reloads with it):
//
//   old      the step-1 baseline (places): rock as the CPU rigid rock (game/rockbodies.ts), structures as the columns'
//            falling pieces, metal on the physics voxels (phys.wgsl: the tankers' lattice)
//   nodes    everything on the node solver (src/solver): rigid clusters for rock and what's built, stiff deformable
//            nodes (plastic hinges on the loads, dents, snaps) for metal and wood
//   lattice  everything on the voxel lattice (phys.wgsl: a particle a voxel, 26 bonds, lattice shape matching; stone
//            stiff and cracking, metal bending and snapping) — one voxel a cell: the lattice's own grain, the one the
//            tankers looked right at (2 × 2 × 2 blocks would be the node solver's job, not the lattice's)
//   hybrid   rock and what's built on the node solver (rigid clusters that the judge's breaks split along cell
//            boundaries), metal and wood on the voxel lattice
//   engine   the physics engine of DESIGN §10 (src/engine, docs/design/PHYSICS_ENGINE.md), as far as it is built: a
//            lab's dropped blocks and everything the judge frees (rock, structures, metal, wood) are rigid rows on the GPU
//            (terrain contacts, body against body, sleep there, no readback): game/integrity/rows.ts
//
// The judge (what lets go) is picked apart: `?judge=runs|sections` (game/judge.ts JUDGES — the column judge and
// the method of sections on the GPU, from branch `judge`).

import { urlFlags } from '../flags';
export type SolverVariant = 'old' | 'nodes' | 'lattice' | 'hybrid' | 'engine';
export const VARIANTS: readonly SolverVariant[] = ['old', 'nodes', 'lattice', 'hybrid', 'engine'];

/** what carries each kind of thing the judge frees */
export interface Routing {
  /** rock: the CPU rigid rock, the node solver, or the voxel lattice */
  rock: 'cpu' | 'nodes' | 'lattice' | 'engine';
  /** what the structure judge frees (concrete, brick): the columns' falling pieces, or as rock */
  structures: 'columns' | 'rock';
  /** metal and wood */
  metal: 'nodes' | 'lattice' | 'engine';
  /** wood bends (with the metal) or falls as rock (the baseline) */
  woodBends: boolean;
}

export const ROUTING: Record<SolverVariant, Routing> = {
  old: { rock: 'cpu', structures: 'columns', metal: 'lattice', woodBends: false },
  nodes: { rock: 'nodes', structures: 'rock', metal: 'nodes', woodBends: true },
  lattice: { rock: 'lattice', structures: 'rock', metal: 'lattice', woodBends: true },
  hybrid: { rock: 'nodes', structures: 'rock', metal: 'lattice', woodBends: true },
  // (terrain pieces are rows: docs/design/PHYSICS_ENGINE.md — nothing on this route goes to the voxel lattice or the
  // CPU rock)
  engine: { rock: 'engine', structures: 'rock', metal: 'engine', woodBends: true },
};

/** the default variant: the phone bench's smoothest (Pixel 9a, lattice x runs p95 20 / p99 35 ms; round 120) */
export const DEFAULT_SOLVER: SolverVariant = 'lattice';

/** the page's variant: `?solver=` (default lattice) */
export function solverVariant(params: URLSearchParams = urlFlags()): SolverVariant {
  const v = params.get('solver') ?? DEFAULT_SOLVER;
  if (!(VARIANTS as readonly string[]).includes(v)) throw new Error(`?solver=${v}: one of ${VARIANTS.join(', ')}`);
  return v as SolverVariant;
}
