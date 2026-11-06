// The settlements as the player sees and touches them (round 119: "have them actually use the new structures"): every
// planned settlement on or near the screen drawn as structures pieces (the game's renderer: Renderer.enableStructures),
// and in the window each standing building's columns claimed as External intervals (sim/external.ts) — what the sims
// see. One concern: showing and claiming what the plans (plan.ts) say stands; the plans and their life are
// settlements.ts' and life.ts'. The buildings were column stamps before (build/town.ts): now the land under a town is its
// ground, the town is pieces on it, and the far land's raster (plan.ts rasterColumns) is told where its roofs are.
//
// (round 128g, cityrender; the user: "There should be multiple grids with their own coordinate system on the GPU and
// everything should be instanced without CPU readback")
//  - Drawing: each settlement is a grid of the structures' grid table (structures/gpu.ts) — its box's frame (local x, y
//    world units; z world) placed in the window's (x from its origin, z less its oz) — and a slab of pieces in that
//    frame, made and uploaded once a change (its plan, a storey raised, a building lost). A slide of the window writes
//    each grid's row (32 bytes) and nothing else. The fortress's pieces are a grid and a slab the same way (`extra`).
//  - Which are drawn: the screen decides (onscreen.ts) — a settlement on screen is drawn whole, with hysteresis; pieces
//    are made ahead for those about to come on screen (one a frame) and let go only well off it.
//  - Claims are only for the sims and change nothing drawn. (Round 128j, claims at load:) each settlement is a static grid
//    (sim/static-claims.ts) — its buildings' column spans on the GPU in its box's frame — claimed where free by the kernel
//    that writes arriving land, region by region: a building partly in the window is claimed there and the rest comes
//    with its land; nothing is let go when it leaves nor claimed again after a slide. A change (a storey raised, a
//    building lost) is the grid's things set again: what changed let go and claimed anew on the GPU.
import type { ColumnSpan, StructurePieces } from '../api/contracts/structures';
import type { ExternalInstance, ExternalRegistry } from '../sim/external';
import { OWNER_STRUCT } from '../sim/external';
import type { StaticClaims, StaticGrid } from '../sim/static-claims';
import { MAT } from '../world/materials';
import { ROW_H } from '../world/lattice';
import { gridApply, gridRow, StructureGpu, type GridTransform } from '../structures/gpu';
import { piecesOf, PIECE_FLOATS, REL } from '../structures/pieces';
import { columnsOf } from '../structures/columns';
import { standingPlan } from '../structures/plan';
import { library } from '../structures/modules';
import { BUILD, planScreen, screenGap, type Box3 } from './onscreen';
import type { Settlements } from './settlements';
import type { SettlementPlan } from './plan';
import type { SettlementSeed } from './records';

export interface ViewIO {
  device: GPUDevice;
  renderer: { enableStructures(sg: StructureGpu): void };
  /** the External registry (null: none — drawn, nothing claimed) */
  external: () => ExternalRegistry | null;
  /** (round 128j) the static grids' claims, written with the land (null: none — drawn, nothing claimed) */
  statics: () => StaticClaims | null;
  dims: { w: number; h: number };
  /** the window's oz */
  oz: () => number;
  /** the camera's view-projection (column-major; render/camera.ts viewProj) */
  viewProj: () => ArrayLike<number>;
  /** the ground the screen's centre shows (window z; render/camera.ts focus) */
  focusZ: () => number;
  /** dust where something went (window units) */
  dust?: (x: number, y: number, z: number, count: number) => void;
}

/** a town's tallest over its ground (world units): its box's z range for the screen test */
const TOWN_TOP = 45;
/** pieces made ahead of the screen a frame (those on screen are made at once) */
const BUILD_BUDGET = 1;
/** frames between looks for settlements to plan ahead of the screen */
const PLAN_EVERY = 15;
/** an unplanned settlement's z range for that look: round the ground the screen's centre shows (no plan: no ground) */
const PLAN_Z = 60;
/** the fortress's slab */
const FORT = 'fortress';

interface Shown {
  seed: SettlementSeed;
  plan: SettlementPlan;
  /** its pieces in its box's frame (null: to be made again) */
  pieces: StructurePieces | null;
  /** its grid in the structures' table (0: none yet) and the transform last written to it */
  grid: number;
  gridKey: string;
  /** drawn last frame */
  drawn: boolean;
  /** its box's ground (world z): lowest, highest */
  zr: [number, number];
  /** per building: its columns in the box's frame, its claim */
  cols: Map<number, ColumnSpan[]>;
  claims: Map<number, ExternalInstance>;
  /** (round 128j) its static grid (its buildings claimed with the land); null: no claims */
  statics: StaticGrid | null;
}

