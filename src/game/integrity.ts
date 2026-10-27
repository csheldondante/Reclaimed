// Structural integrity and falling pieces (round 14, BACKLOG F7; round 17
// K1: bodies sleep where they lie, projected into the terrain grid, within a
// budget) — the sandbox's physics playground. Places where structures changed (a smash, a
// placed model, a cyclone passing, a body landing) are marked dirty; a few
// times a second the layers are read back, the dirty boxes analysed
// (fracture.ts), what breaks free is cut out of the world and becomes a
// rigid body (bodies.ts), crumbled cross-sections burst into chips, and a
// body that comes to rest is written back as voxels.
// The world is edited column by column on the CPU and written back (like the
// place tool); the GPU structure rule only collapses damage here (its
// span-support rule would turn overhangs to rubble before this sees them).

import { packColumn, readColumn, columnSlots, SLOT_WORDS, type Interval } from '../world/layout';
import { MAT, MATERIALS, MatState } from '../world/materials';
import { analyse, analyseRock, floatingRuns, WorldVox, type Fracture, type Voxel } from './fracture';
import { Bodies, type Body } from './bodies';
import type { WorldCore } from '../scenes/world-core';
import { ignoreTeardown } from '../gpu/pipeline';
import { cellAt, cellPos, nbr, DIRV, ROW_H } from '../world/lattice';
import { EventKind } from '../sim/globals';
import { CUTS, OP, editOpOf } from '../sim/edit-ops';
import { ColumnBodies, subtract, type ColPiece, type FallingBody, type Landing } from './colbodies';
import { RockBodies, RB, ROCKBODY, type RockBody, type RockGround, type V3 } from './rockbodies';
import { BUILD_FRAMES, type RockDraw, type RockMesh } from '../render/rockmesh';

const PASS = 0.35; // s between analyses while anything is dirty or moving

/**
 * (round 86) A falling piece's columns written (and its chunks meshed again) every Nth frame: 2 on the phone's
 * tier (no `q` or q=low), 1 otherwise; `?fallevery=N`. A 46-column piece's chunks rebuilt every frame cost the
 * desktop's iGPU ~1.4 ms a frame of mesh passes; at 4 cells/s, every other frame is a step of 0.13 cells.
 */
const FALL_EVERY = (() => {
  if (typeof location === 'undefined') return 1;
  const q = new URLSearchParams(location.search);
  const n = q.get('fallevery');
  if (n) return Math.max(1, Number(n));
  return (q.get('q') ?? 'low') === 'low' ? 2 : 1;
})();

/**
 * (perfopt, round 83 audit: ?intread=near) A pass reads back only the layers' chunks it looks at — round the dirty
 * boxes (4 cells), the cut columns (24: the rock hanging from them), the bodies (4) — into a CPU copy of all of
 * them, not all 16 MB of the atlas's window every 0.35 s while anything is dirty (riding: every region come in) or
 * every 1 s while bodies exist. After a slide (the window's epoch) the next read is whole again.
 * (round 86: the default — `?intread=all` reads it all, as before)
 */
const READ_NEAR = typeof location === 'undefined' || new URLSearchParams(location.search).get('intread') !== 'all';

// Impacts (round 21: "crumble much more easily, break up more; impacts make
// dust"): a body that hits something at IMPACT_BREAK cells/s or more
// shatters into about weakness · speed² · voxels / SHATTER pieces (the small
// ones near the point hit), then loses the voxels within a radius growing
// with the speed around that point (to loose ground, with dust and chips);
// pieces of up to IMPACT_CRUMB voxels crumble too. Metal breaks far less than
// stone. Softer hits only puff dust.
const IMPACT_BREAK = 1.2; // cells/s
const SHATTER = 700;
const IMPACT_CRUMB = 16; // voxels
const impactRadius = (speed: number) => Math.min(2.5, 0.5 + 0.3 * speed);
const impactReach = (m: number) => (m === MAT.Steel || m === MAT.Rust ? 0.4 : m === MAT.Wood ? 0.7 : 1);

export class Integrity {
  readonly bodies: Bodies;
  /** (round 86) what broke free, falling in the columns' own format (colbodies.ts): drawn as the ground is */
  readonly falling: ColumnBodies;
  /**
   * (round 95, `?rockbody=1`) the rock the judge frees (or that tips) as rigid bodies instead (rockbodies.ts): drawn
   * as their cells turned with them, written back into the columns where they come to rest
   */
  readonly rigid: RockBodies | null = null;
  /** sparks where rock hits rock hard (round 86: "a big cloud of dust … and maybe sparks") */
  onSparks?: (x: number, y: number, z: number, count: number, speed: number) => void;
  /** (round 95) the body voxels drawn this frame (the cube bodies' and the rigid rock's) */
  private packF = new Float32Array(0);
  /** (round 95) the rigid rock's mesh (the renderer's: none without the field mesh — then its cubes are drawn) */
  private rockMesh?: RockMesh;
  /** (round 95) a broken body's mesh drawn split between its pieces till theirs are built; a settled one's a few frames on */
  private ghosts: { slot: number; frames: number; seeds: { s: V3; piece: RockBody | null }[]; hit: V3; rad: number }[] = [];
  private afterglow: { slot: number; m: number[]; frames: number }[] = [];
  /**
   * (round 86) a cut was sent this tick or since: the next pass starts at once (not on the 0.35 s timer), its
   * readback submitted after the tick that made the cut — so one look is enough
   */
  private urgent = false;
  private fallFrame = 0;
  /** (round 86) columns written while a readback was in flight: put back into the copy it brings (it predates them) */
  private inflight: Map<number, Interval[]> | null = null;
  /**
   * (round 87) What lies above the window (Streamer.outside, drawn by the band): `take` a column's runs touching
   * the window's top out of it (window z); `put` them back (window z) where a piece that took them lands.
   */
  above?: { take(x: number, y: number): Interval[]; put(x: number, y: number, ivs: Interval[]): void };
  /**
   * (round 92) the window's columns are being read back and written again (a slide in z, a warp:
   * Streamer.columnsHeld): nothing falls and nothing is judged meanwhile (`settle` landed what was falling first)
   */
  held?: () => boolean;
  /** chunks round what was touched: hybrid voxels from now on (the level: HybridChunks.edit); x0, y0, x1, y1 world */
  onTouched?: (x0: number, y0: number, x1: number, y1: number) => void;
  /** (round 86) when the last pass was asked for and done (performance.now, ms): the latency probe reads them */
  timing = { askedAt: 0, readAt: 0, doneAt: 0, spawnedAt: 0 };
  private world: WorldVox;
  /** boxes to analyse: x0, y0, x1, y1, passes left (edits reach the GPU a
   *  tick after they are queued, so each box is looked at twice) */
  private dirty: [number, number, number, number, number][] = [];
  /** (round 83) the columns an edit cut ("y,x" keys) and the passes each is looked at still: where rock is judged */
  private rockSeeds = new Map<number, number>();
  /**
   * (round 92) of those, the columns the edit itself changed (passes left, as rockSeeds): a held piece is weighed
   * (fracture.ts ROCK) only if it, or what holds it, has a run in one — what floats is judged wherever it is
   */
  private cutSeeds = new Map<number, number>();
  private t = 0;
  private busy = false;
  /** chips where something crumbles or a body hits hard */
  onChips?: (x: number, y: number, z: number, count: number, speed?: number) => void;
  /** something came down here: the low crash (voxels broken or landing) */
  onCollapse?: (x: number, y: number, z: number, amount: number) => void;
  /** dust where something breaks or a body hits (grains, spread in cells, the material it's made of) */
  onDust?: (x: number, y: number, z: number, count: number, spread: number, mat: number) => void;
  /** stats for the perf overlay / tests */
  stats = { passes: 0, bodies: 0, crumbled: 0, settled: 0, crumbledBodies: 0, impacts: 0, shatters: 0, shattered: 0, lastMs: 0, rockSeeds: 0, rereads: 0, settledFalls: 0, settleMs: 0 };
  /** sleeping bodies projected per column: top, bottom (top < 0: none) — the
   *  GPU's bodyProj texture and the bodies' own collision share it */
  readonly proj: Float32Array;
  /** budget for sleeping bodies (DECISIONS round 17) */
  static readonly MAX_SLEEPING = 64;
  static readonly MAX_SLEEP_VOXELS = 16384;

