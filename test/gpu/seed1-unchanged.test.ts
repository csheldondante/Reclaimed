// Round 125 (forest): the elder woods are laid as old woods in the atlas (woods.wgsl elderWoods, in forms.wgsl and
// lod.wgsl's succession) — vegetation only. This holds it to that: seed 1's atlas built on Dawn gives the same regions,
// settlement sites and roads as the cached facts every Node fixture, the wiki, the GM's situations and the run's cast
// are made from (data/atlas/seed1.json).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { atlasFacts, type AtlasFacts } from '../../src/gm/atlas-facts';

const cached = (): AtlasFacts => JSON.parse(readFileSync(new URL('../../data/atlas/seed1.json', import.meta.url), 'utf8'));

describe('seed 1 (the cached world)', () => {
  it('has the same regions, settlements and roads as data/atlas/seed1.json', async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, DEFAULT_ATLAS);
    expect(g.takeErrors()).toEqual([]);
    const now = atlasFacts(a);
    const was = cached();
    const reg = (f: AtlasFacts) => f.regions.map((r) => ({ id: r.id, kind: r.kind, centre: r.centre, neighbours: r.neighbours, area: r.area }));
    expect(reg(now)).toEqual(reg(was));
    expect(now.spawn).toEqual(was.spawn);
    expect(now.sites).toEqual(was.sites);
    expect(now.roads).toEqual(was.roads);
  }, 600000);
});
