// (round 128m, townlab) The lab's town fixture (data/lab/town.rclt): it decodes, it's this land generator's (else it's
// stale: capture it again — node scripts/labtown.mjs capture), and it holds the user's town as the game had it.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture, encodeTownFixture, TOWN_FIXTURE_FORMAT } from '../../src/lab/townfixture';
import { GEN_VERSION } from '../../src/world/region-record';
import { LabTown } from '../../src/lab/town';

const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');

describe('the town fixture', () => {
  it('round-trips a small capture (z shifted to its base, the sea with it)', async () => {
    const w = 16;
    const h = 16;
    const N = w * h;
    const cols = Array.from({ length: N }, (_, i) => [
      { z0: 0, z1: 90, mat: 1 },
      { z0: 90, z1: 100 + (i % 3), mat: 2 },
    ]);
    const bytes = await encodeTownFixture({
      header: { gen: 'g', link: '?x', capturedAt: 't', origin: [64, 128], riverWet: 1, seaZ: 95, zMaxWindow: 504, town: { id: 's1', name: 'A', at: [8, 7], spots: [{ kind: 'pile', what: 'stone', at: [3, 4], w: [3, 4] }] } },
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

  it("is the user's start town, made by this land generator", async () => {
    const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
    // (stale: the land generator changed since it was captured — node scripts/labtown.mjs capture)
    expect(header.gen, 'data/lab/town.rclt is stale: capture it again (node scripts/labtown.mjs capture)').toBe(GEN_VERSION);
    expect(header.link).toContain('town=1');
    expect(header.link).toContain('fortress=1');
    const { w, h } = header.dims;
    expect(w * h).toBe(map.surface.length);
    // (the town's heap, doors and the wall's gate posts, as the game gave the fortress)
    const town = LabTown.of(header.town);
    expect(town.homes.length).toBeGreaterThan(0);
    expect(town.spotsOf(header.town.id)!.some((s) => s.kind === 'post' && s.ref === `${header.town.id}:wall`)).toBe(true);
    // (its land: dry ground at the heap, water — the river and the sea — in the window)
    const [hx, hy] = town.heap;
    const hc = Math.floor(hy / (Math.sqrt(3) / 2)) * w + Math.floor(hx);
    expect(map.water[hc]).toBeLessThan(0.3);
    expect(map.water.filter((v) => v > 0.9).length).toBeGreaterThan(1000);
    expect(map.riverFlow!.some((v) => v > 0)).toBe(true);
  });
});
