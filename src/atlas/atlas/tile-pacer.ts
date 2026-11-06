// TilePacer: how many streamed tiles of land a frame may make (round 98, adaptive since round 102). API: TilePacer
// (re-exported by atlas.ts).
import { TILES_FIXED, TILE_MAX, CHAIN, TILE_MAX_FILL, FILL_AT, MOBILE, TILE_MAX_FAST, PACE_FRAME, FAST_AT } from './defs';

/**
 * (round 98) The streamed batches' tiles a frame (atlas.ts tileGate): as many as the frame has room for, not one.
 * Each batch has one tile waiting at a time (its next waits for the last's submit), so the count is over the batches
 * asked for together (a strip's five, the next's).
 *
 * (Round 102, `gpugen`; the user, round 101: "If we had adaptive tile generation …".) By a measured GPU budget a frame: the frame's period
 * (the low envelope of its intervals) less the GPU's own time for the frame, a share of that room given to tiles at
 * the measured GPU ms a tile — a third of it parked, up to 80% as the camera moves fast (`urgency`: its speed, cells a
 * second), and TILE_MAX_FAST tiles then rather than TILE_MAX. The GPU's time: the profiler's timestamps where it has
 * them and they're being read (the frame's GPU ms, colFinish's ms a tile); else — a phone: Mali's per-pass timestamps
 * aren't to be trusted, and the profiler only reads while someone looks — onSubmittedWorkDone once the frame's work
 * is submitted: how long the GPU takes after that, in frames without tiles (the frame's own) and with them (each tile's
 * share of the difference). Round 98's guard stays over it: a frame that ran tiles and came out longer
 * than the envelope by a fifth (and 1.5 ms) halves what may run, else it goes back up by a quarter. At least one a
 * frame, so the land always comes. ?tilepace=frame: the guard alone (round 98).
 */
export class TilePacer {
  private waiting: (() => void)[] = [];
  /** (round 105, tilelatency) the render-only tiles' turns: served in turn with the streamer's, never behind its queue.
   *  (round 112, tilefast) Kept in the asker's order (lowest first; equal: as asked), so the most urgent region's land
   *  goes on to its end rather than six regions' a turn each, all finishing late together. */
  private first: { r: () => void; order: number }[] = [];
  /** (round 112, tilefast) turns this frame has left once its queues ran dry: a tile's next turn asked for in this
   *  frame's task (its chain's next tile, a microtask after the last's submit) runs at once instead of a frame later —
   *  a 68² bordered region's 8 turns on a phone were 8 frames, ~130 ms, whatever the GPU cost of each */
  private credit = 0;
  private creditClear = false;
  /** (round 112) turns run on a frame's credit (the sweeps') */
  chained = 0;
  private armed = false;
  private last = 0;
  private ran = 0;
  /** ms: the frames' time without tiles (their low envelope) */
  base = 16.7;
  /** tiles a frame now (round 102: what the budget and the guard allow) */
  perFrame = 1;
  /** (round 102) what the frame-time guard allows (round 98's perFrame) */
  guard = 1;
  /** (round 101, the benchmark: src/perf/bench.ts) tiles a frame held at this many while it measures; 0: paced */
  fixed = 0;
  /** (for the sweeps) tiles run, frames that ran some */
  tiles = 0;
  frames = 0;
  /** (round 102) the device (onSubmittedWorkDone), the profiler (timestamps), the camera's speed (cells a second) */
  device?: GPUDevice;
  profiler?: import('../../gpu/profiler').Profiler;
  urgency: () => number = () => 0;
  /** (round 113, the planner's — scenes/planner.ts) the view has undrawn land: the tiles get the frame's whole room */
  holes: () => boolean = () => false;
  /** (round 102) GPU ms a tile (measured), the frame's GPU ms without tiles, the budget now (ms), how it's measured */
  tileMs = 0.3;
  gpuMs = 8;
  budgetMs = 0;
  how: 'timestamps' | 'workdone' | 'frame' = 'workdone';
  /** (round 102) the GPU's tail after the frame's submit (onSubmittedWorkDone, ms), frames without tiles */
  private doneIdle = 0;
  private probing = false;

