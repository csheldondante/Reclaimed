// Routes (round 128p, DA-A13; DESIGN section 12: "cached routes, like conveyor belts"; the user: "I expect units to
// share routes. They should be cached and parameterized so it is just a queue with dt interpolation"). Pure, the CPU's
// half (the GPU's: routeride.ts, shaders/routes.wgsl):
//  - RouteNet: a town's walkable network as a graph — its grid's vertices and the walkable edges between them (the paths
//    on the grid's edges: build/edgenet.ts; a drawn path cheaper than an edge no one drew, stairs dearer), its main roads'
//    curves (a point every few metres, a bridge's at its deck) joined to the vertices beside them, and each structure a
//    node at its door (a route's end, never a way through it: units walk the ground — the drawn paths the buildings
//    stand back from, open ground — not through walls). Made again when the
//    town's roads are (a relay).
//  - A group's goals (the stores, the houses, the farms) → a tree over the net toward the nearest goal (multi-source
//    Dijkstra): a route from any node is the walk down it, then straight to the goal. A route is keyed by its group and
//    its first node: every unit of the group joining there shares it (one copy of its points on the GPU).
// No unit is steered or searched for per tick: joining a route is an event (the unit's group changed), on the CPU, once.
import { CUT_WALL, PATH_LANE, PATH_MAIN, type EdgeNet } from '../build/edgenet';
import type { TownSite } from '../build/site';
import type { Ways } from '../build/ways';
import type { NavGraph } from '../api/contracts/structures';
import { LEVEL_H } from '../build/town';

type V2 = [number, number];

export interface RouteNetSite {
  grid: { count: number; verts: ArrayLike<number>; quads: ArrayLike<number> };
  plan: { structures(): { id: number; cells: Map<number, unknown> }[]; structureAt(c: number): unknown };
}

/** a route's points: x, y (the town's frame), z (world: the ground, a bridge's deck), the length along it to there */
export interface RoutePoints {
  xyzl: Float32Array;
  length: number;
}

export class RouteNet {
  /** per node x, y, z (world) */
  readonly xyz: Float32Array;
  /** CSR: per node its first edge and count in `adj` (node, cost) */
  readonly start: Uint32Array;
  readonly count: Uint32Array;
  readonly adj: Float64Array;
  readonly nodes: number;
  /** per node the structure it stands for (entered through its doors), -1: a place on the ground */
  readonly building: Int32Array;
  /** bumped per net: a route cached from an older one is stale */
  static made = 0;
  readonly id = ++RouteNet.made;

  constructor(xyz: number[], edges: [number, number, number][], building?: readonly number[]) {
    this.nodes = xyz.length / 3;
    this.xyz = Float32Array.from(xyz);
    this.building = new Int32Array(this.nodes).fill(-1);
    if (building) this.building.set(building);
    const deg = new Uint32Array(this.nodes);
    for (const [a, b] of edges) (deg[a]++, deg[b]++);
    this.start = new Uint32Array(this.nodes);
    let o = 0;
    for (let v = 0; v < this.nodes; v++) ((this.start[v] = o), (o += deg[v]));
    this.count = new Uint32Array(this.nodes);
    this.adj = new Float64Array(o * 2);
    for (const [a, b, c] of edges) {
      const ia = this.start[a] + this.count[a]++;
      this.adj[ia * 2] = b;
      this.adj[ia * 2 + 1] = c;
      const ib = this.start[b] + this.count[b]++;
      this.adj[ib * 2] = a;
      this.adj[ib * 2 + 1] = c;
    }
  }

  /** the node nearest (x, y) and how far */
  nearest(x: number, y: number): { node: number; d: number } {
    let node = -1;
    let d = Infinity;
    for (let v = 0; v < this.nodes; v++) {
      const dd = (this.xyz[v * 3] - x) ** 2 + (this.xyz[v * 3 + 1] - y) ** 2;
      if (dd < d) ((d = dd), (node = v));
    }
    return { node, d: Math.sqrt(d) };
  }

  /**
   * The tree toward the nearest of `goals` (nodes): per node the next node on the way (-1: a goal, or none) and the
   * cost to it (Infinity: no way).
   */
  treeTo(goals: readonly number[]): { next: Int32Array; cost: Float64Array } {
    const n = this.nodes;
    const cost = new Float64Array(n).fill(Infinity);
    const next = new Int32Array(n).fill(-1);
    const heap: [number, number][] = [];
    const push = (d: number, v: number) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (const g of goals) if (g >= 0) ((cost[g] = 0), push(0, g));
    const goal = new Set(goals);
    while (heap.length) {
      const [d, v] = pop();
      if (d > cost[v]) continue;
      // (a structure's node: reached — a unit in it starts there — but no way on through it)
      if (this.building[v] >= 0 && !goal.has(v)) continue;
      for (let k = this.start[v]; k < this.start[v] + this.count[v]; k++) {
        const w = this.adj[k * 2];
        const nd = d + this.adj[k * 2 + 1];
        if (nd < cost[w]) ((cost[w] = nd), (next[w] = v), push(nd, w));
      }
    }
    return { next, cost };
  }

