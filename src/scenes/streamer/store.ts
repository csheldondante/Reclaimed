// Keeping regions: what's saved to the region store (hashed against the generator's, so unchanged land isn't
// written), the sweep that writes changed regions, deferred work, verification, and loading or restoring them.
// API: saveItem, fillAt, flushFills, check, checkOne, hashed, later, drainLater, sweep, verifyNow, load, restore.
import { record } from '../../gpu/cpustat';
import { RegionStore } from '../../world/region-store';
import { columnsHash, columnsHashSteps, decodeRecord, encodeRecord, recordMismatch } from '../../world/region-record';
import { regionOf, regionSlots } from './regions';
import { reslice } from './generate';
import { write } from './write';
import { SWEEP_MS, LATER_MS, HASH_SLICE_MS, SESSION, Frozen, SaveItem, NO_F32, NO_U8 } from './defs';
import type { Streamer } from '../streamer';

/**
 * (round 100) the CPU parts of the window's region at (lx, ly), for the store. (Round 106, frameprobe: read later —
 * `fill` — from where the region lies on the ring: the CPU's per-column arrays are on the ring, so a slide leaves them
 * where they are until the region coming in is written there, and whatever writes there fills first (Streamer.fills).
 * The slide's own frame no longer copies a strip of them.)
 */
export function saveItem(S: Streamer, lx: number, ly: number, key: string, now = false): SaveItem {
  let info = S.winInfo.get(key);
  if (!info) S.winInfo.set(key, (info = {}));
  const sl = regionSlots(S, lx, ly);
  const at = sl[0];
  const it: SaveItem = { key, x0: S.origin[0] + lx, y0: S.origin[1] + ly, oz: S.oz, outside: [], surface: NO_F32, ground: NO_F32, relief: { relief: NO_U8, gapTop: NO_F32, colTop: NO_F32 }, info };
  it.fill = () => {
    it.fill = undefined;
    it.outside = S.regionOutside(sl);
    it.surface = regionOf(S, S.core.map.surface, sl);
    it.ground = regionOf(S, S.ground, sl);
    it.relief = { relief: regionOf(S, S.relief, sl), gapTop: regionOf(S, S.gapTop, sl), colTop: regionOf(S, S.colTop, sl) };
  };
  if (now) it.fill();
  else S.fills.push({ at, it });
  return it;
}

/** (round 106) the frozen region at ring place `at` read before something writes there */
export function fillAt(S: Streamer, at: number): void {
  if (!S.fills.length) return;
  const t0 = performance.now();
  for (const f of S.fills) if (f.at === at) f.it.fill?.();
  S.fills = S.fills.filter((f) => f.it.fill);
  record('fz.fill', performance.now() - t0);
}

/** (round 106) every frozen region's CPU parts read (before the window's columns are written other than a region at a time) */
export function flushFills(S: Streamer): void {
  if (!S.fills.length) return;
  const t0 = performance.now();
  for (const f of S.fills) f.it.fill?.();
  S.fills = [];
  record('fz.fill', performance.now() - t0);
}

/**
 * (round 100) Regions read back (`stage`, one after another in the layout) and hashed: each that changed since it
 * was made or last saved is written to the store, whole. Nothing waits for it but a load of the same region.
 */
export function check(S: Streamer, stage: GPUBuffer, items: SaveItem[]): void {
  // (round 104) each region's hash and record a task of its own, a few a frame (Streamer.later): the strip's eight in
  // one callback were a long task; the stage read in place, unmapped when the last is done (no 13 MB copy)
  const p = stage.mapAsync(GPUMapMode.READ).then(
    () =>
      new Promise<void>((res) => {
        const all = new Uint8Array(stage.getMappedRange());
        let left = items.length;
        const end = () => {
          if (--left > 0) return;
          stage.unmap();
          stage.destroy();
          for (const a of [S.times.hash, S.times.encode]) if (a.length > 400) a.splice(0, a.length - 400);
          res();
        };
        if (!left) {
          left = 1;
          end();
        }
        items.forEach((it, k) =>
          later(S, () => {
            try {
              checkOne(S, all, k, it, end);
            } catch (e) {
              end();
              throw e;
            }
          }),
        );
      }),
    () => stage.destroy(),
  );
  for (const it of items) {
    const was = S.checks.get(it.key);
    const q = was ? Promise.all([was, p]).then(() => {}) : p;
    S.checks.set(it.key, q);
    void q.then(() => S.checks.get(it.key) === q && S.checks.delete(it.key));
  }
}

/**
 * (round 104) one region of a readback hashed and, if play changed it since it was saved, written to the store;
 * `done` once it's through (the readback is let go then). (Round 106, tilephone: hashed a few rows a turn of
 * Streamer.later — HASH_SLICE_MS each — not whole inside one frame: the phone's rs.hash, 1.1-2.7 ms.)
 */
