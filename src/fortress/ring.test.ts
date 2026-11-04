// (round 128h, FT-57) Fortress.ringCells: a closed ring, each cell sharing a side with the next, so a ring of walls
// painted on it shuts its middle in — on the cells and in the columns the agents walk (it left a 12-column gap on a
// radius-18 ring round (80, 80): the circle's last cell and its first met at a corner).
import { describe, expect, it } from 'vitest';
import { cellPos } from '../world/lattice';
import { Fortress } from './fortress';
import type { ReachColumns } from './reach';

const W = 160;
const H = 184;
const GROUND = 5;

function fortress() {
  let cols: ReachColumns | null = null;
  const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground: () => GROUND,
    stores: () => ({}),
    changed: () => {},
    columns: () => cols,
    townHeap: () => [10, 10],
  });
  f.ready = true;
  return { f, read: () => (cols = { w: W, h: H, runs: () => [[0, GROUND]], water: () => 0 }) };
}

/** the cells a flood from `mid` over sides gets to, round the ring's cells */
function shutIn(f: Fortress, wall: Set<number>, mid: number): Set<number> {
  const seen = new Set([mid]);
  const q = [mid];
  while (q.length) {
    const c = q.pop()!;
    for (let e = 0; e < 4; e++) {
      const n = f.grid.nbr[c * 4 + e];
      if (n < 0 || wall.has(n) || seen.has(n) || seen.size > 2000) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

describe('ringCells (FT-57)', () => {
  it('is closed side to side, and shuts its middle in, at every radius and centre', () => {
    const { f } = fortress();
    const g = f.grid;
    const nb = (a: number, b: number) => [0, 1, 2, 3].some((e) => g.nbr[a * 4 + e] === b);
    for (const [cx, cy] of [[80, 80], [80, 79.7], [83.3, 77.9], [74.8, 84.4], [90, 75], [70, 70]])
      for (const r of [8, 11, 12, 13, 16, 18, 22, 27, 30]) {
        const ring = f.ringCells(cx, cy, r);
        expect(new Set(ring).size).toBe(ring.length);
        for (let i = 0; i < ring.length; i++) expect(nb(ring[i], ring[(i + 1) % ring.length]), `(${cx}, ${cy}) r ${r}: ${i}`).toBe(true);
        // (a flood from the middle over sides, round the ring's cells, never gets out)
        const seen = shutIn(f, new Set(ring), f.cellAt(cx, cy));
        const far = [...seen].some((c) => Math.hypot(g.centre(c)[0] - cx, g.centre(c)[1] - cy) > r + 8);
        expect(far, `(${cx}, ${cy}) radius ${r} leaks`).toBe(false);
      }
  });

  it('a ring of walls shuts the columns inside off from the stores (the agents\' rules)', () => {
    for (const [cx, cy, r] of [[80, 80, 18], [80, 80, 12], [90, 75, 18]]) {
      const { f, read } = fortress();
      const ring = new Set(f.ringCells(cx, cy, r));
      for (const c of ring) expect(f.paint(c, 0, 'wall')).toBe(true);
      const within = shutIn(f, ring, f.cellAt(cx, cy));
      read();
      const m = f.reachMap()!;
      let inside = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const [wx, wy] = cellPos(x, y);
          // (the cells the ring shuts in: not the ring's own — the wall-walk on top of them is reached up its stairs)
          if (within.has(f.grid.cellAtWorld(wx, wy)) && m.reached(x, y)) inside++;
        }
      expect(inside, `(${cx}, ${cy}) r ${r}`).toBe(0);
    }
  });
});
