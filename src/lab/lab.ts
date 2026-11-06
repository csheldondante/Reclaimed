// (round 128l, tooling) The behaviour lab: ?level=lab&lab=<recipe> — the game with less world, for scripted behaviour
// checks (docs/TOOLING.md). A fixed 256² window of a recipe's land (lab/recipes.ts: no atlas, no generation, a short
// warmup), the real fortress on it (scenes/level.ts startFortress on the lab's town and still window: fortress/host.ts),
// its builders the real FortressCrowd on the real agents, its pieces drawn by the structures draw (lab/view.ts). What
// a scenario drives, in the page as `reclaimed.lab`:
//   place(kind, x, y, {level, built})   one block (a structure type, or 'gate' on a wall cell), window world units
//   plan({at, walls, blocks, built})    a whole plan at once (built: standing at once, or planned for the builders)
//   drag(kind, x0, y0, x1, y1)          the cells along a line placed together (Fortress.paintMany: judged as one)
//   build() / planMode()                the bar's Build and Plan (the game's own buttons)
//   run(seconds, speed, {renderEvery})  the sim advanced `seconds` of sim time as fast as the GPU goes: the display's
//                                       frames wait, the lab steps the scene itself, drawing every Nth frame
//   snapshot()                          the walkers (where, doing what, on a road or not), jobs, stores, progress,
//                                       structures, roads ridden — JSON
//   look(x, y, zoom) / shot(name)       the camera; a screenshot (the runner's: scripts/lab.mjs saves it)
//   reset()                             the plan erased, the builders gone, the land as it opened, the stores refilled:
//                                       a new scenario on the same page without a reload
import type { UnitId, V2 } from '../api/contracts/units';
import type { StructureType } from '../api/contracts/fortress';
import { STRUCTURE_TYPES } from '../api/contracts/fortress';
import type { WorldCore } from '../scenes/world-core';
import type { Fortress } from '../fortress/fortress';
import type { FortressCrowd } from '../fortress/crowd';
import type { FortressFollow } from '../fortress/follow';
import type { FortressWindow, TownViewHost } from '../fortress/host';
import type { AgentUnits } from '../units/agent-units';
import { START_STORES } from '../fortress/defs';
import { roadInside, ROAD_SHAPE_FLOATS } from '../agents/roads';
import { Renderer } from '../render/renderer';
import { labRecipe, type LabRecipe, type LabTownSpec } from './recipes';
import { LabTown, stillWindow } from './town';
import { LabTownView } from './view';
import type { ExternalRegistry } from '../sim/external';
import type { StaticClaims } from '../sim/static-claims';
import { siteFromJson } from '../build/site';
import type { FortressRaid } from '../fortress/raiders';
import type { TownFixtureHeader } from './townfixture';
import { cellAt, ROW_H } from '../world/lattice';
import { edgeNetOf } from '../build/edgenet';
import { layoutTownRoads, type TownRoads } from '../build/townroads';
import { typeIndex } from '../build/plan';
import { DEEP } from '../agents/rules';

/** what the lab needs of the scene (scenes/level.ts startLab) */
export interface LabSceneIO {
  core: WorldCore;
  units: AgentUnits;
  device: GPUDevice;
  params: URLSearchParams;
  /** the scene's startFortress on the lab's town, its view host and window */
  startFortress(town: LabTown, view: TownViewHost, win: FortressWindow): void;
  /** (onetown) the External registry and the static grids' claims (the town's claims: build/claims.ts) */
  external(): ExternalRegistry | null;
  statics(win: FortressWindow): StaticClaims | null;
  fortress(): Fortress | undefined;
  life(): FortressCrowd | undefined;
  /** (round 128l, m4) the attack wave (fortress/raiders.ts), from the first Build */
  raid(): FortressRaid | undefined;
  /** the builders let go (FortressCrowd.dispose), so the next Build starts afresh */
  dropLife(): void;
  /** the sim's speed (0: time stopped), read or set */
  speed(n?: number): number;
  /** one frame of the scene, driven by the lab (the display's frames return at once while `driving`) */
  frame(now: number, dt: number): void;
  /** the land put back as the level opened (WorldCore.restoreChunks over the window); (round 128m) resolves once the
   *  world API's mirror has read it (a quarry measured its pit on the last run's ground) */
  restoreLand(): void | Promise<void>;
  /** (round 128l, m4) a tap on the map at screen (x, y), as a finger's (the level's fortressAt) */
  tap(sx: number, sy: number): void;
  /** (m4) the person a tap picked and the follow (fortress/follow.ts) */
  follow(): FortressFollow | undefined;
  /** (round 128m, townlab) the recipe's fixture's header, when its land was loaded from one (lab/townfixture.ts) */
  fixture?: TownFixtureHeader;
}