  constructor(private core: WorldCore) {
    this.world = new WorldVox(core.packed, new Uint32Array(0));
    this.bodies = new Bodies(this.world);
    const N = core.dims.w * core.dims.h;
    this.proj = new Float32Array(N * 4);
    this.resetProjection();
    this.bodies.proj = this.proj;
    this.bodies.onSleep = () => {
      this.stats.settled++;
      this.keepBudget();
      this.project();
    };
    this.bodies.onWake = () => this.project();
    this.bodies.onImpact = (b, speed, at) => this.impact(b, speed, at);
    if (ROCKBODY) {
      (this as { rigid: RockBodies | null }).rigid = new RockBodies(this.rockGround());
      this.rockMesh = core.renderer.enableRockMesh();
    }
    this.falling = new ColumnBodies(
      (x, y) => readColumn(this.core.packed, this.world.slots, x, y),
      (x, y, col) => this.writeColumn(x, y, col, true, false),
      (x, y, col) => this.writeColumn(x, y, col, false, true),
      core.dims.zMax,
      (x, y, ivs) => this.above?.put(x, y, ivs),
    );
    // (round 83, the user: "the meteors and sandbox tools don't wake up the rocks") every edit that takes
    // ground away — a dig, a smash, a crater (a meteor's), a take — whoever queued it (the world API, the
    // sandbox's tools, the level's meteors): what it cut is judged, the rock by its columns
    core.sim.eventTaps.push((sent) => {
      for (const e of sent) {
        if (e.kind !== EventKind.Edit) continue;
        if (CUTS.has(editOpOf(e.z ?? 0))) {
          // (round 92: a crater's event radius is its ejecta's, CRATER_RING × its bowl's: the bowl and its rim are what it cut)
          const op = editOpOf(e.z ?? 0);
          this.markDirty(e.x, e.y, e.radius + 14, Math.max(0.5, e.radius), op === OP.CRATER ? e.radius / 2.5 + 1.5 : undefined);
          // (round 86: judged now — this tick's submit carries the cut, and the pass's readback goes after it)
          this.urgent = true;
          if (!this.timing.askedAt || this.timing.doneAt >= this.timing.askedAt) this.timing.askedAt = performance.now();
        }
      }
    });
  }

  /**
   * Structures around (x, y) within r may have changed; `cut` (round 83): an edit cut the ground within that
   * radius — the rock by those columns is judged too (land come in, a cyclone passing: structures only, the
   * ground as it was made stands).
   */
  markDirty(x: number, y: number, r: number, cut?: number, weighR?: number): void {
    this.markBox(x - r, y - r, x + r, y + r);
    if (cut !== undefined) this.markCut(x, y, cut, weighR);
  }
  /**
   * (round 87) Ground went at (x, y) within r by something that isn't an edit event — the heat beam's bore, lava
   * melting it: judged as a cut is, at once.
   */
  cutAt(x: number, y: number, r: number): void {
    this.markDirty(x, y, r + 14, Math.max(0.5, r));
    this.urgent = true;
    // (round 88: the bore's melt drains on after the beam moves on)
    this.watch(x, y, r + 1, 6);
  }

  /**
   * (round 88) These columns (window cells, y · 65536 + x) were changed by something that isn't an edit event — a
   * great meteor's window edit: what hangs by them is judged, at once.
   */
  cutCols(keys: Iterable<number>): void {
    for (const k of keys) {
      this.rockSeeds.set(k, 2);
      this.cutSeeds.set(k, 2);
    }
    this.urgent = true;
  }

  /**
   * (round 88, the tests' ground truth) The window's layers read back whole now: every run holding something solid
   * with no way to the ground (fracture.ts floatingRuns), and how many runs there are.
   */
  async scan(): Promise<{ runs: number; floating: { x: number; y: number; z0: number; z1: number; mat: number }[]; ms: number }> {
    const f = await this.core.readBuffer('layers');
    const t0 = performance.now();
    const r = floatingRuns(new WorldVox(this.core.packed, new Uint32Array(f.buffer, f.byteOffset, f.byteLength / 4)));
    return { ...r, ms: performance.now() - t0 };
  }

  /**
   * (round 92, the tests: the land as it's made must stand) What the rock's judge would do to the whole window as it
   * is now, every column a seed, nothing done: the pieces that would fall and the runs that would crumble, the cells
   * of each, and how long it took.
   */
  async judgeAll(weigh = true): Promise<{ pieces: number; fell: number; crumbled: number; ms: number; at: [number, number, number][]; why?: Fracture['why'] }> {
    const f = await this.core.readBuffer('layers');
    const w = new WorldVox(this.core.packed, new Uint32Array(f.buffer, f.byteOffset, f.byteLength / 4));
    const seeds: [number, number][] = [];
    for (let y = 0; y < this.core.dims.h; y++) for (let x = 0; x < this.core.dims.w; x++) seeds.push([x, y]);
    const t0 = performance.now();
    const r = analyseRock(w, seeds, undefined, { weigh });
    const ms = performance.now() - t0;
    let fell = 0;
    const at: [number, number, number][] = [];
    for (const p of r.pieces ?? []) {
      let v = 0;
      for (const c of p) for (const iv of c.ivs) v += iv.z1 - iv.z0;
      fell += v;
      at.push([p[0].x, p[0].y, Math.round(v)]);
    }
    let crumbled = 0;
    for (const c of r.crumbleRuns ?? []) for (const iv of c.ivs) crumbled += iv.z1 - iv.z0;
    return { pieces: r.pieces?.length ?? 0, fell, crumbled, ms, at: at.sort((a, b) => b[2] - a[2]).slice(0, 8), why: r.why };
  }

  /**
   * (round 88) The ground round (x, y) within r goes on changing for `secs` after an edit — a meteor's rim melting
   * and setting to basalt over its bowl (lava.wgsl), a beam's bore draining: judged as cut once a second until then
   * (the sweep's floating basalt crusts).
   */
  watch(x: number, y: number, r: number, secs: number): void {
    const w = this.watches.find((w) => Math.hypot(w.x - x, w.y - y) < w.r / 2 && r <= w.r * 1.5);
    if (w) w.left = Math.max(w.left, secs);
    else this.watches.push({ x, y, r, left: secs, next: 0 });
  }
  private watches: { x: number; y: number; r: number; left: number; next: number }[] = [];

  /**
   * (round 83) the columns within r of (x, y) were cut: the rock by them is judged, two passes. (Round 92) those
   * within weighR (default r; 0: none — a rim melting as it sets) were what the edit changed: what they hold is weighed
   */
  markCut(x: number, y: number, r: number, weighR = r): void {
    const [c0x, c0y] = cellAt(x - r - 1, y - r - 1);
    const [c1x, c1y] = cellAt(x + r + 1, y + r + 1);
    for (let cy = Math.max(0, c0y); cy <= Math.min(this.core.dims.h - 1, c1y); cy++)
      for (let cx = Math.max(0, c0x); cx <= Math.min(this.core.dims.w - 1, c1x); cx++) {
        const [px, py] = cellPos(cx, cy);
        const d = Math.hypot(px - x, py - y);
        if (d <= r + 0.75) this.rockSeeds.set(cy * 65536 + cx, 2);
        if (weighR > 0 && d <= weighR + 0.75) this.cutSeeds.set(cy * 65536 + cx, 2);
      }
  }
  markBox(x0: number, y0: number, x1: number, y1: number): void {
    this.dirty.push([x0, y0, x1, y1, 2]);
  }

  /** The visible top of a column: solid ground plus loose ground, or a fallen body's top. */
  topAt(x: number, y: number): number {
    const i = y * this.core.dims.w + x;
    // (the layers hold the loose ground too)
    const ground = this.world.slots.length ? this.world.colTop(x, y) : 0;
    return Math.max(ground, this.proj[i * 4]);
  }

