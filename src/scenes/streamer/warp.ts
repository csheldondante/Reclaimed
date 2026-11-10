// Jumps: the window moved far at once (warp: everything re-made where it lands) and up or down (slideZNow, the
// window's height). API: warp (Streamer.warp), slideZNow.
import { CHUNK, SLOT_WORDS, WORLD_FLOOR, fitColumn, joinColumn, packColumn, readSlot, splitColumn, waterInWindow, type Interval } from '../../world/layout';
import { freezePlan, frozeInto } from './freeze';
import { flushFills } from './store';
import { bring, evict, prepare } from './jobs';
import { moduleBufs, write } from './write';
import { WARP_RING, SESSION, TIER, Frozen, topInside } from './defs';
import type { Streamer } from '../streamer';

/** Streamer.warp (the class keeps the method, documented there) */
export async function warp(S: Streamer, ox: number, oy: number, oz: number, fresh = false): Promise<void> {
  if (ox % S.R || oy % S.R) throw new Error(`a warp's origin must be whole regions of ${S.R}`);
  // (round 128m: under z 0 too, down to the world's floor — a window slid into a deep pit)
  if (oz % TIER || oz < WORLD_FLOOR) throw new Error(`a warp's oz must be whole tiers of ${TIER}, at the world's floor or over`);
  while (S.busy || !S.store) await new Promise((r) => setTimeout(r, 16));
  S.busyWhy = 'warp';
  S.busy = true;
  flushFills(S);
  const t0 = performance.now();
  const { core, W, H, R } = S;
  try {
    for (const f of S.onBeforeSlide) f(0, 0, 0);
    S.heldNow = true;
    core.windowEpoch++;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const spots: [number, number][] = [];
    for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) spots.push([lx, ly]);
    // (round 100) what the window holds into the pool (a fresh warp makes it again: dropped)
    if (!fresh) {
      // (round 106: planned and every region copied out at once — frozeInto — and their CPU parts read)
      frozeInto(S, freezePlan(S, spots, 0, 0));
      flushFills(S);
      S.stats.frozen += spots.length;
    } else {
      for (const k of [...S.frozen.keys()]) if (S.frozen.get(k)!.how === 'made') evict(S, k);
      S.winInfo.clear();
    }
    // (round 102: what's made or under way for the land there — precache — is the warp's to use; a fresh warp's
    // the window made again: dropped)
    if (fresh) {
      S.jobs.clear();
      S.made.clear();
    }
    S.origin[0] = ox;
    S.origin[1] = oy;
    S.oz = oz;
    core.globals.origin = [ox, oy];
    const enc = dev.createCommandEncoder({ label: 'stream warp' });
    for (const b of [...S.bufs, ...moduleBufs(S)]) if (!b.keep) enc.clearBuffer(b.buf);
    enc.clearBuffer(wg.particles);
    dev.queue.submit([enc.finish()]);
    const landsP = Promise.all(
      spots.map(async ([lx, ly]) => {
        const key = S.key((ox + lx) / R, (oy + ly) / R);
        if (fresh) {
          const f = S.frozen.get(key);
          if (f) evict(S, key);
          if (S.store?.has(key)?.session === SESSION) await S.store.delete(key);
        }
        let f: Frozen;
        const done = S.made.get(key);
        const job = S.jobs.get(key);
        if (done) {
          S.made.delete(key);
          if (S.frozen.get(key) === done) S.frozen.delete(key);
          S.stats.warpReady++;
          f = done;
        } else if (job) {
          S.jobs.delete(key);
          S.taken.add(job);
          S.stats.warpReady++;
          f = await job;
        } else f = await bring(S, key, ox + lx, oy + ly, fresh);
        if (f.oz !== S.oz) f = await prepare(S, f);
        if (f.how === 'thawed') S.stats.thawed++;
        else if (f.how === 'made') S.stats.generated++;
        return { key, f };
      }),
    );
    // (round 102) the ring round it asked for now, after the window's own (the tiles go in the order asked): moving
    // off after landing finds it made
    if (WARP_RING > 0) S.precache(ox, oy, WARP_RING, true);
    const lands = await landsP;
    for (let k = 0; k < spots.length; k++) {
      const { key, f } = lands[k];
      if (S.frozen.get(key)?.slot === f.slot) S.frozen.delete(key);
      write(S, f, spots[k][0], spots[k][1], key);
    }
    // (everything built is made again where it is now)
    core.renderer.windowMoved(1 << 12, 0, [0, 0, 0]);
    S.refreshBand();
    core.clearUndo();
    core.windowEpoch++;
    for (const f of S.onWarp) f(ox, oy, oz);
  } finally {
    S.busy = false;
    S.heldNow = false;
    // (merge122) the travel's pinned window is written (or no longer wanted): released once the warp is done
    S.pinned.clear();
  }
  S.stats.lastMs = +(performance.now() - t0).toFixed(1);
}

