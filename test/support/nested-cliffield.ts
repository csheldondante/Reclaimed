// The cliff rule's synthetic 16 m heightfield (round 32 step A; moved here from test/unit/nested-cliffrule.test.ts in
// step B1 so the GPU port's test can use it without registering the unit tests): a plateau ending in a curved 80 m cliff
// (a bay with two inside corners, a bump with two outside corners), a long 70 deg slope over four coarse cells up to a
// 200 m block, a ridge with a col (a saddle), a pit, gentle rolling ground, a sphere bowl and a trench.
import { COARSE_M, UPM, type Field } from '../../src/nested/exp/cliffrule';

export const NXC = 40;
export const NYC = 32;

function sstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** the synthetic terrain, metres (dome: round 32 B3, the owner's sphere ADD beside the bowl; off by default so the
 *  existing numbers stay) */
export function terrain(x: number, y: number, dome = false): number {
  let z = 20 + 2.5 * Math.sin(x / 37) * Math.cos(y / 53) + 1.5 * Math.sin((x + y) / 23);
  // plateau at 100 m: a curved rim, a bay (inside corners), a bump (outside corners); a 4 m wide edge
  const dMain = y - (300 + 40 * Math.sin(x / 90));
  const dBay = Math.min(x - 120, 200 - x, 380 - y);
  const dBump = Math.min(x - 430, 520 - x, y - 196);
  const dP = Math.max(Math.min(dMain, -dBay), dBump);
  z = z + (100 - z) * sstep(-2, 2, dP);
  // the east block: a 70 deg slope (rise 2.75 per metre) from y = 130 to 200 m, a sharp side wall at x = 544
  const zE = 20 + Math.max(0, Math.min(180, (y - 130) * 2.75));
  z = Math.max(z, z + (zE - z) * sstep(-2, 2, x - 544));
  // a ridge along y = 200, 80 m high, 24 m wide, with a col (30 m) at x = 152 (a cell centre: a saddle cell)
  const rh = (80 - 50 * Math.exp(-(((x - 152) / 10) ** 2))) * sstep(40, 50, x) * sstep(250, 240, x);
  z = Math.max(z, 20 + rh * Math.max(0, 1 - Math.abs(y - 200) / 12));
  // a pit 40 m deep, radius 12 m, at a cell centre
  const r = Math.hypot(x - 360, y - 168);
  z -= 40 * sstep(13, 11, r);
  // brush carves (round 32 step A, the owner's addition), stored like any other shape as cell means: a sphere bowl of
  // radius 40 m centred at ground level (20 m), and a trench 48 m wide, 40 m deep, at 27 deg to the grid
  const rb = Math.hypot(x - BOWL[0], y - BOWL[1]);
  if (rb < 40) z = Math.min(z, 20 - Math.sqrt(1600 - rb * rb));
  const ux = x - TRENCH[0];
  const uy = y - TRENCH[1];
  const along = ux * TRENCH_DIR[0] + uy * TRENCH_DIR[1];
  const across = -ux * TRENCH_DIR[1] + uy * TRENCH_DIR[0];
  if (Math.abs(across) < 24 && along > 0 && along < 260) z = Math.min(z, 20 - 40);
  // (B3) a sphere add of radius 40 m centred at ground level (20 m) beside the bowl: a dome
  if (dome) {
    const rd = Math.hypot(x - DOME[0], y - DOME[1]);
    if (rd < 40) z = Math.max(z, 20 + Math.sqrt(1600 - rd * rd));
  }
  return z;
}
export const DOME = [205, 100];
export const BOWL = [120, 90];
export const TRENCH = [250, 40];
export const TRENCH_DIR = [Math.cos((27 * Math.PI) / 180), Math.sin((27 * Math.PI) / 180)];
export function makeField(dome = false): Field {
  const h = new Int32Array(NXC * NYC);
  const S = 8;
  for (let cy = 0; cy < NYC; cy++)
    for (let cx = 0; cx < NXC; cx++) {
      let s = 0;
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) s += terrain(cx * COARSE_M + ((i + 0.5) * COARSE_M) / S, cy * COARSE_M + ((j + 0.5) * COARSE_M) / S, dome);
      h[cy * NXC + cx] = Math.round((s / (S * S)) * UPM);
    }
  return { nx: NXC, ny: NYC, h };
}
