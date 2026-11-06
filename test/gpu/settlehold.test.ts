// (round 128o, DA-B20) The water's settling hold, decided on the GPU. What the CPU tells the GPU's settling hold (sim/sleep.ts settleCand): a chunk an event woke,
// asleep by its time, is a candidate for SETTLE_MAX_S (60 s) from its waking — on the culled lists, the GPU deciding —
// then drowsy once; land that came in (not woken by an event) and a world with no tolerance have none. Nothing is
// held by the CPU any more: its own mask says asleep.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GLOBALS_BYTES } from '../../src/sim/globals';
import { SettleHold } from '../../src/sim/settlehold';
import type { WorldGpu } from '../../src/sim/world-gpu';
import { testGpu, type TestGpu } from './dawn';
import { Sleep } from '../../src/sim/sleep';
import { useRivers } from '../../src/sim/world-gpu';

const bit = (m: Uint32Array, k: number) => (m[k >> 5] >>> (k & 31)) & 1;

describe('the settling hold candidates', () => {
  afterEach(() => useRivers('sim'));

  it('an event-woken chunk past its time: asleep on the CPU, a candidate until 60 s from its waking, then drowsy once', () => {
    // (?rivers=table: the tolerance is on — sim/sleep.ts settleTol)
    useRivers('table');
    const s = new Sleep(4, 4);
    s.wake(8, 8, 1, 8, 100);
    s.update(105, null, [], []);
    expect(bit(s.mask, 0)).toBe(0);
    expect(bit(s.settleCand, 0)).toBe(0);
    // (its 8 s up: asleep — the CPU holds nothing — and a candidate)
    s.update(120, null, [], []);
    expect(bit(s.mask, 0)).toBe(1);
    expect(bit(s.settleCand, 0)).toBe(1);
    expect(s.candidates).toBe(1);
    expect(s.awake).toBe(0);
    // (the rest never woke: no candidates)
    expect(bit(s.settleCand, 5)).toBe(0);
    s.update(159.9, null, [], []);
    expect(bit(s.settleCand, 0)).toBe(1);
    // (60 s from its waking: no longer — drowsy once)
    s.update(160.1, null, [], []);
    expect(bit(s.settleCand, 0)).toBe(0);
    expect(bit(s.drowse, 0)).toBe(1);
    s.update(161, null, [], []);
    expect(bit(s.drowse, 0)).toBe(0);
  });

  it('no tolerance (rivers simulated): no candidates', () => {
    useRivers('sim');
    const s = new Sleep(4, 4);
    s.wake(8, 8, 1, 8, 100);
    s.update(120, null, [], []);
    expect(s.candidates).toBe(0);
  });

  it('land come in (settleAll) is not a candidate: only what an event woke', () => {
    useRivers('table');
    const s = new Sleep(4, 4);
    s.settleAll(1.5, 100);
    s.update(110, null, [], []);
    expect(s.candidates).toBe(0);
  });
});

// ---- the GPU's side (sim/settlehold.ts, shaders/settlehold.wgsl): a candidate is held while its water changes ----

describe('the settling hold on the GPU', () => {
  let g: TestGpu;
  beforeAll(async () => {
    g = await testGpu();
  });
  afterAll(() => g?.destroy());

  it('holds a candidate awake while its water changes, lets it sleep (drowsy once) when it stops; a non-candidate sleeps', async () => {
    const dev = g.device;
    const globals = dev.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const waterChange = dev.createBuffer({ size: 2048 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const hold = new SettleHold(dev, { globals, waterChange } as unknown as WorldGpu);
    const SLEEP_WORD = 284;
    // (the CPU says: slots 0..3 asleep; 0 and 1 candidates, 2 and 3 not)
    const asleep = new Uint32Array(64);
    asleep[0] = 0b1111;
    const cand = new Uint32Array(64);
    cand[0] = 0b0011;
    const tick = async (changes: Record<number, number>): Promise<{ sleep: number; drowse: number }> => {
      const head = new Uint32Array(GLOBALS_BYTES / 4);
      head.set(asleep, SLEEP_WORD);
      dev.queue.writeBuffer(globals, 0, head);
      const ch = new Float32Array(2048);
      for (const [k, v] of Object.entries(changes)) ch[+k] = v;
      dev.queue.writeBuffer(waterChange, 0, ch);
      const enc = dev.createCommandEncoder();
      hold.encode(enc, cand, 0.01);
      dev.queue.submit([enc.finish()]);
      const m = new Uint32Array(await g.read(globals, 512, SLEEP_WORD * 4));
      return { sleep: m[0], drowse: m[64] };
    };
    // (both candidates' water changing, and slot 2's — not a candidate: it sleeps; 3 never ran)
    let m = await tick({ 0: 0.5, 1: 0.5, 2: 0.5 });
    // (a candidate the CPU has asleep never ran: its change can't hold it — it ran only if held already)
    expect(m.sleep & 0b1111).toBe(0b1111);
    // (awake on the CPU for a tick: their water changes — held from now)
    asleep[0] = 0b1100;
    m = await tick({ 0: 0.5, 1: 0.5 });
    expect(m.sleep & 0b0011).toBe(0);
    // (the CPU's time up: 0 still changing — held; 1 settled — held for the hold's ticks, then asleep and drowsy)
    asleep[0] = 0b1111;
    m = await tick({ 0: 0.5, 1: 0.001 });
    expect(m.sleep & 0b0011).toBe(0);
    let ticks = 0;
    let drowsy = 0;
    for (; ticks < 200; ticks++) {
      m = await tick({ 0: 0.5 });
      if (m.drowse & 0b0010) drowsy++;
      if (m.sleep & 0b0010) break;
    }
    expect(ticks).toBeGreaterThan(30);
    expect(ticks).toBeLessThan(60);
    expect(m.sleep & 0b0001).toBe(0);
    for (let k = 0; k < 20; k++) {
      m = await tick({ 0: 0.5 });
      if (m.drowse & 0b0010) drowsy++;
    }
    expect(drowsy).toBeGreaterThan(5);
    expect(m.drowse & 0b0010).toBe(0);
    expect(m.sleep & 0b1110).toBe(0b1110);
    // (slot 0 no longer a candidate — the CPU's 60 s are up: asleep whatever its water does)
    cand[0] = 0;
    m = await tick({ 0: 0.5 });
    expect(m.sleep & 0b0001).toBe(1);
    expect(g.takeErrors()).toEqual([]);
    hold.destroy();
  });
});
