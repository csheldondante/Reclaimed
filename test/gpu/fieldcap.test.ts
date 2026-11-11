// (U2-FIELDCAP) Many order fields at once: every group's field reaches it, or the pool's refusal shows as a failure —
// never a silent FAR. The place table is a stand-in written in townplace.wgsl's layout (as formations.test.ts).
//   FIELD_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { cellPos } from '../../src/world/lattice';
import { TOWN_ROOM } from '../../src/api/contracts/townplaces';
import type { PlaceRef } from '../../src/api/contracts/units';
import { TOWN_WORDS } from '../../src/towncontracts/contracts';
import type { AgentUnits } from '../../src/units/agent-units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const TPS = 60;
const LOG = process.env.FIELD_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);

function fakePlaces(named: Record<number, [number, number, number]>): GPUBuffer {
  const words = new Uint32Array(TOWN_ROOM * TOWN_WORDS);
  const f = new Float32Array(words.buffer);
  words[0] = 1;
  for (let n = 0; n < 23; n++) {
    const e = 16 + n * 8;
    const p = named[n];
    words[e + 3] = p ? 0 : 1;
    if (p) {
      f.set(p, e);
      f.set(p, e + 4);
    }
  }
  const b = g.device.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(b, 0, words);
  return b;
}

async function world(fieldPages?: number) {
  const map = tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core, { fieldPages });
  const { AgentUnits } = await import('../../src/units/agent-units');
  const units: AgentUnits = new AgentUnits(agents);
  const run = async (n: number, every?: () => Promise<boolean | void>) => {
    for (let i = 0; i < n; i++) {
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
      units.update(1 / TPS);
      await g.device.queue.onSubmittedWorkDone();
      if (every && (await every())) return i + 1;
    }
    return n;
  };
  return { units, run };
}

/** the pool's numbers and each field's pages held (the test's read) */
async function poolRead(units: AgentUnits, fields: number[]) {
  const pool = units.agents.fields;
  const st = await pool.stats();
  const { ctl } = await pool.readAll();
  const held = fields.map((f) => {
    let n = 0;
    for (let s = 0; s < pool.o.slots; s++) if (pool.pageOf(ctl, f, s)) n++;
    return n;
  });
  return { ...st, held };
}

/** 40 groups of 2 from 20 places (a 5 x 4 grid), group i to `to(i)`: arrivals, failures (visible), silent ones (neither
 *  arrived nor told), the pool */
async function manyFields(to: (i: number) => PlaceRef, fieldPages?: number, places = 22) {
  const { units, run } = await world(fieldPages);
  const at = (n: number) => cellPos(10 + (n % 5) * 18, 12 + Math.floor(n / 5) * 22);
  const named: Record<number, [number, number, number]> = {};
  for (let n = 0; n < places; n++) {
    const p = at(n);
    named[n] = [p[0], p[1], 10];
  }
  units.usePlaces(fakePlaces(named));
  const arrived = new Set<number>();
  const failed: [number, string][] = [];
  units.arrived.push((x) => arrived.add(x));
  units.orderFailed.push((x, why) => failed.push([x, why]));
  const gids: number[] = [];
  for (let i = 0; i < 40; i++) {
    const from = i % 20;
    const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: from }, 2);
    units.orderGroup!(gid, { kind: 'go', at: to(i) });
    gids.push(gid);
  }
  const L = units.agents.mailLayout;
  const fieldOf = async () => {
    const mail = new Uint32Array(await units.agents.readRaw('mail'));
    return gids.map((_, s) => mail[L.groups + s * L.groupW + 6]);
  };
  let frames = 0;
  const trace: string[] = [];
  await run(TPS * 60, async () => {
    if (++frames % 120 === 0) {
      const fs = [...new Set(await fieldOf())].filter((f) => f !== 0xffffffff);
      const p = await poolRead(units, fs);
      trace.push(`t${frames / TPS}: used ${p.used}/${p.pages} refused ${p.refused} front ${p.front} held ${p.held.join(',')} arrived ${arrived.size}`);
    }
    return gids.every((x) => arrived.has(x) || failed.some(([f]) => f === x));
  });
  const fs = [...new Set(await fieldOf())].filter((f) => f !== 0xffffffff);
  const p = await poolRead(units, fs);
  const out = { refusedSeen: units.agents.fieldPagesRefused, seedsDropped: units.agents.seedsDropped, arrived: gids.filter((x) => arrived.has(x)).length, failed: failed.length, why: [...new Set(failed.map(([, w]) => w))], silent: gids.filter((x) => !arrived.has(x) && !failed.some(([f]) => f === x)).length, pool: { used: p.used, pages: p.pages, refused: p.refused }, fields: fs.length };
  log(`many fields (pool ${fieldPages ?? 'default'}): ${JSON.stringify(out)}\n  ${trace.join('\n  ')}`);
  return out;
}

test('U2-FIELDCAP: 40 groups to 20 destinations — every one arrives, none silently stuck', async () => {
  const r = await manyFields((i) => ({ town: 0, place: (i % 20) ^ 1 }));
  expect(r.silent).toBe(0);
  expect(r.failed).toBe(0);
  expect(r.arrived).toBe(40);
  expect(g.takeErrors()).toEqual([]);
});

test('U2-FIELDCAP: 40 groups to 40 destinations (40 fields at once) — every one arrives', async () => {
  // (a field a key: the same 20 places, each named with one of two else-places — 40 keys, 40 fields seeded at once)
  const r = await manyFields((i) => ({ town: 0, place: (i % 20) ^ 1, else: { town: 0, place: 20 + (i < 20 ? 0 : 1) } }));
  expect(r.fields).toBe(40);
  expect(r.seedsDropped).toBe(0);
  expect(r.silent).toBe(0);
  expect(r.failed).toBe(0);
  expect(r.arrived).toBe(40);
  expect(g.takeErrors()).toEqual([]);
});

test('U2-FIELDCAP: a pool too small for the fields asked of it fails the orders it cannot reach "pool-full", shown — never a silent FAR', async () => {
  const r = await manyFields((i) => ({ town: 0, place: (i % 20) ^ 1 }), 60);
  expect(r.silent).toBe(0);
  expect(r.failed).toBeGreaterThan(0);
  expect(r.why).toEqual(['pool-full']);
  expect(r.refusedSeen).toBeGreaterThan(0);
  expect(r.arrived + r.failed).toBe(40);
  expect(g.takeErrors()).toEqual([]);
});
