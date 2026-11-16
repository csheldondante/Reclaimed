// (loop-skeleton round 3; BACKLOG LS-3) the home town's sites placed on a made-up town: a river down one side, three
// roads. Node only.
import { describe, expect, it } from 'vitest';
import { SITES } from '../../src/season/realm-templates';
import { declutter, placeSites, type P2, type TownShape } from '../../src/season/sites';

const R = 120;
/** a river 12 cells wide running north-south 40 cells east of the centre; ground rising to the west */
const river = (x: number) => Math.abs(x - 40) < 6;
const town: TownShape = {
  centre: [0, 0],
  R,
  roads: [
    [[0, 0], [-60, 10], [-130, 20]],
    [[0, 0], [10, 70], [20, 130]],
    [[0, 0], [-20, -70], [-30, -130]],
  ],
  dry: (x) => !river(x),
  height: (x) => -x,
};
const roadDist = (p: P2) => {
  let d = Infinity;
  for (const r of town.roads)
    for (let i = 0; i + 1 < r.length; i++) {
      const [a, b] = [r[i], r[i + 1]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
  return d;
};

describe('the home town\'s sites (season/sites.ts)', () => {
  const at = placeSites(town);
  it('every site has a place, on dry land, off the roads, inside the town\'s reach', () => {
    for (const s of SITES) {
      const p = at[s.key];
      expect(p, s.key).toBeDefined();
      expect(town.dry(p[0], p[1]), `${s.key} dry`).toBe(true);
      expect(roadDist(p), `${s.key} off the road`).toBeGreaterThanOrEqual(5);
      expect(Math.hypot(p[0], p[1]), `${s.key} in reach`).toBeLessThanOrEqual(R * 0.7);
    }
  });
  it('no two sites share a place: their names have room', () => {
    const ps = SITES.map((s) => at[s.key]);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) expect(Math.hypot(ps[i][0] - ps[j][0], ps[i][1] - ps[j][1]), `${SITES[i].key} / ${SITES[j].key}`).toBeGreaterThanOrEqual(0.09 * R);
  });
  it('a site is where its kind is: the gate beside its road, the waterside on the bank, the tower on higher ground than the market', () => {
    expect(roadDist(at.gate)).toBeLessThan(12);
    expect(roadDist(at.road)).toBeLessThan(12);
    for (const k of ['harbour', 'river', 'dam'] as const) expect(Math.abs(at[k][0] - 40), k).toBeLessThan(6 + 10);
    expect(town.height(at.tower[0], at.tower[1])).toBeGreaterThan(town.height(at.market[0], at.market[1]));
    expect(Math.hypot(at.market[0], at.market[1])).toBeLessThan(0.3 * R);
  });
  it('a town with no water and no roads still places every site', () => {
    const bare = placeSites({ ...town, roads: [], dry: () => true });
    expect(Object.keys(bare).length).toBe(SITES.length);
  });
});

describe('names over the map kept apart (declutter)', () => {
  it('labels that would stack are moved a row apart, and none runs off the screen', () => {
    const out = declutter(
      [
        { x: 30, y: 400, chars: 28 },
        { x: 60, y: 404, chars: 26 },
        { x: 400, y: 410, chars: 30 },
        { x: 200, y: 300, chars: 20 },
      ],
      412,
      80,
      600,
    );
    const box = (p: P2, chars: number) => ({ x0: p[0] - (8.2 * chars + 26) / 2, x1: p[0] + (8.2 * chars + 26) / 2, y0: p[1] - 32, y1: p[1] });
    const bs = out.map((p, i) => box(p, [28, 26, 30, 20][i]));
    for (const b of bs) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(412);
    }
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(bs[i].x0 < bs[j].x1 && bs[j].x0 < bs[i].x1 && bs[i].y0 < bs[j].y1 && bs[j].y0 < bs[i].y1, `${i}/${j}`).toBe(false);
  });
});
