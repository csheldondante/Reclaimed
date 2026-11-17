// (loop round 13, BACKLOG LS-99; docs/design/CITYGEN.md "Units on bridge decks") A column made on a bridge deck, sent to
// a place across the river: does it walk off the deck into town? Round 11 saw columns stand at the far end of Muru's
// second bridge. The deck as the game claims it (streets.wgsl claimRoads): an External slab DECK_CLAIM_T (0.25) thick,
// its top the deck's height, over the riverbed with the river in the gap under it (no open water on a deck column). The
// river is made impassable by height (a drop over the units' DROP), so the deck is the only way across.
// Variants, from what artSpan makes (streets.wgsl: an end at max(bank + deckClear 1, the water's top + 0.35)):
//   A: the deck's ends 1.0 over the banks (deckClear: "at most a walker's step");
//   B: the ends 1.6 over the banks (the water's top set the end, as where the river runs high under a low bank);
//   C: two decks with a dry island 4 columns wide between them, ends as A (Muru's roads 0 and 1).
// Each: the group made on the deck's far end, sent `go` to the market (its field), and, from a fresh world, `march`
// inward along a route over the deck (the road's way in). Logged: where the units end, arrived, and the links of the
// columns where the deck meets the bank. DECKWALK_LOG=<file> appends the numbers.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { cellPos } from '../../src/world/lattice';
import { TOWN_ROOM, PLACE } from '../../src/api/contracts/townplaces';
import { TOWN_WORDS } from '../../src/towncontracts/contracts';
import type { AgentUnits } from '../../src/units/agent-units';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const H = 64;
const TPS = 60;
const ROW = 30;
const BANK = 10;
const BED = 5;
const LOG = process.env.DECKWALK_LOG;
const log = (m: string) => (console.log(m), LOG && appendFileSync(LOG, `${m}\n`));

interface Deck {
  /** columns x0..x1 (inclusive) on rows 26-34 */
  x0: number;
  x1: number;
  /** its top at x0 and at x1 (linear between) */
  z0: number;
  z1: number;
}
/** the river's columns (no ground at the bank's height), and dry islands in it */
const RIVER: [number, number] = [40, 92];

function deckAt(decks: Deck[], x: number, y: number): number | null {
  if (y < 26 || y > 34) return null;
  for (const d of decks) if (x >= d.x0 && x <= d.x1) return d.z0 + ((d.z1 - d.z0) * (x - d.x0)) / Math.max(1, d.x1 - d.x0);
  return null;
}

async function world(decks: Deck[], island: [number, number] | null) {
  const wet = (x: number) => x >= RIVER[0] && x <= RIVER[1] && !(island && x >= island[0] && x <= island[1]);
  const map = tinyMap(W, H, 32, (x, y) => {
    const dz = deckAt(decks, x, y);
    return [{ z0: 0, z1: wet(x) ? BED : BANK, mat: MAT.Stone }, ...(dz !== null ? [{ z0: dz - 0.25, z1: dz, mat: MAT.External }] : [])];
  });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map.water[y * W + x] = wet(x) && deckAt(decks, x, y) === null ? 2 : 0;
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
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
  return { w, agents, units, run };
}

/** townplace.wgsl's table: town 0 live, named places at window points (status OK) — formations.test.ts's */
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
/** routeread.wgsl's buffer: one route, gate slot 0 its march route — formations.test.ts's */
function fakeRoutes(points: { at: [number, number, number]; width: number }[]): GPUBuffer {
  const heads = 16;
  const pts = heads + 4;
  const gates = pts + points.length * 5;
  const words = new Uint32Array(gates + 4);
  const f = new Float32Array(words.buffer);
  words.set([0, 0, 1, pts, 0, 0, 0, points.length, heads, 0, 1, 1, gates, gates], 0);
  let s = 0;
  points.forEach((p, i) => {
    if (i) s += Math.hypot(p.at[0] - points[i - 1].at[0], p.at[1] - points[i - 1].at[1]);
    f.set([...p.at, s, p.width], pts + i * 5);
  });
  words.set([0, points.length], heads);
  f[heads + 2] = s;
  words[heads + 3] = 0;
  words.set([0, 0], gates);
  const b = g.device.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(b, 0, words);
  return b;
}

async function where(units: AgentUnits, ids: number[]): Promise<[number, number, number][]> {
  const raw = new Float32Array(await units.agents.readRaw('units'));
  return ids.flatMap((id) => {
    const u = units.recs.get(id);
    if (!u || !u.v.alive) return [];
    const o = (u.gpu % 8192) * 24;
    return [[raw[o], raw[o + 1], raw[o + 2]] as [number, number, number]];
  });
}

/** a column's walkable surfaces (agents.wgsl nav: z, and the six links — the neighbour's surface + 1, 0 none) */
async function navAt(w: Awaited<ReturnType<typeof world>>['w'], agents: Awaited<ReturnType<typeof world>>['agents'], x: number, y: number): Promise<string> {
  const nav = new Uint32Array(await agents.readRaw('nav'));
  const nf = new Float32Array(nav.buffer);
  const out: string[] = [];
  for (let k = 0; k < 4; k++) {
    const o = (w.core.ring.idx(x, y) * 4 + k) * 4;
    const z = nf[o];
    const y1 = nav[o + 1];
    if (!Number.isFinite(z) || (z === 0 && y1 === 0)) continue;
    const links = Array.from({ length: 6 }, (_, d) => (y1 >>> (9 + 3 * d)) & 7);
    out.push(`s${k} z ${z.toFixed(2)} head ${((y1 & 255) / 8).toFixed(1)} links ${links.join('')}`);
  }
  return `(${x},${y}) ${out.join(' | ') || 'none'}`;
}

