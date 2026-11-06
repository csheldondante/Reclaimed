// (DA-A2, round 128o) The user's start town (data/lab/town.rclt) going to work: its one plan as the game made it, the
// fortress on it (no GPU). The lab's fortressoutside on `town` built 0 of 3 sites in 600 sim s; two causes found here.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { Fortress } from '../../src/fortress/fortress';
import { ECON } from '../../src/fortress/defs';
import { JobBoard, jobSlots } from '../../src/fortress/economy';
import { startSpots } from '../../src/fortress/life';

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
  return { site, f };
}

// (the fixture decoded and its town's ways made: a second or two alone, more beside the GPU tier)
describe("the user's start town goes to work", { timeout: 30_000 }, () => {
  // One plan, so its generated farmland is farm structures — 368 built blocks, a job each. With farms first in
  // JOB_ORDER all its people farmed and nobody built ("There are no builders": 702 of 708 blocks, for good).
  it('gives the builders people, though its farmland has more jobs than it has people', async () => {
    const { site } = await startTown();
    const built = (c: number, l: number) => site.town.has(c, l);
    const building = site.plan.structures().some((s) => [...s.cells.keys()].some((c) => [...site.plan.levels.each(c)].some((l) => !built(c, l))));
    expect(building).toBe(true);
    const slots = jobSlots(site.plan, built, building);
    const people = Array.from({ length: 11 }, (_, i) => i);
    expect(slots.filter((s) => s.kind === 'farm').reduce((n, s) => n + s.count, 0)).toBeGreaterThan(people.length);
    const b = new JobBoard();
    b.assign(people, slots);
    expect(b.count('build')).toBe(ECON.builders);
  });

  // They were spawned 4 m round the stores — the generated warehouse's door — and a unit lands on the top surface where
  // it's put (Agents.spawn): two on the warehouse's roof, one on the lighthouse, 4-16 m up with no way down, standing
  // there with their loads for the whole run.
  it('starts its people on open ground at the stores, not on a roof', async () => {
    const { f } = await startTown();
    const stores = f.storesAt()!;
    // (the stores are a warehouse's door: its way out, a cell with nothing on it)
    expect(f.plan.typeAt(f.cellAt(stores[0], stores[1]))).toBeNull();
    const spots = startSpots(stores, 11);
    expect(spots.map(([x, y]) => f.plan.typeAt(f.cellAt(x, y))), JSON.stringify(spots)).toEqual(spots.map(() => null));
  });
});
