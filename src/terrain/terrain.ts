// Terrain track (round 117): the terrain system — api/contracts/terrain.ts `Terrain` over the atlas. The region graph
// (sample.ts on the GPU → partition.ts), the requests that open or close borders (edits stamped into the land as it
// is made: the atlas's stampHooks; and needs other tracks build — bridges, vegetation), and the basin flood
// (flood.ts).
//
// Why edits are stamps: the atlas makes land a region at a time as the window streams; a stamp hook says what goes in
// each column of each region as it's made (atlas/stamps.ts — the same operations on the GPU's path and the CPU's), so an
// edit made before the land streams in is simply part of it (deterministic from the seed and the edit list). Land
// already in the window isn't remade by a request (a run plans its graph before it arrives); the run manager plans first.

import type { Atlas } from '../atlas/atlas';
import type { StampOps } from '../atlas/stamps';
import { ROW_H } from '../world/lattice';
import type { AtlasRegionGraph, BuriedProp, ExcavationSite, FloodRequest, FloodResult, PassCaps, Terrain, TerrainEdit, TerrainGraph, TerrainNeed, TerrainRequest, TerrainResult, V2 } from '../api/contracts';
import { CAPS_PRESETS } from '../api/contracts/terrain';
import { depthAt, partition, RegionGraph, SCREEN_AREA } from './partition';
import { LandSampler } from './sample';
import { FloodField } from './flood';
import { placeBuried, PROP_TILE } from './props';
import { atlasGraph } from './atlasgraph';

/** a rock fill's material and a ford's (world/materials.ts MAT: Stone, Rubble) */
const MAT_STONE = 1;
const MAT_RUBBLE = 4;
/** a ramp's slope as a share of the controller's steepest (some margin: the ground's noise on top) */
const RAMP_SHARE = 0.75;
/** water wider than this (world units) is bridged (a need), not forded */
const FORD_MAX = 48;
/** a wall's height (cells) and the margin either side of a door it closes (world units) */
const WALL_H = 9;

const wrapD = (d: number, W: number) => d - Math.round(d / W) * W;

/** the planar distance from p to segment a–b and how far along it (0..1) */
function segDist(px: number, py: number, a: V2, b: V2): [number, number] {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const l2 = ux * ux + uy * uy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - a[0]) * ux + (py - a[1]) * uy) / l2)) : 0;
  return [Math.hypot(px - (a[0] + ux * t), py - (a[1] + uy * t)), t];
}

export class TerrainSystem implements Terrain {
  private sampler: LandSampler;
  private list: TerrainEdit[] = [];
  /** world units: every edit's bounds (a region's hook skips the edits that don't reach it) */
  constructor(readonly atlas: Atlas) {
    this.sampler = new LandSampler(atlas);
    // (the sampler's pipeline compiled in the background as the system is made: the first graph doesn't wait for it)
    if (atlas.device) void this.sampler.warm();
    atlas.stampHooks.push(async (ops, x0, y0, w, h) => this.stamp(ops, x0, y0, w, h));
  }

  async graph(rect: { x0: number; y0: number; x1: number; y1: number }, opts: { caps?: PassCaps; step?: number; screen?: number } = {}): Promise<TerrainGraph> {
    const step = opts.step ?? 4;
    const w = Math.max(1, Math.round((rect.x1 - rect.x0) / step));
    const h = Math.max(1, Math.round((rect.y1 - rect.y0) / step));
    const S = await this.sampler.sample(rect.x0, rect.y0, w, h, step);
    return new RegionGraph(partition(S, { caps: opts.caps, screen: opts.screen ?? SCREEN_AREA }));
  }

  /** the samples themselves (the viewer draws them) */
  sample(x0: number, y0: number, w: number, h: number, step: number) {
    return this.sampler.sample(x0, y0, w, h, step);
  }

  private atlasG?: AtlasRegionGraph;
  /** the atlas's regions as a graph (atlasgraph.ts; made once) */
  atlasGraph(): AtlasRegionGraph {
    return (this.atlasG ??= atlasGraph(this.atlas));
  }

