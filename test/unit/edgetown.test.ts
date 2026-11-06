// (round 128p, DA-A13 step 1) The edge paths and reach on the user's start town (data/lab/town.rclt) as generated:
// what the four cuts leave out, measured; EDGE_OUT=<dir> writes the map preview.
import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { cellAt, ROW_H } from '../../src/world/lattice';
import { DEEP } from '../../src/agents/rules';
import { edgeNetOf } from '../../src/build/edgenet';
import { edgePreview } from '../support/edgepreview';
import { layoutTownRoads } from '../../src/build/townroads';
import { typeIndex } from '../../src/build/plan';

it("the start town's edge paths and reach", async () => {
  const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');
  const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
  const site = TownSite.fromData(siteFromJson(header.site));
  const { box } = site;
  const [ox, oy] = header.origin;
  const W = header.dims.w;
  const wet = (x: number, y: number) => {
    const [k, r] = cellAt(x, y);
    const col = (r + box.y0 - oy) * W + (k + box.x0 - ox);
    return col >= 0 && col < map.water.length && map.water[col] > DEEP;
  };
  const toBox = (q: readonly number[]): [number, number] => [q[0] - (box.x0 - ox), q[1] - (box.y0 - oy) * ROW_H];
  const centre = toBox(header.town.at);
  const pile =
    header.town.spots.find((s) => s.kind === 'pile' && s.what !== 'log') ??
    header.town.spots.find((s) => s.kind === 'pile')!;
  const net = edgeNetOf(
    { plan: site.plan, grid: site.grid, floor: (c) => site.town.base[c] },
    {
      ground: (x, y) => site.groundAt(x, y),
      wet,
      centre,
      stores: toBox(pile.w),
      spokes: 5,
      spokeAngle: 0.4,
      roadsOut: site.plan.layout.linear
        .filter((f) => f.kind === 'road')
        .map((f) => f.points.map((q) => [q[0], q[1]] as [number, number])),
    },
  );
  const byWhy: Record<string, number> = {};
  for (const o of net.reach.out) byWhy[o.why] = (byWhy[o.why] ?? 0) + 1;
  const report = {
    ...net.reach,
    out: undefined,
    outByWhy: byWhy,
    outTypes: net.reach.out.map((o) => `${o.type}:${o.why}`),
  };
  console.log(JSON.stringify(report));
  expect(net.reach.structures).toBeGreaterThan(50);
  const out = process.env.EDGE_OUT;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    const R = 95;
    const img = edgePreview(site, net, wet, [centre[0] - R, centre[1] - R, centre[0] + R, centre[1] + R], 4);
    const png = new PNG({ width: img.w, height: img.h });
    png.data = Buffer.from(img.data);
    fs.writeFileSync(path.join(out, 'edges-town.png'), PNG.sync.write(png));
    fs.writeFileSync(path.join(out, 'edges-town.json'), JSON.stringify(report, null, 1));
  }
});

it("the start town's roads laid (the hybrid): radial relax, curve spokes, a drawn road, a far lumber mill, terraces", async () => {
  const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');
  const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
  const site = TownSite.fromData(siteFromJson(header.site));
  const { box } = site;
  const [ox, oy] = header.origin;
  const W = header.dims.w;
  const wet = (x: number, y: number) => {
    const [k, r] = cellAt(x, y);
    const col = (r + box.y0 - oy) * W + (k + box.x0 - ox);
    return col >= 0 && col < map.water.length && map.water[col] > DEEP;
  };
  const toBox = (q: readonly number[]): [number, number] => [q[0] - (box.x0 - ox), q[1] - (box.y0 - oy) * ROW_H];
  const centre = toBox(header.town.at);
  const pile =
    header.town.spots.find((s) => s.kind === 'pile' && s.what !== 'log') ??
    header.town.spots.find((s) => s.kind === 'pile')!;
  let R = 0;
  for (const st of site.plan.structures())
    for (const c of st.cells.keys())
      R = Math.max(R, Math.hypot(site.grid.centre(c)[0] - centre[0], site.grid.centre(c)[1] - centre[1]));
  // a lumber mill far out: the first dry, free cell 30 m past the town to the south-east
  let mill = -1;
  for (let r = R + 30; r < R + 80 && mill < 0; r += 2) {
    const p: [number, number] = [centre[0] + r * Math.cos(-0.9), centre[1] + r * Math.sin(-0.9)];
    const c = site.grid.cellAtWorld(p[0], p[1]);
    if (c >= 0 && !site.plan.structureAt(c) && !wet(p[0], p[1])) mill = c;
  }
  expect(mill).toBeGreaterThanOrEqual(0);
  const ms = site.plan.place('lumber', [[mill, 0]])!;
  site.town.add(mill, 0, ms.id, typeIndex('lumber'));
  const drawn: [number, number][] = [
    [centre[0] - 70, centre[1] + 40],
    [centre[0] - 20, centre[1] + 55],
    [centre[0] + 40, centre[1] + 60],
  ];
  const t0 = performance.now();
  const res = layoutTownRoads(site, {
    ground: (x, y) => site.groundAt(x, y),
    wet,
    centre,
    stores: toBox(pile.w),
    radial: { radius: R + 20, iters: 12 },
    spokes: 4,
    spokeAngle: 0.4,
    drawn: [drawn],
    far: 4,
  });
  const ms2 = performance.now() - t0;
  const report = {
    ms: +ms2.toFixed(1),
    phases: res.ms,
    structures: res.net.reach.structures,
    reached: res.net.reach.reached,
    out: res.net.reach.out.map((o) => `${o.type}:${o.why}`),
    curves: res.curves.map((c) => `${c.kind}:${c.pts.length}`),
    clipped: res.clipped.length,
    removed: res.removed.length,
    gates: res.gates,
    terraces: res.terraces.map((t) => `${t.how}:${t.dz.toFixed(1)}`),
    roadCells: res.net.roads.size,
    millReached: !res.net.reach.out.some((o) => o.id === ms.id),
    millDoor: res.net.door.has(ms.id),
  };
  console.log(JSON.stringify(report));
  expect(report.millReached).toBe(true);
  expect(res.curves.some((c) => c.kind === 'far')).toBe(true);
  const out = process.env.EDGE_OUT;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    const Rv = 110;
    const img = edgePreview(
      site,
      res.net,
      wet,
      [centre[0] - Rv, centre[1] - Rv, centre[0] + Rv, centre[1] + Rv],
      4,
      res.curves.map((c) => c.pts),
    );
    const png = new PNG({ width: img.w, height: img.h });
    png.data = Buffer.from(img.data);
    fs.writeFileSync(path.join(out, 'hybrid-town.png'), PNG.sync.write(png));
    fs.writeFileSync(path.join(out, 'hybrid-town.json'), JSON.stringify(report, null, 1));
  }
});
