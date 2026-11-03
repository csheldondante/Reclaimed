// (round 128b, playmodes) The canyon run as the user meant it: the bike ridden through the course's canyon by the run's
// steering (canyon.ts) on the physical drive with wall riding — round every switchback and out of the exit without a
// crash; pushed sideways it rides up the wall and banks, let go it comes back to the floor.
import { describe, expect, it } from 'vitest';
import type { V2 } from '../../api/contracts/camera';
import { BIKE, makeBike, speedOf, stepBike, type Bike } from '../core/bike';
import { BIKE_DRIVE } from '../core/drive';
import { BIKE_DEFAULTS } from '../controllers/hoverbike';
import { BOULDERS, courseColumn, ROUTE } from '../course/course';
import { CANYON, canyonStick, canyonState } from './canyon';
import { cellAt, cellPos } from '../../world/lattice';

/** the ground as the game reads it: a column's top over its whole cell (world/lattice), not the smooth shape */
const top = (x: number, y: number) => {
  const [cx, cy] = cellAt(x, y);
  const [wx, wy] = cellPos(cx, cy);
  return courseColumn(wx, wy).top;
};
const BOUNDS: [number, number] = [256, 222];
const DT = 1 / 60;

interface Pass {
  crashes: number;
  secs: number;
  done: boolean;
  maxUp: number;
  maxBank: number;
  wallSecs: number;
  worst: string;
}

/** one pass: from the canyon's start to 20 cells into the cliff's stretch; `side(t, s)` the player's sideways push
 *  (none: the game rides — the ▶ autopilot's way, going round the boulders) */
function pass(side: (t: number, s: number) => number = () => 0, limit = 60): Pass {
  const [s0, s1] = ROUTE.span('canyon');
  const start = ROUTE.pointAt(s0 + 2);
  const tun = { ...BIKE_DEFAULTS, wallRide: 1, wallMin: CANYON.wallMin };
  const b: Bike = makeBike(start.at[0], start.at[1], top, tun);
  b.vx = start.tan[0] * 12;
  b.vy = start.tan[1] * 12;
  b.heading = Math.atan2(start.tan[1], start.tan[0]);
  const st = canyonState();
  let hint = -1;
  const out: Pass = { crashes: 0, secs: 0, done: false, maxUp: 0, maxBank: 0, wallSecs: 0, worst: '' };
  for (let k = 0; k < limit / DT; k++) {
    const p: V2 = [b.x, b.y];
    const here = ROUTE.nearest(p, hint, hint < 0 ? 0 : 8);
    hint = here.index;
    if (here.s > s1 + 20) {
      out.done = true;
      break;
    }
    const t = k * DT;
    const sd = side(t, here.s);
    const player: V2 = [here.nrm[0] * sd, here.nrm[1] * sd];
    const stick = canyonStick(ROUTE, p, [b.vx, b.vy], player, st, DT, CANYON, sd !== 0, BOULDERS);
    stepBike(b, stick, DT, top, BOUNDS, tun, false, BIKE_DRIVE);
    if (b.crash > 0) {
      out.crashes++;
      if (!out.worst) out.worst = `crash at s=${(here.s - s0).toFixed(0)}/${(s1 - s0).toFixed(0)} (${b.x.toFixed(0)},${b.y.toFixed(0)}) v=${b.crash.toFixed(1)}`;
    }
    const up = b.z - BIKE.hover - floorAt(here.s);
    out.maxUp = Math.max(out.maxUp, up);
    if (up > 1.5) out.wallSecs += DT;
    out.maxBank = Math.max(out.maxBank, Math.abs(b.bank));
    out.secs = t;
  }
  return out;
}

/** the canyon floor's height at s along the route (the route's own column) */
function floorAt(s: number): number {
  const p = ROUTE.pointAt(s).at;
  if (BOULDERS.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.6)) return top(p[0] + 2, p[1] + 2);
  return top(p[0], p[1]);
}

describe('the canyon run', () => {
  it('let alone, the run carries the bike round every switchback and out of the exit, no crash', () => {
    const r = pass();
    // eslint-disable-next-line no-console
    console.log('run', JSON.stringify(r));
    expect(r.worst).toBe('');
    expect(r.done).toBe(true);
    // (and at speed: over 12 cells/s on average, hairpins and all)
    const [s0, s1] = ROUTE.span('canyon');
    expect((s1 - s0 + 18) / r.secs).toBeGreaterThan(12);
    // (out onto the foot of the outside wall in the bends by itself, banked)
    expect(r.maxUp).toBeGreaterThan(1);
    expect(r.maxBank).toBeGreaterThan(0.5);
  });

  it('pushed sideways it rides up the wall and banks; let go, it comes back to the floor', () => {
    // (the first long run west: push right for 1.5 s, then let go)
    const start = ROUTE.pointAt(ROUTE.nearest([228, 45]).s);
    const tun = { ...BIKE_DEFAULTS, wallRide: 1, wallMin: CANYON.wallMin };
    const b = makeBike(start.at[0], start.at[1], top, tun);
    b.vx = start.tan[0] * 18;
    b.vy = start.tan[1] * 18;
    const st = canyonState();
    let upHeld = 0;
    let bank = 0;
    let upAfter = 99;
    const PUSH = 1.5;
    for (let k = 0; k < 4.5 / DT; k++) {
      const here = ROUTE.nearest([b.x, b.y], st.hint, 8);
      const sd = k * DT < PUSH ? -1 : 0;
      stepBike(b, canyonStick(ROUTE, [b.x, b.y], [b.vx, b.vy], [here.nrm[0] * sd, here.nrm[1] * sd], st, DT, CANYON, sd !== 0, BOULDERS), DT, top, BOUNDS, tun, false, BIKE_DRIVE);
      const up = b.z - BIKE.hover - floorAt(here.s);
      if (k * DT > 0.6 && k * DT < PUSH + 0.2) (upHeld = Math.max(upHeld, up)), (bank = Math.max(bank, Math.abs(b.bank)));
      if (k * DT > 4) upAfter = Math.min(upAfter, up);
      expect(b.crash, `crash at ${k * DT}s`).toBe(0);
    }
    // eslint-disable-next-line no-console
    console.log('push', JSON.stringify({ upHeld, bank, upAfter, v: speedOf(b) }));
    expect(upHeld).toBeGreaterThan(1.8);
    expect(bank).toBeGreaterThan(0.5);
    expect(upAfter).toBeLessThan(1);
  });

  it('the run is tuned for the drive it rides on', () => {
    expect(CANYON.vMax).toBe(BIKE_DRIVE.vMax);
  });
});
