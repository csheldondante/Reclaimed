// The settlements' records (round 88; docs/SYSTEMS.md): every atlas site a Settlement record — its wiki id, name,
// region, realm, size, purpose — and the atlas roads into it. What's built there is the GPU town generator's
// (citygen/towns.ts FieldTowns: a village and up); this module only says where the towns are and what they're called.
// (Switchover, 2026-11-10: the old CPU planner that planned, stamped, drew, peopled and raided the towns from here is
// deleted — docs/design/SWITCHOVER.md. The user: "Stop wasting resources on old code.")
// API (window.reclaimed.settlements): near(at, r), settlement(id), all(), seeds, approachWays(id), regionAt(x, y).
// Positions in a record are world units (atlas x, y).
import type { Settlement } from '../api/contracts/settlement';
import type { RegionId } from '../api/contracts/world';
import type { V2 } from '../api/contracts/units';
import type { Atlas } from '../atlas/atlas';
import { ROW_H } from '../world/lattice';
import { atlasFacts } from '../gm/atlas-facts';
import { buildWiki, type WorldWiki } from '../gm/wiki';
import { recordsFrom, type SettlementSeed } from './records';
import { waysWithout } from '../atlas/ways';

/** a settlement's atlas roads (each from its end at the settlement), their points' graded z, its plaza's z */
interface ApproachWays {
  lines: [number, number][][];
  z: number[][];
  plaza: number;
}

export class Settlements {
  readonly wiki: WorldWiki;
  readonly seeds: SettlementSeed[];
  private recs = new Map<string, Settlement>();
  private cols: number;
  private rows: number;
  /** the ms the records took */
  stats = { recordsMs: 0 };
  /** (citygen M4a) the field towns' atlas roads as they were before their cores were cleared */
  private fieldRoads = new Map<string, ApproachWays>();

  constructor(private atlas: Atlas) {
    const t0 = performance.now();
    this.wiki = buildWiki(atlasFacts(atlas));
    this.seeds = recordsFrom(this.wiki, atlas.p.seed);
    for (const s of this.seeds) this.recs.set(s.rec.id, s.rec);
    this.cols = atlas.p.cols;
    this.rows = atlas.p.rows;
    this.stats.recordsMs = +(performance.now() - t0).toFixed(1);
  }

  settlement(id: string): Settlement | null {
    return this.recs.get(id) ?? null;
  }

  all(): Settlement[] {
    return [...this.recs.values()];
  }

  /** the settlements within `radius` (world units) of a world point, nearest first */
  near(at: V2, radius = 400): Settlement[] {
    return this.all()
      .map((s) => [this.dist(s.at, at), s] as const)
      .filter(([d]) => d <= radius)
      .sort((a, b) => a[0] - b[0])
      .map(([, s]) => s);
  }

  /**
   * (citygen M4a; M4b: every settlement `pick` gives a core — those with a grid) The settlements whose towns the GPU
   * field generator makes (citygen/): within `core` of each centre the atlas's own stamps go — its plaza and its roads'
   * graded fill (atlas/ways.ts waysWithout): the town lays its roads there itself. Asked once, before the first window's
   * land comes in (the level). Their atlas roads are kept as they were for approachWays.
   */
  byFields(pick: (s: SettlementSeed) => number | null): SettlementSeed[] {
    const out: { s: SettlementSeed; core: number; i: number }[] = [];
    this.seeds.forEach((s, i) => {
      const core = pick(s);
      if (core !== null) out.push({ s, core, i });
    });
    for (const [id, r] of this.waysOf(out.map((o) => o.s.rec.id))) this.fieldRoads.set(id, r);
    this.atlas.ways = waysWithout(this.atlas.ways, out.map((o) => ({ x: o.s.rec.at[0], y: o.s.rec.at[1], r: o.core, site: o.i })), this.atlas.worldW, this.atlas.worldH);
    return out.map((o) => o.s);
  }

  /**
   * (citygen M4a) The atlas roads into a settlement as they're stamped in the land (atlas/ways.ts: a point every 2
   * world units, graded and smoothed), each from its end at the settlement, unwrapped round its centre — authored data
   * the field generator takes for its arterials, so the town's main roads are the roads that come in.
   */
  approachWays(id: string): [number, number][][] {
    return this.approach(id).lines;
  }

