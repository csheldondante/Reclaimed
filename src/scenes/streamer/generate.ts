// New land: a region generated (on the GPU or the CPU), cut to the window's depth, brought up to date with its saved
// changes, resliced to another depth; the generator's hash and comparison checks. API: generate, generateGpu,
// genHash, compareGen, cutRegion, since, reslice, place, columnOf.
import { timed } from '../../gpu/cpustat';
import { columnsHash } from '../../world/region-record';
import { CHUNK, SLOT_WORDS, fitColumn, joinColumn, packColumn, readSlot, splitColumn, waterInWindow, type Interval } from '../../world/layout';
import { type RegionLand } from '../../world/streamgen';
import { settleLand } from '../../sim/sleep';
import { GPUGEN, type FinishMeta } from '../../atlas/finish';
import { WINDOW_MAKE } from '../../atlas/atlas';
import { cpu } from './freeze';
import { slotFor } from './jobs';
import { reliefOf } from './write';
import { metaOf, applyChange, Frozen, GenTrace, topInside, boxOf, RELIEF_FORM } from './defs';
import { settleLoose } from '../streamer';
import type { Streamer } from '../streamer';

/** a region's land the first time it is seen, in the frozen form (cut at the window's oz now) */
export async function generate(S: Streamer, x0: number, y0: number): Promise<Frozen> {
  if (GPUGEN && S.source.regionInto) return generateGpu(S, x0, y0);
  const { R } = S;
  const zMax = S.core.dims.zMax;
  const g: GenTrace = { x0, y0, asked: performance.now(), land: 0, done: 0 };
  S.gens.push(g);
  if (S.gens.length > 400) S.gens.shift();
  const [land, snap] = await Promise.all([S.source.region(x0, y0, R, R, zMax), S.source.snapshot?.(x0, y0, R, R)]);
  g.land = performance.now();
  const f = timed('cut', () => S.cutRegion(land, snap));
  g.done = performance.now();
  return f;
}

/**
 * (round 102, `gpugen`) A region's land made on the GPU straight into a pool slot (LandSource.regionInto: the cut,
 * the pack and every field there; nothing read back but what the CPU keeps — its tops, ground, relief, what's
 * outside the window). No hash of its columns as made: one is needed only to tell a region changed by play from its
 * save, and a made region is saved only once play has touched it.
 */
export async function generateGpu(S: Streamer, x0: number, y0: number): Promise<Frozen> {
  const { R } = S;
  const zMax = S.core.dims.zMax;
  const g: GenTrace = { x0, y0, asked: performance.now(), land: 0, done: 0 };
  S.gens.push(g);
  if (S.gens.length > 400) S.gens.shift();
  const oz = S.oz;
  // (no slot free — every one a job's or a slide's: a slot of its own, let go once it's written)
  const slot = slotFor(S) ?? S.pool.temp();
  let m: FinishMeta;
  let snap: unknown;
  try {
    [m, snap] = await Promise.all([S.source.regionInto!(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: S.layout, oz, zMax, K: S.K, colK: S.colK, settle: !settleLand() }, WINDOW_MAKE).then(metaOf), S.source.snapshot?.(x0, y0, R, R)]);
  } catch (e) {
    S.pool.release(slot);
    throw e;
  }
  g.land = performance.now();
  S.stats.fitted += m.fitted;
  S.stats.settled += m.settled;
  const f = timed('gen.meta', (): Frozen => {
    const relief = new Uint8Array(R * R);
    for (let i = 0; i < R * R; i++) relief[i] = Math.abs(m.surface[i] - m.ground[i]) > RELIEF_FORM ? 1 : 0;
    const judge = boxOf(m.structural, R);
    return { slot, surface: m.surface, ground: m.ground, outside: m.outside, relief: { relief, gapTop: m.gapTop, colTop: m.colTop }, judge, oz, snap, info: {}, how: 'made' };
  });
  S.stats.gpuMade++;
  g.done = performance.now();
  return f;
}

