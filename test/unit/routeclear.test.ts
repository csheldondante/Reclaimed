// (round 128p merge, unitsonground; BACKLOG DA-A18) The start town's drawn paths keep their clearance: no stretch of a
// route walk on a drawn path — a lane or main street on the grid's edges, a structure's door, a main road's curve — runs
// through a block's claimed columns (build/solid.ts). The riders are placed on these lines (shaders/routes.wgsl), so such
// a stretch stands a unit inside a building: the unitsonground lab gate's rider in the warehouse's corner by the stores
// (in onetown alone too, 1 of 3 runs, the same spot). `test.fails` until DA-A18 lands — two causes, measured here
// (24 walks of 6,939 through a block; 43 counting open ground, the road links and a wall):
//  - the claims test each cell's own drawn sides while the view moves a structure's corners from all of its sides
//    (edgeview.ts insetTiles), so a corner the view drew 3 m back stayed solid (the warehouse, vertex 4474);
//  - the corner of a cell across a path's turn stands on the path: only the cells beside a path stand back from it
//    (vertex 4476: the warehouse's corner on the turn round the main road's verge).
// The walks over open ground (undrawn edges between two open cells, a main road's links to the grid) and past walls are
// listed, not asserted.
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { cellAt } from '../../src/world/lattice';
import { relayRoads } from '../../src/build/townroads';
import { townRouteNet } from '../../src/agents/routes';
import { solidSpans } from '../../src/build/solid';

test.fails("no route walk on the start town's drawn paths runs through a building's columns", async () => {
  const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');
  const { header } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
  const site = TownSite.fromData(siteFromJson(header.site));
  const roads = relayRoads(site)!;
  const net = roads.net;
  const rn = townRouteNet(site, net);
  const spans = solidSpans({ plan: site.plan, town: site.town, grid: site.grid, ground: (col) => site.ground(col) });
  const W = site.box.w;
  const claim = new Map<number, { z0: number; z1: number; id: number }[]>();
  for (const [id, ss] of spans) for (const s of ss) (claim.get(s.y * W + s.x) ?? claim.set(s.y * W + s.x, []).get(s.y * W + s.x)!).push({ z0: s.z0, z1: s.z1, id });
  // (a unit's body: from just over its feet to its head)
  const inside = (x: number, y: number, z: number): number => {
    const [k, r] = cellAt(x, y);
    for (const s of claim.get(r * W + k) ?? []) if (s.z0 < z + 1.5 && s.z1 > z + 0.1) return s.id;
    return -1;
  };
  const nv = site.grid.verts.length / 2;
  const kindOf = new Map<string, number>();
  for (let e = 0; e < net.kind.length; e++) {
    const [a, b] = [net.ends[e * 2], net.ends[e * 2 + 1]];
    kindOf.set(`${Math.min(a, b)}:${Math.max(a, b)}`, net.kind[e]);
  }
  /** what a walk is: a drawn path, a door, a main road's curve — or open ground, a road's link to the grid */
  const walkOf = (v: number, w: number): 'path' | 'door' | 'road' | 'open' | 'link' => {
    if (rn.building[v] >= 0 || rn.building[w] >= 0) return 'door';
    if (v < nv && w < nv) return kindOf.get(`${Math.min(v, w)}:${Math.max(v, w)}`) ? 'path' : 'open';
    return v >= nv && w >= nv ? 'road' : 'link';
  };
  const bad: Record<string, string[]> = { path: [], door: [], road: [], open: [], link: [] };
  let walks = 0;
  for (let v = 0; v < rn.nodes; v++)
    for (let k = rn.start[v]; k < rn.start[v] + rn.count[v]; k++) {
      const w = rn.adj[k * 2];
      if (w < v) continue;
      walks++;
      const [ax, ay, az] = [rn.xyz[v * 3], rn.xyz[v * 3 + 1], rn.xyz[v * 3 + 2]];
      const [bx, by, bz] = [rn.xyz[w * 3], rn.xyz[w * 3 + 1], rn.xyz[w * 3 + 2]];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const id = inside(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        if (id < 0) continue;
        const st = site.plan.structure(id);
        bad[walkOf(v, w)].push(`${v} (${ax.toFixed(1)}, ${ay.toFixed(1)}) - ${w} (${bx.toFixed(1)}, ${by.toFixed(1)}) at ${t.toFixed(2)}: #${id} ${st?.type} ${st ? site.plan.defs[st.type].form : '?'}`);
        break;
      }
    }
  console.log(`${walks} walks; through a building: ${Object.entries(bad).map(([k, v]) => `${k} ${v.length}`).join(', ')}\n${Object.entries(bad).flatMap(([k, v]) => v.map((s) => `${k}: ${s}`)).join('\n')}`);
  // (the blocks' and the keep's: what stands back from the paths — a wall's band is drawn where the wall runs, and two
  // drawn paths along a wall's cell in the start town cross its band: reported, BACKLOG)
  const stands = (s: string) => / (block|keep)$/.test(s);
  expect([...bad.path, ...bad.door, ...bad.road].filter(stands)).toEqual([]);
});