  /** A turn: the streamer's lane, or (`prio`) the tiles' lane in `order` (lower first). */
  next(prio = false, order = 0): Promise<void> {
    if (prio && this.credit > 0) {
      this.credit--;
      this.ran++;
      this.tiles++;
      this.chained++;
      return Promise.resolve();
    }
    return new Promise((r) => {
      if (prio) {
        // (after the last of its order or lower: a later region's turns wait behind an earlier one's)
        let i = this.first.length;
        while (i > 0 && this.first[i - 1].order > order) i--;
        this.first.splice(i, 0, { r, order });
      } else this.waiting.push(r);
      this.arm();
    });
  }

  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    requestAnimationFrame((t) => this.frame(t));
  }

  /** (round 102) how long after the frame's work (and its tiles) is submitted the GPU is done with it */
  private probe(t: number, ran: number): void {
    const dev = this.device;
    if (!dev || this.probing) return;
    this.probing = true;
    setTimeout(() => {
      // (from here — the frame's work, and its tiles, submitted — to the GPU done with it: the GPU's tail of the frame)
      const tS = performance.now();
      void dev.queue.onSubmittedWorkDone().then(() => {
        this.probing = false;
        const done = performance.now() - tS;
        // (a long stall isn't the frame's: ignored)
        if (done > this.base * 4 || tS - t > this.base * 2) return;
        if (!ran) {
          this.doneIdle = this.doneIdle ? this.doneIdle + (done - this.doneIdle) * 0.2 : done;
          return;
        }
        if (this.doneIdle) {
          const per = Math.max(0.05, Math.min(5, (done - this.doneIdle) / ran));
          this.tileMs += (per - this.tileMs) * 0.15;
        }
      });
    }, 0);
  }

  private frame(t: number): void {
    this.armed = false;
    // (after an idle spell the gap isn't a frame: measured from the next)
    const dt = this.last && t - this.last < 100 ? t - this.last : this.base;
    this.last = t;
    // (the low envelope: down quickly, up slowly — a frame without tiles is the frame's own time)
    if (dt < this.base) this.base += (dt - this.base) * 0.3;
    else this.base += (Math.min(dt, this.base * 2) - this.base) * (this.ran ? 0.002 : 0.02);
    const speed = this.urgency();
    const fast = Math.max(0, Math.min(1, speed / FAST_AT));
    // (round 112, `tilefix2`: off a phone, the tiles' lane backed up — a wide zoom's screenful wanted — the guard may
    // climb to TILE_MAX_FILL, a turn a frame more each frame that came out on time: the turns a frame the GPU has room
    // for, found by the frame's time as ever (halved by a long one). A 3080 at 30 fps filled a 1600 x 900 screen at zoom
    // 1.3 a quarter short in 8 s at four turns a frame. A phone keeps TILE_MAX: its vsync makes an overshoot a dropped
    // frame, and its screen wants a quarter of the tiles)
    const fill = !MOBILE && this.first.length >= FILL_AT;
    const most = fill ? TILE_MAX_FILL : fast > 0.5 ? TILE_MAX_FAST : TILE_MAX;
    if (this.ran) this.guard = dt > this.base * 1.2 + 1.5 ? Math.max(1, this.guard * 0.5) : Math.min(most, this.guard + (fill ? 1 : 0.25));
    let n: number;
    if (PACE_FRAME) {
      this.how = 'frame';
      n = Math.floor(this.guard);
    } else {
      const P = this.profiler;
      if (P?.enabled && P.active && P.gpuFrameMs > 0) {
        this.how = 'timestamps';
        this.gpuMs = P.gpuFrameMs;
        const tm = P.passMs.get('atlas-colFinish');
        if (tm) this.tileMs = tm;
      } else {
        this.how = 'workdone';
        if (this.doneIdle) this.gpuMs = this.doneIdle;
      }
      const room = this.base - this.gpuMs - Math.max(1.5, this.base * 0.1);
      // (round 113: holes first — while the view has undrawn land, all of the room)
      this.budgetMs = Math.max(0, room) * (this.holes() ? 1 : 0.33 + 0.47 * fast);
      n = Math.max(1, Math.min(most, Math.floor(this.guard), Math.floor(this.budgetMs / Math.max(this.tileMs, 0.05))));
    }
    this.perFrame = n;
    n = this.fixed || TILES_FIXED || n;
    // (round 105: the two lanes in turn — the tiles' first, then the streamer's — so neither waits on the other: the
    // window's own land isn't starved by the tiles ahead, the tiles not queued behind the streamer's strips)
    // (round 112, tilefast: the tiles' lane's share — half the turns while the streamer has some waiting, else all — is
    // kept whole for it: what its queue doesn't take now, its chain does as it asks again in this task, the urgent
    // region's next tiles in this frame; the streamer's the rest, and what neither takes is the chain's too)
    // (round 113: holes first — while the view has undrawn land the tiles' lane takes every turn it has asks for)
    const share = !CHAIN || this.fixed || TILES_FIXED || !this.first.length ? 0 : this.waiting.length && !this.holes() ? Math.ceil(n / 2) : n;
    const go: (() => void)[] = [];
    let tileGo = 0;
    if (share) {
      for (; tileGo < share && this.first.length; tileGo++) go.push(this.first.shift()!.r);
      while (go.length < n - share + tileGo && this.waiting.length) go.push(this.waiting.shift()!);
    } else
      while (go.length < n && (this.first.length || this.waiting.length)) {
        if (this.first.length) go.push(this.first.shift()!.r);
        if (go.length < n && this.waiting.length) go.push(this.waiting.shift()!);
      }
    this.ran = go.length;
    if (go.length) {
      this.tiles += go.length;
      this.frames++;
    }
    // (what's left of the frame's turns, for a tile's chain asking again in this task — gone after it)
    this.credit = CHAIN && !this.fixed && !TILES_FIXED ? n - go.length : 0;
    if (this.credit && !this.creditClear) {
      this.creditClear = true;
      setTimeout(() => {
        this.credit = 0;
        this.creditClear = false;
      }, 0);
    }
    for (const r of go) r();
    if (this.how === 'workdone') this.probe(t, go.length);
    // (a frame on, the next batch's tiles — and this frame's time, after tiles or not)
    if (this.waiting.length || this.first.length || this.ran) this.arm();
  }
}
