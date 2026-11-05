// The slide: following the camera (update, track), waiting for the regions coming in, and the slide itself — the
// regions leaving frozen, everything per column moved a region over, the new land written. API: update (Streamer.update),
// slideWhenReady, track, doneAfter, slideNow.
import { record, timed } from '../../gpu/cpustat';
import { CHUNK, WORLD_FLOOR } from '../../world/layout';
import { ROW_H, cellAt } from '../../world/lattice';
import { clearPages, enteringFor, nearFirst, regionRects, regionSlots, strip } from './regions';
import { freezeAt, freezePlan, frozeInto } from './freeze';
import { drainLater, flushFills, sweep } from './store';
import { bring, prepare, pump, startJob } from './jobs';
import { moduleBufs, write } from './write';
import { SLIDE_SKIP, LEAD, STREAM_OLD, ARRIVE_URGENT, WRITE_MS, POOL_CAP, AHEAD, AHEAD_S, AHEAD_MAX, MOVING, TIER, MESH_CHUNK, SlideTrace } from './defs';
import type { Streamer } from '../streamer';

/** Streamer.update (the class keeps the method, documented there) */
export function update(S: Streamer): Promise<void> | null {
  track(S);
  // (round 100: not before the store's index is read — a region made then might have had a record)
  if (!S.store) return null;
  pump(S);
  drainLater(S);
  if (!S.busy && performance.now() - S.baseAt > 500) {
    S.baseAt = performance.now();
    doneAfter(S, S.baseDone);
  }
  if (S.busy || !S.auto) return null;
  sweep(S);
  const [x, yw] = S.core.camera.target;
  const y = yw / ROW_H;
  const R = S.R;
  const reach = R * 0.75;
  const near = R * 0.4;
  const ahead = (v: number) => Math.max(-2 * R, Math.min(2 * R, v * LEAD));
  const px = x + ahead(S.vel[0]);
  const py = y + ahead(S.vel[1]);
  const hx = S.W / 2;
  const hy = S.H / 2;
  if (Math.max(x, px) > hx + near) S.prefetch(R, 0);
  if (Math.min(x, px) < hx - near) S.prefetch(-R, 0);
  if (Math.max(y, py) > hy + near) S.prefetch(0, R);
  if (Math.min(y, py) < hy - near) S.prefetch(0, -R);
  if (px > hx + reach + R) S.prefetch(2 * R, 0);
  if (px < hx - reach - R) S.prefetch(-2 * R, 0);
  if (py > hy + reach + R) S.prefetch(0, 2 * R);
  if (py < hy - reach - R) S.prefetch(0, -2 * R);
  // (round 100) along the camera's motion: AHEAD strips, into the pool before the slides that need them
  // (round 102: by its speed — AHEAD_S seconds of it, AHEAD strips at least, AHEAD_MAX at most; each strip between)
  // (and only while what's made ahead and under way leaves the pool room: the phone's ride made 6x the regions it
  // used with round 102's first ahead, the pool evicting land made ahead to make more)
  if (!STREAM_OLD && AHEAD > 0 && S.made.size + S.jobs.size < POOL_CAP / 2) {
    // (round 113: the planner's reach — speed × the land's and the window's measured latency, and a margin — in strips
    // along each axis of the motion; before, AHEAD_S seconds or AHEAD strips)
    const rc = S.reach;
    const strips = (v: number, d: number) => Math.max(AHEAD, Math.min(AHEAD_MAX, rc ? Math.ceil((rc.land * Math.abs(d)) / R) : Math.ceil((Math.abs(v) * AHEAD_S) / R)));
    if (Math.abs(S.vel[0]) > MOVING) for (let k = 2, n = strips(S.vel[0], rc?.dir[0] ?? 0); k <= n; k++) S.prefetch(Math.sign(S.vel[0]) * k * R, 0);
    if (Math.abs(S.vel[1]) > MOVING) for (let k = 2, n = strips(S.vel[1], rc?.dir[1] ?? 0); k <= n; k++) S.prefetch(0, Math.sign(S.vel[1]) * k * R);
  }
  // in z: the ground under the camera near the window's top or bottom
  const h = S.source.height;
  if (h) {
    const [cx, cy] = cellAt(x, yw);
    if (cx >= 0 && cy >= 0 && cx < S.W && cy < S.H) {
      const g = S.ground[S.colIdx(cx, cy)];
      const zMax = S.core.dims.zMax;
      // (round 128m, quarry: or the ground as it is now where it's dug under the land's — a pit's floor — down to the
      // world's floor, past z 0; the sea's floor near z 0 slides nothing, as before)
      const now = S.groundNow?.(x, yw) ?? g;
      if (g > zMax - 40 && S.oz + zMax < h) return S.slideZ(TIER);
      if (g < 24 && S.oz > 0) return S.slideZ(-TIER);
      if (now < 24 && now < g - 2 && S.oz - TIER >= WORLD_FLOOR) return S.slideZ(-TIER);
    }
  }
  // (the slide itself where the camera is: sliding early for where it's heading slid twice as often on a
  // winding road — back again at each bend — for no nearer edge: DEVLOG round 91)
  // (round 113, tilesfirst: and where it will be in the window's latency at its speed — the planner's slide reach, along
  // the motion only, at most a region: the strip is in the window and drawn by the time the screen's there)
  const sl = S.reach ? Math.min(R, S.reach.slide) : 0;
  const sx = x + (S.reach ? S.reach.dir[0] * sl : 0);
  const sy = y + (S.reach ? S.reach.dir[1] * sl : 0);
  if (sx > hx + reach && x > hx) return slideWhenReady(S, R, 0);
  if (sx < hx - reach && x < hx) return slideWhenReady(S, -R, 0);
  if (sy > hy + reach && y > hy) return slideWhenReady(S, 0, R);
  if (sy < hy - reach && y < hy) return slideWhenReady(S, 0, -R);
  return null;
}