  /** what lies buried in a rectangle (props.ts: decided per world tile, so any rectangle agrees) */
  async buried(rect: { x0: number; y0: number; x1: number; y1: number }): Promise<{ props: BuriedProp[]; sites: ExcavationSite[] }> {
    const x0 = Math.floor(rect.x0 / PROP_TILE) * PROP_TILE;
    const y0 = Math.floor(rect.y0 / PROP_TILE) * PROP_TILE;
    const x1 = Math.ceil(rect.x1 / PROP_TILE) * PROP_TILE;
    const y1 = Math.ceil(rect.y1 / PROP_TILE) * PROP_TILE;
    const step = 4;
    const S = await this.sampler.sample(x0, y0, Math.round((x1 - x0) / step) + 1, Math.round((y1 - y0) / step) + 1, step);
    return placeBuried(S, this.atlas.p.seed, rect);
  }

  edits(): TerrainEdit[] {
    return this.list.slice();
  }

  private floods?: FloodField;
  /** a basin flooded (flood.ts: a GPU height flood fill into the atlas's basins) */
  flood(req: FloodRequest): Promise<FloodResult> {
    return this.floodTool.flood(req);
  }
  get floodTool(): FloodField {
    return (this.floods ??= new FloodField(this.atlas));
  }

  request(graph: TerrainGraph, req: TerrainRequest): TerrainResult {
    const g = graph as RegionGraph;
    const edits: TerrainEdit[] = [];
    const needs: TerrainNeed[] = [];
    const done = (ok: boolean, reason?: string): TerrainResult => ({ ok, reason, edits, needs, graph: g });
    if (req.kind === 'open') return this.open(g, req.border, req.caps, g.border(req.border).a, edits, needs) ? done(true) : done(false, 'no crossing to open');
    if (req.kind === 'obstacle') {
      this.close(g, req.border, req.barrier, edits, needs);
      return done(true);
    }
    const { room, count, caps } = req;
    const cur = g.exits(room, caps);
    if (cur.length < count) {
      // the barriers out of the room, cheapest to open first (a short ramp, a narrow ford before a bridge)
      const shut = g.borders(room).filter((b) => g.cost(b.id, caps, room) === Infinity);
      const scored = shut.map((b) => ({ b, fix: this.fixCost(g, b.id, caps, room) })).filter((s) => s.fix < Infinity).sort((x, y) => x.fix - y.fix);
      for (const s of scored.slice(0, count - cur.length)) this.open(g, s.b.id, caps, room, edits, needs);
      const now = g.exits(room, caps).length;
      return now >= count ? done(true) : done(false, `only ${now} exits could be made (${shut.length} barriers, ${scored.length} openable)`);
    }
    if (cur.length > count) {
      // close the doors that are easiest to close (the narrowest openings first); barriers it crosses stay as they are
      // unless they're all that's left
      const open = cur
        .map((e) => ({ e, B: g.border(e.border) }))
        .sort((x, y) => (x.B.kind === 'open' ? 0 : 1) - (y.B.kind === 'open' ? 0 : 1) || x.B.length - y.B.length);
      for (const { e } of open.slice(0, cur.length - count)) this.close(g, e.border, 'wall', edits, needs);
    }
    return done(true);
  }

  /** what opening a border would cost (world units of edit or build), Infinity: nothing this system knows opens it */
  private fixCost(g: RegionGraph, border: number, caps: PassCaps, from: number): number {
    const B = g.border(border);
    const m = B.measure;
    switch (B.kind) {
      case 'river':
      case 'lake':
      case 'sea':
        return m.minWaterSpan <= FORD_MAX ? m.minWaterSpan : 3 * m.minWaterSpan;
      case 'cliff':
      case 'steep':
      case 'ridge':
        return Math.abs(m.rise) / (RAMP_SHARE * Math.max(caps.slope, 0.1));
      case 'ravine':
      case 'lava':
        return 4 * Math.max(m.minGap, 8);
      case 'vegetation':
        return 2 * g.step * 8;
      default:
        return from >= 0 ? Infinity : Infinity;
    }
  }

  /** the shortest line across a border, ignoring what's in the way: its samples */
  private across(g: RegionGraph, border: number, from: number, keep: Partial<PassCaps>): number[] {
    const probe: PassCaps = { id: `probe:${JSON.stringify(keep)}`, step: Infinity, slope: Infinity, drop: Infinity, deep: Infinity, lava: true, veg: 1, speed: 1, ...keep };
    return g.route(border, probe, from);
  }

