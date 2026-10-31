// The settlements as the player sees and touches them (round 119: "have them actually use the new structures"): every
// planned settlement near the camera drawn as structures pieces (the game's renderer: Renderer.enableStructures), and
// in the window each standing building's columns claimed as External intervals (sim/external.ts) — what the sims see.
// One concern: showing and claiming what the plans (plan.ts) say stands; the plans and their life are settlements.ts'
// and life.ts'. The buildings were column stamps before (build/town.ts): now the land under a town is its ground, the
// town is pieces on it, and the far land's raster (plan.ts rasterColumns) is told where its roofs are.
//
// Frames: a plan is in its box's frame (local x, y world units; z world); the window is its own (x from its origin,
// z less its oz). Each settlement's pieces are made once a change (its plan, a storey raised, a building lost) and
// moved into the window's frame when drawn; the window's slides move them, and a building leaving the window lets go
// of its columns (to air) and claims them again when it's all back (as the resting rock's do).
import type { ColumnSpan, StructurePieces } from '../api/contracts/structures';
import type { ExternalInstance, ExternalRegistry } from '../sim/external';
import { OWNER_STRUCT } from '../sim/external';
import { MAT } from '../world/materials';
import { ROW_H } from '../world/lattice';
import { StructureGpu } from '../structures/gpu';
import { piecesOf, PIECE_FLOATS, REL } from '../structures/pieces';
import { columnsOf } from '../structures/columns';
import { standingPlan } from '../structures/plan';
import { library } from '../structures/modules';
import type { Settlements } from './settlements';
import type { SettlementPlan } from './plan';
import type { SettlementSeed } from './records';

export interface ViewIO {
  device: GPUDevice;
  renderer: { enableStructures(sg: StructureGpu): void };
  /** the External registry (null: none — drawn, nothing claimed) */
  external: () => ExternalRegistry | null;
  /** resolves once the registry's columns can be read */
  ready: () => Promise<void>;
  dims: { w: number; h: number };
  /** the window's world cell (0, 0) and its oz */
  origin: () => [number, number];
  oz: () => number;
  /** the camera's point (window units) */
  focus: () => [number, number];
  /** the hybrid's chunks over a claim: drawn as voxels (a heightfield chunk would stretch the ground over a building) */
  touched?: (x0: number, y0: number, x1: number, y1: number) => void;
  /** dust where something went (window units) */
  dust?: (x: number, y: number, z: number, count: number) => void;
}

/** how far from the camera a settlement is drawn (world units) */
const REACH = 1400;

interface Shown {
  seed: SettlementSeed;
  plan: SettlementPlan;
  /** its pieces in its box's frame (null: to be made again) */
  pieces: StructurePieces | null;
  /** per building: its columns in the box's frame, its claim */
  cols: Map<number, ColumnSpan[]>;
  claims: Map<number, ExternalInstance>;
  away: Set<number>;
}

export class SettlementsView {
  readonly sg: StructureGpu;
  private shown = new Map<string, Shown>();
  private dirty = true;
  private copyIn = false;
  private lastOrigin = '';
  /** (debugging) draw only the pieces whose module name starts with this */
  only = '';
  /** (debugging) the last pieces set, in the window's frame */
  last: { module: Uint16Array; data: Float32Array } | null = null;
  readonly stats = { settlements: 0, drawn: 0, pieces: 0, claimed: 0, columns: 0, lost: 0, piecesMs: 0 };

  constructor(private io: ViewIO, private st: Settlements) {
    this.sg = new StructureGpu(io.device);
    io.renderer.enableStructures(this.sg);
    st.onPlanned.push((id) => this.add(id));
    st.onRaised.push((id, b) => this.raised(id, b));
    for (const { seed } of st.plannedAll()) this.add(seed.rec.id);
    const ext = io.external();
    if (ext) {
      ext.owner(OWNER_STRUCT, { name: 'settlements', onLost: (inst) => this.lost(inst) });
      void io.ready().then(() => {
        this.copyIn = true;
        for (const s of this.shown.values()) this.claimAll(s);
      });
    }
  }

