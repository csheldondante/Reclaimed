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
//  - (round 128m, onetown) One town, one plan (build/site.ts): what's drawn is the plan's view (build/view.ts
//    townPieces) and what's claimed its built blocks' solid (fortress/solid.ts solidSpans: a block its cell, a wall its
//    band, a gate open under its lintel, a wall's stairs, the ramps) and the layout's decks (bridges, piers) — the same
//    for every town. The player's town adds its edit state to both through its hook (setHook: the fortress's mode, its
//    ways and lanes, Inspect's pick, a refusal's warning, the gates shut); there is no second slab for it.
import type { StructurePieces } from '../api/contracts/structures';
import { townPieces, type ViewInputs } from '../build/view';
import { TownClaims } from '../build/claims';
import type { Ways } from '../build/ways';
import type { ExternalRegistry } from '../sim/external';
import type { StaticClaims } from '../sim/static-claims';
import { ROW_H } from '../world/lattice';
import { typeIndex } from '../build/plan';
import { gridApply, gridRow, StructureGpu, type GridTransform } from '../structures/gpu';
import { PIECE_FLOATS, REL } from '../structures/pieces';
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
/**
 * (onetown) What a town's player-side state adds to its view and its claims (the fortress's: fortress/fortress.ts). The
 * view asks each time it makes the town's pieces or claims (after `changed`).
 */
export interface TownHook {
  /** the view's extra inputs: ghosts and scaffolding by the mode, Inspect's pick, a warning, the lanes */
  view(): Partial<ViewInputs>;
  /** the claims': the ways (a wall's stairs are solid), the gates shut */
  solid(): { ways?: Ways; shut?: boolean };
  /** a structure's claim was cut (dug out, smashed): what's left of it is the hook's to say (the fortress: it breaks) */
  lost?(structure: number): void;
}

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
  /** (onetown) its built blocks claimed in the columns (build/claims.ts: the one rule for every town) */
  claims: TownClaims;
}

export class SettlementsView {
  readonly sg: StructureGpu;
  private shown = new Map<string, Shown>();
  private hooks = new Map<string, TownHook>();
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
  }

  /** (debugging) draw only the pieces whose module name starts with this */
  get only(): string {
    return this.onlyV;
  }
  set only(v: string) {
    this.onlyV = v;
    for (const s of this.shown.values()) s.pieces = null;
  }

  /** (onetown) a town's player-side state (the fortress's): its view and claims take it in from now */
  setHook(id: string, hook: TownHook | null): void {
    if (hook) this.hooks.set(id, hook);
    else this.hooks.delete(id);
    this.changed(id);
  }

  /** (onetown) a town's plan or what stands of it changed: its pieces made again, its claims set again */
  changed(id: string): void {
    const s = this.shown.get(id);
    if (!s) return;
    s.pieces = null;
    s.claims.update();
    this.count();
  }

  /** (onetown) a town's claims (tests, probes: the level's fortressClaims) */
  claimsOf(id: string): TownClaims | null {
    return this.shown.get(id)?.claims ?? null;
  }

  /** (onetown) only its pieces made again (a ghost's look, Inspect's pick: nothing solid changed) */
  redraw(id: string): void {
    const s = this.shown.get(id);
    if (s) s.pieces = null;
  }

  private add(id: string): void {
    const sp = this.st.plannedAll().find((x) => x.seed.rec.id === id);
    if (!sp || this.shown.has(id)) return;
    const g = sp.plan.site.groundCols;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const z of g) {
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    if (!g.length) throw new Error(`settlements view: ${id}'s plan has no ground`);
    const s: Shown = {
      seed: sp.seed,
      plan: sp.plan,
      pieces: null,
      grid: 0,
      gridKey: '',
      drawn: false,
      zr: [z0, z1 + TOWN_TOP],
      claims: new TownClaims(sp.plan.site, {
        external: this.io.external,
        statics: this.io.statics,
        place: () => {
          const [dx, dy] = this.offset(s);
          return { dx, dy, dz: -this.io.oz() };
        },
        solid: () => this.hooks.get(id)?.solid() ?? {},
        lost: (structure, cols) => this.lost(s, structure, cols),
      }),
    };
    this.shown.set(id, s);
    this.stats.settlements = this.shown.size;
    s.claims.update();
    this.count();
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
      n += s.claims.stats.structures;
      c += s.claims.stats.columns;
    }
    this.stats.claimed = n;
    this.stats.columns = c;
  }

  /** a site raised a storey (life.ts → settlements.ts raise): its pieces and its claim made again */
  private raised(id: string, _structure: number): void {
    // (round 128j: its grid's things set again — the building raised let go where it stood, to air, and claimed anew)
    this.changed(id);
  }

  /**
   * A structure's cells were cut or it hangs free: it's let go to rubble where it stood (TownClaims), its pieces gone
   * behind dust. (onetown) What's left is the town's hook's to say (the player's town: the fortress breaks it, the
   * builders mend it); else it comes down — its blocks planned again, as a raid's breach; a layout deck is gone.
   */
  private lost(s: Shown, structure: number, cols: readonly { x: number; y: number; z0: number; z1: number }[]): void {
    const hook = this.hooks.get(s.seed.rec.id);
    if (hook?.lost) hook.lost(structure);
    else {
      const site = s.plan.site;
      const st = structure > 0 ? site.plan.structure(structure) : null;
      if (st) for (const c of st.cells.keys()) for (const L of [...site.town.built.each(c)]) (site.town.remove(c, L), site.town.plan(c, L, true, st.id, typeIndex(st.type)));
    }
    s.pieces = null;
    this.stats.lost++;
    this.count();
    const { w, h } = this.io.dims;
    if (this.io.dust) for (const c of cols.filter((q, k) => k % 3 === 0 && q.x >= 0 && q.y >= 0 && q.x < w && q.y < h)) this.io.dust(c.x + 0.5, (c.y + 0.5) * ROW_H, (c.z0 + c.z1) / 2, 6);
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
   * (debugging, scripts) What's drawn now in the window's frame: every shown slab's pieces through its grid. Made on
   * demand on the CPU (nothing draws from it).
   */
  get last(): { module: Uint16Array; data: Float32Array } | null {
    const parts: { p: StructurePieces; t: GridTransform }[] = [];
    for (const s of this.shown.values()) if (s.drawn && s.pieces) parts.push({ p: s.pieces, t: this.frame(s) });
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

  /**
   * (onetown) The town drawn: its plan's view as it stands — what isn't built yet a plot or scaffolding — and what its
   * hook adds (the fortress planning: the plan whole)
   */
  private make(s: Shown): StructurePieces {
    const site = s.plan.site;
    const hook = this.hooks.get(s.seed.rec.id)?.view() ?? {};
    return this.filter(townPieces(site, { ground: (x, y) => site.groundAt(x, y), ghost: (c, l) => !site.town.has(c, l), ...hook }));
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
