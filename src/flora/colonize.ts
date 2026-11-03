// Crowns grown by space colonization (round 128, treegen; Runions, Lane & Prusinkiewicz 2007, "Modeling Trees with a
// Space Colonization Algorithm"). The user: "They make too steep an angle branch from the main trunk", "they should
// almost always have branches go up to fill the space above the tree with leaves since that is how most real trees
// work", and "we might want willows and whatnot so they don't always need to curve up".
//
// Why this and not more L-system rules: an L-system says what each bud does and the crown's shape is whatever comes
// out (the elder's near-level T of limbs, the birch's few stiff forks). Here the crown's shape is the input — attraction
// points scattered in the species' envelope (a dome, a cone, a column, an umbrella) — and the branching comes out of
// the branches competing for that space: many branches a node where there is room, all of them growing toward the
// space left, so the crown fills. The trunk below the crown is drawn straight (with a leader carrying on up for the
// excurrent species); the bend up (or, negative, down: a willow) and the cap on the branching angle are biases on the
// growth direction. A hybrid on purpose: the bole stays a designed part (its height, its width, the buttresses), the
// crown is grown. Deterministic per seed; CPU, once per variant (a few ms; measured in the tests).
//
// Out: the same Skeleton the L-system's turtle makes (segments with stem ids and leaf sites), so the noise-swept stems,
// twist, knots, kinks, bark, twigs, sprays and epiphytes all work on it unchanged.

import type { LeafSite, Segment, Skeleton, V3 } from './lsystem';
import { norm } from './lsystem';
import { rng } from './rng';

export type Envelope = 'dome' | 'cone' | 'column' | 'umbrella';

/** A crown grown by colonization; lengths in the skeleton's units (the plant is scaled to its height after). */
export interface ColonizeSpec {
  /** the plant's height before scaling (the envelope's top) */
  height: number;
  /** where the crown starts, a share of the height (the bare bole below) */
  crownBase: number;
  /** the crown's half-width over the height */
  width: number;
  envelope: Envelope;
  /** attraction points (the crown's fill: more, a denser crown) */
  points: number;
  /** a node feels the points within this (× step) */
  influence: number;
  /** a point is taken when a node comes within this (× step) */
  kill: number;
  /** a node's length */
  step: number;
  /** the pull up as limbs grow (0 none; negative: down — a willow's arching, weeping limbs) */
  upBend: number;
  /** the outer branches' droop (0..1): past `weepFrom` of a limb's length the pull turns down */
  weep: number;
  /** the widest a new branch leaves its parent (degrees) */
  maxAngle: number;
  /** excurrent: the trunk carries on up through the crown as a leader (a birch, a conifer); else it forks at the crown's
   *  base into several rising limbs (decurrent: an oak, the elder) */
  leader: boolean;
  /** decurrent: how many limbs the trunk forks into at the crown's base */
  forks: number;
  /** the trunk's radius at the foot and the thinnest a tip is */
  trunkRadius: number;
  tipRadius: number;
  /** how fast the branches thin with the share of the tree they carry: r = trunkRadius × share^thin (0.5 thick limbs ..
   *  0.8 slender) */
  thin: number;
  /** stop after this many rounds */
  rounds: number;
  /** how much a growing branch keeps its way, node to node (0 none: it zigzags toward the points .. 1) */
  straight: number;
  /**
   * (round 128, the user: "taller trees with multiple leaf clusters") the crown as separate tiers in place of one
   * envelope: each a flattened ellipsoid at `at` (a share of the height), `width` (its half-width over the height) and
   * `depth` (its thickness over the height) — bare trunk and limbs between them (a cloud pine's pads, a conifer's
   * shelves, a Scots pine's high crown)
   */
  tiers?: { at: number; width: number; depth: number }[];
}

interface Node {
  p: V3;
  parent: number;
  dir: V3;
  kids: number[];
  /** path length from the crown's base along its branch (for the weep) */
  len: number;
}

