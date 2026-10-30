// A city in the game's world (round 117, BACKLOG STR9): `?city=<tile system>` on the atlas level. The planner on the
// window's ground, the pieces drawn by the game's renderer (Renderer.enableStructures: its light, shadows, haze), each
// building's columns claimed as External intervals (sim/external.ts) so water runs round it, sand piles on it and the
// terrain's draws leave room for it. The settlement it stands in for is handed off (Settlements.handOff: not stamped).
//
// What the sims do to it: a building whose cells are cut (dug, smashed, melted) or found hanging free is let go — its
// cells become rubble where they were, its pieces are taken away behind a burst of dust (the round-106 rule: "hide every
// re-mesh or body-to-terrain swap behind a burst of dust"). Collapse as bodies is later (STR15 with the physics track).
//
// Window coordinates throughout: the plan is made in the window's frame and moved when the window slides; a building
// whose columns leave the window lets go of them (to air: the streamer freezes the land as it is) and claims them again
// when they're all back.
import type { CitySpec, CityPlan, ColumnSpan, StructurePieces } from '../api/contracts/structures';
import type { GridStyle } from '../api/contracts/settlement';
import type { ExternalInstance, ExternalRegistry } from '../sim/external';
import { OWNER_STRUCT } from '../sim/external';
import { MAT } from '../world/materials';
import { cellAt, ROW_H } from '../world/lattice';
import { planCity, grown } from './plan';
import { piecesOf, PIECE_FLOATS } from './pieces';
import { columnsOf } from './columns';
import { StructureGpu } from './gpu';
import { STYLE_IDS } from './styles';

export interface CityHostIO {
  device: GPUDevice;
  renderer: { enableStructures(sg: StructureGpu): void };
  /** the External registry (null: the level has none — the pieces are drawn, nothing claimed) */
  external: () => ExternalRegistry | null;
  /** resolves once the registry's columns can be read (the integrity system's CPU copy is in) */
  ready: () => Promise<void>;
  dims: { w: number; h: number };
  /** the window's ground (window z) at column (x, y), as it was made */
  ground: Float32Array;
  /** the window's water depth at column (x, y), as it was made */
  water?: Float32Array;
  /** the sea's level (window z): ground under it is under water too */
  sea?: number;
  /**
   * (the renderer's hybrid: a chunk drawn as a heightfield lattice through the columns' tops would stretch the ground
   * up over a building's External top — the field mesh's voxels leave room for it) the window box a claim touched
   * (window units), to be drawn as voxels
   */
  touched?: (x0: number, y0: number, x1: number, y1: number) => void;
  /** where to say something fell (dust) */
  dust?: (x: number, y: number, z: number, count: number) => void;
}

export interface CitySite {
  /** centre (window x, y world units) and reach */
  at: [number, number];
  radius: number;
  id?: string;
}

/** the URL's city: ?city=<system>&cstyle=&cseed=&cr=&croads=&cwalls=1 */
export function citySpecFrom(q: URLSearchParams, site: CitySite): CitySpec {
  const system = q.get('city') as GridStyle;
  if (!['irregular', 'contour-voronoi', 'radial', 'orthogonal'].includes(system)) throw new Error(`?city= must be irregular, contour-voronoi, radial or orthogonal (got "${system}")`);
  const style = (q.get('cstyle') ?? (system === 'radial' ? 'bastion' : 'hearth')) as CitySpec['style'];
  if (!STYLE_IDS.includes(style)) throw new Error(`?cstyle= must be one of ${STYLE_IDS.join(', ')}`);
  return { seed: Number(q.get('cseed') ?? 7), system, style, at: site.at, radius: Number(q.get('cr') ?? site.radius), roads: Number(q.get('croads') ?? 2), walls: q.get('cwalls') === '1' || undefined, progress: q.has('cgrow') ? Number(q.get('cgrow')) : undefined };
}

export class CityHost {
  readonly sg: StructureGpu;
  plan!: CityPlan;
  private all!: StructurePieces;
  /** per building: its columns (window cells) and its claim */
  private cols = new Map<number, ColumnSpan[]>();
  private claims = new Map<number, ExternalInstance>();
  private gone = new Set<number>();
  private away = new Set<number>();
  /** the first claim made (the copy was in) */
  private claimed = false;
  readonly stats = { buildings: 0, pieces: 0, claimed: 0, columns: 0, cut: 0, planMs: 0 };

