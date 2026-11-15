// The whole body ↔ body path's test rig (test/gpu/sdf-rooms.test.ts, sdf-slots.test.ts): the engine's rows as
// buffers, an SdfCollide over them, and one tick read back: the pairs, each one's record and slot, the rows' `missing`
// words, what was asked of the rooms; and brute force's pair set (test/support/sdf-coarse-ref.ts).
import { expect } from 'vitest';
import { COUNT_BRICKS, COUNT_BRICKS_DROPPED, COUNT_CULL, COUNT_CULL_DROPPED, COUNT_SLOT_FAILS, COUNTS_BYTES, NO_SLOT, PAIR_HIT_BYTES, PAIR_HIT_ROWS, PAIR_HIT_SAMPLES, PAIR_HIT_SLOT, SLOT_KEY_AGE, SLOT_KEY_BYTES, SLOT_KEY_PAIR, packBodies, type BodyRow } from '../../src/engine/sdf/contract';
import { PAIR_ASKED, PAIR_HEADER_WORDS, PAIR_ITEMS_ASKED, PAIR_ITEMS_DROPPED, type CoarseInputs } from '../../src/engine/sdf/coarse';
import { SdfCollide, type CollideOptions } from '../../src/engine/sdf/collide';
import type { SdfModels, SdfModelSpec } from '../../src/engine/sdf/models';
import { awakeList, COARSE_MAX_DIAMETER } from '../../src/engine/sdf/shapes';
import { brutePairs } from '../support/sdf-coarse-ref';
import type { TestGpu } from './dawn';
import { storage } from './sdf-harness';

export const MARGIN = 0.25;

/** the device, the store and the store's rows for `specs` */
export interface RigWorld {
  g: TestGpu;
  store: SdfModels;
  ids: number[];
  specs: SdfModelSpec[];
}

export interface Tick {
  /** the pairs written, 'lo,hi', in the list's order, and each one's record: sample contacts and rows */
  pairs: string[];
  samples: Map<string, number>;
  rowsOf: Map<string, number>;
  /** each pair's slot (NO_SLOT: none), the slot's age, and whether the slot's key record names the pair and its place in the list */
  slotOf: Map<string, number>;
  ageOf: Map<string, number>;
  keyed: Map<string, boolean>;
  /** the rows' `missing` words */
  missing: Uint32Array;
  asked: { pairs: number; items: number; itemsDropped: number; groups: number; groupsDropped: number; slotFails: number; cull: number; cullDropped: number };
}

export interface Rig {
  c: SdfCollide;
  bodies: BodyRow[];
  inputs: CoarseInputs;
  /** the rows uploaded again (as many or more), `epoch` as the engine would bump it */
  set(bodies: BodyRow[], epoch: number): void;
  /** one tick: encode, submit, poll; then what it wrote. `wait`: let the read land first (a test's ticks; the engine never waits) */
  tick(wait?: boolean): Promise<Tick>;
  brute(): { sure: string[]; maybe: Set<string> };
  destroy(): void;
}