/** Is q inside the envelope (q in the plant's frame: z up)? */
export function inEnvelope(q: V3, c: ColonizeSpec): boolean {
  if (c.tiers?.length) {
    const r = Math.hypot(q[0], q[1]);
    for (const t of c.tiers) {
      const zc = c.height * t.at;
      const hd = Math.max(0.05, (c.height * t.depth) / 2);
      const W = Math.max(0.1, c.width * c.height * (t.width / Math.max(c.width, 1e-3)));
      if ((r / W) ** 2 + ((q[2] - zc) / hd) ** 2 <= 1) return true;
    }
    return false;
  }
  const z0 = c.height * c.crownBase;
  const hz = c.height - z0;
  if (q[2] < z0 || q[2] > c.height) return false;
  const t = (q[2] - z0) / hz; // 0 at the crown's base .. 1 at its top
  const W = c.width * c.height;
  const r = Math.hypot(q[0], q[1]);
  let R: number;
  switch (c.envelope) {
    case 'cone':
      R = W * (1 - t) * 1.05;
      break;
    case 'column':
      R = W * Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 4)));
      break;
    case 'umbrella':
      // (a broad, flat-topped crown high on the tree: wide over its upper half, narrowing below)
      R = W * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, 0.65 - t) / 0.65, 2))) * (t > 0.85 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.85) / 0.15, 2))) : 1);
      break;
    default:
      // a dome: an ellipsoid's upper part over a short taper
      R = W * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.35) / 0.65, 2)));
  }
  return r <= R;
}