/** (round 98) the slide once its land is ready (asked for now if it wasn't); before round 98, at once */
export function slideWhenReady(S: Streamer, dx: number, dy: number): Promise<void> | null {
  if (STREAM_OLD) return S.slide(dx, dy);
  S.prefetch(dx, dy);
  const R = S.R;
  for (const [lx, ly] of enteringFor(S, dx, dy)) {
    const key = S.key((S.origin[0] + dx + lx) / R, (S.origin[1] + dy + ly) / R);
    const m = S.made.get(key);
    if (!m || m.oz !== S.oz) {
      // (round 100: made at another oz — the window slid in z since — cut again first)
      if (m) {
        S.made.delete(key);
        startJob(S, key, prepare(S, m));
      }
      S.waited++;
      return null;
    }
  }
  return S.slide(dx, dy);
}

/** the camera's velocity, from its target's world cell frame to frame (a jump — a warp — isn't motion) */
export function track(S: Streamer): void {
  const t = performance.now() / 1000;
  const [x, yw] = S.core.camera.target;
  const wx = S.origin[0] + x;
  const wy = S.origin[1] + yw / ROW_H;
  const l = S.last;
  S.last = [wx, wy, t];
  if (!l) return;
  const dt = t - l[2];
  const dx = wx - l[0];
  const dy = wy - l[1];
  if (dt <= 0) return;
  if (dt > 0.5 || Math.hypot(dx, dy) > 2 * S.R) {
    S.vel[0] = S.vel[1] = 0;
    return;
  }
  // (over about a quarter of a second)
  const a = Math.min(1, dt / 0.25);
  S.vel[0] += (dx / dt - S.vel[0]) * a;
  S.vel[1] += (dy / dt - S.vel[1]) * a;
}

export function doneAfter(S: Streamer, into: number[]): void {
  const t0 = performance.now();
  void S.core.host.gpu.device.queue.onSubmittedWorkDone().then(() => {
    into.push(+(performance.now() - t0).toFixed(1));
    if (into.length > 64) into.shift();
  });
}

