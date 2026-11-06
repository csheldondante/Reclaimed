// Freezing regions that leave the window and their bodies: copying a region's columns, fields and textures out to a
// staging buffer (and back in), the record body they're kept as, and the CPU copy read when needed. API: copyOut,
// copyIn, toBody, fromBody, freezePlan, freezeAt, frozeInto, cpuNow, cpu.
import { record } from '../../gpu/cpustat';
import { CHUNK, SLOT_WORDS } from '../../world/layout';
import { PAGE_COLS, regionRowsToPages } from '../../sim/pages';
import { clearPages, regionRects, regionSlots, texRegion } from './regions';
import { check, saveItem } from './store';
import { slotFor } from './jobs';
import { moduleBufs } from './write';
import { Frozen, Freeze } from './defs';
import type { Streamer } from '../streamer';

/** Streamer.copyOut (the class keeps the method, documented there) */
export function copyOut(S: Streamer, enc: GPUCommandEncoder, lx: number, ly: number, dst: GPUBuffer, off: number, kernel = true, flush = true): void {
  const { W, R } = S;
  // (round 107, pages: the region's pages where they lie — one rectangle for the identity's slots)
  const sl = regionSlots(S, lx, ly);
  const L = S.layout;
  const wg = S.core.world;
  const table = S.core.packed.chunkTable;
  const cx = W / CHUNK;
  for (let j = 0; j < L.rc; j++)
    for (let i = 0; i < L.rc; i++) {
      const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
      enc.copyBufferToBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, dst, off + (j * L.rc + i) * L.pageBytes, L.pageBytes);
    }
  const H = S.H;
  for (const lb of L.bufs) {
    const b = S.bufs.find((x) => x.name === lb.name)!;
    // (round 104: a dispatch a buffer — dst must be a storage buffer: a pool slot, not a readback's stage)
    if (kernel) {
      regionRects(S, b, sl, false, dst, (off + lb.off) / 4);
      continue;
    }
    // (round 107: a page's columns are one run in both: a copy a run of pages, a plane)
    const pb = PAGE_COLS * b.stride;
    for (const run of S.core.ring.runs(sl, L.rc))
      for (let p = 0; p < b.planes; p++)
        for (let r = 0; r < run.rows; r++)
          enc.copyBufferToBuffer(b.buf, p * W * H * b.stride + (run.slot + r * run.rowSlots) * pb, dst, off + lb.off + p * R * R * b.stride + (run.k + r * L.rc) * pb, run.n * pb);
  }
  // (round 106: a caller freezing several encodes their rectangles once, in one pass)
  if (flush) S.copier.encode(enc);
  for (const lt of L.texs) {
    const t = S.texs.find((x) => x.name === lt.name)!;
    for (const q of texRegion(S, lx, ly, t, lt.rowBytes)) enc.copyTextureToBuffer({ texture: t.tex, origin: q.origin }, { buffer: dst, offset: off + lt.off + q.off, bytesPerRow: lt.rowBytes }, q.size);
  }
}

/** (round 100) Copy a region's bytes (a pool slot) into the window at (lx, ly): its pages to the layers (and layersNext). */
export function copyIn(S: Streamer, enc: GPUCommandEncoder, src: GPUBuffer, off: number, lx: number, ly: number, once = false): void {
  const { W } = S;
  const sl = regionSlots(S, lx, ly);
  const L = S.layout;
  const wg = S.core.world;
  const table = S.core.packed.chunkTable;
  const cx = W / CHUNK;
  for (let j = 0; j < L.rc; j++)
    for (let i = 0; i < L.rc; i++) {
      const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
      for (const b of [wg.layers, wg.layersNext]) enc.copyBufferToBuffer(src, off + (j * L.rc + i) * L.pageBytes, b, table[ci * 2] * SLOT_WORDS * 4, L.pageBytes);
    }
  for (const lb of L.bufs) {
    const b = S.bufs.find((x) => x.name === lb.name)!;
    regionRects(S, b, sl, true, src, (off + lb.off) / 4, once);
  }
  S.copier.encode(enc);
  for (const lt of L.texs) {
    const t = S.texs.find((x) => x.name === lt.name)!;
    for (const q of texRegion(S, lx, ly, t, lt.rowBytes)) enc.copyBufferToTexture({ buffer: src, offset: off + lt.off + q.off, bytesPerRow: lt.rowBytes }, { texture: t.tex, origin: q.origin }, q.size);
  }
}