/** Streamer.genHash (the class keeps the method, documented there) */
export async function genHash(S: Streamer, x0: number, y0: number): Promise<{ cols: number; bytes: number; ms: number }> {
  if (!S.source.regionInto) throw new Error('genHash: the land source makes nothing on the GPU');
  const { R } = S;
  const L = S.layout;
  const dev = S.core.host.gpu.device;
  const t0 = performance.now();
  const slot = S.pool.temp();
  try {
    const oz = S.oz;
    const m = metaOf(await S.source.regionInto(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: L, oz, zMax: S.core.dims.zMax, K: S.K, colK: S.colK, settle: !settleLand() }, WINDOW_MAKE));
    const st = dev.createBuffer({ label: 'genHash read', size: L.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'genHash read' });
    enc.copyBufferToBuffer(slot.buf, slot.off, st, 0, L.bytes);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const all = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    let h = 0x811c9dc5;
    for (let i = 0; i < all.length; i++) h = Math.imul(h ^ all[i], 0x01000193) >>> 0;
    const cols = columnsHash(all.subarray(0, (L.rc * L.rc * L.pageBytes) / 4), L, m.outside, oz);
    return { cols, bytes: h, ms: performance.now() - t0 };
  } finally {
    S.pool.release(slot);
  }
}

/** Streamer.compareGen (the class keeps the method, documented there) */
export async function compareGen(S: Streamer, x0: number, y0: number): Promise<{ words: number; nonzero: number; diff: number; parts: Record<string, number>; first: unknown[]; meta: Record<string, number>; cpuMs: number; gpuMs: number }> {
  if (!S.source.regionInto) throw new Error('compareGen: the land source makes nothing on the GPU');
  const { R } = S;
  const L = S.layout;
  const zMax = S.core.dims.zMax;
  const dev = S.core.host.gpu.device;
  const t0 = performance.now();
  const land = await S.source.region(x0, y0, R, R, zMax);
  const fc = S.cutRegion(land, undefined);
  const cpu = new Uint32Array(S.toBody(fc).slice().buffer);
  const rc = reliefOf(S, fc);
  const t1 = performance.now();
  const slot = S.pool.temp();
  let m: FinishMeta;
  let gpu: Uint32Array;
  try {
    m = metaOf(await S.source.regionInto(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: L, oz: S.oz, zMax, K: S.K, colK: S.colK, settle: !settleLand() }, { pace: 'none', stamps: 'plan' }));
    const st = dev.createBuffer({ label: 'compareGen read', size: L.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'compareGen read' });
    enc.copyBufferToBuffer(slot.buf, slot.off, st, 0, L.bytes);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    gpu = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
  } finally {
    S.pool.release(slot);
  }
  const t2 = performance.now();
  // the slot's parts, by word
  const parts: [string, number, number][] = [['pages', 0, L.rc * L.rc * L.pageBytes]];
  for (const b of L.bufs) parts.push([b.name, b.off, b.off + b.bytes]);
  for (const t of L.texs) parts.push([`tex:${t.name}`, t.off, t.off + t.bytes]);
  const count: Record<string, number> = {};
  const first: unknown[] = [];
  let diff = 0;
  const f32 = (u: number) => new Float32Array(new Uint32Array([u]).buffer)[0];
  for (const [name, a, b] of parts) {
    let n = 0;
    for (let w = a / 4; w < b / 4; w++) {
      if (cpu[w] === gpu[w]) continue;
      n++;
      if (first.length < 12) {
        const at: Record<string, unknown> = { part: name, word: w - a / 4, cpu: cpu[w], gpu: gpu[w], cpuF: f32(cpu[w]), gpuF: f32(gpu[w]) };
        if (name === 'pages') {
          const slotI = Math.floor((w - a / 4) / SLOT_WORDS);
          const page = Math.floor(slotI / S.pageSlots);
          const inPage = slotI % S.pageSlots;
          const c = Math.floor(inPage / S.K);
          at.col = [(page % L.rc) * CHUNK + (c % CHUNK), Math.floor(page / L.rc) * CHUNK + Math.floor(c / CHUNK)];
          at.slot = inPage % S.K;
        }
        first.push(at);
      }
    }
    if (n) count[name] = n;
    diff += n;
  }
  // what the CPU keeps
  const meta: Record<string, number> = {};
  const same = (name: string, p: ArrayLike<number>, q: ArrayLike<number>) => {
    let n = 0;
    for (let i = 0; i < R * R; i++) if (!Object.is(p[i], q[i])) {
      n++;
      if (first.length < 16) first.push({ part: name, i, cpu: p[i], gpu: q[i] });
    }
    if (n) meta[name] = n;
  };
  same('surface', fc.surface, m.surface);
  same('ground', fc.ground!, m.ground);
  same('relief', rc.relief, Uint8Array.from(m.surface, (s, i) => (Math.abs(s - m.ground[i]) > RELIEF_FORM ? 1 : 0)));
  same('gapTop', rc.gapTop, m.gapTop);
  same('colTop', rc.colTop, m.colTop);
  let no = 0;
  for (let i = 0; i < R * R; i++) if (JSON.stringify(fc.outside[i]) !== JSON.stringify(m.outside[i])) no++;
  if (no) meta.outside = no;
  if (JSON.stringify(fc.judge) !== JSON.stringify(boxOf(m.structural, R))) meta.judge = 1;
  // (that there was something to compare: the slot's words not zero)
  let nonzero = 0;
  for (let w = 0; w < gpu.length; w++) if (gpu[w]) nonzero++;
  return { words: cpu.length, nonzero, diff, parts: count, first, meta, cpuMs: +(t1 - t0).toFixed(1), gpuMs: +(t2 - t1).toFixed(1) };
}

