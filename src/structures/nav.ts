// Baked navigation (the user, round 117: "bake paths into the tiles we generate so agents can interact with them.
// Taking elevators, stairs, walking on ramparts"; round 104: paths, not fields). A graph over the plan: where agents can
// stand (streets, plazas, yards, each storey of each building, balconies, rampart walks, tower tops) and how they get
// between them (walk, stairs, a door, a gate, a lift). Agents (the inhabitants track) path on it; the play track reads
// it for where a hero can climb. Its own representation: it never reads the pieces or the columns.
import type { CityPlan, NavGraph, NavLink, NavLinkKind, NavNode, NavSurface, V3 } from '../api/contracts/structures';
import { quadCentre, quadCorners } from './tiles/builder';
import { resample } from './linear';

export function bakeNav(plan: CityPlan, adj: Int32Array): NavGraph {
  const t = plan.tiles;
  const nq = t.use.length;
  const nodes: NavNode[] = [];
  const links: NavLink[] = [];
  const node = (at: V3, surface: NavSurface, building: number) => {
    nodes.push({ id: nodes.length, at, surface, building });
    return nodes.length - 1;
  };
  const link = (a: number, b: number, kind: NavLinkKind, cost?: number) => {
    const p = nodes[a].at;
    const q = nodes[b].at;
    links.push({ a, b, kind, cost: cost ?? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) });
  };
  const groundAt = (q: number) => {
    let z = 0;
    for (let k = 0; k < 4; k++) z += plan.ground[t.quads[q * 4 + k]];
    return z / 4;
  };

  // ---- the ground: every open tile (streets, the plaza, yards, the gates' passages)
  const outdoor = new Int32Array(nq).fill(-1);
  const surfaceOf: Partial<Record<string, NavSurface>> = { street: 'street', plaza: 'plaza', yard: 'ground', gate: 'street', field: 'ground', orchard: 'ground', pasture: 'ground' };
  for (let q = 0; q < nq; q++) {
    const s = surfaceOf[t.use[q]];
    if (!s) continue;
    const [x, y] = quadCentre(t, q);
    outdoor[q] = node([x, y, groundAt(q) + (s === 'street' || s === 'plaza' ? 0.12 : 0)], s, -1);
  }
  // (open tiles touching at a vertex are linked, not only across a side: the tile systems leave T-junctions where
  // radial rings double and Voronoi bands meet plots, and a diagonal step across open ground is a step anyone takes)
  const atVert = new Map<number, number[]>();
  for (let q = 0; q < nq; q++) if (outdoor[q] >= 0) for (let k = 0; k < 4; k++) (atVert.get(t.quads[q * 4 + k]) ?? atVert.set(t.quads[q * 4 + k], []).get(t.quads[q * 4 + k])!).push(q);
  const linked = new Set<number>();
  for (const qs of atVert.values())
    for (let i = 0; i < qs.length; i++)
      for (let j = i + 1; j < qs.length; j++) {
        const a = Math.min(qs[i], qs[j]);
        const b = Math.max(qs[i], qs[j]);
        if (linked.has(a * nq + b)) continue;
        linked.add(a * nq + b);
        link(outdoor[a], outdoor[b], t.use[a] === 'gate' || t.use[b] === 'gate' ? 'gate' : 'walk');
      }
  // (T-junctions: a tile's corner lying on another's side links them too — found by position, centimetres)
  const byPos = new Map<string, number>();
  for (const v of atVert.keys()) byPos.set(`${Math.round(t.verts[v * 2] * 100)},${Math.round(t.verts[v * 2 + 1] * 100)}`, v);
  for (let q = 0; q < nq; q++) {
    if (outdoor[q] < 0) continue;
    for (let s = 0; s < 4; s++) {
      const n = adj[q * 4 + s];
      if (n >= 0) continue;
      const a = t.quads[q * 4 + s];
      const b = t.quads[q * 4 + ((s + 1) % 4)];
      const mx = (t.verts[a * 2] + t.verts[b * 2]) / 2;
      const my = (t.verts[a * 2 + 1] + t.verts[b * 2 + 1]) / 2;
      const v = byPos.get(`${Math.round(mx * 100)},${Math.round(my * 100)}`);
      if (v === undefined) continue;
      {
        const qs = atVert.get(v)!;
        for (const o of qs) {
          const lo = Math.min(o, q);
          const hi = Math.max(o, q);
          if (o === q || linked.has(lo * nq + hi)) continue;
          linked.add(lo * nq + hi);
          link(outdoor[lo], outdoor[hi], 'walk');
        }
      }
    }
  }

  // ---- buildings: a node a storey, stairs between, doors to the ground outside, balconies off their storey
  const levelNode = new Map<string, number>();
  for (const b of plan.buildings) {
    let x = 0;
    let y = 0;
    let top = 0;
    for (const q of b.quads) {
      const [cx, cy] = quadCentre(t, q);
      x += cx;
      y += cy;
      top = Math.max(top, Math.round((plan.quadTop[q] - b.base) / b.storeyH));
    }
    x /= b.quads.length;
    y /= b.quads.length;
    if (b.mega) {
      // a landmark: its foot and its top — a tower's by a lift (Bulwark's lifts; stairs would wind round inside), a
      // domed temple's gallery by stairs — a door onto the open ground beside it
      const foot = node([x, y, b.base + 0.05], 'floor', b.id);
      const crown = node([x, y, b.base + top * b.storeyH], b.mega === 'tower' ? 'roof' : 'floor', b.id);
      link(foot, crown, b.mega === 'tower' ? 'lift' : 'stairs', top * b.storeyH * (b.mega === 'tower' ? 1 : 2));
      levelNode.set(`${b.id},0`, foot);
      let door = false;
      for (const q of b.quads)
        for (let s = 0; s < 4 && !door; s++) {
          const n = adj[q * 4 + s];
          if (n >= 0 && outdoor[n] >= 0) {
            link(foot, outdoor[n], 'door');
            door = true;
          }
        }
      continue;
    }
    let below = -1;
    for (let l = 0; l < top; l++) {
      const id = node([x, y, b.base + l * b.storeyH + 0.05], 'floor', b.id);
      levelNode.set(`${b.id},${l}`, id);
      if (below >= 0) link(below, id, 'stairs', b.storeyH * 2);
      below = id;
    }
  }
  for (const f of plan.facades) {
    if (f.kind !== 'door' && f.kind !== 'balcony') continue;
    const inside = levelNode.get(`${f.building},${f.level}`);
    if (inside === undefined) continue;
    const p = quadCorners(t, f.quad);
    const a = p[f.side];
    const c = p[(f.side + 1) % 4];
    const mx = (a[0] + c[0]) / 2;
    const my = (a[1] + c[1]) / 2;
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    // outward: the right of the side (the quads run counter-clockwise)
    const ox = (c[1] - a[1]) / L;
    const oy = -(c[0] - a[0]) / L;
    if (f.kind === 'door') {
      const n = adj[f.quad * 4 + f.side];
      const step = node([mx + ox * 0.4, my + oy * 0.4, f.z0], 'ground', -1);
      link(inside, step, 'door');
      if (n >= 0 && outdoor[n] >= 0) link(step, outdoor[n], 'walk');
      else {
        // (no open tile across the side — a T-junction where rings double, or a neighbour's house: the nearest open
        // ground within a few metres; none, and the door opens onto nothing walkable: the planner's to avoid)
        let best = -1;
        let bd = 6;
        for (let q = 0; q < nq; q++) {
          if (outdoor[q] < 0) continue;
          const o = nodes[outdoor[q]].at;
          const d = Math.hypot(o[0] - nodes[step].at[0], o[1] - nodes[step].at[1]);
          if (d < bd) {
            bd = d;
            best = outdoor[q];
          }
        }
        if (best >= 0) link(step, best, 'walk');
      }
    } else {
      const bal = node([mx + ox * 0.6, my + oy * 0.6, f.z0 + 0.05], 'floor', f.building);
      link(inside, bal, 'door');
    }
  }

  // ---- a keep (a mega feature on the plaza, no tiles of its own): a door to the plaza, a lift to its top
  for (const m of plan.megas) {
    if (m.kind !== 'keep') continue;
    const x = (m.frame[0][0] + m.frame[2][0]) / 2;
    const y = (m.frame[0][1] + m.frame[2][1]) / 2;
    const foot = node([x, y, m.z0], 'floor', -1);
    const crown = node([x, y, m.z1], 'roof', -1);
    link(foot, crown, 'lift', m.z1 - m.z0);
    let best = -1;
    let bd = Infinity;
    for (let q = 0; q < nq; q++) {
      if (outdoor[q] < 0) continue;
      const o = nodes[outdoor[q]].at;
      const d = Math.hypot(o[0] - x, o[1] - y);
      if (d < bd) {
        bd = d;
        best = outdoor[q];
      }
    }
    if (best >= 0) link(foot, best, 'door');
  }

  // ---- ramparts: a walk along the wall's top, stairs down at the gates
  const wallTop = new Int32Array(nq).fill(-1);
  for (let q = 0; q < nq; q++) {
    if (t.use[q] !== 'wall' && t.use[q] !== 'gate') continue;
    const [x, y] = quadCentre(t, q);
    wallTop[q] = node([x, y, plan.quadTop[q]], 'rampart', -1);
  }
  for (let q = 0; q < nq; q++) {
    if (wallTop[q] < 0) continue;
    for (let s = 0; s < 4; s++) {
      const n = adj[q * 4 + s];
      if (n > q && wallTop[n] >= 0) link(wallTop[q], wallTop[n], 'walk');
    }
    if (t.use[q] === 'gate')
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        if (n >= 0 && outdoor[n] >= 0 && t.use[n] !== 'gate') {
          link(wallTop[q], outdoor[n], 'stairs', (plan.quadTop[q] - nodes[outdoor[n]].at[2]) * 2);
        }
      }
  }
  // ---- linear features: a node every 4 m along roads, bridges and wall walks; a road's first node joins the town's
  // nearest open ground, a wall's ends come down by stairs
  const nearestOutdoor = (x: number, y: number, within: number) => {
    let best = -1;
    let bd = within;
    for (let q = 0; q < nq; q++) {
      if (outdoor[q] < 0) continue;
      const o = nodes[outdoor[q]].at;
      const d = Math.hypot(o[0] - x, o[1] - y);
      if (d < bd) {
        bd = d;
        best = outdoor[q];
      }
    }
    return best;
  };
  const ends: { at: V3; id: number }[] = [];
  for (const f of plan.linear) {
    // (fences and hedges are borders, not ways)
    if (f.kind === 'fence' || f.kind === 'hedge') continue;
    const S = resample(f, 4);
    if (S.length < 2) continue;
    const surface: NavSurface = f.kind === 'wall' ? 'rampart' : f.kind === 'bridge' ? 'bridge' : 'street';
    const ids = S.map((q) => node([q.p[0], q.p[1], q.p[2] + 0.1], surface, -1));
    for (let i = 0; i + 1 < ids.length; i++) link(ids[i], ids[i + 1], 'walk');
    if (f.closed) link(ids[ids.length - 1], ids[0], 'walk');
    if (f.kind === 'wall') {
      for (const e of f.closed ? [] : [0, ids.length - 1]) {
        const q = S[e];
        const foot = node([q.p[0], q.p[1], q.g], 'ground', -1);
        link(ids[e], foot, 'stairs', (q.p[2] - q.g) * 2);
        const o = nearestOutdoor(q.p[0], q.p[1], 14);
        if (o >= 0) link(foot, o, 'walk');
      }
    } else {
      // (the run's ends: joined to the town, or to the next run's end — a road meets its bridge)
      for (const e of [0, ids.length - 1]) {
        const at = nodes[ids[e]].at;
        const other = ends.find((x) => Math.hypot(x.at[0] - at[0], x.at[1] - at[1]) < 1);
        if (other) link(ids[e], other.id, 'walk');
        else ends.push({ at, id: ids[e] });
      }
      const o = nearestOutdoor(S[0].p[0], S[0].p[1], 10);
      if (o >= 0) link(ids[0], o, 'walk');
    }
  }
  return { nodes, links };
}

/** Shortest path on the graph (Dijkstra; small graphs): node ids from a to b, empty if none. */
export function navPath(g: NavGraph, a: number, b: number): number[] {
  const n = g.nodes.length;
  const out: { to: number; c: number }[][] = Array.from({ length: n }, () => []);
  for (const l of g.links) {
    out[l.a].push({ to: l.b, c: l.cost });
    out[l.b].push({ to: l.a, c: l.cost });
  }
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[a] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++)
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    if (u < 0 || u === b) break;
    done[u] = 1;
    for (const e of out[u])
      if (dist[u] + e.c < dist[e.to]) {
        dist[e.to] = dist[u] + e.c;
        prev[e.to] = u;
      }
  }
  if (!isFinite(dist[b])) return [];
  const path = [b];
  while (path[path.length - 1] !== a) path.push(prev[path[path.length - 1]]);
  return path.reverse();
}
