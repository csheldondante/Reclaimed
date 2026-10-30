// (round 117: BikeTuning a type, not an interface, so it is a Params record for the play contract)
// (ported from GameplayGM runtimes/hoverbike/src/bike.ts @ experiment/slice 515fcd9, round 117: the play layer moved into Reclaimed)
// The hover bike: a glide drive (momentum, like iso-adventure's `glide` DriveDef) over
// Reclaimed's terrain. Pure: it knows the ground only through `heightAt`, so it runs in
// tests without a GPU. Units are Reclaimed's: world cells, cells/s, z in cells.

export type BikeTuning = {
  /** thrust at full stick (cells/s²) */
  accel: number;
  /** speed lost per second (1/s) under thrust (low, so slopes and momentum count), and coasting with the stick let go */
  drag: number;
  coastDrag: number;
  /** thrust stops adding speed past this (cells/s); downhill can take it on to `limit` */
  max: number;
  limit: number;
  /** share of gravity's pull along the slope it feels on the cushion: downhill speeds it up, uphill slows it */
  slope: number;
  /** ride height over the ground (cells) */
  hover: number;
  /** the lift cushion: how stiffly it pushes up within reach of the ground (1/s²), and its damping (1/s) */
  spring: number;
  damp: number;
  /** pull down (cells/s²); a crest taken fast enough leaves the cushion behind and it flies */
  gravity: number;
  /** boost: thrust while it's held (cells/s²), the speed it can push to, and the steepest
   *  face it gets up while boosting (rise over run, vs `climb`); a full tank lasts `boostTime`
   *  s and refills at `refill` tanks a second when it's let go */
  boost: number;
  boostMax: number;
  boostClimb: number;
  boostTime: number;
  refill: number;
  /** a bump steeper than `launchSlope` (rise over run) taken on the cushion throws it up:
   *  this share of the speed it rose at, less what the cushion soaks up (`launchSoak`), at
   *  most `launchMax` (cells/s), and never higher than `launchHeight` times the bump's
   *  height; so slow, it rolls over */
  launch: number;
  launchSlope: number;
  launchSoak: number;
  launchMax: number;
  launchHeight: number;
  /** the steepest face (rise over run) it rides up or lands on; steeper, and taller than `wall`, is a barricade */
  climb: number;
  /** a barricade stands more than this over its underside (cells, about the bike's own height);
   *  anything lower it rolls over, paying `bump` for the climb */
  wall: number;
  /** share of speed lost per cell it's bumped up rolling over something (1/cell) */
  bump: number;
  /** how far ahead the nose looks for a barricade (cells), and the footprint's radius under it */
  nose: number;
  foot: number;
  /** into a barricade faster than this (cells/s) it crashes; slower it glances off */
  crash: number;
  /** how long a crash takes the controls away (s) */
  crashTime: number;
  /** share of speed kept glancing off a barricade */
  bounce: number;
  /** the Akira slide: faster than `slideMin` (cells/s), the stick pushed against the way it
   *  goes swings it sideways: it turns to the stick at `slideTurn` (rad/s), braking with
   *  `slideBrake` times its thrust, laid over up to `slideBank` (radians), till it's going
   *  the stick's way or slower than `slideStop` */
  slideMin: number;
  slideTurn: number;
  slideBrake: number;
  slideBank: number;
  slideStop: number;
  /**
   * (round 117, play) held down to the ground on a climb faster than the cushion can lift it, it keeps this share of
   * the ground's rise speed under it (the slope along its way over a cell either side, times its speed; at most
   * `launchMax`), so it carries that up over the crest and a ramp throws it. 0: the slice's old behaviour — the clamp
   * zeroed it, and the bike went over a ramp's lip with no upward speed (a kicker to a landing at the same height
   * dropped it into the gap).
   */
  carry: number;
};

export const BIKE: BikeTuning = {
  accel: 30,
  drag: 0.2,
  coastDrag: 1.1,
  max: 22,
  limit: 34,
  slope: 0.7,
  hover: 0.8,
  spring: 70,
  damp: 9,
  gravity: 24,
  boost: 45,
  boostMax: 32,
  boostClimb: 4,
  boostTime: 1.5,
  refill: 0.3,
  launch: 0.7,
  launchSlope: 0.5,
  launchSoak: 6,
  launchMax: 14,
  launchHeight: 4,
  climb: 1.5,
  wall: 1.2,
  bump: 0.15,
  nose: 0.8,
  foot: 0.3,
  crash: 9,
  crashTime: 1.2,
  bounce: 0.35,
  slideMin: 11,
  slideTurn: 5.5,
  slideBrake: 1.5,
  slideBank: 0.9,
  slideStop: 3,
  carry: 1,
};