export class SettlementsView {
  readonly sg: StructureGpu;
  private shown = new Map<string, Shown>();
  private fort: { p: StructurePieces | null; grid: number; gridKey: string } = { p: null, grid: 0, gridKey: '' };
  private onlyV = '';
  private frames = 0;
  /** (round 128i, FT-67) updateMs by part, the last update's: gridMs the grid rows, screenMs the screen's entries and
   *  plan (pieces made in it: piecesMs), claimMs the claims (0 when none were due), aheadMs the look ahead (0 between) */
  readonly stats = { settlements: 0, drawn: 0, cached: 0, pieces: 0, built: 0, claimed: 0, columns: 0, lost: 0, piecesMs: 0, updateMs: 0, claimMs: 0, aheadMs: 0, gridMs: 0, screenMs: 0 };

  constructor(private io: ViewIO, private st: Settlements) {
    this.sg = new StructureGpu(io.device);
    io.renderer.enableStructures(this.sg);
    st.onPlanned.push((id) => this.add(id));
    st.onRaised.push((id, b) => this.raised(id, b));
    for (const { seed } of st.plannedAll()) this.add(seed.rec.id);
    const ext = io.external();
    if (ext) ext.owner(OWNER_STRUCT, { name: 'settlements', onLost: (inst) => this.lost(inst) });
  }

  /** (debugging) draw only the pieces whose module name starts with this */
  get only(): string {
    return this.onlyV;
  }
  set only(v: string) {
    this.onlyV = v;
    for (const s of this.shown.values()) s.pieces = null;
    this.fort.p = null;
  }

  private add(id: string): void {
    const sp = this.st.plannedAll().find((x) => x.seed.rec.id === id);
    if (!sp || this.shown.has(id)) return;
    const g = sp.plan.city.ground;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const z of g) {
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    if (!g.length) throw new Error(`settlements view: ${id}'s plan has no ground`);
    const s: Shown = { seed: sp.seed, plan: sp.plan, pieces: null, grid: 0, gridKey: '', drawn: false, zr: [z0, z1 + TOWN_TOP], cols: new Map(), claims: new Map(), statics: null };
    this.columnsOf(s);
    this.shown.set(id, s);
    this.stats.settlements = this.shown.size;
    this.claim(s);
  }

  /** a building's columns as the plan has it standing (box frame) */
  private columnsOf(s: Shown): void {
    s.cols.clear();
    for (const c of columnsOf(standingPlan(s.plan.city, s.plan.standing))) {
      const l = s.cols.get(c.building);
      if (l) l.push(c);
      else s.cols.set(c.building, [c]);
    }
  }

  /**
   * (round 128j) The settlement's buildings as its static grid's things (its box's frame; world z): claimed where free
   * with the land as it's written, and now over the window's written land where they changed.
   */
  private claim(s: Shown): void {
    const st = this.io.statics();
    if (!st) return;
    s.statics ??= st.grid(`town ${s.seed.rec.id}`, OWNER_STRUCT, () => {
      const [dx, dy] = this.offset(s);
      return { dx, dy, dz: -this.io.oz() };
    });
    s.claims = st.set(
      s.statics,
      [...s.cols].map(([b, cs]) => ({ key: b, cols: cs.map((c) => ({ x: c.x, y: c.y, z0: c.z0, z1: c.z1 })), fallback: MAT.Rubble })),
    );
  }

  /** the box's offset in the window (columns, rows) */
  private offset(s: Shown): [number, number] {
    // (the atlas wraps: the box's corner the window's way round)
    const [x, y] = this.st.toWindow([s.seed.box.x0, s.seed.box.y0 * ROW_H]);
    return [Math.round(x), Math.round(y / ROW_H)];
  }

  /** a settlement's grid: its box's frame in the window's */
  private frame(s: Shown): GridTransform {
    const [dx, dy] = this.offset(s);
    return { pos: [dx, dy * ROW_H, -this.io.oz()] };
  }

  /** (scripts) the last update's screen entries: each settlement's gap off the screen, cached, drawn */
  gaps: { id: string; gap: number; cached: boolean; shown: boolean }[] = [];

  /** whether a settlement is drawn now (tests, the pan check) */
  isDrawn(id: string): boolean {
    return this.shown.get(id)?.drawn ?? false;
  }

  private count(): void {
    let n = 0;
    let c = 0;
    for (const s of this.shown.values()) {
      n += s.claims.size;
      for (const i of s.claims.values()) c += i.cols.length;
    }
    this.stats.claimed = n;
    this.stats.columns = c;
  }

  /** a site raised a storey (life.ts → settlements.ts raise): its pieces and its claim made again */
  private raised(id: string, b: number): void {
    const s = this.shown.get(id);
    if (!s) return;
    s.pieces = null;
    // (round 128j: its grid's things set again — the building raised let go where it stood, to air, and claimed anew)
    void b;
    this.columnsOf(s);
    this.claim(s);
  }

