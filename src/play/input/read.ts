// ---- play/input/read.ts -----------------------------------------------------------------------------------------
// Layer A's last step (ported from GameplayGM runtimes/hoverbike/src/input.ts, round 117): the thumbs (controls.ts)
// from the screen onto the ground through the camera, as the hero's PlayInput — the stick's way, a drag held, the
// gestures let go as acts in the world. What they mean is each hero's.

import type { Gesture, Pt } from '../core/gestures';
import type { Controls } from './controls';
import type { Act, Drag, PlayInput } from './types';

/** A full drag of the right thumb (px); a flick this fast (px/s) is a full one. */
const DRAG_PX = 130;
const FLICK_FULL = 2500;
/** A press on the hero: within this many cells of it as drawn (its column from the ground under it to its top), and no fewer px. */
const SELF = { cells: 0.8, minPx: 22 };

/** What reading needs of the camera and the hero. */
export interface ReadView {
  project(x: number, y: number, z: number): Pt;
  /** a screen direction (px) as a world one */
  screenDeltaToWorld(dx: number, dy: number): Pt;
  /** the ground seen under a screen point */
  groundAt(screen: Pt): Pt;
  /** the hero's feet, its height, the ground under it */
  hero(): { at: [number, number, number]; height: number; ground: number };
  /** screen px per cell */
  zoom(): number;
}

/** The frame's PlayInput (reads the gestures: call once a frame). */
export function readInput(controls: Controls, v: ReadView): PlayInput {
  const groundDir = (dx: number, dy: number): Pt => {
    const [wx, wy] = v.screenDeltaToWorld(dx, dy);
    const l = Math.hypot(wx, wy) || 1;
    return [wx / l, wy / l];
  };
  const s = controls.stickDir();
  const m = Math.hypot(s[0], s[1]);
  const dir: Pt = m > 0 ? scale(groundDir(s[0], s[1]), m) : [0, 0];
  const h = v.hero();
  const top = v.project(h.at[0], h.at[1], h.at[2] + h.height);
  const foot = v.project(h.at[0], h.at[1], h.ground);
  const onSelf = (p: Pt) => gapToSegment(p, top, foot) < Math.max(SELF.minPx, SELF.cells * v.zoom());
  const held = controls.drag();
  let drag: Drag | null = null;
  if (held) {
    const dx = held.at[0] - held.from[0];
    const dy = held.at[1] - held.from[1];
    const px = Math.hypot(dx, dy);
    drag = { from: v.groundAt(held.from), at: v.groundAt(held.at), dir: px > 4 ? groundDir(dx, dy) : [0, 0], extent: Math.min(1, px / DRAG_PX), up: -dy, self: onSelf(held.from), screen: held.from, screenAt: held.at };
  }
  const acts = controls.gestures().map((g) => toAct(g, v, groundDir, onSelf)).filter((a): a is Act => a !== null);
  return { dir, buttons: controls.buttons(), drag, acts };
}

const scale = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k];

/** How far p is from the segment a–b (px). */
export function gapToSegment(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * k, p[1] - a[1] - dy * k);
}

function toAct(g: Gesture, v: ReadView, groundDir: (dx: number, dy: number) => Pt, onSelf: (p: Pt) => boolean): Act | null {
  switch (g.kind) {
    case 'tap':
      return { kind: 'tap', at: v.groundAt(g.at), screen: g.at, self: onSelf(g.at) };
    case 'flick':
      return { kind: 'flick', from: v.groundAt(g.from), dir: groundDir(g.dir[0], g.dir[1]), power: Math.min(1, g.speed / FLICK_FULL), screen: g.from, self: onSelf(g.from) };
    case 'circle':
      return { kind: 'circle', centre: v.groundAt(g.centre), ccw: g.ccw, turns: g.turns };
    default:
      return null;
  }
}