export async function slideZNow(S: Streamer, dz: number): Promise<void> {
  const { core, W, H, R } = S;
  const dev = core.host.gpu.device;
  const wg = core.world;
  const zMax = core.dims.zMax;
  const N = W * H;
  const [layersBuf, waterBuf, lavaBuf] = await Promise.all([core.readBuffer('layers'), core.readBuffer('water'), core.readBuffer('lava')]);
  const slots = new Uint32Array(layersBuf.buffer, layersBuf.byteOffset, layersBuf.byteLength / 4);
  const water = new Float32Array(waterBuf.buffer, waterBuf.byteOffset, N);
  const lava = new Float32Array(lavaBuf.buffer, lavaBuf.byteOffset, N * 4);
  flushFills(S);
  const table = core.packed.chunkTable;
  const cx = W / CHUNK;
  const K = S.K;
  const out = slots.slice();
  const oz = S.oz + dz;
  const surf = core.map.surface;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const ci = Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK);
      const base = table[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
      const was: Interval[] = [];
      for (let s = 0; s < K; s++) {
        const iv = readSlot(slots, base + s);
        if (!iv) break;
        was.push(iv);
      }
      const wasTop = was.length > 0 && !S.outside[S.oi(i)].some((iv) => iv.z0 >= S.oz + zMax);
      // (round 88) its water's level (world z), as reslice's
      const level = S.oz + (was.length ? was[was.length - 1].z1 : 0) + water[i];
      const overTop = S.outside[S.oi(i)].some((iv) => iv.z0 >= S.oz + zMax);
      const cut = splitColumn(joinColumn(was, S.oz, S.outside[S.oi(i)]), oz, zMax);
      if (fitColumn(cut.inside, S.colK)) S.stats.fitted++;
      S.outside[S.oi(i)] = cut.outside;
      out.set(packColumn(cut.inside, K), base * SLOT_WORDS);
      surf[S.oi(i)] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
      water[i] = overTop ? 0 : waterInWindow(cut, oz, zMax, level);
      if (!(wasTop && topInside(cut, oz, zMax))) {
        lava.fill(0, i * 4, i * 4 + 4);
      } else if (lava[i * 4] > 0) lava[i * 4 + 3] -= dz;
    }
  dev.queue.writeBuffer(wg.layers, 0, out);
  // (round 128o, DA-B9: every chunk's version moved)
  core.columnsWritten('all');
  // (ringwin: read in window order, written back in the ring's)
  const waterR = core.ring.toStore(water);
  const lavaR = core.ring.toStore(lava, 4);
  for (const b of [wg.water, wg.waterPrev]) dev.queue.writeBuffer(b, 0, waterR);
  for (const b of [wg.lava, wg.lavaNext]) dev.queue.writeBuffer(b, 0, lavaR);
  // (particles in the air: dropped, as on a slide sideways)
  const enc = dev.createCommandEncoder({ label: 'stream slide z' });
  enc.clearBuffer(wg.particles);
  dev.queue.submit([enc.finish()]);
  S.oz = oz;
  for (let i = 0; i < N; i++) S.ground[i] -= dz;
  core.camera.shift(0, 0, dz);
  for (const f of core.onShift) f(0, 0, dz);
  core.windowEpoch++;
  core.renderer.windowMoved(0, 0, [0, 0, -dz]);
  S.refreshBand();
  core.clearUndo();
  void R;
  for (const f of S.onSlide) f(0, 0, dz);
}
