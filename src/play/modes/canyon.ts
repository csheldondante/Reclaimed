// ---- play/modes/canyon.ts ---------------------------------------------------------------------------------------
// (round 128b, `playmodes`; the user: "I was imagining zoomed in so far the canyon walls were only in the background
// and the camera followed as the bike auto steers around") The canyon run's steering: the route carries the bike round
// every bend, the player only says where across the canyon to be — the floor, or up on a wall.
//
//   the line    a point on the route `ahead` cells on (more with speed), moved across by the offset wanted; the stick
//               points at it (pure pursuit), so the bike is aimed into a bend before it reaches it
//   the offset  the player's sideways push, held: full left / right is up on that wall (`floorHalf` + `wallBand`); let
//               go, back toward the floor's middle. With no push, the line drifts up the outside of a bend at speed —
//               the bobsled's line: the wall's v² / r load is what grips it round (core/bike.ts wall riding)
//   the speed   the route's cruise, cut before a bend to √(grip · r) of the tightest turn in the next second; the
//               stick's forward / back part a little faster or slower
//
// Pure: Node tests ride the course's canyon with the bike (canyon.test.ts).

import type { V2 } from '../../api/contracts/camera';

/** The route as the canyon run reads it (play/course/course.ts Route). */
export interface RouteLike {
  readonly length: number;
  nearest(p: V2, hint?: number, span?: number): { index: number; s: number; tan: V2; nrm: V2; off: number };
  pointAt(s: number): { at: V2; tan: V2 };
}

export interface CanyonTuning {
  /** cells/s: the run's cruise on a straight */
  cruise: number;
  /** cells/s: the drive's top (the stick's full length) */
  vMax: number;
  /** cells/s²: the sideways grip the speed into a bend is planned for */
  grip: number;
  /** cells: the pursuit point's distance ahead at standstill, and seconds of travel added */
  ahead: number;
  aheadT: number;
  /** cells: the floor's half width (where the line is the floor's) and how far up the wall a full push takes it */
  floorHalf: number;
  wallBand: number;
  /** the bobsled line: cells out toward the outside wall per unit of v² / (r · grip) past 0.3 */
  bob: number;
  /** on that line, the bend's speed planned for this much more grip (the wall's v² / r load presses it on) */
  bobGrip: number;
  /** cells/s the wanted offset moves at (a push is felt at once, but not a jump) */
  offRate: number;
  /** how hard the line pulls across: its offset's error this many times over at the pursuit point */
  lateral: number;
  /** the bike's wall riding in the run (core/bike.ts wallMin): from this speed it holds a flank — the run's bends
   *  keep it near 12, the lab's default, where it dropped off the wall and met the flank as a barricade */
  wallMin: number;
}

export const CANYON: CanyonTuning = {
  cruise: 21,
  vMax: 22,
  grip: 34,
  ahead: 3,
  aheadT: 0.3,
  floorHalf: 3.6,
  wallBand: 3.6,
  bob: 20,
  bobGrip: 1.3,
  offRate: 6,
  wallMin: 7,
  lateral: 2,
};

export interface CanyonState {
  /** the offset wanted now (cells, + left of the way) */
  off: number;
  /** the route's index last frame (the nearest search's hint) */
  hint: number;
}

export const canyonState = (): CanyonState => ({ off: 0, hint: -1 });

const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** the signed turn (radians, + left) of the route between s and s + d */
export function turnBetween(r: RouteLike, s: number, d: number): number {
  const a = r.pointAt(s).tan;
  const b = r.pointAt(s + d).tan;
  return Math.atan2(a[0] * b[1] - a[1] * b[0], dot(a, b));
}

/** the tightest radius (cells) of the route from s over `span` cells, and the way that turn goes (+1 left) */
export function tightest(r: RouteLike, s: number, span: number, step = 2): { radius: number; side: number } {
  let radius = Infinity;
  let side = 0;
  for (let a = 0; a <= span; a += step) {
    const t = turnBetween(r, s + a, 4);
    const rad = Math.abs(t) > 1e-4 ? 4 / Math.abs(t) : Infinity;
    if (rad < radius) (radius = rad), (side = Math.sign(t));
  }
  return { radius, side };
}

/**
 * The stick for the canyon run (world xy, length ≤ 1, the drive's wanted velocity as a share of its top). `p` the
 * bike, `vel` its velocity, `stick` the player's (world xy; its sideways part across the route is the offset push,
 * its forward part a little more or less speed). `hands`: the player's stick counts (false: the brief auto).
 */