  /** the route from node `from` down a tree to its goal, then straight to `goal` (its point), as points along it */
  walk(from: number, tree: { next: Int32Array; cost: Float64Array }, goal: (node: number) => [number, number, number]): RoutePoints | null {
    if (!Number.isFinite(tree.cost[from])) return null;
    const pts: number[] = [];
    let len = 0;
    const add = (x: number, y: number, z: number) => {
      const n = pts.length / 4;
      if (n) len += Math.hypot(x - pts[(n - 1) * 4], y - pts[(n - 1) * 4 + 1]);
      pts.push(x, y, z, len);
    };
    let v = from;
    for (let guard = 0; guard <= this.nodes; guard++) {
      add(this.xyz[v * 3], this.xyz[v * 3 + 1], this.xyz[v * 3 + 2]);
      if (tree.next[v] < 0) break;
      v = tree.next[v];
    }
    const [gx, gy, gz] = goal(v);
    add(gx, gy, gz);
    return { xyzl: Float32Array.from(pts), length: len };
  }
}

/** a drawn path's cost a metre against an edge no one drew (people keep to the streets); stairs dearer */
export const COST = { main: 0.5, lane: 0.7, open: 1, stairs: 1.6 } as const;

/**
 * A town's RouteNet from its edge network (build/edgenet.ts, as last laid: Fortress.roads) and its main roads' curves:
 * `ground(x, y)` world z; `deck(x, y)` a bridge's deck there (null: none).
 */
export function routeNetOf(site: RouteNetSite, net: EdgeNet, ground: (x: number, y: number) => number, deck: (x: number, y: number) => number | null): RouteNet {
  const { grid } = site;
  const nv = grid.verts.length / 2;
  const xyz: number[] = [];
  for (let v = 0; v < nv; v++) {
    const x = grid.verts[v * 2];
    const y = grid.verts[v * 2 + 1];
    xyz.push(x, y, ground(x, y));
  }
  const edges: [number, number, number][] = [];
  const building: number[] = new Array(nv).fill(-1);
  const ne = net.kind.length;
  // (a walk the units can make on the ground: a drawn path — the buildings stand back from it — or an edge with open ground
  // either side; never along a building's side no path was drawn by, where the walls stand on the edge)
  const built = (c: number) => c >= 0 && !!site.plan.structureAt(c);
  for (let e = 0; e < ne; e++) {
    if (net.inner[e] || net.cut[e]) continue;
    const k = net.kind[e];
    if (!k && (built(net.cells[e * 2]) || built(net.cells[e * 2 + 1]))) continue;
    const per = (k === PATH_MAIN ? COST.main : k === PATH_LANE ? COST.lane : COST.open) * (net.steep[e] ? COST.stairs : 1);
    edges.push([net.ends[e * 2], net.ends[e * 2 + 1], net.length[e] * per]);
  }
  // each structure a node at its door (the edge its lane leaves by: its middle) — a route's end, never passed through
  // (Router: a structure's node is only ever a route's first or last)
  for (const [id, e] of net.door) {
    if (net.cut[e] & CUT_WALL) continue;
    const a = net.ends[e * 2];
    const b = net.ends[e * 2 + 1];
    const x = (xyz[a * 3] + xyz[b * 3]) / 2;
    const y = (xyz[a * 3 + 1] + xyz[b * 3 + 1]) / 2;
    const s = xyz.length / 3;
    xyz.push(x, y, ground(x, y));
    building.push(id);
    for (const v of [a, b]) edges.push([s, v, Math.hypot(xyz[v * 3] - x, xyz[v * 3 + 1] - y)]);
  }
  // the main roads: a node every few metres along each curve, chained; each joined to the grid's vertices within its half
  // width and a little (where the curve crosses the grid, its edges meet it)
  const bins = new Map<number, number[]>();
  const B = 4;
  const key = (x: number, y: number) => Math.floor(x / B) * 100003 + Math.floor(y / B);
  for (let v = 0; v < nv; v++) {
    const k = key(xyz[v * 3], xyz[v * 3 + 1]);
    (bins.get(k) ?? bins.set(k, []).get(k)!).push(v);
  }
  const near = (x: number, y: number, r: number): number[] => {
    const out: number[] = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const v of bins.get((Math.floor(x / B) + i) * 100003 + Math.floor(y / B) + j) ?? [])
          if (Math.hypot(xyz[v * 3] - x, xyz[v * 3 + 1] - y) <= r) out.push(v);
    return out;
  };
  for (const c of net.curves) {
    let prev = -1;
    let px = 0;
    let py = 0;
    for (let i = 0; i < c.length; i++) {
      const [x, y] = c[i];
      if (prev >= 0 && i < c.length - 1 && Math.hypot(x - px, y - py) < 2) continue;
      const d = deck(x, y);
      const s = xyz.length / 3;
      xyz.push(x, y, d ?? ground(x, y));
      building.push(-1);
      if (prev >= 0) edges.push([prev, s, Math.hypot(x - px, y - py) * COST.main]);
      // (on a bridge: no way off it but its ends)
      if (d === null) for (const v of near(x, y, 2.6)) edges.push([s, v, Math.hypot(xyz[v * 3] - x, xyz[v * 3 + 1] - y)]);
      prev = s;
      px = x;
      py = y;
    }
  }
  return new RouteNet(xyz, edges, building);
}