  /** a building's cells were cut or it hangs free: it's let go to rubble where it stood, its pieces gone behind dust */
  private lost(inst: ExternalInstance): void {
    for (const s of this.shown.values())
      for (const [b, i] of s.claims) {
        if (i.id !== inst.id) continue;
        s.claims.delete(b);
        this.io.external()?.release(inst.id);
        if (b >= 0) s.plan.standing[b] = 0;
        s.cols.delete(b);
        s.pieces = null;
        this.stats.lost++;
        const { w, h } = this.io.dims;
        if (this.io.dust) for (const c of inst.cols.filter((q, k) => k % 3 === 0 && q.x >= 0 && q.y >= 0 && q.x < w && q.y < h)) this.io.dust(c.x + 0.5, (c.y + 0.5) * ROW_H, (c.z0 + c.z1) / 2, 6);
        return;
      }
  }

  /**
   * (round 128g) Settlements not planned yet whose box is within BUILD screens of the screen: their plans asked for now
   * (Settlements.prepare), so their pieces are made before they're seen. Their ground isn't known before the plan: the box
   * is taken round the ground the screen's centre shows.
   */
  private planAhead(vp: ArrayLike<number>, focusZ: number): void {
    for (const seed of this.st.seeds) {
      const id = seed.rec.id;
      if (this.shown.has(id)) continue;
      const [x, y] = this.st.toWindow([seed.box.x0, seed.box.y0 * ROW_H]);
      const box: Box3 = { x0: x, y0: y, x1: x + seed.box.w, y1: y + seed.box.h * ROW_H, z0: focusZ - PLAN_Z, z1: focusZ + PLAN_Z };
      if (screenGap(vp, box) <= BUILD) this.st.prepare(id);
    }
  }

  /** (tests, debugging) a settlement's pieces in its box's frame: module name and the 16 floats */
  pieces(id: string): { module: string; data: number[]; building: number }[] {
    const s = this.shown.get(id);
    if (!s) return [];
    const p = (s.pieces ??= this.make(s));
    const lib = library();
    const out = [];
    for (let i = 0; i < p.count; i++) out.push({ module: lib.modules[p.module[i]].name, data: Array.from(p.data.subarray(i * PIECE_FLOATS, (i + 1) * PIECE_FLOATS)), building: p.building[i] });
    return out;
  }

  /**
   * (fortress slice 1) Other pieces drawn with the towns' (one structures draw): in their own frame (x, y world units
   * from (dx, dy) in the window; z world). The same object back while they haven't changed (only then are they uploaded
   * again); null: none.
   */
  extra: (() => { p: StructurePieces; dx: number; dy: number } | null) | null = null;

  /**
   * (debugging, scripts) What's drawn now in the window's frame: every shown slab's pieces through its grid. Made on
   * demand on the CPU (nothing draws from it).
   */
  get last(): { module: Uint16Array; data: Float32Array } | null {
    const parts: { p: StructurePieces; t: GridTransform }[] = [];
    for (const s of this.shown.values()) if (s.drawn && s.pieces) parts.push({ p: s.pieces, t: this.frame(s) });
    const ex = this.extra?.();
    if (ex && ex.p.count) parts.push({ p: ex.p, t: { pos: [ex.dx, ex.dy, -this.io.oz()] } });
    let n = 0;
    for (const x of parts) n += x.p.count;
    const module = new Uint16Array(n);
    const data = new Float32Array(n * PIECE_FLOATS);
    let k = 0;
    for (const { p, t } of parts) {
      module.set(p.module, k);
      data.set(p.data, k * PIECE_FLOATS);
      const row = gridRow(t);
      for (let i = k; i < k + p.count; i++) toFrame(data, i * PIECE_FLOATS, row);
      k += p.count;
    }
    return { module, data };
  }

  private make(s: Shown): StructurePieces {
    return this.filter(piecesOf(standingPlan(s.plan.city, s.plan.standing)));
  }

  private filter(p: StructurePieces): StructurePieces {
    if (!this.onlyV) return p;
    const lib = library();
    const keep: number[] = [];
    for (let i = 0; i < p.count; i++) if (lib.modules[p.module[i]].name.startsWith(this.onlyV)) keep.push(i);
    const data = new Float32Array(keep.length * PIECE_FLOATS);
    keep.forEach((src, dst) => data.set(p.data.subarray(src * PIECE_FLOATS, (src + 1) * PIECE_FLOATS), dst * PIECE_FLOATS));
    return { module: Uint16Array.from(keep, (i) => p.module[i]), data, building: Int32Array.from(keep, (i) => p.building[i]), count: keep.length };
  }

