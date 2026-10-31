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
import { cellAt, cellPos, nbr, ROW_H } from '../world/lattice';
import { EventKind } from '../sim/globals';
import { CUTS, OP, editOpOf } from '../sim/edit-ops';
import { ColumnBodies, subtract, type ColPiece, type FallingBody, type Landing } from './colbodies';
import { RockBodies, RB, columnsGround, type RockBody, type RockGround, type V3 } from './rockbodies';
import { BUILD_FRAMES, type RockDraw, type RockMesh } from '../render/rockmesh';
import type { Physics } from '../physics/physics';
import { TUNE } from '../tune/params';
import { record } from '../gpu/cpustat'; // (round 100, hitchrec: timing)
import { ExternalRegistry, OWNER_ROCK, type ExternalCol, type ExternalInstance } from '../sim/external';
import { fieldMeshed } from '../world/materials';
import { restingVoxels } from './rockbodies';
import { Solver } from '../solver/solver';
import { ROUTING, solverVariant, type Routing, type SolverVariant } from '../solver/variant';
import type { PhysBody } from '../physics/physics';
import type { SolverBody } from '../api/contracts/solver';

/** (round 96) what bends: metal — and (solver step 2, but for the baseline variant) wood — goes to a deformable body (the node solver's or the voxel lattice's, by the variant), the rest of what falls stays rigid */
const METAL: ReadonlySet<number> = new Set<number>([MAT.Steel, MAT.Rust]);
const WOOD: ReadonlySet<number> = new Set<number>([MAT.Wood, MAT.Log]);
/** (round 96) cells of metal woken at once at most (wake.ts WAKE_MAX) */
const METAL_MAX = 6000;
/**
 * (round 96, ?rbskin=1, an experiment) the metal drawn as a field mesh skinned to its particles (meshed as stone: the
 * field leaves metal to the prisms). Off by default: the field mesh can't hold metal's thin members — a girder two
 * cells deep, a tower's one-column legs mesh to nothing — so the metal is drawn as its particles' own voxels, each
 * turned with its particle, as the woken buildings and the drop tool's bodies are.
 */
const SKIN_METAL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('rbskin') === '1';

