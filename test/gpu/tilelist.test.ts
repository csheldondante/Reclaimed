// (round 128o, DA-B26) Tile lists made on the GPU from the chunks' versions (sim/cull.ts ChangedTiles,
// shaders/tilelist.wgsl), and their first reader, the agents' re-peel (agents.ts encodeScoped):
//  - a chunk is listed changed the first time, then only after its columns or its water moved, and `around` holds
//    the scope's chunks next to one listed;
//  - nothing changed: 0 workgroups;
//  - the agents' surfaces after a heap is stamped are what a whole re-peel makes, two ticks on (the round robin's eighth
//    a tick would most often have left it unpeeled that soon).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { tinyMap } from '../support/tinymap';
import { MAT } from '../../src/world/materials';
import { CUSTOM, ChangedTiles, type GpuTileList } from '../../src/sim/cull';
import { installAgents } from '../../src/agents/install';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
  globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
});
afterAll(() => g?.destroy());

const W = 64;
const stone = () => [{ z0: 0, z1: 10, mat: MAT.Stone }];
const LIST = CUSTOM + 99;

/** a GPU list's window chunks (as read back: its args' workgroups, 4 a chunk) */
async function listed(w: TinyWorld, l: GpuTileList): Promise<number[]> {
  const n = new Uint32Array(await g.read(l.args, 12))[0] / 4;
  if (!n) return [];
  const e = new Uint32Array(await g.read(l.list, n * 4));
  const cx = w.core.packed.chunksX;
  return [...e].map((v) => ((v >> 6) & 63) * cx + (v & 63)).sort((a, b) => a - b);
}

describe('ChangedTiles: what changed, and round it', () => {
  it('lists a chunk the first time, then only when its columns or water moved', async () => {
    const w = await tinyWorld(g, tinyMap(W, W, 32, stone), []);
    try {
      const t = w.core.world.tiles!;
      const all = [...Array(t.chunks).keys()];
      t.setList(LIST, all);
      const ct = new ChangedTiles(g.device, w.core.world, t, LIST, 'test');
      const build = async () => {
        await w.step(1);
        t.setList(LIST, all);
        const enc = g.device.createCommandEncoder();
        ct.build(enc, w.core.host.profiler, all.length, false);
        g.device.queue.submit([enc.finish()]);
        await g.device.queue.onSubmittedWorkDone();
      };
      // (never looked at: every chunk)
      await build();
      expect(await listed(w, ct.changed)).toEqual(all);
      expect(await listed(w, ct.around)).toEqual(all);
      // (nothing since: none, no workgroups)
      await build();
      expect(await listed(w, ct.changed)).toEqual([]);
      expect(await listed(w, ct.around)).toEqual([]);
      // (one chunk's columns written: it, and the 3 x 3 round it)
      const cx = w.core.packed.chunksX;
      const ci = 1 * cx + 2;
      w.core.columnsWritten([ci]);
      await build();
      expect(await listed(w, ct.changed)).toEqual([ci]);
      const round: number[] = [];
      for (let b = 0; b <= 2; b++) for (let a = 1; a <= 3; a++) round.push(b * cx + a);
      expect(await listed(w, ct.around)).toEqual(round);
      // (and gone again)
      await build();
      expect(await listed(w, ct.changed)).toEqual([]);
      // (its water only, at the corner: the corner and its three)
      w.core.world.bumpChunks([0], w.core.sim.tick, 'water');
      await build();
      expect(await listed(w, ct.changed)).toEqual([0]);
      expect(await listed(w, ct.around)).toEqual([0, 1, cx, cx + 1]);
      expect(g.takeErrors()).toEqual([]);
      ct.destroy();
    } finally {
      w.destroy();
    }
  });
});

describe("the agents' re-peel over what changed", () => {
  it('a heap stamped is peeled at once, as a whole re-peel would; nothing changed, nothing peeled', async () => {
    const w = await tinyWorld(g, tinyMap(W, W, 32, stone), ['surface', 'edit']);
    try {
      const agents = installAgents(w.core);
      const tick = async (n: number) => {
        for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'edit' || s.name === 'agents');
        await g.device.queue.onSubmittedWorkDone();
      };
      agents.spawn(20, 32, 27, { spread: 6 });
      await tick(12);
      const lists = (agents as unknown as { sk: { lists: ChangedTiles } }).sk.lists;
      // (still ground: the peel lists nothing)
      expect(await listed(w, lists.changed)).toEqual([]);
      const navBytes = agents.nav.size;
      const before = new Uint32Array(await g.read(agents.nav, navBytes));
      // (a heap stamped in one tick: colapply)
      w.core.stampColumns([{ cuts: [], claim: [36, 37, 38].map((x) => ({ x, y: 30, z0: 10, z1: 14, aux: MAT.Rubble })) }]);
      await tick(2);
      const peeled = new Uint32Array(await g.read(agents.nav, navBytes));
      expect(peeled).not.toEqual(before);
      // (the whole scope peeled again: nothing more to change)
      (agents as unknown as { navStale: boolean }).navStale = true;
      await tick(1);
      const whole = new Uint32Array(await g.read(agents.nav, navBytes));
      expect(peeled).toEqual(whole);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      w.destroy();
    }
  });
});