export function checkOne(S: Streamer, all: Uint8Array, k: number, it: SaveItem, done: () => void): void {
  const L = S.layout;
  const body = all.subarray(k * L.bytes, (k + 1) * L.bytes);
  // (round 106: its CPU parts, if not read yet — still where it lay: whatever writes there reads them first)
  it.fill?.();
  // (not touched by play: nothing to keep — the source makes it again; hashed only for ?rsverify)
  if (!it.info.changed && !S.verify) {
    done();
    return;
  }
  const g = columnsHashSteps(new Uint32Array(all.buffer, k * L.bytes, (L.rc * L.rc * L.pageBytes) / 4), L, it.outside, it.oz, undefined, 4);
  let spent = 0;
  const step = () => {
    let ok = false;
    try {
      const t0 = performance.now();
      let r = g.next();
      while (!r.done && performance.now() - t0 < HASH_SLICE_MS) r = g.next();
      spent += performance.now() - t0;
      record('rs.hash', performance.now() - t0);
      if (!r.done) {
        ok = true;
        later(S, step);
        return;
      }
      hashed(S, body, it, r.value, spent);
      ok = true;
      done();
    } finally {
      if (!ok) done();
    }
  };
  step();
}

/** (round 106) a region's hash in: kept, and written to the store if play changed it since it was saved */
export function hashed(S: Streamer, body: Uint8Array, it: SaveItem, h: number, spent: number): void {
  const L = S.layout;
  S.times.hash.push(spent);
  S.stats.checked++;
  it.info.last = h;
  if (!it.info.changed || h === it.info.saved || !S.store || S.halted) return;
  const t1 = performance.now();
  const [rx, ry] = it.key.split(',').map(Number);
  const rec = encodeRecord(
    { world: S.save.world, rx, ry, x0: it.x0, y0: it.y0, oz: it.oz, sig: L.sig, session: SESSION, savedAt: Date.now(), hash: h, things: it.things },
    body,
    { oz: it.oz, outside: it.outside, surface: it.surface, ground: it.ground, relief: it.relief },
  );
  S.times.encode.push(performance.now() - t1);
  record('rs.encode', performance.now() - t1);
  it.info.saved = h;
  S.stats.saved++;
  void S.store.put(it.key, rec, { session: SESSION, hash: h });
}

/**
 * (round 104) Main-thread work that isn't the frame's (a readback's hashing and encoding): run from update() while
 * it fits LATER_MS of the frame (one at least), at once while the page is hidden (no frames come then).
 */
export function later(S: Streamer, f: () => void): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') f();
  else S.laterQ.push(f);
}

export function drainLater(S: Streamer): void {
  const t0 = performance.now();
  for (let n = 0; S.laterQ.length && (n === 0 || performance.now() - t0 < LATER_MS); n++) S.laterQ.shift()!();
}

/**
 * (round 100) The window's regions read back for the store: the next one (every SWEEP_MS), or all of them (the
 * page hidden). Not while a slide or a warp is under way, a region not written yet, or something falling.
 */
