// (round 128m, townlab) The land fixtures (data/lab/site-*.rclt, the street lab's sites): the format round-trips, and
// each site decodes. (Switchover: the behaviour lab's old-town fixture, data/lab/town.rclt, is retired with the old
// towns — its test with it.)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture, encodeTownFixture, TOWN_FIXTURE_FORMAT } from '../../src/lab/townfixture';

describe('the land fixture', () => {
  it('round-trips a small capture (z shifted to its base, the sea with it)', async () => {
    const w = 16;
    const h = 16;
    const N = w * h;
    const cols = Array.from({ length: N }, (_, i) => [
      { z0: 0, z1: 90, mat: 1 },
      { z0: 90, z1: 100 + (i % 3), mat: 2 },
    ]);
    const bytes = await encodeTownFixture({
      header: { gen: 'g', link: '?x', capturedAt: 't', origin: [64, 128], riverWet: 1, seaZ: 95, zMaxWindow: 504, town: { id: 's1', name: 'A', at: [8, 7] } },
      w,
      h,
      cols,
      water: new Float32Array(N).fill(0.5),
      vegetation: new Float32Array(N).fill(2),
      waterSource: new Float32Array(N),
      riverFlow: new Float32Array(N * 4).fill(0.25),
    });
    const { header, map } = await decodeTownFixture(bytes);
    expect(header.format).toBe(TOWN_FIXTURE_FORMAT);
    expect(header.zBase).toBe(88);
    expect(header.seaZ).toBe(7);
    expect(header.dims).toEqual({ w, h, zMax: 64 });
    expect(map.grid.col(1, 0)).toEqual([
      { z0: 0, z1: 2, mat: 1, aux: 0 },
      { z0: 2, z1: 13, mat: 2, aux: 0 },
    ]);
    expect(map.surface[2]).toBe(14);
    expect(map.water[5]).toBe(0.5);
    expect(map.riverFlow![N * 4 - 1]).toBe(0.25);
  });

  it('the street lab’s sites decode, each a window of land with its town’s place in it', async () => {
    for (const site of ['muru', 'river', 'mountain', 'mesa', 'coast']) {
      const file = path.resolve(import.meta.dirname, `../../data/lab/site-${site}.rclt`);
      const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(file)));
      const { w, h } = header.dims;
      expect(w * h, site).toBe(map.surface.length);
      expect(header.town.name, site).toBe(site);
      const [x, y] = header.town.at;
      expect(x > 0 && x < w && y > 0 && y < h * (Math.sqrt(3) / 2), site).toBe(true);
    }
  }, 60_000);
});
