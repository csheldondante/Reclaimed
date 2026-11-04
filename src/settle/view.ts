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
//  - Claims are only for the sims and change nothing drawn: a building wholly in the window, on land the streamer has
//    written, is claimed where it's free (ExternalRegistry.claimFree: the GPU's stamp, nothing read back); one partly out
//    of the window, or on land still coming in, isn't — the sims see air there (water runs through it, the agents'
//    surfaces don't hold it) until it's whole and its land has come; one about to leave lets go first (beforeSlide).
import type { ColumnSpan, StructurePieces } from '../api/contracts/structures';
import type { ExternalCol, ExternalInstance, ExternalRegistry } from '../sim/external';
import { OWNER_STRUCT } from '../sim/external';
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
  dims: { w: number; h: number };
  /** the window's oz */
  oz: () => number;
  /** the camera's view-projection (column-major; render/camera.ts viewProj) */
  viewProj: () => ArrayLike<number>;
  /** the ground the screen's centre shows (window z; render/camera.ts focus) */
  focusZ: () => number;
  /** (round 128g) whether the window's land in box [x0, x1) × [y0, y1) (cells, rows) is written (not still coming in) */
  landed: (x0: number, y0: number, x1: number, y1: number) => boolean;
  /** the hybrid's chunks over a claim: drawn as voxels (a heightfield chunk would stretch the ground over a building) */
  touched?: (x0: number, y0: number, x1: number, y1: number) => void;
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
}

export class SettlementsView {
  readonly sg: StructureGpu;
  private shown = new Map<string, Shown>();
  /** buildings to try claiming next update (a slide, land come in, a plan changed) */
  private claimsDue = true;
  private fort: { p: StructurePieces | null; grid: number; gridKey: string } = { p: null, grid: 0, gridKey: '' };
  private onlyV = '';
  private frames = 0;
  readonly stats = { settlements: 0, drawn: 0, cached: 0, pieces: 0, built: 0, claimed: 0, columns: 0, lost: 0, piecesMs: 0, updateMs: 0, claimMs: 0, aheadMs: 0 };

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
    const s: Shown = { seed: sp.seed, plan: sp.plan, pieces: null, grid: 0, gridKey: '', drawn: false, zr: [z0, z1 + TOWN_TOP], cols: new Map(), claims: new Map() };
    this.columnsOf(s);
    this.shown.set(id, s);
    this.stats.settlements = this.shown.size;
    this.claimsDue = true;
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

  /**
   * A building's columns in the window as it would claim them: null when it can't be claimed now — not wholly in the
   * window (one instance a building: all of it or nothing), or on land still coming in.
   */
  private want(s: Shown, b: number): ExternalCol[] | null {
    const cs = s.cols.get(b);
    if (!cs?.length) return null;
    const [dx, dy] = this.offset(s);
    const { w, h } = this.io.dims;
    const oz = this.io.oz();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const want = cs.map((c) => {
      const q = { x: c.x + dx, y: c.y + dy, z0: c.z0 - oz, z1: c.z1 - oz };
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x + 1);
      y1 = Math.max(y1, q.y + 1);
      return q;
    });
    if (x0 < 0 || y0 < 0 || x1 > w || y1 > h) return null;
    if (!this.io.landed(x0, y0, x1, y1)) return null;
    return want;
  }

  /** a settlement's buildings not claimed claim their columns where they can (nothing read: claimFree) */
  private claimAll(): void {
    const ext = this.io.external();
    if (!ext) return;
    const who: [Shown, number][] = [];
    const wants: ExternalCol[][] = [];
    for (const s of this.shown.values())
      for (const b of s.cols.keys()) {
        if (s.claims.has(b)) continue;
        const want = this.want(s, b);
        if (!want) continue;
        who.push([s, b]);
        wants.push(want);
      }
    // (one stamp for them all: a town coming back into the window is one GPU dispatch, not one a building)
    ext.claimFreeEach(OWNER_STRUCT, wants, MAT.Rubble).forEach((inst, k) => {
      if (!inst) return;
      who[k][0].claims.set(who[k][1], inst);
      this.touchCols(inst);
    });
  }

  private touchCols(inst: ExternalInstance): void {
    if (!this.io.touched) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of inst.cols) {
      x0 = Math.min(x0, c.x);
      x1 = Math.max(x1, c.x + 1);
      y0 = Math.min(y0, c.y * ROW_H);
      y1 = Math.max(y1, (c.y + 1) * ROW_H);
    }
    this.io.touched(x0, y0, x1, y1);
  }

  private release(s: Shown, b: number, toAir: boolean): void {
    const inst = s.claims.get(b);
    if (!inst) return;
    this.io.external()?.release(inst.id, toAir);
    s.claims.delete(b);
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
    this.release(s, b, true);
    this.columnsOf(s);
    this.claimsDue = true;
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
        if (this.io.dust) for (const c of inst.cols.filter((_, k) => k % 3 === 0)) this.io.dust(c.x + 0.5, (c.y + 0.5) * ROW_H, (c.z0 + c.z1) / 2, 6);
        return;
      }
  }

  /** before the window slides by (dx, dy) columns: buildings that would leave let go of their columns (to air) */
  beforeSlide(dx: number, dy: number): void {
    const { w, h } = this.io.dims;
    for (const s of this.shown.values())
      for (const [b, inst] of [...s.claims]) if (inst.cols.some((c) => c.x - dx < 0 || c.y - dy < 0 || c.x - dx >= w || c.y - dy >= h)) this.release(s, b, true);
  }

  /** after it slid (the registry moved the claims with the land): the buildings back claim again next update */
  slid(): void {
    this.claimsDue = true;
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

  /** (round 128g) land was written into the window (the streamer's onRelief): buildings on it may claim now */
  landed(): void {
    this.claimsDue = true;
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
    if (++this.frames % PLAN_EVERY === 0) {
      const ta = performance.now();
      this.planAhead(vp, this.io.focusZ());
      this.stats.aheadMs = +(performance.now() - ta).toFixed(2);
    }
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
    if (this.claimsDue) {
      this.claimsDue = false;
      const tc = performance.now();
      this.claimAll();
      this.stats.claimMs = +(performance.now() - tc).toFixed(2);
    }
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
