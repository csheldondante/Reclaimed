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
    return col >= 0 && col < map.water.length && (map.water[col] > DEEP || map.surface[col] < header.seaZ);
  };
  const toBox = (q: readonly number[]): [number, number] => [q[0] - (box.x0 - ox), q[1] - (box.y0 - oy) * ROW_H];
  const centre = toBox(header.town.at);
  const pile = header.town.spots.find((s) => s.kind === 'pile' && s.what !== 'log') ?? header.town.spots.find((s) => s.kind === 'pile')!;
  const net = edgeNetOf(
    { plan: site.plan, grid: site.grid, floor: (c) => site.town.base[c] },
    { ground: (x, y) => site.groundAt(x, y), wet, centre, stores: toBox(pile.w), spokes: 5, spokeAngle: 0.4, roadsOut: site.plan.layout.linear.filter((f) => f.kind === 'road').map((f) => f.points.map((q) => [q[0], q[1]] as [number, number])) },
  );
  const byWhy: Record<string, number> = {};
  for (const o of net.reach.out) byWhy[o.why] = (byWhy[o.why] ?? 0) + 1;
  const report = { ...net.reach, out: undefined, outByWhy: byWhy, outTypes: net.reach.out.map((o) => `${o.type}:${o.why}`) };
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