  /** each frame: the grids' rows where they moved, what's drawn by the screen, pieces made where needed, the claims */
  update(): void {
    const t0 = performance.now();
    let built = 0;
    let buildMs = 0;
    const oz = this.io.oz();
    // (the screen: each settlement's box projected; its pieces cached on the GPU unless they changed)
    const vp = this.io.viewProj();
    this.stats.aheadMs = 0;
    if (++this.frames % PLAN_EVERY === 0) {
      const ta = performance.now();
      this.planAhead(vp, this.io.focusZ());
      this.stats.aheadMs = +(performance.now() - ta).toFixed(2);
    }
    const ts = performance.now();
    const entries = [];
    for (const [id, s] of this.shown) {
      const [dx, dy] = this.offset(s);
      const box: Box3 = { x0: dx, y0: dy * ROW_H, x1: dx + s.seed.box.w, y1: (dy + s.seed.box.h) * ROW_H, z0: s.zr[0] - oz, z1: s.zr[1] - oz };
      entries.push({ id, gap: screenGap(vp, box), cached: !!s.pieces && this.sg.has(id), held: this.sg.has(id), shown: s.drawn });
    }
    this.gaps = entries;
    const plan = planScreen(entries, BUILD_BUDGET);
    for (const id of plan.build) {
      const s = this.shown.get(id)!;
      const tb = performance.now();
      s.pieces = this.make(s);
      if (!s.grid) s.grid = this.sg.newGrid();
      this.sg.put(id, s.pieces, s.grid, false);
      buildMs += performance.now() - tb;
      built++;
    }
    for (const id of plan.drop) {
      const s = this.shown.get(id)!;
      this.sg.drop(id);
      this.sg.freeGrid(s.grid);
      s.grid = 0;
      s.gridKey = '';
      s.pieces = null;
    }
    const tg = performance.now();
    this.stats.screenMs = +(tg - ts - buildMs).toFixed(2);
    let drawn = 0;
    let cached = 0;
    for (const [id, s] of this.shown) {
      if (s.grid) {
        cached++;
        // (a slide, a warp, a change of oz: the grid's row, 32 bytes — the pieces stay where they are on the GPU)
        const t = this.frame(s);
        const key = t.pos.join(',');
        if (key !== s.gridKey) {
          s.gridKey = key;
          this.sg.setGrid(s.grid, t);
        }
      }
      s.drawn = plan.show.has(id);
      this.sg.show(id, s.drawn);
      if (s.drawn) drawn++;
    }
    // (the fortress: its own grid; its pieces uploaded only when they're new)
    const ex = this.extra?.();
    if (ex && ex.p.count) {
      if (!this.fort.grid) this.fort.grid = this.sg.newGrid();
      if (ex.p !== this.fort.p) {
        this.fort.p = ex.p;
        this.sg.put(FORT, this.filter(ex.p), this.fort.grid);
      }
      const t: GridTransform = { pos: [ex.dx, ex.dy, -oz] };
      const key = t.pos.join(',');
      if (key !== this.fort.gridKey) {
        this.fort.gridKey = key;
        this.sg.setGrid(this.fort.grid, t);
      }
    } else if (this.fort.p) {
      this.sg.drop(FORT);
      this.fort.p = null;
    }
    this.stats.gridMs = +(performance.now() - tg).toFixed(2);
    // (round 128j: nothing to claim here — the claims are written with the land; claimMs the static claims' last write)
    this.stats.claimMs = this.io.statics()?.stats.lastMs ?? 0;
    this.count();
    this.stats.drawn = drawn;
    this.stats.cached = cached;
    this.stats.pieces = this.sg.stats.pieces;
    this.stats.built += built;
    if (built) this.stats.piecesMs = +buildMs.toFixed(1);
    this.stats.updateMs = +(performance.now() - t0).toFixed(2);
  }
}

/** a piece's 16 floats (at o) moved through a grid row into its host's frame (CPU; `last`'s, for scripts) */
function toFrame(d: Float32Array, o: number, row: Float32Array): void {
  const flags = d[o + 15];
  if (flags & 2) {
    // (affine: rows 0-2 a 3 × 4 transform — its translation through the grid; a grid that turns isn't handled here)
    const t = gridApply(row, [d[o + 3], d[o + 7], d[o + 11]]);
    d[o + 3] = t[0];
    d[o + 7] = t[1];
    d[o + 11] = t[2];
    return;
  }
  for (let c = 0; c < 4; c++) {
    const p = gridApply(row, [d[o + c * 2], d[o + c * 2 + 1], d[o + 8 + c]]);
    d[o + c * 2] = p[0];
    d[o + c * 2 + 1] = p[1];
    d[o + 8 + c] = p[2];
  }
  if (!(flags & REL)) d[o + 12] = gridApply(row, [d[o], d[o + 1], d[o + 12]])[2];
}
