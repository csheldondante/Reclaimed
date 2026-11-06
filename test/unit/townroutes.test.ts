// (DA-A7's core, round 128o) The user's start town (data/lab/town.rclt) as the game generated it: its routes come from
// its structures' entrances (build/entrances.ts) and its ways, never through a building. The lab's fortressoutside on
// `town` found builders riding into a house and stopping 30 m short, and carriers stopping 3 m from the stores: the roads
// ran on cell borders flush with claimed buildings (lanes.ts before round 128o).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { entrancesOf, needsEntrance } from '../../src/build/entrances';
import { Fortress } from '../../src/fortress/fortress';
import { solidSpans } from '../../src/build/solid';
import { laneGraph } from '../../src/build/lanes';
import { nearestNode, reached } from '../../src/agents/roadgraph';
import { cellAt } from '../../src/world/lattice';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

async function startTown() {
  const { header } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
  const site = TownSite.fromData(siteFromJson(header.site));
  const heap = header.town.spots.find((s) => s.kind === 'pile')!.w;
  const f = new Fortress(site, {
    windowOrigin: () => header.origin,
    oz: () => header.oz! + header.zBase,
    dims: header.dims,
    stores: () => ({}),
    changed: () => {},
    townHeap: () => [heap[0], heap[1]],
  });
  return { site, f };
}

describe("the user's start town's routes", () => {
  it('gives every structure but its wall an entrance', async () => {
    const { f } = await startTown();
    const has = new Set(entrancesOf(f.plan, f.grid).map((e) => e.structure));
    const without = f.plan.structures().filter((s) => needsEntrance(s.type) && !has.has(s.id)).map((s) => `${s.type} ${s.id}`);
    expect(without).toEqual([]);
  });

  it('runs no route through a building: a lane enters a claimed column only in a gate or a passage', async () => {
    const { site, f } = await startTown();
    const { w, h } = f.box;
    // (a column claimed solid at a walker's height over its ground: a building's, as the claims put it in the world)
    const solid = new Map<number, number>();
    for (const [sid, spans] of solidSpans({ plan: f.plan, town: f.town, grid: f.grid, ground: (c) => site.ground(c), ways: f.ways() }))
      for (const q of spans) {
        const col = q.y * w + q.x;
        const g = site.ground(col);
        if (q.z0 <= g + 1 && q.z1 > g + 0.5) solid.set(col, sid);
      }
    const through = new Set([...f.ways().gates, ...f.ways().passages]);
    const hits: string[] = [];
    for (const s of f.lanes().segs) {
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      for (let t = 0; t <= L; t += 0.25) {
        const x = s.a[0] + ((s.b[0] - s.a[0]) * t) / L;
        const y = s.a[1] + ((s.b[1] - s.a[1]) * t) / L;
        const [k, r] = cellAt(x, y);
        if (k < 0 || r < 0 || k >= w || r >= h) continue;
        const sid = solid.get(r * w + k);
        if (sid === undefined) continue;
        const cell = f.grid.cellAtWorld(x, y);
        if (through.has(cell)) continue;
        hits.push(`${s.kind} at (${x.toFixed(1)}, ${y.toFixed(1)}) in the ${f.plan.structure(sid)?.type} ${sid}`);
        break;
      }
    }
    expect(hits).toEqual([]);
  });

  // (cell 1188: a house site with houses on three sides and the wall on the fourth had no side to stand at — generation
  // now cuts a passage through a neighbour, and a builder stands under its arch)
  it('gives every block still to build a side its builders stand at', async () => {
    const { f } = await startTown();
    const none = f.todoCells().filter((c) => !f.standsOf(c).length).map((c) => `${f.plan.typeAt(c)} at cell ${c}`);
    expect(none).toEqual([]);
  });

  it("joins every structure's entrance to the stores on the route graph", async () => {
    const { f } = await startTown();
    const graph = laneGraph(f.lanes());
    const stores = f.storesAt()!;
    const s0 = nearestNode(graph, ...f.toBox(stores[0], stores[1]));
    expect(s0.d).toBeLessThan(0.01);
    const net = reached(graph, s0.node);
    const off: string[] = [];
    for (const e of entrancesOf(f.plan, f.grid)) {
      const n = nearestNode(graph, ...f.grid.centre(e.out));
      if (n.d > 0.01 || !net.has(n.node)) off.push(`${f.plan.structure(e.structure)!.type} ${e.structure} (${e.kind}, ${n.d.toFixed(1)} m off)`);
    }
    expect(off).toEqual([]);
  });
});
