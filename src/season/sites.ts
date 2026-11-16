// (loop-skeleton round 3; BACKLOG LS-3) Where the home town's sites are: each at a real, relevant place of the town as
// it is laid out — a gate's on its road and beside it, the waterside's on a bank, the tower's on high ground, the
// market's by the heart — never in water, never on a road, and apart from each other so their names don't stack.
// Pure: the town's shape in, a point a site out. What the CPU knows of a town is its centre, its reach, its approach
// roads and the atlas's ground and rivers (the lots are the GPU's: a site is a place among them, not a lot's record).
// FIXED-CITY: the sites are one town's (the home town's), placed once for the run.
import { SITES, type SiteKey } from './realm-templates';

export type P2 = [number, number];

export interface TownShape {
  /** the town's centre and reach (R: cells) — any frame, x in cells and y in world units */
  centre: P2;
  R: number;
  /** the approach roads, each from the town outward */
  roads: readonly (readonly (readonly [number, number])[])[];
  /** dry land (not sea, lake or river) */
  dry(x: number, y: number): boolean;
  /** the ground's height (the atlas's coarse ground is enough: which of two places is higher) */
  height(x: number, y: number): number;
}

/** cells a site keeps from a road's line, and from water when it looks for a bank */
const OFF_ROAD = 6;
const BANK = 9;
/** how far from the heart a site may stand, as a share of the town's reach: the whole set fits a phone's screen with
 *  the town framed (scenes/level/loop.ts showTown) */
export const REACH = 0.62;

function segDist(p: P2, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** the point `d` along a road from its first point, and the road's direction there */
function along(road: readonly (readonly [number, number])[], d: number): { at: P2; dir: P2 } | null {
  if (road.length < 2) return null;
  let left = d;
  for (let i = 0; i + 1 < road.length; i++) {
    const a = road[i];
    const b = road[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!l) continue;
    if (left <= l || i + 2 === road.length) {
      const t = Math.min(1, left / l);
      return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
    }
    left -= l;
  }
  return null;
}

export function placeSites(t: TownShape): Record<SiteKey, P2> {
  const { centre: c, R } = t;
  const out = new Map<SiteKey, P2>();
  const roadDist = (p: P2) => {
    let d = Infinity;
    for (const r of t.roads) for (let i = 0; i + 1 < r.length; i++) d = Math.min(d, segDist(p, r[i], r[i + 1]));
    return d;
  };
  const far = (p: P2, d: number) => [...out.values()].every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= d);
  const ok = (p: P2) => t.dry(p[0], p[1]) && roadDist(p) >= OFF_ROAD - 0.5;
  const ring = (r: number, n: number, phase = 0): P2[] => Array.from({ length: n }, (_, k) => [c[0] + Math.cos(phase + (k / n) * Math.PI * 2) * r, c[1] + Math.sin(phase + (k / n) * Math.PI * 2) * r] as P2);
  const wet = (p: P2) => ring(BANK, 8).some((q) => !t.dry(p[0] + q[0] - c[0], p[1] + q[1] - c[1]));

  // 1 the road's own: beside a road, a way out along it
  const byRoad: [SiteKey, number, number][] = [
    ['gate', 0, 0.36],
    ['road', 0, 0.6],
    ['watch', 1, 0.4],
    ['wall', 2, 0.36],
    ['wagons', 1, 0.6],
  ];
  for (const [key, k, share] of byRoad) {
    if (!t.roads.length) break;
    const road = t.roads[k % t.roads.length];
    search: for (let step = 0; step < 8; step++) {
      for (const side of k % 2 ? [-1, 1] : [1, -1]) {
        const a = along(road, (share + (step % 2 ? -1 : 1) * 0.05 * Math.ceil(step / 2)) * R);
        if (!a) continue;
        const p: P2 = [a.at[0] - a.dir[1] * side * (OFF_ROAD + 2), a.at[1] + a.dir[0] * side * (OFF_ROAD + 2)];
        if (ok(p) && far(p, 0.12 * R)) {
          out.set(key, p);
          break search;
        }
      }
    }
  }

  // 2 the water's: on a bank (dry, water a few cells off), apart from each other
  const bank: P2[] = [];
  for (let r = 0.12; r <= REACH; r += 0.05) for (const p of ring(r * R, 40, r * 7)) if (ok(p) && wet(p)) bank.push(p);
  bank.sort((a, b) => Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]));
  // (the dam first: the bank nearest the heart, so what its water takes when it breaks is the built low ground — "the
  // lower town"; then the waterside and the crossing along the bank)
  for (const key of ['dam', 'harbour', 'river'] as const) {
    const p = bank.find((q) => far(q, 0.2 * R));
    if (p) out.set(key, p);
  }

  // 3 the town's own: round the heart, off the roads
  const inner: SiteKey[] = ['market', 'keep', 'forge', 'quarter', 'mill', 'pit'];
  for (let i = 1, k = 0; i <= 240 && k < inner.length; i++) {
    const r = R * (0.05 + 0.32 * Math.sqrt(i / 240));
    const p: P2 = [c[0] + Math.cos(i * 2.39996) * r, c[1] + Math.sin(i * 2.39996) * r];
    if (ok(p) && far(p, 0.12 * R)) out.set(inner[k++], p);
  }

  // 4 high places: the tower in the town, the quarry and the shrine on the heights round it
  const high = (r0: number, r1: number, apart: number): P2 | null => {
    const cands: P2[] = [];
    for (let r = r0; r <= r1; r += 0.06) for (const p of ring(r * R, 32, r * 5)) if (ok(p) && far(p, apart * R)) cands.push(p);
    cands.sort((a, b) => t.height(b[0], b[1]) - t.height(a[0], a[1]));
    return cands[0] ?? null;
  };
  for (const [key, r0, r1, apart] of [
    ['tower', 0.2, 0.4, 0.12],
    ['quarry', 0.4, REACH, 0.16],
    ['shrine', 0.4, REACH, 0.25],
  ] as const) {
    const p = high(r0, r1, apart);
    if (p) out.set(key, p);
  }

  // 5 the land round it: fields and woods
  for (const key of ['fields', 'woods'] as const) {
    const p = ring(0.55 * R, 24, key === 'fields' ? 0.4 : 2.1).find((q) => ok(q) && far(q, 0.15 * R));
    if (p) out.set(key, p);
  }

  // (anything with no place of its kind — a town with no water has no bank: the nearest free dry place round the heart)
  for (const s of SITES) {
    if (out.has(s.key)) continue;
    let put: P2 | null = null;
    for (let i = 1; i <= 400 && !put; i++) {
      const r = R * (0.1 + (REACH - 0.1) * Math.sqrt(i / 400));
      const p: P2 = [c[0] + Math.cos(i * 2.39996 + 1) * r, c[1] + Math.sin(i * 2.39996 + 1) * r];
      if (ok(p) && far(p, 0.12 * R)) put = p;
    }
    out.set(s.key, put ?? [c[0], c[1]]);
  }
  return Object.fromEntries(out) as Record<SiteKey, P2>;
}