/** where a town's main roads cross water: their bridges' decks (plan.layout.linear, of 'mainroad') — z there, or null */
export function deckOf(linear: readonly { of?: string; points: readonly (readonly number[])[] }[]): (x: number, y: number) => number | null {
  const bridges = linear.filter((f) => f.of === 'mainroad');
  return (x, y) => {
    for (const f of bridges)
      for (let i = 1; i < f.points.length; i++) {
        const a = f.points[i - 1];
        const b = f.points[i];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const L2 = ex * ex + ey * ey || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L2));
        if (Math.hypot(x - a[0] - ex * t, y - a[1] - ey * t) < 1.5) return a[2] + (b[2] - a[2]) * t;
      }
    return null;
  };
}

/** a town's RouteNet as its roads were last laid (townroads.ts TownRoads.net): on its ground, its bridges at their decks */
export function townRouteNet(site: TownSite, net: EdgeNet): RouteNet {
  return routeNetOf(site, net, (x, y) => site.groundAt(x, y) + 0.05, deckOf(site.plan.layout.linear));
}

/**
 * (round 128p) A town's nav graph (structures' NavGraph: the viewer's, the town plans') as a view of its RouteNet — one
 * network, the routes': each node a place on the ground (a street), each structure node its ground floor (entered by a
 * door), each edge a walk — and what only this graph carries: the wall-walks (a node a wall cell at its top, joined along
 * the wall) and the stairs from their foot up to them (ways.stairs: build/ways.ts). Box frame, world z.
 */
export function navOfRoutes(site: TownSite, rn: RouteNet, ways: Pick<Ways, 'stairs'>): NavGraph {
  const { grid, plan, town } = site;
  const nodes: NavGraph['nodes'] = [];
  const links: NavGraph['links'] = [];
  const link = (a: number, b: number, kind: NavGraph['links'][number]['kind']) => {
    const p = nodes[a].at;
    const q = nodes[b].at;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    links.push({ a, b, kind, cost: kind === 'stairs' ? d + Math.abs(p[2] - q[2]) : d });
  };
  for (let v = 0; v < rn.nodes; v++) {
    const id = rn.building[v];
    const x = rn.xyz[v * 3];
    const y = rn.xyz[v * 3 + 1];
    if (id < 0) nodes.push({ id: v, at: [x, y, rn.xyz[v * 3 + 2]], surface: 'street', building: -1 });
    else {
      const s = plan.structure(id);
      const c = s ? [...s.cells.keys()][0] : -1;
      nodes.push({ id: v, at: [x, y, c >= 0 ? town.floorZ(c, 0) + 0.05 : rn.xyz[v * 3 + 2]], surface: 'floor', building: id });
    }
  }
  for (let v = 0; v < rn.nodes; v++)
    for (let k = rn.start[v]; k < rn.start[v] + rn.count[v]; k++) {
      const w = rn.adj[k * 2];
      if (w > v) link(v, w, rn.building[v] >= 0 || rn.building[w] >= 0 ? 'door' : 'walk');
    }
  const walk = new Map<number, number>();
  for (const st of plan.structures()) {
    if (plan.defs[st.type].form !== 'wall') continue;
    for (const c of st.cells.keys()) {
      const [x, y] = grid.centre(c);
      walk.set(c, nodes.length);
      nodes.push({ id: nodes.length, at: [x, y, town.floorZ(c, Math.max(0, plan.top(c))) + LEVEL_H], surface: 'rampart', building: -1 });
    }
  }
  for (const [c, n] of walk)
    for (let e = 0; e < 4; e++) {
      const m = grid.nbr[c * 4 + e];
      if (m > c && walk.has(m)) link(n, walk.get(m)!, 'walk');
    }
  for (const st of ways.stairs) {
    const w = walk.get(st.wall);
    if (w === undefined) continue;
    // (its foot: the corner of the foot cell nearest the wall — on the ground the routes walk)
    const [wx, wy] = grid.centre(st.wall);
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const v = grid.quads[st.foot * 4 + k];
      const d = Math.hypot(grid.verts[v * 2] - wx, grid.verts[v * 2 + 1] - wy);
      if (d < bd) ((bd = d), (best = v));
    }
    if (best >= 0) link(best, w, 'stairs');
  }
  return { nodes, links };
}

