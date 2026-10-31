// L-systems for trunks and branches (round 117; the user: "For plants, L systems are great for branches and then
// cellular autonoma for roots").
//
// Why an L-system: a handful of rewrite rules gives a whole family of plausible trees, and the apical-growth effect
// (older branches have been rewritten more often, so lower branches are longer) comes for free — the shape reads as a
// tree without hand modelling. Stochastic rules + a seed give variants that stay recognisably one species.
//
// Two steps, kept apart so each is tested on its own:
//   expand(spec, seed)        string rewriting (stochastic, deterministic from the seed)
//   interpret(str, turtle, seed)  a 3D turtle walks the string into segments (wood) and leaf sites
//
// Turtle alphabet (Prusinkiewicz & Lindenmayer, "The Algorithmic Beauty of Plants", with a few additions):
//   F  draw forward one step (length and radius by the branch's depth)   f  move forward without drawing
//   +  yaw left   -  yaw right   &  pitch down   ^  pitch up   /  roll right   \  roll left   |  turn round
//   [  push (a child branch: depth + 1)   ]  pop
//   L  a leaf site (cluster, needle tuft, blade, flower — the species decides what grows there)
//   !  thin the current branch (radius × thin)
//   Any other symbol is a growing tip with no drawing (A, B, C …).
// Coordinates: z up, units = world cells (1 cell is the terrain's column width).

import { rng } from './rng';

export type V3 = [number, number, number];

export interface LSystemSpec {
  axiom: string;
  /** symbol → weighted successors (one is chosen per symbol per step, by the seed) */
  rules: Record<string, { s: string; w: number }[]>;
  /** what a symbol still unrewritten at the end becomes (e.g. a bud → a leaf) */
  finals?: Record<string, string>;
  iterations: number;
}

export interface TurtleSpec {
  /** trunk step (cells) */
  step: number;
  /** each depth's step = step × stepDecay^depth */
  stepDecay: number;
  /** trunk base radius (cells) */
  radius: number;
  /** each depth's radius × radiusDecay^depth */
  radiusDecay: number;
  /** each F along a branch thins it by this */
  taper: number;
  /** branching angle (degrees) for + - & ^ */
  angle: number;
  /** roll angle (degrees) for / \ — 137.5 gives phyllotaxis */
  roll: number;
  /** ± jitter on every turn (degrees) */
  jitter: number;
  /** a constant pull on the heading after each F (gravity down for weeping, light up) */
  tropism: V3;
  /** how strongly, per depth: [trunk, first branches, deeper] */
  tropismStrength: [number, number, number];
  /** a branch thinner than this ends (no more drawing: keeps triangle counts sane) */
  minRadius: number;
  /** keep the first frame unturned (a vine stays in its wall's plane: + and - turn within y, z) */
  planar?: boolean;
}

export interface Segment {
  a: V3;
  b: V3;
  r0: number;
  r1: number;
  depth: number;
}

export interface LeafSite {
  p: V3;
  /** the heading there (unit) */
  d: V3;
  depth: number;
}

export interface Skeleton {
  segments: Segment[];
  leaves: LeafSite[];
  /** bounds: height (max z) and spread (max horizontal distance from the trunk) */
  height: number;
  spread: number;
}