export async function slideNow(S: Streamer, dx: number, dy: number, tr: SlideTrace): Promise<void> {
  for (const f of S.onBeforeSlide) f(dx, dy, 0);
  const tSync = performance.now();
  // (a readback that straddles the slide is stale: round 80)
  S.core.windowEpoch++;
  const { core, W, H, R } = S;
  const dev = core.host.gpu.device;
  const wg = core.world;
  const table = core.packed.chunkTable;
  const cx = W / CHUNK;
  const cy = H / CHUNK;
  // what leaves (old window cells) and what comes in (new window cells)
  const leaving = dx > 0 ? strip(S, 0, dx, 0, H) : dx < 0 ? strip(S, W + dx, W, 0, H) : dy > 0 ? strip(S, 0, W, 0, dy) : strip(S, 0, W, H + dy, H);
  // (round 90: nearest the camera first — what's written first, and what's made first when it wasn't asked ahead)
  const entering = nearFirst(S, enteringFor(S, dx, dy), dx, dy);

  // ---- 1. freeze what leaves: copies into the pool (round 100), read back for the store off the frame ----
  const enc = dev.createCommandEncoder({ label: 'stream slide' });
  // (round 104) the slide's GPU work timed (the profiler's 'slide' pass: an empty pass's start to another's end)
  const ts = core.host.profiler.timestamps('slide');
  if (ts) enc.beginComputePass({ label: 'slide t0', timestampWrites: { querySet: ts.querySet, beginningOfPassWriteIndex: ts.beginningOfPassWriteIndex } }).end();
  const tf = performance.now();
  const fz = SLIDE_SKIP.has('freeze') ? null : freezePlan(S, leaving, dx, dy);
  record('slide.freeze', performance.now() - tSync);
  // ---- 2. (round 105, ringwin) nothing moves: the window's columns stay where they lie on the ring ----------
  // (a world cell keeps its place mod the window's size: the strip coming in lies where the strip leaving lay —
  // what that held was frozen above; what isn't kept for it starts empty there, as a band of whole regions)
  const ring = core.ring;
  ring.slide(dx, dy);
  const mods = moduleBufs(S);
  // (particles in the air: dropped — Q28 follow-up: keep them, they're in window coordinates)
  enc.clearBuffer(wg.particles);
  // (round 106: each region's band is cleared as it's frozen — freezeAt; this, only when nothing is frozen: ?slideskip=freeze)
  if (!fz) {
    // (the band coming in, region by region where its pages lie — round 107, pages)
    for (const [lx, ly] of entering) {
      const sl = regionSlots(S, lx, ly);
      for (const b of [...S.bufs, ...mods]) {
        if (b.keep) continue;
        if (b.buf.usage & GPUBufferUsage.STORAGE) regionRects(S, b, sl, true, null, 0);
        else clearPages(S, enc, b, sl);
      }
    }
    S.copier.encode(enc);
  }
  if (ts) enc.beginComputePass({ label: 'slide t1', timestampWrites: { querySet: ts.querySet, endOfPassWriteIndex: ts.endOfPassWriteIndex } }).end();
  dev.queue.submit([enc.finish()]);
  doneAfter(S, S.slideDone);
  S.times.freeze.push(performance.now() - tf);
  record('rs.freeze', performance.now() - tf);
  if (S.times.freeze.length > 400) S.times.freeze.shift();
  const surf = core.map.surface;
  S.stats.frozen += leaving.length;

  record('slide.move', performance.now() - tSync);
  // ---- 3. the chunk table: pages move, the leaving chunks' pages are reused --
  // (round 106, frameprobe: a chunk coming in takes the pages of the one that left from the same place on the ring —
  // the table rotates with the ring — so what left lies untouched, pages and columns, until it's frozen: freezeAt)
  const old = table.slice();
  const dcx = dx / CHUNK;
  const dcy = dy / CHUNK;
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) {
      const si = (((i + dcx) % cx) + cx) % cx;
      const sj = (((j + dcy) % cy) + cy) % cy;
      table[(j * cx + i) * 2] = old[(sj * cx + si) * 2];
    }
  dev.queue.writeBuffer(wg.chunks, 0, table);

  record('slide.table', performance.now() - tSync);
  // ---- 4. the CPU's window coordinates move too ------------------------------
  S.origin[0] += dx;
  S.origin[1] += dy;
  core.globals.origin = [S.origin[0], S.origin[1]];
  let tg = performance.now();
  const lap = (label: string) => {
    const t = performance.now();
    record(label, t - tg);
    tg = t;
  };
  // (round 106, frameprobe: map.surface, the ground and the relief are on the ring — nothing moves)
  void surf;
  lap('sl.cpuGrids');
  core.camera.shift(dx, dy * ROW_H, 0);
  // (round 99, runstream) the world's queued events (edits past a tick's four wait for the next) are in window
  // coordinates too: they land where they were aimed, not a region off
  for (const ev of core.globals.events) {
    ev.x -= dx;
    ev.y -= dy * ROW_H;
  }
  // (what the game installed that lives in window coordinates: units, bodies — round 80)
  lap('sl.camEvents');
  core.onShift.forEach((f, k) => {
    f(dx, dy * ROW_H, 0);
    lap(`sl.onShift${k}`);
  });
  // (what's built moves with the land: round 73, nothing is built again but what came in fresh)
  core.renderer.windowMoved(dx / MESH_CHUNK, dy / MESH_CHUNK, [-dx, -dy * ROW_H, 0]);
  lap('sl.windowMoved');
  record('slide.grids', performance.now() - tSync);
  core.renderer.band?.shift(dx, dy);
  record('slide.band', performance.now() - tSync);
  core.weather.shift(dx, dy * ROW_H);
  record('slide.weather', performance.now() - tSync);
  core.clearUndo();
  record('slide.undo', performance.now() - tSync);
  S.onSlide.forEach((f, k) => {
    const t = performance.now();
    f(dx, dy, 0);
    record(`slide.cb${k}`, performance.now() - t);
  });

  record('slide', performance.now() - tSync);
  tr.sync = performance.now();
  // ---- 5. what comes in: from the pool (round 100: thawed, made or loaded ahead), or asked for now ----
  const coming = entering.map(([lx, ly]) => {
    const wx = S.origin[0] + lx;
    const wy = S.origin[1] + ly;
    const key = S.key(wx / R, wy / R);
    const done = S.made.get(key);
    const job = S.jobs.get(key);
    S.made.delete(key);
    S.jobs.delete(key);
    // (the slide's now: not to be evicted before it's written)
    if (done && S.frozen.get(key) === done) S.frozen.delete(key);
    if (job) S.taken.add(job);
    tr.regions.push({ how: done ? (done.how === 'made' ? 'ahead' : done.how) : job ? 'ahead' : 'made', ready: 0, written: 0 });
    const p = done ? Promise.resolve(done) : (job ?? bring(S, key, wx, wy));
    return p.then((f) => {
      if (f.how === 'thawed') S.stats.thawed++;
      else if (f.how === 'made') {
        S.stats.generated++;
        if (done || job) S.stats.prefetched++;
      }
      return { key, f };
    });
  });
  S.unwritten = entering.slice();
  let tw = performance.now();
  try {
  for (let k = 0; k < entering.length; k++) {
    const [lx, ly] = entering[k];
    if (!STREAM_OLD && k > 0 && performance.now() - tw > WRITE_MS) {
      await new Promise((r) => requestAnimationFrame(r));
      tw = performance.now();
    }
    const c = await coming[k];
    let f = c.f;
    if (f.oz !== S.oz) f = await prepare(S, f);
    if (S.frozen.get(c.key)?.slot === f.slot) S.frozen.delete(c.key);
    tr.regions[k].ready = performance.now();
    // (round 106: what left from where this lies, copied out first)
    if (fz) freezeAt(S, fz, lx, ly);
    write(S, f, lx, ly, c.key);
    tr.regions[k].written = performance.now();
    S.unwritten = S.unwritten.filter(([x, y]) => x !== lx || y !== ly);
    if (!STREAM_OLD && ARRIVE_URGENT) S.core.renderer.fieldMesh.urgent(lx, ly * ROW_H, lx + R, (ly + R) * ROW_H, 8);
  }
  } finally {
    // (round 106: the regions that left all frozen — any not written over yet too — and their readback asked)
    if (fz) frozeInto(S, fz);
  }
  // (round 106: whatever of the strip that left isn't read yet — nothing came in where it lay)
  flushFills(S);
  // (round 80: the band's pages went with the land; only what came in is packed)
  timed('band', () => S.core.renderer.band?.packFresh(S.outside, S.core.dims.zMax));
  S.core.windowEpoch++;
}
