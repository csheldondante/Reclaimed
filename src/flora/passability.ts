// Plants as soft barriers (round 117). The user: "plants making a barrier (even a soft barrier like slowing you down
// or requiring you to cut through) is a good thing" and "we should know by character controller what they can and
// can't pass easily".
//
// The model, kept small so generation can reason with it (the run planner asks "can the bike get through this
// wood?"):
//   - every plant in a region adds its footprint × fill (a thicket shrub fills ~0.7 of a circle its own radius; a
//     tree only its trunk — you walk under the canopy; tall grass its clump) scaled by how much of the controller's
//     height it reaches (waist-high grass barely slows a tall walker; a bike's rider is low);
//   - coverage = 1 − exp(−Σ / area): independent plants overlapping, as a Poisson scatter does — never over 1;
//   - speed falls with coverage by the plants' own slowness (their weighted `slow`);
//   - past MUST_CUT coverage a controller must cut (cuttable plants and a blade), break through (mass ≥ the plants'
//     breakMass) or it is blocked; a flyer ignores all of it.
// Pure: the plants come in as a list (what placement says stands there), so it is tested on its own.

import type { FloraCaps, FloraPassage } from '../api/contracts/flora';
import type { Barrier } from './species';

export interface StandPlant {
  barrier: Barrier;
  /** its footprint radius at walking height (cells) */
  radius: number;
  /** its height (cells) */
  height: number;
  /** a tree: only its trunk blocks */
  trunkOnly: boolean;
}

/** coverage past which a controller has to cut, break through or go round */
export const MUST_CUT = 0.55;

/** How much of a cell's area the plants fill for a controller of height `h` (cells), over `area` cells. */
export function coverage(plants: StandPlant[], area: number, h = 2): number {
  if (area <= 0) return 0;
  let sum = 0;
  for (const p of plants) {
    const reach = Math.min(1, p.height / Math.max(0.3, h * 0.6));
    const foot = p.trunkOnly ? 1 : Math.PI * p.radius * p.radius;
    sum += p.barrier.fill * foot * reach;
  }
  return 1 - Math.exp(-sum / area);
}

export function passage(plants: StandPlant[], area: number, caps: FloraCaps): FloraPassage {
  if (caps.flies) return { density: 0, speed: 1, mustCut: false, blocked: false, cost: 1 };
  const c = coverage(plants, area, caps.height);
  // the stand's slowness and toughness, weighted by what each plant adds
  let w = 0;
  let slow = 0;
  let cuttable = 0;
  let breakMass = 0;
  for (const p of plants) {
    const k = p.barrier.fill * (p.trunkOnly ? 1 : Math.PI * p.radius * p.radius);
    w += k;
    slow += k * p.barrier.slow;
    cuttable += k * (p.barrier.cuttable ? 1 : 0);
    breakMass = Math.max(breakMass, p.barrier.breakMass * (k > 0 ? 1 : 0));
  }
  const slowAvg = w > 0 ? slow / w : 1;
  const cutShare = w > 0 ? cuttable / w : 1;
  // a heavy controller loses less in brush (it shoves through) — half the loss per mass class over the stand's
  const shove = caps.mass >= breakMass && w > 0 ? 0.5 : 1;
  let speed = Math.max(0.15, 1 - c * (1 - slowAvg) * shove * 1.6);
  const dense = c >= MUST_CUT;
  const breaks = caps.mass >= breakMass;
  const mustCut = dense && !breaks;
  const canCut = caps.cuts && cutShare > 0.75;
  const blocked = mustCut && !canCut;
  if (mustCut && canCut) speed = Math.min(speed, 0.35);
  const cost = blocked ? Infinity : 1 / speed + (mustCut ? 1.5 * c : 0);
  return { density: c, speed, mustCut, blocked, cost };
}
