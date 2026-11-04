// (round 128e, FT-48; the user: "Inspect doesn't work on the generated town and it should") What a town has at a point:
// one of its buildings (a house, the hall, a granary …; a landmark on it — the keep, a tower, a dome), or its wall. Read
// from the town's plan (CityPlan) in its box's frame. Pure: no GPU, no DOM. The fortress's Inspect card for it:
// fortress/townpick.ts.
import type { CityPlan, MegaKind } from '../api/contracts/structures';

type Pt = [number, number];

export interface TownThing {
  kind: 'building' | 'wall';
  /** what the town uses a building for (settle/plan.ts lotUse: house, hall, granary, workshop, warehouse, sawmill, stable, temple, ruin, site) */
  use?: string;
  /** a landmark standing on it */
  mega?: MegaKind;
  /** storeys standing (0: not built yet) and tiles it covers */
  storeys?: number;
  tiles?: number;
  /** a wall: its length and height (m) */
  length?: number;
  height?: number;
  /** its top (the plan's world z): a ray from the camera meets it below this */
  top: number;
}

/** whether p is inside the counter-clockwise quad q of the plan's tiles */
function inQuad(city: CityPlan, q: number, p: Pt): boolean {
  const t = city.tiles;
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = t.quads[q * 4 + k];
    const b = t.quads[q * 4 + ((k + 1) & 3)];
    const ax = t.verts[a * 2];
    const ay = t.verts[a * 2 + 1];
    const cr = (t.verts[b * 2] - ax) * (p[1] - ay) - (t.verts[b * 2 + 1] - ay) * (p[0] - ax);
    const s = Math.sign(cr);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** the distance from p to the segment ab */
function toSegment(p: Pt, a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

/** What the town has at p (its box's frame): a building standing there, else its wall within reach. */
export function townThingAt(city: CityPlan, standing: Int32Array, lotUse: Map<string, string>, p: Pt): TownThing | null {
  const n = city.tiles.quads.length / 4;
  for (let q = 0; q < n; q++) {
    const b = city.quadBuilding[q];
    if (b < 0 || !inQuad(city, q, p)) continue;
    const rec = city.buildings[b];
    const m = city.megas.find((x) => x.quads.some((y) => rec.quads.includes(y)));
    const storeys = standing[b] ?? rec.storeys;
    const top = Math.max(rec.base + storeys * rec.storeyH + (city.roofRise?.[b] ?? 0), m ? m.z1 : -Infinity);
    return { kind: 'building', use: lotUse.get(`b${b}`) ?? rec.kind, mega: m?.kind, storeys, tiles: rec.quads.length, top };
  }
  for (const f of city.linear) {
    if (f.kind !== 'wall') continue;
    const pts = f.points;
    const segs = f.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (toSegment(p, a, b) > f.width / 2 + 1) continue;
      let length = 0;
      for (let k = 0; k < segs; k++) length += Math.hypot(pts[(k + 1) % pts.length][0] - pts[k][0], pts[(k + 1) % pts.length][1] - pts[k][1]);
      const height = Math.max(...pts.map((q, k) => q[2] - f.ground[k]));
      return { kind: 'wall', length, height, top: Math.max(...pts.map((q) => q[2])) };
    }
  }
  return null;
}
