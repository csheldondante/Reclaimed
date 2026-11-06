// Writing a region into the window: its columns into the chunk pages, its fields and textures, its relief; blank
// and zero buffers; live edits of the land (editLive). API: write, writeNow, blankBuf, zeros, moduleBufs, setRelief,
// reliefOf, editLive.
import { record, timed } from '../../gpu/cpustat';
import { CHUNK, SLOT_WORDS, fitColumn, joinColumn, packColumn, readSlot, splitColumn, type Interval } from '../../world/layout';
import { regionRowsToPages } from '../../sim/pages';
import { regionIdx, regionPut, regionRects, regionSlots, texRegion } from './regions';
import { copyIn, cpuNow } from './freeze';
import { fillAt, flushFills, verifyNow } from './store';
import { columnOf, reslice } from './generate';
import { applyChange, ColBuf, Frozen, align256, setReliefIn } from './defs';
import type { Streamer } from '../streamer';

/** write a region into the window at local cell (lx, ly) */
export function write(S: Streamer, f: Frozen, lx: number, ly: number, key = S.key((S.origin[0] + lx) / S.R, (S.origin[1] + ly) / S.R)): void {
  timed('write', () => writeNow(S, f, lx, ly, key));
}

export function writeNow(S: Streamer, f: Frozen, lx: number, ly: number, key: string): void {
  // (round 98: a region cut again has its relief made again — its surface is the new cut's)
  // (round 104: a loaded region not in the pool — no room — split for the CPU's write)
  if (!f.slot) f = cpuNow(S, f);
  if (f.oz !== S.oz) {
    f = cpuNow(S, f);
    if (!f.layers) throw new Error('a region in the pool written at another oz (prepare it first)');
    f = { ...reslice(S, f), relief: undefined };
  }
  const { core, W, R } = S;
  const tl = performance.now();
  // (round 107, pages: where the region's pages lie)
  const sl = regionSlots(S, lx, ly);
  // (round 106: what lay there before, frozen by the slide, read first)
  fillAt(S, sl[0]);
  for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) S.outside[regionIdx(S, sl, c, r)] = f.outside[r * R + c];
  const dev = core.host.gpu.device;
  const wg = core.world;
  const table = core.packed.chunkTable;
  const cx = W / CHUNK;
  const rc = R / CHUNK;
  const pageWords = S.pageSlots * SLOT_WORDS;
  const tb = performance.now();
  const slot = f.slot;
  if (slot && !f.layers) {
    // (round 100) from the pool: copies on the GPU only
    const enc = dev.createCommandEncoder({ label: 'stream thaw' });
    copyIn(S, enc, slot.buf, slot.off, lx, ly, slot.id < 0);
    for (const t of S.texs) {
      if (t.keep) continue;
      const tw = (R / t.div) * t.per;
      const th = R / t.div;
      const b = blankBuf(S, tw, th, t.fill);
      for (const q of texRegion(S, lx, ly, t, b.rowBytes)) enc.copyBufferToTexture({ buffer: b.buf, offset: q.off, bytesPerRow: b.rowBytes }, { texture: t.tex, origin: q.origin }, q.size);
    }
    dev.queue.submit([enc.finish()]);
    S.pool.release(slot);
    S.times.thaw.push(performance.now() - tl);
    record('rs.thaw', performance.now() - tl);
    if (S.times.thaw.length > 400) S.times.thaw.shift();
    record('write.pool', performance.now() - tl);
  } else {
    if (slot) S.pool.release(slot);
    const layers = f.layers!;
    for (let j = 0; j < rc; j++)
      for (let i = 0; i < rc; i++) {
        const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
        const page = layers.subarray((j * rc + i) * pageWords, (j * rc + i + 1) * pageWords);
        dev.queue.writeBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, page);
      }
    record('write.layers', performance.now() - tl);
    // (round 98) the kept buffers' region in one upload, then a copy a row on the GPU: a row's writeBuffer each
    // (~800 a region) was most of a slide's frame
    const kept = S.bufs.filter((b) => b.keep);
    const size = kept.reduce((n, b) => n + R * R * b.stride * b.planes, 0);
    if (!S.writeStage || S.writeStage.size < size) {
      S.writeStage?.destroy();
      S.writeStage = wg.buf('streamWrite', size, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE);
      S.writeHost = new Uint8Array(size);
    }
    const host = S.writeHost!;
    const enc = dev.createCommandEncoder({ label: 'stream write' });
    let off = 0;
    for (const b of kept) {
      const d = f.bufs?.[b.name];
      const n = R * R * b.stride * b.planes;
      // (round 104: a dispatch a buffer, not a copy a row; round 107: staged page-major, the region's pages to their slots)
      regionRects(S, b, sl, true, d ? S.writeStage : null, off / 4);
      if (d) host.set(regionRowsToPages(d.subarray(0, n), R, b.stride, b.planes, true), off);
      off += n;
    }
    dev.queue.writeBuffer(S.writeStage, 0, host, 0, size);
    S.copier.encode(enc);
    record('write.bufs', performance.now() - tb);
    for (const t of S.texs) {
      const tw = (R / t.div) * t.per;
      const th = R / t.div;
      const d = t.keep ? f.texs?.[t.name] : undefined;
      if (d) for (const q of texRegion(S, lx, ly, t, tw * 16)) dev.queue.writeTexture({ texture: t.tex, origin: q.origin }, d, { offset: q.off, bytesPerRow: tw * 16 }, q.size);
      else {
        const b = blankBuf(S, tw, th, t.fill);
        for (const q of texRegion(S, lx, ly, t, b.rowBytes)) enc.copyBufferToTexture({ buffer: b.buf, offset: q.off, bytesPerRow: b.rowBytes }, { texture: t.tex, origin: q.origin }, q.size);
      }
    }
    dev.queue.submit([enc.finish()]);
  }
  S.winInfo.set(key, f.info);
  if (S.verify && f.info.last !== undefined) verifyNow(S, lx, ly, key, f.how, f.info.last);
  if (f.things?.length) for (const t of S.things) t.give(f.things, lx, ly);
  record('write.gpu', performance.now() - tb);
  // (round 128j: the static grids' claims with the land, on the GPU, before anything reads it)
  const tcl = performance.now();
  for (const cb of S.onWritten) cb(lx, ly, R, R);
  record('write.claims', performance.now() - tcl);
  const tc = performance.now();
  const surf = core.map.surface;
  // (round 106: the CPU's per-column arrays where the region lies — round 107: its pages' rows at their slots)
  regionPut(S, surf, sl, f.surface);
  // (the ground: its own if the source said, else the surface)
  regionPut(S, S.ground, sl, f.ground ?? f.surface);
  // (hybrid) the relief of what came in (round 98: made ahead when it was ready; the ground's offset to the surface,
  // and the runs in world z, are the same whatever oz it's cut at)
  const rf = f.relief;
  if (rf) {
    regionPut(S, S.relief, sl, rf.relief);
    regionPut(S, S.gapTop, sl, rf.gapTop);
    regionPut(S, S.colTop, sl, rf.colTop);
  } else
  for (let r = 0; r < R; r++)
    for (let c = 0; c < R; c++) {
      const i = regionIdx(S, sl, c, r);
      setRelief(S, i, joinColumn(columnOf(S, f.layers!, c, r), f.oz, f.outside[r * R + c]), surf[i], S.ground[i]);
    }
  record('write.cpu', performance.now() - tc);
  const tr = performance.now();
  for (const cb of S.onRelief) cb(lx, ly, lx + R, ly + R);
  record('write.onRelief', performance.now() - tr);
  const ta = performance.now();
  if (f.judge) for (const cb of S.onArrive) cb(lx + f.judge[0], ly + f.judge[1], lx + f.judge[2], ly + f.judge[3]);
  record('write.onArrive', performance.now() - ta);
}

