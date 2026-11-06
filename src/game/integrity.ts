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

import { type Interval } from '../world/layout';
import { floatingRuns, WorldVox, type Fracture } from './fracture';
import { JUDGE_ID, JUDGES, type RockJudge } from './judge';
import { Bodies, type Body } from './bodies';
import type { WorldCore } from '../scenes/world-core';
import { cellAt, cellPos, ROW_H } from '../world/lattice';
import { EventKind } from '../sim/globals';
import { BLOW_TAG, CUTS, OP, editOpOf } from '../sim/edit-ops';
import { ColumnBodies } from './colbodies';
import { RockBodies, type RockBody, type V3 } from './rockbodies';
import { type RockMesh } from '../render/rockmesh';
import type { Physics } from '../physics/physics';
import { worldG } from '../tune/params';
import { ExternalRegistry, OWNER_ROCK } from '../sim/external';
import { Solver } from '../solver/solver';
import { ROUTING, solverVariant, type Routing, type SolverVariant } from '../solver/variant';
import type { PhysBody } from '../physics/physics';
import type { SolverBody } from '../api/contracts/solver';
import { type VoxelModel } from '../world/models';
import { BodyMeshes } from '../render/bodymesh';
import { ColumnCopy } from './colcopy';
import { ColumnApply } from './colapply';
import { ColumnQuery } from './colquery';
import { judgeCols, update, withColumns } from './integrity/tick';
import { forget, settle, slid } from './integrity/window';
import { allocRock, meshFor, rockGround } from './integrity/rigid';
import { wakeMetal, wakeMetalNear } from './integrity/metal';
import { regionThings, unrest, wakeResting } from './integrity/resting';
import { edit, writeColumn } from './integrity/columns';
import { chips, impact, keepBudget, project, resetProjection, toLoose } from './integrity/loose';
import { dropModels, spawnLattice } from './integrity/lattice';
import { METAL, WOOD, Grab, JB6_KEEP, GROUND_DUST, mainMat } from './integrity/defs';
export { GROUND_DUST } from './integrity/defs';
export type { Grab } from './integrity/defs';

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
  readonly route: Routing = ROUTING[this.variant];
  /** what bends (goes to a deformable body): metal, and wood but for the baseline */
  bends(m: number): boolean {
    return METAL.has(m) || (this.route.woodBends && WOOD.has(m));
  }
  /** sparks where rock hits rock hard (round 86: "a big cloud of dust … and maybe sparks") */
  onSparks?: (x: number, y: number, z: number, count: number, speed: number) => void;
  /** (round 95) the body voxels drawn this frame (the cube bodies' and the rigid rock's) */
  packF = new Float32Array(0);
  /** (round 95) the rigid rock's mesh (the renderer's: none without the field mesh — then its cubes are drawn) */
  rockMesh?: RockMesh;
  /** (round 95) a broken body's mesh drawn split between its pieces till theirs are built; a settled one's a few frames on */
  ghosts: { slot: number; frames: number; seeds: { s: V3; piece: RockBody | null }[]; hit: V3; rad: number }[] = [];
  afterglow: { slot: number; m: number[]; frames: number }[] = [];
  /**
   * (round 99, `?meshinst=1`) Columns owned by other systems (sim/external.ts): with the rigid rock, a body that comes
   * to rest stays its mesh where it lies — its cells External intervals (they hold what's put on them), drawn by the
   * rock's mesh at its last transform — instead of being written back as ground. Null without meshinst.
   */
  readonly external: ExternalRegistry | null = null;
  /** (round 99) the resting rock: instance → its mesh's slot and transform (oldest first) */
  resting = new Map<number, { slot?: number; m: number[]; mat: number; cells?: { x: number; y: number; z: number; mat: number }[]; history?: number; mesh?: number }>();
  /**
   * (round 96, the user: "a different material like metal (does it use the deformation physics the buildings
   * do?)") With rockbody on, metal that the judges free or cut is woken into the physics voxels (the GPU solver the
   * buildings and the drop tool use: it bends, plastically, and snaps), whole — everything of it connected, its
   * cells resting on other ground pinned — and drawn with its own mesh skinned to the particles.
   */
  physics?: Physics;
  /** (solver step 2) the metal woken into the node solver: its body, its own mesh (bodyMeshes), its main material */
  metal: { body: SolverBody; mesh: number; mat: number }[] = [];
  /**
   * (round 120, the user: "Rendering and simulation should not be coupled that way") every body's own mesh, skinned to
   * what moves it (render/bodymesh.ts): the metal's whole, a rock's what the rock mesh doesn't hold (what's built, or
   * all of one the rock mesh had no room for) — never its cells drawn as voxels
   */
  readonly bodyMeshes: BodyMeshes | null = null;
  /** each moving rock's own mesh (0: none, the rock mesh holds all of it) */
  rockMeshOf = new Map<RockBody, number>();
  /**
   * (round 86) a cut was sent this tick or since: the next pass starts at once (not on the 0.35 s timer), its
   * readback submitted after the tick that made the cut — so one look is enough
   */
  urgent = false;
  fallFrame = 0;
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
  /**
   * (round 128j) land a slide is bringing in isn't written yet (Streamer.unwritten): its places still hold the land that
   * left — with its towns' claims in it (claims at load: kept when a region leaves) — until it's frozen into the pool, so
   * no orphan pass runs over the window meanwhile (it would take those claims for orphans and freeze them as rubble)
   */
  landPending?: () => boolean;
  /** chunks round what was touched: hybrid voxels from now on (the level: HybridChunks.edit); x0, y0, x1, y1 world */
  onTouched?: (x0: number, y0: number, x1: number, y1: number) => void;
  /** (round 86) when the last pass was asked for and done (performance.now, ms): the latency probe reads them */
  timing = { askedAt: 0, readStartAt: 0, readAt: 0, doneAt: 0, spawnedAt: 0 };
  /**
   * (round 120, JB6) the CPU's copy of the columns (game/colcopy.ts): kept whole where a CPU consumer walks it (judge A,
   * the CPU rigid rock, the pieces falling in the columns), else nothing held but what a reader fetches
   */
  cols: ColumnCopy;
  /** the copy's columns as the CPU judges and bodies read them */
  get world(): WorldVox {
    return this.cols.vox;
  }
  /** (round 120, JB6) the GPU's own changes to its columns (a verdict's cuts, spills, deposits, External let go) */
  gpuEdit: ColumnApply;
  /** (round 120, JB6) small questions asked of the GPU's columns (is anything built in a box?) */
  query: ColumnQuery;
  /** (round 120, JB6) the window slid or was written again: orphaned External intervals made ground on the GPU next pass */
  orphanCheck = false;
  /** boxes to analyse: x0, y0, x1, y1, passes left (edits reach the GPU a
   *  tick after they are queued, so each box is looked at twice) */
  dirty: [number, number, number, number, number][] = [];
  /** (round 83) the columns an edit cut ("y,x" keys) and the passes each is looked at still: where rock is judged */
  rockSeeds = new Map<number, number>();
  /**
   * (round 92) of those, the columns the edit itself changed (passes left, as rockSeeds): a held piece is weighed
   * (fracture.ts ROCK) only if it, or what holds it, has a run in one — what floats is judged wherever it is
   */
  cutSeeds = new Map<number, number>();
  /** (round 96) why what gave gave, summed over every rock pass (Fracture.why) — for the tests */
  why: Record<string, number> = {};
  /**
   * (round 120) the rock's judge (game/judge.ts): A, runs (fracture.ts analyseRock on the CPU's copy), by default; B,
   * sections (the method of sections on the GPU, judge.wgsl), with ?judge=sections. Settable (a lab's panel: JUDGES)
   */
  judge: RockJudge = JUDGES[JUDGE_ID].make();
  t = 0;
  busy = false;
  /** chips where something crumbles or a body hits hard */
  onChips?: (x: number, y: number, z: number, count: number, speed?: number) => void;
  /** something came down here: the low crash (voxels broken or landing) */
  onCollapse?: (x: number, y: number, z: number, amount: number) => void;
  /** dust where something breaks or a body hits (grains, spread in cells, the material it's made of) */
  onDust?: (x: number, y: number, z: number, count: number, spread: number, mat: number) => void;
  /** stats for the perf overlay / tests */
  /**
   * (round 120, the physics bench's toggles — the user: "You need to toggle systems to measure the diff for an
   * accurate number") the CPU rigid rock not stepped (the bodies frozen where they are, still drawn), the judge not run
   */
  readonly paused = { physics: false, judge: false };
  stats = { passes: 0, bodies: 0, crumbled: 0, settled: 0, crumbledBodies: 0, impacts: 0, shatters: 0, shattered: 0, lastMs: 0, rockSeeds: 0, rereads: 0, settledFalls: 0, settleMs: 0, metal: 0, deferred: 0, judgeMs: 0, judgeGpuMs: 0, readMs: 0, readKB: 0, blows: 0 };
  /** sleeping bodies projected per column: top, bottom (top < 0: none) — the
   *  GPU's bodyProj texture and the bodies' own collision share it */
  readonly proj: Float32Array;
  /** budget for sleeping bodies (DECISIONS round 17) */
  static readonly MAX_SLEEPING = 64;
  static readonly MAX_SLEEP_VOXELS = 16384;

  constructor(
    public core: WorldCore,
    /** (round 95) rock the judge frees falls as rigid bodies (rockbodies.ts rockbodyFor) */
    rockbody = false,
  ) {
    this.cols = new ColumnCopy(
      {
        device: core.host.gpu.device,
        packed: core.packed,
        layers: () => core.world.layers,
        epoch: () => core.windowEpoch,
        readWhole: () => core.readBuffer('layers'),
        // (round 80: a column written under a sleeping chunk wakes it — its surface, its water, its slumping)
        woke: (x, y) => core.sleep?.wake(x + 0.5, (y + 0.5) * ROW_H, 16, 8, performance.now() / 1000),
      },
      'kept',
    );
    this.gpuEdit = core.columnApply;
    this.query = new ColumnQuery(core.host.gpu.device);
    // (round 120: judge B's pipelines made ahead of the first cut)
    void this.judge.warm?.(core.host.gpu.device);
    this.bodies = new Bodies(this.world);
    const N = core.dims.w * core.dims.h;
    this.proj = new Float32Array(N * 4);
    resetProjection(this);
    this.bodies.proj = this.proj;
    // (round 107, pages: the projection mirrors a texture — bodyCpu, a page atlas: column (x, y) at its texel)
    this.bodies.projIdx = (x, y) => core.ring.t(x, y);
    this.bodies.onSleep = () => {
      this.stats.settled++;
      keepBudget(this);
      project(this);
    };
    this.bodies.onWake = () => project(this);
    this.bodies.onImpact = (b, speed, at) => impact(this, b, speed, at);
    if (rockbody) {
      (this as { rigid: RockBodies | null }).rigid = new RockBodies(rockGround(this));
      // (solver step 2, AR4) the GPU node solver moves them: body against body, the contact rules, a fixed step drawn
      // between its last two; the judge here still decides what lets go, breaks it, and takes it back at rest — with
      // the variant's say (?solver=: the baseline keeps the CPU rigid rock, the lattice the voxels)
      const route = ROUTING[this.variant];
      if (route.rock === 'nodes' || route.metal === 'nodes') {
      const solver = new Solver(core.host.gpu.device, core.world, core.host.profiler);
      core.sim.systems.push(solver);
      if (route.rock === 'nodes') this.rigid!.engine = solver;
      (this as { solver: Solver | null }).solver = solver;
      // (its bodies' cells in the columns every column while it holds any: the projection's whole pass)
      core.sim.project.wholeWhile.push(() => solver.used > 0);
      }
      // (round 120) the bodies' own meshes, skinned each frame to the solver's nodes (or a matrix), drawn lit and shadowed
      const bm = new BodyMeshes(core.host.gpu.device, core.world, core.host.profiler);
      (this as { bodyMeshes: BodyMeshes | null }).bodyMeshes = bm;
      core.renderer.addMesh(bm.out, bm.args);
      bm.onBuffers = () => {
        core.renderer.removeMesh(bm.args);
        core.renderer.addMesh(bm.out, bm.args);
      };
      core.renderer.frameCompute.push((enc) => bm.encode(enc, core.renderAlpha()));
      const solver = this.solver;
      if (solver) {
        const nodes = () => {
          core.renderer.setRockNodes({ pose: solver.pose, lanes: solver.lanes });
          bm.setNodes({ pose: solver.pose, lanes: solver.lanes });
        };
        nodes();
        solver.onBuffers = nodes;
      }
      this.rockMesh = core.renderer.enableRockMesh();
      // (round 110: with the rigid rock always, not only `?meshinst=1` — the user: "When things come to rest they turn
      // to dust instead of staying as meshes as we discussed"; DECISIONS round 106: "A settled body stays an object
      // (sleeping, instanced). It is baked into terrain only between runs, or when the object buffer needs room")
      if (this.rockMesh) {
        const ext = new ExternalRegistry({
          read: (x, y) => this.cols.read(x, y),
          write: (x, y, col) => writeColumn(this, x, y, col),
          release: (spans) => edit(this, [{ cuts: [], release: spans }]),
          // (round 128, INT16: a claim is the GPU's stamp too)
          claim: (spans) => edit(this, [{ cuts: [], claim: spans }]),
          // (round 128g: a claim where free, nothing read — the settlements' and the fortress's)
          claimFree: (spans) => edit(this, [{ cuts: [], claimFree: spans }]),
        });
        // (round 110, BACKLOG MI5) one cut or found hanging free wakes, its own mesh as it lay: not ground again
        ext.owner(OWNER_ROCK, { name: 'rock', onLost: (inst, why) => wakeResting(this, inst, why) });
        (this as { external: ExternalRegistry | null }).external = ext;
      }
    }
    this.falling = new ColumnBodies(
      (x, y) => this.cols.read(x, y),
      (x, y, col) => writeColumn(this, x, y, col, true, false),
      (x, y, col) => writeColumn(this, x, y, col, false, true),
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
    const r = await this.judge.judge({ cols: { ...judgeCols(this), vox: w }, seeds, weigh });
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
  watches: { x: number; y: number; r: number; left: number; next: number }[] = [];

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

  /**
   * The top of a fallen body sleeping over column (x, y) (-1: none). (Round 120, JB6: the ground's own top is the
   * surface's — the caller's readback, powers.ts — not this copy's: the CPU holds no copy of the columns everywhere.)
   */
  bodyTopAt(x: number, y: number): number {
    // (round 106: the projection on the window's ring — the window index y * W + x mapped onto it, so a column past
    // the window's edge reads what it did in window order: the row's wrap, or nothing past the ends)
    const w = y * this.core.dims.w + x;
    const W = this.core.dims.w;
    const i = w >= 0 && w < W * this.core.dims.h ? this.core.ring.t(w % W, Math.floor(w / W)) : -1;
    return i < 0 ? -1 : this.proj[i * 4];
  }

  /**
   * (round 92) Before the window slides (Streamer.onBeforeSlide): every piece falling lands now, where it would have
   * — the GPU's columns hold it mid-air at its offset, and a slide freezes them as they are (a region leaving), reads
   * them back to cut them again in z, or moves the land from under the piece while it goes on writing its old
   * columns: rock left hanging in the air with nothing under it (the user's meteor-made floaters, round 92).
   */
  settle(dx = 0, dy = 0, dz = 0): void {
    return settle(this, dx, dy, dz);
  }

  /**
   * (round 92) The window slid by (dx, dy) cells (whole regions, an even number of rows) or dz in z: what's waiting to
   * be judged moves with the land (round 88 kept window cells — the next pass judged where the land had been, and
   * a meteor's rim watched for 15 s was watched somewhere else). Seeds off the window go; the copy is read whole.
   */
  slid(dx: number, dy: number, dz: number): void {
    return slid(this, dx, dy, dz);
  }

  /**
   * (round 108, the playground's station reset) What moves or rests over the columns [x0, x1) × [y0, y1) (storage
   * cells) is let go before the caller writes them again: the rigid rock over them dropped, the resting rock on them
   * forgotten, the pieces falling through them landed at once (written into the columns the caller then writes over),
   * the loose bodies over them gone. Elsewhere nothing changes.
   */
  forget(x0: number, y0: number, x1: number, y1: number): void {
    return forget(this, x0, y0, x1, y1);
  }

  /**
   * (solver step 2, the lab) A body made of these cells (column x, y, cell z — where it starts, out of the ground),
   * dropped by the picked variant (ROUTING): what's mostly metal (or wood, where wood bends) as the metal goes — a
   * deformable on the node solver or the voxel lattice — the rest as the rock goes. Its cells must be air.
   * (round 120, the drop tool: a car or a tanker is mostly steel with asphalt tyres and a rusted tank — the whole
   * model is one body, classed by what most of it is made of)
   */
  dropBody(cells: { x: number; y: number; z: number; mat: number }[], vel: [number, number, number] = [0, 0, 0]): boolean {
    if (!this.rigid || !cells.length) return false;
    const mats = new Map<number, number>();
    for (const c of cells) mats.set(c.mat, (mats.get(c.mat) ?? 0) + 1);
    const most = [...mats].sort((a, b) => b[1] - a[1])[0][0];
    const bent = cells.filter((c) => this.bends(c.mat)).length * 2 > cells.length;
    if (this.route.rock === 'lattice' || (bent && this.route.metal === 'lattice')) return spawnLattice(this, cells, () => false);
    if (bent) {
      if (!this.solver) return false;
      const body = this.solver.add({ cells, vel, kind: 'deformable' });
      if (!body) return false;
      this.metal.push({ body, mesh: meshFor(this, body, cells), mat: this.bends(most) ? most : cells.find((c) => this.bends(c.mat))!.mat });
      this.stats.bodies++;
      return true;
    }
    const b = this.rigid.spawn(cells);
    if (!b) return false;
    b.v = vel;
    b.slot = allocRock(this, cells);
    this.stats.bodies++;
    return true;
  }

  /** (solver step 2, the lab) the metal at this cell (column x, y, cell z) and all it connects to woken (by the variant) */
  wakeMetalAt(x: number, y: number, z: number): void {
    if (this.rigid && this.metalSolver) void wakeMetal(this, [[x, y, z]]);
  }

  /** whether the variant has a body for metal (the node solver, or the voxel lattice) */
  get metalSolver(): boolean {
    return !!(this.route.metal === 'nodes' ? this.solver : this.physics);
  }

  /**
   * (round 120, the user: "Can you modify the tanker physics to use it") The map's metal (its tankers, ruined cars,
   * pylons — world/models.ts, stamped into the columns) within r of world (x, y), at height z (z < 0: any height),
   * woken with all it connects to into the picked variant's body (wakeMetal). True if there was metal there.
   * (Round 120, JB6: the columns round it read where they lie — the copy, or fetched — so the answer comes when they have.)
   */
  wakeMetalNear(x: number, y: number, z: number, r: number): Promise<boolean> {
    return wakeMetalNear(this, x, y, z, r);
  }

  /**
   * (round 120, the drop tool: "make a drop things tool that does") Models (world/models.ts, physics/shapes.ts) dropped
   * side by side round column (cx, cy) — in rows no wider than `wrap` columns, 3 apart — each `above` cells over the
   * highest ground under it, each one body by the picked variant (dropBody). How many went in (one refused: no room).
   */
  dropModels(models: VoxelModel[], cx: number, cy: number, above: number, wrap = Infinity): Promise<number> {
    return dropModels(this, models, cx, cy, above, wrap);
  }

  /**
   * (solver step 2, the lattice variants) Cells (out of the columns already) as a body of the physics voxels — a
   * particle a cell on its lattice, 26 bonds, shape matched (phys.wgsl) — `pinned` ones held. False with no room.
   */
  /** (round 120) the voxel lattice's bodies with rock in them: the rock mesh's slot, skinned to their particles */
  latticeRock: { body: PhysBody; slot: number; lo: [number, number, number]; dims: [number, number, number] }[] = [];
  particlesBound = false;

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
    this.cols.drop();
    this.orphanCheck = true;
    if (reseed)
      for (const b of was)
        for (const c of b.cols) {
          this.rockSeeds.set(c.y * 65536 + c.x, 2);
          this.cutSeeds.set(c.y * 65536 + c.x, 2);
          this.urgent = true;
        }
    project(this);
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
  projected = true;

  /**
   * A body turns into loose ground where it lies: each voxel's volume goes to
   * the column under it, as the loose material its own material breaks down
   * to (concrete, brick, stone, metal → gravel; wood, canvas → ash; bone →
   * dust). Through the deposit buffer (y, z), which the sediment pass folds into the layers.
   */
  crumble(b: Body): void {
    toLoose(this, this.bodies.worldVoxels(b));
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
    chips(this, removed.map((v) => v.p), 1);
    this.onDust?.(at[0], at[1], at[2], Math.min(50, 8 + removed.length * 2), radius, mainMat(removed));
    toLoose(this, crumbs);
    project(this);
    return true;
  }

  /** loose ground waiting to go to the GPU: column (y · W + x) → amount and material votes */
  pendingLoose = new Map<number, { amount: number; mats: Map<number, number> }>();

  update(dt: number): void {
    return update(this, dt);
  }

  /**
   * (round 117, structures; round 120 JB6) Columns readable on the CPU for an owner claiming External cells (the
   * settlements view, src/settle/view.ts): kept, the copy (read once if there's none yet); sparse, the chunks holding
   * these columns fetched. `then` runs in the same task with them readable (the registry's claim reads them); nothing
   * runs if the window slid meanwhile.
   */
  async columnsReady(cols: Iterable<[number, number]>, then: () => void): Promise<void> {
    const chunks = new Set<number>();
    for (const [x, y] of cols) if (x >= 0 && y >= 0 && x < this.core.dims.w && y < this.core.dims.h) chunks.add(this.cols.chunkOf(x, y));
    await withColumns(this, chunks, then);
  }

  /**
   * (round 88) the chunks a piece reached last pass that the copy didn't hold as they are (`needChunks`): read before it's
   * judged again — one falling from columns the copy last saw seconds ago would write them back as they were
   */
  needChunks = new Set<number>();
  /** bytes of the columns read back so far (scripts and the battery read it) */
  get readBytes(): number {
    return this.cols.readBytes;
  }

  /**
   * (round 95) This frame's draws of the rigid rock's mesh: each body with a slot, those come to rest a few frames on,
   * the ghosts of those just broken (their pieces' own meshes not drawn till the ghost goes).
   */
  /** (round 120) this frame's draw path of each moving rock by its id (rockDraws) */
  readonly drawPaths = new Map<number, 'skin' | 'matrix' | 'split-skin' | 'split-matrix' | 'mesh' | 'cubes' | 'none'>();

  /**
   * (solver step 2: the design's "energy goes to particles") A metal or wood body on the node solver that hit something
   * this tick: its blow's energy (½ m v²) as sparks and chips where it struck, and the sound; a small knock nothing.
   */
  metalTick = new Map<SolverBody, number>();

  /** (round 100) nothing falling (no piece, no rigid rock in the air): the streamer may save the window as it is */
  get quiet(): boolean {
    return !this.falling.list.length && !this.rigid?.list.length;
  }

  /**
   * (round 100, meshinst) The resting rock as a region's things (Streamer.things): taken with a region frozen — out
   * of the registry and its mesh let go, its cells left External in the columns — and given back when the region is
   * written again: registered, its mesh made from its cells, at its transform.
   */
  regionThings(): { name: string; take(x0: number, y0: number, x1: number, y1: number, keep?: boolean): import('../world/region-record').ThingRecord[]; give(things: import('../world/region-record').ThingRecord[], x0: number, y0: number): void } {
    return regionThings(this);
  }

  /** (round 99) the resting rock (meshinst): instances, their cells, for the tests */
  get restingCount(): number {
    return this.resting.size;
  }

  /**
   * (round 120, the user: "the tower toppling does not wake up the tanker on top of it so the tanker floats until
   * touched") The voxel lattice's sleepers (physics.ts: they wake for what moves among its own bodies, and cuts) woken
   * by what moves on the other solvers too — a rigid rock or a node-solver body going by or out from under one.
   */
  /**
   * (round 120, the user: "dropping the tanker in a stone does not trigger breaking and it probably should"; "when bodies
   * hit the ground with heavy impacts in soft material like sand or dirt they should displace material and dampen
   * energy that way … I really want it to push into the ground a bit") A body struck the ground at world (x, y) (z: where,
   * for its dust) with this energy (½mv²), its footprint `reach` cells round. Round 120, JB6: a blow event to the edit
   * pass (edit.wgsl, OP.SMASH with BLOW_TAG), which decides on the columns as the GPU has them — no CPU copy: loose
   * ground sinks under it ("erode, don't push": the footprint dug out deepest in the middle, a share sprayed, the rest a
   * rim round the dent), hard ground struck past impact.groundEnergy crumbles where it was struck (the break tool's smash,
   * a ball of 0.8·∛(E / groundEnergy), at most 3). The collapse judge looks at what that leaves. (The body's own share:
   * rock breaks on its hits, metal and wood dent: solver.wgsl.)
   */
  groundBlow(x: number, y: number, z: number, energy: number, reach = 1.5): void {
    if (!(energy > 0)) return;
    // (what it lands on asleep: woken, so the edit pass sees it)
    this.core.sleep?.wake(x, y, reach + 6, 4, performance.now() / 1000);
    // (a smash is a cut: the event tap marks it for the judge — two looks — as any smash; a sink judges nothing much)
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.SMASH * 32 + BLOW_TAG, radius: reach + 3, strength: energy });
    // (the spray, the ground's own stuff — what was struck the particles look up)
    this.onDust?.(x, y, z + 0.3, Math.min(80, Math.round(8 + Math.cbrt(energy) * 0.4)), reach + 0.5, GROUND_DUST);
    this.stats.blows++;
  }

  /**
   * (round 120, the user: "Consider a telekinetic drag tool to test swinging tankers and rocks into things") The body
   * nearest world (x, y, z) within `r` of it (and its own size) — a rigid rock, a node-solver body (metal, wood), a
   * voxel-lattice body — to be pulled (pull). Null: none near.
   */
  grabAt(x: number, y: number, z: number, r: number): Grab | null {
    let best: Grab | null = null;
    let bd = Infinity;
    const consider = (g: Grab, p: V3, size: number) => {
      const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z) - size;
      if (d < r && d < bd) [best, bd] = [g, d];
    };
    for (const b of this.rigid?.list ?? []) consider({ kind: 'rigid', b }, b.pos, b.radius);
    if (this.solver)
      for (const mb of this.metal) {
        const rd = this.solver.read(mb.body);
        if (rd) consider({ kind: 'solver', body: mb.body }, rd.pos, Math.cbrt(mb.body.cells));
      }
    if (this.physics)
      for (const body of this.physics.bodies) {
        const st = this.physics.state(body);
        if (st && st.alive > 0) consider({ kind: 'phys', body }, st.pos, 0.5 * Math.hypot(...body.dims) * body.size);
      }
    return best;
  }

  /** where a grabbed body is and how it moves (null: it's gone) */
  grabState(g: Grab): { pos: V3; vel: V3 } | null {
    if (g.kind === 'rigid') return this.rigid?.list.includes(g.b) ? { pos: g.b.pos, vel: g.b.v } : null;
    if (g.kind === 'solver') {
      const r = this.solver?.bodies.has(g.body) ? this.solver.read(g.body) : undefined;
      return r ? { pos: r.pos, vel: r.vel } : null;
    }
    const st = this.physics?.state(g.body);
    return st && st.alive > 0 ? { pos: st.pos, vel: st.vel } : null;
  }

  /**
   * Pull a grabbed body toward `target` (world) for dt s: a damped spring on its centre (it swings, overshoots a little,
   * and carries its speed into what it hits — the hit goes through the same rules: breaks, dents, the ground giving),
   * its weight held up. False: it's gone.
   */
  pull(g: Grab, target: V3, dt: number, k = 40): boolean {
    const s = this.grabState(g);
    if (!s) return false;
    const c = 2 * Math.sqrt(k) * 0.6;
    const dv: V3 = [0, 1, 2].map((a) => (k * (target[a] - s.pos[a]) - c * s.vel[a]) * dt) as V3;
    dv[2] += worldG() * dt;
    if (g.kind === 'rigid') {
      const sb = this.rigid!.engineBody(g.b);
      if (sb && this.solver) {
        this.solver.wake(sb);
        this.solver.impulse(sb, dv);
      } else g.b.v = [g.b.v[0] + dv[0], g.b.v[1] + dv[1], g.b.v[2] + dv[2]];
      // (held, it isn't at rest however still it hangs)
      g.b.still = 0;
    } else if (g.kind === 'solver') {
      this.solver!.wake(g.body);
      this.solver!.impulse(g.body, dv);
    } else this.physics!.impulse(g.body, dv);
    return true;
  }

  /**
   * (round 120: the hybrid's tanker, on the voxel lattice, dropped on stone broke nothing) The lattice's bodies' hits:
   * a body falling that stopped short this tick (its speed down by more than 2.5 cells/s, from going down) struck what's
   * under it — its blow's energy (½ m Δv², m its voxels × 4) to the ground there (groundBlow).
   */
  latticeLast = new Map<number, { v: V3; tick: number }>();

  /** (round 120) the rock meshes made (moving and resting): those no body holds any more let go (syncRockMeshes) */
  rockMeshIds = new Set<number>();

  /**
   * (round 110) Every resting rock baked into the ground (the explicit request: between runs) — each behind its dust.
   */
  bakeResting(): number {
    const ext = this.external;
    if (!ext) return 0;
    let n = 0;
    for (const inst of [...ext.instances]) {
      if (inst.owner !== OWNER_ROCK) continue;
      unrest(this, inst, 'asked');
      n++;
    }
    return n;
  }

  /**
   * (round 120, JB6) Whether the CPU keeps its whole copy of the columns: only where a CPU consumer walks it — judge A
   * (runs: fracture.ts analyseRock), the CPU rigid rock's ground (the variants whose rock isn't on the voxel lattice:
   * rockbodies.ts columnsGround, RockBodies' spawn and fast-forward), the pieces falling in the columns (a level without
   * the rigid rock, or the old variant's structures: colbodies.ts). `?jb6=0` (measuring only) keeps it everywhere.
   */
  get keepsCopy(): boolean {
    return JB6_KEEP || this.judge.id === 'runs' || !this.rigid || this.route.rock !== 'lattice' || this.route.structures === 'columns';
  }

}
