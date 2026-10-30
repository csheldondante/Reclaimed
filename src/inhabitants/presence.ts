// Density and threat per region (round 117): hostile creatures are soft barriers for runs (r117: "transient soft
// barriers like hostile agents"). Computed on the CPU from the groups' centres and counts (read back from the GPU's
// group sums every ~0.5 s): a few hundred groups, any rectangle, any scale — the run planner asks about regions far
// past the window too, where only the group records exist. Pure (presence.test.ts).

import type { Presence } from '../api/contracts/inhabitants';

export interface GroupSample {
  x: number;
  y: number;
  count: number;
  /** the species' threat (0..1) */
  threat: number;
  /** how far the group spreads (cells): its members are spread over the regions this covers */
  spread: number;
}

export function presence(groups: readonly GroupSample[], rect: { x0: number; y0: number; x1: number; y1: number }, cell: number): Presence {
  if (!(cell > 0)) throw new Error(`presence: cell ${cell}`);
  const nx = Math.max(1, Math.ceil((rect.x1 - rect.x0) / cell));
  const ny = Math.max(1, Math.ceil((rect.y1 - rect.y0) / cell));
  const density = new Float32Array(nx * ny);
  const threat = new Float32Array(nx * ny);
  for (const g of groups) {
    if (g.count <= 0) continue;
    // a group's members spread over a disc of `spread`: split them over the regions the disc's box covers, by overlap
    const r = Math.max(0.5, g.spread);
    const i0 = Math.floor((g.x - r - rect.x0) / cell);
    const i1 = Math.floor((g.x + r - rect.x0) / cell);
    const j0 = Math.floor((g.y - r - rect.y0) / cell);
    const j1 = Math.floor((g.y + r - rect.y0) / cell);
    const area = 4 * r * r;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const ox = Math.min(g.x + r, rect.x0 + (i + 1) * cell) - Math.max(g.x - r, rect.x0 + i * cell);
        const oy = Math.min(g.y + r, rect.y0 + (j + 1) * cell) - Math.max(g.y - r, rect.y0 + j * cell);
        if (ox <= 0 || oy <= 0 || i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const share = (g.count * ox * oy) / area;
        density[j * nx + i] += share;
        threat[j * nx + i] += share * g.threat;
      }
  }
  return { x0: rect.x0, y0: rect.y0, cell, nx, ny, density, threat };
}
