// The regions' jobs and the pool: a slot for each region made ahead or thawed, evicting what's not needed, and the
// pipeline that brings a region (store, made, generated), prepares it and pumps the uploads. API: slotFor, evict,
// slotHeld, ready, startJob, bring, prepare, pump.
import { poolVictim } from '../pool-victim';
import { timed } from '../../gpu/cpustat';
import { type PoolSlot } from '../region-pool';
import { cpu } from './freeze';
import { load } from './store';
import { generate, reslice, since } from './generate';
import { reliefOf } from './write';
import { UPLOAD_MS, UPLOAD_BYTES, UPLOAD_SLICE, SESSION, Frozen } from './defs';
import type { Streamer } from '../streamer';

/** (round 100) A pool slot: a free one, or the least recently used region's (evicted: on disk if it changed). */
export function slotFor(S: Streamer): PoolSlot | null {
  for (;;) {
    const s = S.pool.alloc();
    if (s) return s;
    // (round 104: the least recently used of those more than a region and a half outside where the window is
    // heading — the window's middle a second of the camera's motion on — else the farthest; never what a job is
    // working on. Round 102 evicted what was left behind before what was made ahead: a pan back and forth lost the
    // regions it was coming back to, loaded from disk or made again — BN28)
    const R = S.R;
    const lead = (v: number) => Math.max(-2 * R, Math.min(2 * R, v));
    const cx = (S.origin[0] + S.W / 2 + lead(S.vel[0])) / R - 0.5;
    const cy = (S.origin[1] + S.H / 2 + lead(S.vel[1])) / R - 0.5;
    const wrap = S.source.wrap;
    // (merge122: the choice is pool-victim.ts's, tested on its own; a travel's pinned window is kept like a job's)
    const victim = poolVictim(S.frozen.keys(), {
      keep: (k) => S.jobs.has(k) || S.pinned.has(k),
      centre: [cx, cy],
      near: [S.W / R / 2 + 1.5, S.H / R / 2 + 1.5],
      wrap: wrap ? [wrap[0] / R, wrap[1] / R] : undefined,
    });
    if (victim === null) return null;
    evict(S, victim);
  }
}

/** (round 100) A region out of the pool: its slot freed. If it changed it was (or is being) saved by its check. */
export function evict(S: Streamer, key: string): void {
  const f = S.frozen.get(key);
  if (!f) return;
  S.frozen.delete(key);
  S.made.delete(key);
  if (f.slot) S.pool.release(f.slot);
  if (f.snap !== undefined) S.snaps.set(key, f.snap);
  S.stats.evicted++;
}

/** (round 100) whether a slot is a region's in the pool still */
export function slotHeld(S: Streamer, s: PoolSlot): boolean {
  for (const f of S.frozen.values()) if (f.slot === s) return true;
  return false;
}

/** (round 100) a region's land is ready: in the pool (the most recently used), ready to be copied into the window */
export function ready(S: Streamer, key: string, f: Frozen): void {
  if (f.slot) {
    S.frozen.delete(key);
    S.frozen.set(key, f);
  }
  S.made.set(key, f);
}

/** (round 100) a job for a region's land under way: ready when done (unless dropped meanwhile — a warp) */
export function startJob(S: Streamer, key: string, job: Promise<Frozen>): void {
  S.jobs.set(key, job);
  const t0 = performance.now();
  job.then(
    (f) => {
      // (round 113: asked to made, for the planner's land reach)
      S.landMs.push(performance.now() - t0);
      if (S.landMs.length > 24) S.landMs.shift();
      if (S.taken.has(job)) return;
      if (S.jobs.get(key) === job) {
        S.jobs.delete(key);
        ready(S, key, f);
      } else if (f.slot && S.frozen.get(key) !== f && !slotHeld(S, f.slot)) S.pool.release(f.slot);
    },
    (e) => {
      if (S.jobs.get(key) === job) S.jobs.delete(key);
      console.error(`[stream] region ${key}'s land failed: ${(e as Error)?.message ?? e}`);
    },
  );
}

/**
 * (round 100) A region's land, wherever it is: the pool's (as left, or made ahead), the store's (as saved), or
 * made by the source — checked for what changed while it was away, cut at the window's oz, its relief made, and
 * in the pool (uploaded) when it wasn't.
 */
export async function bring(S: Streamer, key: string, wx: number, wy: number, fresh = false): Promise<Frozen> {
  // (a region leaving is saved, if it changed, before it's looked for in the store)
  await S.checks.get(key);
  let f = fresh ? undefined : S.frozen.get(key);
  f?.fill?.();
  // (its slot this job's now: nothing evicts it meanwhile; ready() puts it back)
  if (f) S.frozen.delete(key);
  if (!f && S.store?.has(key) && !(fresh && S.store.has(key)!.session === SESSION)) f = (await load(S, key)) ?? undefined;
  // (round 112, tilefix2: the pan bench's disk rows came mostly generated — 6 of 248 from disk — so why: no record)
  if (!f && S.store && !S.store.has(key)) S.stats.storeMiss++;
  if (!f) f = await generate(S, wx, wy);
  f = await since(S, f, wx, wy);
  // (round 128j: the static grids over it known — their claims are written with it)
  const ready = S.readyFor.map((h) => h(wx, wy, S.R)).filter((p) => p);
  if (ready.length) await Promise.all(ready);
  return prepare(S, f);
}

/** (round 100) cut at the window's oz, its relief made, uploaded into a pool slot (a CPU form is let go then) */
export async function prepare(S: Streamer, f: Frozen): Promise<Frozen> {
  if (f.oz !== S.oz) f = reslice(S, await cpu(S, f));
  if (!f.relief) {
    const c = await cpu(S, f);
    f = { ...c, relief: timed('relief', () => reliefOf(S, c)) };
  }
  if (!f.layers && !f.body) return f;
  const slot = f.slot ?? slotFor(S);
  // (no room in the pool, every slot's region wanted: written from the CPU, as before round 100)
  if (!slot) return f;
  await new Promise<void>((res) => S.uploads.push({ f, slot, res }));
  return { ...f, slot, layers: undefined, bufs: undefined, texs: undefined, body: undefined };
}

/** (round 100) uploads of land into the pool, a few ms of the frame (one at least) */
export function pump(S: Streamer): void {
  const t0 = performance.now();
  let bytes = 0;
  // (round 112, tilefast: UPLOAD_BYTES a frame in all, a region's bytes split across frames when it's over that — the
  // phone's frames with a whole region's writeBuffer in them were held for the GPU: the pan bench's disk hitch)
  while (S.uploads.length && bytes < UPLOAD_BYTES && (bytes === 0 || performance.now() - t0 < UPLOAD_MS)) {
    const u = S.uploads[0];
    // (round 104: a loaded region's bytes as they came — the layout's already)
    const body = (u.body ??= u.f.body ?? S.toBody(u.f));
    const at = u.at ?? 0;
    const n = Math.min(body.byteLength - at, Math.max(UPLOAD_SLICE, UPLOAD_BYTES - bytes - ((UPLOAD_BYTES - bytes) % 4)));
    timed('pool.upload', () => S.core.host.gpu.device.queue.writeBuffer(u.slot.buf, u.slot.off + at, body, at, n));
    bytes += n;
    u.at = at + n;
    if (u.at < body.byteLength) break;
    S.uploads.shift();
    S.stats.uploads++;
    u.res();
  }
}
