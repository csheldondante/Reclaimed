// (round 128o, DA-B9) The chunks' versions (sim/chunkver.ts, shaders/chunkver.wgsl): every writer of the columns moves
// the version of each chunk it changed, and of no other. A writer that forgets is silent staleness for every reader that
// trusts the versions, so each has its test here: on a tiny world with only that writer stepping, a change it makes
// moves its chunk's version to its tick + 1, and a chunk it didn't change keeps its own. (test/unit/chunkver.test.ts
// holds the sources to it: every kernel with the columns writable calls bumpChunk, every CPU write of them tells
// WorldCore.columnsWritten.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { tinyMap } from '../support/tinymap';
import { MAT } from '../../src/world/materials';
import { CHUNK, type Interval } from '../../src/world/layout';
import { cellPos } from '../../src/world/lattice';
import { versionIndex } from '../../src/sim/chunkver';
import { attachSim } from '../../src/api/world';
import { EventKind } from '../../src/sim/globals';
import { LavaSystem } from '../../src/sim/lava';
import { Sleep } from '../../src/sim/sleep';
import { installFlow } from '../../src/flow/install';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
  // (the world API's mirror asks a page on the next animation frame: Node has none)
  globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
});
afterAll(() => g?.destroy());

const W = 64;
const H = 64;

/** the versions now, by window chunk */
async function versions(w: TinyWorld): Promise<(ci: number) => number> {
  const raw = new Uint32Array((await w.core.readBuffer('chunks')).buffer);
  const p = w.core.packed;
  const base = p.chunkTable.length;
  return (ci) => raw[base + versionIndex(p, ci)];
}
/** window chunk of column (x, y) */
const chunkOf = (w: TinyWorld, x: number, y: number) => Math.floor(y / CHUNK) * w.core.packed.chunksX + Math.floor(x / CHUNK);
/** the chunk under window world (x, y) */
const chunkAt = (w: TinyWorld, wx: number, wy: number) => chunkOf(w, Math.floor(wx), Math.floor(wy / 0.8660254));

/** a writer's check: `act` changes the columns round (x, y) (window columns); after `ticks` of `systems`, that chunk's
 *  version is past where it was and the far corner's (0, 3 chunks over) isn't */
async function bumps(map: ReturnType<typeof tinyMap>, systems: string[], x: number, y: number, act: (w: TinyWorld) => void | Promise<void>, ticks = 4, warm = 6): Promise<{ before: number; after: number; far: [number, number]; tick: number }> {
  const w = await tinyWorld(g, map, systems);
  try {
    await w.step(warm);
    const v0 = await versions(w);
    const ci = chunkOf(w, x, y);
    const far = chunkOf(w, W - 2, H - 2);
    const before = v0(ci);
    const farBefore = v0(far);
    await act(w);
    await w.step(ticks);
    const v1 = await versions(w);
    expect(g.takeErrors()).toEqual([]);
    return { before, after: v1(ci), far: [farBefore, v1(far)], tick: w.core.sim.tick };
  } finally {
    w.destroy();
  }
}

const stone = (): Interval[] => [{ z0: 0, z1: 10, mat: MAT.Stone }];

