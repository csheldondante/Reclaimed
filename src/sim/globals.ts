// CPU mirror of `struct Globals` in src/shaders/common.wgsl.

import { ROW_H } from '../world/lattice';

export const GLOBALS_BYTES = 1136;
/** cyclones the GPU knows about at once (common.wgsl MAX_CYCLONES) */
export const MAX_CYCLONES = 4;

/** One cyclone for the GPU (common.wgsl CycloneU). */
export interface CycloneUniform {
  /** x, y, radius, strength × spin sign */
  a: [number, number, number, number];
  /** velocity x, y, dust-dropping rate (as it dies), unused */
  b: [number, number, number, number];
  /** the funnel's spine nodes: x, y, z, funnel radius (Weather.SPINE_N = 6) */
  spine: [number, number, number, number][];
}
export const MAX_GUSTS = 4;
export const MAX_STORMS = 4;
export const MAX_EVENTS = 4;
export const MAX_DUSTS = 2;

export const enum EventKind {
  Lightning = 1,
  Chip = 2,
  /** startles perched birds within the radius */
  Scare = 3,
  /** a tap on the ground: growth boost, or a visible wilt on hostile ground */
  Grow = 4,
  /** sandbox brush: z = op * 32 + material (edit.wgsl) */
  Edit = 5,
  /** every click: a ring of wind pushing out from it (windfield.wgsl; round 20) */
  Ripple = 6,
  /** set alight: fuel within the radius catches at intensity `strength` (fire.wgsl; world API fire.ignite) */
  Ignite = 7,
}

/** A dust storm: a roaming patch of strong, gusty wind (no rain, no cloud). */
export interface DustUniform {
  x: number;
  y: number;
  radius: number;
  strength: number;
}

export interface StormUniform {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
  downpour: number;
  flash: number;
  /** outline phases (3) and elongation along travel */
  shape: [number, number, number, number];
}

/** A one-tick impulse into the world (lightning strike, later quakes, …). */
export interface WorldEvent {
  kind: EventKind;
  /** height for height-targeted events (chips) */
  z?: number;
  x: number;
  y: number;
  radius: number;
  strength: number;
}

/** A wind impulse: player gust under a storm, or the cursor breeze. */
export interface Gust {
  x: number;
  y: number;
  radius: number;
  strength: number;
  dx: number;
  dy: number;
  /** stroke segment length behind (x, y) along -(dx, dy) — player drags (wind field) */
  len?: number;
}

export interface GlobalsState {
  mapW: number;
  mapH: number;
  tick: number;
  chunkSize: number;
  chunksX: number;
  zMax: number;
  seed: number;
  time: number;
  dt: number;
  windX: number;
  windY: number;
  sun: [number, number, number];
  pollution: number;
  storms: StormUniform[];
  events: WorldEvent[];
  collapseEnabled: boolean;
  /** false: the structure system only collapses damage (the sandbox's rigid
   *  bodies — game/integrity.ts — handle what loses support); default true */
  spanCollapse?: boolean;
  flash: number;
  gusts: Gust[];
  /** ambient sky rgb + night factor */
  sky: [number, number, number, number];
  /** sun rgb×intensity + time of day 0..1 */
  sunCol: [number, number, number, number];
  /** life lens: x, y, radius, strength (0 = off) */
  lens: [number, number, number, number];
  /** prevailing wind integrated over time (cells): gust patches and ripples are advected by it */
  windOff: [number, number];
  /** >1 while the level is being seeded: ground debris accumulates faster */
  debrisBoost: number;
  /** 0 easy, 1 medium, 2 hard (round 10): how easily green ground is lost */
  difficulty: number;
  dusts: DustUniform[];
  /** the live cyclones (round 12; several at once since round 14) */
  cyclones: CycloneUniform[];
  /** draw plants at diorama scale (the title screen: petals, blades, moss) */
  fineVeg?: boolean;
  /** story rules (round 30): green spreads only by seeds, and sheds them */
  story?: boolean;
  /**
   * The climate (round 50; sim/climate.ts): air temperature (°C) at height 0
   * by day, and how much colder per cell up (snow on the peaks while the
   * valley rains). Below freezing rain falls as snow, water freezes; above,
   * snow and ice melt. Absent: 15 °C, no fall with height.
   */
  climate?: { temp: number; lapse: number };
  /**
   * The season (round 51): 0..1 through the year from midsummer — leaves
   * turn ~0.4–0.55, fall ~0.5–0.75, crowns bare in winter, green again by 1
   * (common.wgsl seasonColour / seasonShed / seasonBare). Absent: 0.
   * WorldCore.yearLength advances it.
   */
  season?: number;
  /**
   * The world cell of the window's first column and row (a streamed world,
   * round 66: scenes/streamer.ts). Hashes and noise of position add it, so
   * what they draw stays with the land when the window slides. Absent: 0, 0.
   */
  origin?: [number, number];
  /** the sea's level in window z (round 79, a streamed atlas world): past the window's edge the world is sea at it */
  seaZ?: number;
  /** set by Simulation.step when a tick consumed the stroke segments (Powers re-anchors) */
  strokeSent?: boolean;
}

