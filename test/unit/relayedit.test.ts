// (round 128p, DA-A13) An edit lays the roads again only where it touched (edgenet.ts EdgeNetPrev: the changed cells'
// edges, the touched structures' doors, the lanes the edit broke or orphaned; the rest kept). The coordinator: "Watch
// relayRoads' cost … make it incremental (only the area an edit touches)". Checked on the user's start town against the
// whole town laid again: the same structures reached, every lane joined to the network, and cheaper.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { Fortress } from '../../src/fortress/fortress';
import { edgeNetOf } from '../../src/build/edgenet';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

async function startTown() {
  const { header } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
  const site = TownSite.fromData(siteFromJson(header.site));
  const f = new Fortress(site, {
    windowOrigin: () => header.origin,
    oz: () => header.oz! + header.zBase,
    dims: header.dims,
    stores: () => ({}),
    changed: () => {},
  });
  f.ready = true;
  return { site, f };
}

/** the whole town's net laid from scratch on the site as it stands (no carry) */
function whole(site: TownSite) {
  const r = site.plan.layout.roads!;
  const deep = new Set(r.deep);
  return edgeNetOf(
    { plan: site.plan, grid: site.grid, floor: (c) => site.town.base[c] },
    { ground: (x, y) => site.groundAt(x, y), wet: (x, y) => deep.has(site.grid.cellAtWorld(x, y)), centre: r.centre, stores: r.stores, roads: r.verge, far: 4 },
  );
}

describe('an edit relays only what it touched', { timeout: 60_000 }, () => {
  it('placements and erases on the start town: the same reach as the whole town laid again, every lane joined', async () => {
    const { site, f } = await startTown();
    // (open cells round the stores, a few rings out: houses there, then some taken out again)
    const st = site.plan.layout.roads!.stores;
    const open: number[] = [];
    for (let c = 0; c < site.grid.count && open.length < 40; c++) {
      const [x, y] = site.grid.centre(c);
      if (site.plan.structureAt(c) || site.plan.layout.roads!.verge.includes(c) || site.plan.layout.roads!.deep.includes(c)) continue;
      const d = Math.hypot(x - st[0], y - st[1]);
      if (d > 20 && d < 70) open.push(c);
    }
    expect(open.length).toBeGreaterThan(20);
    const edits: number[] = [];
    let incMs = 0;
    let wholeMs = 0;
    let edits1 = 0;
    for (let i = 0; i < 24; i++) {
      const c = open[(i * 7) % open.length];
      if (i % 4 === 3 && edits.length) f.erase(edits.pop()!, 0);
      else if (!site.plan.structureAt(c) && f.paint(c, 0, 'house')) edits.push(c);
      const net = f.roads!.net;
      if (net.reach.relaid === 'edit') {
        edits1++;
        incMs += net.reach.ms;
      }
      const t0 = performance.now();
      const w = whole(site);
      wholeMs += performance.now() - t0;
      expect([...net.reach.reachedIds].sort((a, b) => a - b), `edit ${i}`).toEqual([...w.reach.reachedIds].sort((a, b) => a - b));
      expect(net.reach.out.map((o) => o.id)).toEqual(w.reach.out.map((o) => o.id));
      // (each lane ends on the network: the stores' component holds its door)
      for (const [id, d] of net.door) if (w.reach.reachedIds.has(id)) expect(net.reach.comp[net.ends[d * 2]], `lane of ${id}`).toBe(net.reach.storesRoot);
    }
    expect(edits1).toBeGreaterThan(12);
    // (cheaper than the whole town, per edit)
    expect(incMs / edits1).toBeLessThan(wholeMs / 24);
  });
});