  constructor(private io: CityHostIO, readonly spec: CitySpec) {
    this.sg = new StructureGpu(io.device);
    io.renderer.enableStructures(this.sg);
    const t0 = performance.now();
    this.plan = planCity(spec, (x, y) => this.groundAt(x, y), this.io.water || this.io.sea !== undefined ? (x, y) => Math.max(this.io.water ? this.at(this.io.water, x, y) : 0, (this.io.sea ?? -Infinity) - this.groundAt(x, y)) : undefined);
    // (?cgrow=: the town as built so far — stored progress, a share of its build order)
    const built = grown(this.plan, spec.progress ?? 1);
    this.all = piecesOf(built);
    this.stats.planMs = +(performance.now() - t0).toFixed(1);
    // (one instance a building; the ramparts (−1) one, each wall run or bridge (−2 …) one)
    for (const c of columnsOf(built)) {
      const l = this.cols.get(c.building);
      if (l) l.push(c);
      else this.cols.set(c.building, [c]);
    }
    this.stats.buildings = this.plan.buildings.length;
    this.show();
    const ext = io.external();
    if (ext) {
      ext.owner(OWNER_STRUCT, { name: 'structures', onLost: (inst) => this.lost(inst) });
      void io.ready().then(() => {
        for (const b of this.cols.keys()) this.claim(b);
        this.claimed = true;
      });
    }
  }

  /** the window's ground under a world point (the column it's in, as made) */
  private groundAt(x: number, y: number): number {
    return this.at(this.io.ground, x, y);
  }

  private at(a: Float32Array, x: number, y: number): number {
    const [cx, cy] = cellAt(x, y);
    const { w, h } = this.io.dims;
    return a[Math.min(h - 1, Math.max(0, cy)) * w + Math.min(w - 1, Math.max(0, cx))];
  }

  private inWindow(cs: ColumnSpan[]): boolean {
    const { w, h } = this.io.dims;
    return cs.every((c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h);
  }

  private claim(b: number): void {
    const ext = this.io.external();
    const cs = this.cols.get(b);
    if (!ext || !cs || this.gone.has(b)) return;
    if (!this.inWindow(cs)) {
      this.away.add(b);
      return;
    }
    const inst = ext.claim(OWNER_STRUCT, cs.map((c) => ({ x: c.x, y: c.y, z0: c.z0, z1: c.z1 })), MAT.Rubble);
    this.away.delete(b);
    if (!inst) return;
    this.claims.set(b, inst);
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
    this.stats.claimed = this.claims.size;
    this.stats.columns += inst.cols.length;
  }

  /** a building's cells were cut or it hangs free: let it go to rubble, take its pieces away behind dust */
  private lost(inst: ExternalInstance): void {
    let b: number | undefined;
    for (const [k, v] of this.claims) if (v.id === inst.id) b = k;
    if (b === undefined) return;
    const ext = this.io.external()!;
    this.claims.delete(b);
    ext.release(inst.id);
    this.gone.add(b);
    this.stats.cut++;
    if (this.io.dust)
      for (const c of inst.cols.filter((_, i) => i % 3 === 0)) this.io.dust(c.x, c.y, (c.z0 + c.z1) / 2, 6);
    this.show();
  }

  /** the pieces of what still stands */
  private show(): void {
    if (!this.gone.size) {
      this.sg.set(this.all);
      this.stats.pieces = this.all.count;
      return;
    }
    const keep: number[] = [];
    for (let i = 0; i < this.all.count; i++) if (!this.gone.has(this.all.building[i])) keep.push(i);
    const data = new Float32Array(keep.length * PIECE_FLOATS);
    keep.forEach((s, d) => data.set(this.all.data.subarray(s * PIECE_FLOATS, (s + 1) * PIECE_FLOATS), d * PIECE_FLOATS));
    this.sg.set({ module: Uint16Array.from(keep, (i) => this.all.module[i]), data, building: Int32Array.from(keep, (i) => this.all.building[i]), count: keep.length });
    this.stats.pieces = keep.length;
  }

  /** before the window slides by (dx, dy) columns: buildings that would leave let go of their columns (to air) */
  beforeSlide(dx: number, dy: number): void {
    const ext = this.io.external();
    if (!ext || !this.claimed) return;
    const { w, h } = this.io.dims;
    for (const [b, inst] of [...this.claims]) {
      const leaves = inst.cols.some((c) => c.x - dx < 0 || c.y - dy < 0 || c.x - dx >= w || c.y - dy >= h);
      if (!leaves) continue;
      ext.release(inst.id, true);
      this.claims.delete(b);
      this.away.add(b);
    }
  }

  /** after it slid: the plan's frame moves with the land; buildings all back in the window claim again */
  slid(dx: number, dy: number): void {
    const ox = dx;
    const oy = dy * ROW_H;
    const d = this.all.data;
    for (let i = 0; i < this.all.count; i++)
      for (let k = 0; k < 4; k++) {
        d[i * PIECE_FLOATS + k * 2] -= ox;
        d[i * PIECE_FLOATS + k * 2 + 1] -= oy;
      }
    for (const cs of this.cols.values())
      for (const c of cs) {
        c.x -= dx;
        c.y -= dy;
      }
    this.show();
    if (this.claimed) for (const b of [...this.away]) this.claim(b);
  }
}