/** Streamer.cutRegion (the class keeps the method, documented there) */
export function cutRegion(S: Streamer, land: RegionLand, snap: Frozen['snap']): Frozen {
  const { R } = S;
  const zMax = S.core.dims.zMax;
  const oz = S.oz;
  const rc = R / CHUNK;
  const layers = new Uint32Array(rc * rc * S.pageSlots * SLOT_WORDS);
  const outside: Interval[][] = [];
  const surface = new Float32Array(R * R);
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const i = y * R + x;
      // (perfopt, settle=0: nothing loose comes in floating — it won't wake to fall)
      if (!settleLand() && settleLoose(land.cols[i])) S.stats.settled++;
      const cut = splitColumn(land.cols[i], oz, zMax);
      outside.push(cut.outside);
      place(S, layers, x, y, cut.inside);
      surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
      // (round 88: the water the window holds — over the floor where the ground is under it, the sea's)
      const col = land.cols[i];
      land.water[i] = col.length ? waterInWindow(cut, oz, zMax, col[col.length - 1].z1 + land.water[i]) : 0;
      // (the ground's top out of the window: what lies on it isn't here)
      if (!topInside(cut, oz, zMax)) {
        if (land.waterSource) land.waterSource[i] = 0;
        if (land.riverFlow) land.riverFlow.fill(0, i * 4, i * 4 + 4);
        if (land.lava) land.lava.fill(0, i * 4, i * 4 + 4);
      } else if (land.lava && land.lava[i * 4] > 0) land.lava[i * 4 + 3] -= oz;
    }
  const bytes = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bufs: Record<string, Uint8Array> = {
    water: bytes(land.water),
    moisture: bytes(land.moisture),
    veg: bytes(land.vegetation),
    contam: bytes(land.contam),
    petals: bytes(new Float32Array(R * R).fill(1)),
  };
  if (land.lava) bufs.lava = bytes(land.lava);
  if (land.waterSource) bufs.waterSource = bytes(land.waterSource);
  const texs: Record<string, Float32Array> = {};
  const judge = land.structural ? boxOf(land.structural, R) : undefined;
  if (land.lavaSpring) {
    const t = new Float32Array(R * R * 4);
    for (let k = 0; k < R * R; k++) t[k * 4] = land.lavaSpring[k];
    texs.lavaSpring = t;
  }
  if (land.riverFlow) texs.riverFlow = land.riverFlow;
  const ground = land.ground ? land.ground.map((v) => v - oz) : undefined;
  // (round 100) its columns as made: a region whose hash is this when it's read back hasn't changed
  const last = timed('rs.hash', () => columnsHash(layers, S.layout, outside, oz));
  return { layers, bufs, texs, surface, judge, oz, outside, snap, ground, info: { last }, how: 'made' };
}