export interface Bike {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** facing (radians, world xy) */
  heading: number;
  /** nose up (radians): the ground's slope under it, or, in the air, the slope where it'll land */
  pitch: number;
  /** lean into turns (radians, + to the right) */
  bank: number;
  /** speed of the last barricade hit this step (cells/s), 0 if none */
  hit: number;
  /** seconds off the cushion (0 while riding it) */
  air: number;
  /** speed it came down at, on the step it landed (cells/s), else 0 */
  landed: number;
  /** how far it's climbed the steep bump it's on (cells; 0 off one) */
  ramp: number;
  /** boost left in the tank (0..1), and whether it's boosting this step */
  fuel: number;
  boosting: boolean;
  /** time left in a crash (s; no control while > 0) and how fast it's spinning (rad/s) */
  crashed: number;
  spin: number;
  /** speed it hit a barricade at, on the step it crashed (cells/s), else 0 */
  crash: number;
  /** seconds into an Akira slide (0: not sliding) */
  slide: number;
}

export type HeightAt = (x: number, y: number) => number;
/** Whether a world point is in the ground (ground.ts `solidAt`: overhangs and caves are open). */
export type SolidAt = (x: number, y: number, z: number) => boolean;
/** The ground in 3D: its top, and what's solid under it. */
export interface Solid {
  heightAt: HeightAt;
  solidAt: SolidAt;
}

export function makeBike(x: number, y: number, heightAt: HeightAt, t: BikeTuning = BIKE): Bike {
  return { x, y, z: heightAt(x, y) + t.hover, vx: 0, vy: 0, vz: 0, heading: 0, pitch: 0, bank: 0, hit: 0, air: 0, landed: 0, ramp: 0, fuel: 1, boosting: false, crashed: 0, spin: 0, crash: 0, slide: 0 };
}

export const speedOf = (b: Bike) => Math.hypot(b.vx, b.vy);

/** The highest ground under the bike's footprint (a small ring, so it sees a ledge before its centre is over it). */
export function groundUnder(x: number, y: number, heightAt: HeightAt, r = BIKE.foot): number {
  let g = heightAt(x, y);
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    g = Math.max(g, heightAt(x + Math.cos(a) * r, y + Math.sin(a) * r));
  }
  return g;
}

/** The signed angle from `a` to `b` (radians, -π..π). */
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

function gradient(x: number, y: number, heightAt: HeightAt, e = 0.4): [number, number] {
  return [(heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e), (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e)];
}

/**
 * Where it'll come down, flying: a ballistic path (gravity only) stepped until it meets
 * the cushion's height, up to `horizon` s. Null if it doesn't come down by then.
 */
export function landingPoint(b: Bike, heightAt: HeightAt, t: BikeTuning = BIKE, horizon = 1.5): [number, number] | null {
  const h = 0.05;
  let [x, y, z, vz] = [b.x, b.y, b.z, b.vz];
  for (let s = 0; s < horizon; s += h) {
    x += b.vx * h;
    y += b.vy * h;
    vz -= t.gravity * h;
    z += vz * h;
    if (z <= heightAt(x, y) + t.hover) return [x, y];
  }
  return null;
}

/**
 * One step. `stick` is the wanted direction in world xy (length 0..1); `bounds` the
 * world's extent; `boost` held.
 */
