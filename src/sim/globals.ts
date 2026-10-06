// CPU mirror of `struct Globals` in src/shaders/common.wgsl.

export const GLOBALS_BYTES = 192;
export const MAX_STORMS = 4;

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
}
