// (round 128d) The fortress bakes its own ways (ways.ts; the user: "buildings are supposed to bake their own paths so we
// probably want roads and squares between structures and the stairs up onto the walls"): every door joins one road
// net, gates carry it through the wall, each wall run has a stair, the nav graph reaches the wall-walk — and the solid
// the GPU field walks (solid.ts claims) climbs the stair onto the wall's top, which it can't without one.
import { describe, expect, it } from 'vitest';
import { LEVEL_H } from '../build/town';
import { navPath } from '../structures/nav';
import { library } from '../structures/modules';
import { nbr as hexNbr } from '../world/lattice';
import { Fortress } from './fortress';
import { fortressPieces } from './pieces';
import { solidSpans } from './solid';
import { noWays, SLOPE, WAY_ROAD, WAY_SQUARE, WAY_STAIR, axisLength, type Ways } from './ways';
import { WALL_HALF } from './solid';

const W = 160;
const H = 184;
const GROUND = 5;

function fortress() {
  const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground: () => GROUND,
    stores: () => ({}),
    changed: () => {},
  });
  f.ready = true;
  return f;
}

/** a walled ring round the box's middle (radius r), a gate on its +x side, the keep in the middle, buildings inside */
function walled(f: Fortress, r = 22) {
  const [cx, cy] = [W / 2, (H / 2) * Math.sqrt(3) / 2];
  const ring = f.ringCells(cx, cy, r);
  for (const c of ring) f.paint(c, 0, 'wall');
  const byX = [...ring].sort((a, b) => f.centre(b)[0] - f.centre(a)[0]);
  const gate = byX.find((c) => f.setGate(c, true));
  if (gate === undefined) throw new Error('no straight wall cell for a gate');
  const keep = f.cellAt(cx, cy);
  f.paint(keep, 0, 'fortress');
  f.paint(keep, 1, 'fortress');
  const house = f.cellAt(cx - 10, cy + 6);
  f.paint(house, 0, 'house');
  const store = f.cellAt(cx + 4, cy - 12);
  f.paint(store, 0, 'warehouse');
  // a farm outside the wall (a yard: no door)
  f.paint(f.cellAt(cx + r + 14, cy), 0, 'farm');
  return { ring, gate, keep, house, store };
}

/** the net's cells (roads, squares, gates) reached from a cell along it */
function along(f: Fortress, w: Ways, from: number): Set<number> {
  const on = (c: number) => c >= 0 && (w.way[c] === WAY_ROAD || w.way[c] === WAY_SQUARE || w.gates.includes(c));
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const c = q.pop()!;
    for (let e = 0; e < 4; e++) {
      const n = f.grid.nbr[c * 4 + e];
      if (on(n) && !seen.has(n)) {
        seen.add(n);
        q.push(n);
      }
    }
  }
  return seen;
}

