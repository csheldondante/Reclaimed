// How a moving rock is drawn (round 120): one pose source from its break to its rest (Integrity.rockDraws).
import type { SolverBody } from '../api/contracts/solver';
import type { RockDraw } from '../render/rockmesh';

/**
 * (round 120, the user: "the mesh changes appearance … during falling") A moving rock's draw this frame: on the node
 * solver its mesh skinned to its nodes — its own slot, or none while a ghost's split draws its part of the parent's
 * mesh — always from the solver's pose, from its break to its rest; else by its CPU matrix (the baseline's rock).
 */
export function rockDrawFor(own: number, sb: Pick<SolverBody, 'slot' | 'restCom' | 'nodes'> | null, matrix: () => number[]): RockDraw {
  if (sb) return { slot: own, m: [], skin: { slot: sb.slot, com: sb.restCom, nodes: sb.nodes } };
  return { slot: own, m: matrix() };
}
