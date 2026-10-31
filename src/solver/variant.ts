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
//
// The judge (what lets go) is the same for all: `?judge=` picks it (game/judges.ts; the column judge today, room for
// the method of sections on branch `judge`).

export type SolverVariant = 'old' | 'nodes' | 'lattice' | 'hybrid';
export const VARIANTS: readonly SolverVariant[] = ['old', 'nodes', 'lattice', 'hybrid'];

/** what carries each kind of thing the judge frees */
export interface Routing {
  /** rock: the CPU rigid rock, the node solver, or the voxel lattice */
  rock: 'cpu' | 'nodes' | 'lattice';
  /** what the structure judge frees (concrete, brick): the columns' falling pieces, or as rock */
  structures: 'columns' | 'rock';
  /** metal and wood */
  metal: 'nodes' | 'lattice';
  /** wood bends (with the metal) or falls as rock (the baseline) */
  woodBends: boolean;
}

export const ROUTING: Record<SolverVariant, Routing> = {
  old: { rock: 'cpu', structures: 'columns', metal: 'lattice', woodBends: false },
  nodes: { rock: 'nodes', structures: 'rock', metal: 'nodes', woodBends: true },
  lattice: { rock: 'lattice', structures: 'rock', metal: 'lattice', woodBends: true },
  hybrid: { rock: 'nodes', structures: 'rock', metal: 'lattice', woodBends: true },
};

/** the page's variant: `?solver=` (default nodes) */
export function solverVariant(params: URLSearchParams = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)): SolverVariant {
  const v = params.get('solver') ?? 'nodes';
  if (!(VARIANTS as readonly string[]).includes(v)) throw new Error(`?solver=${v}: one of ${VARIANTS.join(', ')}`);
  return v as SolverVariant;
}
