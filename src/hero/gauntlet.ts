// ---- hero/gauntlet.ts -----------------------------------------------------------
// (round 112, herosandbox; the user: "play generated gauntlets or maps I edit") Where a hero sandbox gets a course
// to play: a CourseGenerator makes one at a point, as the world API's edits and the units' spawns; the sandbox
// lays it and puts the hero at its start. The generators are behind this one interface so the level generator to
// come (BACKLOG GE3) plugs in as another; `obstacleCourse` is the stub: a straight run of stations along a heading —
// a low wall to climb, a wall with a gap, a pit, a pool, a slalom of pillars, foes to fight — to a crystal goal.
// An edited map is the other way in: the sandbox editor's save / load (ui/editor.ts), its start the map's
// poi.heroStart (set with the sandbox's 📍 tool, saved with the map).

import type { V2 } from '../api/contracts/units';
import { cellAt, cellPos } from '../world/lattice';

/** One edit of the world API (api/terrain.ts build / dig; api/water.ts flood), at a world point. */
export type CoursePiece =
  | { kind: 'build'; at: V2; material: 'concrete' | 'stone' | 'brick' | 'crystal' | 'steel'; radius: number; layers: number }
  | { kind: 'dig'; at: V2; radius: number; layers: number }
  | { kind: 'flood'; at: V2; radius: number; depth: number };

/** A unit to spawn (the sandbox's foe kinds: hero/sandbox.ts UNIT_KINDS). */
export interface CourseFoe {
  kind: string;
  at: V2;
}

export interface Course {
  name: string;
  start: V2;
  goal: V2;
  pieces: CoursePiece[];
  foes: CourseFoe[];
}

export interface CourseGenerator {
  id: string;
  name: string;
  /** a course from `at` along `heading` (radians, 0: +x), the same for the same seed */
  make(at: V2, heading: number, seed: number): Course;
}

/** a small seeded random (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The stub: eight stations, 12 cells apart, in a seeded order, then the goal. */
export const obstacleCourse: CourseGenerator = {
  id: 'obstacles',
  name: 'Obstacle course',
  make(at, heading, seed) {
    const r = rng(seed);
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    // (along the course and across it)
    const P = (along: number, side = 0): V2 => [at[0] + fx * along - fy * side, at[1] + fy * along + fx * side];
    const pieces: CoursePiece[] = [];
    const foes: CourseFoe[] = [];
    const wall = (along: number, from: number, to: number, layers: number, material: 'concrete' | 'stone' | 'brick' = 'concrete') => {
      for (let s = from; s <= to; s += 1.5) pieces.push({ kind: 'build', at: P(along, s), material, radius: 1.4, layers });
    };
    const stations: ((a: number) => void)[] = [
      // a low wall: a stride's climb
      (a) => wall(a, -6, 6, 2),
      // a tall wall with a gap off the middle
      (a) => {
        const gap = (r() - 0.5) * 6;
        wall(a, -7, gap - 1.8, 7, 'brick');
        wall(a, gap + 1.8, 7, 7, 'brick');
      },
      // a pit to go round (or fall in)
      (a) => pieces.push({ kind: 'dig', at: P(a, (r() - 0.5) * 3), radius: 3.5, layers: 4 }),
      // a pool: deeper than a walker wades in the middle
      (a) => {
        pieces.push({ kind: 'dig', at: P(a, 0), radius: 4, layers: 3 });
        pieces.push({ kind: 'flood', at: P(a, 0), radius: 4, depth: 3 });
      },
      // a slalom of pillars
      (a) => {
        for (let k = -1; k <= 1; k++) pieces.push({ kind: 'build', at: P(a + k * 3, k % 2 ? 2.5 : -2.5), material: 'stone', radius: 1.2, layers: 6 });
      },
      // foes at a post
      (a) => {
        for (let k = 0; k < 2 + Math.floor(r() * 2); k++) foes.push({ kind: 'raider', at: P(a, (k - 1) * 2.5) });
      },
      // a ramp up and a drop
      (a) => {
        for (let k = 0; k < 4; k++) pieces.push({ kind: 'build', at: P(a - 3 + k * 1.5, 0), material: 'stone', radius: 3, layers: 1 + k });
      },
      // a brute and a runner
      (a) => {
        foes.push({ kind: 'brute', at: P(a, 0) });
        foes.push({ kind: 'runner', at: P(a + 3, 3) });
      },
    ];
    // (shuffled by the seed: the same seed, the same course)
    for (let i = stations.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [stations[i], stations[j]] = [stations[j], stations[i]];
    }
    stations.forEach((f, i) => f(14 + i * 12));
    const end = 14 + stations.length * 12;
    pieces.push({ kind: 'build', at: P(end, 0), material: 'crystal', radius: 1.2, layers: 8 });
    return { name: `${this.name} #${seed}`, start: P(0), goal: P(end - 2), pieces, foes };
  },
};

export const COURSES: CourseGenerator[] = [obstacleCourse];

/**
 * The build pieces as one build a column (window cell centres, radius under a cell's spacing), each column the most
 * layers of the pieces over it. (The world API's build is a press of its own each call: discs that overlap add up —
 * a wall of overlapping discs comes out two or three times its height. A column at a time, it's the height asked.)
 */
export function perColumn(pieces: CoursePiece[]): { at: V2; material: string; layers: number }[] {
  const cols = new Map<string, { at: V2; material: string; layers: number }>();
  for (const p of pieces) {
    if (p.kind !== 'build') continue;
    const [c0x, c0y] = cellAt(p.at[0] - p.radius, p.at[1] - p.radius);
    const [c1x, c1y] = cellAt(p.at[0] + p.radius, p.at[1] + p.radius);
    for (let cy = c0y - 1; cy <= c1y + 1; cy++)
      for (let cx = c0x - 1; cx <= c1x + 1; cx++) {
        const at = cellPos(cx, cy);
        if (Math.hypot(at[0] - p.at[0], at[1] - p.at[1]) > p.radius) continue;
        const k = `${cx},${cy}`;
        const had = cols.get(k);
        if (!had || had.layers < p.layers) cols.set(k, { at, material: p.material, layers: p.layers });
      }
  }
  return [...cols.values()];
}
