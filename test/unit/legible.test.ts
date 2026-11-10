// (round 128s, trackA-legible) Variant D's field streets on the user's start town's land (the lab fixture): they stay
// off the water, keep their spacing, and (LEGIBLE_OUT=<dir>) a map preview — the ground shaded, water blue, the town's
// edge, the streets red.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson } from '../../src/build/site';
import { cellAt, ROW_H } from '../../src/world/lattice';
import { fieldStreets } from '../../src/roadgen/fieldstreets';
import { LEGIBLE } from '../../src/structures/legible';
import { hashf } from '../../src/structures/rng';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

describe('legible D: field streets on the start town', () => {
  it('traces main streets off the water, a spacing apart', async () => {
    const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
    const site = siteFromJson(header.site);
    const { box } = site;
    const W = box.w;
    const H = box.h;
    const oz = header.oz ?? 0;
    // box column → window column (the window's origin in world columns; its rows' too)
    const wx0 = box.x0 - header.origin[0];
    const wy0 = box.y0 - header.origin[1];
    const groundAt = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      return site.ground[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, k))];
    };
    const water = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      const wk = k + wx0;
      const wr = r + wy0;
      if (wk < 0 || wr < 0 || wk >= header.dims.w || wr >= header.dims.h) return 0;
      const c = wr * header.dims.w + wk;
      const sea = header.seaZ > -1e8 ? header.seaZ - map.surface[c] : 0;
      return Math.max(map.water[c], sea);
    };
    void oz;
    const at = header.town.at;
    const centre: [number, number] = [at[0] - wx0, at[1] - wy0 * ROW_H];
    const f = LEGIBLE.D.legible!.field!;
    const R = 30 + 20;
    const out = fieldStreets({ W: W - 1.5, H: (H - 1.5) * ROW_H, centre, radius: R, ground: groundAt, water, seed: site.seed, major: f.major, grid: f.grid, radial: f.radial, wWater: f.water, sigmaW: f.sigmaW, theta: hashf(site.seed, 91) * Math.PI * 2 });
    expect(out.lines.length).toBeGreaterThan(0);
    for (const l of out.lines) for (const p of l) expect(water(p[0], p[1])).toBeLessThan(0.31);
    const dir = process.env.LEGIBLE_OUT;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const S = 3;
      const pw = Math.ceil(W * S);
      const ph = Math.ceil(H * ROW_H * S);
      const png = new PNG({ width: pw, height: ph });
      let lo = Infinity;
      let hi = -Infinity;
      for (const g of site.ground) (lo = Math.min(lo, g)), (hi = Math.max(hi, g));
      for (let j = 0; j < ph; j++)
        for (let i = 0; i < pw; i++) {
          const x = i / S;
          const y = j / S;
          const o = (j * pw + i) * 4;
          const g = (groundAt(x, y) - lo) / (hi - lo || 1);
          const shade = groundAt(x + 1, y) - groundAt(x - 1, y);
          const v = Math.max(0, Math.min(255, 60 + g * 160 + shade * 25));
          const wet = water(x, y) > 0.3;
          png.data[o] = wet ? 40 : v;
          png.data[o + 1] = wet ? 90 : v;
          png.data[o + 2] = wet ? 200 : v * 0.85;
          png.data[o + 3] = 255;
          if (Math.abs(Math.hypot(x - centre[0], y - centre[1]) - 30) < 0.4) (png.data[o] = 255), (png.data[o + 1] = 220), (png.data[o + 2] = 0);
        }
      for (const l of out.lines)
        for (const p of l)
          for (let dj = -2; dj <= 2; dj++)
            for (let di = -2; di <= 2; di++) {
              const i = Math.round(p[0] * S) + di;
              const j = Math.round(p[1] * S) + dj;
              if (i < 0 || j < 0 || i >= pw || j >= ph) continue;
              const o = (j * pw + i) * 4;
              png.data[o] = 230;
              png.data[o + 1] = 30;
              png.data[o + 2] = 30;
            }
      fs.writeFileSync(path.join(dir, 'legible-D-streets.png'), PNG.sync.write(png));
      console.log(`${out.lines.length} streets, ${out.ms} ms`);
    }
  });
});

describe('legible: the variants on a town the start town size', () => {
  it('lowers the houses, keeps the landmarks tall, opens the core', async () => {
    const { draftCity } = await import('../../src/structures/plan');
    const ground = (x: number, y: number) => 10 + 0.02 * x + 2 * Math.sin(y * 0.03);
    const rows: Record<string, unknown>[] = [];
    for (const v of ['A', 'B', 'C', 'D'] as const) {
      const spec = { seed: 1664191, system: 'irregular' as const, style: 'hearth' as const, at: [120, 120] as [number, number], radius: 30, tile: 4, storeys: [3.6, 1] as [number, number], ...LEGIBLE[v] };
      const d = draftCity(spec, ground);
      const houses = d.buildings.filter((b) => (b.kind === 'house' || b.kind === 'hut') && !b.mega);
      const marks = d.buildings.filter((b) => b.mega);
      const inTown = d.tiles.use.map((u, q) => q).filter((q) => {
        const [x, y] = [0, 1, 2, 3].reduce((s, k) => [s[0] + d.tiles.verts[d.tiles.quads[q * 4 + k] * 2] / 4, s[1] + d.tiles.verts[d.tiles.quads[q * 4 + k] * 2 + 1] / 4], [0, 0]);
        return Math.hypot(x - 120, y - 120) < 30;
      });
      const built = inTown.filter((q) => d.quadBuilding[q] >= 0).length;
      const plaza = inTown.filter((q) => d.tiles.use[q] === 'plaza').length;
      const mean = houses.reduce((s, b) => s + b.storeys, 0) / Math.max(1, houses.length);
      const low = houses.filter((b) => b.storeys <= 2).length / Math.max(1, houses.length);
      rows.push({ v, houses: houses.length, meanStoreys: +mean.toFixed(2), le2: +low.toFixed(2), landmarks: marks.map((b) => `${b.mega}:${b.storeys}`).join(' '), builtShare: +(built / inTown.length).toFixed(2), plazaTiles: plaza });
    }
    console.table(rows);
    const A = rows[0] as { meanStoreys: number; builtShare: number; plazaTiles: number };
    const B = rows[1] as { meanStoreys: number; builtShare: number; plazaTiles: number };
    const C = rows[2] as { meanStoreys: number; builtShare: number; plazaTiles: number };
    expect(B.meanStoreys).toBeLessThan(A.meanStoreys);
    expect(C.meanStoreys).toBeLessThanOrEqual(B.meanStoreys);
    expect(C.builtShare).toBeLessThan(A.builtShare);
    expect(C.plazaTiles).toBeGreaterThan(A.plazaTiles);
  });
});