/** Streamer.toBody (the class keeps the method, documented there) */
export function toBody(S: Streamer, f: Frozen): Uint8Array {
  const L = S.layout;
  const host = (S.uploadHost ??= new Uint8Array(L.bytes));
  host.fill(0);
  const ly = f.layers!;
  host.set(new Uint8Array(ly.buffer, ly.byteOffset, Math.min(ly.byteLength, L.rc * L.rc * L.pageBytes)), 0);
  for (const lb of L.bufs) {
    const d = f.bufs?.[lb.name];
    // (round 107, pages: the record's buffers page-major — the CPU's forms row-major)
    if (d) host.set(regionRowsToPages(d.subarray(0, lb.bytes), L.R, lb.stride, lb.planes, true), lb.off);
  }
  for (const lt of L.texs) {
    const d = f.texs?.[lt.name];
    if (!d) continue;
    const row = lt.tw * 16;
    const u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    for (let r = 0; r < lt.th; r++) host.set(u.subarray(r * row, (r + 1) * row), lt.off + r * lt.rowBytes);
  }
  return host;
}

/** (round 100) a region's CPU form (layers, kept buffers, kept textures) from its bytes */
export function fromBody(S: Streamer, body: Uint8Array): Pick<Frozen, 'layers' | 'bufs' | 'texs'> {
  const L = S.layout;
  const layers = new Uint32Array(body.slice(0, L.rc * L.rc * L.pageBytes).buffer);
  const bufs: Record<string, Uint8Array> = {};
  // (round 107, pages: page-major in the record, row-major for the CPU)
  for (const lb of L.bufs) bufs[lb.name] = regionRowsToPages(body.subarray(lb.off, lb.off + lb.bytes), L.R, lb.stride, lb.planes, false);
  const texs: Record<string, Float32Array> = {};
  for (const lt of L.texs) {
    const d = new Float32Array(lt.tw * lt.th * 4);
    const u = new Uint8Array(d.buffer);
    const row = lt.tw * 16;
    for (let r = 0; r < lt.th; r++) u.set(body.subarray(lt.off + r * lt.rowBytes, lt.off + r * lt.rowBytes + row), r * row);
    texs[lt.name] = d;
  }
  return { layers, bufs, texs };
}

/**
 * (round 100) The window's regions leaving, at these local corners (the window before the slide): copied into pool
 * slots (and those play changed into one staging buffer, read back for the store), their CPU parts and things taken.
 * (Round 106, frameprobe: planned here, in the slide's frame — the things taken, the coarse world's snapshots asked,
 * the readback's stage made — and each region's copies made later, where it lies on the ring, just before the
 * region coming in is written there (freezeAt): the window's data is on the ring and the chunk table keeps a place's
 * pages, so what left stays where it lay, untouched, until then. frozeInto once all are done.)
 */
