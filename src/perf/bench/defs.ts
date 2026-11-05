// The bench's constants and small helpers: the version and build, the A/B system lists, the probe speeds, stat and
// r3. Owns no state (the page heartbeat, beat/beatWhat and frame(), stays in bench.ts: ES imports can't be assigned).
import { RANGES } from '../../scenes/range';

/** (v3) vite.config.ts `define`: the build's time */
declare const __BENCH_BUILD__: string;

export const BENCH_VERSION = 9;
export const STATE = 'reclaimed.bench.state';
/** (v3) the build, on the start page: vite.config.ts defines it at build time */
export const BUILD: string = typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev';
export const LAST = 'reclaimed.bench.last';
export const ROW_H = Math.sqrt(3) / 2;
/** the riding scenario's start (scripts/hitchrun.mjs: a road in a temperate place on the default seed) */
export const RIDE_AT = '15024,14337';
/** the URL keys the suite sets itself (the rest of the start page's URL is carried to every page) */
export const OWN = ['bench', 'benchpage', 'benchsmoke', 'panzooms', 'run', 'win', 'drive', 'at', 'hitch', 'hitchhud', 'world', 'skipmenu', 'level', 'tutorial', 'perf', 'bgcheck'];

// ---------- numbers ----------

export interface Stat {
  unit: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  min: number;
}

export const r3 = (v: number) => (Number.isFinite(v) ? +v.toFixed(3) : v);

/** samples → their unit, count, p50/p95/max (null when none) */
export function stat(xs: number[], unit: string): Stat | null {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { unit, n: a.length, p50: r3(q(0.5)), p95: r3(q(0.95)), max: r3(a[a.length - 1]), mean: r3(a.reduce((s, v) => s + v, 0) / a.length), min: r3(a[0]) };
}

export const MB = 1048576;

/** (v2) the A/B's systems that may scale with the window (the window pages) */
export const AB_WINDOW = ['simAll', 'renderprep', 'meshRebuild', 'shadow', 'grid', 'farLand'];
/**
 * (v4) The A/B on an active scene (the user: "it turns off systems to check perf but on a pretty static scene … those
 * systems sleep most of the time anyway"): while riding with a storm over the camera (land arriving wakes its chunks,
 * the rain wakes water and sediment), and at a meteor's lava
 */
export const AB_RIDE = ['simAll', 'water', 'sediment', 'wind', 'lava', 'plants', 'otherSims', 'renderfields', 'particlesSim', 'agents', 'renderprep', 'meshRebuild', 'shadow', 'farLand', 'grid', 'voxelMesh', 'particlesDraw', 'waterDraw', 'plantsDraw'];
export const AB_METEOR = ['simAll', 'lava', 'water', 'sediment', 'particlesSim', 'renderfields'];
/** (v3, round 102) the window sizes: the range button's three and two wider (the user: "crank up pan speed and view distance") */
export const WINDOWS = [...RANGES, 448, 512];
/** (v3) the max-sustainable probe's pan speeds (cells/s), each held PROBE_S seconds */
export const PROBE_SPEEDS = [80, 100, 125, 160, 200, 250, 320, 400, 500, 640];
export const PROBE_S = 3;
