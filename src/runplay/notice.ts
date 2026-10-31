// ---- runplay/notice.ts ------------------------------------------------------------------------------------------
// (round 120, PL20) How much notice a rider gets of each gate: the user, "The bike was not really playable because of
// how zoomed in we are and how little notice for the gates." Two ways a gate is noticed — on the screen, or signposted
// by an arrow at the screen's edge (stage.ts) — and a gate's warning is the time from the first of them to reaching it.
// The arrows point at the next gate AND the one after (SIGNPOSTED): with gates ~70 cells apart and the bike at 46
// cells/s, the next gate alone gives ~1.3 s; the one after doubles it. Pure: stage.ts asks `signposted`, the Node test
// and scripts/runplay.mjs measure with `NoticeLog`, and `rideCourse` rides a course at a speed through the real camera
// maths (chase.ts and render/camera.ts) for the DEVLOG's before/after.

import type { ChaseFraming } from '../api/contracts/hero';
import { Chase, type ChaseView } from '../play/core/chase';
import type { Camera } from '../render/camera';
import type { P2 } from './course';

/** how many gates ahead are signposted: the next and the one after */
export const SIGNPOSTED = 2;

/** is gate i signposted when `passed` gates are behind the hero (`n`: how many are signposted; the old HUD's was 1) */
export function signposted(i: number, passed: number, n = SIGNPOSTED): boolean {
  return i >= passed && i < passed + n;
}

/** a point (CSS px) on the screen, `pad` in from its edges */
export function onScreen(sx: number, sy: number, w: number, h: number, pad: number): boolean {
  return sx > pad && sy > pad && sx < w - pad && sy < h - pad;
}

export interface GateNotice {
  /** when it first came on screen, first signposted, was passed (s; null: not yet) */
  seen: number | null;
  sign: number | null;
  passed: number | null;
  /** cells from the hero when first seen / first signposted */
  seenD: number;
  signD: number;
}

/** The notice each gate got over a ride: `observe` every frame, `warnings` at the end. */
export class NoticeLog {
  readonly gates: GateNotice[];
  constructor(n: number) {
    this.gates = Array.from({ length: n }, () => ({ seen: null, sign: null, passed: null, seenD: 0, signD: 0 }));
  }
  /** gate i this frame: its distance from the hero (cells), on screen or not, signposted or not */
  observe(t: number, i: number, dist: number, on: boolean, sign: boolean): void {
    const g = this.gates[i];
    if (!g || g.passed !== null) return;
    if (on && g.seen === null) (g.seen = t), (g.seenD = dist);
    if (sign && g.sign === null) (g.sign = t), (g.signD = dist);
  }
  pass(t: number, i: number): void {
    const g = this.gates[i];
    if (g && g.passed === null) g.passed = t;
  }
  /**
   * per gate passed: seconds of warning on screen and in all (screen or arrow), and the same in cells over `top` (the
   * seconds it'd be at top speed from where it was first noticed)
   */
  warnings(top: number): { gate: number; seenS: number; noticeS: number; seenTopS: number; noticeTopS: number }[] {
    const out: { gate: number; seenS: number; noticeS: number; seenTopS: number; noticeTopS: number }[] = [];
    this.gates.forEach((g, i) => {
      if (g.passed === null) return;
      const seenS = g.seen === null ? 0 : g.passed - g.seen;
      const first = Math.min(g.seen ?? Infinity, g.sign ?? Infinity);
      const firstD = g.seen !== null && g.seen === first ? g.seenD : g.signD;
      out.push({ gate: i, seenS, noticeS: first === Infinity ? 0 : g.passed - first, seenTopS: g.seen === null ? 0 : g.seenD / top, noticeTopS: first === Infinity ? 0 : firstD / top });
    });
    return out;
  }
}

/**
 * Rides a course on flat ground at a steady `speed` in straight lines through the gates (passed within `passR`),
 * framed by `framing` round `base` zoom on `cam` (its viewport set): the notice each gate got. `arrows`: how many gates
 * ahead are signposted. `lag`: the old chase (the camera's target chasing hero + lead at `framing.follow`, round 118)
 * instead of the round 120 offset. `wait`: seconds stood on the line first (the race's 3-2-1, the arrows already up).
 */
export function rideCourse(
  o: { gates: P2[]; from: P2; speed: number; passR: number; framing: ChaseFraming; base: number; cam: Camera; arrows: number; pad: number; margin: number; lag?: boolean; fast?: number; wait?: number },
): NoticeLog {
  const { cam } = o;
  const log = new NoticeLog(o.gates.length);
  const chase = new Chase(o.framing, o.base);
  let at: P2 = [o.from[0], o.from[1]];
  cam.target = [at[0], at[1], 0];
  cam.zoom = o.base;
  cam.update();
  const dt = 1 / 60;
  let passed = 0;
  for (let t = -(o.wait ?? 0); t < 600 && passed < o.gates.length; t += dt) {
    const g = o.gates[passed];
    const dx = g[0] - at[0];
    const dy = g[1] - at[1];
    const d = Math.hypot(dx, dy) || 1;
    const sp = t < 0 ? 0 : o.speed;
    const vx = (dx / d) * sp;
    const vy = (dy / d) * sp;
    at = [at[0] + vx * dt, at[1] + vy * dt];
    // the camera, as the session frames it
    const z = cam.zoom;
    const c = cam.target;
    const p0 = cam.project(c[0], c[1], 0);
    const view: ChaseView = {
      w: cam.viewportW,
      h: cam.viewportH,
      squash: 1 / (z * Math.hypot(...cam.screenDeltaToWorld(0, -1))),
      margin: o.margin,
      screenOf: (sx, sy) => {
        const q = cam.project(c[0] + sx, c[1] + sy, 0);
        return [(q[0] - p0[0]) / z, (q[1] - p0[1]) / z];
      },
    };
    chase.step(dt, vx, vy, o.fast ?? 0, view);
    if (o.lag) {
      const k = 1 - Math.exp(-o.framing.follow * dt);
      cam.target[0] += (at[0] + chase.lead[0] - cam.target[0]) * k;
      cam.target[1] += (at[1] + chase.lead[1] - cam.target[1]) * k;
    } else {
      cam.target[0] = at[0] + chase.lead[0];
      cam.target[1] = at[1] + chase.lead[1];
    }
    cam.zoom = chase.zoom;
    cam.update();
    for (let i = passed; i < o.gates.length; i++) {
      const [sx, sy] = cam.project(o.gates[i][0], o.gates[i][1], 0);
      log.observe(t, i, Math.hypot(o.gates[i][0] - at[0], o.gates[i][1] - at[1]), onScreen(sx, sy, cam.viewportW, cam.viewportH, o.pad), signposted(i, passed, o.arrows));
    }
    if (Math.hypot(g[0] - at[0], g[1] - at[1]) < o.passR) log.pass(t, passed++);
  }
  return log;
}