/** the column made at x `from` on row 30 on the deck, sent to the market at x 12: `go` (its field) or `march` (the
 *  road's route in: x 120 → 12, on the deck at its height); where they end, arrived */
async function cross(name: string, decks: Deck[], island: [number, number] | null, how: 'go' | 'march', from = 88, deckWidth = 3) {
  const W0 = await world(decks, island);
  const { units, run } = W0;
  const z = (x: number) => deckAt(decks, x, ROW) ?? (x >= RIVER[0] && x <= RIVER[1] && !(island && x >= island[0] && x <= island[1]) ? BED : BANK);
  const at = (x: number): [number, number, number] => {
    const [px, py] = cellPos(x, ROW);
    return [px, py, z(x)];
  };
  // (the route's free width: 3, or on the deck what routes.wgsl freeWidth gives a deck point — it stops at a wet
  // column with no exception for a deck, so 0.5: one file)
  const pts = Array.from({ length: 109 }, (_, i) => ({ at: at(12 + i), width: deckAt(decks, 12 + i, ROW) !== null ? deckWidth : 3 }));
  units.usePlaces(fakePlaces({ [PLACE.barracks]: at(from), [PLACE.market]: at(12) }), null, () => fakeRoutes(pts));
  const gid = units.spawnAt!('soldier', 'f-town', { town: 0, place: PLACE.barracks }, 9);
  const arrived: number[] = [];
  units.arrived.push((x) => arrived.push(x));
  await run(30);
  const ids = units.members!(gid);
  const start = await where(units, ids);
  if (how === 'go') units.orderGroup!(gid, { kind: 'go', at: { town: 0, place: PLACE.market }, formation: 'column' });
  else units.orderGroup!(gid, { kind: 'march', town: 0, gate: 0, inward: true });
  let tick = 0;
  const trace: string[] = [];
  // (a march in walks out to the route's outer end first — x 120 — and back: ~100 cells more than a field's walk)
  await run(TPS * (how === 'march' ? 90 : 50), async () => {
    if (tick++ % 120) return arrived.includes(gid);
    const ps = await where(units, ids);
    const xs = ps.map(([x]) => x);
    const L = units.agents.mailLayout;
    const mail = new Uint32Array(await units.agents.readRaw('mail'));
    const mf = new Float32Array(mail.buffer);
    const F = L.groups + L.formAt;
    trace.push(`${(tick / TPS).toFixed(0)}s x ${Math.min(...xs).toFixed(0)}-${Math.max(...xs).toFixed(0)} st ${mail[F + 8]} s ${mf[F + 4].toFixed(1)} lag ${mf[F + 10].toFixed(1)}`);
    return arrived.includes(gid);
  });
  const end = await where(units, ids);
  const meanX = end.reduce((a, [x]) => a + x, 0) / Math.max(1, end.length);
  const ends = [...new Set(decks.flatMap((d) => [d.x0 - 1, d.x0, d.x1, d.x1 + 1]))];
  const navs = await Promise.all(ends.map((x) => navAt(W0.w, W0.agents, x, ROW)));
  log(`${name} (${how}): made at z ${start.map((p) => p[2].toFixed(1)).slice(0, 3).join(',')}…; ended at mean x ${meanX.toFixed(1)} (x ${Math.min(...end.map((p) => p[0])).toFixed(0)}-${Math.max(...end.map((p) => p[0])).toFixed(0)}), arrived ${arrived.includes(gid)}\n  ${trace.join('\n  ')}\n  ${navs.join('\n  ')}`);
  expect(g.takeErrors()).toEqual([]);
  return { arrived: arrived.includes(gid), meanX, n: end.length };
}

const A: Deck[] = [{ x0: 38, x1: 94, z0: BANK + 1, z1: BANK + 1 }];
const B: Deck[] = [{ x0: 38, x1: 94, z0: BANK + 1.6, z1: BANK + 1.6 }];
const C: Deck[] = [
  { x0: 38, x1: 64, z0: BANK + 1, z1: BANK + 1 },
  { x0: 69, x1: 94, z0: BANK + 1, z1: BANK + 1 },
];
const ISLAND: [number, number] = [65, 68];

test('LS-99 A: a column on a deck whose ends are a step over the banks walks off it to the market (go)', async () => {
  const r = await cross('A', A, null, 'go');
  expect(r.n).toBe(9);
  expect(r.arrived).toBe(true);
}, 400000);

test('LS-99 A: … and marching in along the road over the deck', async () => {
  const r = await cross('A', A, null, 'march');
  expect(r.arrived).toBe(true);
}, 400000);

test('LS-99 C: two decks with a dry island between them: the column walks off both to the market (go)', async () => {
  const r = await cross('C', C, ISLAND, 'go');
  expect(r.arrived).toBe(true);
}, 400000);

test('LS-99 C: … and marching in along the road over both decks', async () => {
  const r = await cross('C', C, ISLAND, 'march');
  expect(r.arrived).toBe(true);
}, 400000);

test('LS-99 C: marching in over both decks where the route is 0.5 wide on them (routes.wgsl freeWidth on a deck)', async () => {
  const r = await cross('C narrow', C, ISLAND, 'march', 88, 0.5);
  expect(r.arrived).toBe(true);
}, 400000);

test('LS-99 B: deck ends 1.6 over the banks (over the units\' step): logged, not asserted — the deck is cut off', async () => {
  const r = await cross('B', B, null, 'go');
  log(`B: arrived ${r.arrived}, mean x ${r.meanX.toFixed(1)}`);
}, 400000);
