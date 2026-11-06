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
import { CHUNK_CLASS, CHUNK_COLUMNS, CHUNK_DEPTH, CUSTOM, ChangedTiles, type GpuTileList } from '../../src/sim/cull';
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
      const ct = new ChangedTiles(g.device, w.core.world, t, LIST, 'test', CHUNK_COLUMNS | CHUNK_CLASS);
      // (one that follows the water's depth only)
      const cd = new ChangedTiles(g.device, w.core.world, t, LIST, 'test depth', CHUNK_DEPTH, false);
      const build = async () => {
        await w.step(1);
        t.setList(LIST, all);
        const enc = g.device.createCommandEncoder();
        ct.build(enc, w.core.host.profiler, all.length, false);
        cd.build(enc, w.core.host.profiler, all.length, false);
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
      // (the depth's follower saw the written chunk too, and nothing since)
      expect(await listed(w, cd.changed)).toEqual([]);
      // (its class only — the places — at the corner: the corner and its three; not the depth's follower)
      w.core.world.bumpChunks([0], w.core.sim.tick, 'water');
      await build();
      expect(await listed(w, ct.changed)).toEqual([0]);
      expect(await listed(w, ct.around)).toEqual([0, 1, cx, cx + 1]);
      expect(await listed(w, cd.changed)).toEqual([]);
      expect(g.takeErrors()).toEqual([]);
      ct.destroy();
      cd.destroy();
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

  it("the top surfaces' water follows the water's depth where nothing else changed", async () => {
    const map = tinyMap(W, W, 32, stone);
    for (let y = 24; y < 40; y++) for (let x = 28; x < 44; x++) map.water[y * W + x] = 0.3;
    const w = await tinyWorld(g, map, ['surface', 'water']);
    try {
      const agents = installAgents(w.core);
      const tick = async (n: number, water: boolean) => {
        for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents' || (water && s.name === 'water'));
        await g.device.queue.onSubmittedWorkDone();
      };
      agents.spawn(10, 36, 27, { spread: 4 });
      await tick(30, true);
      // (the water still: what it is now, the surfaces show)
      await tick(2, false);
      // (nav in window order: 4 surfaces of 4 words a column; the top's .w its water)
      const nav = new Float32Array(w.core.world.ring.toWindow(new Uint32Array(await g.read(agents.nav, agents.nav.size)), 16).buffer);
      const water = await w.read('water');
      const lists = (agents as unknown as { sk: { lists: ChangedTiles } }).sk.lists;
      // (shallow water spreading and drying: no band crossed, nothing re-peeled)
      expect(await listed(w, lists.changed)).toEqual([]);
      let wet = 0;
      for (let y = 26; y < 38; y++)
        for (let x = 30; x < 42; x++) {
          const c = y * W + x;
          expect(nav[c * 16 + 3]).toBe(water[c]);
          if (water[c] > 0) wet++;
        }
      expect(wet).toBeGreaterThan(0);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      w.destroy();
    }
  });
});