  /**
   * (round 92) Before the window slides (Streamer.onBeforeSlide): every piece falling lands now, where it would have
   * — the GPU's columns hold it mid-air at its offset, and a slide freezes them as they are (a region leaving), reads
   * them back to cut them again in z, or moves the land from under the piece while it goes on writing its old
   * columns: rock left hanging in the air with nothing under it (the user's meteor-made floaters, round 92).
   */
  settle(dx = 0, dy = 0, dz = 0): void {
    // (a slide along x or y: only what's in the strip leaving — the rest moves with the land, slid)
    const { w: W, h: H } = this.core.dims;
    const leaving = (b: FallingBody) => {
      if (dz || (!dx && !dy)) return true;
      const [x0, y0, x1, y1] = b.box;
      return dx > 0 ? x0 < dx : dx < 0 ? x1 >= W + dx : dy > 0 ? y0 < dy : y1 >= H + dy;
    };
    const t0 = performance.now();
    let n = 0;
    // (round 95) the rigid rock in the strip leaving (all of it, for a slide in z or a warp) comes to rest first,
    // written into the columns as they are before the slide
    if (this.rigid) {
      const wl = (b: RockBody) => {
        if (dz || (!dx && !dy)) return true;
        const [x0, y0, x1, y1] = this.rigid!.box(b);
        return dx > 0 ? x0 < dx + 1 : dx < 0 ? x1 >= W + dx - 1 : dy > 0 ? y0 / ROW_H < dy + 1 : y1 / ROW_H >= H + dy - 1;
      };
      for (const b of this.rigid.list.filter(wl)) {
        this.fastForward(b);
        n++;
      }
    }
    for (let k = 0; k < 2000; k++) {
      const go = this.falling.list.filter(leaving);
      if (!go.length) break;
      n += go.length;
      for (const l of this.falling.update(0.05, false, go)) this.land(l);
    }
    if (n) this.stats.settledFalls = (this.stats.settledFalls ?? 0) + 1;
    this.stats.settleMs = Math.max(this.stats.settleMs ?? 0, performance.now() - t0);
  }

  /**
   * (round 92) The window slid by (dx, dy) cells (whole regions, an even number of rows) or dz in z: what's waiting to
   * be judged moves with the land (round 88 kept window cells — the next pass judged where the land had been, and
   * a meteor's rim watched for 15 s was watched somewhere else). Seeds off the window go; the copy is read whole.
   */
  slid(dx: number, dy: number, dz: number): void {
    const { w: W, h: H } = this.core.dims;
    const move = (m: Map<number, number>) => {
      const out = new Map<number, number>();
      for (const [k, v] of m) {
        const x = (k % 65536) - dx;
        const y = Math.floor(k / 65536) - dy;
        if (x >= 0 && y >= 0 && x < W && y < H) out.set(y * 65536 + x, v);
      }
      return out;
    };
    this.rockSeeds = move(this.rockSeeds);
    this.cutSeeds = move(this.cutSeeds);
    const wx = dx;
    const wy = dy * ROW_H;
    for (const w of this.watches) {
      w.x -= wx;
      w.y -= wy;
    }
    this.dirty = this.dirty.map(([x0, y0, x1, y1, n]) => [x0 - wx, y0 - wy, x1 - wx, y1 - wy, n]);
    // (what's falling where the land left or was cut again landed before the slide; the rest moves with it. The
    // physics bodies are in window coordinates: they go, as before)
    if (dz) this.falling.clear();
    else this.falling.shift(dx, dy);
    // (round 95) the rigid rock moves with the land, still until the copy is read again (it's of the old window)
    if (this.rigid) {
      this.rigid.shift(wx, wy, dz);
      this.rigid.frozen = true;
    }
    this.bodies.list = [];
    this.pendingLoose.clear();
    this.needChunks.clear();
    this.readEpoch = -1;
    if (this.rockSeeds.size) this.urgent = true;
    this.project();
  }

  /**
   * Forget every falling piece (undo restores the world beneath them; a slide moved the columns). `reseed` (round
   * 86: the window's columns were all written again where it stands — a great meteor's): where they were is
   * looked at again — what was mid-air in the copy that went back is judged and falls on — and the copy read whole.
   */
  clear(reseed = false): void {
    const was = this.falling.clear();
    this.bodies.list = [];
    // (round 95: the rigid rock goes — undo puts the world back under it; a warp's window is elsewhere)
    if (this.rigid) {
      for (const b of this.rigid.list) if (b.slot !== undefined) this.rockMesh?.release(b.slot);
      for (const g of [...this.ghosts, ...this.afterglow]) this.rockMesh?.release(g.slot);
      this.ghosts = [];
      this.afterglow = [];
      this.rigid.list = [];
    }
    this.pendingLoose.clear();
    this.dirty = [];
    this.rockSeeds.clear();
    this.cutSeeds.clear();
    // (a great meteor's window edit keeps watching its rim)
    if (!reseed) this.watches = [];
    this.readEpoch = -1;
    if (reseed)
      for (const b of was)
        for (const c of b.cols) {
          this.rockSeeds.set(c.y * 65536 + c.x, 2);
          this.cutSeeds.set(c.y * 65536 + c.x, 2);
          this.urgent = true;
        }
    this.project();
  }

  private resetProjection(): void {
    for (let i = 0; i < this.proj.length; i += 4) {
      this.proj[i] = -1;
      this.proj[i + 1] = 0;
      this.proj[i + 2] = 0;
    }
  }

  /**
   * Rasterise every sleeping body into the terrain grid: per column, the top
   * and bottom of any body voxel over it (each voxel's rotated-cube box, so a
   * little generous at skewed edges). Written to the bodyProj texture.
   */
  private project(): void {
    this.resetProjection();
    const { w: W, h: H } = this.core.dims;
    const P = this.proj;
    for (const b of this.bodies.list) {
      if (!b.asleep) continue;
      this.bodies.voxelBounds(b, (lo, hi) => {
        // (the cells whose centres the voxel's box covers: the grid is hex)
        for (let y = Math.max(0, Math.floor((lo[1] + 0.15) / ROW_H - 0.5)); y <= Math.min(H - 1, Math.ceil((hi[1] - 0.15) / ROW_H - 0.5)); y++)
          for (let x = Math.max(0, Math.floor(lo[0] - 1)); x <= Math.min(W - 1, Math.ceil(hi[0])); x++) {
            const [cx, cy] = cellPos(x, y);
            if (cx < lo[0] + 0.15 || cx > hi[0] - 0.15 || cy < lo[1] + 0.15 || cy > hi[1] - 0.15) continue;
            const i = (y * W + x) * 4;
            if (P[i] < 0) {
              P[i] = hi[2];
              P[i + 1] = lo[2];
              P[i + 2] = b.id;
            } else {
              if (hi[2] > P[i]) P[i + 2] = b.id;
              P[i] = Math.max(P[i], hi[2]);
              P[i + 1] = Math.min(P[i + 1], lo[2]);
            }
          }
      });
    }
    const dev = this.core.host.gpu.device;
    dev.queue.writeTexture({ texture: this.core.world.bodyCpu }, P as Float32Array<ArrayBuffer>, { bytesPerRow: W * 16 }, [W, H]);
  }

  /**
   * Over budget (DECISIONS round 17: about 64 sleeping bodies, 16k voxels):
   * the oldest small sleeping bodies crumble into loose ground where they lie
   * (the oldest of all if none is small).
   */
  private keepBudget(): void {
    for (;;) {
      const sleeping = this.bodies.list.filter((b) => b.asleep);
      const voxels = sleeping.reduce((s, b) => s + b.local.length, 0);
      if (sleeping.length <= Integrity.MAX_SLEEPING && voxels <= Integrity.MAX_SLEEP_VOXELS) return;
      const byAge = sleeping.sort((a, b) => a.sleptAt - b.sleptAt);
      const victim = byAge.find((b) => b.local.length < 200) ?? byAge[0];
      this.crumble(victim);
    }
  }

  /**
   * A body turns into loose ground where it lies: each voxel's volume goes to
   * the column under it, as the loose material its own material breaks down
   * to (concrete, brick, stone, metal → gravel; wood, canvas → ash; bone →
   * dust). Through the deposit buffer (y, z), which the sediment pass folds into the layers.
   */
  crumble(b: Body): void {
    this.toLoose(this.bodies.worldVoxels(b));
    this.bodies.list = this.bodies.list.filter((x) => x !== b);
    this.stats.crumbledBodies++;
  }

