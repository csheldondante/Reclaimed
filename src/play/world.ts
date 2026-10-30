// ---- play/world.ts --------------------------------------------------------------------------------------------
// What the play layer's heroes see of the world (round 117): a narrow, structural view built at the boundary
// (makePlayWorld) from the engine's contracts — the world API (terrain, water, wind, fx), the Units contract and the
// camera. Why narrow: the heroes' logic runs in Node tests on tiny synthetic worlds (play/*.test.ts) with stubs of
// exactly this, and the engine can change behind it freely. Nothing here reaches into another system's buffers.

import type { AreaHit, UnitId, Units, UnitView, V3 } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { Camera } from '../render/camera';
import type { FxName, FxOpts } from '../api/fx';
import type { BlowSpec, WakeSpec } from '../api/wind';
import type { Pt } from './core/gestures';

/** The units, with the blows and holds the heroes deal (the Units contract's optional strike/hold/release, required here). */
export interface PlayUnits {
  /** living units within `radius` of (x, y) */
  near(x: number, y: number, radius: number): UnitView[];
  get(id: UnitId): UnitView | null;
  strike(h: AreaHit): void;
  hold(id: UnitId, at: V3): boolean;
  release(id: UnitId, vel?: V3): void;
  readonly maxHeld: number;
}

/** A wind held round a point (the lich's downdraft, its storm): moved each frame, stopped when done. */
export interface Blow {
  set(spec: Partial<BlowSpec>): void;
  stop(): void;
  readonly alive: boolean;
}

/** (round 118) Another rider or vehicle in play, as a hook sees it (the sandbox's rivals): its body and its way. */
export interface Vehicle {
  id: string;
  at: V3;
  vel: V3;
  heading: number;
}

export interface PlayWorld {
  /** the top a hover rides: the ground, loose ground on it, or the water's surface (cells) */
  top(x: number, y: number): number;
  /** the ground under any water (what feet stand on) */
  floor(x: number, y: number): number;
  /** water standing at (x, y) (cells) */
  depth(x: number, y: number): number;
  /** the window's extent (x cells, y world units) */
  bounds: [number, number];
  units: PlayUnits;
  burst(name: FxName, x: number, y: number, z: number, opts?: FxOpts): void;
  /** a passing mover's wake in the wind (dust kicked up behind it) */
  wake(id: string, spec: WakeSpec): void;
  gust(x: number, y: number, radius: number, strength: number, dir: Pt): void;
  blow(spec: BlowSpec): Blow;
  /** air slammed out from (x, y) for a moment (a downwash, a landing, a slam) */
  blast(x: number, y: number, radius: number, strength: number): void;
  /** a bowl blown out of the ground (the lich's slam) */
  crater(x: number, y: number, radius: number): void;
  /** a world point on the screen (CSS px), and the ground point seen under a screen point */
  project(x: number, y: number, z: number): Pt;
  groundAt(screen: Pt): Pt;
  /** (round 118) the other riders and vehicles in play (a hook reels up alongside them); absent: none */
  vehicles?(): Vehicle[];
}

/** The units' blows, required: the play layer's heroes shove and hold (AgentUnits implements them). */
function playUnits(u: Units): PlayUnits {
  const { strike, hold, release } = u;
  if (!strike || !hold || !release) throw new Error('play: the units implementation has no strike/hold/release (the Units contract, round 117) — AgentUnits has them');
  return {
    near: (x, y, r) => u.query([x, y], r),
    get: (id) => u.get(id),
    strike: (h) => strike.call(u, h, 'hero'),
    hold: (id, at) => hold.call(u, id, at),
    release: (id, vel) => release.call(u, id, vel),
    maxHeld: u.maxHeld ?? 8,
  };
}

/**
 * The play world over the engine's contracts. Heights the mirror hasn't read yet (null) are the last good answer
 * near there — a hover never drops through unread ground — and the first read is waited for before a hero is put
 * down (PlaySandbox.start).
 */
export function makePlayWorld(api: Sim, units: Units, camera: Camera, bounds: [number, number]): PlayWorld {
  const t = api.terrain;
  const water = api.water;
  const wind = api.wind;
  const fx = api.fx;
  if (!t || !water || !wind || !fx) throw new Error('play: needs the world API terrain, water, wind and fx modules');
  let last = 0;
  const floor = (x: number, y: number) => {
    const h = t.heightAt(x, y);
    if (h !== null) last = h;
    return h ?? last;
  };
  let lastTop = 0;
  const top = (x: number, y: number) => {
    const g = t.heightAt(x, y);
    const w = water.levelAt(x, y, { smooth: true });
    const d = water.depthAt(x, y) ?? 0;
    if (g === null) return lastTop;
    lastTop = d > 0.05 && w !== null ? Math.max(g, w) : g;
    return lastTop;
  };
  return {
    top,
    floor,
    depth: (x, y) => water.depthAt(x, y) ?? 0,
    bounds,
    units: playUnits(units),
    burst: (name, x, y, z, opts) => fx.burst(name, x, y, z, opts),
    wake: (id, spec) => wind.wake(id, spec),
    gust: (x, y, r, s, dir) => void wind.gust(x, y, r, s, dir),
    blow: (spec) => {
      const h = wind.blow(spec);
      return {
        set: (s) => void h.set(s),
        stop: () => h.stop(),
        get alive() {
          return h.alive;
        },
      };
    },
    blast: (x, y, r, s) => void wind.blast(x, y, r, s),
    crater: (x, y, radius) => t.crater(x, y, { radius }),
    project: (x, y, z) => camera.project(x, y, z),
    groundAt: (s) => camera.groundAt(s[0], s[1], floor).slice(0, 2) as Pt,
  };
}
