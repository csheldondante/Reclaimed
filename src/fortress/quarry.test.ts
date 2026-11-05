// (round 128m, quarry; V128-11) The miners grow a pit down tier by tier (quarry.ts) on a fortress over a fake ground:
// the tiers are dug in order, each to its depth, the floor flat, and a walker (the agents' step, reach.ts STEP) gets
// from the rim to the floor down the ramps the whole time.
import { describe, expect, it } from 'vitest';
import { LEVEL_H } from '../build/town';
import { cellAt, cellPos, nbr } from '../world/lattice';
import { Fortress } from './fortress';
import { QuarryDig } from './quarry';
import { STEP } from './reach';

const W = 120;
const H = 140;
/** the land rises east: the ramp's top is over the pit's lowest ground */
const SLOPE = 0.08;

function world() {
  const z = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) z[y * W + x] = 60 + x * SLOPE;
  const col = (x: number, y: number) => {
    const [k, r] = cellAt(x, y);
    return Math.max(0, Math.min(H - 1, r)) * W + Math.max(0, Math.min(W - 1, k));
  };
  const fort = new Fortress(
    { origin: [0, 0], w: W, h: H },
    { windowOrigin: () => [0, 0], dims: { w: W, h: H, zMax: 400 }, ground: (x, y) => z[col(x, y)], stores: () => ({}), changed: () => {} },
  );
  fort.ready = true;
  let woken = 0;
  const dig = new QuarryDig({
    fort,
    ground: (x, y) => z[col(x, y)],
    dig: (at, n) => {
      const i = col(at[0], at[1]);
      const got = Math.max(0, Math.min(n, z[i] - 2));
      z[i] -= got;
      return Promise.resolve(got);
    },
    settle: () => woken++,
  });
  return { z, col, fort, dig, woken: () => woken };
}

/** a quarry's footprint: the cells within r of (x, y), painted and built */
function quarry(w: ReturnType<typeof world>, x: number, y: number, r: number): number {
  const { fort } = w;
  for (let c = 0; c < fort.grid.count; c++) {
    const [cx, cy] = fort.grid.centre(c);
    if (Math.hypot(cx - x, cy - y) <= r) fort.paint(c, 0, 'quarry');
  }
  const s = fort.plan.structures().find((t) => t.type === 'quarry')!;
  for (const c of s.cells.keys()) fort.markBuilt(c, 0);
  return s.id;
}

/** whether a walker gets from the rim to the floor: hex columns of the footprint, a step no higher than STEP */
function walkable(w: ReturnType<typeof world>, id: number): boolean {
  const { fort, z } = w;
  const pit = fort.plan.pitOf(id)!;
  const inPit = new Set<number>();
  for (const c of pit.ring.keys()) for (const col of fort.grid.columns[c]) inPit.add(col);
  // (from outside: the cell beyond the ramp's top)
  const outside = fort.grid.nbr[pit.top * 4 + pit.topSide];
  for (const col of fort.grid.columns[outside]) inPit.add(col);
  const start = fort.grid.columns[outside];
  // (the floor: the deepest tier's cells)
  const floor = new Set<number>();
  for (const [c, d] of pit.ring) if (d >= pit.tiers) for (const col of fort.grid.columns[c]) floor.add(col);
  const seen = new Set<number>(start);
  const queue = [...start];
  while (queue.length) {
    const i = queue.pop()!;
    if (floor.has(i)) return true;
    const x = i % W;
    const y = Math.floor(i / W);
    for (let k = 0; k < 6; k++) {
      const [nx, ny] = nbr(x, y, k);
      const j = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(j) || !inPit.has(j)) continue;
      if (Math.abs(z[j] - z[i]) > STEP) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return false;
}

/** miners at every spot dig until the pit is done (or `rounds` run out); every round the JobBoard's turn */
async function digOn(w: ReturnType<typeof world>, rounds: number, each?: (round: number) => void): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    w.dig.update();
    if (!w.dig.digging()) return;
    for (const at of w.dig.spots(8)) w.dig.dig(at);
    await Promise.resolve();
    each?.(r);
  }
}