/**
 * The routes of a town's groups: per group its goals and its tree; a route per (group, first node), its points once.
 * Made again (all routes stale) when the net is.
 */
export class Router {
  private trees = new Map<number, { goals: V2[]; nodes: number[]; tree: { next: Int32Array; cost: Float64Array } }>();
  private routes = new Map<string, number>();
  /** the routes made (their points: what the GPU's pool holds) */
  readonly made: RoutePoints[] = [];
  /** per route made, the group it was made for (routes.wgsl: a rider whose group isn't its route's is off it) */
  readonly groupOf: number[] = [];

  constructor(
    readonly net: RouteNet,
    private z: (x: number, y: number) => number,
  ) {}

  /** group `g`'s goals (the net's frame): its tree made again if they changed; false: none, or a goal off the net */
  setGoals(g: number, goals: readonly (readonly [number, number])[] | null, near: number): boolean {
    if (!goals || !goals.length) {
      this.trees.delete(g);
      return false;
    }
    const was = this.trees.get(g);
    if (was && was.goals.length === goals.length && was.goals.every((p, i) => p[0] === goals[i][0] && p[1] === goals[i][1])) return true;
    const nodes = goals.map((p) => this.net.nearest(p[0], p[1]));
    if (nodes.some((n) => n.d > near)) {
      this.trees.delete(g);
      return false;
    }
    this.trees.set(g, { goals: goals.map((p) => [p[0], p[1]]), nodes: nodes.map((n) => n.node), tree: this.net.treeTo(nodes.map((n) => n.node)) });
    for (const k of [...this.routes.keys()]) if (k.startsWith(`${g}:`)) this.routes.delete(k);
    return true;
  }

  riding(g: number): boolean {
    return this.trees.has(g);
  }

  /** every goal of the riding groups */
  goalPoints(): V2[] {
    return [...this.trees.values()].flatMap((t) => t.goals);
  }

  /**
   * The route group `g` takes from (x, y): its id (an index into `made`; a new one made if none starts at that node),
   * and the node it starts at. Null: the group doesn't ride, or no way.
   */
  routeFrom(g: number, x: number, y: number): { route: number; first: [number, number, number] } | null {
    const t = this.trees.get(g);
    if (!t) return null;
    // (on a goal's last leg already — no farther from it than the node it's reached from: straight to it, a route of one
    // point)
    for (let i = 0; i < t.goals.length; i++) {
      const [gx, gy] = t.goals[i];
      const v = t.nodes[i];
      if (Math.hypot(x - gx, y - gy) > Math.hypot(this.net.xyz[v * 3] - gx, this.net.xyz[v * 3 + 1] - gy)) continue;
      const k = `${g}:goal${i}`;
      let id = this.routes.get(k);
      if (id === undefined) {
        id = this.made.length;
        this.made.push({ xyzl: Float32Array.from([gx, gy, this.z(gx, gy), 0]), length: 0 });
        this.groupOf.push(g);
        this.routes.set(k, id);
      }
      const p = this.made[id].xyzl;
      return { route: id, first: [p[0], p[1], p[2]] };
    }
    const from = this.net.nearest(x, y).node;
    if (from < 0) return null;
    const k = `${g}:${from}`;
    let id = this.routes.get(k);
    if (id === undefined) {
      const pts = this.net.walk(from, t.tree, (v) => {
        const i = t.nodes.indexOf(v);
        const p = t.goals[Math.max(0, i)];
        return [p[0], p[1], this.z(p[0], p[1])];
      });
      if (!pts) return null;
      id = this.made.length;
      this.made.push(pts);
      this.groupOf.push(g);
      this.routes.set(k, id);
    }
    const p = this.made[id].xyzl;
    return { route: id, first: [p[0], p[1], p[2]] };
  }
}
