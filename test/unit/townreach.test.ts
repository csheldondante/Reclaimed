// (DA-A3, round 128o) Reach as an invariant on the user's start town (data/lab/town.rclt): every block still to build
// and every structure's way in are reached from the stores, judged against the land (the reach's CPU reference,
// fortress/reach.ts CpuReach — the GPU's rule — over the fixture's columns, the plan's solid as built).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { Fortress } from '../../src/fortress/fortress';
import { CpuReach, type ReachColumns } from '../../src/fortress/reach';
import { MAT } from '../../src/world/materials';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

async function startTown() {
  const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
  const site = TownSite.fromData(siteFromJson(header.site));
  const { w, h } = header.dims;
  // (the land's own matter: the town's claims as the capture baked them left out — the plan's solid stands for them)
  const land = (m: number) => m !== MAT.Air && m !== MAT.Water && m !== MAT.External;
  const cols: ReachColumns = {
    w,
    h,
    runs: (x, y) => map.grid.col(x, y).filter((iv) => land(iv.mat)).map((iv) => [iv.z0, iv.z1] as [number, number]),
    water: (x, y) => map.water[y * w + x],
  };
  const f: Fortress = new Fortress(site, {
    windowOrigin: () => header.origin,
    oz: () => header.oz! + header.zBase,
    dims: header.dims,
    stores: () => ({}),
    changed: () => {},
    reach: new CpuReach(cols, site.box.w, site.box.h, () => f.offset()),
  });
  f.ready = true;
  return f;
}

describe("the user's start town is reached", () => {
  // (cell 1188: a house site walled in by houses; its stand is under its neighbour's passage — the reach read the roof
  // over the arch, the top surface, and never counted it)
  it('reaches every block still to build', async () => {
    const f = await startTown();
    const cells = f.todoCells();
    const r = (await f.probeReach(cells))!;
    expect(cells.filter((_, i) => !r[i]).map((c) => `${f.plan.typeAt(c)} at cell ${c}`)).toEqual([]);
  });

  it("reaches every structure's way in", async () => {
    const f = await startTown();
    const es = f.ways().entrances;
    const r = (await f.probeReach(es.map((e) => e.cell)))!;
    expect(es.filter((_, i) => !r[i]).map((e) => `${f.plan.structure(e.structure)!.type} ${e.structure} (${e.kind})`)).toEqual([]);
  });
});
