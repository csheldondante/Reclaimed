// (round 128p, DA-A13) Routes (agents/routes.ts): a town's route net from its edge network and the routes over it —
// shared per group and first node; a unit already on a goal's last leg goes straight there; units walk the ground (the
// drawn paths the buildings stand back from, open ground), never through a building nor along its wall.
import { describe, expect, it } from 'vitest';
import { QuadGrid } from '../../src/build/quadgrid';
import { TownPlan } from '../../src/build/plan';
import { DEFS } from '../../src/fortress/defs';
import { edgeNetOf } from '../../src/build/edgenet';
import { Router, routeNetOf, RouteNet } from '../../src/agents/routes';

function squares(n: number, S = 4): QuadGrid {
  const verts: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * S, j * S);
  const quads: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) quads.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return new QuadGrid(Math.ceil(n * S) + 2, Math.ceil((n * S) / 0.866) + 2, verts, quads);
}

const N = 9;
const cell = (i: number, j: number) => i + j * N;

function town(build: (plan: TownPlan) => void) {
  const grid = squares(N);
  const plan = new TownPlan(grid, DEFS);
  build(plan);
  const net = edgeNetOf({ plan, grid, floor: () => 0 }, { ground: () => 0, wet: () => false, centre: [2, 2], stores: [2, 2] });
  const rn = routeNetOf({ grid, plan }, net, () => 0, () => null);
  return { grid, plan, net, rn };
}

/** the route's points, as [x, y] */
const pts = (r: Router, id: number) => {
  const p = r.made[id].xyzl;
  const out: [number, number][] = [];
  for (let i = 0; i < p.length; i += 4) out.push([p[i], p[i + 1]]);
  return out;
};

describe('the route net', () => {
  it('has no edge along a building no path was drawn by, and a building only at its door', () => {
    const { grid, plan, net, rn } = town((p) => {
      p.place('house', [[cell(4, 4), 0]]);
      p.place('house', [[cell(6, 6), 0]]);
    });
    const h = plan.structureAt(cell(4, 4))!;
    // (the house's sides: only the drawn one — its lane — is in the net)
    const inNet = (a: number, b: number) => {
      for (let k = rn.start[a]; k < rn.start[a] + rn.count[a]; k++) if (rn.adj[k * 2] === b) return true;
      return false;
    };
    for (let s = 0; s < 4; s++) {
      const e = net.edgeOf[cell(4, 4) * 4 + s];
      expect(inNet(net.ends[e * 2], net.ends[e * 2 + 1]), `side ${s}`).toBe(!!net.kind[e]);
    }
    // (its node: one, at the middle of its door, joined to that edge's ends)
    const nodes = [...Array(rn.nodes).keys()].filter((v) => rn.building[v] === h.id);
    expect(nodes.length).toBe(1);
    const d = net.door.get(h.id)!;
    const mx = (grid.verts[net.ends[d * 2] * 2] + grid.verts[net.ends[d * 2 + 1] * 2]) / 2;
    expect(rn.xyz[nodes[0] * 3]).toBeCloseTo(mx);
  });
});

describe('routes', () => {
  it('a unit goes round a building, not through it (a structure node is a route end only)', () => {
    // (a wall of houses across the town's middle but for its ends: the way from below to above goes round)
    const { plan, net, rn } = town((p) => {
      for (let i = 1; i < N - 1; i++) p.place('house', [[cell(i, 4), 0]]);
    });
    void plan;
    void net;
    const R = new Router(rn, () => 0);
    expect(R.setGoals(1, [[18, 34]], 6)).toBe(true);
    const r = R.routeFrom(1, 18, 2)!;
    const p = pts(R, r.route);
    // (it leaves the middle column: out to an end of the row and back)
    expect(Math.max(...p.map(([x]) => Math.abs(x - 18)))).toBeGreaterThan(10);
    // (no point inside a house's cell: the row of houses spans y 16..20, x 4..32)
    for (const [x, y] of p) expect(x > 4.5 && x < 31.5 && y > 16.5 && y < 19.5, `${x},${y}`).toBe(false);
  });

  it('two units of a group joining at one node share its route; another group gets its own; each knows its group', () => {
    const { rn } = town(() => {});
    const R = new Router(rn, () => 0);
    R.setGoals(1, [[30, 30]], 6);
    R.setGoals(2, [[30, 30]], 6);
    const a = R.routeFrom(1, 4.2, 4.1)!;
    const b = R.routeFrom(1, 3.9, 3.8)!;
    const c = R.routeFrom(2, 4.2, 4.1)!;
    expect(a.route).toBe(b.route);
    expect(c.route).not.toBe(a.route);
    expect(R.groupOf[a.route]).toBe(1);
    expect(R.groupOf[c.route]).toBe(2);
  });

  it("a unit on a goal's last leg (no farther from it than its node) goes straight to it: a route of one point", () => {
    const { rn } = town(() => {});
    const R = new Router(rn, () => 0);
    // (the goal 2 m off the node at (12, 12): a unit 0.5 m from it is on its last leg)
    R.setGoals(1, [[12, 14]], 6);
    const r = R.routeFrom(1, 12.3, 14.4)!;
    expect(pts(R, r.route)).toEqual([[12, 14]]);
    expect(R.made[r.route].length).toBe(0);
    // (one farther out walks to the net first)
    const far = R.routeFrom(1, 20, 20)!;
    expect(pts(R, far.route).length).toBeGreaterThan(1);
  });

  it('a net built by hand (the GPU tests): its nodes and edges as given, no structures', () => {
    const rn = new RouteNet([0, 0, 0, 4, 0, 0], [[0, 1, 4]]);
    expect(rn.nodes).toBe(2);
    expect([...rn.building]).toEqual([-1, -1]);
  });
});