/** a whole plan at once (lab.plan; a recipe's `town`) */
export interface LabPlan extends LabTownSpec {
  /** where its offsets are from (world units; default the heap) */
  at?: V2;
  /** blocks at absolute positions (world units) */
  cells?: { type: StructureType; at: V2; level?: number }[];
  /** standing at once (true) or planned for the builders (false, the default) */
  built?: boolean;
}

export interface LabSnapshot {
  recipe: string;
  /** sim seconds the lab has run since it opened or was reset */
  simT: number;
  mode: string;
  speed: number;
  sims: string;
  progress: { built: number; total: number };
  stores: Record<string, number>;
  people: number;
  jobs: Record<string, number>;
  walkers: { id: UnitId; at: [number, number, number]; state: string; phase: string; job: string | null; onRoad: boolean }[];
  /** (round 128l, m4) the soldiers the barracks trained */
  soldiers: { id: UnitId; at: [number, number, number]; state: string; phase: string; onRoad: boolean }[];
  /** (m4) the carts, and the goods waiting on each structure's pile for one */
  carts: { id: UnitId; at: [number, number, number]; state: string; phase: string; pile: number | null; onRoad: boolean }[];
  piles: Record<string, number>;
  /** of the walkers walking now: how many are on a road or lane, and the roads' share of the ground round them */
  roads: { shapes: number; walking: number; onRoad: number; areaShare: number | null; riding: unknown };
  structures: { id: number; type: string; cells: number; built: number; planned: number }[];
  cutOff: number;
  note: string | null;
  refusal: string | null;
  stats: Record<string, number> | null;
  /** (round 128m, quarry) each quarry's pit: the tiers the plan lays, the tier being dug and the cut into it (m) */
  pits: { id: number; tiers: number; tier: number; cut: number }[];
}

const DT = 1 / 60;

/**
 * lab.sims presets: which of the sim's systems tick (sim/simulation.ts; the rest wait). 'all' is the game. 'fortress'
 * leaves out the land's slow processes the fortress's checks don't read — oil, contamination, moisture, fire, sediment,
 * climate, cover, wilt, ecology, lava, sway, wind, particles, stats — and keeps the edits, the column stamps and
 * claims, water, the structure judge, the surfaces, the agents and the render fields: about twice the sim seconds a
 * wall second. A check that might depend on a left-out process runs with 'all'.
 */
export const LAB_SIMS: Record<string, readonly string[] | null> = {
  all: null,
  fortress: ['edit', 'layerpull', 'landbrush', 'townstamp', 'placeop', 'project', 'structure', 'surface', 'water', 'physics', 'traits', 'agents', 'structtick', 'renderfields'],
  // (round 128l, m4: the attack wave) the fortress's, and the fire and the particles: houses burn, chips and dust fly
  raid: ['edit', 'layerpull', 'landbrush', 'townstamp', 'placeop', 'project', 'structure', 'surface', 'water', 'physics', 'traits', 'agents', 'structtick', 'renderfields', 'fire', 'particles'],
};

export class Lab {
  readonly recipe: LabRecipe;
  readonly town: LabTown;
  readonly view: LabTownView;
  readonly window: FortressWindow;
  /** the lab steps the scene (lab.run): the display's frames wait */
  driving = false;
  /** the fortress is ready and the recipe's town stands */
  ready = false;
  private simT = 0;
  /** (onetown) reset() puts the recipe's town back — not a fixture's: its town is the captured site's data */
  get resettable(): boolean {
    return !this.recipe.fixture;
  }
  /** the sim's systems that tick (null: all — lab.sims) */
  simFilter: ((s: { name: string }) => boolean) | undefined = undefined;
  private simsNow = 'all';
  readonly api: ReturnType<Lab['makeApi']>;

