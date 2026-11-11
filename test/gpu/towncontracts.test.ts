// (town contracts for Track B's U2/U3: docs/design/TOWN_CONTRACTS.md) The side map and the named-place table on Dawn.
// Side map: two towns' rings of wall claimed into a tiny world's columns (External rubble, as citygen claims them):
// inside a closed ring reads its town's side (slot + 1), outside reads 0, each town its own number; a breach (a piece's
// spans let go) or the gate rule set to open makes the inside one component with the outside — woken on the GPU by the
// chunks' versions and the CPU's input epoch, no readback deciding anything.
// Places: citygen-shaped records (a market, a keep district, houses, plazas, a ring with two gates) resolved on the GPU,
// read back through townplace.wgsl's own accessors in a probe kernel: stores, market, keep, barracks, muster, gates,
// spawn points, houses by (district, rank) in growth order whatever the record order, and the invalid ones.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { tinyMap } from '../support/tinymap';
import { MAT } from '../../src/world/materials';
import { cellPos } from '../../src/world/lattice';
import { TownContracts, SC, PC, type ContractTown } from '../../src/towncontracts/contracts';
import { PLACE, PLACE_STATUS } from '../../src/api/contracts/townplaces';
import townplaceWgsl from '../../src/shaders/townplace.wgsl?raw';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const ROW_H = Math.sqrt(3) / 2;
const RECW = 24;
const REC_LM = 32768;
const NB = 72;
const WB_V = 80;
const WB_KIND = 368;
const WB_ART = 440;
const WB_S = 512;
const AW = 20 + 2 * 128;

function buf(data: ArrayBufferView | ArrayBuffer): GPUBuffer {
  const bytes = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
  const b = g.device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  g.device.queue.writeBuffer(b, 0, data instanceof ArrayBuffer ? data : (data as ArrayBufferView & ArrayLike<number>));
  return b;
}

/** a ring of NB corners round (cx, cy) of radius r; gate segments where arterials (directions) cross it, or `gates` */
function ringWords(cx: number, cy: number, r: number, arts: [number, number][], gates?: number[], ground = 10): { words: Uint32Array; corners: [number, number][]; kind: number[] } {
  const words = new Uint32Array(600);
  const wf = new Float32Array(words.buffer);
  const V: [number, number][] = [];
  for (let b = 0; b < NB; b++) {
    const a = ((b + 0.5) / NB) * 2 * Math.PI - Math.PI;
    V.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    wf[WB_V + 2 * b] = V[b][0];
    wf[WB_V + 2 * b + 1] = V[b][1];
    // (each corner's ground: the piece's foot is 0.4 under it)
    wf[296 + b] = ground;
  }
  let first = -1;
  let n = 0;
  for (let b = 0; b < NB; b++) {
    const p = V[b];
    const q = V[(b + 1) % NB];
    arts.forEach((e, k) => {
      const d = [e[0] - cx, e[1] - cy];
      const s = [q[0] - p[0], q[1] - p[1]];
      const den = d[0] * s[1] - d[1] * s[0];
      if (Math.abs(den) < 1e-9) return;
      const t = ((p[0] - cx) * s[1] - (p[1] - cy) * s[0]) / den;
      const v = ((p[0] - cx) * d[1] - (p[1] - cy) * d[0]) / den;
      if (t < 0 || t > 1 || v < 0 || v > 1) return;
      words[WB_KIND + b] = 1;
      words[WB_ART + b] = k + 1;
      wf[WB_S + b] = t * Math.hypot(d[0], d[1]);
      n++;
      if (first < 0) first = b;
    });
  }
  for (const b of gates ?? []) {
    words[WB_KIND + b] = 1;
    if (first < 0) first = b;
    n++;
  }
  words[0] = 1;
  words[1] = n;
  words[2] = Math.max(first, 0);
  // (risen: the stage to 1 long ago)
  wf.set([1, 1, -1e9], 4);
  return { words, corners: V, kind: [...words.slice(WB_KIND, WB_KIND + NB)] };
}