  private edit(e: Omit<TerrainEdit, 'id'>, edits: TerrainEdit[]): TerrainEdit {
    const E = { ...e, id: this.list.length };
    this.list.push(E);
    edits.push(E);
    return E;
  }

  private open(g: RegionGraph, border: number, caps: PassCaps, from: number, edits: TerrainEdit[], needs: TerrainNeed[]): boolean {
    const B = g.border(border);
    const S = g.built.S;
    const path = this.across(g, border, from, {});
    if (path.length < 2) return false;
    const at = (i: number) => g.at(i);
    const inRoom = (i: number) => g.built.room[i] >= 0;
    // the stretch of the path outside both rooms (the barrier), widened a sample each way
    let i0 = 0;
    while (i0 < path.length - 1 && inRoom(path[i0 + 1])) i0++;
    let i1 = path.length - 1;
    while (i1 > 0 && inRoom(path[i1 - 1])) i1--;
    if (i1 < i0) [i0, i1] = [i1, i0];
    const a = path[i0];
    const b = path[i1];
    const mid = at(path[(i0 + i1) >> 1]);
    const width = 3 * g.step;
    switch (B.kind) {
      case 'river':
      case 'lake':
      case 'sea': {
        const wet = path.filter((i) => depthAt(S, i) > 0);
        const span = wet.length * g.step;
        if (span > FORD_MAX || !wet.length) {
          needs.push({ kind: 'bridge', border, at: mid, a: at(a), b: at(b), za: S.ground[a], zb: S.ground[b], width });
          g.addMade(border, { at: mid, width, kind: 'bridge', edit: -1 }, () => true, path.length * g.step);
          return true;
        }
        const level = Math.min(...wet.map((i) => S.water[i]));
        const z = level - 0.4;
        const E = this.edit({ kind: 'ford', a: at(wet[0]), b: at(wet[wet.length - 1]), za: z, zb: z, half: width / 2, border }, edits);
        g.addMade(border, { at: mid, width, kind: 'ford', edit: E.id }, (c) => !!c.fly || c.deep >= 0.4, path.length * g.step * 1.5);
        return true;
      }
      case 'cliff':
      case 'steep':
      case 'ridge': {
        // a ramp from the lower room's floor to the upper's, long enough for the body's slope, run out into the lower room
        let lo = a;
        let hi = b;
        if (S.ground[lo] > S.ground[hi]) [lo, hi] = [hi, lo];
        const zl = S.ground[lo];
        const zh = S.ground[hi];
        const slope = RAMP_SHARE * Math.max(caps.slope, 0.1);
        const need = (zh - zl) / slope;
        const pl = at(lo);
        const ph = at(hi);
        let dx = ph[0] - pl[0];
        let dy = ph[1] - pl[1];
        const d = Math.hypot(dx, dy) || 1;
        dx /= d;
        dy /= d;
        const start: V2 = d >= need ? pl : [ph[0] - dx * need, ph[1] - dy * need];
        const E = this.edit({ kind: 'ramp', a: start, b: ph, za: zl, zb: zh, half: width / 2, border }, edits);
        g.addMade(border, { at: mid, width, kind: 'ramp', edit: E.id }, (c) => !!c.fly || c.slope >= slope * 0.99, Math.max(d, need) * 1.5);
        return true;
      }
      case 'ravine':
      case 'lava':
        needs.push({ kind: 'bridge', border, at: mid, a: at(a), b: at(b), za: S.ground[a], zb: S.ground[b], width });
        g.addMade(border, { at: mid, width, kind: 'bridge', edit: -1 }, () => true, (i1 - i0 + 2) * g.step);
        return true;
      case 'vegetation':
        needs.push({ kind: 'vegetation', border, at: mid, a: at(a), b: at(b), width });
        g.addMade(border, { at: mid, width, kind: 'cleared', edit: -1 }, () => true, (i1 - i0 + 2) * g.step);
        return true;
      default:
        return false;
    }
  }