  constructor(private io: LabSceneIO) {
    this.recipe = labRecipe(io.params.get('lab'));
    const fx = io.fixture;
    if (this.recipe.fixture && !fx) throw new Error(`lab recipe ${this.recipe.name}: its fixture wasn't loaded`);
    // (onetown: a fixture's town is the start town's site as the game had it; a recipe's an empty plan round the heap)
    if (fx && !fx.site) throw new Error(`lab recipe ${this.recipe.name}: its fixture has no town site (captured before onetown: capture it again — scripts/labtown.mjs capture)`);
    this.town = fx ? LabTown.of(fx.town, siteFromJson(fx.site)) : LabTown.plain(this.recipe.heap, this.recipe.homes, (x, y) => this.recipe.ground(x, y));
    this.window = fx ? stillWindow(io.core.dims, fx.origin, fx.oz! + fx.zBase) : stillWindow(io.core.dims);
    // (a fixture's sea, at its level as the game had it: past the window's edge the world is sea, so it doesn't drain)
    if (fx) {
      io.core.globals.seaZ = fx.seaZ;
    }
    this.view = new LabTownView({ device: io.device, renderer: io.core.renderer, external: () => io.external(), statics: () => io.statics(this.window) }, this.town.site, this.window);
    io.startFortress(this.town, this.view, this.window);
    // (what reset puts back: the land as it opened)
    io.core.keepPristine();
    this.api = this.makeApi();
    void this.whenReady();
  }