export function colonize(c: ColonizeSpec, seed: number, opts: { kinkChance?: number; kinkAngle?: number; twist?: number } = {}): Skeleton {
  const r = rng(seed ^ 0xc010);
  const D = c.step;
  const di = c.influence * D;
  const dk = c.kill * D;
  // attraction points in the envelope (rejection from its bounding box)
  const W = c.width * c.height;
  const z0 = c.height * c.crownBase;
  const pts: V3[] = [];
  for (let tries = 0; pts.length < c.points && tries < c.points * 60; tries++) {
    const q: V3 = [(r() * 2 - 1) * W, (r() * 2 - 1) * W, z0 + r() * (c.height - z0)];
    if (inEnvelope(q, c)) pts.push(q);
  }
  const nodes: Node[] = [];
  const add = (p: V3, parent: number, dir: V3, len: number) => {
    nodes.push({ p, parent, dir, kids: [], len });
    if (parent >= 0) nodes[parent].kids.push(nodes.length - 1);
    return nodes.length - 1;
  };
  // the trunk: straight up to the crown's base (a little lean by the seed), in steps
  const lean: V3 = [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08, 1];
  let at = add([0, 0, 0], -1, [0, 0, 1], 0);
  const trunkTop = c.leader ? z0 + (c.height - z0) * 0.15 : z0;
  while (nodes[at].p[2] < trunkTop) {
    const d = norm(lean);
    const p = nodes[at].p;
    at = add([p[0] + d[0] * D, p[1] + d[1] * D, p[2] + d[2] * D], at, d, 0);
  }
  // decurrent: the fork at the crown's base — `forks` limbs leaving the trunk's top, rising (each at up to maxAngle)
  const starts: number[] = [at];
  if (!c.leader && c.forks > 1) {
    const a0 = r() * Math.PI * 2;
    const ang = (Math.min(c.maxAngle, 45) * Math.PI) / 180;
    for (let k = 0; k < c.forks; k++) {
      const a = a0 + ((k + (r() - 0.5) * 0.4) / c.forks) * Math.PI * 2;
      const d = norm([Math.cos(a) * Math.sin(ang), Math.sin(a) * Math.sin(ang), Math.cos(ang)]);
      const p = nodes[at].p;
      starts.push(add([p[0] + d[0] * D, p[1] + d[1] * D, p[2] + d[2] * D], at, d, D));
    }
  }
  const maxCos = Math.cos((c.maxAngle * Math.PI) / 180);
  const kinkC = opts.kinkChance ?? 0;
  const kinkA = ((opts.kinkAngle ?? 0) * Math.PI) / 180;
  // colonization rounds
  for (let round = 0; round < c.rounds && pts.length; round++) {
    // each point to its nearest node within the influence
    const pull = new Map<number, V3>();
    for (const q of pts) {
      let best = -1;
      let bd = di * di;
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].p;
        const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d2 < bd) {
          bd = d2;
          best = i;
        }
      }
      if (best < 0) continue;
      // (only from the crown: the bare trunk below the fork doesn't sprout — the decurrent's limbs and the leader do)
      if (nodes[best].p[2] < z0 * 0.98 && nodes[best].kids.length) continue;
      const p = nodes[best].p;
      const v = norm([q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
      const s = pull.get(best) ?? [0, 0, 0];
      pull.set(best, [s[0] + v[0], s[1] + v[1], s[2] + v[2]]);
    }
    if (!pull.size) break;
    let grew = 0;
    for (const [i, s] of pull) {
      const n = nodes[i];
      // the bend: up as the limb grows, turning down past a share of its length when it weeps
      const weepNow = c.weep > 0 && n.len > c.height * 0.25 ? c.weep : 0;
      const bend = c.upBend * (1 - weepNow) - weepNow * 1.2;
      let d = norm([s[0], s[1], s[2] + bend * Math.hypot(s[0], s[1], s[2]) * 0.6]);
      // (a branch keeps some of its way — no zigzag from node to node; a new side branch takes its own)
      if (n.kids.length === 0 && c.straight > 0) d = norm([d[0] + n.dir[0] * c.straight * 1.5, d[1] + n.dir[1] * c.straight * 1.5, d[2] + n.dir[2] * c.straight * 1.5]);
      // the widest a branch leaves its parent: a node growing a second child turns it toward the parent's direction
      if (n.kids.length > 0) {
        const cos = d[0] * n.dir[0] + d[1] * n.dir[1] + d[2] * n.dir[2];
        if (cos < maxCos) {
          const t = (maxCos - cos) / Math.max(1e-3, 1 - cos);
          d = norm([d[0] + (n.dir[0] - d[0]) * t, d[1] + (n.dir[1] - d[1]) * t, d[2] + (n.dir[2] - d[2]) * t]);
        }
      }
      if (kinkC && r() < kinkC) {
        const k = norm([r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]);
        d = norm([d[0] + k[0] * Math.sin(kinkA), d[1] + k[1] * Math.sin(kinkA), d[2] + k[2] * Math.sin(kinkA)]);
      }
      const q: V3 = [n.p[0] + d[0] * D, n.p[1] + d[1] * D, n.p[2] + d[2] * D];
      // (no duplicate: the same node pulled the same way twice in a row)
      if (n.kids.some((k) => Math.hypot(nodes[k].p[0] - q[0], nodes[k].p[1] - q[1], nodes[k].p[2] - q[2]) < D * 0.3)) continue;
      add(q, i, d, n.len + D);
      grew++;
    }
    if (!grew) break;
    // the points reached
    for (let j = pts.length - 1; j >= 0; j--) {
      const q = pts[j];
      for (let i = nodes.length - grew; i < nodes.length; i++) {
        const p = nodes[i].p;
        if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < dk * dk) {
          pts.splice(j, 1);
          break;
        }
      }
    }
  }
  // the radii: by how much of the tree a node carries (its subtree's nodes), r = trunkRadius × (share)^thin — a twig at a
  // thousandth of the tree a few hundredths of a cell, a main limb a good part of the trunk (the pipe model's exponent
  // made a style parameter: the pure pipe model makes a broad trunk's twigs as thick as fingers)
  const size = new Float64Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    let z = 1;
    for (const k of nodes[i].kids) z += size[k];
    size[i] = z;
  }
  const rad = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) rad[i] = Math.max(c.tipRadius, c.trunkRadius * Math.pow(size[i] / size[0], c.thin));
  // stems: each node carries on into its heaviest child; the others start new stems a depth deeper
  const segments: Segment[] = [];
  const leaves: LeafSite[] = [];
  let stems = 0;
  const twist = ((opts.twist ?? 0) * Math.PI) / 180;
  // (a stem's nodes merged where it runs straight — a segment ends where the stem turns more than ~9°, where a branch
  // leaves it, or every 4 steps: the mesh's rings follow the shape, not the growth's step)
  const walk = (start: number, from: number, depth: number, stem: number) => {
    let i = start;
    let prev = from;
    let tw = 0;
    let run = 0;
    while (true) {
      const n = nodes[i];
      const kids = [...n.kids].sort((a, b) => size[b] - size[a]);
      run++;
      const next = kids.length ? nodes[kids[0]] : null;
      const turn = next ? n.dir[0] * next.dir[0] + n.dir[1] * next.dir[1] + n.dir[2] * next.dir[2] : -1;
      const keep = prev < 0 || !next || kids.length > 1 || turn < 0.988 || run >= 4;
      if (keep && prev >= 0) {
        segments.push({ a: nodes[prev].p, b: n.p, r0: rad[prev], r1: rad[i], depth, stem, twist: tw });
        tw += twist * run;
        run = 0;
        prev = i;
      } else if (prev < 0) prev = i;
      if (!kids.length) {
        leaves.push({ p: n.p, d: n.dir, depth: depth + 1 });
        return;
      }
      for (const k of kids.slice(1)) walk(k, i, depth + 1, stems++);
      // (a leaf site along the thin branches too: the sprays sit on the branching, not only at the tips)
      if (rad[i] < c.tipRadius * 3) leaves.push({ p: n.p, d: n.dir, depth: depth + 1 });
      i = kids[0];
    }
  };
  walk(0, -1, 0, stems++);
  let height = 0;
  let spread = 0;
  for (const g of segments) {
    height = Math.max(height, g.b[2]);
    spread = Math.max(spread, Math.hypot(g.b[0], g.b[1]));
  }
  return { segments, leaves, height, spread };
}