describe('the fortress bakes its ways', () => {
  it('every door opens on one road net, through the gate to outside', () => {
    const f = fortress();
    const { keep, house, store, gate } = walled(f);
    const w = f.ways();
    const doorOf = (c: number) => w.doors.find((d) => d.structure === f.plan.owner[c]);
    for (const c of [keep, house, store]) {
      const d = doorOf(c);
      expect(d, `a door on ${f.plan.typeAt(c)}`).toBeTruthy();
      expect([WAY_ROAD, WAY_SQUARE]).toContain(w.way[d!.out]);
    }
    expect(w.cutOff).toEqual([]);
    const net = along(f, w, doorOf(keep)!.out);
    for (const c of [house, store]) expect(net.has(doorOf(c)!.out)).toBe(true);
    // the gate is on the way, and so is ground on both its sides
    expect(net.has(gate)).toBe(true);
    const outs = [0, 1, 2, 3].map((e) => f.grid.nbr[gate * 4 + e]).filter((n) => n >= 0 && f.plan.owner[n] < 0);
    expect(outs.length).toBe(2);
    for (const o of outs) expect(net.has(o)).toBe(true);
    // a road never runs over a structure
    for (let c = 0; c < f.grid.count; c++) if (w.way[c] !== 0 && !w.gates.includes(c)) expect(f.plan.owner[c]).toBe(-1);
  });

  it('a wall run has a stair: free cells straight out from a straight stretch, on the inside, no steeper than SLOPE', () => {
    const f = fortress();
    const { ring, keep } = walled(f);
    const w = f.ways();
    expect(w.stairs.length).toBeGreaterThanOrEqual(1);
    for (const s of w.stairs) {
      expect(ring).toContain(s.wall);
      expect(f.plan.gate[s.wall]).toBe(0);
      for (const c of s.cells) {
        expect(f.plan.owner[c]).toBe(-1);
        expect(w.way[c]).toBe(WAY_STAIR);
      }
      // its foot on the road
      expect([WAY_ROAD, WAY_SQUARE]).toContain(w.way[s.foot]);
      // long enough for the wall's height at SLOPE
      expect(axisLength(s.axis) - WALL_HALF).toBeGreaterThanOrEqual((f.plan.top(s.wall) + 1) * LEVEL_H / SLOPE - 1e-6);
      // inside: its foot nearer the keep than the wall is
      const d = (c: number) => Math.hypot(f.centre(c)[0] - f.centre(keep)[0], f.centre(c)[1] - f.centre(keep)[1]);
      expect(d(s.foot)).toBeLessThan(d(s.wall));
    }
  });

  it('the nav graph: from a house through its door, along the road, up a stair to the wall-walk', () => {
    const f = fortress();
    const { house } = walled(f);
    const g = f.nav();
    const from = g.nodes.find((n) => n.surface === 'floor' && n.building === f.plan.owner[house])!;
    expect(from).toBeTruthy();
    const walks = g.nodes.filter((n) => n.surface === 'rampart');
    expect(walks.length).toBeGreaterThan(10);
    const to = walks[Math.floor(walks.length / 2)];
    const path = navPath(g, from.id, to.id);
    expect(path.length).toBeGreaterThan(2);
    const kinds = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) {
      const l = g.links.find((k) => (k.a === path[i] && k.b === path[i + 1]) || (k.b === path[i] && k.a === path[i + 1]))!;
      kinds.add(l.kind);
    }
    expect(kinds.has('door')).toBe(true);
    expect(kinds.has('stairs')).toBe(true);
    expect(g.nodes[path[path.length - 1]].at[2]).toBeGreaterThanOrEqual(GROUND + LEVEL_H);
  });

  it('the solid the units walk (GPU surfaces: a step up to 1.1, down to 2.6) climbs the stair onto the wall-walk', () => {
    const f = fortress();
    const { ring } = walled(f);
    for (const s of f.plan.structures()) for (const c of s.cells.keys()) for (const L of f.plan.levels.each(c)) f.markBuilt(c, L);
    const w = f.ways();
    const st = w.stairs[0];
    /** each box column's top: the ground, or a claim's top over it */
    const tops = (ways: Ways) => {
      const top = new Float64Array(W * H).fill(GROUND);
      for (const spans of solidSpans({ plan: f.plan, town: f.town, grid: f.grid, ground: (c) => f.groundAt(c), ways }).values())
        for (const q of spans) {
          expect(Number.isFinite(q.z0) && Number.isFinite(q.z1)).toBe(true);
          if (q.x >= 0 && q.y >= 0 && q.x < W && q.y < H) top[q.y * W + q.x] = Math.max(top[q.y * W + q.x], q.z1);
        }
      return top;
    };
    const reach = (top: Float64Array, from: number) => {
      const seen = new Uint8Array(W * H);
      seen[from] = 1;
      const q = [from];
      while (q.length) {
        const i = q.pop()!;
        for (let k = 0; k < 6; k++) {
          const [x, y] = hexNbr(i % W, Math.floor(i / W), k);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const j = y * W + x;
          const dz = top[j] - top[i];
          if (seen[j] || dz > 1.1 || dz < -2.6) continue;
          seen[j] = 1;
          q.push(j);
        }
      }
      return seen;
    };
    const wallTop = f.town.floorZ(st.wall, 0) + LEVEL_H;
    // the wall-walk: the band's columns at the wall's top in a wall cell far from the stair
    const far = [...ring].sort((a, b) => Math.hypot(...sub(f.centre(b), f.centre(st.wall))) - Math.hypot(...sub(f.centre(a), f.centre(st.wall))))[0];
    const start = f.grid.columns[st.foot][0];
    for (const [label, ways, want] of [['with the stair', w, true], ['without it', noWays(f.grid.count), false]] as const) {
      const top = tops(ways);
      const seen = reach(top, start);
      const onWalk = f.grid.columns[far].filter((c) => Math.abs(top[c] - wallTop) < 0.01);
      expect(onWalk.length, label).toBeGreaterThan(0);
      expect(onWalk.some((c) => seen[c] === 1), label).toBe(want);
    }
  });

  it('squares are paved whole (roads a lane wide: lanes.test), the stair drawn as steps', () => {
    const f = fortress();
    walled(f);
    const w = f.ways();
    const p = fortressPieces({ plan: f.plan, town: f.town, grid: f.grid, ground: () => GROUND, zOff: 0, ways: w });
    const bare = fortressPieces({ plan: f.plan, town: f.town, grid: f.grid, ground: () => GROUND, zOff: 0, ways: noWays(f.grid.count) });
    const lib = library();
    const count = (q: typeof p, name: string) => {
      let n = 0;
      for (let i = 0; i < q.count; i++) if (lib.modules[q.module[i]].name === name) n++;
      return n;
    };
    // (round 128f) a road's cell isn't paved whole any more: only the squares (the courtyards' paved either way)
    let squares = 0;
    for (let c = 0; c < f.grid.count; c++) if (w.way[c] === WAY_SQUARE) squares++;
    expect(count(p, 'pave') - count(bare, 'pave')).toBeLessThanOrEqual(squares);
    expect([...w.way].filter((x) => x === WAY_ROAD).length).toBeGreaterThan(squares);
    expect(count(p, 'rampart')).toBeGreaterThan(count(bare, 'rampart') + 6 * w.stairs.length);
  });
});

function sub(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}