  private add(id: string): void {
    const sp = this.st.plannedAll().find((x) => x.seed.rec.id === id);
    if (!sp || this.shown.has(id)) return;
    const s: Shown = { seed: sp.seed, plan: sp.plan, pieces: null, cols: new Map(), claims: new Map(), away: new Set() };
    this.columnsOf(s);
    this.shown.set(id, s);
    this.stats.settlements = this.shown.size;
    this.dirty = true;
    if (this.copyIn) this.claimAll(s);
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

  private claim(s: Shown, b: number): void {
    const ext = this.io.external();
    const cs = s.cols.get(b);
    if (!ext || !cs) return;
    const [dx, dy] = this.offset(s);
    const { w, h } = this.io.dims;
    const oz = this.io.oz();
    const want = cs.map((c) => ({ x: c.x + dx, y: c.y + dy, z0: c.z0 - oz, z1: c.z1 - oz }));
    if (!want.every((c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h)) {
      // (wholly in the window or not at all: one instance a building)
      if (want.some((c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h)) s.away.add(b);
      return;
    }
    const inst = ext.claim(OWNER_STRUCT, want, MAT.Rubble);
    s.away.delete(b);
    if (!inst) return;
    s.claims.set(b, inst);
    if (this.io.touched) {
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
    this.count();
  }

  private claimAll(s: Shown): void {
    for (const b of s.cols.keys()) if (!s.claims.has(b)) this.claim(s, b);
  }

  private release(s: Shown, b: number, toAir: boolean): void {
    const inst = s.claims.get(b);
    if (!inst) return;
    this.io.external()?.release(inst.id, toAir);
    s.claims.delete(b);
    this.count();
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
    this.dirty = true;
    this.release(s, b, true);
    this.columnsOf(s);
    if (this.copyIn) this.claim(s, b);
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
        this.dirty = true;
        this.stats.lost++;
        if (this.io.dust) for (const c of inst.cols.filter((_, k) => k % 3 === 0)) this.io.dust(c.x + 0.5, (c.y + 0.5) * ROW_H, (c.z0 + c.z1) / 2, 6);
        this.count();
        return;
      }
  }

  /** before the window slides by (dx, dy) columns: buildings that would leave let go of their columns (to air) */
  beforeSlide(dx: number, dy: number): void {
    const { w, h } = this.io.dims;
    for (const s of this.shown.values())
      for (const [b, inst] of [...s.claims])
        if (inst.cols.some((c) => c.x - dx < 0 || c.y - dy < 0 || c.x - dx >= w || c.y - dy >= h)) {
          this.release(s, b, true);
          s.away.add(b);
        }
  }

  /** after it slid (the registry moved the claims with the land): the pieces move, the buildings all back claim again */
  slid(): void {
    this.dirty = true;
    if (!this.copyIn) return;
    for (const s of this.shown.values()) {
      for (const b of [...s.away]) this.claim(s, b);
      // (a settlement that came into the window: its buildings claim)
      this.claimAll(s);
    }
  }

  /** (tests, debugging) a settlement's pieces in its box's frame: module name and the 16 floats */
  pieces(id: string): { module: string; data: number[]; building: number }[] {
    const s = this.shown.get(id);
    if (!s) return [];
    const p = (s.pieces ??= piecesOf(standingPlan(s.plan.city, s.plan.standing)));
    const lib = library();
    const out = [];
    for (let i = 0; i < p.count; i++) out.push({ module: lib.modules[p.module[i]].name, data: Array.from(p.data.subarray(i * PIECE_FLOATS, (i + 1) * PIECE_FLOATS)), building: p.building[i] });
    return out;
  }

  /** each frame: the pieces again when something changed or the window moved */
  update(): void {
    const o = this.io.origin();
    const key = `${o[0]},${o[1]},${this.io.oz()}`;
    if (key !== this.lastOrigin) {
      this.lastOrigin = key;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const t0 = performance.now();
    const [fx, fy] = this.io.focus();
    const oz = this.io.oz();
    const parts: { p: StructurePieces; dx: number; dy: number }[] = [];
    let drawn = 0;
    for (const s of this.shown.values()) {
      const [dx, dyRows] = this.offset(s);
      const dy = dyRows * ROW_H;
      // (near the camera: the box's middle within reach)
      const mx = dx + s.seed.box.w / 2;
      const my = dy + (s.seed.box.h * ROW_H) / 2;
      if (Math.hypot(mx - fx, my - fy) > REACH) continue;
      s.pieces ??= piecesOf(standingPlan(s.plan.city, s.plan.standing));
      parts.push({ p: s.pieces, dx, dy });
      drawn++;
    }
    let n = 0;
    for (const x of parts) n += x.p.count;
    const module = new Uint16Array(n);
    const data = new Float32Array(n * PIECE_FLOATS);
    const building = new Int32Array(n);
    let k = 0;
    for (const { p, dx, dy } of parts) {
      module.set(p.module, k);
      building.set(p.building, k);
      data.set(p.data, k * PIECE_FLOATS);
      for (let i = k; i < k + p.count; i++) {
        const o = i * PIECE_FLOATS;
        const flags = data[o + 15];
        if (flags & 2) {
          data[o + 3] += dx;
          data[o + 7] += dy;
          data[o + 11] -= oz;
          continue;
        }
        for (let c = 0; c < 4; c++) {
          data[o + c * 2] += dx;
          data[o + c * 2 + 1] += dy;
          data[o + 8 + c] -= oz;
        }
        if (!(flags & REL)) data[o + 12] -= oz;
      }
      k += p.count;
    }
    this.last = { module, data };
    if (this.only) {
      const lib = library();
      const keep: number[] = [];
      for (let i = 0; i < n; i++) if (lib.modules[module[i]].name.startsWith(this.only)) keep.push(i);
      const d2 = new Float32Array(keep.length * PIECE_FLOATS);
      keep.forEach((src, dst) => d2.set(data.subarray(src * PIECE_FLOATS, (src + 1) * PIECE_FLOATS), dst * PIECE_FLOATS));
      this.sg.set({ module: Uint16Array.from(keep, (i) => module[i]), data: d2, building: Int32Array.from(keep, (i) => building[i]), count: keep.length });
    } else this.sg.set({ module, data, building, count: n });
    this.stats.drawn = drawn;
    this.stats.pieces = n;
    this.stats.piecesMs = +(performance.now() - t0).toFixed(1);
  }
}
