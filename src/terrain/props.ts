// Terrain track (round 117): where things lie buried — skew stones, statues, fallen columns and slabs, ruins — and the
// excavation sites they cluster in (api/contracts/terrain.ts BuriedProp, ExcavationSite). Pure: from the seed and the
// land's samples; unit-tested in props.test.ts.
//
// The user (DECISIONS round 117): "I want more meshes buried in the terrain. The whole point of having an other type and
// interval is we can actually have buried statues and fallen structures and stones. These being skew add visual interest
// and they make great props for telekenisis or excavation sites."
//
// Why it's decided per world tile (PROP_TILE units, a hash of the seed and the tile), not per request: the same land must
// hold the same things whatever rectangle asks, and a run's plan and the streamed land must agree. What a statue looks
// like is structures' (its contract's asset, by kind); who draws it and holds its cells is an External owner (sim/
// external.ts; the un-burying physics is testkit's tests). This only says where, how deep and how tilted.

import type { BuriedProp, ExcavationSite, V2 } from '../api/contracts';
import { depthAt, type TerrainSamples } from './partition';

/** world units a side of the tiles props are decided in */
export const PROP_TILE = 128;
/** a tile's chance of an excavation site (on dry ground not too steep) */
const SITE_CHANCE = 0.05;

/** a small deterministic generator from integers (mulberry32 over a hash) */
function rngOf(...k: number[]): () => number {
  let h = 0x9e3779b9;
  for (const v of k) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b);
    h = (h ^ (h >>> 13)) >>> 0;
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the sample nearest a world point (−1 outside) */
function sampleAt(S: TerrainSamples, p: V2): number {
  const x = Math.round((p[0] - S.x0) / S.step);
  const y = Math.round((p[1] - S.y0) / S.step);
  return x < 0 || y < 0 || x >= S.w || y >= S.h ? -1 : y * S.w + x;
}

/** the ground's steepest rise to a neighbour sample (cells a cell) */
function slopeAt(S: TerrainSamples, i: number): number {
  const x = i % S.w;
  const y = (i - x) / S.w;
  let m = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= S.w || ny >= S.h) continue;
    m = Math.max(m, Math.abs(S.ground[ny * S.w + nx] - S.ground[i]) / S.step);
  }
  return m;
}

/**
 * The props and sites of the tiles whose corner lies in [x0, x1) × [y0, y1) — S must cover those tiles (sampled over
 * the tile-aligned rectangle). Ids are the tile's (x, y: 16 bits each) × 64 + k: the same whatever rectangle asks.
 */
export function placeBuried(S: TerrainSamples, seed: number, rect: { x0: number; y0: number; x1: number; y1: number }): { props: BuriedProp[]; sites: ExcavationSite[] } {
  const props: BuriedProp[] = [];
  const sites: ExcavationSite[] = [];
  const tx0 = Math.floor(rect.x0 / PROP_TILE);
  const ty0 = Math.floor(rect.y0 / PROP_TILE);
  const tx1 = Math.ceil(rect.x1 / PROP_TILE);
  const ty1 = Math.ceil(rect.y1 / PROP_TILE);
  const add = (p: Omit<BuriedProp, 'id' | 'z'>, tid: number, k: number): BuriedProp | null => {
    const i = sampleAt(S, p.at);
    if (i < 0 || depthAt(S, i) > 0.3 || S.lava[i]) return null;
    const P: BuriedProp = { ...p, id: tid * 64 + k, z: S.ground[i] };
    props.push(P);
    return P;
  };
  for (let ty = ty0; ty < ty1; ty++)
    for (let tx = tx0; tx < tx1; tx++) {
      const r = rngOf(seed, tx, ty, 0x6b1d);
      // (an id from the tile itself, so the same prop has the same id whatever rectangle asked)
      const tid = ((tx & 0xffff) * 65536 + (ty & 0xffff)) * 1;
      const cx = (tx + r()) * PROP_TILE;
      const cy = (ty + r()) * PROP_TILE;
      const ci = sampleAt(S, [cx, cy]);
      let k = 0;
      // an excavation site: statues, columns and slabs of a ruin, skew, half sunk, round a middle
      if (ci >= 0 && r() < SITE_CHANCE && depthAt(S, ci) === 0 && slopeAt(S, ci) < 0.6) {
        const site: ExcavationSite = { id: sites.length, at: [cx, cy], radius: 10 + 14 * r(), props: [] };
        const n = 3 + Math.floor(r() * 5);
        for (let j = 0; j < n; j++) {
          const a = r() * Math.PI * 2;
          const d = site.radius * Math.sqrt(r());
          const pick = r();
          const kind: BuriedProp['kind'] = pick < 0.35 ? 'statue' : pick < 0.65 ? 'column' : pick < 0.85 ? 'slab' : 'ruin';
          const P = add(
            {
              kind,
              at: [cx + Math.cos(a) * d, cy + Math.sin(a) * d],
              size: kind === 'statue' ? 5 + 7 * r() : kind === 'column' ? 8 + 10 * r() : kind === 'slab' ? 4 + 4 * r() : 10 + 10 * r(),
              yaw: r() * Math.PI * 2,
              // (a column lies fallen, nearly flat; a statue leans; a slab tips up out of the ground)
              tilt: kind === 'column' ? 1.2 + 0.35 * r() : kind === 'statue' ? 0.15 + 0.7 * r() : 0.2 + 0.9 * r(),
              tiltAxis: r() * Math.PI * 2,
              buried: 0.3 + 0.5 * r(),
              site: site.id,
            },
            tid,
            k++,
          );
          if (P) site.props.push(P.id);
        }
        if (site.props.length) sites.push(site);
      }
      // stones on their own: where the ground is steep (a cliff's foot, a bank) more of them, skew, half sunk
      const tries = 3;
      for (let j = 0; j < tries; j++) {
        const at: V2 = [(tx + r()) * PROP_TILE, (ty + r()) * PROP_TILE];
        const i = sampleAt(S, at);
        const chance = i < 0 ? 0 : 0.08 + 0.5 * Math.min(1, slopeAt(S, i) / 2);
        const keep = r() < chance;
        const size = 2 + 6 * r() * r();
        const yaw = r() * Math.PI * 2;
        const tilt = 0.2 + 0.8 * r();
        const axis = r() * Math.PI * 2;
        const buried = 0.25 + 0.5 * r();
        if (keep) add({ kind: 'stone', at, size, yaw, tilt, tiltAxis: axis, buried, site: -1 }, tid, k++);
      }
    }
  // only what's inside the rectangle asked for
  const inside = (p: V2) => p[0] >= rect.x0 && p[0] < rect.x1 && p[1] >= rect.y0 && p[1] < rect.y1;
  const kept = props.filter((p) => inside(p.at));
  const keptIds = new Set(kept.map((p) => p.id));
  return { props: kept, sites: sites.filter((s) => inside(s.at)).map((s) => ({ ...s, props: s.props.filter((id) => keptIds.has(id)) })) };
}
