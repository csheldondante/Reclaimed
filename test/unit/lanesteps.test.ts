// (DA-A10, failing first) The user's start town's lanes over its land: no lane's ground rises or falls more than a
// walker's STEP within a metre along it. Today 16 of its 340 lane metres do (worst 3.3 m: a terrace's edge inside a
// cell — the ways only cross a cell's side where a walker steps), and the trips are placed over them (units.wgsl, round
// 128o's hack). `test.fails` until roads shape the land (BACKLOG DA-A10; DESIGN section 12: grading, cuts and fills,
// ramps).
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { Fortress } from '../../src/fortress/fortress';
import { cellAt } from '../../src/world/lattice';
import { STEP } from '../../src/agents/rules';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

describe("the start town's lanes over its land", { timeout: 30_000 }, () => {
  test.fails('has no step a walker cannot take along any lane', async () => {
    const { header } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
    const site = TownSite.fromData(siteFromJson(header.site));
    const heap = header.town.spots.find((s) => s.kind === 'pile')!.w;
    const f = new Fortress(site, { windowOrigin: () => header.origin, oz: () => header.oz! + header.zBase, dims: header.dims, stores: () => ({}), changed: () => {}, townHeap: () => [heap[0], heap[1]] });
    const { w, h } = f.box;
    const ground = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      return site.ground(Math.max(0, Math.min(h - 1, r)) * w + Math.max(0, Math.min(w - 1, k)));
    };
    let total = 0;
    let steep = 0;
    let worst = 0;
    const where: string[] = [];
    for (const s of f.lanes().segs) {
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      let prev = ground(s.a[0], s.a[1]);
      for (let t = 1; t <= L; t += 1) {
        const x = s.a[0] + ((s.b[0] - s.a[0]) * t) / L;
        const y = s.a[1] + ((s.b[1] - s.a[1]) * t) / L;
        const g = ground(x, y);
        total++;
        const d = Math.abs(g - prev);
        if (d > STEP) {
          steep++;
          worst = Math.max(worst, d);
          if (where.length < 12) where.push(`${x.toFixed(0)},${y.toFixed(0)}: ${d.toFixed(2)}`);
        }
        prev = g;
      }
    }
    expect(total).toBeGreaterThan(300);
    expect({ steep, worst: +worst.toFixed(2), where }).toEqual({ steep: 0, worst: 0, where: [] });
  });
});