/** a name over the map: its anchor on the screen (px) and the text's length */
export interface Label {
  x: number;
  y: number;
  chars: number;
}

/**
 * Names over the map kept apart and on the screen (LS-3, LS-28): each label's box (its text's width, anchored at its
 * bottom middle) is slid sideways to stay inside the screen, then moved up or down a row at a time until it covers no
 * label placed before it. Returns the anchors to draw at, in the order given.
 */
export function declutter(labels: readonly Label[], width: number, top = 0, bottom = Infinity): P2[] {
  // (a name's row: 42 px, so each name keeps at least a thumb's 40 px of its own when names stack — round 4's touch
  // walk measured 38 with rows of 32)
  const H = 42;
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  return labels.map((l) => {
    const w = Math.min(width - 8, 8.2 * l.chars + 26);
    const x = Math.max(w / 2 + 4, Math.min(width - w / 2 - 4, l.x));
    for (const dy of [0, -H, H, -2 * H, 2 * H, -3 * H, 3 * H, -4 * H, 4 * H]) {
      const y = l.y + dy;
      if (y - H < top || y > bottom) continue;
      const b = { x0: x - w / 2, x1: x + w / 2, y0: y - H, y1: y };
      if (placed.some((q) => b.x0 < q.x1 && q.x0 < b.x1 && b.y0 < q.y1 && q.y0 < b.y1)) continue;
      placed.push(b);
      return [x, y] as P2;
    }
    placed.push({ x0: x - w / 2, x1: x + w / 2, y0: l.y - H, y1: l.y });
    return [x, l.y] as P2;
  });
}