export function stepBike(b: Bike, stick: [number, number], dt: number, heightAt: HeightAt, bounds: [number, number], t: BikeTuning = BIKE, boost = false): void {
  b.hit = 0;
  b.landed = 0;
  b.crash = 0;
  // crashed: the controls are gone until it rights itself
  if (b.crashed > 0) {
    b.crashed = Math.max(0, b.crashed - dt);
    stick = [0, 0];
    boost = false;
  }
  b.boosting = boost && b.fuel > 0;
  if (b.boosting) b.fuel = Math.max(0, b.fuel - dt / t.boostTime);
  else if (!boost) b.fuel = Math.min(1, b.fuel + t.refill * dt);
  const climb = b.boosting ? t.boostClimb : t.climb;
  const pvx = b.vx;
  const pvy = b.vy;
  // the Akira slide: fast, the stick hauled round against the way it's going (on the cushion, or just off it)
  {
    const v = speedOf(b);
    const m = Math.hypot(stick[0], stick[1]);
    const against = v > 0 && m > 0 ? (b.vx * stick[0] + b.vy * stick[1]) / (v * m) : 1;
    if (b.slide > 0) b.slide = m < 0.3 || v < t.slideStop || against > 0 ? 0 : b.slide + dt;
    else if (b.air < 0.3 && v > t.slideMin && m > 0.5 && against < -0.5) b.slide = dt;
  }
  // thrust, but it adds nothing past `max` the way it pushes; boosting, harder and up to
  // `boostMax`, at full power along the stick (or, let go, the way it faces)
  let push = stick;
  if (b.boosting && Math.hypot(stick[0], stick[1]) < 0.2) push = [Math.cos(b.heading), Math.sin(b.heading)];
  const sm = Math.hypot(push[0], push[1]);
  if (sm > 0) {
    const [accel, top, power] = b.boosting ? [t.boost, t.boostMax, 1] : [t.accel * (b.slide > 0 ? t.slideBrake : 1), t.max, sm];
    const [ux, uy] = [push[0] / sm, push[1] / sm];
    const along = b.vx * ux + b.vy * uy;
    const room = Math.max(0, Math.min(1, (top - along) / (accel * dt)));
    b.vx += ux * accel * dt * room * power;
    b.vy += uy * accel * dt * room * power;
  }
  const reach = t.hover * 1.6;
  // on the cushion, gravity pulls it along the slope: it keeps some of what it gains downhill
  const g0 = groundUnder(b.x, b.y, heightAt);
  const onCushion = b.z - g0 < reach;
  if (onCushion) {
    // (over a cell either way: the lie of the land, not the rock under it)
    let [gx, gy] = gradient(b.x, b.y, heightAt, 1);
    // (only a slope it can ride counts: a wall's edge isn't a hill to slide off)
    const gl = Math.hypot(gx, gy);
    if (gl > climb) {
      gx *= climb / gl;
      gy *= climb / gl;
    }
    b.vx -= t.gravity * t.slope * gx * dt;
    b.vy -= t.gravity * t.slope * gy * dt;
  }
  const keep = Math.exp(-(sm > 0 ? t.drag : t.coastDrag) * dt);
  b.vx *= keep;
  b.vy *= keep;
  const sp = speedOf(b);
  if (sp > t.limit) {
    b.vx *= t.limit / sp;
    b.vy *= t.limit / sp;
  }
  let nx = Math.max(0.5, Math.min(bounds[0] - 0.5, b.x + b.vx * dt));
  let ny = Math.max(0.5, Math.min(bounds[1] - 0.5, b.y + b.vy * dt));
  // a barricade: at its nose, a face steeper than it can ride, standing higher than the bike
  // over its underside (so flying high, it passes over; rocks, kerbs and ledges lower than
  // that it rolls over; a bank it can ride, it lands on). Fast into it, it crashes; slow, it
  // glances off along it
  const spd = speedOf(b);
  if (spd > 0.5) {
    const [mx, my] = [b.vx / spd, b.vy / spd];
    const here = groundUnder(b.x, b.y, heightAt, t.foot);
    const near = heightAt(nx + mx * t.nose * 0.5, ny + my * t.nose * 0.5);
    const far = heightAt(nx + mx * t.nose, ny + my * t.nose);
    const ahead = Math.max(near, far);
    // (rise over the run from where it is now: the samples are ahead of where it's going)
    const run = Math.hypot(nx - b.x, ny - b.y);
    const steep = Math.max((near - here) / (run + t.nose * 0.5), (far - here) / (run + t.nose));
    if (ahead > b.z + t.wall && steep > climb) {
      const ax0 = nx + mx * t.nose;
      const ay0 = ny + my * t.nose;
      const [gx, gy] = gradient(ax0, ay0, heightAt);
      const gl = Math.hypot(gx, gy);
      const [ux, uy] = gl > 1e-6 ? [gx / gl, gy / gl] : [mx, my];
      const into = Math.max(0, b.vx * ux + b.vy * uy);
      b.hit = into;
      if (into > t.crash) {
        b.crash = into;
        b.crashed = t.crashTime;
        b.vx = -ux * into * 0.2;
        b.vy = -uy * into * 0.2;
        b.vz = Math.max(b.vz, into * 0.3);
        b.spin = (b.vx * uy - b.vy * ux >= 0 ? 1 : -1) * Math.min(14, into * 0.8);
      } else {
        b.vx -= (1 + t.bounce) * into * ux;
        b.vy -= (1 + t.bounce) * into * uy;
      }
      nx = b.x;
      ny = b.y;
    }
  }
  // rolling over something: the bump up costs speed, and a sharp one throws it up
  const before = groundUnder(b.x, b.y, heightAt);
  const moved = Math.hypot(nx - b.x, ny - b.y);
  b.x = nx;
  b.y = ny;
  // gravity, and a lift cushion that only pushes up, within reach of the ground: riding
  // up a slope fast gives it upward speed, so over the crest it flies
  const ground = groundUnder(b.x, b.y, heightAt);
  const gap = b.z - ground;
  const rise = ground - before;
  if (rise > 0 && gap < reach && b.air === 0) {
    const k = Math.exp(-t.bump * rise);
    b.vx *= k;
    b.vy *= k;
    if (moved > 0 && rise / moved > t.launchSlope) {
      b.ramp += rise;
      const cap = Math.min(t.launchMax, Math.sqrt(2 * t.gravity * b.ramp * t.launchHeight));
      b.vz = Math.max(b.vz, Math.min(cap, (rise / dt) * t.launch - t.launchSoak));
    } else b.ramp = 0;
  } else b.ramp = 0;
  const rest = t.hover + t.gravity / t.spring; // the cushion sags to `hover` under gravity
  let az = -t.gravity;
  if (gap < reach) az += Math.max(0, (rest - gap) * t.spring) - (b.vz < 0 ? b.vz * t.damp : 0);
  b.vz += az * dt;
  b.z += b.vz * dt;
  if (b.z < ground + 0.3) {
    if (b.air > 0) {
      // coming down from the air onto a face, it meets it belly down: what drives into the
      // face is lost, the rest carries on along it (up an opposite bank, not into it)
      const [gx, gy] = gradient(b.x, b.y, heightAt);
      const nl = Math.hypot(gx, gy, 1);
      const [n0, n1, n2] = [-gx / nl, -gy / nl, 1 / nl];
      const vn = b.vx * n0 + b.vy * n1 + b.vz * n2;
      b.landed = Math.max(0, -vn);
      if (vn < 0) {
        b.vx -= vn * n0;
        b.vy -= vn * n1;
        b.vz -= vn * n2;
      }
    } else {
      b.landed = Math.max(0, -b.vz);
      // (the ground's rise speed under it, smoothed over a cell either side so a pebble isn't a ramp)
      const sp = speedOf(b);
      let up = 0;
      if (sp > 0.5 && t.carry > 0) {
        const [ux, uy] = [b.vx / sp, b.vy / sp];
        const along = (heightAt(b.x + ux, b.y + uy) - heightAt(b.x - ux, b.y - uy)) / 2;
        up = Math.min(t.launchMax, Math.max(0, along * sp * t.carry));
      }
      b.vz = up;
    }
    b.z = ground + 0.3;
  }
  const flying = b.z - ground > reach;
  if (!flying && b.air > 0) b.landed = Math.max(b.landed, -b.vz, 0.01);
  b.air = flying ? b.air + dt : 0;
  // its pitch: the ground's slope along its heading, or, flying, the slope where it'll come
  // down, so it lands belly down
  const at = flying ? landingPoint(b, heightAt, t) : ([b.x, b.y] as [number, number]);
  if (at) {
    const [fx, fy] = [Math.cos(b.heading), Math.sin(b.heading)];
    const e = 0.6;
    const along = (heightAt(at[0] + fx * e, at[1] + fy * e) - heightAt(at[0] - fx * e, at[1] - fy * e)) / (2 * e);
    const want = Math.max(-0.6, Math.min(0.6, Math.atan(along)));
    b.pitch += (want - b.pitch) * Math.min(1, dt * (flying ? 4 : 10));
  }
  // crashed, it spins out (the spin dies away); else it faces the way it moves and leans
  // into the turn (lateral acceleration)
  if (b.crashed > 0) {
    b.heading += b.spin * dt;
    b.spin *= Math.exp(-2.5 * dt);
    b.bank = Math.sin(b.crashed * 9) * 0.5 * (b.crashed / t.crashTime);
    return;
  }
  const s2 = speedOf(b);
  if (b.slide > 0) {
    // sliding: it swings round to the stick, laid over away from the way it skids
    b.heading += Math.max(-t.slideTurn * dt, Math.min(t.slideTurn * dt, angleTo(b.heading, Math.atan2(stick[1], stick[0]))));
    const skid = -b.vx * Math.sin(b.heading) + b.vy * Math.cos(b.heading);
    const lay = Math.max(-t.slideBank, Math.min(t.slideBank, skid * 0.1));
    b.bank += (lay - b.bank) * Math.min(1, dt * 10);
    return;
  }
  if (s2 > 0.8) {
    const want = Math.atan2(b.vy, b.vx);
    let d = want - b.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    b.heading += d * Math.min(1, dt * 8);
  }
  const ax = (b.vx - pvx) / Math.max(dt, 1e-4);
  const ay = (b.vy - pvy) / Math.max(dt, 1e-4);
  const lateral = -ax * Math.sin(b.heading) + ay * Math.cos(b.heading);
  const want = Math.max(-0.6, Math.min(0.6, lateral * 0.02));
  b.bank += (want - b.bank) * Math.min(1, dt * 6);
}
