// ---- play/world.ts --------------------------------------------------------------------------------------------
// What the play layer's heroes see of the world (round 117): a narrow, structural view built at the boundary
// (makePlayWorld) from the engine's contracts — the world API (terrain, water, wind, fx), the Units contract and the
// camera. Why narrow: the heroes' logic runs in Node tests on tiny synthetic worlds (play/*.test.ts) with stubs of
// exactly this, and the engine can change behind it freely. Nothing here reaches into another system's buffers.

import { seen, type AreaHit, type SeenUnit, type UnitId, type Units, type V2, type V3 } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { Camera } from '../render/camera';
import type { FxName, FxOpts } from '../api/fx';
import type { BlowSpec, WakeSpec } from '../api/wind';
import type { Pt } from './core/gestures';

/** The units, with the blows and holds the heroes deal (the Units contract's optional strike/hold/release, required here). */
export interface PlayUnits {
  /** living units within `radius` of (x, y), nearest first, each where it stands now */
  near(x: number, y: number, radius: number): SeenUnit[];
  /** a unit where it stands now, or null: gone, or its place not known (not round the hero: UnitsAround) */
  get(id: UnitId): SeenUnit | null;
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
  /** (merge123, BACKLOG LW1-1) the fallen within `radius` of (x, y) rise undead and follow the hero (the trait
   *  system's raise effect, put together at the boundary: makePlayWorld's `raise`); absent: no raising here */
  raise?(x: number, y: number, radius: number): void;
}

/** (round 128p, U1) cells round the hero whose units the play layer sees: the farthest reach its heroes ask within
 *  (the bike's hook, 40 at most, + 2) and a margin */
export const AROUND = 48;

/**
 * (round 128p, U1, DA-B22 (c)(4)) The units round the hero, for the heroes' aim and reach, each frame: asked of the GPU
 * (Units.query within AROUND of the hero, one ask out at a time, asked again as each answer comes) and observed while
 * in that answer (Units.observe: their places read each sync) — not every unit's place read every frame. A unit that
 * walks in is seen from the answer after (a frame or two); its place from the sync after that.
 */
export class UnitsAround {
  /** where the hero is (null: none in play — nothing asked) */
  centre: () => V2 | null = () => null;
  private ids = new Map<UnitId, () => void>();
  private asking = false;
  private gone = false;

  constructor(readonly units: Units) {}

  /** each frame: asked again when the last answer is in */
  tick(): void {
    if (this.asking || this.gone) return;
    const c = this.centre();
    if (!c) return;
    this.asking = true;
    void this.units.query(c, AROUND).then((found) => {
      this.asking = false;
      if (this.gone) return;
      const now = new Set(found.map((v) => v.id));
      for (const [id, release] of this.ids)
        if (!now.has(id)) {
          release();
          this.ids.delete(id);
        }
      for (const id of now) if (!this.ids.has(id)) this.ids.set(id, this.units.observe(id));
    });
  }

  near(x: number, y: number, r: number): SeenUnit[] {
    if (r > AROUND) throw new Error(`play: units asked for within ${r} cells; the play layer sees ${AROUND} round the hero (AROUND)`);
    const out: [number, SeenUnit][] = [];
    for (const id of this.ids.keys()) {
      const v = seen(this.units.get(id));
      if (!v?.alive) continue;
      const d = Math.hypot(v.at[0] - x, v.at[1] - y);
      if (d <= r) out.push([d, v]);
    }
    return out.sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  }

  get(id: UnitId): SeenUnit | null {
    return seen(this.units.get(id));
  }

  dispose(): void {
    this.gone = true;
    for (const release of this.ids.values()) release();
    this.ids.clear();
  }
}

/** The units' blows, required: the play layer's heroes shove and hold (AgentUnits implements them). */
function playUnits(a: UnitsAround): PlayUnits {
  const u = a.units;
  const { strike, hold, release } = u;
  if (!strike || !hold || !release) throw new Error('play: the units implementation has no strike/hold/release (the Units contract, round 117) — AgentUnits has them');
  return {
    near: (x, y, r) => a.near(x, y, r),
    get: (id) => a.get(id),
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
export function makePlayWorld(api: Sim, units: UnitsAround, camera: Camera, bounds: [number, number], raise?: PlayWorld['raise']): PlayWorld {
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
    raise,
  };
}
