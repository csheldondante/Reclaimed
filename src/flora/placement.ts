// Where plants grow (round 117): "Plants growing on fields". Two layers, each for its user:
//   fit(site)       which species suit a site's fields (succession, moisture, light, altitude, slope, host): the niche
//                   table in species.ts, scored by how centred the site is in each range. For generators and the
//                   viewer's biome pick, and the reference the GPU kernels follow.
//   standsAt(...)   the plants the game actually draws on a column (vegplan.wgsl's trees through api/plants.ts
//                   planTree, and vegprep.wgsl's floraSmall rules for thickets and tall grass), on the CPU, for
//                   passability and queries — the same hashes, so what you can't walk through is what you see.
import type { FloraSite } from '../api/contracts/flora';
import { planTree } from '../api/plants';
import { SPECIES, SPECIES_IDS, type SpeciesId } from './species';

/** 1 at a range's middle, falling to 0 at its ends (and 0 outside) */
function inRange(v: number, [lo, hi]: [number, number]): number {
  if (v < lo || v > hi) return 0;
  if (hi - lo < 1e-6) return 1;
  const t = (v - lo) / (hi - lo);
  return 0.35 + 0.65 * (1 - Math.abs(t - 0.5) * 2);
}

export function fit(site: FloraSite): { id: SpeciesId; weight: number }[] {
  const out: { id: SpeciesId; weight: number }[] = [];
  for (const id of SPECIES_IDS) {
    const n = SPECIES[id].niche;
    if (!n.hosts.includes(site.host) || site.slope > n.slopeMax) continue;
    const w = inRange(site.veg, n.veg) * inRange(site.moisture, n.moisture) * inRange(site.light, n.light) * inRange(site.altitude, n.altitude) * n.weight;
    if (w > 0) out.push({ id, weight: w });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

// common.wgsl pcg / hash3 / rand3 with the window's origin (as api/plants.ts)
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
function rand3(x: number, y: number, z: number, org: [number, number]): number {
  return (pcg(((x + org[0]) ^ pcg(((y + org[1]) ^ pcg(z)) >>> 0)) >>> 0) >>> 8) / 16777216;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Stand {
  species: SpeciesId;
  cx: number;
  cy: number;
  /** height scale of the species' mature height (0..1.2) */
  scale: number;
}

const TREE_SPECIES: Record<string, SpeciesId> = { broadleaf: 'oak', conifer: 'pine', birch: 'birch', giant: 'giant' };

/**
 * The plants vegprep.wgsl draws on window column (cx, cy) with succession v (trees: vegPlan; small plants:
 * floraSmall). Grass needs soil-like ground on the GPU (MATS eco); here it is assumed (the CPU has no material per
 * column without a layers read) — passability over bare rock slightly overcounts grass.
 */
export function standsAt(cx: number, cy: number, v: number, w: number, h: number, org: [number, number]): Stand[] {
  const out: Stand[] = [];
  const t = planTree(cx, cy, v, w, h, org);
  if (t) out.push({ species: TREE_SPECIES[t.species], cx, cy, scale: 0.8 + 0.2 * Math.min(1, Math.max(0, (v - 3.6) / 1.2)) });
  const hh = rand3(cx, cy, 4242, org);
  // (vegprep floraSmall: shrubland's thicket; under the woods only a fifth of them — the floor stays open)
  const shrub = !t && v >= 2.6 && hh < 0.25 && (v < 3.6 || rand3(cx, cy, 545, org) < 0.2);
  if (shrub) out.push({ species: 'shrub', cx, cy, scale: 1 });
  if (v >= 3.6) {
    if (!t && rand3(cx, cy, 543, org) < 0.16) out.push({ species: 'fern', cx, cy, scale: 1 });
    return out;
  }
  // tall grass where tufts grow (vegPlan: v ≥ 1.2, chance by smoothstep(1.2, 2.5, v) × 0.9) and floraSmall's share
  if (v >= 1.4) {
    const tr = rand3(cx, cy, 99, org);
    const tufts = tr < smooth(1.2, 2.5, v) * 0.9;
    const lush = smooth(1.4, 2.6, v) * (1 - smooth(3.3, 3.8, v));
    if (tufts && rand3(cx, cy, 544, org) < 0.25 + 0.7 * lush) out.push({ species: 'tallgrass', cx, cy, scale: 0.7 + 0.45 * lush });
  }
  return out;
}