  /**
   * Break bodies at a world point (the Break tool, round 18): voxels within
   * the radius go (chips), the rest splits into pieces that wake and fall;
   * crumbs become loose ground. True if a body was hit.
   */
  breakBodies(at: [number, number, number], radius: number): boolean {
    const { removed, crumbs } = this.bodies.breakAt(at, radius);
    if (!removed.length) return false;
    this.chips(removed.map((v) => v.p), 1);
    this.onDust?.(at[0], at[1], at[2], Math.min(50, 8 + removed.length * 2), radius, mainMat(removed));
    this.toLoose(crumbs);
    this.project();
    return true;
  }

  /** A body hit something at `speed` (cells/s) at world point `at`. */
  private impact(b: Body, speed: number, at: [number, number, number]): void {
    this.stats.impacts++;
    const mat = mainMat(b.local);
    this.onDust?.(at[0], at[1], at[2], Math.min(40, Math.round(4 + speed * 4)), 0.6 + speed * 0.2, mat);
    if (speed < IMPACT_BREAK) {
      this.onCollapse?.(at[0], at[1], at[2], b.local.length * speed * 0.05);
      return;
    }
    const weak = b.local.reduce((s, v) => s + impactReach(v.mat), 0) / b.local.length;
    const k = Math.min(8, Math.floor((weak * speed * speed * b.local.length) / SHATTER));
    const shards = this.bodies.shatter(b, at, k, IMPACT_CRUMB);
    const { removed, crumbs } = this.bodies.breakAt(at, impactRadius(speed), IMPACT_CRUMB, impactReach);
    crumbs.push(...shards);
    if (k >= 2) this.stats.shatters++;
    this.onCollapse?.(at[0], at[1], at[2], removed.length + crumbs.length + b.local.length * speed * 0.05);
    if (!removed.length && !crumbs.length) return;
    this.stats.shattered += removed.length + crumbs.length;
    this.onDust?.(at[0], at[1], at[2], Math.min(60, 10 + removed.length * 3), impactRadius(speed) + 0.5, mat);
    this.toLoose([...removed, ...crumbs]);
    this.project();
  }

  /** loose ground waiting to go to the GPU: column → amount and material votes */
  private pendingLoose = new Map<number, { amount: number; mats: Map<number, number> }>();
  private looseFlushedAt = -Infinity;

