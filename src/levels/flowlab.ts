// The flow lab (?flow=1&level=flowlab, docs/ARCHITECTURE.md "The flow model"): the flow model's test scenes on one map.
//   A (x 30..70, y 30..80): a pool on a plateau 24 cells over the plain, held by a concrete plug in a notch at its lip —
//     dig the plug (reclaimed.flow.breach()) and it pours off the ledge as an arc; a trench takes it off the map.
//   B (x 100..150, y 100..150): a hill with a tunnel through it at z 16..19; a spring at the tunnel's inner end runs along
//     its floor and out of the hillside as a waterfall.
//   C (x 30..110, y 180..230): a ramp with a step in it; a lava vent at its top runs down it, falls off the step, cools
//     and sets into basalt.
// Storage coordinates (x column, y row); the camera looks from +x+y, so each scene's fall faces it.

import { ColumnGrid, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';
import type { FlowKit } from '../flow/install';
import { cellPos } from '../world/lattice';

const PLAIN = 6;
/** the trenches' row bands (scenes A and B): to the map's edge */
const TRENCH_A: [number, number] = [52, 58];
const TRENCH_B: [number, number] = [122, 128];

export const FLOWLAB = {
  pool: { c: [52, 55] as [number, number], r: 9, floor: 27, level: 29.6 },
  plateau: { x0: 30, x1: 70, y0: 30, y1: 80, top: 30 },
  notch: { y0: 53, y1: 57, floor: 28, plug: [64, 66] as [number, number] },
  hill: { x0: 100, x1: 150, y0: 100, y1: 150, top: 34 },
  tunnel: { x0: 110, y0: 123, y1: 127, z0: 16, z1: 19 },
  ramp: { x0: 30, x1: 110, y0: 180, y1: 230, top: 30, step: 75, stepDrop: 5 },
};

export function generateFlowlab(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const water = new Float32Array(N);
  const L = FLOWLAB;
  const inBox = (x: number, y: number, b: { x0: number; x1: number; y0: number; y1: number }) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // the plain, and the trenches that take scenes A and B's water off the map (falling gently to the edge)
      let top = PLAIN;
      if (y >= TRENCH_A[0] && y < TRENCH_A[1] && x >= L.plateau.x1) top = PLAIN - 1 - Math.floor(((x - L.plateau.x1) / (w - L.plateau.x1)) * 3);
      if (y >= TRENCH_B[0] && y < TRENCH_B[1] && x >= L.hill.x1) top = PLAIN - 1 - Math.floor(((x - L.hill.x1) / (w - L.hill.x1)) * 3);
      if (inBox(x, y, L.plateau)) {
        top = L.plateau.top;
        const d = Math.hypot(x - L.pool.c[0], y - L.pool.c[1]);
        if (d < L.pool.r) top = L.pool.floor;
        else if (y >= L.notch.y0 && y < L.notch.y1 && x > L.pool.c[0]) top = L.notch.floor;
        if (d < L.pool.r) water[i] = L.pool.level - top;
        if (top === L.notch.floor && x < L.notch.plug[0]) water[i] = L.pool.level - top;
      }
      if (inBox(x, y, L.hill)) top = L.hill.top;
      if (inBox(x, y, L.ramp)) {
        const r = L.ramp;
        top = Math.round(r.top - (x - r.x0) * ((r.top - PLAIN - r.stepDrop) / (r.x1 - r.x0))) - (x >= r.step ? r.stepDrop : 0);
        top = Math.max(top, PLAIN);
      }
      const tunnel = inBox(x, y, L.hill) && x >= L.tunnel.x0 && y >= L.tunnel.y0 && y < L.tunnel.y1;
      if (tunnel) {
        grid.push(x, y, 0, L.tunnel.z0, MAT.Stone);
        grid.push(x, y, L.tunnel.z1, top, MAT.Stone);
      } else if (top > PLAIN) {
        grid.push(x, y, 0, top, MAT.Stone);
      } else {
        grid.push(x, y, 0, top - 2, MAT.Stone);
        grid.push(x, y, top - 2, top, MAT.Soil);
      }
      // the plug holding the pool back
      if (inBox(x, y, L.plateau) && y >= L.notch.y0 && y < L.notch.y1 && x >= L.notch.plug[0] && x < L.notch.plug[1]) grid.push(x, y, top, top + 3, MAT.Concrete);
    }
  const surface = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    surface[i] = col[col.length - 1].z1;
  }
  const z = (n: number) => new Float32Array(n);
  const moisture = z(N).fill(0.3);
  return {
    grid,
    water,
    contam: z(N * 2),
    moisture,
    vegetation: z(N),
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: [90, 55], dam: L.pool.c, pool: L.pool.c, tunnel: [150, 125], ramp: [70, 205] },
  };
}

/** The lab's springs (the tunnel's stream, the vent), and the plug's breach for scripts. */
export function setupFlowlab(kit: FlowKit): { breach: (spring?: number) => void } {
  const L = FLOWLAB;
  const [tx, ty] = cellPos(L.tunnel.x0 + 2, 125);
  kit.water.addSpring(tx, ty, L.tunnel.z0, 1.2);
  const [vx, vy] = cellPos(L.ramp.x0 + 4, 205);
  kit.lava.addSpring(vx, vy, L.ramp.top + 1, 6);
  return {
    breach: (spring = 1.5) => {
      // (the plug cut away: the level's dig events, a column at a time; and a spring in the pool keeps it pouring)
      const [px, py] = cellPos(L.pool.c[0], L.pool.c[1]);
      if (spring > 0) kit.water.addSpring(px, py, L.pool.floor, spring);
    },
  };
}