function artWords(cx: number, cy: number, ends: [number, number][], lim: number): Uint32Array {
  const art = new Uint32Array(4 + 8 * AW);
  const af = new Float32Array(art.buffer);
  art[0] = ends.length;
  ends.forEach((e, k) => {
    const o = 4 + k * AW;
    const L = Math.hypot(e[0] - cx, e[1] - cy);
    art[o] = 2;
    af[o + 1] = L;
    af[o + 3] = lim;
    af.set([cx, cy, e[0], e[1]], o + 20);
  });
  return art;
}

/** a ContractTown over hand-made buffers (citygen's contract shapes) */
function fakeTown(id: string, o: { w: number; h: number; centre: [number, number]; R: number; wall: Uint32Array; art?: Uint32Array; records?: ArrayBuffer; n?: number; progress?: Float32Array; pop?: Float32Array; heights?: number; place?: { dx: number; dy: number; dz: number } }): ContractTown {
  const N = o.w * o.h;
  return {
    site: { id },
    box: { w: o.w, h: o.h, R: o.R },
    centre: o.centre,
    lots: { records: buf(o.records ?? new Uint32Array(4)), counts: buf(new Uint32Array([o.n ?? 0, 0, RECW, REC_LM])), progress: buf(o.progress ?? new Float32Array(4)), place: buf(new Float32Array(4)) },
    routes: { roads: buf(new Uint32Array(N)), heights: buf(new Float32Array(N).fill(o.heights ?? 10)), wet: buf(new Float32Array(N)), pop: buf(o.pop ?? new Float32Array(N * 4)), art: buf(o.art ?? new Uint32Array(4 + 8 * AW)), wall: buf(o.wall) },
    times: { lots: o.n ?? 0 },
    gridPlace: () => o.place ?? { dx: 0, dy: 0, dz: 0 },
  };
}

/** frames until the side map has been solved `want` times (or throws) */
async function solve(w: TinyWorld, tc: TownContracts, towns: ContractTown[], want: number): Promise<Uint32Array> {
  for (let f = 0; f < 200; f++) {
    tc.setTowns(towns, 0);
    const enc = g.device.createCommandEncoder();
    tc.encode(enc);
    g.device.queue.submit([enc.finish()]);
    if (f % 4 === 3) {
      const c = await tc.debugRead('ctl');
      if (c[SC.solves] >= want && c[SC.state] === 0) return c;
    }
  }
  throw new Error(`the side map wasn't solved ${want} times in 200 frames`);
}

