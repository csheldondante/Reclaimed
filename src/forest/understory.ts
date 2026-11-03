// The understory model (round 125, `forest`; BACKLOG FLO32; the contract api/contracts/understory.ts). Is the hero
// under the canopy, how deep, and how high is the canopy over it — from the trees standing round it as the flora plan
// lays them out (api/plants.ts treesNear: the same hashes the GPU draws by), so nothing is read back from the GPU.
//
// Why a weight eased over time and not a switch: the user asked for "a seamless transition". The cover is measured
// over a small disc round the hero (not its one point: walking past a trunk's foot shouldn't flicker the look), the
// weight eases toward it in about a second, and every treatment scales with it.
import type { UnderstoryLook, UnderstoryTreatments } from '../api/contracts/understory';
import { ALL_TREATMENTS, type OccluderSignal } from '../api/contracts/understory';
import { TREE_SCALE } from '../flora/spacing';

/** a tree as the plan has it (api/plants.ts Tree's fields this needs) */
export interface PlanTree {
  x: number;
  y: number;
  species: 'broadleaf' | 'conifer' | 'birch' | 'giant' | 'willow';
  trunk: number;
  crown: number;
}

/**
 * How far a tree's crown reaches out from its trunk (cells): the flora library's crowns (round 125's sizes; measured
 * from the meshes' leaves — birch r 7-10, broadleaf 4-7, conifer ~5, the elder 10-15), taken a little in from the
 * tips: where the canopy is closed enough to stand "under" it.
 */
export function crownReach(t: PlanTree): number {
  // (round 128: × TREE_SCALE, the trees' size)
  switch (t.species) {
    case 'giant':
      return 9 * TREE_SCALE;
    case 'birch':
      return 5 * TREE_SCALE;
    case 'conifer':
      return 3.5 * TREE_SCALE;
    case 'willow':
      return 6;
    default:
      return 4 * TREE_SCALE;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The canopy over (x, y): its cover 0..1 (crowns overlapping add up, 1 − Π(1 − c)) and its underside's height over the ground (cells). */
export function canopyAt(trees: readonly PlanTree[], x: number, y: number): { cover: number; under: number } {
  let open = 1;
  let under = Infinity;
  for (const t of trees) {
    const R = crownReach(t);
    const d = Math.hypot(t.x - x, t.y - y);
    const c = 0.85 * (1 - smooth(R * 0.55, R, d));
    if (c <= 0) continue;
    open *= 1 - c;
    under = Math.min(under, t.trunk);
  }
  return { cover: 1 - open, under: Number.isFinite(under) ? under : 0 };
}

/** The cover over a disc round (x, y): its middle and six points `r` out, averaged. */
export function canopyOver(trees: readonly PlanTree[], x: number, y: number, r = 3): { cover: number; under: number } {
  let cover = 0;
  let under = Infinity;
  const pts: [number, number][] = [[x, y]];
  for (let k = 0; k < 6; k++) pts.push([x + Math.cos((k * Math.PI) / 3) * r, y + Math.sin((k * Math.PI) / 3) * r]);
  for (const [px, py] of pts) {
    const c = canopyAt(trees, px, py);
    cover += c.cover / pts.length;
    if (c.cover > 0.2) under = Math.min(under, c.under);
  }
  return { cover, under: Number.isFinite(under) ? under : 0 };
}

/**
 * (round 128) How much sticks up round (x, y) within `r` cells (contracts/understory.ts OccluderSignal): each tree
 * whose crown reaches the disc counts its top (trunk + crown) by the share of the crown over it. Shrubs and grass are
 * not trees in the plan: they never count.
 */
export function occluders(trees: readonly PlanTree[], x: number, y: number, r = 12): OccluderSignal {
  let w = 0;
  let hw = 0;
  let top = 0;
  let n = 0;
  for (const t of trees) {
    const R = crownReach(t);
    const d = Math.hypot(t.x - x, t.y - y);
    if (d > r + R) continue;
    // (the crown's share over the disc: whole when it is inside, falling off as it reaches only the rim)
    const k = 1 - smooth(Math.max(0, r - R), r + R, d);
    if (k <= 0) continue;
    n++;
    const h = t.trunk + t.crown;
    top = Math.max(top, h);
    w += k * R * R;
    hw += k * R * R * h;
  }
  const cover = canopyOver(trees, x, y, Math.min(r, 6)).cover;
  return { height: w > 0 ? (hw / w) * Math.min(1, cover / 0.5) : 0, top, cover, trees: n, radius: r };
}

export interface UnderstoryOpts {
  /** cover where the look starts and where it is whole */
  coverLo: number;
  coverHi: number;
  /** seconds to ease in (out is the same) */
  ease: number;
  /** the hole round the hero (world units on screen) */
  radius: number;
  treatments: UnderstoryTreatments;
}

export const UNDERSTORY_DEFAULTS: UnderstoryOpts = { coverLo: 0.25, coverHi: 0.65, ease: 1.1, radius: 7, treatments: { ...ALL_TREATMENTS } };

/** The look, eased: step it each frame with the hero and the trees near it. */
export class Understory {
  weight = 0;
  cover = 0;
  private canopy = 12;
  /** the falling leaves' colour (the driver sets it from the crowns near the hero and the season) */
  leaf: [number, number, number] = [0.86, 0.3, 0.1];
  constructor(public o: UnderstoryOpts = { ...UNDERSTORY_DEFAULTS, treatments: { ...UNDERSTORY_DEFAULTS.treatments } }) {}

  /** Eases toward the canopy over `at`; `force` (0..1) holds the weight there instead (the lab's in / out). */
  step(dt: number, at: [number, number, number], trees: readonly PlanTree[], force: number | null = null): UnderstoryLook {
    const c = canopyOver(trees, at[0], at[1]);
    this.cover = c.cover;
    const target = force ?? smooth(this.o.coverLo, this.o.coverHi, c.cover);
    const k = 1 - Math.exp(-dt / Math.max(this.o.ease / 3, 1e-3));
    this.weight += (target - this.weight) * k;
    if (Math.abs(target - this.weight) < 1e-3) this.weight = target;
    // (the canopy's height eases too, so walking from under a birch into an elder's shade doesn't jump)
    if (c.under > 0) this.canopy += (c.under - this.canopy) * k;
    return { weight: this.weight, at: [at[0], at[1], at[2]], canopyZ: at[2] + this.canopy, radius: this.o.radius, leaf: this.leaf, treatments: { ...this.o.treatments } };
  }
}