export function canyonStick(r: RouteLike, p: V2, vel: V2, stick: V2, st: CanyonState, dt: number, t: CanyonTuning = CANYON, hands = true, avoid: readonly V2[] = []): V2 {
  const here = r.nearest(p, st.hint, st.hint < 0 ? 0 : 8);
  st.hint = here.index;
  const v = Math.hypot(vel[0], vel[1]);
  const s = hands ? stick : ([0, 0] as V2);
  // the speed: the cruise, cut for the tightest bend in the next second (and the one being ridden)
  const bend = tightest(r, here.s - 2, Math.max(8, v * 1.1));
  // (with the game's own line — up the outside wall — the wall's load grips harder: a bend taken faster)
  const bobbing = !hands || Math.abs(dot(stick, here.nrm)) < 0.15;
  let speed = Math.min(t.cruise, Math.sqrt(t.grip * (bobbing ? t.bobGrip : 1) * bend.radius));
  speed *= clamp(1 + dot(s, here.tan) * 0.3, 0.6, 1.25);
  // the offset wanted: the player's push (up that wall at full), else the bobsled's line up the outside of the bend
  let side = dot(s, here.nrm);
  if (Math.abs(side) < 0.15) side = 0;
  const top = t.floorHalf + t.wallBand;
  const near = tightest(r, here.s - 1, Math.max(8, v * 0.7));
  let want: number;
  // (what's on the floor ahead is gone round, by the side the line is nearer, when the player isn't pushing across —
  // and when the bike is nearly stopped, after a crash, so a push held into a boulder doesn't pin it there)
  const slow = v < 5;
  const dodge = side === 0 || slow ? dodgeOffset(r, here.s, Math.max(v, 6), st.off, avoid, 2.8, slow ? -1.5 : 0.5) : null;
  if (dodge !== null && (side === 0 || slow)) want = dodge;
  else if (side !== 0) want = side * top;
  else {
    const load = (v * v) / (Math.max(near.radius, 1) * t.grip);
    want = -near.side * clamp(t.bob * (load - 0.3), 0, t.floorHalf + t.wallBand * 0.8);
  }
  // (never far onto a tight bend's inside: a hairpin's inside is the rock it turns round — a line there turns tighter
  // than the bike can, into the pillar)
  const inside = Math.max(0, near.radius - t.floorHalf);
  const clampIn = (o: number) => (near.side !== 0 && Math.sign(o) === near.side ? Math.sign(o) * Math.min(Math.abs(o), inside) : o);
  want = clampIn(want);
  const step = t.offRate * dt;
  st.off = clampIn(st.off + clamp(want - st.off, -step, step));
  // the line: a point ahead on the route, across by the offset; the stick at it
  // (the offset's error counted `lateral` times over: the pursuit alone, aimed at a point 7 cells on, asked for a few
  // degrees toward a wall — less than the flank's pull back down — and the bike never left the floor)
  const P = r.pointAt(here.s + t.ahead + v * t.aheadT);
  const n: V2 = [-P.tan[1], P.tan[0]];
  const across = here.off + (st.off - here.off) * t.lateral;
  const aim: V2 = [P.at[0] + n[0] * across - p[0], P.at[1] + n[1] * across - p[1]];
  const al = Math.hypot(aim[0], aim[1]) || 1;
  // (up on a wall the slope pulls it back down and slows it: full throttle there, so it holds the speed that holds it up)
  const onWall = clamp((Math.abs(st.off) - t.floorHalf) / 1.5, 0, 1);
  const m = clamp((speed + (t.vMax - speed) * onWall) / t.vMax, 0, 1);
  return [(aim[0] / al) * m, (aim[1] / al) * m];
}

/** an obstacle ahead within the next ~second on the line held: the offset that passes it by `clear` cells, else null */
export function dodgeOffset(r: RouteLike, s: number, v: number, off: number, avoid: readonly V2[], clear = 2.8, from = 0.5): number | null {
  let best: number | null = null;
  let bestAlong = Infinity;
  const reach = 4 + v * 1.1;
  for (const o of avoid) {
    const h = r.nearest(o);
    const along = h.s - s;
    if (along < from || along > reach || along >= bestAlong) continue;
    if (Math.abs(h.off - off) > clear) continue;
    bestAlong = along;
    // (by the side the line is already on; dead ahead, by the side with the more room — away from the obstacle)
    const by = off === h.off ? -Math.sign(h.off) || 1 : Math.sign(off - h.off);
    best = h.off + by * clear;
  }
  return best;
}