describe('the miners grow the pit', () => {
  it('tier by tier down to the plan’s depth: the floor flat, the ramps walkable all the way down', async () => {
    const w = world();
    const id = quarry(w, 60, 60, 22);
    const pit = w.fort.plan.pitOf(id)!;
    expect(pit.tiers).toBeGreaterThanOrEqual(3);
    w.dig.update();
    const st = w.dig.stateOf(id)!;
    expect(st.tier).toBe(1);
    let lastTier = 1;
    let checks = 0;
    await digOn(w, 20000, (r) => {
      const s = w.dig.stateOf(id)!;
      // (tiers in order, never skipped)
      expect(s.tier - lastTier).toBeLessThanOrEqual(1);
      lastTier = s.tier;
      // (a walker gets down: checked now and then, once the first ramp has begun)
      if (r % 10 === 9 && s.tier > 1) {
        expect(walkable(w, id)).toBe(true);
        checks++;
      }
    });
    expect(w.dig.digging()).toBe(false);
    expect(checks).toBeGreaterThan(3);
    const ref = w.dig.stateOf(id)!.ref;
    // (the floor: the deepest tier, flat)
    for (const [c, d] of pit.ring)
      if (d >= pit.tiers) for (const col of w.fort.grid.columns[c]) expect(w.z[col]).toBeCloseTo(ref - pit.tiers * LEVEL_H, 0);
    // (a shelf: its ring's tier)
    const shelf = [...pit.ring].find(([c, d]) => d === 1 && !w.fort.plan.pit.at(c, -2))![0];
    for (const col of w.fort.grid.columns[shelf]) expect(w.z[col]).toBeCloseTo(ref - LEVEL_H, 0);
    // (the rim untouched off the ramp)
    const rim = [...pit.ring].find(([c, d]) => d === 0 && !w.fort.plan.pit.any(c))![0];
    for (const col of w.fort.grid.columns[rim]) expect(w.z[col]).toBeCloseTo(60 + (col % W) * SLOPE, 4);
    expect(walkable(w, id)).toBe(true);
    // (every tier's levels dug, the ground woken a tier at a time)
    for (const [c] of pit.ring) for (const L of w.fort.plan.pit.each(c)) expect(w.fort.dug.has(c, L)).toBe(true);
    expect(w.woken()).toBe(pit.tiers);
  });

  it('nothing is dug until every cell of the footprint is built', () => {
    const w = world();
    const { fort } = w;
    for (let c = 0; c < fort.grid.count; c++) {
      const [cx, cy] = fort.grid.centre(c);
      if (Math.hypot(cx - 60, cy - 60) <= 16) fort.paint(c, 0, 'quarry');
    }
    w.dig.update();
    expect(w.dig.digging()).toBe(false);
    expect(w.dig.dig(fort.centre([...fort.plan.structures()[0].cells.keys()][5]))).toBe(false);
  });

  it('a slide in z: the pit keeps its depth in the world', async () => {
    const w = world();
    const id = quarry(w, 60, 60, 16);
    await digOn(w, 50);
    const before = w.dig.stateOf(id)!;
    // (the window up 32: every window z 32 lower, the fortress told)
    for (let i = 0; i < w.z.length; i++) w.z[i] -= 32;
    w.fort.slidZ(32);
    w.dig.update();
    const after = w.dig.stateOf(id)!;
    expect(after.tier).toBe(before.tier);
    expect(after.ref).toBe(before.ref);
    // (the ground as first read, in window z now)
    expect(w.fort.groundAt(60 * W + 60)).toBeCloseTo(60 + 60 * SLOPE - 32, 3);
  });

  it('the pit’s ramp top is where the quarry’s road comes in', () => {
    const w = world();
    const id = quarry(w, 60, 60, 16);
    const e = w.fort.pitEntry(id)!;
    expect(e.cell).toBe(w.fort.plan.pitOf(id)!.top);
    const out = w.fort.grid.nbr[e.cell * 4 + e.side];
    expect(out < 0 || w.fort.plan.owner[out] !== id).toBe(true);
    void cellPos;
  });
});