export function freezePlan(S: Streamer, spots: [number, number][], dx: number, dy: number): Freeze {
  const { R, W, H } = S;
  const L = S.layout;
  const dev = S.core.host.gpu.device;
  // (round 104) read back only what play changed (or ?rsverify): a region never touched is made again when it's
  // wanted, its readback was 1.6 MB a region mapped for nothing — the whole strip, every slide
  const keys = spots.map(([lx, ly]) => S.key((S.origin[0] + lx) / R, (S.origin[1] + ly) / R));
  const need = keys.filter((key) => S.verify || S.winInfo.get(key)?.changed).length;
  const stage = need ? dev.createBuffer({ label: 'stream freeze', size: L.bytes * need, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
  const fz: Freeze = { stage, items: [], entries: [], pending: new Map() };
  // (round 106, frameprobe: the freeze's CPU by part)
  const tm = [0, 0, 0];
  let tq = performance.now();
  const lap = (k: number) => {
    const t = performance.now();
    tm[k] += t - tq;
    tq = t;
  };
  spots.forEach(([lx, ly], i) => {
    const key = keys[i];
    tq = performance.now();
    const it = saveItem(S, lx, ly, key);
    lap(0);
    const things = S.things.flatMap((t) => t.take(lx, ly, lx + R, ly + R));
    if (things.length) it.things = things;
    lap(1);
    const read = !!stage && (S.verify || !!it.info.changed);
    const k = fz.items.length;
    if (read) fz.items.push(it);
    // (the coarse world as the region leaves it: asked now — Coarse.snapshot copies a task's together)
    const snap = S.source.snapshot?.(it.x0, it.y0, R, R);
    lap(2);
    // (the same place on the ring, in the window after the slide: the region coming in there)
    const nx = (((lx - dx) % W) + W) % W;
    const ny = (((ly - dy) % H) + H) % H;
    fz.pending.set(ny * W + nx, { it, key, read, k, snap });
    S.winInfo.delete(key);
  });
  record('fz.saveItem', tm[0]);
  record('fz.things', tm[1]);
  record('fz.snapshot', tm[2]);
  return fz;
}

/**
 * (round 106, frameprobe) The region that left from where window region (lx, ly) — after the slide — lies on the ring
 * copied out (into a pool slot; to the stage if play changed it) and its band cleared there, before what comes in is
 * written: one region's copies a submit, in the frame that writes there.
 */
export function freezeAt(S: Streamer, fz: Freeze, lx: number, ly: number): void {
  const p = fz.pending.get(ly * S.W + lx);
  if (!p) return;
  fz.pending.delete(ly * S.W + lx);
  const t0 = performance.now();
  const L = S.layout;
  const dev = S.core.host.gpu.device;
  const enc = dev.createCommandEncoder({ label: 'stream freeze' });
  const { it, key, read, k, snap } = p;
  const slot = slotFor(S);
  const t1 = performance.now();
  if (slot) {
    S.copyOut(enc, lx, ly, slot.buf, slot.off);
    if (read) enc.copyBufferToBuffer(slot.buf, slot.off, fz.stage!, k * L.bytes, L.bytes);
    const fe: Frozen = { oz: it.oz, outside: it.outside, surface: it.surface, ground: it.ground, relief: it.relief, snap, slot, info: it.info, how: 'thawed', things: it.things };
    // (round 106: its CPU parts as the item's, when they're read)
    const readCpu = it.fill;
    if (readCpu)
      it.fill = fe.fill = () => {
        fe.fill = undefined;
        readCpu();
        fe.outside = it.outside;
        fe.surface = it.surface;
        fe.ground = it.ground;
        fe.relief = it.relief;
      };
    fz.entries.push([key, fe]);
  } else {
    // (no room in the pool: read back only — saved if it changed, made again if it didn't)
    if (read) S.copyOut(enc, lx, ly, fz.stage!, k * L.bytes, false);
    // (round 106: kept nowhere — its CPU parts never read)
    else it.fill = undefined;
    S.stats.evicted++;
  }
  // (what isn't kept for the region coming in starts empty there)
  const sl = regionSlots(S, lx, ly);
  for (const b of [...S.bufs, ...moduleBufs(S)]) {
    if (b.keep) continue;
    if (b.buf.usage & GPUBufferUsage.STORAGE) regionRects(S, b, sl, true, null, 0);
    else clearPages(S, enc, b, sl);
  }
  S.copier.encode(enc);
  dev.queue.submit([enc.finish()]);
  record('fz.slotFor', t1 - t0);
  record('fz.copyOut', performance.now() - t1);
}

/** (round 100) once every region that left is copied out: the regions in the pool, their readback under way */
export function frozeInto(S: Streamer, fz: Freeze): void {
  for (const [ly, lx] of [...fz.pending.keys()].map((i) => [Math.floor(i / S.W), i % S.W])) freezeAt(S, fz, lx, ly);
  for (const [key, f] of fz.entries) {
    S.frozen.delete(key);
    S.frozen.set(key, f);
  }
  if (fz.stage) check(S, fz.stage, fz.items);
}

/** (round 104) a loaded region's bytes split into its CPU form (layers, bufs, texs) */
export function cpuNow(S: Streamer, f: Frozen): Frozen {
  if (f.layers || !f.body) return f;
  return { ...f, ...fromBody(S, f.body), body: undefined };
}

/** (round 100) A region out of the pool (or the CPU form), on the CPU — read back from its slot when it isn't. */
export async function cpu(S: Streamer, f: Frozen): Promise<Frozen> {
  if (f.layers || f.body) return cpuNow(S, f);
  if (!f.slot) throw new Error('a frozen region with neither its land on the CPU nor a slot');
  const dev = S.core.host.gpu.device;
  const st = dev.createBuffer({ label: 'region readback', size: S.layout.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = dev.createCommandEncoder({ label: 'region readback' });
  enc.copyBufferToBuffer(f.slot.buf, f.slot.off, st, 0, S.layout.bytes);
  dev.queue.submit([enc.finish()]);
  await st.mapAsync(GPUMapMode.READ);
  const body = new Uint8Array(st.getMappedRange()).slice();
  st.unmap();
  st.destroy();
  return { ...f, ...fromBody(S, body) };
}