/** (round 100) a texture region's blank (its fill), on the GPU once, copied in where nothing is kept */
export function blankBuf(S: Streamer, tw: number, th: number, fill?: [number, number, number, number]): { buf: GPUBuffer; rowBytes: number } {
  const k = `${tw}x${th}:${fill ?? ''}`;
  let b = S.blankGpu.get(k);
  if (!b) {
    const rowBytes = align256(tw * 16);
    const d = new Float32Array((rowBytes / 4) * th);
    if (fill) for (let q = 0; q < d.length / 4; q++) d.set(fill, q * 4);
    const buf = S.core.world.buf(`streamBlank:${k}`, d.byteLength, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    S.core.host.gpu.device.queue.writeBuffer(buf, 0, d);
    b = { buf, rowBytes };
    S.blankGpu.set(k, b);
  }
  return b;
}

/** (round 104) a row of zeros on the GPU, at least `words` long (what the kernel clears from) */
export function zeros(S: Streamer, words: number): GPUBuffer {
  if (!S.zeroBuf || S.zeroBuf.size < words * 4) {
    // (an older one may be queued still: left to the world's dispose)
    S.zeroBuf = S.core.world.buf('streamZeros', Math.max(words * 4, 4096), GPUBufferUsage.STORAGE);
  }
  return S.zeroBuf;
}

/** the installed modules' per-column buffers (WorldCore.columnBufs) as the streamer's own */
export function moduleBufs(S: Streamer): ColBuf[] {
  const out: ColBuf[] = S.core.columnBufs.map((m) => ({ name: m.name, buf: m.buf, stride: m.stride, planes: m.planes, keep: false }));
  return out;
}

/** (hybrid) column i's relief from its runs (world z, joined), its surface and its ground's own top (window z) */
export function setRelief(S: Streamer, i: number, col: Interval[], surface: number, ground: number): void {
  setReliefIn(S, i, col, surface, ground);
}

/** (round 98) a region's relief, as writeNow would make it (the runs joined are world z: the same at any oz) */
export function reliefOf(S: Streamer, f: Frozen): NonNullable<Frozen['relief']> {
  const R = S.R;
  const out = { relief: new Uint8Array(R * R), gapTop: new Float32Array(R * R), colTop: new Float32Array(R * R) };
  const gr = f.ground ?? f.surface;
  for (let r = 0; r < R; r++)
    for (let c = 0; c < R; c++) {
      const i = r * R + c;
      setReliefIn(out, i, joinColumn(columnOf(S, f.layers!, c, r), f.oz, f.outside[i]), f.surface[i], gr[i]);
    }
  return out;
}

/** Streamer.editLive (the class keeps the method, documented there) */
export async function editLive(S: Streamer, x0: number, y0: number, x1: number, y1: number, at: (x: number, y: number) => { dr: number; cap?: number; dl: number; lmat: number } | null): Promise<number> {
  const { core, W, H } = S;
  const dev = core.host.gpu.device;
  const wg = core.world;
  const zMax = core.dims.zMax;
  const [layersBuf, vegBuf] = await Promise.all([core.readBuffer('layers'), core.readBuffer('veg')]);
  const slots = new Uint32Array(layersBuf.buffer, layersBuf.byteOffset, layersBuf.byteLength / 4);
  const veg = new Float32Array(vegBuf.buffer, vegBuf.byteOffset, W * H);
  flushFills(S);
  const table = core.packed.chunkTable;
  const cx = W / CHUNK;
  const K = S.K;
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const d = at(x, y);
      if (!d || (Math.abs(d.dr) < 0.05 && d.dl < 0.05)) continue;
      const i = y * W + x;
      const ci = Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK);
      const base = table[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
      const was: Interval[] = [];
      for (let s = 0; s < K; s++) {
        const iv = readSlot(slots, base + s);
        if (!iv) break;
        was.push(iv);
      }
      const full = joinColumn(was, S.oz, S.outside[S.oi(i)]);
      applyChange(full, d);
      const cut = splitColumn(full, S.oz, zMax);
      if (fitColumn(cut.inside, S.colK)) S.stats.fitted++;
      S.outside[S.oi(i)] = cut.outside;
      slots.set(packColumn(cut.inside, K), base * SLOT_WORDS);
      const si = S.oi(i);
      core.map.surface[si] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
      S.ground[si] += d.dr + (d.dl > 0.05 ? d.dl : 0);
      setRelief(S, si, full, core.map.surface[si], S.ground[si]);
      if (d.dl > 0.05) veg[i] *= Math.max(0, 1 - d.dl * 2);
      n++;
    }
  if (n) {
    S.touch(x0, y0, x1, y1);
    dev.queue.writeBuffer(wg.layers, 0, slots);
    // (ringwin: read in window order, written back in the ring's)
    const vegR = core.ring.toStore(veg);
    for (const b of [wg.veg, wg.vegNext]) dev.queue.writeBuffer(b, 0, vegR);
    core.clearUndo();
    for (const f of S.onRelief) f(Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1));
  }
  return n;
}