describe('every writer of the columns moves its chunks\' versions', () => {
  it('a column apply (claims, stamps: colapply.wgsl)', async () => {
    const r = await bumps(tinyMap(W, H, 32, stone), [], 10, 10, (w) => w.core.stampColumns([{ cuts: [], claim: [{ x: 10, y: 10, z0: 10, z1: 14, aux: MAT.Rubble }] }]), 1);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('the edit pass (a dig: edit.wgsl)', async () => {
    const r = await bumps(tinyMap(W, H, 32, stone), ['edit'], 12, 12, (w) => {
      const t = attachSim(w.core, { terrain: true }).terrain!;
      t.dig(...cellPos(12, 12), { radius: 2, layers: 2 });
    });
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('the structure pass (a lightning strike blasts compacted waste to ash: structure.wgsl)', async () => {
    const map = tinyMap(W, H, 32, (x, y) => (x > 8 && x < 16 && y > 8 && y < 16 ? [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 13, mat: MAT.Trash }] : stone()));
    const r = await bumps(map, ['structure'], 12, 12, (w) => {
      const [x, y] = cellPos(12, 12);
      w.core.globals.events.push({ kind: EventKind.Lightning, x, y, radius: 6, strength: 40 });
    }, 2);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('the sediment pass (a heap of sand slumps: sediment.wgsl)', async () => {
    const map = tinyMap(W, H, 40, (x, y) => (x === 20 && y === 20 ? [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 30, mat: MAT.Sand }] : stone()));
    const r = await bumps(map, ['surface', 'sediment'], 20, 20, () => {}, 40, 0);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('the climate pass (snow melts in the warm: climate.wgsl)', async () => {
    const map = tinyMap(W, H, 32, (x, y) => (x > 24 && x < 32 && y > 24 && y < 32 ? [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 11, mat: MAT.Snow }] : stone()));
    const r = await bumps(map, ['climate'], 28, 28, (w) => {
      w.core.globals.climate = { temp: 30, lapse: 0 };
    }, 200, 0);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('the landform brush (a range raised: landbrush.wgsl)', async () => {
    const r = await bumps(tinyMap(W, H, 60, stone), ['landbrush'], 30, 30, (w) => {
      const s = attachSim(w.core, { terrain: true }).terrain!.raise('range', { radius: 4, height: 8 });
      s.to(...cellPos(28, 30));
      s.to(...cellPos(32, 30));
      s.end();
    }, 60);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('a layer pull (stone pulled up: layerpull.wgsl)', async () => {
    const r = await bumps(tinyMap(W, H, 60, stone), ['layerpull'], 36, 36, (w) => {
      const s = attachSim(w.core, { terrain: true }).terrain!.pull('stone');
      s.to(...cellPos(36, 36), { radius: 3, height: 4 });
      s.end();
    }, 30);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.far[1]).toBe(r.far[0]);
  });

  it('the town stamp (a block added: townstamp.wgsl)', async () => {
    const r = await bumps(tinyMap(W, H, 60, stone), ['townstamp'], 32, 32, (w) => {
      const town = attachSim(w.core, { terrain: true }).town({ seed: 7 });
      const cell = town.grid.cellAtWorld(...cellPos(32, 32));
      if (cell < 0) throw new Error('no town cell at (32, 32)');
      town.add(cell, 0);
    }, 6);
    expect(r.after).toBeGreaterThan(r.before);
  });

  it("the lava pass (a volcano's cone rises: lava.wgsl)", async () => {
    // (the lava system comes with the physics install, not the world: added here, stepped alone)
    const w = await tinyWorld(g, tinyMap(W, H, 60, stone), []);
    try {
      const lava = new LavaSystem(g.device, w.core.world, w.core.host.profiler);
      w.core.sim.systems.push(lava);
      const step = async (n: number) => {
        for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (sy) => sy === lava);
        await g.device.queue.onSubmittedWorkDone();
      };
      await step(4);
      const v0 = await versions(w);
      const ci = chunkOf(w, 40, 20);
      const far = chunkOf(w, W - 2, H - 2);
      lava.addVent(...cellPos(40, 20), 30, 9, 1.6, 10, 2);
      await step(60);
      const v1 = await versions(w);
      expect(v1(ci)).toBeGreaterThan(v0(ci));
      expect(v1(far)).toBe(v0(far));
      expect(g.takeErrors()).toEqual([]);
    } finally {
      w.destroy();
    }
  });

  it('the flowing lava sets to basalt (?flow=1: liquid.wgsl)', async () => {
    const w = await tinyWorld(g, tinyMap(W, H, 60, stone), []);
    try {
      const sleep = new Sleep(W / CHUNK, H / CHUNK, w.core.ring);
      const kit = installFlow(w.core, sleep);
      const flow = new Set<string>([kit.lava.name, 'flow-steady', 'surface']);
      const step = async (n: number) => {
        for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (sy) => flow.has(sy.name));
        await g.device.queue.onSubmittedWorkDone();
      };
      await step(4);
      const v0 = await versions(w);
      const ci = chunkOf(w, 20, 44);
      const far = chunkOf(w, W - 2, 2);
      const [x, y] = cellPos(20, 44);
      kit.lava.addSpring(x, y, 11, 2);
      await step(60);
      kit.lava.springs.length = 0;
      let moved = false;
      for (let k = 0; k < 20 && !moved; k++) {
        await step(60);
        moved = (await versions(w))(ci) > v0(ci);
      }
      expect(moved).toBe(true);
      expect((await versions(w))(far)).toBe(v0(far));
      expect(g.takeErrors()).toEqual([]);
    } finally {
      w.destroy();
    }
  });

  it('the CPU: WorldCore.columnsWritten moves the chunks named, to the next tick + 1', async () => {
    const w = await tinyWorld(g, tinyMap(W, H, 32, stone), []);
    try {
      await w.step(3);
      const ci = chunkAt(w, ...cellPos(5, 40));
      w.core.columnsWritten([ci]);
      const v = await versions(w);
      expect(v(ci)).toBe(w.core.sim.tick + 1);
      expect(v(chunkOf(w, W - 2, H - 2))).toBe(0);
      // (an undo: every chunk)
      w.core.snapshot();
      await w.step(2);
      expect(w.core.undo()).toBe(true);
      const v2 = await versions(w);
      for (let c = 0; c < (W / CHUNK) * (H / CHUNK); c++) expect(v2(c)).toBe(w.core.sim.tick + 1);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      w.destroy();
    }
  });
});