  private close(g: RegionGraph, border: number, barrier: 'wall' | 'vegetation' | 'rubble' | 'ravine', edits: TerrainEdit[], needs: TerrainNeed[]): void {
    const B = g.border(border);
    const S = g.built.S;
    const P = g.built.pairs[border];
    // the border's line: its two crossing pairs farthest apart across the rooms' line
    const ca = g.region(B.a).centre;
    const cb = g.region(B.b).centre;
    let ux = cb[0] - ca[0];
    let uy = cb[1] - ca[1];
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    let lo = Infinity;
    let hi = -Infinity;
    let pa: V2 = ca;
    let pb: V2 = cb;
    let zs = 0;
    for (let k = 0; k < P.length; k += 2) {
      const p = g.at(P[k]);
      const s = -uy * p[0] + ux * p[1];
      zs = Math.max(zs, S.ground[P[k]], S.ground[P[k + 1]]);
      if (s < lo) (lo = s), (pa = p);
      if (s > hi) (hi = s), (pb = p);
    }
    const ext = 2 * g.step;
    const a: V2 = [pa[0] + uy * ext, pa[1] - ux * ext];
    const b: V2 = [pb[0] - uy * ext, pb[1] + ux * ext];
    const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (barrier === 'vegetation') {
      needs.push({ kind: 'vegetation', border, at: mid, a, b, width });
      g.addClosed(border, (c) => c.veg >= 0.95 || !!c.vegCost || !!c.fly);
      return;
    }
    if (barrier === 'ravine') {
      this.edit({ kind: 'cut', a, b, za: zs - 30, zb: zs - 30, half: 2 * g.step, border }, edits);
      g.addClosed(border, (c) => (c.fly ?? 0) >= 30 || (c.gap ?? 0) >= 4 * g.step);
      return;
    }
    if (barrier === 'rubble') needs.push({ kind: 'rubble', border, at: mid, a, b, width });
    this.edit({ kind: 'wall', a, b, za: zs, zb: zs, half: g.step, height: WALL_H, border }, edits);
    g.addClosed(border, (c) => c.step + (c.fly ?? 0) >= WALL_H + 1);
  }

  /** the edits into a region's columns as it's made (atlas stampHooks: world cells x0.. × y0..) */
  private stamp(ops: StampOps, x0: number, y0: number, w: number, h: number): void {
    if (!this.list.length) return;
    const W = this.atlas.worldW;
    const H = this.atlas.worldH;
    const bx = x0 + w / 2 + 0.5;
    const by = (y0 + h / 2) * ROW_H;
    const reach = Math.hypot(w, h * ROW_H) / 2;
    for (const e of this.list) {
      // (the edit near the region: its line within reach, round the torus)
      const ea: V2 = [bx + wrapD(e.a[0] - bx, W), by + wrapD(e.a[1] - by, H)];
      const eb: V2 = [ea[0] + wrapD(e.b[0] - e.a[0], W), ea[1] + wrapD(e.b[1] - e.a[1], H)];
      if (segDist(bx, by, ea, eb)[0] > reach + e.half + 4) continue;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const px = x0 + x + 0.5 + 0.5 * ((y0 + y) & 1);
          const py = (y0 + y + 0.5) * ROW_H;
          const [d, t] = segDist(px, py, ea, eb);
          if (d > e.half) continue;
          const i = y * w + x;
          const z = e.za + (e.zb - e.za) * t;
          switch (e.kind) {
            case 'ramp':
            case 'ford':
              // the column made exactly this high, solid 40 cells under it (a fill over a hollow, a cut through a cliff)
              ops.plan(i, z - 40, [{ z0: z - 40, z1: z, mat: e.kind === 'ford' ? MAT_RUBBLE : MAT_STONE }], e.kind === 'ford');
              break;
            case 'wall':
              ops.plan(i, z - 40, [{ z0: z - 40, z1: z + (e.height ?? WALL_H), mat: MAT_STONE }], true);
              break;
            case 'cut':
              ops.plan(i, z, [], true);
              break;
            case 'tunnel':
              ops.plan(i, 1e5, [], true, 0, [z, z + (e.height ?? 6)]);
              break;
          }
        }
    }
  }
}

export { CAPS_PRESETS };