export function writeGlobals(s: GlobalsState, out: ArrayBuffer): void {
  const u = new Uint32Array(out);
  const f = new Float32Array(out);
  u[0] = s.mapW;
  u[1] = s.mapH;
  u[2] = s.tick >>> 0;
  u[3] = s.chunkSize;
  u[4] = s.chunksX;
  u[5] = s.zMax;
  u[6] = Math.min(s.storms.length, MAX_STORMS);
  u[7] = s.seed;
  f[8] = s.time;
  f[9] = s.dt;
  f[10] = s.windX;
  f[11] = s.windY;
  f[12] = s.sun[0];
  f[13] = s.sun[1];
  f[14] = s.sun[2];
  f[15] = s.pollution;
  for (let i = 0; i < MAX_STORMS; i++) {
    const st = s.storms[i];
    const a = 16 + i * 4;
    const b = 32 + i * 4;
    if (st) {
      f.set([st.x, st.y, st.radius, st.intensity], a);
      f.set([st.vx, st.vy, st.downpour, st.flash], b);
      f.set(st.shape, 116 + i * 4);
    } else {
      f.fill(0, a, a + 4);
      f.fill(0, b, b + 4);
      f.set([0, 0, 0, 1], 116 + i * 4);
    }
  }
  const nEv = Math.min(s.events.length, MAX_EVENTS);
  for (let i = 0; i < MAX_EVENTS; i++) {
    const e = s.events[i];
    const a = 48 + i * 4;
    if (e && i < nEv) {
      f.set([e.x, e.y, e.radius, e.strength], a);
      f[64 + i] = e.kind + 16 * Math.max(0, Math.round(e.z ?? 0));
    } else {
      f.fill(0, a, a + 4);
      f[64 + i] = 0;
    }
  }
  f[68] = nEv;
  f[69] = s.collapseEnabled ? (s.spanCollapse === false ? 2 : 1) : 0;
  f[70] = s.flash;
  f[71] = s.fineVeg ? 1 : 0;
  for (let i = 0; i < MAX_GUSTS; i++) {
    const g = s.gusts[i];
    if (g) {
      f.set([g.x, g.y, g.radius, g.strength], 72 + i * 4);
      f.set([g.dx, g.dy, g.len ?? 0, 0], 88 + i * 4);
    } else {
      f.fill(0, 72 + i * 4, 76 + i * 4);
      f.fill(0, 88 + i * 4, 92 + i * 4);
    }
  }
  f.set(s.sky, 104);
  f.set(s.sunCol, 108);
  f.set(s.lens, 112);
  f.set([s.windOff[0], s.windOff[1], s.debrisBoost, s.difficulty], 132);
  for (let c = 0; c < MAX_CYCLONES; c++) {
    const cy = s.cyclones[c];
    const o = 144 + c * 32;
    f.set(cy ? cy.a : [0, 0, 1, 0], o);
    f.set(cy ? cy.b : [0, 0, 0, 0], o + 4);
    for (let i = 0; i < 6; i++) f.set(cy?.spine[i] ?? [0, 0, 0, 0], o + 8 + i * 4);
  }
  for (let i = 0; i < MAX_DUSTS; i++) {
    const d = s.dusts[i];
    f.set(d ? [d.x, d.y, d.radius, d.strength] : [0, 0, 1, 0], 136 + i * 4);
  }
  f.set([s.story ? 1 : 0, s.climate?.temp ?? 15, s.climate?.lapse ?? 0, s.season ?? 0], 272);
  const o = s.origin ?? [0, 0];
  // (world units for the noise of positions; cells for the hashes of cells)
  f.set([o[0], o[1] * ROW_H, o[0], o[1]], 276);
  f.set([s.seaZ ?? -1e9, 0, 0, 0], 280);
}