export function sweep(S: Streamer, all = false): boolean {
  if (!S.store || S.busy || S.heldNow || S.sweeping) return false;
  if (S.canSave.some((f) => !f())) return false;
  const now = performance.now();
  if (!all && now - S.sweepT < SWEEP_MS) return false;
  S.sweepT = now;
  const { W, H, R } = S;
  const spots: [number, number][] = [];
  for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) spots.push([lx, ly]);
  // (round 104: only what play changed, or ?rsverify — the rest is made again when it's wanted: its readback was for
  // nothing. DA-B13: between, only what play touched since its last read — the next such in the round, one a sweep:
  // read after the edit, not polled — a region touched once was read back, whole, every round after)
  const info = ([lx, ly]: [number, number]) => S.winInfo.get(S.key((S.origin[0] + lx) / R, (S.origin[1] + ly) / R));
  const wanted = (p: [number, number]) => !S.unwritten.some(([x, y]) => x === p[0] && y === p[1]) && (S.verify || (all ? !!info(p)?.changed : !!info(p)?.dirty));
  let go: [number, number][];
  if (all) go = spots.filter(wanted);
  else {
    go = [];
    for (let k = 0; k < spots.length; k++) {
      const p = spots[(S.sweepAt + k) % spots.length];
      if (!wanted(p)) continue;
      S.sweepAt += k + 1;
      go = [p];
      break;
    }
  }
  // (nothing touched: nothing to read)
  if (!go.length) return all;
  const dev = S.core.host.gpu.device;
  const L = S.layout;
  const stage = dev.createBuffer({ label: 'region save', size: L.bytes * go.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = dev.createCommandEncoder({ label: 'region save' });
  go.forEach(([lx, ly], k) => S.copyOut(enc, lx, ly, stage, k * L.bytes, false));
  dev.queue.submit([enc.finish()]);
  for (const p of go) {
    const i = info(p);
    if (i) i.dirty = false;
  }
  const items = go.map(([lx, ly]) => {
    // (a region staying in the window: its CPU parts read now, with its readback)
    const it = saveItem(S, lx, ly, S.key((S.origin[0] + lx) / R, (S.origin[1] + ly) / R), true);
    const things = S.things.flatMap((t) => t.take(lx, ly, lx + R, ly + R, true));
    if (things.length) it.things = things;
    return it;
  });
  S.sweeping = true;
  check(S, stage, items);
  void Promise.all(items.map((it) => S.checks.get(it.key))).finally(() => (S.sweeping = false));
  return true;
}

export function verifyNow(S: Streamer, lx: number, ly: number, key: string, how: string, want: number): void {
  const dev = S.core.host.gpu.device;
  const L = S.layout;
  const st = dev.createBuffer({ label: 'region verify', size: L.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = dev.createCommandEncoder({ label: 'region verify' });
  S.copyOut(enc, lx, ly, st, 0, false);
  dev.queue.submit([enc.finish()]);
  const out = S.regionOutside(regionSlots(S, lx, ly)).map((c) => c.slice());
  const oz = S.oz;
  void st.mapAsync(GPUMapMode.READ).then(() => {
    const body = new Uint8Array(st.getMappedRange()).slice();
    st.unmap();
    st.destroy();
    const h = columnsHash(new Uint32Array(body.buffer, 0, (L.rc * L.rc * L.pageBytes) / 4), L, out, oz);
    S.verified.push({ key, how, same: h === want, at: performance.now() });
  });
}

/** (round 100) A region's record from the store as a frozen region (null: none usable — why reported). */
export async function load(S: Streamer, key: string): Promise<Frozen | null> {
  const s = S.store;
  if (!s?.has(key)) return null;
  const t0 = performance.now();
  let bytes: Uint8Array;
  try {
    bytes = await s.get(key);
  } catch (e) {
    S.stats.loadFailed++;
    console.error(`[worldsave] ${(e as Error).message} — the region is made again from the generator, its changes lost`);
    return null;
  }
  // (round 104: 'rs.load' the main thread's part only — the decode; the wait for the worker isn't the frame's, and
  // the recorder counted it as a step 30–77 ms long)
  const td = performance.now();
  const d = decodeRecord(bytes, S.R);
  record('rs.load', performance.now() - td);
  const why = recordMismatch(d.header, S.layout, S.save.world);
  if (why) {
    S.stats.mismatched++;
    console.warn(`[worldsave] region ${key}'s record can't be used: ${why} — the region is made again`);
    void s.delete(key);
    return null;
  }
  S.stats.loaded++;
  S.times.load.push(performance.now() - t0);
  const { meta, header } = d;
  return {
    body: d.body,
    oz: meta.oz,
    outside: meta.outside,
    surface: meta.surface,
    ground: meta.ground,
    relief: meta.relief,
    // (the coarse world's snapshot: this session's when it left the pool, else the coarse world now — another
    // session's coarse world started again)
    snap: S.snaps.get(key) ?? S.source.snapshot?.(header.x0, header.y0, S.R, S.R),
    info: { saved: header.hash, last: header.hash, changed: true },
    how: 'loaded',
    things: header.things,
  };
}

/**
 * (round 100) On load: the window's regions that have a record written in as they were saved (the window
 * otherwise is as the source made it). Busy meanwhile; what the game keeps in window coordinates told as by a warp.
 */
export async function restore(S: Streamer, s: RegionStore): Promise<void> {
  const { W, H, R } = S;
  const spots: [number, number][] = [];
  for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) if (s.has(S.key((S.origin[0] + lx) / R, (S.origin[1] + ly) / R))) spots.push([lx, ly]);
  if (!spots.length) return;
  while (S.busy) await new Promise((r) => setTimeout(r, 16));
  S.busyWhy = 'restore';
  S.busy = true;
  S.heldNow = true;
  const t0 = performance.now();
  try {
    for (const f of S.onBeforeSlide) f(0, 0, 0);
    S.core.windowEpoch++;
    S.store = s;
    let n = 0;
    for (const [lx, ly] of spots) {
      const key = S.key((S.origin[0] + lx) / R, (S.origin[1] + ly) / R);
      let f = await load(S, key);
      if (!f) continue;
      if (f.oz !== S.oz) f = reslice(S, f);
      write(S, f, lx, ly);
      void S.source.restored?.(S.origin[0] + lx, S.origin[1] + ly, R, R);
      n++;
    }
    S.store = null;
    S.core.renderer.windowMoved(1 << 12, 0, [0, 0, 0]);
    S.refreshBand();
    S.core.clearUndo();
    S.core.windowEpoch++;
    S.stats.restored += n;
    for (const f of S.onWarp) f(S.origin[0], S.origin[1], S.oz);
    console.log(`[worldsave] ${n} saved regions of ${S.save.world} restored into the window in ${(performance.now() - t0).toFixed(0)} ms`);
  } finally {
    S.busy = false;
    S.heldNow = false;
  }
}