  /** Voxels (world centres) into loose ground at the columns under them. */
  private toLoose(vox: { p: [number, number, number]; mat: number }[], chipSpeed?: number): void {
    const { w: W, h: H } = this.core.dims;
    const add = this.pendingLoose;
    for (const v of vox) {
      const x = Math.floor(v.p[0]);
      const y = Math.floor(v.p[1]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      const m = looseFrom(v.mat);
      const e = add.get(i) ?? { amount: 0, mats: new Map() };
      e.amount += 1;
      e.mats.set(m, (e.mats.get(m) ?? 0) + 1);
      add.set(i, e);
    }
    this.chips(vox.map((v) => v.p), 1, chipSpeed);
    this.flushLoose();
  }

  /**
   * Chips at some points, `each` per point, as one burst per column (the
   * particle queue holds 64 bursts a tick; one per voxel crowded out the
   * dust clouds).
   */
  private chips(pts: [number, number, number][], each: number, speed?: number): void {
    const cols = new Map<string, { p: [number, number, number]; n: number }>();
    for (const p of pts) {
      const k = `${Math.floor(p[0])},${Math.floor(p[1])}`;
      const e = cols.get(k);
      if (e) {
        e.n += each;
        e.p[2] = Math.max(e.p[2], p[2]);
      } else cols.set(k, { p: [...p], n: each });
    }
    // (round 86: the points are column indices + 0.5 — the particles want the world's: the hex lattice's)
    for (const { p, n } of cols.values()) {
      const [wx, wy] = cellPos(Math.floor(p[0]), Math.floor(p[1]));
      this.onChips?.(wx, wy, p[2], Math.min(12, n), speed);
    }
  }

  /**
   * the deposit's y, z are overwritten, not added to, so a column is only written again
   * once the drift pass (period 2) has folded the last write in: at most one
   * flush per two sim ticks; in between, crumbs gather here.
   */
  private flushLoose(): void {
    const tick = this.core.globals.tick;
    if (!this.pendingLoose.size || tick - this.looseFlushedAt < 2) return;
    this.looseFlushedAt = tick;
    const dev = this.core.host.gpu.device;
    for (const [i, e] of this.pendingLoose) {
      let best: number = MAT.Rubble;
      let n = -1;
      for (const [m, c] of e.mats) if (c > n) [best, n] = [m, c];
      dev.queue.writeBuffer(this.core.world.deposit, i * 16 + 4, new Float32Array([e.amount, best]));
    }
    this.pendingLoose.clear();
  }

  update(dt: number): void {
    if (this.held?.()) return;
    if (this.world.slots.length && dt > 0) {
      this.bodies.update(dt);
    }
    this.flushLoose();
    const { data, count } = this.bodies.pack();
    if (this.rigid?.list.length) {
      // (round 95) the rigid rock: a step, its hits (dust, sparks, a break), what came to rest written back
      if (this.world.slots.length && dt > 0) this.stepRigid(dt);
      const max = 16384;
      if (this.packF.length < max * 8) this.packF = new Float32Array(max * 8);
      const f = this.packF;
      const u = new Uint32Array(f.buffer);
      f.set(new Float32Array(data.buffer, data.byteOffset, Math.min(count, max) * 8));
      // (the cubes of those without a mesh drawn; the rest only cast the shadow)
      const cubes = (b: RockBody) => !!RB.cubes || b.slot === undefined;
      const shown = this.rigid.packInto(f, u, Math.min(count, max), max, cubes);
      const n = this.rigid.packInto(f, u, shown, max, (b) => !cubes(b));
      this.core.renderer.setBodies(u, n, shown);
    } else this.core.renderer.setBodies(data, count);
    this.rockDraws();
    // (round 86) the pieces falling in the columns: a step, their chunks meshed at once, what came down
    if (this.world.slots.length && dt > 0 && this.falling.list.length) {
      for (const l of this.falling.update(dt, ++this.fallFrame % FALL_EVERY === 0)) this.land(l);
      for (const b of this.falling.list) this.touch(b, false);
    }
    this.t -= dt;
    for (const w of this.watches) {
      w.left -= dt;
      w.next -= dt;
      if (w.next <= 0) {
        w.next = 1;
        this.markCut(w.x, w.y, w.r, 0);
      }
    }
    if (this.watches.length) this.watches = this.watches.filter((w) => w.left > 0);
    // (round 86: a cut waits for its event to be sent — the world API marks it as it's queued — then goes at once)
    const cutQueued = this.urgent && this.core.globals.events.some((e) => e.kind === EventKind.Edit && CUTS.has(editOpOf(e.z ?? 0)));
    const due = (this.urgent && !cutQueued) || this.t <= 0;
    const rigidN = this.rigid?.list.length ?? 0;
    if (this.busy || !due || (!this.dirty.length && !this.rockSeeds.size && !this.bodies.list.length && !rigidN && this.world.slots.length)) return;
    // (with only sleeping bodies about, a slower pass still checks they're held up; the rigid rock's ground is read round it)
    this.t = this.dirty.length || this.rockSeeds.size || this.bodies.anyAwake || rigidN ? PASS : 1.0;
    this.urgent = false;
    this.busy = true;
    this.inflight = new Map();
    // the layers (structures, solid ground; the loose ground on them too)
    const read = READ_NEAR ? this.readNear() : this.core.readBuffer('layers').then((f) => ((this.readBytes += f.byteLength), (this.fresh = null), f));
    void read.then((f) => {
      this.busy = false;
      this.timing.readAt = performance.now();
      // (round 92: a slide began meanwhile — what was read is of the window before it; judged again after)
      if (this.held?.()) f = 'slid';
      // (round 88: the window slid while it was read — nothing judged on that, the seeds kept for the next look)
      if (f === 'slid') {
        this.inflight = null;
        this.urgent = true;
        return;
      }
      if (f) this.world.slots = new Uint32Array(f.buffer);
      // (what was written meanwhile, and the columns pieces fall through: as they are, not as the readback had them)
      for (const [k, col] of this.inflight ?? []) this.writeColumn(k % 65536, Math.floor(k / 65536), col, true, false);
      this.inflight = null;
      this.falling.restoreCpu();
      // (round 95) the copy is of the window as it is: the rigid rock moves again
      if (this.rigid && (!READ_NEAR || this.readEpoch === this.core.windowEpoch)) this.rigid.frozen = false;
      this.pass();
      this.timing.doneAt = performance.now();
    }, ignoreTeardown);
  }

  /** (round 86) a piece's columns changed: the chunks over them meshed the next frame (and voxels, in the hybrid), their sim awake */
  private touch(b: FallingBody, first: boolean): void {
    const [x0, y0] = cellPos(b.box[0], b.box[1]);
    const [x1, y1] = cellPos(b.box[2], b.box[3]);
    this.core.renderer.fieldMesh.urgent(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    if (first) this.onTouched?.(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    this.core.sleep?.wake((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2 + 8, 4, performance.now() / 1000);
  }

  /**
   * (round 86) A piece came down: hit hard (IMPACT_BREAK), the rim of its foot crumbles round where it struck
   * first — rubble, chips thrown, dust — a small one all of it; the rest is ground again where it lies, and its
   * columns are judged (what overhangs where it landed hangs).
   */
  private land(l: Landing): void {
    const b = l.body;
    const [hx, hy] = cellPos(l.at[0], l.at[1]);
    const hz = l.at[2];
    // (it didn't fall: it was resting on something — ground again, quietly)
    if (b.dz > -0.05) {
      this.falling.commit(b);
      return;
    }
    this.stats.impacts++;
    this.onDust?.(hx, hy, hz, Math.min(40, Math.round(4 + l.speed * 4)), 0.6 + l.speed * 0.2 + Math.sqrt(b.cols.length) * 0.3, b.mat);
    const removed: { p: [number, number, number]; mat: number }[] = [];
    if (l.speed >= IMPACT_BREAK) {
      const small = b.cells <= IMPACT_CRUMB;
      const R = small ? Infinity : impactRadius(l.speed) * impactReach(b.mat) + 0.5;
      const inPiece = new Set(b.cols.map((c) => c.y * 65536 + c.x));
      for (const c of b.cols) {
        const [cx, cy] = cellPos(c.x, c.y);
        const dxy = Math.hypot(cx - hx, cy - hy);
        if (dxy > R) continue;
        // (only the rim: a column with all six neighbours in the piece is its core, and holds the rest up)
        let n = 0;
        for (let k = 0; k < 6; k++) {
          const [nx, ny] = nbr(c.x, c.y, k);
          if (inPiece.has(ny * 65536 + nx)) n++;
        }
        if (!small && n === 6) continue;
        const cut: { z0: number; z1: number }[] = [];
        for (const iv of c.ivs) {
          const z0 = iv.z0 + b.dz;
          const z1 = iv.z1 + b.dz;
          for (let z = Math.floor(z0); z < z1; z++) {
            const lo = Math.max(z, z0);
            const hi = Math.min(z + 1, z1);
            if (hi - lo < 1e-3 || Math.hypot(dxy, (lo + hi) / 2 - hz) > R) continue;
            cut.push({ z0: lo - b.dz, z1: hi - b.dz });
            removed.push({ p: [c.x + 0.5, c.y + 0.5, (lo + hi) / 2], mat: iv.mat });
          }
        }
        if (cut.length) c.ivs = subtract(c.ivs, cut);
      }
      if (removed.length) {
        this.stats.shatters++;
        this.stats.shattered += removed.length;
        this.onDust?.(hx, hy, hz, Math.min(60, 10 + removed.length * 3), impactRadius(l.speed) + 0.5, b.mat);
      }
    }
    this.onCollapse?.(hx, hy, hz, removed.length + b.cells * l.speed * 0.05);
    this.falling.commit(b);
    // (thrown: chips flying from what broke, faster the harder it hit)
    if (removed.length) {
      this.toLoose(removed, l.speed * 1.5);
    }
    this.touch(b, false);
    // what it landed on and what of it overhangs: judged (rock), looked at (structures)
    for (const c of b.cols) {
      this.rockSeeds.set(c.y * 65536 + c.x, 1);
      this.cutSeeds.set(c.y * 65536 + c.x, 1);
    }
    this.urgent = true;
  }

  /** (intread=near) the window's epoch the CPU copy is of, and bytes read back so far (scripts read it) */
  private readEpoch = -1;
  /**
   * (round 88) the chunks (index in the chunk table) read back for this pass — the CPU copy holds them as the GPU
   * has them now; null: all of it. A piece of rock reaching past them is judged once those it reached are read
   * (`needChunks`): one falling from columns the copy last saw seconds ago would write them back as they were.
   */
  private fresh: Set<number> | null = null;
  private needChunks = new Set<number>();
  /** the chunk (index in the chunk table) a column is in */
  private chunkOf(x: number, y: number): number {
    return Math.floor(y / 16) * this.core.packed.chunksX + Math.floor(x / 16);
  }
  readBytes = 0;

  /** (intread=near) the chunks a pass looks at, read back into the CPU copy of the layers (whole after a slide) */
  private async readNear(): Promise<Float32Array | null | 'slid'> {
    const core = this.core;
    if (!this.world.slots.length || core.windowEpoch !== this.readEpoch) {
      const e = core.windowEpoch;
      const f = await core.readBuffer('layers');
      // (round 88: it slid again meanwhile — what came back is of neither)
      if (core.windowEpoch !== e) return 'slid';
      this.readEpoch = e;
      this.readBytes += f.byteLength;
      this.fresh = null;
      this.needChunks.clear();
      return f;
    }
    const p = core.packed;
    const C = 16;
    const want = new Set<number>();
    const box = (x0: number, y0: number, x1: number, y1: number) => {
      const cx0 = Math.max(0, Math.floor(x0 / C));
      const cx1 = Math.min(p.chunksX - 1, Math.floor(x1 / C));
      const cy0 = Math.max(0, Math.floor(y0 / ROW_H / C));
      const cy1 = Math.min(p.chunksY - 1, Math.floor(y1 / ROW_H / C));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) want.add(cy * p.chunksX + cx);
    };
    for (const [x0, y0, x1, y1] of this.dirty) box(x0 - 6, y0 - 6, x1 + 6, y1 + 6);
    for (const k of this.rockSeeds.keys()) {
      const [px, py] = cellPos(k % 65536, Math.floor(k / 65536));
      box(px - 24, py - 24, px + 24, py + 24);
    }
    for (const b of this.bodies.list) {
      let r = 0;
      for (const v of b.local) r = Math.max(r, Math.hypot(v.p[0], v.p[1], v.p[2]));
      box(b.pos[0] - r - 4, b.pos[1] - r - 4, b.pos[0] + r + 4, b.pos[1] + r + 4);
    }
    // (round 95) round the rigid rock: what it falls onto
    for (const b of this.rigid?.list ?? []) {
      const [x0, y0, x1, y1] = this.rigid!.box(b);
      const m = 4 + Math.hypot(b.v[0], b.v[1]) * PASS * 2;
      box(x0 - m, y0 - m, x1 + m, y1 + m);
    }
    // (round 88) the columns a piece reached last pass that the copy didn't hold as they are
    for (const ci of this.needChunks) want.add(ci);
    this.needChunks.clear();
    // (the pieces falling in the columns need nothing read: what they fall onto is their columns' base)
    this.fresh = want;
    if (!want.size) return null;
    const dev = core.host.gpu.device;
    const ranges: [number, number][] = [];
    let bytes = 0;
    for (const ci of want) {
      const at = p.chunkTable[ci * 2] * SLOT_WORDS * 4;
      const n = C * C * p.chunkTable[ci * 2 + 1] * SLOT_WORDS * 4;
      ranges.push([at, n]);
      bytes += n;
    }
    const e = core.windowEpoch;
    const tmp = dev.createBuffer({ label: 'integrity near', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    let o = 0;
    for (const [at, n] of ranges) {
      enc.copyBufferToBuffer(core.world.layers, at, tmp, o, n);
      o += n;
    }
    dev.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    // (the window slid meanwhile: the pages moved — the whole of it next time)
    if (core.windowEpoch !== e) {
      tmp.destroy();
      this.readEpoch = -1;
      return 'slid';
    }
    const all = new Uint32Array(tmp.getMappedRange());
    o = 0;
    for (const [at, n] of ranges) {
      this.world.slots.set(all.subarray(o / 4, (o + n) / 4), at / 4);
      o += n;
    }
    tmp.destroy();
    this.readBytes += bytes;
    return null;
  }

  private pass(): void {
    const t0 = performance.now();
    // a sleeping body with nothing left under it (broken, dug, washed out) wakes
    for (const b of this.bodies.list) if (b.asleep && !this.bodies.supported(b)) this.bodies.wake(b);
    this.stats.passes++;
    // (round 83) rock, by the columns an edit cut: the hanging runs by them, and only those. (Round 88: first —
    // it takes what hangs free whole, whatever it's made of; the structures' boxes then see what's left)
    if (this.rockSeeds.size) {
      const seeds: [number, number][] = [];
      for (const [k, left] of this.rockSeeds) {
        seeds.push([k % 65536, Math.floor(k / 65536)]);
        if (left > 1) this.rockSeeds.set(k, left - 1);
        else this.rockSeeds.delete(k);
      }
      const cut = new Set(this.cutSeeds.keys());
      for (const [k, left] of this.cutSeeds) {
        if (left > 1) this.cutSeeds.set(k, left - 1);
        else this.cutSeeds.delete(k);
      }
      const fresh = this.fresh;
      const known = fresh ? (x: number, y: number) => fresh.has(this.chunkOf(x, y)) : undefined;
      const r = analyseRock(this.world, seeds, known, { weigh: (x, y) => cut.has(y * 65536 + x), rotate: !!this.rigid });
      this.stats.rockSeeds += seeds.length;
      // (round 88) a piece reaching columns not read this pass: they're read, it's judged again at once
      if (r.undecided?.length) {
        for (const [x, y] of r.need ?? []) this.needChunks.add(this.chunkOf(x, y));
        for (const [x, y] of r.undecided) {
          const k = y * 65536 + x;
          this.rockSeeds.set(k, Math.max(1, this.rockSeeds.get(k) ?? 0));
          if (cut.has(k)) this.cutSeeds.set(k, Math.max(1, this.cutSeeds.get(k) ?? 0));
        }
        this.stats.rereads++;
        this.urgent = true;
      }
      // (what gave: its columns looked at again, what it held now hanging free)
      if (this.apply(r))
        for (const c of r.crumbleRuns ?? []) {
          this.rockSeeds.set(c.y * 65536 + c.x, 2);
          this.cutSeeds.set(c.y * 65536 + c.x, 2);
        }
    }
    const boxes = this.dirty;
    this.dirty = [];
    for (const [x0, y0, x1, y1, left] of boxes) {
      if (left > 1) this.dirty.push([x0, y0, x1, y1, left - 1]);
      const r = analyse(this.world, x0 - 2, y0 - 2, x1 + 2, y1 + 2);
      if (this.apply(r)) {
        // what the cut held is looked at again next pass (it now hangs free)
        this.markBox(x0, y0, x1, y1);
      }
      // (round 87) a structure going on past the box wasn't judged: once more over a box twice the size (to 256)
      if (r.beyond && x1 - x0 < 256) {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const h = x1 - x0;
        this.dirty.push([cx - h, cy - h, cx + h, cy + h, 1]);
      }
    }
    this.stats.lastMs = performance.now() - t0;
  }

  /** What an analysis found, done: what crumbles crumbles, what breaks free falls. Did anything crumble? */
  private apply(r: Fracture): boolean {
    // (round 87) the rock's runs that gave: cut out whole (fractional ends too), their volume rubble beside them
    const gave = r.crumbleRuns ?? [];
    if (gave.length) {
      const cells: Voxel[] = [];
      for (const c of gave) {
        const col = readColumn(this.core.packed, this.world.slots, c.x, c.y);
        this.writeColumn(c.x, c.y, subtract(col, c.ivs));
        for (const iv of c.ivs) for (let z = Math.floor(iv.z0); z < iv.z1 - 0.25; z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
      }
      this.spillRubble(cells);
      this.stats.crumbled += cells.length;
      this.chips(cells.map((c) => [c.x + 0.5, c.y + 0.5, c.z + 0.5]), 4);
    }
    if (r.crumble.length) {
      this.removeCells(r.crumble);
      this.spillRubble(r.crumble);
      this.stats.crumbled += r.crumble.length;
      this.chips(r.crumble.map((c) => [c.x + 0.5, c.y + 0.5, c.z + 0.5]), 4);
    }
    // (round 86) what broke free falls in the columns' own format: the rock's pieces by their runs, the
    // structures' by their cells (a column's cells one run each, touching ones of a material joined)
    const zTop = this.core.dims.zMax - 1e-3;
    // (round 95) the rock's pieces as rigid bodies
    if (this.rigid && r.pieces?.length) {
      const tips = new Map((r.tips ?? []).map((t) => [t.piece, t]));
      r.pieces.forEach((piece, i) => {
        if (this.above) for (const c of piece) if (c.ivs.some((iv) => iv.z1 >= zTop)) c.ivs.push(...this.above.take(c.x, c.y));
        this.spawnRigid(piece, tips.get(i));
      });
      if (r.pieces.length) this.timing.spawnedAt = performance.now();
    }
    const pieces: ColPiece[][] = [...(this.rigid ? [] : (r.pieces ?? [])), ...r.bodies.map(cellsToRuns)];
    for (const piece of pieces) {
      // (round 87: a run reaching the window's top goes on above it — Streamer.outside, the band draws it: that
      // comes down with it)
      if (this.above) for (const c of piece) if (c.ivs.some((iv) => iv.z1 >= zTop)) c.ivs.push(...this.above.take(c.x, c.y));
      const b = this.falling.spawn(piece);
      if (!b) continue;
      // a cloud where it tore free (its foot: the columns with a run within a cell of its lowest), to soften the moment
      let z0 = Infinity;
      for (const c of b.cols) for (const iv of c.ivs) z0 = Math.min(z0, iv.z0);
      const foot = b.cols.filter((c) => c.ivs.some((iv) => iv.z0 <= z0 + 1));
      const [fx, fy] = cellPos(Math.round(foot.reduce((s, c) => s + c.x, 0) / foot.length), Math.round(foot.reduce((s, c) => s + c.y, 0) / foot.length));
      this.onDust?.(fx, fy, z0 + 0.5, Math.min(40, 10 + foot.length), Math.sqrt(foot.length) * 0.6 + 0.5, b.mat);
      this.onCollapse?.(fx, fy, z0 + 0.5, foot.length + r.crumble.length + gave.length);
      this.stats.bodies++;
      this.touch(b, true);
    }
    if (pieces.length) this.timing.spawnedAt = performance.now();
    return r.crumble.length > 0 || gave.length > 0;
  }

  /**
   * (round 95) What the rigid rock knows of the world: the CPU copy of the columns. A point in solid or loose ground
   * is pushed out up when it's within 0.6 of its run's top, else sideways through the nearest face of its column with
   * air beside it at that height (the hex's six); the window's floor holds.
   */
  private rockGround(): RockGround {
    const W = this.core.dims.w;
    const H = this.core.dims.h;
    const isGround = (m: number) => {
      const s = MATERIALS[m]?.state;
      return s === MatState.Solid || s === MatState.Granular;
    };
    const world = () => this.world;
    return {
      probe: (wx, wy, wz) => {
        if (wz < 0) return { d: -wz, n: [0, 0, 1] };
        const wv = world();
        if (!wv.slots.length) return null;
        const [cx, cy] = cellAt(wx, wy);
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
        const zq = Math.max(0, wz - 0.5);
        if (!isGround(wv.matAt(cx, cy, zq))) return null;
        let t = wv.runTop(cx, cy, zq);
        for (let i = 0; i < 8 && isGround(wv.matAt(cx, cy, t - 0.49)); i++) t = wv.runTop(cx, cy, t - 0.49);
        const up = t - wz;
        if (up < 0.6) return { d: up, n: [0, 0, 1] };
        const [px, py] = cellPos(cx, cy);
        let best = Infinity;
        let n: V3 = [0, 0, 1];
        for (let k = 0; k < 6; k++) {
          const [nx, ny] = nbr(cx, cy, k);
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && isGround(wv.matAt(nx, ny, zq))) continue;
          const d = 0.5 - ((wx - px) * DIRV[k][0] + (wy - py) * DIRV[k][1]);
          if (d < best) [best, n] = [d, [DIRV[k][0], DIRV[k][1], 0]];
        }
        if (best === Infinity) return { d: Math.min(up, 1), n: [0, 0, 1] };
        return { d: Math.max(0.01, best), n };
      },
      topIn: (x0, y0, x1, y1) => {
        const wv = world();
        if (!wv.slots.length) return 0;
        let top = 0;
        const ya = Math.max(0, Math.floor(y0 / ROW_H - 1));
        const yb = Math.min(H - 1, Math.ceil(y1 / ROW_H));
        const xa = Math.max(0, Math.floor(x0 - 1));
        const xb = Math.min(W - 1, Math.ceil(x1));
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) top = Math.max(top, wv.colTop(x, y));
        return top;
      },
    };
  }

  /** (round 95) A rock piece (its runs) out of the columns as a rigid body; `tip`: it turns over that edge. */
  private spawnRigid(piece: ColPiece[], tip?: { pivot: [number, number, number]; axis: [number, number, number] }): void {
    const rigid = this.rigid!;
    // (the phone's cap: the oldest comes to rest first)
    while (rigid.list.length >= Math.max(1, RB.maxBodies)) {
      rigid.stats.capped++;
      this.fastForward(rigid.list[0]);
    }
    const cells: { x: number; y: number; z: number; mat: number }[] = [];
    let z0 = Infinity;
    for (const c of piece) {
      const col = readColumn(this.core.packed, this.world.slots, c.x, c.y);
      this.writeColumn(c.x, c.y, subtract(col, c.ivs));
      for (const iv of c.ivs) {
        z0 = Math.min(z0, iv.z0);
        for (let z = Math.round(iv.z0); z < Math.round(iv.z1); z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
      }
    }
    const b = rigid.spawn(cells, tip);
    this.touchCols(piece, true);
    if (!b) return;
    b.slot = this.rockMesh?.alloc(cells)?.id;
    // (where it tore free watched a few seconds: what the sim lays meanwhile on what was read — lava setting to a
    // basalt skin on its top — is judged, not left in the air where it was)
    const [bx0, by0, bx1, by1] = rigid.box(b);
    this.watch((bx0 + bx1) / 2, (by0 + by1) / 2, (bx1 - bx0) / 2 + 1, 4);
    this.stats.bodies++;
    // a cloud where it tore free
    const foot = piece.filter((c) => c.ivs.some((iv) => iv.z0 <= z0 + 1));
    const [fx, fy] = cellPos(Math.round(foot.reduce((s, c) => s + c.x, 0) / foot.length), Math.round(foot.reduce((s, c) => s + c.y, 0) / foot.length));
    this.onDust?.(fx, fy, z0 + 0.5, Math.min(40, 10 + foot.length), Math.sqrt(foot.length) * 0.6 + 0.5, b.mat);
    this.onCollapse?.(fx, fy, z0 + 0.5, foot.length);
  }

  /** (round 95) the rigid rock a step: hits raise dust (sparks when hard), break it; what came to rest is ground again */
  private stepRigid(dt: number): void {
    const rigid = this.rigid!;
    const { hits, rest } = rigid.update(dt);
    for (const h of hits) {
      const b = h.body;
      if (!rigid.list.includes(b)) continue;
      const [x, y, z] = h.at;
      const size = Math.sqrt(b.cells.length);
      this.onDust?.(x, y, z, Math.min(60, Math.round(6 + h.speed * 3 + size)), 0.6 + h.speed * 0.15 + size * 0.15, b.mat);
      if (h.speed > RB.breakSpeed * 0.6) this.onSparks?.(x, y, z + 0.3, Math.min(30, Math.round(h.speed * 2)), 2 + h.speed * 0.6);
      this.onCollapse?.(x, y, z, b.cells.length * h.speed * 0.02);
      this.stats.impacts++;
      const br = rigid.breakAt(b, h.speed, h.at);
      if (!br) continue;
      // (its mesh drawn split between the pieces till theirs are built)
      for (const p of br.pieces) p.slot = this.rockMesh?.alloc(rigid.latCells(p))?.id;
      if (b.slot !== undefined) this.ghosts.push({ slot: b.slot, frames: BUILD_FRAMES, seeds: br.seeds, hit: br.hit, rad: br.rad });
      this.stats.shatters++;
      this.stats.shattered += br.rubble.length;
      this.onDust?.(x, y, z, Math.min(60, 12 + br.rubble.length * 2), 1.5 + h.speed * 0.2, b.mat);
      this.toLoose(this.toIndex(br.rubble), h.speed * 1.2);
    }
    for (const b of rest) if (rigid.list.includes(b)) this.settleRigid(b);
  }

  /**
   * (round 95) This frame's draws of the rigid rock's mesh: each body with a slot, those come to rest a few frames on,
   * the ghosts of those just broken (their pieces' own meshes not drawn till the ghost goes).
   */
  private rockDraws(): void {
    const rm = this.rockMesh;
    if (!rm || !this.rigid) return;
    const draws: RockDraw[] = [];
    const index = new Map<RockBody, number>();
    const waiting = new Set<RockBody>();
    for (const g of this.ghosts) for (const s of g.seeds) if (s.piece) waiting.add(s.piece);
    for (const b of this.rigid.list) {
      if (b.slot === undefined && !waiting.has(b)) continue;
      index.set(b, draws.length);
      draws.push({ slot: waiting.has(b) || b.slot === undefined ? -1 : b.slot, m: this.rigid.matrix(b) });
    }
    for (const a of this.afterglow) draws.push({ slot: a.slot, m: a.m });
    for (const g of this.ghosts) {
      const seeds = g.seeds.map((s): [number, number, number, number] => [s.s[0], s.s[1], s.s[2], s.piece && index.has(s.piece) ? index.get(s.piece)! : -1]);
      draws.push({ slot: g.slot, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], ghost: { seeds, hit: g.hit, rad: g.rad } });
    }
    rm.setDraws(draws);
    for (const a of this.afterglow) if (--a.frames <= 0) rm.release(a.slot);
    this.afterglow = this.afterglow.filter((a) => a.frames > 0);
    for (const g of this.ghosts) if (--g.frames <= 0) rm.release(g.slot);
    this.ghosts = this.ghosts.filter((g) => g.frames > 0);
  }

  /** (round 95) world points → the column indices + 0.5 toLoose and chips take */
  private toIndex(vox: { p: V3; mat: number }[]): { p: [number, number, number]; mat: number }[] {
    return vox.map((v) => {
      const [cx, cy] = cellAt(v.p[0], v.p[1]);
      return { p: [cx + 0.5, cy + 0.5, v.p[2]], mat: v.mat };
    });
  }

  /** (round 95) a rigid body run on alone until it rests (at most 4 s), then written back */
  private fastForward(b: RockBody): void {
    const rigid = this.rigid!;
    for (let k = 0; k < 120 && !rigid.frozen; k++) if (rigid.update(1 / 30, [b]).rest.includes(b)) break;
    this.settleRigid(b);
  }

  /**
   * (round 95) A rigid body is ground again: each cell into the column under its centre, down onto what's under it
   * there (in place of a liquid), and those columns judged (and watched a few seconds).
   */
  private settleRigid(b: RockBody): void {
    const rigid = this.rigid!;
    // (its mesh stays a few frames where it came to rest, while the ground's own is made there)
    if (b.slot !== undefined) this.afterglow.push({ slot: b.slot, m: rigid.matrix(b), frames: 6 });
    rigid.remove(b);
    rigid.stats.settled++;
    const { w: W, h: H, zMax } = this.core.dims;
    const by = new Map<number, { z: number; mat: number }[]>();
    for (const c of rigid.worldCells(b)) {
      const [cx, cy] = cellAt(c.p[0], c.p[1]);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const k = cy * 65536 + cx;
      const l = by.get(k) ?? [];
      l.push({ z: Math.max(0, Math.floor(c.p[2])), mat: c.mat });
      by.set(k, l);
    }
    const matter = (m: number) => {
      const s = MATERIALS[m]?.state;
      return s !== undefined && s !== MatState.Empty && s !== MatState.Liquid;
    };
    const cols: ColPiece[] = [];
    for (const [k, cells] of by) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      let col = readColumn(this.core.packed, this.world.slots, x, y);
      const over: Interval[] = [];
      cells.sort((a, c) => a.z - c.z);
      for (const c of cells) {
        // (down onto what's under it in its column: a cell of a body lying across a gap or a crater's edge, over air
        // in its own column, would float once the ground beside it went — the first try left single cells over a
        // meteor's melting bowl. A heap settles column by column, as rubble would)
        let z0 = 0;
        for (const iv of col) if (matter(iv.mat) && iv.z1 <= c.z + 0.5 && iv.z1 > z0) z0 = iv.z1;
        for (let moved = true, i = 0; moved && i < 64; i++) {
          moved = false;
          for (const iv of col)
            if (matter(iv.mat) && iv.z0 < z0 + 1 - 1e-3 && iv.z1 > z0 + 1e-3) {
              z0 = iv.z1;
              moved = true;
            }
        }
        if (z0 + 1 > zMax - 1e-3) {
          over.push({ z0: Math.max(z0, zMax), z1: Math.max(z0, zMax) + 1, mat: c.mat });
          continue;
        }
        col = subtract(col, [{ z0, z1: z0 + 1 }]);
        col.push({ z0, z1: z0 + 1, mat: c.mat });
        col.sort((a, c2) => a.z0 - c2.z0);
      }
      // (touching intervals of a material: one)
      const merged: Interval[] = [];
      for (const iv of col) {
        const last = merged[merged.length - 1];
        if (last && last.mat === iv.mat && Math.abs(last.z1 - iv.z0) < 1e-4 && (last.aux ?? 0) === (iv.aux ?? 0)) last.z1 = iv.z1;
        else merged.push({ ...iv });
      }
      this.writeColumn(x, y, merged);
      if (over.length) this.above?.put(x, y, over);
      cols.push({ x, y, ivs: [] });
      // (judged for what floats, not weighed: a heap lying as it fell isn't tipped or crushed again — round 95's first
      // try weighed it and the heap's pieces were freed, fell and settled over and over)
      this.rockSeeds.set(k, 2);
    }
    if (cols.length) {
      this.touchCols(cols, true);
      // (and watched a few seconds: a cell left over air once the ground round it changes — a crater's rim melting
      // and setting, a piece landing beside — is judged again; the first try left single cells floating in a crater)
      const [x0, y0, x1, y1] = rigid.box(b);
      this.watch((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 1, 4);
    }
    this.urgent = true;
  }

  /** (round 95) columns changed: the chunks over them meshed again (voxels, in the hybrid), their sim awake */
  private touchCols(cols: { x: number; y: number }[], first: boolean): void {
    if (!cols.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of cols) {
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
    }
    this.touch({ box: [x0, y0, x1, y1] } as FallingBody, first);
  }

  /**
   * Crushed cells (a cross-section that gave way) don't vanish (round 23,
   * Q3): each one's volume squeezes out as its rubble (looseFrom) onto the
   * lowest open ground beside it — not where it was, where the rubble would
   * go on holding up what the section held.
   */
  private spillRubble(cells: Voxel[]): void {
    const { w: W, h: H } = this.core.dims;
    const gone = new Set(cells.map((c) => c.y * W + c.x));
    const tops = new Map<number, number>();
    const topAt = (x: number, y: number): number => {
      const k = y * W + x;
      let t = tops.get(k);
      if (t === undefined) {
        const col = readColumn(this.core.packed, this.world.slots, x, y);
        t = col.length ? col[col.length - 1].z1 : 0;
        tops.set(k, t);
      }
      return t;
    };
    const out: { p: [number, number, number]; mat: number }[] = [];
    for (const c of cells) {
      let best: [number, number] = [c.x, c.y];
      let low = Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = c.x + dx;
          const y = c.y + dy;
          if (x < 0 || y < 0 || x >= W || y >= H || gone.has(y * W + x)) continue;
          const t = topAt(x, y);
          if (t < low) [best, low] = [[x, y], t];
        }
      out.push({ p: [best[0] + 0.5, best[1] + 0.5, c.z + 0.5], mat: c.mat });
    }
    this.toLoose(out);
  }

  /** Cut single cells out of their columns (CPU mirror + GPU). */
  private removeCells(cells: Voxel[]): void {
    const byCol = new Map<number, number[]>();
    const W = this.core.dims.w;
    for (const c of cells) {
      const k = c.y * W + c.x;
      if (!byCol.has(k)) byCol.set(k, []);
      byCol.get(k)!.push(c.z);
    }
    for (const [k, zs] of byCol) {
      const x = k % W;
      const y = (k - x) / W;
      let col = readColumn(this.core.packed, this.world.slots, x, y);
      for (const z of zs) {
        const out: Interval[] = [];
        for (const iv of col) {
          if (z < iv.z0 || z >= iv.z1) out.push(iv);
          else {
            if (iv.z0 < z) out.push({ ...iv, z1: z });
            if (z + 1 < iv.z1) out.push({ ...iv, z0: z + 1 });
          }
        }
        col = out;
      }
      this.writeColumn(x, y, col);
    }
  }

  /** A column written (to the CPU copy, the GPU's layers or both; round 86: either alone, for the falling pieces). */
  private writeColumn(x: number, y: number, col: Interval[], cpu = true, gpu = true): void {
    const { base, k } = columnSlots(this.core.packed, x, y);
    if (col.length > k) {
      // no room: keep the bottom k − 1 and pile the rest's mass as rubble on top
      const keep = col.slice(0, k - 1);
      const top = keep.length ? keep[keep.length - 1].z1 : 0;
      const rest = col.slice(k - 1).reduce((s, iv) => s + iv.z1 - iv.z0, 0);
      keep.push({ z0: top, z1: Math.min(top + rest, this.core.dims.zMax - 1), mat: MAT.Rubble });
      col = keep;
    }
    const data = packColumn(col, k);
    if (cpu) {
      this.world.slots.set(data, base * SLOT_WORDS);
      this.inflight?.set(y * 65536 + x, col);
    }
    if (!gpu) return;
    this.core.host.gpu.device.queue.writeBuffer(this.core.world.layers, base * SLOT_WORDS * 4, data);
    // (round 80: a column written under a sleeping chunk wakes it — its surface, its water, its slumping)
    if (cpu) this.core.sleep?.wake(x + 0.5, (y + 0.5) * ROW_H, 16, 8, performance.now() / 1000);
  }
}

/** (round 86) a structure's cells as runs, column by column (touching cells of a material one run) */
function cellsToRuns(cells: Voxel[]): ColPiece[] {
  const by = new Map<number, Voxel[]>();
  for (const c of cells) {
    const k = c.y * 65536 + c.x;
    const l = by.get(k);
    if (l) l.push(c);
    else by.set(k, [c]);
  }
  const out: ColPiece[] = [];
  for (const l of by.values()) {
    l.sort((a, b) => a.z - b.z);
    const ivs: Interval[] = [];
    for (const c of l) {
      const last = ivs[ivs.length - 1];
      if (last && last.z1 === c.z && last.mat === c.mat) last.z1 = c.z + 1;
      else ivs.push({ z0: c.z, z1: c.z + 1, mat: c.mat });
    }
    out.push({ x: l[0].x, y: l[0].y, ivs });
  }
  return out;
}

/** What a body voxel of material m crumbles to (a loose material). */
function looseFrom(m: number): number {
  if (m === MAT.Wood || m === MAT.Canvas || m === MAT.Leaves) return MAT.Ash;
  if (m === MAT.Bone) return MAT.Drift;
  if (m === MAT.Trash) return MAT.Litter;
  if (m === MAT.Ice) return MAT.Snow;
  if (m === MAT.Crystal) return MAT.Sand;
  return MAT.Rubble;
}

/** The commonest material among some voxels. */
function mainMat(vox: { mat: number }[]): number {
  const n = new Map<number, number>();
  let best = 0;
  let most = 0;
  for (const v of vox) {
    const c = (n.get(v.mat) ?? 0) + 1;
    n.set(v.mat, c);
    if (c > most) [best, most] = [v.mat, c];
  }
  return best;
}