/** Rewrite the axiom `iterations` times (stochastic rules chosen by the seed). */
export function expand(spec: LSystemSpec, seed: number, maxLen = 200_000): string {
  const r = rng(seed);
  let s = spec.axiom;
  for (let it = 0; it < spec.iterations; it++) {
    let out = '';
    for (const ch of s) {
      const succ = spec.rules[ch];
      if (!succ) {
        out += ch;
        continue;
      }
      let total = 0;
      for (const o of succ) total += o.w;
      let pick = r() * total;
      let chosen = succ[succ.length - 1].s;
      for (const o of succ) {
        pick -= o.w;
        if (pick <= 0) {
          chosen = o.s;
          break;
        }
      }
      out += chosen;
      if (out.length > maxLen) throw new Error(`L-system grew past ${maxLen} symbols (rules too prolific)`);
    }
    s = out;
  }
  if (spec.finals) {
    let out = '';
    for (const ch of s) out += spec.finals[ch] ?? ch;
    s = out;
  }
  return s;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** rotate v about the unit axis k by angle t (Rodrigues) */
function rot(v: V3, k: V3, t: number): V3 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

interface Turtle {
  p: V3;
  h: V3; // heading
  l: V3; // left
  u: V3; // up
  depth: number;
  r: number;
  alive: boolean;
}

/** Walk the string with a 3D turtle: wood segments and leaf sites. Deterministic from the seed (the jitter). */
export function interpret(str: string, t: TurtleSpec, seed: number): Skeleton {
  const r = rng(seed ^ 0x9e3779b9);
  const D = Math.PI / 180;
  const jit = () => (r() * 2 - 1) * t.jitter * D;
  let s: Turtle = { p: [0, 0, 0], h: [0, 0, 1], l: [0, 1, 0], u: [-1, 0, 0], depth: 0, r: t.radius, alive: true };
  // the first branch's start is turned by the seed, so variants don't all face one way
  const yaw0 = t.planar ? 0 : r() * Math.PI * 2;
  s.l = rot(s.l, s.h, yaw0);
  s.u = rot(s.u, s.h, yaw0);
  const stack: Turtle[] = [];
  const segments: Segment[] = [];
  const leaves: LeafSite[] = [];
  const trop = norm(t.tropism);
  const turn = (axis: V3, a: number) => {
    s.h = norm(rot(s.h, axis, a));
    s.l = norm(rot(s.l, axis, a));
    s.u = norm(cross(s.h, s.l));
  };
  for (const ch of str) {
    switch (ch) {
      case 'F':
      case 'f': {
        if (!s.alive) break;
        const len = t.step * Math.pow(t.stepDecay, s.depth);
        const b = add(s.p, mul(s.h, len));
        const r1 = s.r * t.taper;
        if (ch === 'F') segments.push({ a: s.p, b, r0: s.r, r1, depth: s.depth });
        s.p = b;
        s.r = r1;
        if (s.r < t.minRadius) s.alive = false;
        // tropism: bend the heading toward the pull, more where the heading is across it
        const k = t.tropismStrength[Math.min(2, s.depth)];
        if (k !== 0) {
          const ax = cross(s.h, trop);
          const m = Math.hypot(ax[0], ax[1], ax[2]);
          if (m > 1e-6) turn(mul(ax, 1 / m), k * m);
        }
        break;
      }
      case '+':
        turn(s.u, t.angle * D + jit());
        break;
      case '-':
        turn(s.u, -t.angle * D + jit());
        break;
      case '&':
        turn(s.l, t.angle * D + jit());
        break;
      case '^':
        turn(s.l, -t.angle * D + jit());
        break;
      case '/':
        turn(s.h, t.roll * D + jit());
        break;
      case '\\':
        turn(s.h, -t.roll * D + jit());
        break;
      case '|':
        turn(s.u, Math.PI);
        break;
      case '!':
        s.r *= 0.7;
        break;
      case '[':
        stack.push({ ...s });
        s = { ...s, depth: s.depth + 1, r: s.r * t.radiusDecay };
        if (s.r < t.minRadius) s.alive = false;
        break;
      case ']': {
        const top = stack.pop();
        if (!top) throw new Error('L-system: unbalanced ]');
        s = top;
        break;
      }
      case 'L':
        leaves.push({ p: s.p, d: s.h, depth: s.depth });
        break;
      default:
        break;
    }
  }
  if (stack.length) throw new Error('L-system: unbalanced [');
  let height = 0;
  let spread = 0;
  for (const g of segments) {
    height = Math.max(height, g.a[2], g.b[2]);
    spread = Math.max(spread, Math.hypot(g.b[0], g.b[1]));
  }
  for (const l of leaves) {
    height = Math.max(height, l.p[2]);
    spread = Math.max(spread, Math.hypot(l.p[0], l.p[1]));
  }
  return { segments, leaves, height, spread };
}
