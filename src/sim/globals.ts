// CPU mirror of `struct Globals` in src/shaders/common.wgsl.

export const GLOBALS_BYTES = 464;
export const MAX_GUSTS = 4;
export const MAX_STORMS = 4;
export const MAX_EVENTS = 4;

export const enum EventKind {
  Lightning = 1,
  Chip = 2,
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
  flash: number;
  gusts: Gust[];
  /** ambient sky rgb + night factor */
  sky: [number, number, number, number];
  /** sun rgb×intensity + time of day 0..1 */
  sunCol: [number, number, number, number];
  /** life lens: x, y, radius, strength (0 = off) */
  lens: [number, number, number, number];
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
    } else {
      f.fill(0, a, a + 4);
      f.fill(0, b, b + 4);
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
  f[69] = s.collapseEnabled ? 1 : 0;
  f[70] = s.flash;
  f[71] = 0;
  for (let i = 0; i < MAX_GUSTS; i++) {
    const g = s.gusts[i];
    if (g) {
      f.set([g.x, g.y, g.radius, g.strength], 72 + i * 4);
      f.set([g.dx, g.dy, 0, 0], 88 + i * 4);
    } else {
      f.fill(0, 72 + i * 4, 76 + i * 4);
      f.fill(0, 88 + i * 4, 92 + i * 4);
    }
  }
  f.set(s.sky, 104);
  f.set(s.sunCol, 108);
  f.set(s.lens, 112);
}