describe('the side map', () => {
  const W = 128;
  const H = 64;
  const R = 14;
  const A: [number, number] = [32, 32 * ROW_H + 0.5 * ROW_H];
  const B: [number, number] = [96, 32 * ROW_H + 0.5 * ROW_H];

  /** the wall's columns round a ring (a piece's band, as citygen's wallCols: centre within 1.35), not its gates */
  function wallCols(corners: [number, number][], kind: number[]): [number, number][] {
    const out: [number, number][] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [px, py] = cellPos(x, y);
        for (let b = 0; b < NB; b++) {
          if (kind[b] !== 0) continue;
          const a = corners[b];
          const q = corners[(b + 1) % NB];
          const ab = [q[0] - a[0], q[1] - a[1]];
          const t = Math.max(0, Math.min(1, ((px - a[0]) * ab[0] + (py - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)));
          if (Math.hypot(px - a[0] - ab[0] * t, py - a[1] - ab[1] * t) <= 1.35) {
            out.push([x, y]);
            break;
          }
        }
      }
    return out;
  }

  it('inside a closed ring reads its town, outside 0; each town its own; a breach or an open gate joins them', async () => {
    const w = await tinyWorld(g, tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), ['surface']);
    try {
      // (town A: a gate east, five segments wide; town B: closed all round)
      const ra = ringWords(A[0], A[1], R, [], [33, 34, 35, 36, 37]);
      const rb = ringWords(B[0], B[1], R, []);
      // (B's ring left open over water at segments 10–12, as citygen leaves it: no piece there, and still closed)
      for (const b of [10, 11, 12]) rb.words[WB_KIND + b] = 2;
      rb.kind.splice(10, 3, 2, 2, 2);
      const cols = [...wallCols(ra.corners, ra.kind), ...wallCols(rb.corners, rb.kind)];
      // (the wall claimed as citygen claims it: External rubble spans, 4.5 high over the ground at 10)
      w.core.stampColumns([{ cuts: [], claim: cols.map(([x, y]) => ({ x, y, z0: 10, z1: 14.5, aux: MAT.Rubble })) }]);
      await w.step(2);
      const ta = fakeTown('A', { w: W, h: H, centre: A, R, wall: ra.words });
      const tb = fakeTown('B', { w: W, h: H, centre: B, R, wall: rb.words });
      const tc = new TownContracts(g.device, { globals: w.core.world.globals, chunks: w.core.world.chunks, layers: w.core.world.layers, water: w.core.world.water, w: W, h: H }, w.core.world.buf('agentSides', W * H * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC));
      const at = (s: Uint32Array, p: [number, number]) => {
        const y = Math.round(p[1] / ROW_H - 0.5);
        const x = Math.round(p[0] - 0.5 - 0.5 * (y & 1));
        return s[y * W + x];
      };
      let c = await solve(w, tc, [ta, tb], 1);
      let s = await tc.debugRead('sides');
      expect(g.takeErrors()).toEqual([]);
      const solves0 = c[SC.solves];
      expect(at(s, A), 'inside A').toBe(1);
      expect(at(s, [A[0] - 6, A[1] + 3]), 'inside A, off centre').toBe(1);
      expect(at(s, B), 'inside B').toBe(2);
      expect(s[2 * W + 2], 'outside').toBe(0);
      expect(at(s, [64, A[1]]), 'between the towns').toBe(0);
      // (settled: no new solve while nothing changes)
      c = await solve(w, tc, [ta, tb], solves0);
      for (let f = 0; f < 12; f++) {
        tc.setTowns([ta, tb], 0);
        const enc = g.device.createCommandEncoder();
        tc.encode(enc);
        g.device.queue.submit([enc.finish()]);
      }
      expect((await tc.debugRead('ctl'))[SC.solves], 'idle: no solve without a change').toBe(solves0);
      // (the gate open: A's inside joins the outside; B's stays)
      tc.gates = 'open';
      await solve(w, tc, [ta, tb], solves0 + 1);
      s = await tc.debugRead('sides');
      expect(at(s, A), 'A open at its gate').toBe(0);
      expect(at(s, B), 'B still closed').toBe(2);
      tc.gates = 'closed';
      c = await solve(w, tc, [ta, tb], solves0 + 2);
      s = await tc.debugRead('sides');
      expect(at(s, A)).toBe(1);
      // (a breach: B's west piece's spans let go — the chunks' versions wake the solve)
      const west = wallCols(rb.corners, rb.kind).filter(([x, y]) => cellPos(x, y)[0] < B[0] - R + 1.5 && Math.abs(cellPos(x, y)[1] - B[1]) < 2.5);
      expect(west.length).toBeGreaterThan(3);
      w.core.stampColumns([{ cuts: [], release: west.map(([x, y]) => ({ x, y, z0: 10, z1: 14.5, fallback: 0, toAir: true })) }]);
      await w.step(2);
      c = await solve(w, tc, [ta, tb], c[SC.solves] + 1);
      s = await tc.debugRead('sides');
      expect(g.takeErrors()).toEqual([]);
      expect(at(s, B), 'B breached').toBe(0);
      expect(at(s, A), 'A untouched').toBe(1);
      console.log(`[towncontracts] side map solves ${c[SC.solves]}, last ${c[SC.lastRounds]} rounds`);
      tc.dispose();
    } finally {
      w.destroy();
    }
  }, 120_000);
});

