// (round 128h, FT-57) Fortress.ringCells: a closed ring, each cell sharing a side with the next, so a ring of walls
// painted on it shuts its middle in — on the cells and in the columns the agents walk (it left a 12-column gap on a
// radius-18 ring round (80, 80): the circle's last cell and its first met at a corner).
import { fortressOn } from './testing';
import { describe, expect, it } from 'vitest';
import { Fortress } from './fortress';
import { CpuReach, type ReachColumns } from '../build/reach';

const W = 160;
const H = 184;
const GROUND = 5;

function fortress() {
  const cols: ReachColumns = { w: W, h: H, runs: () => [[0, GROUND]], water: () => 0 };
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground: () => GROUND,
    stores: () => ({}),
    changed: () => {},
    reach: new CpuReach(cols, W, H, () => [0, 0]),
    townHeap: () => [10, 10],
  });
  f.ready = true;
  return { f };
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

  it('a ring of walls shuts the cells inside off from the stores (the agents\' rules)', async () => {
    for (const [cx, cy, r] of [[80, 80, 18], [80, 80, 12], [90, 75, 18]]) {
      const { f } = fortress();
      const ring = new Set(f.ringCells(cx, cy, r));
      const within = shutIn(f, ring, f.cellAt(cx, cy));
      // (farms on every cell inside: the reach asks about each one)
      const yards = [...within].filter((c) => !ring.has(c));
      // (RT-6: the ring placed gets a gate — the cells a builder stands at only from inside — shut again behind the
      // check's back; round 128o, B: the farms inside then get a gate of their own, the one way in — every farm kept)
      f.paintMany([...ring], 0, 'wall');
      await f.settled();
      for (const c of ring) f.plan.gate[c] = 0;
      f.requestReach();
      await f.settled();
      f.paintMany(yards, 0, 'farm');
      await f.settled();
      const inside = yards.filter((c) => f.plan.has(c, 0)).length;
      expect(inside, `(${cx}, ${cy}) r ${r}`).toBe(yards.length);
      expect([...ring].filter((c) => f.plan.gate[c]).length).toBe(1);
      expect(f.refusal).toBe(null);
    }
  }, 30000);
});