  /** the ground's top at window world (x, y): the recipe's, or a fixture's columns as loaded */
  ground(x: number, y: number): number {
    if (!this.io.fixture) return this.recipe.ground(x, y);
    const { w, h } = this.io.core.dims;
    const cx = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(h - 1, Math.floor(y / ROW_H)));
    return this.io.core.map.surface[cy * w + cx];
  }

  /** each frame of the scene: the fortress's pieces */
  frame(): void {
    this.view.update();
  }

  private fort(): Fortress {
    const f = this.io.fortress();
    if (!f) throw new Error('lab: no fortress');
    return f;
  }

  /** the fortress ready (the ground read back), then the recipe's town standing */
  private async whenReady(): Promise<void> {
    const f = this.fort();
    while (!f.ready || !f.reachKnown) await new Promise((r) => setTimeout(r, 50));
    if (this.recipe.town) this.plan({ ...this.recipe.town, built: true });
    this.ready = true;
  }

  // ---- (round 128p, DA-A13 step 1) the paths on the grid's edges

  async edges(
    o: {
      spokes?: number;
      spokeAngle?: number;
      off?: boolean;
      /** (step 2) the hybrid: the radial relax, curve spokes, roads drawn (window points), structures placed first */
      hybrid?: boolean;
      radial?: number;
      drawn?: V2[][];
      place?: { type: StructureType; at: V2 }[];
      far?: number;
    } = {},
  ): Promise<unknown> {
    const site = this.town.site;
    if (o.off) {
      this.view.edges = null;
      this.view.redraw(site.id);
      return null;
    }
    const { box } = site;
    const [ox, oy] = this.window.origin;
    const W = this.io.core.dims.w;
    // (the water as it is now: the lab's rivers and sea settle after the fixture's capture — one read, an edit's)
    const live = await this.io.core.readBuffer('water');
    const map = { water: live };
    const wet = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      const col = (r + box.y0 - oy) * W + (k + box.x0 - ox);
      return col >= 0 && col < map.water.length && map.water[col] > DEEP;
    };
    // (any water: a road under it is a bridge)
    const water = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      const col = (r + box.y0 - oy) * W + (k + box.x0 - ox);
      return col >= 0 && col < map.water.length && map.water[col] > 0;
    };
    const toBox = (q: readonly number[]): V2 => [q[0] - (box.x0 - ox), q[1] - (box.y0 - oy) * ROW_H];
    const centre = toBox(this.town.rec.at);
    let hybrid: TownRoads | null = null;
    for (const p of o.place ?? []) {
      const c = site.grid.cellAtWorld(...toBox(p.at));
      if (c < 0 || site.plan.structureAt(c)) throw new Error(`lab.edges: no free cell at ${p.at}`);
      const s = site.plan.place(p.type, [[c, 0]]);
      if (!s) throw new Error(`lab.edges: ${p.type} refused at ${p.at}`);
      site.town.add(c, 0, s.id, typeIndex(p.type));
    }
    if (o.hybrid) {
      let R = 0;
      for (const st of site.plan.structures())
        for (const c of st.cells.keys()) R = Math.max(R, Math.hypot(site.grid.centre(c)[0] - centre[0], site.grid.centre(c)[1] - centre[1]));
      hybrid = layoutTownRoads(site, {
        ground: (x, y) => site.groundAt(x, y),
        wet,
        water,
        centre,
        stores: toBox(this.town.heap),
        radial: o.radial === 0 ? undefined : { radius: o.radial ?? R + 20, iters: 12 },
        spokes: o.spokes ?? 4,
        spokeAngle: o.spokeAngle ?? 0.4,
        drawn: (o.drawn ?? []).map((d) => d.map(toBox)),
        far: o.far ?? 4,
      });
    }
    const net = hybrid ? hybrid.net : edgeNetOf(
      { plan: site.plan, grid: site.grid, floor: (c) => site.town.base[c] },
      {
        ground: (x, y) => site.groundAt(x, y),
        wet,
        centre,
        stores: toBox(this.town.heap),
        spokes: o.spokes ?? 5,
        spokeAngle: o.spokeAngle ?? 0.4,
        roadsOut: site.plan.layout.linear.filter((f) => f.kind === 'road').map((f) => f.points.map((q) => [q[0], q[1]] as V2)),
      },
    );
    this.view.edges = net;
    this.view.wet = water;
    if (hybrid) this.view.changed(site.id);
    else this.view.redraw(site.id);
    const win = (q: V2): V2 => [q[0] + (box.x0 - ox), q[1] + (box.y0 - oy) * ROW_H];
    const why: Record<string, number> = {};
    for (const x of net.reach.out) why[x.why] = (why[x.why] ?? 0) + 1;
    // (where to look: drawn edges' middles, nearest the stores first)
    const g = site.grid;
    const mids: { at: V2; d: number; kind: number }[] = [];
    for (let e = 0; e < net.kind.length; e++) {
      if (!net.kind[e]) continue;
      const a = net.ends[e * 2];
      const b = net.ends[e * 2 + 1];
      const m: V2 = [(g.verts[a * 2] + g.verts[b * 2]) / 2, (g.verts[a * 2 + 1] + g.verts[b * 2 + 1]) / 2];
      const st = toBox(this.town.heap);
      mids.push({ at: win(m), d: Math.hypot(m[0] - st[0], m[1] - st[1]), kind: net.kind[e] });
    }
    mids.sort((a, b) => a.d - b.d);
    const hy = hybrid && {
      curves: hybrid.curves.map((c) => ({ kind: c.kind, from: win(c.pts[0]), to: win(c.pts[c.pts.length - 1]), n: c.pts.length, water: c.pts.filter((q) => water(q[0], q[1])).length })),
      clipped: hybrid.clipped.length,
      removed: hybrid.removed.length,
      gates: hybrid.gates,
      terraces: hybrid.terraces,
      roadCells: net.roads.size,
      bridges: site.plan.layout.linear.filter((f) => f.of === 'mainroad').map((f) => win([f.points[Math.floor(f.points.length / 2)][0], f.points[Math.floor(f.points.length / 2)][1]])),
      ms: hybrid.ms,
    };
    return { ...net.reach, hybrid: hy, ms: +net.reach.ms.toFixed(1), out: net.reach.out.map((x) => `${x.type}:${x.why}`), outByWhy: why, centre: win(centre), pathsAt: mids.filter((_, i) => i % 15 === 0).slice(0, 8) };
  }

  // ---- placing

  place(kind: StructureType | 'gate', x: number, y: number, o: { level?: number; built?: boolean } = {}): number {
    const f = this.fort();
    const c = f.cellAt(x, y);
    if (c < 0) throw new Error(`lab.place: (${x.toFixed(1)}, ${y.toFixed(1)}) is off the fortress's box`);
    if (kind === 'gate') {
      if (!f.setGate(c, true)) throw new Error(`lab.place: no gate at cell ${c} (${f.refusal ?? 'not a wall cell'})`);
      return c;
    }
    if (!STRUCTURE_TYPES.includes(kind)) throw new Error(`lab.place: "${kind}" is not a structure type (${STRUCTURE_TYPES.join(', ')}, gate)`);
    const level = o.level ?? 0;
    if (!f.paint(c, level, kind)) throw new Error(`lab.place: ${kind} at cell ${c} level ${level} refused: ${f.refusal ?? 'no reason given'}`);
    if (o.built) this.standAll();
    return c;
  }

  /**
   * (RT-6) a drag: the cells along the line from (x0, y0) to (x1, y1), window world units, placed together
   * (Fortress.paintMany) — the reach judges them as one, refusing only those out of reach. The cells, in order.
   */
  drag(kind: StructureType, x0: number, y0: number, x1: number, y1: number): number[] {
    const f = this.fort();
    const cells: number[] = [];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= n; i++) {
      const c = f.cellAt(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
      if (c >= 0 && !cells.includes(c)) cells.push(c);
    }
    f.paintMany(cells, 0, kind);
    return cells;
  }

  /** a whole plan at once: walls round `at` with a gate, blocks by offset or position; built at once when asked */
  plan(p: LabPlan): { cells: number; types: string[]; cutOff: number; skipped: string[] } {
    const f = this.fort();
    const [cx, cy] = p.at ?? this.town.heap;
    if (p.walls) {
      const ring = f.ringCells(cx, cy, p.walls.r);
      for (const c of ring) f.paint(c, 0, 'wall');
      const dir: Record<string, V2> = { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] };
      const [ux, uy] = dir[p.walls.gate];
      const along = (c: number) => (f.centre(c)[0] - cx) * ux + (f.centre(c)[1] - cy) * uy;
      if (![...ring].sort((a, b) => along(b) - along(a)).find((c) => f.setGate(c, true))) throw new Error(`lab.plan: no gate on the ${p.walls.gate} side`);
    }
    const skipped: string[] = [];
    const blocks = [...(p.blocks ?? []).map((b) => ({ type: b.type, at: [cx + b.d[0], cy + b.d[1]] as V2, level: b.level ?? 0 })), ...(p.cells ?? []).map((b) => ({ ...b, level: b.level ?? 0 }))];
    for (const b of blocks.sort((a, q) => a.level - q.level)) {
      const c = f.cellAt(b.at[0], b.at[1]);
      if (c < 0) throw new Error(`lab.plan: ${b.type} at (${b.at[0].toFixed(1)}, ${b.at[1].toFixed(1)}) is off the box`);
      // (two offsets in one cell: planned once; a cell another structure holds — a wall cell the ring took — skipped)
      if (f.plan.typeAt(c) === b.type && f.plan.has(c, b.level)) continue;
      const held = f.plan.typeAt(c);
      if (held !== null && held !== b.type) {
        skipped.push(`${b.type} at cell ${c} (a ${held} cell)`);
        continue;
      }
      if (!f.paint(c, b.level, b.type)) throw new Error(`lab.plan: ${b.type} at cell ${c} level ${b.level} refused: ${f.refusal ?? 'no reason given'}`);
    }
    if (p.built) this.standAll();
    const structures = f.plan.structures();
    return { cells: structures.reduce((n, s) => n + s.cells.size, 0), types: [...new Set(structures.map((s) => s.type))], cutOff: f.ways().cutOff.length, skipped };
  }

  /** every planned block standing (bottom up: a block on one not yet standing waits a pass) */
  private standAll(): void {
    const f = this.fort();
    for (let pass = 0; pass < 8; pass++) {
      let left = 0;
      for (const s of f.plan.structures())
        for (const c of s.cells.keys())
          for (const l of [...f.plan.levels.each(c)])
            if (!f.town.has(c, l))
              try {
                f.markBuilt(c, l);
              } catch {
                left++;
              }
      if (!left) return;
    }
  }

  /** the stores set (the town's record: what the fortress reads) */
  stores(set: Record<string, number>): Record<string, number> {
    for (const [k, v] of Object.entries(set)) (this.town.rec.stores[k] ??= { stock: 0, rate: 0 }).stock = v;
    return this.fort().stores() as Record<string, number>;
  }

  // ---- the bar

  private go(): void {
    const b = document.querySelector<HTMLButtonElement>('.fort-bar button.go');
    if (!b) throw new Error('lab: no Build/Plan button on the bar');
    b.click();
  }
  build(): void {
    if (this.fort().mode === 'plan') this.go();
  }
  planMode(): void {
    if (this.fort().mode === 'build') this.go();
  }

  // ---- time

  /**
   * `seconds` of sim time at `speed` (the game's speeds: 1 … 32), as fast as the GPU goes: the lab steps the scene a
   * frame (1/60 s of wall time at that speed) after another, each once the GPU has done the last, drawing every
   * `renderEvery`th. Time stops after (speed 0) unless `keep`: a snapshot or a shot then sees the same moment.
   * `dt` (default 1/60: every tick runs) is the frame's wall time: 0.1 is the game's longest frame — the fortress's
   * people and the units step 0.1 × speed while the world's ticks are capped at the tier's maxTicksPerFrame × speed,
   * as on a loaded phone at 16x: about three times the sim seconds a wall second, and less like a smooth 60 fps.
   */
  async run(seconds: number, speed = 16, o: { renderEvery?: number; keep?: boolean; dt?: number } = {}): Promise<{ simSeconds: number; frames: number; wallMs: number; xRealtime: number }> {
    if (this.driving) throw new Error('lab.run: already running');
    if (!(speed > 0 && speed <= 64)) throw new Error('lab.run: speed must be in (0, 64]');
    const every = Math.max(1, Math.round(o.renderEvery ?? 8));
    const dt = o.dt ?? DT;
    if (!(dt > 0 && dt <= 0.1)) throw new Error('lab.run: dt must be in (0, 0.1] (main.ts caps a frame at 0.1 s)');
    const skipped = Renderer.skip.has('render');
    const t0 = performance.now();
    let sim = 0;
    let frames = 0;
    this.driving = true;
    const before = this.io.speed();
    this.io.speed(speed);
    try {
      while (sim < seconds - 1e-6) {
        if (!skipped) {
          if (frames % every === 0) Renderer.skip.delete('render');
          else Renderer.skip.add('render');
        }
        this.io.frame(performance.now(), dt);
        sim += dt * speed;
        frames++;
        await this.io.device.queue.onSubmittedWorkDone();
        if (document.querySelector('.fatal')) throw new Error('lab.run: the fatal overlay came up');
      }
    } finally {
      if (!skipped) Renderer.skip.delete('render');
      this.io.speed(o.keep ? before : 0);
      this.driving = false;
    }
    this.simT += sim;
    const wallMs = performance.now() - t0;
    return { simSeconds: +sim.toFixed(2), frames, wallMs: Math.round(wallMs), xRealtime: +(sim / (wallMs / 1000)).toFixed(1) };
  }

  /** which of the sim's systems tick: a preset (LAB_SIMS: 'all', 'fortress') or the systems' names */
  sims(which: string | string[] = 'all'): string {
    const list = Array.isArray(which) ? which : LAB_SIMS[which];
    if (list === undefined) throw new Error(`lab.sims: no preset "${which}" (${Object.keys(LAB_SIMS).join(', ')}, or a list of names)`);
    const known = new Set(this.io.core.sim.systems.map((s) => s.name));
    for (const n of list ?? []) if (!known.has(n)) throw new Error(`lab.sims: no system "${n}" (${[...known].join(', ')})`);
    const keep = list ? new Set(list) : null;
    this.simFilter = keep ? (s) => keep.has(s.name) : undefined;
    this.simsNow = Array.isArray(which) ? which.join(',') : which;
    return this.simsNow;
  }

  // ---- looking

  look(x: number, y: number, zoom?: number): void {
    const cam = this.io.core.camera;
    cam.target[0] = x;
    cam.target[1] = y;
    cam.target[2] = this.ground(x, y);
    if (zoom) cam.zoom = zoom;
  }

  /** a screenshot (the runner's `__labShot`: scripts/lab.mjs saves it as <name>.png), after two drawn frames */
  async shot(name: string): Promise<string | null> {
    if (this.driving) throw new Error('lab.shot: not while running');
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frames();
    await this.io.device.queue.onSubmittedWorkDone();
    const hook = (window as unknown as { __labShot?: (n: string) => Promise<string> }).__labShot;
    return hook ? hook(name) : null;
  }

  // ---- reading

  snapshot(): LabSnapshot {
    const f = this.fort();
    const life = this.io.life();
    const units = this.io.units;
    const S = f.roadShapes();
    const n = S.length / ROAD_SHAPE_FLOATS;
    const onRoad = (x: number, y: number) => {
      const [bx, by] = f.toBox(x, y);
      for (let i = 0; i < n; i++) if (roadInside(S, i, bx, by) >= 0) return true;
      return false;
    };
    const walkers: LabSnapshot['walkers'] = [];
    for (const id of life?.people() ?? []) {
      const u = units.get(id);
      if (!u) continue;
      walkers.push({ id, at: [+u.at[0].toFixed(1), +u.at[1].toFixed(1), +u.at[2].toFixed(1)], state: u.state, phase: life?.life.phaseOf(id) ?? '-', job: life?.life.jobOf(id) ?? null, onRoad: onRoad(u.at[0], u.at[1]) });
    }
    // (round 128l, m4) the soldiers: where, doing what (their routine's phase, or 'patrol' on the wall-walk)
    const soldiers: LabSnapshot['soldiers'] = [];
    for (const id of life?.soldiers ?? []) {
      const u = units.get(id);
      if (!u) continue;
      soldiers.push({ id, at: [+u.at[0].toFixed(1), +u.at[1].toFixed(1), +u.at[2].toFixed(1)], state: u.state, phase: life?.life.phaseOf(id) ?? '-', onRoad: onRoad(u.at[0], u.at[1]) });
    }
    const carts: LabSnapshot['carts'] = [];
    for (const id of life?.carts ?? []) {
      const u = units.get(id);
      if (!u) continue;
      carts.push({ id, at: [+u.at[0].toFixed(1), +u.at[1].toFixed(1), +u.at[2].toFixed(1)], state: u.state, phase: life?.life.phaseOf(id) ?? '-', pile: life?.pileOf(id) ?? null, onRoad: onRoad(u.at[0], u.at[1]) });
    }
    const piles = Object.fromEntries([...(life?.piles ?? new Map())].map(([k, g]) => [k, Object.values(g as Record<string, number>).reduce((a, b) => a + b, 0)]));
    const walking = walkers.filter((w) => w.state === 'walk');
    // (the roads' share of the ground round the walkers: the box round them, 4 m out)
    let areaShare: number | null = null;
    if (walking.length) {
      const xs = walking.map((w) => w.at[0]);
      const ys = walking.map((w) => w.at[1]);
      let a = 0;
      let k = 0;
      for (let x = Math.min(...xs) - 4; x <= Math.max(...xs) + 4; x += 1.5)
        for (let y = Math.min(...ys) - 4; y <= Math.max(...ys) + 4; y += 1.5) {
          k++;
          if (onRoad(x, y)) a++;
        }
      areaShare = +(a / k).toFixed(3);
    }
    const structures = f.plan.structures().map((s) => {
      let planned = 0;
      let built = 0;
      for (const c of s.cells.keys())
        for (const l of f.plan.levels.each(c)) {
          planned++;
          if (f.town.has(c, l)) built++;
        }
      return { id: s.id, type: s.type, cells: s.cells.size, built, planned };
    });
    return {
      recipe: this.recipe.name,
      simT: +this.simT.toFixed(2),
      mode: f.mode,
      speed: this.io.speed(),
      sims: this.simsNow,
      progress: f.progress(),
      stores: f.stores() as Record<string, number>,
      people: f.status.people,
      jobs: { ...f.status.jobs } as Record<string, number>,
      walkers,
      soldiers,
      carts,
      piles,
      roads: { shapes: n, walking: walking.length, onRoad: walking.filter((w) => w.onRoad).length, areaShare, riding: life?.riding ?? null },
      structures,
      cutOff: f.cutOff,
      note: f.note,
      refusal: f.refusal,
      stats: life ? { ...life.stats } : null,
      pits: f.plan.structures().filter((s) => s.type === 'quarry').map((s) => {
        const d = life?.quarry.stateOf(s.id);
        return { id: s.id, tiers: f.plan.pitOf(s.id)?.tiers ?? 0, tier: d?.tier ?? 0, cut: d?.cut ?? 0 };
      }),
    };
  }

  // ---- again

  /** a new scenario on the same page: the builders gone, the plan erased, the land as it opened, the stores refilled */
  async reset(): Promise<void> {
    if (this.driving) throw new Error('lab.reset: not while running');
    // (onetown: a fixture's town is the start town's site — its plan and what stands, one record. Erasing its plan left
    // its 702 built blocks standing with no plan; putting the site back in place would mean every holder of it — the
    // fortress, its view, its claims — taking a new one. A fixture's page is loaded again instead: scripts/lab.mjs)
    if (!this.resettable) throw new Error(`lab.reset: the ${this.recipe.name} recipe's town is a fixture's site: load the page again (lab.mjs does)`);
    this.ready = false;
    const f = this.fort();
    this.planMode();
    this.io.dropLife();
    for (let pass = 0; pass < 4 && f.plan.structures().length; pass++)
      for (const s of f.plan.structures())
        for (const c of [...s.cells.keys()])
          for (const l of [...f.plan.levels.each(c)].reverse()) f.erase(c, l);
    if (f.plan.structures().length) throw new Error('lab.reset: the plan would not erase');
    const st = this.town.rec.stores;
    for (const k of Object.keys(st)) delete st[k];
    for (const [k, v] of Object.entries(START_STORES)) st[k] = { stock: v.stock, rate: 0 };
    f.note = null;
    await this.io.restoreLand();
    this.io.speed(0);
    this.sims('all');
    this.simT = 0;
    this.look(this.town.heap[0], this.town.heap[1], 6);
    // (the land's columns read again before the town is put back: the reach check plans on them)
    await new Promise((r) => setTimeout(r, 200));
    f.onMode.forEach((h) => h('plan'));
    await new Promise((r) => setTimeout(r, 300));
    if (this.recipe.town) this.plan({ ...this.recipe.town, built: true });
    this.ready = true;
  }

  private async placeBench(o?: { types?: StructureType[]; arriveS?: number; arrive?: boolean }) {
    const [{ runPlaceBench }, { placeSummary }, { placeReport }] = await Promise.all([import('../perf/placebench/run'), import('../perf/placebench/summary'), import('../perf/placebench')]);
    const result = await runPlaceBench(
      {
        fort: this.fort(),
        frame: () => new Promise<number>((r) => requestAnimationFrame(r)),
        ground: (x, y) => this.ground(x, y),
        build: () => this.build(),
        advance: async (seconds, speed) => void (await this.run(seconds, speed, { keep: false })),
        simTime: () => this.simT,
        walkers: () => (this.io.life()?.people() ?? []).flatMap((id) => {
          const u = this.io.units.get(id);
          return u ? [[u.at[0], u.at[1]] as [number, number]] : [];
        }),
        log: (l) => console.log(`[placebench] ${l}`),
      },
      o,
    );
    return { summary: placeSummary(result), report: placeReport(result, { lab: this.recipe.name, fixture: this.io.fixture?.link ?? null }) };
  }

  private makeApi() {
    const lab = this;
    return {
      /** the recipe's name, its heap (the stores until a warehouse stands) and the window's size */
      recipe: this.recipe.name,
      heap: this.town.heap,
      dims: { w: this.io.core.dims.w, h: this.io.core.dims.h },
      get ready() {
        return lab.ready;
      },
      place: (kind: StructureType | 'gate', x: number, y: number, o?: { level?: number; built?: boolean }) => this.place(kind, x, y, o),
      drag: (kind: StructureType, x0: number, y0: number, x1: number, y1: number) => this.drag(kind, x0, y0, x1, y1),
      plan: (p: LabPlan) => this.plan(p),
      /** every planned block standing at once (no builders) */
      standAll: () => this.standAll(),
      stores: (set: Record<string, number>) => this.stores(set),
      build: () => this.build(),
      planMode: () => this.planMode(),
      sims: (which?: string | string[]) => this.sims(which),
      run: (seconds: number, speed?: number, o?: { renderEvery?: number; keep?: boolean; dt?: number }) => this.run(seconds, speed, o),
      snapshot: () => this.snapshot(),
      look: (x: number, y: number, zoom?: number) => this.look(x, y, zoom),
      shot: (name: string) => this.shot(name),
      reset: () => this.reset(),
      /** (onetown) whether reset() can put the recipe's town back (a fixture's can't: its page is loaded again) */
      get resettable() {
        return lab.resettable;
      },
      ground: (x: number, y: number) => this.ground(x, y),
      /** (townlab) the fixture's header (where it was captured, its town, its generator), or null */
      fixture: this.io.fixture ?? null,
      /** the game's own objects, for what the API doesn't cover */
      fortress: () => this.fort(),
      life: () => this.io.life() ?? null,
      /** (m4) the attack wave: its state, "Call raiders now" */
      raid: () => this.io.raid() ?? null,
      units: this.io.units,
      /** (m4) a tap at screen (x, y), and the follow it drives */
      tap: (sx: number, sy: number) => this.io.tap(sx, sy),
      follow: () => this.io.follow() ?? null,
      /** (m4) a world point on the screen (CSS pixels) */
      project: (x: number, y: number, z: number) => this.io.core.camera.project(x, y, z),
      viewport: () => [this.io.core.camera.viewportW, this.io.core.camera.viewportH],
      /** sim seconds since the lab opened or was reset */
      get simT() {
        return lab.simT;
      },
      /** (round 128m, townlab) the placement bench (perf/placebench/run.ts) on this land, the lab driving the sim for its
       *  arrival check: the result, its summary lines and the report the phone's run downloads */
      placeBench: (o?: { types?: StructureType[]; arriveS?: number; arrive?: boolean }) => this.placeBench(o),
      /** (round 128p, DA-A13 step 1) the paths on the grid's edges and their reach (build/edgenet.ts), drawn with the
       *  buildings inset in place of the lanes; `off` back to the lanes. Returns the reach report */
      edges: (o?: Parameters<Lab['edges']>[0]) => this.edges(o),
    };
  }
}

export function installLab(io: LabSceneIO): Lab {
  return new Lab(io);
}