describe('the named places', () => {
  const W = 96;
  const H = 96;
  const C: [number, number] = [48, 48 * ROW_H];

  /** the probe: townplace.wgsl's own accessors read into a buffer (town slot 0) */
  async function readTable(tc: TownContracts) {
    const probe = /* wgsl */ `
@group(0) @binding(58) var<storage, read_write> OUT: array<f32>;
@compute @workgroup_size(1)
fn main() {
  for (var p = 0u; p < 24u; p++) {
    let o = p * 8u;
    OUT[o] = f32(placeStatus(0u, p));
    let a = place(0u, p);
    let b = placeApproach(0u, p);
    OUT[o + 1u] = a.x; OUT[o + 2u] = a.y; OUT[o + 3u] = a.z;
    OUT[o + 4u] = b.x; OUT[o + 5u] = b.y; OUT[o + 6u] = f32(placeAux(0u, p));
    OUT[o + 7u] = select(0.0, 1.0, placeValid(0u, p));
  }
  for (var r = 0u; r < 6u; r++) {
    let h = houseAt(0u, 3u, r);
    OUT[200u + r * 2u] = f32(lotSeedOf(0u, h));
    OUT[201u + r * 2u] = f32(lotStatus(0u, h));
  }
  OUT[220u] = f32(lotCount(0u, 3u, 1u));
  OUT[221u] = f32(select(districtPurpose(0u, 2u), districtPurpose(0u, 7u), lotCount(0u, 7u, 1u) > 0u));
  OUT[222u] = f32(lotCount(0u, 4u, 3u));
  OUT[223u] = f32(placeStatus(1u, 0u));
  OUT[224u] = select(0.0, 1.0, townLive(0u));
  let h0 = lotAt(0u, 4u, 3u, 0u);
  OUT[225u] = f32(lotSeedOf(0u, h0));
}`;
    const k = makeCompute(g.device, 'townplace probe', [townplaceWgsl, probe], { 57: 'read', 58: 'rw' }, 'main');
    const out = g.device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const e2 = g.device.createCommandEncoder();
    const ps = e2.beginComputePass();
    ps.setPipeline(k.pipeline);
    ps.setBindGroup(0, makeBindGroup(g.device, 'probe', k.layout, { 57: tc.places, 58: out }));
    ps.dispatchWorkgroups(1);
    ps.end();
    const st = g.device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    e2.copyBufferToBuffer(out, 0, st, 0, 256 * 4);
    g.device.queue.submit([e2.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const r = new Float32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    out.destroy();
    const named = (p: number) => ({ status: r[p * 8], at: [r[p * 8 + 1], r[p * 8 + 2], r[p * 8 + 3]], approach: [r[p * 8 + 4], r[p * 8 + 5]], aux: r[p * 8 + 6], valid: r[p * 8 + 7] === 1 });
    return { named, r };
  }

  async function resolve(withKeep: boolean, ringMade = true, roles?: Record<number, number>) {
    const s = await townSetup(withKeep, ringMade, roles);
    try {
      const { tc, t, place } = s;
      tc.setTowns([t], 0);
      const enc = g.device.createCommandEncoder();
      tc.encode(enc);
      g.device.queue.submit([enc.finish()]);
      const { named, r } = await readTable(tc);
      expect(g.takeErrors()).toEqual([]);
      tc.dispose();
      return { named, r, place };
    } finally {
      s.w.destroy();
    }
  }

  /** a town of citygen-shaped records over a tiny world, its contracts made (not yet run) */
  async function townSetup(withKeep: boolean, ringMade = true, roles?: Record<number, number>, opts: { stage?: [number, number, number] } = {}) {
    // (UC-13: the window holds the spawn points and their roads — the east one at x 93, the north one at row 94 — and its
    // ground is where the table's z says: the grid's 10 + dz 1.5)
    const w = await tinyWorld(g, tinyMap(128, 96, 32, () => [{ z0: 0, z1: 11.5, mat: MAT.Stone }]), ['surface']);
    {
      const rec = new ArrayBuffer((REC_LM + 64) * RECW * 4);
      const ru = new Uint32Array(rec);
      const rf = new Float32Array(rec);
      const progress = new Float32Array(REC_LM + 64);
      const pop = new Float32Array(W * H * 4);
      let n = 0;
      const lot = (x0: number, y0: number, x1: number, y1: number, kind: number, district: number, purpose: number, height: number, key: number, seed: number, p = 1) => {
        const o = n * RECW;
        rf.set([x0 - 1, y0 - 1, x1 + 1, y0 - 1, x1 + 1, y1 + 1, x0 - 1, y1 + 1], o);
        rf.set([x0, y0, x1, y0, x1, y1, x0, y1], o + 8);
        ru[o + 16] = 0;
        ru[o + 17] = kind;
        ru[o + 18] = district;
        ru[o + 19] = height > 0 ? Math.max(1, Math.round(height / 3)) : 0;
        rf[o + 20] = height;
        rf[o + 21] = 9.5;
        rf[o + 22] = key;
        ru[o + 23] = seed;
        progress[n] = p;
        // (the population field's purpose over the lot)
        for (let y = Math.floor(y0 / ROW_H) - 1; y <= Math.ceil(y1 / ROW_H) + 1; y++) for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) if (x >= 0 && y >= 0 && x < W && y < H) pop[(y * W + x) * 4 + 2] = purpose;
        n++;
      };
      // (houses first in record order, their growth keys shuffled: ranks must follow the keys, then the seeds)
      const keys = [0.5, 0.1, 0.3, 0.9, 0.2];
      keys.forEach((k, i) => lot(10 + i * 6, 70, 14 + i * 6, 74, 1, 3, 0, 6, k, 300 + i, i === 3 ? 0 : i === 2 ? 0.5 : 1));
      // (the market district: two buildings and a plaza; a homes building nearer the centre than either)
      lot(46, 36, 50, 40, 1, 1, 1, 6, 0.1, 100);
      lot(60, 36, 64, 40, 1, 1, 1, 6, 0.1, 101);
      lot(52, 46, 58, 50, 3, 1, 1, 0, 0.1, 102);
      lot(47, 42, 49, 43, 1, 0, 0, 6, 0.1, 103);
      // (a keep district: the tallest is the keep, the biggest of the rest the barracks)
      if (withKeep) {
        lot(28, 56, 32, 60, 1, 2, 5, 12, 0.2, 200);
        lot(34, 56, 42, 62, 1, 2, 5, 8, 0.2, 201);
        lot(22, 56, 27, 61, 1, 2, 5, 6, 0.2, 202);
      }
      // (a district the population field calls homes: the keep's when a keep card claimed it — `roles`)
      if (roles) lot(10, 82, 16, 88, 1, 7, 0, 9, 0.2, 700);
      // (plazas: one inside the ring near the east gate — the muster yard — one farther, one outside the ring nearer)
      lot(66, 40, 70, 44, 3, 4, 0, 0, 0.3, 400);
      lot(36, 28, 40, 32, 3, 4, 0, 0, 0.3, 401);
      lot(80, 40, 84, 44, 3, 5, 0, 0, 0.3, 402);
      const ring = ringWords(C[0], C[1], 30, [[95, C[1]], [C[0], 94 * ROW_H]]);
      if (!ringMade) ring.words[0] = 0;
      // (the wall's stage: from, to, its start on the towns' clock — risen long ago unless given)
      if (opts.stage) new Float32Array(ring.words.buffer).set(opts.stage, 4);
      const art = artWords(C[0], C[1], [[95, C[1]], [C[0], 94 * ROW_H]], 25);
      const place = { dx: 4, dy: 2, dz: 1.5 };
      const t = fakeTown('T', { w: W, h: H, centre: C, R: 40, wall: ring.words, art, records: rec, n, progress, pop, place });
      const tc = new TownContracts(g.device, { globals: w.core.world.globals, chunks: w.core.world.chunks, layers: w.core.world.layers, water: w.core.world.water, w: 128, h: 96 }, w.core.world.buf('agentSides', 128 * 96 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST), { roles: () => roles });
      return { w, t, tc, place, ring, progress, n };
    }
  }

  it('resolves the named places, the gates, the spawn points and the houses by rank', async () => {
    const { named, r, place } = await resolve(true);
    const ox = place.dx;
    const oy = place.dy * ROW_H;
    // (the stores: the market district's building nearest the centre, not the nearer homes building)
    expect(named(PLACE.stores).valid).toBe(true);
    expect(named(PLACE.stores).aux).toBe(100);
    // (its door: on its frontage (edge 0, the south face y 36) just outside, in the window; z the ground + dz)
    expect(named(PLACE.stores).at[0]).toBeCloseTo(48 + ox, 3);
    expect(named(PLACE.stores).at[1]).toBeCloseTo(36 - 0.6 + oy, 3);
    expect(named(PLACE.stores).at[2]).toBeCloseTo(10 + 1.5, 3);
    expect(named(PLACE.stores).approach[1]).toBeCloseTo(35 + oy, 3);
    // (the market: the open plaza of the market district)
    expect(named(PLACE.market).aux).toBe(102);
    expect(named(PLACE.keep).aux).toBe(200);
    expect(named(PLACE.barracks).aux).toBe(201);
    // (the muster yard: open land inside the ring nearest its first gate — not the nearer plaza outside the ring)
    expect(named(PLACE.muster).valid).toBe(true);
    expect(named(PLACE.muster).aux).toBe(400);
    // (gate 0: the east arterial's crossing, on its road; gate 1 the north's; the rest none)
    const g0 = named(PLACE.gate0);
    expect(g0.valid).toBe(true);
    expect(g0.at[0]).toBeCloseTo(48 + 30 * Math.cos(Math.PI / 72) + ox, 0);
    expect(g0.at[1]).toBeCloseTo(C[1] + oy, 3);
    expect(g0.approach[0]).toBeLessThan(g0.at[0]);
    expect(named(PLACE.gate0 + 1).valid).toBe(true);
    for (let k = 2; k < 10; k++) expect(named(PLACE.gate0 + k).status).toBe(PLACE_STATUS.none);
    // (spawn 0: the east road past the limit, 25 + 16 along)
    expect(named(PLACE.spawn0).valid).toBe(true);
    expect(named(PLACE.spawn0).at[0]).toBeCloseTo(48 + 41 + ox, 2);
    expect(named(PLACE.spawn0 + 1).valid).toBe(true);
    expect(named(PLACE.spawn0 + 2).status).toBe(PLACE_STATUS.none);
    // (houses of district 3 by rank: growth keys 0.1, 0.2, 0.3, 0.5, 0.9 → seeds 301, 304, 302, 300, 303)
    expect(r[220]).toBe(5);
    expect([0, 1, 2, 3, 4].map((k) => r[200 + k * 2])).toEqual([301, 304, 302, 300, 303]);
    expect([0, 1, 2, 3, 4].map((k) => r[201 + k * 2])).toEqual([PLACE_STATUS.ok, PLACE_STATUS.ok, PLACE_STATUS.rising, PLACE_STATUS.ok, PLACE_STATUS.none]);
    expect(r[201 + 5 * 2]).toBe(PLACE_STATUS.none);
    expect(r[221]).toBe(5);
    expect(r[222]).toBe(2);
    expect(r[223]).toBe(PLACE_STATUS.noTown);
    expect(r[224]).toBe(1);
    expect(r[225]).toBe(400);
  }, 120_000);

  it('a place not built is invalid: no keep card, no barracks; no ring, no muster yard or gates', async () => {
    const a = await resolve(false);
    expect(a.named(PLACE.keep).status).toBe(PLACE_STATUS.none);
    expect(a.named(PLACE.barracks).status).toBe(PLACE_STATUS.none);
    expect(a.named(PLACE.stores).valid).toBe(true);
    const b = await resolve(true, false);
    expect(b.named(PLACE.muster).status).toBe(PLACE_STATUS.none);
    expect(b.named(PLACE.gate0).status).toBe(PLACE_STATUS.none);
    expect(b.named(PLACE.keep).valid).toBe(true);
    // (the keep card's district: claimed for the keep — an input, the district's id and purpose — though its ground
    // says homes)
    const c = await resolve(false, true, { 7: 5 });
    expect(c.named(PLACE.keep).aux).toBe(700);
    expect(c.r[221]).toBe(5);
  }, 120_000);

  // (UC-8) the place table re-solved only when what it reads changes: woken on the GPU, its uniform written only when its
  // contents change
  async function frames(tc: TownContracts, t: ContractTown, now: number | ((f: number) => number), n: number) {
    for (let f = 0; f < n; f++) {
      tc.setTowns([t], typeof now === 'number' ? now : now(f));
      const enc = g.device.createCommandEncoder();
      tc.encode(enc);
      g.device.queue.submit([enc.finish()]);
    }
    return (await tc.debugRead('pctl'))[PC.solves];
  }

  it('solves only on a change: a lot rising, a ring change, a slide — one solve each, the table right after', async () => {
    const s = await townSetup(true);
    const { tc, t, place, ring } = s;
    // (the CPU's writes to the town's place uniform, counted)
    const q = g.device.queue;
    const write0 = q.writeBuffer.bind(q);
    let uWrites = 0;
    q.writeBuffer = ((b: GPUBuffer, ...rest: unknown[]) => {
      if (b.label === 'town places T') uWrites++;
      return (write0 as (...a: unknown[]) => void)(b, ...rest);
    }) as typeof q.writeBuffer;
    try {
      expect(await frames(tc, t, 0, 1), 'the first frame solves').toBe(1);
      expect(await frames(tc, t, 0, 12), 'idle: no solve').toBe(1);
      expect(uWrites, 'the uniform written once').toBe(1);
      let tab = await readTable(tc);
      expect(tab.r[201 + 4 * 2], 'seed 303 not begun').toBe(PLACE_STATUS.none);
      // (a card's lot begins rising: house 303 (record 3) to 0.5 — one solve; rising further within the class: none)
      q.writeBuffer(t.lots.progress, 3 * 4, new Float32Array([0.5]));
      expect(await frames(tc, t, 0, 4), 'a lot rising: one solve').toBe(2);
      tab = await readTable(tc);
      expect(tab.r[200 + 4 * 2]).toBe(303);
      expect(tab.r[201 + 4 * 2], 'seed 303 rising').toBe(PLACE_STATUS.rising);
      q.writeBuffer(t.lots.progress, 3 * 4, new Float32Array([0.7]));
      expect(await frames(tc, t, 0, 4), 'still rising: no solve').toBe(2);
      q.writeBuffer(t.lots.progress, 3 * 4, new Float32Array([1]));
      expect(await frames(tc, t, 0, 4), 'built: one solve').toBe(3);
      expect((await readTable(tc)).r[201 + 4 * 2]).toBe(PLACE_STATUS.ok);
      // (a ring change: a filler gate at segment 10 — gate slot 8 valid after one solve)
      expect(tab.named(PLACE.gate0 + 8).status).toBe(PLACE_STATUS.none);
      ring.words[WB_KIND + 10] = 1;
      q.writeBuffer(t.routes.wall, 0, ring.words);
      expect(await frames(tc, t, 0, 4), 'a ring change: one solve').toBe(4);
      tab = await readTable(tc);
      expect(tab.named(PLACE.gate0 + 8).status).toBe(PLACE_STATUS.ok);
      expect(tab.named(PLACE.gate0 + 8).aux).toBe(10);
      // (a slide: the grid 6 columns on — one solve, every place moved with it)
      const before = tab.named(PLACE.stores).at[0];
      const w0 = uWrites;
      place.dx += 6;
      expect(await frames(tc, t, 0, 4), 'a slide: one solve').toBe(5);
      expect(uWrites - w0, 'the uniform written once for the slide').toBe(1);
      tab = await readTable(tc);
      expect(tab.named(PLACE.stores).at[0]).toBeCloseTo(before + 6, 3);
      expect(tab.named(PLACE.stores).aux).toBe(100);
      // (the clock moving with no wall rising: no solve, no uniform write)
      expect(await frames(tc, t, (f) => 100 + f, 12), 'the clock alone: no solve').toBe(5);
      expect(uWrites - w0).toBe(1);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      q.writeBuffer = write0;
      tc.dispose();
      s.w.destroy();
    }
  }, 120_000);

  // (UC-13) a spawn point stands on dry, walkable ground in the window: Muru's spawn point 0 had its approach in the
  // river, and raiders drowned on arrival. One arterial east from (20, row 30) to the window's edge, its limit 10 along:
  // the nominal spawn point at x 46, its approach at x 38
  async function spawnSetup(band: [number, number] | null) {
    const W2 = 128;
    const H2 = 64;
    const map = tinyMap(W2, H2);
    if (band) for (let y = 0; y < H2; y++) for (let x = band[0]; x <= band[1]; x++) map.water[y * W2 + x] = 2;
    const w = await tinyWorld(g, map, ['surface']);
    const cy = 30 * ROW_H + 0.5 * ROW_H;
    const ring = ringWords(20, cy, 8, []);
    ring.words[0] = 0;
    const t = fakeTown('S', { w: W2, h: H2, centre: [20, cy], R: 20, wall: ring.words, art: artWords(20, cy, [[127, cy]], 10), heights: 10 });
    const tc = new TownContracts(g.device, { globals: w.core.world.globals, chunks: w.core.world.chunks, layers: w.core.world.layers, water: w.core.world.water, w: W2, h: H2 }, w.core.world.buf('agentSides', W2 * H2 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST));
    return { w, t, tc, cy };
  }

  it('a spawn point over water moves out along its road to dry ground, or reads WATER', async () => {
    // (a river 5 columns wide under the nominal approach: the spawn point moves out until its approach and the crowd's
    // ring round it (3 units) are past the far bank)
    const a = await spawnSetup([36, 40]);
    try {
      expect(await frames(a.tc, a.t, 0, 2)).toBe(1);
      const s0 = (await readTable(a.tc)).named(PLACE.spawn0);
      expect(s0.valid).toBe(true);
      expect(s0.at[0]).toBeGreaterThan(46);
      expect(s0.approach[0]).toBeGreaterThan(40.5 + 3);
      expect(s0.approach[0]).toBeLessThan(40.5 + 3 + 2);
      expect(s0.at[0] - s0.approach[0]).toBeCloseTo(8, 3);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      a.tc.dispose();
      a.w.destroy();
    }
    // (water the whole bounded search along: WATER — a season's chain goes on to its next spawn point)
    const b = await spawnSetup([36, 100]);
    try {
      expect(await frames(b.tc, b.t, 0, 2)).toBe(1);
      const s0 = (await readTable(b.tc)).named(PLACE.spawn0);
      expect(s0.status).toBe(PLACE_STATUS.water);
      expect(s0.valid).toBe(false);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      b.tc.dispose();
      b.w.destroy();
    }
  }, 120_000);

  it('the water rising under a spawn point wakes one solve (within WET_GAP frames), not one a frame', async () => {
    const s = await spawnSetup(null);
    try {
      expect(await frames(s.tc, s.t, 0, 2)).toBe(1);
      expect((await readTable(s.tc)).named(PLACE.spawn0).at[0]).toBeCloseTo(46, 3);
      // (a flood: the river under the approach, written into the world's water — its ring-paged columns)
      const ring = s.w.core.ring;
      for (let y = 0; y < 64; y++) for (let x = 36; x <= 40; x++) g.device.queue.writeBuffer(s.w.core.world.water, ring.idx(x, y) * 4, new Float32Array([2]));
      expect(await frames(s.tc, s.t, 0, 130), 'the flood: one solve').toBe(2);
      const s0 = (await readTable(s.tc)).named(PLACE.spawn0);
      expect(s0.valid).toBe(true);
      expect(s0.approach[0]).toBeGreaterThan(40.5 + 3);
      expect(await frames(s.tc, s.t, 0, 130), 'still: no solve').toBe(2);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      s.tc.dispose();
      s.w.destroy();
    }
  }, 120_000);

  it('a gate whose wall is rising wakes a solve when the clock passes its rise, not before', async () => {
    // (the wall's stage 0 → 1 from clock 10 over its span: both gates rising at 0, the first up before the second)
    const s = await townSetup(true, true, undefined, { stage: [0, 1, 10] });
    const { tc, t } = s;
    try {
      expect(await frames(tc, t, 0, 3)).toBe(1);
      let tab = await readTable(tc);
      expect(tab.named(PLACE.gate0).status).toBe(PLACE_STATUS.rising);
      expect(tab.named(PLACE.gate0 + 1).status).toBe(PLACE_STATUS.rising);
      // (the clock a quarter second a frame to 25: past the stage's span — each gate's flip one solve)
      const seen: number[] = [];
      for (let k = 0; k < 100; k++) seen.push(await frames(tc, t, k * 0.25, 1));
      expect(seen[seen.length - 1], 'two flips: two solves').toBe(3);
      expect(seen.indexOf(2), 'the first gate up after the stage began').toBeGreaterThan(40);
      expect(seen.indexOf(3)).toBeGreaterThan(seen.indexOf(2));
      tab = await readTable(tc);
      expect(tab.named(PLACE.gate0).status).toBe(PLACE_STATUS.ok);
      expect(tab.named(PLACE.gate0 + 1).status).toBe(PLACE_STATUS.ok);
      expect(g.takeErrors()).toEqual([]);
    } finally {
      tc.dispose();
      s.w.destroy();
    }
  }, 120_000);
});