const PASS = 0.35; // s between analyses while anything is dirty or moving
/** (round 100, hitchrec) the structures' boxes a pass judges until it has taken this long (ms); the rest wait for the next */
const PASS_BUDGET = 8;
/** (round 99, meshinst; round 110: the tuning's rigid.restMax) resting rock kept as meshes at once (their slots are the rock mesh's: render/rockmesh.ts) */
/** (round 100) the streamer's region (scenes/streamer.ts REGION: not imported — the scene imports this) */
const REGION_CELLS = 64;
/** (round 99) cells under a resting rock's cells, down to the ground, claimed with it (what it stands on) */
const REST_FILL = 3;

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
// (round 108: the tuning's `impact` — breakSpeed (was IMPACT_BREAK, cells/s), shatter (SHATTER), crumb (IMPACT_CRUMB, voxels))
const IMP = TUNE.impact;
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
  /** (solver step 2, AR4) the GPU node solver that moves the rigid rock (src/solver; its contract api/contracts/solver.ts) */
  readonly solver: Solver | null = null;
  /** (solver step 2, the experiment) which representation moves what's freed (solver/variant.ts: ?solver=) */
  readonly variant: SolverVariant = solverVariant();
  private readonly route: Routing = ROUTING[this.variant];
  /** what bends (goes to a deformable body): metal, and wood but for the baseline */
  private bends(m: number): boolean {
    return METAL.has(m) || (this.route.woodBends && WOOD.has(m));
  }
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
   * (round 99, `?meshinst=1`) Columns owned by other systems (sim/external.ts): with the rigid rock, a body that comes
   * to rest stays its mesh where it lies — its cells External intervals (they hold what's put on them), drawn by the
   * rock's mesh at its last transform — instead of being written back as ground. Null without meshinst.
   */
  readonly external: ExternalRegistry | null = null;
  /** (round 99) the resting rock: instance → its mesh's slot and transform (oldest first) */
  private resting = new Map<number, { slot?: number; m: number[]; mat: number; cells?: { x: number; y: number; z: number; mat: number }[]; history?: number; vox?: Float32Array }>();
  /**
   * (round 96, the user: "a different material like metal (does it use the deformation physics the buildings
   * do?)") With rockbody on, metal that the judges free or cut is woken into the physics voxels (the GPU solver the
   * buildings and the drop tool use: it bends, plastically, and snaps), whole — everything of it connected, its
   * cells resting on other ground pinned — and drawn with its own mesh skinned to the particles.
   */
  physics?: Physics;
  /** (solver step 2) the metal woken into the node solver: its body, its mesh's slot (SKIN_METAL) */
  private metal: { body: SolverBody; slot?: number; mat: number }[] = [];
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
  /** (round 96) why what gave gave, summed over every rock pass (Fracture.why) — for the tests */
  why: Record<string, number> = {};
  private t = 0;
  private busy = false;
  /** chips where something crumbles or a body hits hard */
  onChips?: (x: number, y: number, z: number, count: number, speed?: number) => void;
  /** something came down here: the low crash (voxels broken or landing) */
  onCollapse?: (x: number, y: number, z: number, amount: number) => void;
  /** dust where something breaks or a body hits (grains, spread in cells, the material it's made of) */
  onDust?: (x: number, y: number, z: number, count: number, spread: number, mat: number) => void;
  /** stats for the perf overlay / tests */
  stats = { passes: 0, bodies: 0, crumbled: 0, settled: 0, crumbledBodies: 0, impacts: 0, shatters: 0, shattered: 0, lastMs: 0, rockSeeds: 0, rereads: 0, settledFalls: 0, settleMs: 0, metal: 0, deferred: 0 };
  /** sleeping bodies projected per column: top, bottom (top < 0: none) — the
   *  GPU's bodyProj texture and the bodies' own collision share it */
  readonly proj: Float32Array;
  /** budget for sleeping bodies (DECISIONS round 17) */
  static readonly MAX_SLEEPING = 64;
  static readonly MAX_SLEEP_VOXELS = 16384;

  constructor(
    private core: WorldCore,
    /** (round 95) rock the judge frees falls as rigid bodies (rockbodies.ts rockbodyFor) */
    rockbody = false,
  ) {
    this.world = new WorldVox(core.packed, new Uint32Array(0));
    this.bodies = new Bodies(this.world);
    const N = core.dims.w * core.dims.h;
    this.proj = new Float32Array(N * 4);
    this.resetProjection();
    this.bodies.proj = this.proj;
    // (round 107, pages: the projection mirrors a texture — bodyCpu, a page atlas: column (x, y) at its texel)
    this.bodies.projIdx = (x, y) => core.ring.t(x, y);
    this.bodies.onSleep = () => {
      this.stats.settled++;
      this.keepBudget();
      this.project();
    };
    this.bodies.onWake = () => this.project();
    this.bodies.onImpact = (b, speed, at) => this.impact(b, speed, at);
    if (rockbody) {
      (this as { rigid: RockBodies | null }).rigid = new RockBodies(this.rockGround());
      // (solver step 2, AR4) the GPU node solver moves them: body against body, the contact rules, a fixed step drawn
      // between its last two; the judge here still decides what lets go, breaks it, and takes it back at rest — with
      // the variant's say (?solver=: the baseline keeps the CPU rigid rock, the lattice the voxels)
      const route = ROUTING[this.variant];
      if (route.rock === 'nodes' || route.metal === 'nodes') {
      const solver = new Solver(core.host.gpu.device, core.world, core.host.profiler);
      core.sim.systems.push(solver);
      if (route.rock === 'nodes') this.rigid!.engine = solver;
      (this as { solver: Solver | null }).solver = solver;
      // (what it draws: the metal's cells as voxels, each riding its node; the rock mesh skinned to its nodes)
      core.renderer.addVoxels(solver.skinInst, solver.skinArgs);
      core.renderer.setRockNodes({ pose: solver.pose, lanes: solver.lanes });
      solver.onBuffers = () => {
        core.renderer.removeVoxels(solver.skinArgs);
        core.renderer.addVoxels(solver.skinInst, solver.skinArgs);
        core.renderer.setRockNodes({ pose: solver.pose, lanes: solver.lanes });
      };
      }
      this.rockMesh = core.renderer.enableRockMesh();
      // (round 110: with the rigid rock always, not only `?meshinst=1` — the user: "When things come to rest they turn
      // to dust instead of staying as meshes as we discussed"; DECISIONS round 106: "A settled body stays an object
      // (sleeping, instanced). It is baked into terrain only between runs, or when the object buffer needs room")
      if (this.rockMesh) {
        const ext = new ExternalRegistry({
          read: (x, y) => readColumn(this.core.packed, this.world.slots, x, y),
          write: (x, y, col) => this.writeColumn(x, y, col),
        });
        // (round 110, BACKLOG MI5) one cut or found hanging free wakes, its own mesh as it lay: not ground again
        ext.owner(OWNER_ROCK, { name: 'rock', onLost: (inst, why) => this.wakeResting(inst, why) });
        (this as { external: ExternalRegistry | null }).external = ext;
      }
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
          // (solver step 2: the lattice's sleepers by a cut wake — the node solver's find out for themselves)
          this.physics?.wakeNear(e.x, e.y, e.radius + 4);
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
    // (round 100, hitchrec) a box inside one already waiting as long is judged with it (a cyclone marks its box a frame)
    for (const d of this.dirty) if (d[4] >= 2 && d[0] <= x0 && d[1] <= y0 && d[2] >= x1 && d[3] >= y1) return;
    this.dirty.push([x0, y0, x1, y1, 2]);
  }

  /** The visible top of a column: solid ground plus loose ground, or a fallen body's top. */
  topAt(x: number, y: number): number {
    // (round 106: the projection on the window's ring — the window index y * W + x mapped onto it, so a column past
    // the window's edge reads what it did in window order: the row's wrap, or nothing past the ends)
    const w = y * this.core.dims.w + x;
    const W = this.core.dims.w;
    const i = w >= 0 && w < W * this.core.dims.h ? this.core.ring.t(w % W, Math.floor(w / W)) : -1;
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
    // (round 99) the resting rock leaving the window (all of it, in z or a warp) becomes ground first: the streamer
    // freezes the columns as they are, and no one owns them over there
    if (this.external) {
      for (const inst of [...this.external.instances]) {
        if (inst.owner !== OWNER_ROCK) continue;
        const out = dz || (!dx && !dy) || inst.cols.some((c) => (dx > 0 ? c.x < dx + 1 : dx < 0 ? c.x >= W + dx - 1 : dy > 0 ? c.y < dy + 1 : c.y >= H + dy - 1));
        // (round 100: one wholly inside a region leaving — or any of the window's, a warp — goes with it, its mesh
        // and transform in the region's record: Streamer.things, regionThings below)
        if (out && !dz && this.carried(inst, dx, dy)) continue;
        if (out) this.unrest(inst, 'leaving');
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
    this.solver?.shift(wx, wy, dz);
    // (round 99) the resting rock with the land (what left was let go in settle)
    if (this.external) {
      this.external.shift(dx, dy);
      for (const r of this.resting.values()) {
        r.m[3] -= wx;
        r.m[7] -= wy;
        r.m[11] -= dz;
      }
    }
    this.bodies.list = [];
    this.pendingLoose.clear();
    this.needChunks.clear();
    this.readEpoch = -1;
    if (this.rockSeeds.size) this.urgent = true;
    this.project();
  }

  /**
   * (round 108, the playground's station reset) What moves or rests over the columns [x0, x1) × [y0, y1) (storage
   * cells) is let go before the caller writes them again: the rigid rock over them dropped, the resting rock on them
   * forgotten, the pieces falling through them landed at once (written into the columns the caller then writes over),
   * the loose bodies over them gone. Elsewhere nothing changes.
   */
  forget(x0: number, y0: number, x1: number, y1: number): void {
    const [wx0, wy0] = cellPos(x0, y0);
    const [wx1, wy1] = cellPos(x1, y1);
    const over = (x: number, y: number) => x >= wx0 - 1 && x < wx1 + 1 && y >= wy0 - 1 && y < wy1 + 1;
    if (this.rigid) {
      const go = new Set(this.rigid.list.filter((b) => over(b.pos[0], b.pos[1])));
      for (const b of go) if (b.slot !== undefined) this.rockMesh?.release(b.slot);
      this.rigid.list = this.rigid.list.filter((b) => !go.has(b));
    }
    if (this.external) {
      for (const inst of [...this.external.instances]) {
        if (inst.owner !== OWNER_ROCK || !inst.cols.some((c) => c.x >= x0 && c.x < x1 && c.y >= y0 && c.y < y1)) continue;
        const r = this.resting.get(inst.id);
        this.external.forget(inst);
        if (r) {
          if (r.slot !== undefined) this.rockMesh?.release(r.slot);
          this.resting.delete(inst.id);
        }
      }
    }
    const through = (b: FallingBody) => b.box[0] < x1 && b.box[2] >= x0 && b.box[1] < y1 && b.box[3] >= y0;
    for (let k = 0; k < 2000; k++) {
      const go = this.falling.list.filter(through);
      if (!go.length) break;
      for (const l of this.falling.update(0.05, false, go)) this.land(l);
    }
    this.bodies.list = this.bodies.list.filter((b) => !over(b.pos[0], b.pos[1]));
    this.dirty = this.dirty.filter(([a, b, c, d]) => !(a >= wx0 && c <= wx1 && b >= wy0 && d <= wy1));
    // (solver step 2) the metal there let go too
    if (this.solver)
      for (const mb of [...this.metal]) {
        const r = this.solver.read(mb.body);
        const at = r?.pos ?? mb.body.restCom;
        if (!over(at[0], at[1])) continue;
        this.solver.remove(mb.body);
        if (mb.slot !== undefined) this.rockMesh?.release(mb.slot);
        this.metal = this.metal.filter((m) => m !== mb);
      }
  }

  /**
   * (solver step 2, the lab) A body made of these cells (column x, y, cell z — where it starts, out of the ground),
   * dropped: metal into the node solver as a deformable, the rest as the rigid rock. Its cells must be air.
   */
  dropBody(cells: { x: number; y: number; z: number; mat: number }[], vel: [number, number, number] = [0, 0, 0]): boolean {
    if (!this.rigid || !cells.length) return false;
    if (this.route.rock === 'lattice' || (this.bends(cells[0].mat) && this.route.metal === 'lattice')) return this.spawnLattice(cells, () => false);
    if (this.bends(cells[0].mat)) {
      const slot = SKIN_METAL ? this.rockMesh?.alloc(cells.map((c) => ({ ...c, mat: MAT.Stone })))?.id : undefined;
      if (!this.solver) return false;
      const body = this.solver.add({ cells, vel, kind: 'deformable', drawCells: slot === undefined });
      if (!body) return false;
      this.metal.push({ body, slot, mat: cells[0].mat });
      return true;
    }
    const b = this.rigid.spawn(cells);
    if (!b) return false;
    b.v = vel;
    b.slot = this.allocRock(cells);
    this.stats.bodies++;
    return true;
  }

  /** (solver step 2, the lab) the metal at this cell (column x, y, cell z) and all it connects to woken (by the variant) */
  wakeMetalAt(x: number, y: number, z: number): void {
    if (this.rigid && (this.route.metal === 'nodes' ? this.solver : this.physics) && this.world.slots.length) this.wakeMetal([[x, y, z]]);
  }

  /**
   * (solver step 2, the lattice variants) Cells (out of the columns already) as a body of the physics voxels — a
   * particle a cell on its lattice, 26 bonds, shape matched (phys.wgsl) — `pinned` ones held. False with no room.
   */
  private spawnLattice(cells: { x: number; y: number; z: number; mat: number }[], pinned: (c: { x: number; y: number; z: number; mat: number }) => boolean): boolean {
    const phys = this.physics;
    if (!phys || !cells.length) return false;
    let lo: [number, number, number] = [Infinity, Infinity, Infinity];
    let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of cells) {
      lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
      hi = [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
    }
    const dims: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
    if (!phys.hasRoom(dims[0] * dims[1] * dims[2])) return false;
    const at = new Map(cells.map((c) => [`${c.x - lo[0]},${c.y - lo[1]},${c.z - lo[2]}`, c]));
    const body: PhysBody | null = phys.spawnLattice(
      dims,
      (x, y, z) => at.get(`${x},${y},${z}`)?.mat ?? 0,
      (x, y, z) => {
        const [px, py] = cellPos(lo[0] + x, lo[1] + y);
        return [px, py, lo[2] + z + 0.5];
      },
      { pinned: (x, y, z) => {
        const c = at.get(`${x},${y},${z}`);
        return !!c && pinned(c);
      } },
    );
    if (body) this.stats.bodies++;
    return !!body;
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
      // (round 99: the resting rock's columns are the undo's or the warp's now — orphans there go back to ground)
      for (const r of this.resting.values()) if (r.slot !== undefined) this.rockMesh?.release(r.slot);
      this.resting.clear();
      this.external?.clear();
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
  /**
   * (round 106, frameprobe) whether the last projection held a body: when it held none and none sleeps now, the
   * texture is already all "none" (WorldGpu fills it so, a slide's strip comes in so) and nothing is written — a
   * slide's re-projection was 4 MB filled, rotated and uploaded at window 512 for an empty grid
   */
  private projected = true;

  private project(): void {
    const sleeping = this.bodies.list.some((b) => b.asleep);
    if (!sleeping && !this.projected) return;
    this.projected = sleeping;
    this.resetProjection();
    const { w: W, h: H } = this.core.dims;
    const P = this.proj;
    const ring = this.core.ring;
    for (const b of this.bodies.list) {
      if (!b.asleep) continue;
      this.bodies.voxelBounds(b, (lo, hi) => {
        // (the cells whose centres the voxel's box covers: the grid is hex)
        for (let y = Math.max(0, Math.floor((lo[1] + 0.15) / ROW_H - 0.5)); y <= Math.min(H - 1, Math.ceil((hi[1] - 0.15) / ROW_H - 0.5)); y++)
          for (let x = Math.max(0, Math.floor(lo[0] - 1)); x <= Math.min(W - 1, Math.ceil(hi[0])); x++) {
            const [cx, cy] = cellPos(x, y);
            if (cx < lo[0] + 0.15 || cx > hi[0] - 0.15 || cy < lo[1] + 0.15 || cy > hi[1] - 0.15) continue;
            // (round 106: on the window's ring, as the texture: written whole, not rotated)
            const i = ring.t(x, y) * 4;
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
    // (ringwin: in the ring's order — round 106: kept so)
    dev.queue.writeTexture({ texture: this.core.world.bodyCpu }, P as Float32Array<ArrayBuffer>, { bytesPerRow: W * 16 }, [W, H]);
    // (round 104, simscale: written whole, so projected whole next tick — grids/systems.ts ProjectSystem)
    this.core.world.projectAll = true;
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
    if (speed < IMP.breakSpeed) {
      this.onCollapse?.(at[0], at[1], at[2], b.local.length * speed * 0.05);
      return;
    }
    const weak = b.local.reduce((s, v) => s + impactReach(v.mat), 0) / b.local.length;
    const k = Math.min(8, Math.floor((weak * speed * speed * b.local.length) / IMP.shatter));
    const shards = this.bodies.shatter(b, at, k, IMP.crumb);
    const { removed, crumbs } = this.bodies.breakAt(at, impactRadius(speed), IMP.crumb, impactReach);
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
      // (ringwin: window column i's place on the ring)
      const W = this.core.dims.w;
      dev.queue.writeBuffer(this.core.world.deposit, this.core.ring.idx(i % W, Math.floor(i / W)) * 16 + 4, new Float32Array([e.amount, best]));
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
    if (this.rigid?.list.length || this.restingVox) {
      // (round 95) the rigid rock: a step, its hits (dust, sparks, a break), what came to rest written back
      const tRigid = performance.now(); // (round 100, hitchrec: timing)
      if (this.rigid?.list.length && this.world.slots.length && dt > 0) this.stepRigid(dt);
      record('rockbodies', performance.now() - tRigid); // (round 100, hitchrec: timing)
      const max = 16384;
      if (this.packF.length < max * 8) this.packF = new Float32Array(max * 8);
      const f = this.packF;
      const u = new Uint32Array(f.buffer);
      f.set(new Float32Array(data.buffer, data.byteOffset, Math.min(count, max) * 8));
      // (the cells drawn as voxels: of those without a mesh, all; (round 112) of the rest, what's built — the rock's mesh
      // is the field mesh's, which draws no concrete, brick or metal: a concrete piece was a body with an empty mesh,
      // the user's "The concrete just immediately vanished". The rest of the cells only cast the shadow)
      const drawn = (b: RockBody, k: { mat: number }) => !!RB.cubes || b.slot === undefined || !fieldMeshed(k.mat);
      let shown = this.rigid!.packInto(f, u, Math.min(count, max), max, drawn);
      // (round 112) and the resting ones' (their cells drawn so where they lie)
      for (const r of this.resting.values())
        if (r.vox?.length) {
          const k = Math.min(r.vox.length / 8, max - shown);
          f.set(r.vox.subarray(0, k * 8), shown * 8);
          shown += k;
        }
      const n = this.rigid!.packInto(f, u, shown, max, (b, k) => !drawn(b, k));
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
        // (round 96: weighed too — lava setting by what the cut freed props it up, a film of basalt against its side;
        // judged for floating only, it was held by that and never weighed: the user's "basalt that resupports it")
        this.markCut(w.x, w.y, w.r);
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

  /**
   * (round 117, structures — a tweak for main to consolidate) The CPU copy of the layers, read once if there's none yet:
   * an owner claiming External cells at the level's start (the settlements view, src/settle/view.ts) reads and writes it.
   */
  async ensureCopy(): Promise<void> {
    if (this.world.slots.length) return;
    const e = this.core.windowEpoch;
    const f = await this.core.readBuffer('layers');
    if (this.world.slots.length || this.core.windowEpoch !== e) return;
    this.world.slots = new Uint32Array(f.buffer);
    this.readEpoch = e;
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
   * (round 86) A piece came down: hit hard (IMP.breakSpeed), the rim of its foot crumbles round where it struck
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
    if (l.speed >= IMP.breakSpeed && !b.broke) {
      const small = b.cells <= IMP.crumb;
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
    // (round 96) its foot crumbled: it settles on down onto what's under it, gently, rather than being ground again
    // over the gap the crumbs left — judged hanging, it fell and crumbled again each time it landed (floatsweep's
    // 3-wide, 100-tall tower, a few cells a fall, never settling)
    if (removed.length && b.cells > removed.length) {
      b.broke = true;
      b.vz = 0;
      this.toLoose(removed, l.speed * 1.5);
      this.touch(b, false);
      return;
    }
    this.falling.commit(b);
    // (thrown: chips flying from what broke, faster the harder it hit)
    if (removed.length) {
      this.toLoose(removed, l.speed * 1.5);
    }
    this.touch(b, false);
    // what it landed on and what of it overhangs: judged (rock), looked at (structures)
    // (round 96: judged for floating only — weighed, a tall piece landed on uneven ground was judged off its "leg" each
    // time it came to rest, slumping a cell a pass: floatsweep's 3-wide 100-tall tower never settled)
    for (const c of b.cols) this.rockSeeds.set(c.y * 65536 + c.x, 1);
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
    // (round 99) what other systems own, as the copy now has it: an instance that lost cells is cut (its owner told);
    // after a whole read, External intervals no one owns are orphans (an undo, a thaw) and go back to ground
    if (this.external) {
      const fresh = this.fresh;
      const te = performance.now();
      this.external.verify(fresh ? (x, y) => fresh.has(this.chunkOf(x, y)) : undefined);
      if (!fresh) this.external.orphans(this.externalCols());
      this.external.stats.ms = +(performance.now() - te).toFixed(2);
    }
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
      // (round 96: what the last weighing found, for the tests)
      for (const [k, v] of Object.entries(r.why ?? {})) this.why[k] = (this.why[k] ?? 0) + v;
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
      const gave = this.apply(r);
      // (what gave, and (round 96) the columns a piece left: what's left there — a leg's stump, what was joined to
      // the piece — is judged again, weighed: it lost what it held or what held it)
      for (const c of [...(gave ? (r.crumbleRuns ?? []) : []), ...(r.pieces ?? []).flat()]) {
        this.rockSeeds.set(c.y * 65536 + c.x, 2);
        this.cutSeeds.set(c.y * 65536 + c.x, 2);
      }
    }
    const boxes = this.dirty;
    this.dirty = [];
    for (let b = 0; b < boxes.length; b++) {
      // (round 100, hitchrec: a pass never holds the main thread for seconds — past its budget the boxes left wait,
      // as they were, for the next pass; a soak saw one pass of 40 s, every arriving town's box solved)
      if (b > 0 && performance.now() - t0 > PASS_BUDGET) {
        for (let k = b; k < boxes.length; k++) this.dirty.push(boxes[k]);
        this.stats.deferred += boxes.length - b;
        break;
      }
      const [x0, y0, x1, y1, left] = boxes[b];
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
    record('judge.pass', this.stats.lastMs); // (round 100, hitchrec: timing — the pass runs in its readback's continuation)
  }

  /** What an analysis found, done: what crumbles crumbles, what breaks free falls. Did anything crumble? */
  private apply(r: Fracture): boolean {
    // (round 96) metal isn't the judges': it's woken into the physics voxels, whole, where they found it
    if (this.rigid && (this.route.metal === 'nodes' ? this.solver : this.physics)) this.takeMetal(r);
    // (round 99) what other systems own found hanging free or giving: their owners told (the rock lets go: its cells
    // are ground again, and fall here with the rest as they do)
    if (this.external) this.takeExternal(r);
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
    // (solver step 2, AR11: the falling pieces folded into the one solver) what the structure judge frees — concrete,
    // brick — falls as rigid bodies too, body against body, toppling, at rest a mesh or its cells
    if (this.rigid && this.route.structures === 'rock' && r.bodies.length) {
      for (const body of r.bodies) {
        const piece = cellsToRuns(body);
        if (this.above) for (const c of piece) if (c.ivs.some((iv) => iv.z1 >= zTop)) c.ivs.push(...this.above.take(c.x, c.y));
        this.spawnRigid(piece);
      }
      this.timing.spawnedAt = performance.now();
    }
    const pieces: ColPiece[][] = this.rigid && this.route.structures === 'rock' ? [] : [...(this.rigid ? [] : (r.pieces ?? [])), ...r.bodies.map(cellsToRuns)];
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
    // (round 110: the rules are rockbodies.ts columnsGround's — shared with the CPU harness, scripts/physfix-cpu.ts)
    return columnsGround(() => (this.world.slots.length ? this.world : null), this.core.dims.w, this.core.dims.h, (x, y, z) => this.restingMass(x, y, z));
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
    // (the lattice variant: rock and what's built on the voxel lattice too — the tankers' solver for everything)
    if (this.route.rock === 'lattice' && this.physics) {
      this.touchCols(piece, true);
      this.spawnLattice(cells, () => false);
      return;
    }
    const b = rigid.spawn(cells, tip);
    this.touchCols(piece, true);
    if (!b) return;
    b.slot = this.allocRock(cells);
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
    const { hits, rest, erode } = rigid.update(dt);
    if (erode.length) this.erodeUnder(erode);
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
      for (const p of br.pieces) p.slot = this.allocRock(rigid.latCells(p));
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
    // (the solver's bodies cleared — undo, a warp — take the metal's with them)
    if (this.solver && this.metal.length) {
      const live = this.solver.bodies;
      for (const mb of this.metal) if (!live.has(mb.body) && mb.slot !== undefined) rm.release(mb.slot);
      this.metal = this.metal.filter((mb) => live.has(mb.body));
    }
    const draws: RockDraw[] = [];
    const index = new Map<RockBody, number>();
    const waiting = new Set<RockBody>();
    for (const g of this.ghosts) for (const s of g.seeds) if (s.piece) waiting.add(s.piece);
    for (const b of this.rigid.list) {
      if (b.slot === undefined && !waiting.has(b)) continue;
      index.set(b, draws.length);
      draws.push({ slot: waiting.has(b) || b.slot === undefined ? -1 : b.slot, m: this.rigid.drawMatrix(b) });
    }
    for (const a of this.afterglow) draws.push({ slot: a.slot, m: a.m });
    // (round 99) the resting rock, where it lies
    for (const r of this.resting.values()) if (r.slot !== undefined) draws.push({ slot: r.slot, m: r.m });
    // (round 96) the metal: its mesh skinned to its particles
    for (const mb of this.metal) if (mb.slot !== undefined) draws.push({ slot: mb.slot, m: [], skin: { slot: mb.body.slot, com: mb.body.restCom, nodes: mb.body.nodes, mat: mb.mat } });
    for (const g of this.ghosts) {
      const seeds = g.seeds.map((s): [number, number, number, number] => [s.s[0], s.s[1], s.s[2], s.piece && index.has(s.piece) ? index.get(s.piece)! : -1]);
      draws.push({ slot: g.slot, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], ghost: { seeds, hit: g.hit, rad: g.rad } });
    }
    rm.setDraws(draws, this.core.renderAlpha());
    for (const a of this.afterglow) if (--a.frames <= 0) rm.release(a.slot);
    this.afterglow = this.afterglow.filter((a) => a.frames > 0);
    for (const g of this.ghosts) if (--g.frames <= 0) rm.release(g.slot);
    this.ghosts = this.ghosts.filter((g) => g.frames > 0);
  }

  /** (round 96) The metal in what the judges found taken out of it, and woken (wakeMetal) where it was. */
  private takeMetal(r: Fracture): void {
    const at: [number, number, number][] = [];
    const strip = (rp: { x: number; y: number; ivs: { z0: number; z1: number; mat: number }[] }[] | undefined) => {
      for (const c of rp ?? []) {
        const keep = c.ivs.filter((iv) => !this.bends(iv.mat));
        if (keep.length !== c.ivs.length) for (const iv of c.ivs) if (this.bends(iv.mat)) at.push([c.x, c.y, Math.floor((iv.z0 + iv.z1) / 2)]);
        c.ivs = keep;
      }
    };
    for (const p of r.pieces ?? []) strip(p);
    if (r.pieces) r.pieces = r.pieces.map((p) => p.filter((c) => c.ivs.length));
    strip(r.crumbleRuns);
    if (r.crumbleRuns) r.crumbleRuns = r.crumbleRuns.filter((c) => c.ivs.length);
    const cellsOut = (vs: Voxel[]) => {
      for (const v of vs) if (this.bends(v.mat)) at.push([v.x, v.y, v.z]);
      return vs.filter((v) => !this.bends(v.mat));
    };
    r.crumble = cellsOut(r.crumble);
    r.bodies = r.bodies.map(cellsOut).filter((b) => b.length);
    if (at.length) this.wakeMetal(at);
  }

  /**
   * (round 96) The metal connected to these cells (column x, y, cell z), out of the columns into the node solver
   * (solver step 2; it was the physics voxels) as one deformable body — it bends, dents and snaps — a cell resting on
   * other ground pinned (a foundation: wake.ts), drawn as its cells riding its nodes (or its mesh skinned to them,
   * ?rbskin=1).
   */
  private wakeMetal(seeds: [number, number, number][]): void {
    const solver = this.solver;
    const { w: W, h: H } = this.core.dims;
    const cols = new Map<number, Interval[]>();
    const colAt = (x: number, y: number) => {
      const k = y * 65536 + x;
      let c = cols.get(k);
      if (!c) cols.set(k, (c = readColumn(this.core.packed, this.world.slots, x, y)));
      return c;
    };
    const key = (x: number, y: number, z: number) => (z * 8192 + y) * 8192 + x;
    /** the metal cell at (x, y, z): its material, and whether it rests on other ground */
    const metalAt = (x: number, y: number, z: number): { mat: number; pin: boolean } | null => {
      if (x < 0 || y < 0 || x >= W || y >= H || z < 0) return null;
      const col = colAt(x, y);
      for (let k = 0; k < col.length; k++) {
        const iv = col[k];
        // (any metal in the cell, a sliver too: what a meteor's melt left of a member is taken with it, not left floating)
        if (!this.bends(iv.mat) || iv.z1 <= z + 0.01 || iv.z0 >= z + 0.99) continue;
        const below = k > 0 ? col[k - 1] : null;
        const pin = z === Math.floor(iv.z0 + 0.01) && (iv.z0 < 1e-3 || (!!below && Math.abs(below.z1 - iv.z0) < 1e-3 && !this.bends(below.mat)));
        return { mat: iv.mat, pin };
      }
      return null;
    };
    const cells = new Map<number, { x: number; y: number; z: number; mat: number; pin: boolean }>();
    const queue: number[] = [];
    for (const [x, y, z] of seeds) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = metalAt(x, y, z + dz);
        const k = key(x, y, z + dz);
        if (c && !cells.has(k)) {
          cells.set(k, { x, y, z: z + dz, ...c });
          queue.push(k);
        }
      }
    }
    for (let q = 0; q < queue.length && cells.size < METAL_MAX; q++) {
      const c = cells.get(queue[q])!;
      const around: [number, number][] = [[c.x, c.y]];
      for (let d = 0; d < 6; d++) around.push(nbr(c.x, c.y, d));
      for (const [nx, ny] of around)
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(nx, ny, c.z + dz);
          if (cells.has(k)) continue;
          const n = metalAt(nx, ny, c.z + dz);
          if (!n) continue;
          cells.set(k, { x: nx, y: ny, z: c.z + dz, ...n });
          queue.push(k);
        }
    }
    if (!cells.size) return;
    let lo: [number, number, number] = [Infinity, Infinity, Infinity];
    let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of cells.values()) {
      lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
      hi = [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
    }
    // (its mesh's slot first: without one its cells are drawn)
    const list = [...cells.values()];
    // (meshed as stone: the field leaves metal to the prisms — its own material drawn: RockDraw.skin.mat)
    const mats = new Map<number, number>();
    for (const c of list) mats.set(c.mat, (mats.get(c.mat) ?? 0) + 1);
    const mat = [...mats].sort((a, b) => b[1] - a[1])[0][0];
    const slot = SKIN_METAL ? this.rockMesh?.alloc(list.map((c) => ({ ...c, mat: MAT.Stone })))?.id : undefined;
    const pins = new Set(list.filter((c) => c.pin).map((c) => key(c.x, c.y, c.z)));
    const plain = list.map((c) => ({ x: c.x, y: c.y, z: c.z, mat: c.mat }));
    // (the variant's: the voxel lattice — the physics voxels, drawn as their own voxels — or the node solver)
    let body: SolverBody | null = null;
    if (this.route.metal === 'lattice') {
      if (slot !== undefined) this.rockMesh?.release(slot);
      if (!this.spawnLattice(plain, (c) => pins.has(key(c.x, c.y, c.z)))) return;
    } else {
      body = solver!.add({ cells: plain, pinned: (c) => pins.has(key(c.x, c.y, c.z)), kind: 'deformable', drawCells: slot === undefined });
      if (!body) {
        if (slot !== undefined) this.rockMesh?.release(slot);
        return;
      }
    }
    // out of the columns (both copies)
    const byCol = new Map<number, { z0: number; z1: number }[]>();
    for (const c of cells.values()) {
      const k = c.y * 65536 + c.x;
      const l = byCol.get(k) ?? [];
      l.push({ z0: c.z, z1: c.z + 1 });
      byCol.set(k, l);
    }
    const touched: { x: number; y: number }[] = [];
    for (const [k, cut] of byCol) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      // (only the metal goes: what else shares those heights stays)
      const col = colAt(x, y);
      const out: Interval[] = [];
      for (const iv of col) {
        if (!this.bends(iv.mat)) out.push(iv);
        else out.push(...subtract([iv], cut));
      }
      this.writeColumn(x, y, out);
      touched.push({ x, y });
      this.rockSeeds.set(k, 2);
    }
    this.touchCols(touched, true);
    this.urgent = true;
    if (body) this.metal.push({ body, slot, mat });
    this.stats.bodies++;
    this.stats.metal = (this.stats.metal ?? 0) + list.length;
    const [fx, fy] = cellPos(Math.round((lo[0] + hi[0]) / 2), Math.round((lo[1] + hi[1]) / 2));
    this.onCollapse?.(fx, fy, lo[2] + 0.5, list.length * 0.1);
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
    // (round 112: with or without a mesh — one without is drawn as its cells, as it was while it moved)
    if (this.external && this.restRigid(b)) return;
    // (round 110: written back — no mesh for it, or nowhere to claim — is a bake: behind a burst of dust, DECISIONS
    // round 106's "hide every re-mesh or body-to-terrain swap behind a burst of dust")
    {
      const [x0, y0, x1, y1] = rigid.box(b);
      this.bakeDust((x0 + x1) / 2, (y0 + y1) / 2, b.pos[2], Math.max(x1 - x0, y1 - y0) / 2, b.cells.length, b.mat);
    }
    // (its mesh stays a few frames where it came to rest, while the ground's own is made there)
    if (b.slot !== undefined) this.afterglow.push({ slot: b.slot, m: rigid.matrix(b), frames: 6 });
    rigid.remove(b);
    rigid.stats.settled++;
    rigid.stats.baked++;
    const why = b.slot === undefined ? 'no mesh' : this.external ? 'unclaimed' : 'no registry';
    rigid.bakedWhy[why] = (rigid.bakedWhy[why] ?? 0) + 1;
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

  /** (round 99) A mesh slot for a piece; with no room, the oldest resting rock becomes ground to make some. */
  private allocRock(all: { x: number; y: number; z: number; mat: number }[]): number | undefined {
    const rm = this.rockMesh;
    if (!rm) return undefined;
    // (round 112) its mesh is the field mesh's: only what that draws (what's built is drawn as voxels)
    const cells = all.filter((c) => fieldMeshed(c.mat));
    if (!cells.length) return undefined;
    for (;;) {
      const got = rm.alloc(cells);
      if (got) return got.id;
      const oldest = this.resting.keys().next();
      if (oldest.done || !this.external) return undefined;
      const inst = this.external.get(oldest.value);
      if (!inst) {
        this.resting.delete(oldest.value);
        continue;
      }
      this.unrest(inst, 'room');
    }
  }

  /** (round 100) nothing falling (no piece, no rigid rock in the air): the streamer may save the window as it is */
  get quiet(): boolean {
    return !this.falling.list.length && !this.rigid?.list.length;
  }

  /** (round 100) whether a resting rock is wholly inside one region that a slide of (dx, dy) — (0, 0): a warp — freezes */
  private carried(inst: ExternalInstance, dx: number, dy: number): boolean {
    const { w: W, h: H } = this.core.dims;
    const R = REGION_CELLS;
    const r = this.resting.get(inst.id);
    if (!r?.cells || !inst.cols.length) return false;
    const rx = Math.floor(inst.cols[0].x / R);
    const ry = Math.floor(inst.cols[0].y / R);
    if (!inst.cols.every((c) => Math.floor(c.x / R) === rx && Math.floor(c.y / R) === ry)) return false;
    const x0 = rx * R;
    const y0 = ry * R;
    if (!dx && !dy) return true;
    return dx > 0 ? x0 < dx : dx < 0 ? x0 >= W + dx : dy > 0 ? y0 < dy : y0 >= H + dy;
  }

  /**
   * (round 100, meshinst) The resting rock as a region's things (Streamer.things): taken with a region frozen — out
   * of the registry and its mesh let go, its cells left External in the columns — and given back when the region is
   * written again: registered, its mesh made from its cells, at its transform.
   */
  regionThings(): { name: string; take(x0: number, y0: number, x1: number, y1: number, keep?: boolean): import('../world/region-record').ThingRecord[]; give(things: import('../world/region-record').ThingRecord[], x0: number, y0: number): void } {
    return {
      name: 'rock',
      take: (x0, y0, x1, y1, keep = false) => {
        const ext = this.external;
        if (!ext) return [];
        const out: import('../world/region-record').ThingRecord[] = [];
        for (const inst of [...ext.instances]) {
          if (inst.owner !== OWNER_ROCK) continue;
          if (!inst.cols.every((c) => c.x >= x0 && c.x < x1 && c.y >= y0 && c.y < y1)) continue;
          const r = this.resting.get(inst.id);
          if (!r?.cells) continue;
          const m = [...r.m];
          m[3] -= x0;
          m[7] -= y0 * ROW_H;
          out.push({ owner: OWNER_ROCK, kind: 'rock', m, state: { cells: r.cells, mat: r.mat }, cols: inst.cols.map((c) => ({ x: c.x - x0, y: c.y - y0, z0: c.z0, z1: c.z1 })), fallback: inst.fallback, id: r.history ?? inst.id });
          if (keep) continue;
          ext.forget(inst);
          if (r.slot !== undefined) this.rockMesh?.release(r.slot);
          this.resting.delete(inst.id);
        }
        return out;
      },
      give: (things, x0, y0) => {
        const ext = this.external;
        if (!ext) return;
        for (const t of things) {
          if (t.owner !== OWNER_ROCK) continue;
          const st = t.state as { cells: { x: number; y: number; z: number; mat: number }[]; mat: number };
          // (round 112: a mesh for what the field mesh draws of it; all built, none)
          const meshed = st.cells.filter((c) => fieldMeshed(c.mat));
          const slot = meshed.length ? this.rockMesh?.alloc(meshed)?.id : undefined;
          const inst = ext.adopt(OWNER_ROCK, t.cols.map((c) => ({ x: c.x + x0, y: c.y + y0, z0: c.z0, z1: c.z1 })), t.fallback);
          if (slot === undefined && meshed.length) {
            // (no room for its mesh: ground again)
            this.unrest(inst, 'room');
            continue;
          }
          const m = [...t.m];
          m[3] += x0;
          m[7] += y0 * ROW_H;
          this.resting.set(inst.id, { slot, m, mat: st.mat, cells: st.cells, history: t.id, vox: this.voxOf(st.cells, m, slot) });
        }
      },
    };
  }

  /** (round 99) the resting rock (meshinst): instances, their cells, for the tests */
  get restingCount(): number {
    return this.resting.size;
  }

  /** (round 112) voxels the resting bodies have drawn as voxels (what's built in them; all of one with no mesh) */
  private get restingVox(): number {
    let n = 0;
    for (const r of this.resting.values()) n += (r.vox?.length ?? 0) / 8;
    return n;
  }

  /** (round 112) a resting body's voxels: what its mesh doesn't draw (all of it without one) */
  private voxOf(cells: { x: number; y: number; z: number; mat: number }[], m: number[], slot: number | undefined): Float32Array | undefined {
    const v = restingVoxels(cells, m, (mat) => slot === undefined || !fieldMeshed(mat));
    return v.length ? v : undefined;
  }

  /**
   * (round 99, meshinst) A rigid body come to rest stays its mesh where it lies: the columns its cells are in claimed
   * as External from its lowest to its highest cell in each (down onto the ground under it where that's less than a
   * cell below — what holds it), buried where they're ground already. False: nothing claimed (written back instead).
   */
  private restRigid(b: RockBody): boolean {
    const rigid = this.rigid!;
    const ext = this.external!;
    const { w: W, h: H, zMax } = this.core.dims;
    const by = new Map<number, [number, number]>();
    for (const c of rigid.worldCells(b)) {
      const [cx, cy] = cellAt(c.p[0], c.p[1]);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const k = cy * 65536 + cx;
      const r = by.get(k);
      const lo = Math.max(0, c.p[2] - 0.5);
      const hi = Math.min(zMax - 1e-3, c.p[2] + 0.5);
      if (r) by.set(k, [Math.min(r[0], lo), Math.max(r[1], hi)]);
      else by.set(k, [lo, hi]);
    }
    const want: ExternalCol[] = [];
    const matter = (m: number) => {
      const s = MATERIALS[m]?.state;
      return s !== undefined && s !== MatState.Empty && s !== MatState.Liquid;
    };
    for (const [k, [lo0, hi]] of by) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      let lo = lo0;
      let ground = 0;
      for (const iv of readColumn(this.core.packed, this.world.slots, x, y)) if (matter(iv.mat) && iv.z1 <= lo + 0.5 && iv.z1 > ground) ground = iv.z1;
      // (round 99: down to the ground under its whole footprint where that's within REST_FILL — the rock judge weighs
      // what stands by the columns under it: a boulder touching at a corner, its centre of mass past that corner, was
      // judged to tip and let go the moment it came to rest)
      if (lo > ground && lo - ground < REST_FILL) lo = ground;
      if (hi - lo > 0.05) want.push({ x, y, z0: lo, z1: hi });
    }
    // (room: the resting rock is held to REST_MAX — the oldest becomes ground)
    while (this.resting.size >= Math.max(1, RB.restMax)) {
      const id = this.resting.keys().next().value!;
      const inst = ext.get(id);
      if (inst) this.unrest(inst, 'room');
      else this.resting.delete(id);
    }
    const inst = ext.claim(OWNER_ROCK, want, b.mat);
    if (!inst) return false;
    rigid.remove(b);
    rigid.stats.settled++;
    const m = rigid.matrix(b);
    const cells = rigid.latCells(b);
    this.resting.set(inst.id, { slot: b.slot, m, mat: b.mat, cells, vox: this.voxOf(cells, m, b.slot) });
    const cols = inst.cols.map((c) => ({ x: c.x, y: c.y, ivs: [] }));
    this.touchCols(cols, true);
    // (judged for what floats, not weighed — as a heap written back is)
    for (const c of inst.cols) this.rockSeeds.set(c.y * 65536 + c.x, 2);
    const [x0, y0, x1, y1] = rigid.box(b);
    this.watch((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 1, 4);
    this.urgent = true;
    return true;
  }

  /**
   * (round 110) Every resting rock baked into the ground (the explicit request: between runs) — each behind its dust.
   */
  bakeResting(): number {
    const ext = this.external;
    if (!ext) return 0;
    let n = 0;
    for (const inst of [...ext.instances]) {
      if (inst.owner !== OWNER_ROCK) continue;
      this.unrest(inst, 'asked');
      n++;
    }
    return n;
  }

  /** (round 110) the mass (cells) of the resting rock owning column (x, y) at height z; undefined: none (the ground) */
  private restingMass(x: number, y: number, z: number): number | undefined {
    const inst = this.external?.at(x, y, z, z + 0.5).find((o) => o.owner === OWNER_ROCK);
    return inst ? this.resting.get(inst.id)?.cells?.length : undefined;
  }

  /** (round 110) the burst a bake (or a re-mesh) hides behind: dust over the body's size, a puff of chips */
  private bakeDust(x: number, y: number, z: number, r: number, cells: number, mat: number): void {
    this.onDust?.(x, y, z, Math.min(60, 12 + Math.round(Math.sqrt(cells) * 3)), Math.max(1, r * 0.8), mat);
  }

  /**
   * (round 110, BACKLOG MI5) A resting rock whose instance was lost wakes as a body where it lies — its own mesh, at
   * its transform, still — rather than becoming ground the judge then frees as a new body (meshed again: the user's
   * "they turn to dust"). Cut (dug, smashed): the cells it lost are gone from it, its mesh made again behind dust;
   * hanging free: as it was. Its cells in the columns go to air (the body has them).
   */
  private wakeResting(inst: ExternalInstance, why: 'cut' | 'loose'): void {
    const rigid = this.rigid;
    const ext = this.external!;
    const r = this.resting.get(inst.id);
    if (!rigid || !r?.cells) return this.unrest(inst, 'lost');
    let keep = r.cells;
    if (why === 'cut') {
      // (each cell where it lies now: still claimed, and still External in the copy — or dug out of it)
      const m = r.m;
      keep = r.cells.filter((c) => {
        const [px, py] = cellPos(c.x, c.y);
        const pz = c.z + 0.5;
        const wx = m[0] * px + m[1] * py + m[2] * pz + m[3];
        const wy = m[4] * px + m[5] * py + m[6] * pz + m[7];
        const wz = m[8] * px + m[9] * py + m[10] * pz + m[11];
        const [cx, cy] = cellAt(wx, wy);
        if (!ext.at(cx, cy, wz - 0.5, wz + 0.5).includes(inst)) return true;
        return readColumn(this.core.packed, this.world.slots, cx, cy).some((iv) => iv.mat === MAT.External && iv.z1 > wz - 0.25 && iv.z0 < wz + 0.25);
      });
    }
    this.resting.delete(inst.id);
    ext.release(inst.id, true);
    const cols = inst.cols.map((c) => ({ x: c.x, y: c.y, ivs: [] }));
    this.touchCols(cols, true);
    for (const c of inst.cols) {
      this.rockSeeds.set(c.y * 65536 + c.x, 2);
      this.cutSeeds.set(c.y * 65536 + c.x, 2);
    }
    this.urgent = true;
    const lost = r.cells.length - keep.length;
    const b = keep.length >= 8 ? rigid.revive(keep, r.m) : null;
    if (!b) {
      // (what's left of it too small to be a body: rubble, behind dust)
      if (r.slot !== undefined) this.afterglow.push({ slot: r.slot, m: r.m, frames: 2 });
      if (keep.length) {
        const m = r.m;
        const pts = keep.map((c) => {
          const [px, py] = cellPos(c.x, c.y);
          const pz = c.z + 0.5;
          return { p: [m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]] as V3, mat: c.mat };
        });
        this.toLoose(this.toIndex(pts), 2);
        this.bakeDust(pts[0].p[0], pts[0].p[1], pts[0].p[2], 2, keep.length, r.mat);
      }
      return;
    }
    if (!lost) b.slot = r.slot;
    else {
      // (its mesh made again without what it lost: the swap behind a burst of dust)
      if (r.slot !== undefined) this.afterglow.push({ slot: r.slot, m: r.m, frames: 2 });
      b.slot = this.allocRock(rigid.latCells(b));
      const [x0, y0, x1, y1] = rigid.box(b);
      this.bakeDust((x0 + x1) / 2, (y0 + y1) / 2, b.pos[2], Math.max(x1 - x0, y1 - y0) / 2, lost, b.mat);
    }
    this.stats.bodies++;
    // (the phone's cap: the oldest other comes to rest first)
    while (rigid.list.length > Math.max(1, RB.maxBodies)) {
      const old = rigid.list.find((o) => o !== b);
      if (!old) break;
      rigid.stats.capped++;
      this.fastForward(old);
    }
  }

  /**
   * (round 110) Ground a body cut deep into (RockBodies: past its slop by RB.erodeDepth) crumbles where they meet —
   * rubble and dust — rather than the body being pushed out (DECISIONS round 106). Solid ground only (loose ground
   * it just sinks into), not bedrock, not what other systems own (External: a resting rock).
   */
  private erodeUnder(pts: { body: RockBody; at: V3 }[]): void {
    const { w: W, h: H } = this.core.dims;
    const removed: { p: [number, number, number]; mat: number }[] = [];
    const cols: { x: number; y: number; ivs: [] }[] = [];
    const done = new Set<number>();
    let mat = 0;
    for (const { body, at } of pts) {
      const [cx, cy] = cellAt(at[0], at[1]);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const z = Math.floor(at[2]);
      const key = (z * 8192 + cy) * 8192 + cx;
      if (z < 1 || done.has(key)) continue;
      done.add(key);
      const col = readColumn(this.core.packed, this.world.slots, cx, cy);
      const cut: { z0: number; z1: number }[] = [];
      for (const iv of col) {
        const d = MATERIALS[iv.mat];
        if (!d || d.state !== MatState.Solid || d.span === Infinity) continue;
        const lo = Math.max(iv.z0, z);
        const hi = Math.min(iv.z1, z + 1);
        if (hi - lo < 0.05) continue;
        cut.push({ z0: lo, z1: hi });
        removed.push({ p: [cx + 0.5, cy + 0.5, (lo + hi) / 2], mat: iv.mat });
        mat = iv.mat;
      }
      if (!cut.length) continue;
      this.writeColumn(cx, cy, subtract(col, cut));
      cols.push({ x: cx, y: cy, ivs: [] });
      this.rockSeeds.set(cy * 65536 + cx, 2);
      this.cutSeeds.set(cy * 65536 + cx, 2);
      void body;
    }
    if (!removed.length) return;
    this.rigid!.stats.eroded += removed.length;
    this.touchCols(cols, true);
    this.toLoose(removed, 1.5);
    const p = pts[0].at;
    this.onDust?.(p[0], p[1], p[2], Math.min(30, 6 + removed.length * 3), 0.8 + removed.length * 0.2, mat);
    this.urgent = true;
  }

  /**
   * (round 99) A resting rock baked into the ground (round 110: only out of room, leaving the window, or asked —
   * `bakeResting`; one cut or hanging free wakes instead): its cells ground again, its mesh gone, behind a burst of dust.
   */
  private unrest(inst: ExternalInstance, why: 'room' | 'leaving' | 'asked' | 'lost'): void {
    const r = this.resting.get(inst.id);
    this.resting.delete(inst.id);
    if (r) {
      if (r.slot !== undefined) this.afterglow.push({ slot: r.slot, m: r.m, frames: 6 });
      if (this.rigid) {
        this.rigid.stats.baked++;
        this.rigid.bakedWhy[why] = (this.rigid.bakedWhy[why] ?? 0) + 1;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z = 0;
      for (const c of inst.cols) {
        x0 = Math.min(x0, c.x);
        y0 = Math.min(y0, c.y);
        x1 = Math.max(x1, c.x);
        y1 = Math.max(y1, c.y);
        z = Math.max(z, c.z1);
      }
      const [wx0, wy0] = cellPos(x0, y0);
      const [wx1, wy1] = cellPos(x1, y1);
      this.bakeDust((wx0 + wx1) / 2, (wy0 + wy1) / 2, z - 1, Math.max(wx1 - wx0, wy1 - wy0) / 2, r.cells?.length ?? 8, r.mat);
    }
    this.external?.release(inst.id);
    const cols = inst.cols.map((c) => ({ x: c.x, y: c.y, ivs: [] }));
    this.touchCols(cols, true);
    for (const c of inst.cols) {
      this.rockSeeds.set(c.y * 65536 + c.x, 2);
      this.cutSeeds.set(c.y * 65536 + c.x, 2);
    }
    this.urgent = true;
  }

  /** (round 99) An analysis's runs that are External: made their fallback material in it, their owners told. */
  private takeExternal(r: Fracture): void {
    const ext = this.external!;
    const hit: ExternalCol[] = [];
    // (round 110: taken out of what falls or crumbles — the owner wakes its thing, which takes them back as itself;
    // round 99 made them their fallback material in the piece, and the rock was freed again as a new body, meshed
    // again. One no instance owns stays in, as its fallback)
    const scan = (rp: { x: number; y: number; ivs: Interval[] }[] | undefined) => {
      for (const c of rp ?? []) {
        const keep: Interval[] = [];
        for (const iv of c.ivs) {
          if (iv.mat !== MAT.External) {
            keep.push(iv);
            continue;
          }
          const owned = ext.at(c.x, c.y, iv.z0, iv.z1);
          if (owned.length) {
            hit.push({ x: c.x, y: c.y, z0: iv.z0, z1: iv.z1 });
            continue;
          }
          iv.mat = iv.aux || MAT.Stone;
          iv.aux = 0;
          keep.push(iv);
        }
        c.ivs = keep;
      }
    };
    for (const p of r.pieces ?? []) scan(p);
    scan(r.crumbleRuns);
    if (r.pieces) r.pieces = r.pieces.map((p) => p.filter((c) => c.ivs.length));
    if (r.crumbleRuns) r.crumbleRuns = r.crumbleRuns.filter((c) => c.ivs.length);
    if (hit.length) ext.loose(hit);
  }

  /** (round 99) The columns (y · 65536 + x) with an External interval in the CPU copy (a scan of its words). */
  private externalCols(): number[] {
    const p = this.core.packed;
    const u = this.world.slots;
    const out: number[] = [];
    const C = 16;
    for (let cy = 0; cy < p.chunksY; cy++)
      for (let cx = 0; cx < p.chunksX; cx++) {
        const ci = cy * p.chunksX + cx;
        const base = p.chunkTable[ci * 2];
        const k = p.chunkTable[ci * 2 + 1];
        for (let i = 0; i < C * C; i++) {
          const o = (base + i * k) * SLOT_WORDS;
          for (let s = 0; s < k; s++) {
            const w = o + s * SLOT_WORDS;
            if (u[w + 1] === 0) break;
            if ((u[w + 2] & 0xff) === MAT.External) {
              out.push((cy * C + Math.floor(i / C)) * 65536 + cx * C + (i % C));
              break;
            }
          }
        }
      }
    return out;
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