  /**
   * (loop-streets) The same roads' heights: each point's graded z (world z: atlas/ways.ts — the macro ground smoothed
   * along the road and held to its grade), aligned with approachWays' points, and the settlement's plaza's z (the
   * atlas's plaza disc: its ground at the centre, over the sea). Authored data: a town grades its arterials and square
   * to them (docs/design/CITYGEN.md "Streets as terrain").
   */
  approachHeights(id: string): { z: number[][]; plaza: number } {
    const a = this.approach(id);
    return { z: a.z, plaza: a.plaza };
  }

  private approach(id: string): ApproachWays {
    // (a field town's: as they were before its core was cleared)
    return this.fieldRoads.get(id) ?? this.waysOf([id]).get(id)!;
  }

  /** the atlas roads into each of these settlements (approachWays), the ways' points walked once */
  private waysOf(ids: string[]): Map<string, ApproachWays> {
    const roads = this.atlas.settlement.roads;
    const W = this.atlas.worldW;
    const H = this.atlas.worldH;
    const wrap = (d: number, n: number) => d - Math.round(d / n) * n;
    const idx = new Map<number, string>();
    for (const id of ids) {
      const i = this.seeds.findIndex((x) => x.rec.id === id);
      if (i < 0) throw new Error(`settlements: no ${id}`);
      const site = this.atlas.settlement.sites[i];
      const at = this.seeds[i].rec.at;
      if (!site || Math.hypot(site.x - at[0], site.y - at[1]) > 1) throw new Error(`settlements: ${id} isn't atlas site ${i}`);
      idx.set(i, id);
    }
    // (site → way → its points, round the site's centre; (loop-streets) each site's plaza z — its disc's points, way
    // −1 − site)
    const by = new Map<number, Map<number, { i: number; x: number; y: number; z: number }[]>>();
    const plaza = new Map<number, number>();
    for (const p of this.atlas.ways.points) {
      if (p.way < 0 && idx.has(-1 - p.way)) plaza.set(-1 - p.way, p.z);
      const r = roads[p.way];
      if (!r) continue;
      for (const si of [r.a, r.b]) {
        if (!idx.has(si)) continue;
        const at = this.seeds[si].rec.at;
        const m = by.get(si) ?? by.set(si, new Map()).get(si)!;
        (m.get(p.way) ?? m.set(p.way, []).get(p.way)!).push({ i: p.i, x: at[0] + wrap(p.x - at[0], W), y: at[1] + wrap(p.y - at[1], H), z: p.z });
      }
    }
    const out = new Map<string, ApproachWays>();
    for (const [si, id] of idx) {
      const at = this.seeds[si].rec.at;
      const d = (p: { x: number; y: number }) => Math.hypot(p.x - at[0], p.y - at[1]);
      const ways = [...(by.get(si)?.values() ?? [])].map((ps) => {
        ps.sort((a, b) => a.i - b.i);
        return d(ps[0]) <= d(ps[ps.length - 1]) ? ps : ps.reverse();
      });
      const pz = plaza.get(si);
      if (pz === undefined) throw new Error(`settlements: ${id} has no plaza in the atlas's ways`);
      out.set(id, { lines: ways.map((ps) => ps.map((q): [number, number] => [q.x, q.y])), z: ways.map((ps) => ps.map((q) => q.z)), plaza: pz });
    }
    return out;
  }

  /** the atlas region at world (x, y) */
  regionAt(x: number, y: number): RegionId {
    const a = this.atlas;
    const n = a.p.n;
    const tx = this.mod(Math.floor((x / a.worldW) * n), n);
    const ty = this.mod(Math.floor((y / a.worldH) * n), n);
    return a.regionOf[ty * n + tx];
  }

  private dist(a: V2, b: V2): number {
    const W = this.cols;
    const H = this.rows * ROW_H;
    const dx = Math.abs(a[0] - b[0]) % W;
    const dy = Math.abs(a[1] - b[1]) % H;
    return Math.hypot(Math.min(dx, W - dx), Math.min(dy, H - dy));
  }

  private mod(v: number, n: number): number {
    return ((v % n) + n) % n;
  }
}