export function rig(world: RigWorld, bodies: BodyRow[], opts: Partial<CollideOptions> = {}, rowRoom = bodies.length, bufRows = bodies.length): Rig {
  const { g, store, ids, specs } = world;
  const dev = g.device;
  const mk = (b: BodyRow[], room: number) => {
    const p = packBodies(b);
    const grown = <T extends Float32Array | Uint32Array>(a: T, per: number): T => {
      const out = new (a.constructor as new (n: number) => T)(room * per);
      out.set(a);
      return out;
    };
    return { pose: grown(p.pose, 16), vel: grown(p.vel, 8), info: grown(p.info, 12), model: grown(p.model, 1), list: awakeList(b.map((_, i) => i).filter((i) => !b[i].asleep && !b[i].dead), room) };
  };
  // (the engine's own buffers: room for the rows a test ends with)
  const room = Math.max(bufRows, bodies.length);
  const first = mk(bodies, room);
  const list = dev.createBuffer({ label: 'test awake list', size: first.list.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(list, 0, first.list);
  const inputs: CoarseInputs = { list, pose: storage(g, 'pose', first.pose), vel: storage(g, 'vel', first.vel), info: storage(g, 'info', first.info), model: storage(g, 'model', first.model), sleepEpoch: storage(g, 'epoch', new Uint32Array([1, 0, 0, 0])) };
  // (no sample cap: every sample every tick, so a pair's record is the same from tick to tick)
  const c = new SdfCollide(dev, store, { rows: rowRoom, cellTop: COARSE_MAX_DIAMETER + MARGIN, margin: MARGIN, readEvery: 1, cap: 1 << 16, ...opts });
  let n = 0;
  const me: Rig = {
    c,
    bodies,
    inputs,
    set(next, epoch) {
      me.bodies = next;
      const q = mk(next, room);
      dev.queue.writeBuffer(inputs.pose, 0, q.pose);
      dev.queue.writeBuffer(inputs.vel, 0, q.vel);
      dev.queue.writeBuffer(inputs.info, 0, q.info);
      dev.queue.writeBuffer(inputs.model, 0, q.model);
      dev.queue.writeBuffer(list, 0, q.list);
      dev.queue.writeBuffer(inputs.sleepEpoch, 0, new Uint32Array([epoch]));
    },
    async tick(wait = true) {
      const enc = dev.createCommandEncoder();
      c.encode(enc, inputs, me.bodies.length, n++);
      dev.queue.submit([enc.finish()]);
      // (read before the poll: its read clears the high-water words, and a growth replaces the buffers)
      const head = new Uint32Array(await g.read(c.coarse.pairBuf, PAIR_HEADER_WORDS * 4));
      const k = Math.min(head[PAIR_ASKED], c.coarse.pairRoom);
      const raw = k ? new Uint32Array(await g.read(c.coarse.pairBuf, k * 8, PAIR_HEADER_WORDS * 4)) : new Uint32Array(0);
      const hits = k ? new Uint32Array(await g.read(c.fine.hits, k * PAIR_HIT_BYTES)) : new Uint32Array(0);
      const counts = new Uint32Array(await g.read(c.fine.counts, COUNTS_BYTES));
      const keys = new Uint32Array(await g.read(c.fine.slotKeys, c.fine.slots * SLOT_KEY_BYTES));
      const missing = new Uint32Array(await g.read(c.missing, me.bodies.length * 4));
      c.poll();
      if (wait) await c.settled();
      expect(g.takeErrors()).toEqual([]);
      const out: Tick = { pairs: [], samples: new Map(), rowsOf: new Map(), slotOf: new Map(), ageOf: new Map(), keyed: new Map(), missing, asked: { slotFails: counts[COUNT_SLOT_FAILS], cull: counts[COUNT_CULL], cullDropped: counts[COUNT_CULL_DROPPED], pairs: head[PAIR_ASKED], items: head[PAIR_ITEMS_ASKED], itemsDropped: head[PAIR_ITEMS_DROPPED], groups: counts[COUNT_BRICKS], groupsDropped: counts[COUNT_BRICKS_DROPPED] } };
      for (let i = 0; i < k; i++) {
        const key = `${Math.min(raw[2 * i], raw[2 * i + 1])},${Math.max(raw[2 * i], raw[2 * i + 1])}`;
        out.pairs.push(key);
        out.samples.set(key, hits[i * 32 + PAIR_HIT_SAMPLES]);
        out.rowsOf.set(key, hits[i * 32 + PAIR_HIT_ROWS]);
        const slot = hits[i * 32 + PAIR_HIT_SLOT];
        out.slotOf.set(key, slot);
        if (slot !== NO_SLOT) {
          out.ageOf.set(key, keys[slot * 4 + SLOT_KEY_AGE]);
          out.keyed.set(key, `${keys[slot * 4]},${keys[slot * 4 + 1]}` === key && keys[slot * 4 + SLOT_KEY_PAIR] === i);
        }
      }
      return out;
    },
    brute() {
      const ref = brutePairs(me.bodies, specs, (b) => ids.indexOf(b.model), MARGIN);
      return { sure: ref.filter((x) => x.slack > 1e-3).map((x) => `${x.a},${x.b}`), maybe: new Set(ref.filter((x) => Math.abs(x.slack) <= 1e-3).map((x) => `${x.a},${x.b}`)) };
    },
    destroy() {
      c.destroy();
      for (const b of Object.values(inputs)) (b as GPUBuffer).destroy();
    },
  };
  return me;
}

export const rowsOf = (key: string) => key.split(',').map(Number);

/** a tick against brute force: no pair twice, none that brute force lacks; and every row of a pair the tick lacks is flagged. Returns the pairs it lacks */
export function expectSafe(t: Tick, ref: { sure: string[]; maybe: Set<string> }): string[] {
  expect(new Set(t.pairs).size).toBe(t.pairs.length);
  const got = new Set(t.pairs);
  const want = new Set(ref.sure);
  expect(t.pairs.filter((x) => !want.has(x) && !ref.maybe.has(x)), 'GPU pairs brute force lacks').toEqual([]);
  const lacks = ref.sure.filter((x) => !got.has(x));
  const bare = lacks.filter((x) => rowsOf(x).some((r) => t.missing[r] === 0));
  expect(bare, 'pairs not written whose rows are not both flagged').toEqual([]);
  return lacks;
}
