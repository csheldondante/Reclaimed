// (round 128s, trackA-legible, variant D — a prototype) A town's main streets as streamlines of a direction field: the
// parked road generator's CPU reference (roadgen/cpu.ts, DA-A13 step 0, branch onetown-roadgen) run for its major family
// only, at a generous spacing, over the town's box, with a basis the step-0 field lacked — the iso-lines of the smoothed
// distance to water, so streets run along rivers and shores (the user: "a smoothed JFA distance field to get lines
// parallel to water features and mountains"). The lines go to the town's roads as drawn main roads (build/townroads.ts
// mainRoads `drawn`): the irregular grid adapts to them and its tiles fill the blocks between, so painting is unchanged.
// On the CPU in the plan worker (the step-0 GPU kernels are on the parked branch: production would run them there, the
// distance by the atlas's JFA — DEVLOG round 128s).
import { RoadGenCpu } from './cpu';
import { latticeSize, ROADGEN_STYLE, type RoadGenParams, type V2 } from './roadgen';

export interface FieldStreetsIn {
  /** the box (m) and the town's middle and the streets' reach from it */
  W: number;
  H: number;
  centre: V2;
  radius: number;
  ground(x: number, y: number): number;
  /** water over the ground here (m) */
  water(x: number, y: number): number;
  seed: number;
  major: number;
  grid: number;
  radial: number;
  wWater: number;
  sigmaW: number;
  /** the grid basis's angle */
  theta: number;
}

/** the major streets (box-local polylines, a step apart) */
export function fieldStreets(o: FieldStreetsIn): { lines: V2[][]; ms: number } {
  const t0 = performance.now();
  const params: RoadGenParams = {
    W: o.W,
    H: o.H,
    S: ROADGEN_STYLE.S,
    centre: o.centre,
    radius: o.radius,
    theta: o.theta,
    sigmaR: o.radius * 0.8,
    sigmaC: ROADGEN_STYLE.sigmaC,
    major: o.major,
    minor: 0,
    step: 2,
    jitter: 0,
    seed: o.seed,
    wGrid: o.grid,
    wRadial: o.radial,
    wWater: o.wWater,
    sigmaW: o.sigmaW,
  };
  const { nx, ny } = latticeSize(params);
  const ground = new Float32Array(nx * ny);
  const wet = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = i * params.S;
      const y = j * params.S;
      ground[j * nx + i] = o.ground(x, y);
      wet[j * nx + i] = o.water(x, y) > 0.3 ? 1 : 0;
    }
  const waterDist = smoothed(chamfer(wet, nx, ny, params.S), nx, ny, 3);
  const roads = new RoadGenCpu({ params, ground, wet, constraints: [], waterDist }).run();
  return { lines: roads.filter((r) => r.family === 0 && !r.fixed).map((r) => r.pts), ms: +(performance.now() - t0).toFixed(1) };
}

/** the distance (m) from each node to the nearest wet one: a two-pass chamfer (1, √2) — the JFA's answer on the CPU */
function chamfer(wet: Uint8Array, nx: number, ny: number, S: number): Float32Array {
  const d = new Float32Array(nx * ny).fill(1e9);
  for (let k = 0; k < d.length; k++) if (wet[k]) d[k] = 0;
  const D = Math.SQRT2;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? 1e9 : d[j * nx + i]);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) d[j * nx + i] = Math.min(d[j * nx + i], at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + D, at(i + 1, j - 1) + D);
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) d[j * nx + i] = Math.min(d[j * nx + i], at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + D, at(i - 1, j + 1) + D);
  for (let k = 0; k < d.length; k++) d[k] = Math.min(d[k], 1e4) * S;
  return d;
}

/** a box blur `n` times (a node's 3 x 3) */
function smoothed(f: Float32Array, nx: number, ny: number, n: number): Float32Array {
  let a = f;
  for (let it = 0; it < n; it++) {
    const b = new Float32Array(a.length);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0;
        let c = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            s += a[jj * nx + ii];
            c++;
          }
        b[j * nx + i] = s / c;
      }
    a = b;
  }
  return a;
}