/** a region coming in with what changed while it was away (LandSource.changes since its snapshot) */
export async function since(S: Streamer, f: Frozen, x0: number, y0: number): Promise<Frozen> {
  const { R } = S;
  if (!S.source.changes || f.snap === undefined) return f;
  const at = await S.source.changes(await f.snap, x0, y0, R, R);
  if (!at) return f;
  // (round 100: changed — its land on the CPU to change, read back from its slot if it's in the pool)
  f = await cpu(S, f);
  if (!f.layers || !f.bufs) throw new Error('since: a region without its land on the CPU');
  const zMax = S.core.dims.zMax;
  const layers = f.layers.slice();
  const outside = f.outside.slice();
  const surface = f.surface.slice();
  const water = f.bufs.water ? new Float32Array(f.bufs.water.slice().buffer) : undefined;
  const veg = f.bufs.veg ? new Float32Array(f.bufs.veg.slice().buffer) : undefined;
  let n = 0;
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const d = at(x0 + x, y0 + y);
      if (Math.abs(d.dr) < 0.05 && d.dl < 0.05 && d.dw < 0.02) continue;
      const i = y * R + x;
      const full = joinColumn(columnOf(S, f.layers, x, y), f.oz, f.outside[i]);
      applyChange(full, d);
      const cut = splitColumn(full, f.oz, zMax);
      outside[i] = cut.outside;
      place(S, layers, x, y, cut.inside);
      surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
      if (water && d.dw > 0) water[i] += d.dw;
      if (veg && d.dl > 0.05) veg[i] *= Math.max(0, 1 - d.dl * 2);
      n++;
    }
  if (!n) return f;
  S.stats.changed++;
  f.info.last = undefined;
  const bufs = { ...f.bufs };
  if (water) bufs.water = new Uint8Array(water.buffer);
  if (veg) bufs.veg = new Uint8Array(veg.buffer);
  return { ...f, layers, outside, surface, bufs, snap: undefined, relief: undefined };
}

/** a frozen region cut again at the window's oz now (it was left at another) */
export function reslice(S: Streamer, f: Frozen): Frozen {
  const { R } = S;
  if (!f.layers || !f.bufs) throw new Error('reslice: a region without its land on the CPU');
  const fl = f.layers;
  const fb = f.bufs;
  const zMax = S.core.dims.zMax;
  const layers = new Uint32Array(fl.length);
  const outside: Interval[][] = [];
  const surface = new Float32Array(R * R);
  const water = fb.water ? new Float32Array(fb.water.buffer, fb.water.byteOffset, R * R) : undefined;
  const lava = fb.lava ? new Float32Array(fb.lava.buffer, fb.lava.byteOffset, R * R * 4) : undefined;
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const i = y * R + x;
      const was = columnOf(S, fl, x, y);
      const full = joinColumn(was, f.oz, f.outside[i]);
      const wasTop = was.length > 0 && !f.outside[i].some((iv) => iv.z0 >= f.oz + zMax);
      // (round 88) its water's level (world z): over its top in the window, or over the floor where its ground was
      // under it; none where its top was over the window
      const level = f.oz + (was.length ? was[was.length - 1].z1 : 0) + (water ? water[i] : 0);
      const overTop = f.outside[i].some((iv) => iv.z0 >= f.oz + zMax);
      const cut = splitColumn(full, S.oz, zMax);
      outside.push(cut.outside);
      place(S, layers, x, y, cut.inside);
      surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
      if (water) water[i] = overTop ? 0 : waterInWindow(cut, S.oz, zMax, level);
      if (!(wasTop && topInside(cut, S.oz, zMax))) {
        if (lava) lava.fill(0, i * 4, i * 4 + 4);
      } else if (lava && lava[i * 4] > 0) lava[i * 4 + 3] += f.oz - S.oz;
    }
  S.stats.resliced++;
  const ground = f.ground ? f.ground.map((v) => v + f.oz - S.oz) : undefined;
  return { ...f, layers, surface, oz: S.oz, outside, ground };
}

/** column (x, y) of a region (window z) into its layers' pages, fitted to what a column may hold */
export function place(S: Streamer, layers: Uint32Array, x: number, y: number, col: Interval[]): void {
  const { K } = S;
  if (fitColumn(col, S.colK)) S.stats.fitted++;
  const rc = S.R / CHUNK;
  const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
  const slot = page * S.pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
  layers.set(packColumn(col, K), slot * SLOT_WORDS);
}

/** the intervals of column (x, y) of a region's pages (window z) */
export function columnOf(S: Streamer, layers: Uint32Array, x: number, y: number): Interval[] {
  const { K } = S;
  const rc = S.R / CHUNK;
  const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
  const slot = page * S.pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
  const out: Interval[] = [];
  for (let s = 0; s < K; s++) {
    const iv = readSlot(layers, slot + s);
    if (!iv) break;
    out.push(iv);
  }
  return out;
}
