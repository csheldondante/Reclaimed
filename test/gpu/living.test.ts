// (living town LT2, docs/design/LIVING_TOWN.md) The route graph from a citygen-shaped road raster on the GPU, the hubs'
// fields settled with no readback, routes traced and shared, riders on kinematic trips: on a 96 × 96 box with a
// crossroads (a bridge deck on the west arm), homes along the east-west road and a market district east. Commuters ride
// home → market → home; a commuter from the west rides the deck at its height; builders go to the two sites rising.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { LivingTown, C, L_C, LT_WORDS, ROUTE_HEAD_WORDS } from '../../src/citylife/living';
import { LIVING_TUNING } from '../../src/citylife/params';
import { Works } from '../../src/citylife/works';
import routereadWgsl from '../../src/shaders/routeread.wgsl?raw';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';
import { GLOBALS_BYTES } from '../../src/sim/globals';
import { packMaterialTable } from '../../src/world/materials';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const H = 96;
const ROW_H = Math.sqrt(3) / 2;
const RECW = 24;
const LOT_ROOM = 64;
const DECK_BIT = 0x80000000;

async function rideTown(ptsRoom?: number, wall = false): Promise<Uint32Array> {
  const dev = g.device;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (data: ArrayBufferView) => {
    const b = dev.createBuffer({ size: Math.max(16, data.byteLength), usage: S });
    dev.queue.writeBuffer(b, 0, data);
    return b;
  };
  const N = W * H;
  // (the road raster: row 48 east-west, column 48 north-south; the west arm's x 8..20 a deck at z 7)
  const roads = new Uint32Array(N);
  for (let x = 0; x < W; x++) roads[48 * W + x] = x >= 8 && x <= 20 ? (DECK_BIT | (7 * 256)) >>> 0 : 1;
  for (let y = 0; y < H; y++) roads[y * W + 48] = 1;
  // (an orphan street: a stub of road joined to nothing, with a building on it — the check must lay its passage)
  for (let x = 70; x < 90; x++) roads[80 * W + x] = 1;
  const heights = new Float32Array(N).fill(2);
  // (season life: the town wall, its ring not made yet — its columns in the raster as citygen claims them)
  // (the wall's columns kept aside: drawn into the raster after the first routes are traced, as citygen claims them
  // when the wall rises — the graph made again then)
  const marked = roads.slice();
  const wallData = wall ? makeWall(marked, false, 0) : null;
  const roadsBuf = mk(roads);
  const wallBuf = wallData ? mk(wallData.words) : undefined;
  // (the population field: market east of x 60, homes elsewhere)
  const pop = new Float32Array(N * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pop[(y * W + x) * 4 + 2] = x > 60 ? 1 : 0;
  // (lots: 20 buildings north of the east-west road, fronting it (edge 0 faces south), x 2..90 every 4.5)
  const rec = new ArrayBuffer((LOT_ROOM + 64) * RECW * 4);
  const ru = new Uint32Array(rec);
  const rf = new Float32Array(rec);
  const yRoad = (48 + 0.5) * ROW_H;
  let n = 0;
  for (let k = 0; k < 20; k++) {
    const x0 = 2 + k * 4.5;
    if (x0 > 44 && x0 < 52) continue;
    const x1 = x0 + 3.5;
    const y0 = yRoad + 1.4;
    const y1 = y0 + 5;
    const o = n * RECW;
    rf.set([x0, y0, x1, y0, x1, y1, x0, y1], o);
    rf.set([x0 + 0.4, y0 + 1, x1 - 0.4, y0 + 1, x1 - 0.4, y1 - 0.4, x0 + 0.4, y1 - 0.4], o + 8);
    ru[o + 16] = 0;
    ru[o + 17] = 1;
    ru[o + 19] = 2;
    rf[o + 20] = 6;
    rf[o + 21] = 2;
    ru[o + 23] = 1000 + k;
    n++;
  }
  {
    // (the orphan street's building, fronting it from the north)
    const yR = (80 + 0.5) * ROW_H;
    const x0 = 76;
    const x1 = 79.5;
    const y0 = yR + 1.4;
    const y1 = y0 + 5;
    const o = n * RECW;
    rf.set([x0, y0, x1, y0, x1, y1, x0, y1], o);
    rf.set([x0 + 0.4, y0 + 1, x1 - 0.4, y0 + 1, x1 - 0.4, y1 - 0.4, x0 + 0.4, y1 - 0.4], o + 8);
    ru[o + 16] = 0;
    ru[o + 17] = 1;
    ru[o + 19] = 2;
    rf[o + 20] = 6;
    rf[o + 21] = 2;
    ru[o + 23] = 2000;
    n++;
  }
  const progress = new Float32Array(LOT_ROOM + 64).fill(1);
  progress[3] = 0.4;
  progress[10] = 0.6;
  const town = new LivingTown(dev, {
    w: W,
    h: H,
    roads: roadsBuf,
    heights: mk(heights),
    wet: mk(new Uint32Array(N)),
    pop: mk(pop),
    art: mk(wallData ? wallData.art : new Uint32Array(4 + 8 * 276)),
    wall: wallBuf,
    records: mk(ru),
    counts: mk(new Uint32Array([n, 0, RECW, LOT_ROOM])),
    progress: mk(progress),
    lotRoom: LOT_ROOM,
    centre: [48, 48 * ROW_H],
    radius: 40,
  }, LIVING_TUNING.values, ptsRoom);
  const p = LIVING_TUNING.values;
  Object.assign(p.people, { commuters: 60, farmers: 0, quarrymen: 0, stoneCarts: 0, woodcutters: 0, logCarts: 0, builders: 6, work: 2, speed: 1, spread: 0 });
  p.quarry.on = 0;
  p.forest.on = 0;
  const place = { dx: 0, dy: 0, dz: 0, winW: W, winH: H };
  for (let f = 0; f < 900; f++) {
    const enc = dev.createCommandEncoder();
    town.frame(enc, 0.1, place);
    dev.queue.submit([enc.finish()]);
    if (f % 100 === 99) await dev.queue.onSubmittedWorkDone();
  }
  const head = (await town.counters())!;
  expect(g.takeErrors()).toEqual([]);
  const c = (k: keyof typeof C) => head[L_C + C[k]];
  // (settled, routes traced, nobody without a route)
  expect(head[0]).toBe(4);
  expect(c('traced')).toBeGreaterThan(10);
  expect(c('miss')).toBe(0);
  // (the connectivity check: the orphan street joined by a passage, nothing left cut off, every built door reached)
  expect(c('passages')).toBeGreaterThan(0);
  expect(c('cutLeft')).toBe(0);
  expect(c('doorsCut')).toBe(0);
  expect(c('poolFull')).toBe(0);
  expect(c('arrivals')).toBeGreaterThan(60);
  // (shared: fewer routes than riders' trips — a home's route is one key however many ride it)
  const routes = head[4];
  expect(routes).toBeLessThan(c('arrivals'));
  // (the deck: a route's point on the west arm at the deck's height)
  // (the points, past the route buffer's header and heads: routeread.wgsl's layout)
  const P0 = ROUTE_HEAD_WORDS + 8192 * 4;
  const pts = new Float32Array(await town.debugRead(town.routes, (P0 + head[3] * 5) * 4)).subarray(P0);
  let onDeck = 0;
  for (let i = 0; i < head[3]; i++) if (pts[i * 5] > 9 && pts[i * 5] < 19 && Math.abs(pts[i * 5 + 2] - 7) < 1e-3) onDeck++;
  expect(onDeck).toBeGreaterThan(0);
  // (routeWidth: every traced point's free width is finite and sensible; on the open box's streets (no buildings in
  // the way: their footprints are 4 m off the road) at least a couple of metres; on the deck narrower than the open
  // road beside it — the water under it is a drop)
  let deckW = 0;
  let deckN = 0;
  let roadW = 0;
  let roadN = 0;
  for (let i = 0; i < head[3]; i++) {
    const w = pts[i * 5 + 4];
    // (a trace reserves a point or two more than it writes: those stay empty)
    if (pts[i * 5] === 0 && pts[i * 5 + 1] === 0) continue;
    expect(Number.isFinite(w) && w > 0 && w <= 12.5).toBe(true);
    if (Math.abs(pts[i * 5 + 2] - 7) < 1e-3) ((deckW += w), deckN++);
    else if (pts[i * 5] > 25 && pts[i * 5] < 44) ((roadW += w), roadN++);
  }
  expect(roadN).toBeGreaterThan(0);
  expect(roadW / roadN).toBeGreaterThan(2);
  // (the builders: at the two sites (progress between 0 and 1, read on the GPU), working)
  expect(c('buildWork')).toBeGreaterThan(50);
  // (season life: the wall's table, made on the GPU with nothing asked — the ring written into the wall's words as
  // citygen makes it, then its stage moved on; the table read only through routeread.wgsl)
  if (wallBuf && wallData) {
    const frames = async (n: number) => {
      for (let f = 0; f < n; f++) {
        const enc = dev.createCommandEncoder();
        town.frame(enc, 0.1, place);
        dev.queue.submit([enc.finish()]);
      }
      await dev.queue.onSubmittedWorkDone();
    };
    const tk = makeCompute(dev, 'wall table test', [routereadWgsl, WALL_TEST], { 56: 'read', 2: 'rw' });
    const tout = dev.createBuffer({ size: 200 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const table = async () => {
      const enc = dev.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(tk.pipeline);
      cp.setBindGroup(0, makeBindGroup(dev, 'wall table test', tk.layout, { 56: town.routes, 2: tout }));
      cp.dispatchWorkgroups(1);
      cp.end();
      dev.queue.submit([enc.finish()]);
      return new Uint32Array(await town.debugRead(tout, 200 * 4));
    };
    const NONE_ID = 0xffffffff;
    // (no ring yet: no wall-walk routes, every gate slot GATE_NONE)
    const t0 = await table();
    expect(t0[0]).toBe(0);
    expect(t0[1]).toBe(10);
    for (let k = 0; k < 10; k++) expect([t0[120 + k * 3], t0[122 + k * 3] & 0xff]).toEqual([NONE_ID, 1]);
    // (the wall's columns claimed in the raster and the graph made again (citygen's mesh run, LivingTowns' rebuild): every
    // cached route traced again over it — the pool switched, and no route's point on a wall column)
    // (the riders' routes' points where the east gate will stand: their mean width, the current half's)
    const gateWidth = async () => {
      const hn = (await town.counters())!;
      const rb = new Uint32Array(await town.debugRead(town.routes, town.routes.size));
      const rf = new Float32Array(rb.buffer);
      const at = rb[3] + hn[11] * (rb[7] / 2) * 5;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < hn[3]; i++) {
        const o = at + i * 5;
        if (Math.hypot(rf[o] - (48.75 + WALL_R), rf[o + 1] - (48 + 0.5) * ROW_H) < 1.2) ((sum += rf[o + 4]), n++);
      }
      return n ? sum / n : NaN;
    };
    const before = await gateWidth();
    expect(before).toBeGreaterThan(0);
    const sw0 = (await town.counters())![L_C + C.switches];
    dev.queue.writeBuffer(roadsBuf, 0, marked);
    town.rebuild();
    for (let k = 0; k < 40; k++) {
      await frames(25);
      const h = (await town.counters())!;
      if (h[0] === 4 && h[L_C + C.switches] > sw0) break;
    }
    const hw = (await town.counters())!;
    expect(hw[0]).toBe(4);
    expect(hw[L_C + C.switches]).toBeGreaterThan(sw0);
    await frames(60);
    // (traced again, the routes through the gate narrower there than before the wall)
    const after = await gateWidth();
    console.log(`[living test] the riders' routes at the east gate: ${before.toFixed(2)} m before the wall, ${after.toFixed(2)} m after`);
    expect(after).toBeLessThan(before);
    {
      const hn = (await town.counters())!;
      const rb = new Uint32Array(await town.debugRead(town.routes, town.routes.size));
      const rf = new Float32Array(rb.buffer);
      const half = hn[11];
      const room = rb[7] / 2;
      let onWall = 0;
      let seen = 0;
      for (let i = half * room; i < half * room + hn[3]; i++) {
        const o = rb[3] + i * 5;
        const x = rf[o];
        const y = rf[o + 1];
        if (x === 0 && y === 0) continue;
        seen++;
        const cy = Math.round(y / ROW_H - 0.5);
        const cx = Math.round(x - 0.5 - 0.5 * (cy & 1));
        if (cx >= 0 && cy >= 0 && cx < W && cy < H && marked[cy * W + cx] === 0x40000000) onWall++;
      }
      expect(seen).toBeGreaterThan(50);
      expect(onWall).toBe(0);
    }
    // (the ring made, half of it risen)
    wallData.words[0] = 1;
    new Float32Array(wallData.words.buffer).set([0.5, 0.5, -1e9], 4);
    dev.queue.writeBuffer(wallBuf, 0, wallData.words);
    await frames(4);
    const t1 = await table();
    const runs = t1[0];
    // (four gates and a stretch of water: five runs of wall)
    expect(runs).toBe(5);
    const risenHalf = Array.from({ length: runs }, (_, i) => (t1[6 + i * 3] >> 17) & 1).filter(Boolean).length;
    expect(risenHalf).toBeGreaterThan(0);
    expect(risenHalf).toBeLessThan(runs);
    for (let i = 0; i < runs; i++) expect(t1[5 + i * 3]).toBe((t1[6 + i * 3] >> 17) & 1);
    // (all of it risen: the stage moved on, nothing else)
    dev.queue.writeBuffer(wallBuf, 16, new Float32Array([1, 1, -1e9]));
    await frames(4);
    const t2 = await table();
    expect(t2[2]).toBeGreaterThan(t1[2]);
    for (let i = 0; i < runs; i++) expect(t2[5 + i * 3]).toBe(1);
    // (the four arterials' gates: march routes; no other arterial, no filler gate)
    for (let k = 0; k < 4; k++) expect([t2[121 + k * 3], t2[122 + k * 3] & 0xff]).toEqual([1, 0]);
    for (let k = 4; k < 10; k++) expect([t2[120 + k * 3], t2[122 + k * 3] & 0xff]).toEqual([NONE_ID, 1]);
    // (the routes' points, read from the route buffer as laid out: heads at header[8], points at header[3])
    const rb = await town.debugRead(town.routes, town.routes.size);
    const ru = new Uint32Array(rb);
    const rfl = new Float32Array(rb);
    const route = (id: number) => {
      const o = ru[8] + (id & 0xffff) * 4;
      const out: { x: number; y: number; z: number; s: number; w: number }[] = [];
      for (let i = 0; i < ru[o + 1]; i++) {
        const p = ru[3] + (ru[o] + i) * 5;
        out.push({ x: rfl[p], y: rfl[p + 1], z: rfl[p + 2], s: rfl[p + 3], w: rfl[p + 4] });
      }
      return out;
    };
    let stairW = Infinity;
    let longRuns = 0;
    for (let i = 0; i < runs; i++) {
      const pts = route(t2[4 + i * 3]);
      expect(pts.length).toBeGreaterThanOrEqual(8);
      // (from the ground up a stair, along the wall's top 4.1 m over it, down a stair to the ground)
      expect(pts[0].z).toBeCloseTo(2, 3);
      // (a run longer than its two stairs ends down the second; a shorter one is its first stair's dead end on the top)
      const long = pts[pts.length - 1].z < 3;
      if (long) longRuns++;
      expect(pts[pts.length - 1].z).toBeCloseTo(long ? 2 : 2 - 0.4 + 4.5, 3);
      expect(Math.max(...pts.map((p) => p.z))).toBeCloseTo(2 - 0.4 + 4.5, 3);
      for (let j = 1; j < pts.length; j++) {
        expect(Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y)).toBeLessThan(3.5);
        expect(pts[j].s).toBeGreaterThan(pts[j - 1].s);
      }
      // (the walk's own width on top, the stairs' narrower)
      for (const p of pts) expect(p.z > 6 ? p.w : 1.1).toBeCloseTo(p.z > 6 ? 2 : 1.1, 3);
      stairW = Math.min(stairW, ...pts.filter((p) => p.z < 6).map((p) => p.w));
    }
    expect(longRuns).toBeGreaterThanOrEqual(3);
    // (the east gate's march: out along its arterial to the box's edge; narrower at the gate than the street outside it)
    const east = route(t2[120]);
    expect(east[0].x).toBeCloseTo(48.75 + WALL_R, 0);
    expect(east[east.length - 1].x).toBeGreaterThan(94);
    const out = east.filter((p) => p.x > 76 && p.x < 92);
    const streetW = out.reduce((a, p) => a + p.w, 0) / out.length;
    console.log(`[living test] wall: ${runs} runs, gate width ${east[0].w.toFixed(2)}, street ${streetW.toFixed(2)}, stairs ${stairW.toFixed(2)}`);
    expect(east[0].w).toBeLessThan(streetW);
    expect(stairW).toBeLessThan(east[0].w);
    // (the reach check: the stairs' feet by the gates' roads — every risen piece's walk reached; tests only read it)
    const reached = (await town.debugWallReach())!;
    let pieces = 0;
    let ok = 0;
    for (let b = 0; b < 72; b++) {
      if (wallData.words[368 + b] !== 0) continue;
      pieces++;
      if (reached[b]) ok++;
    }
    expect(ok).toBe(pieces);
    expect(g.takeErrors()).toEqual([]);
  }
  // (Track B's interface: a rider whose override is set — its `overridden`, a forced stub here — is not advanced by the
  // job kernel, and its state isn't touched, so the job resumes by itself once the override's gone)
  {
    const frames = async (n: number) => {
      for (let f = 0; f < n; f++) {
        const enc = dev.createCommandEncoder();
        town.frame(enc, 0.1, place);
        dev.queue.submit([enc.finish()]);
      }
      await dev.queue.onSubmittedWorkDone();
    };
    const rows = async () => new Uint32Array(await town.debugRead(town.rid, town.riders * 64));
    const before = await rows();
    // (a rider on a route leg: byte 2 forward or back)
    let k = -1;
    for (let i = 0; i < town.riders && k < 0; i++) {
      const leg = (before[i * 16 + 4] >> 16) & 0xff;
      if (leg === 1 || leg === 2) k = i;
    }
    expect(k).toBeGreaterThanOrEqual(0);
    town.debugOverride = k + 1;
    await frames(40);
    const held = await rows();
    expect(Array.from(held.slice(k * 16, k * 16 + 16))).toEqual(Array.from(before.slice(k * 16, k * 16 + 16)));
    town.debugOverride = 0;
    await frames(30);
    const after = await rows();
    // (resumed: it moved on, or its job stepped — its route's half may have been reused while it was held (a small pool):
    // then its leg ends where it is and the route is asked again)
    expect(after[k * 16] !== held[k * 16] || after[k * 16 + 1] !== held[k * 16 + 1] || after[k * 16 + 4] !== held[k * 16 + 4]).toBe(true);
  }
  // (the route-read contract, routeread.wgsl: every riding rider's position is routeAt(its route, its distance along);
  // its id is valid; after the pool's halves have both been reused, an id held from before is stale)
  {
    const k = makeCompute(dev, 'routeread test', [routereadWgsl, READ_TEST], { 56: 'read', 1: 'read', 2: 'rw' });
    const nR = town.riders;
    const out = dev.createBuffer({ size: nR * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readAt = async () => {
      const enc = dev.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, makeBindGroup(dev, 'routeread test', k.layout, { 56: town.routes, 1: town.rid, 2: out }));
      cp.dispatchWorkgroups(Math.ceil(nR / 64));
      cp.end();
      dev.queue.submit([enc.finish()]);
      return new Float32Array(await town.debugRead(out, nR * 16));
    };
    const at = await readAt();
    const rows = new Float32Array(await town.debugRead(town.rid, nR * 64));
    const ru32 = new Uint32Array(rows.buffer);
    let checked = 0;
    for (let i = 0; i < nR; i++) {
      const leg = (ru32[i * 16 + 4] >> 16) & 0xff;
      if (leg !== 1 && leg !== 2) continue;
      expect(new Uint32Array(at.buffer)[i * 4 + 3]).toBe(1);
      for (let c = 0; c < 3; c++) expect(Math.abs(at[i * 4 + c] - rows[i * 16 + c])).toBeLessThan(1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    if (ptsRoom) {
      // (an id held now, then the halves reused twice: stale)
      let k0 = -1;
      for (let i = 0; i < nR && k0 < 0; i++) if ([1, 2].includes((ru32[i * 16 + 4] >> 16) & 0xff)) k0 = i;
      const held = ru32[k0 * 16 + 5];
      const sw0 = (await town.counters())![L_C + C.switches];
      for (let f = 0; f < 3000; f++) {
        const enc = dev.createCommandEncoder();
        town.frame(enc, 0.1, place);
        dev.queue.submit([enc.finish()]);
        if (f % 100 === 99 && (await town.counters())![L_C + C.switches] >= sw0 + 2) break;
      }
      expect((await town.counters())![L_C + C.switches]).toBeGreaterThanOrEqual(sw0 + 2);
      dev.queue.writeBuffer(town.rid, k0 * 64 + 20, new Uint32Array([held]));
      // (the rider row's route word set back to the held id, read through routeValid without a frame between)
      const stale = await readAt();
      expect(new Uint32Array(stale.buffer)[k0 * 4 + 3]).toBe(0);
    }
  }
  // (the state words' size as the WGSL's)
  expect(town.lt.size).toBe(LT_WORDS * 4);
  console.log(`[living test] routes ${routes}, traced ${c('traced')}, arrivals ${c('arrivals')}, sweeps ${head[7]}, points ${head[3]}, deck points ${onDeck}, build work ${c('buildWork')}`);
  town.dispose();
  return head;
}

test('riders ride routes traced on the GPU from the road raster, over a deck at its height', async () => {
  await rideTown();
}, 120_000);

test('the wall routes and table: wall-walk routes up the stairs and along the top, each gate march, made on the GPU as the wall rises', async () => {
  await rideTown(undefined, true);
}, 120_000);

test('a small points pool switches halves and every route is traced again: no misses, riders keep arriving', async () => {
  const head = await rideTown(700);
  expect(head[L_C + C.switches]).toBeGreaterThan(0);
  expect(head[L_C + C.miss]).toBe(0);
}, 120_000);

test('the works kernels compile and bind (works.wgsl over the world prelude)', async () => {
  const dev = g.device;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const b = (n: number, u = S) => dev.createBuffer({ size: n, usage: u });
  const town = new LivingTown(dev, { w: 64, h: 64, roads: b(64 * 64 * 4), heights: b(64 * 64 * 4), wet: b(64 * 64 * 4), pop: b(64 * 64 * 16), art: b(4096), records: b(4096), counts: b(16), progress: b(4096), lotRoom: 16, centre: [32, 28], radius: 20 });
  const works = new Works(dev, town, { globals: b(GLOBALS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), chunks: b(4096), materials: b(packMaterialTable().byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), layers: b(4096), veg: b(4096), vegNext: b(4096) });
  await dev.queue.onSubmittedWorkDone();
  expect(g.takeErrors()).toEqual([]);
  works.dispose();
  town.dispose();
});

/** (the route-read test) a thread a rider: routeAt(its route word, its distance along) and routeValid(its route word) */
const READ_TEST = `
@group(0) @binding(1) var<storage, read> rid: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outp: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= arrayLength(&rid) / 4u) { return; }
  let w = bitcast<u32>(rid[i * 4u + 1u].y);
  let s = rid[i * 4u + 2u].x;
  let p = routeAt(w, s);
  outp[i] = vec4<f32>(p, bitcast<f32>(select(0u, 1u, routeValid(w))));
}
`;

// ---- the town wall (season life: citygen streets.wgsl WALL's layout, made on the CPU here) ----
const WALL_MARK = 0x40000000;
const NB = 72;
const WB_V = 80;
const WB_Z = 296;
const WB_KIND = 368;
const WB_ART = 440;
const WB_S = 512;
const AW = 20 + 2 * 128;
/** a ring of radius WALL_R round the crossroads: a gate where each of the four arterials (east, west, north, south)
 *  crosses it, segments 20–22 over "water" (no piece), wall elsewhere; its columns, towers at the gates' corners and
 *  the stairs at each run's ends marked WALL_MARK in the road raster (the arterials' own columns left open, as
 *  citygen's wallClaim) */
const WALL_R = 22;
function makeWall(roads: Uint32Array, made: boolean, to: number): { words: Uint32Array; art: Uint32Array } {
  const cx = 48.75;
  const cy = (48 + 0.5) * ROW_H;
  const ends: [number, number][] = [[95.4, cy], [0.6, cy], [cx, 95 * ROW_H], [cx, 0.5]];
  const art = new Uint32Array(4 + 8 * AW);
  const af = new Float32Array(art.buffer);
  art[0] = 4;
  ends.forEach((e, k) => {
    const o = 4 + k * AW;
    art[o] = 2;
    const L = Math.hypot(e[0] - cx, e[1] - cy);
    af[o + 1] = L;
    af[o + 3] = L;
    af.set([cx, cy, e[0], e[1]], o + 20);
  });
  const words = new Uint32Array(600);
  const wf = new Float32Array(words.buffer);
  const V: [number, number][] = [];
  for (let b = 0; b < NB; b++) {
    const a = ((b + 0.5) / NB) * 2 * Math.PI - Math.PI;
    V.push([cx + Math.cos(a) * WALL_R, cy + Math.sin(a) * WALL_R]);
    wf[WB_V + 2 * b] = V[b][0];
    wf[WB_V + 2 * b + 1] = V[b][1];
    wf[WB_Z + b] = 2;
  }
  let first = -1;
  let gates = 0;
  for (let b = 0; b < NB; b++) {
    const p = V[b];
    const q = V[(b + 1) % NB];
    words[WB_KIND + b] = b >= 20 && b <= 22 ? 2 : 0;
    ends.forEach((e, k) => {
      // (the arterial from the centre out: where it crosses p → q)
      const r = [e[0] - cx, e[1] - cy];
      const s = [q[0] - p[0], q[1] - p[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-9) return;
      const t = ((p[0] - cx) * s[1] - (p[1] - cy) * s[0]) / den;
      const v = ((p[0] - cx) * r[1] - (p[1] - cy) * r[0]) / den;
      if (t < 0 || t > 1 || v < 0 || v > 1) return;
      words[WB_KIND + b] = 1;
      words[WB_ART + b] = k + 1;
      wf[WB_S + b] = t * Math.hypot(r[0], r[1]);
      gates++;
      if (first < 0) first = b;
    });
  }
  words[0] = made ? 1 : 0;
  words[1] = gates;
  words[2] = first;
  wf.set([to, to, -1e9], 4);
  // (the columns: pieces, the towers beside the gates, the stairs; never an arterial's)
  const onArt = (x: number, y: number) => Math.abs(y - cy) < 2 || Math.abs(x - cx) < 2;
  const segD = (x: number, y: number, a: [number, number], b: [number, number]) => {
    const ab = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)));
    return Math.hypot(x - a[0] - ab[0] * t, y - a[1] - ab[1] * t);
  };
  const boxes: { a: [number, number]; b: [number, number]; hw: number }[] = [];
  const gap = (b: number) => words[WB_KIND + ((b + NB) % NB)] !== 0;
  for (let b = 0; b < NB; b++) {
    const p = V[b];
    const q = V[(b + 1) % NB];
    if (!gap(b)) boxes.push({ a: p, b: q, hw: 1 });
    if (words[WB_KIND + b] === 1) {
      boxes.push({ a: p, b: p, hw: 2 });
      boxes.push({ a: q, b: q, hw: 2 });
    }
    for (const e of [0, 1]) {
      if (gap(b) || !gap(e === 1 ? b - 1 : b + 1)) continue;
      const c = e === 1 ? p : q;
      const o = e === 1 ? q : p;
      const l = Math.hypot(o[0] - c[0], o[1] - c[1]);
      const d = [(o[0] - c[0]) / l, (o[1] - c[1]) / l];
      let n = [-d[1], d[0]];
      if (n[0] * (cx - c[0]) + n[1] * (cy - c[1]) < 0) n = [-n[0], -n[1]];
      for (let k = 0; k < 6; k++) {
        const a: [number, number] = [c[0] + d[0] * (2.6 + k * 1.1) + n[0] * 1.55, c[1] + d[1] * (2.6 + k * 1.1) + n[1] * 1.55];
        boxes.push({ a, b: [a[0] + d[0] * 1.1, a[1] + d[1] * 1.1], hw: 0.55 });
      }
    }
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 + 0.5 * (y & 1);
      const py = (y + 0.5) * ROW_H;
      if (onArt(px, py)) continue;
      if (boxes.some((bx) => segD(px, py, bx.a, bx.b) <= bx.hw + 0.35)) roads[y * W + x] = WALL_MARK;
    }
  return { words, art };
}

/** (the wall test) the wall's table read through routeread.wgsl: the wall-walk count; each wall-walk route's id, its
 *  validity and run; each gate slot's id, validity and status */
const WALL_TEST = `
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let n = wallWalkCount();
  outp[0] = n;
  outp[1] = gateSlots();
  outp[2] = wallTableVersion();
  for (var i = 0u; i < 36u; i++) {
    let id = wallWalkRoute(i);
    let r = wallWalkRun(i);
    outp[4u + i * 3u] = id;
    outp[5u + i * 3u] = select(0u, 1u, routeValid(id));
    outp[6u + i * 3u] = r.x | (r.y << 8u) | (r.z << 16u) | (r.w << 17u);
  }
  for (var k = 0u; k < 12u; k++) {
    let id = gateRoute(k);
    outp[120u + k * 3u] = id;
    outp[121u + k * 3u] = select(0u, 1u, routeValid(id));
    outp[122u + k * 3u] = gateStatus(k) | (gateSegment(k) << 8u);
  }
}
`;
