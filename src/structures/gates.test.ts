// (round 128l) Every walled town has a way out by land. The user, on the phone, in the fortress's starting town (a port
// on a river mouth, walled, no roads of its own): "The city has ports and a wall but I don't see any gate so the only exit
// does look like it is into the sea"; "I mean towns should always have gates". Over many seeds, tile systems, sizes and
// grounds (a plain, a coast, a river, a river mouth on the coast, a mountain's foot): the wall leaves at least one gap
// that is a way out by land (structures/linear.ts landWay), and the bigger towns more. An island town is the only one
// allowed none. Node, no GPU: `npx vitest run src/structures/gates`.
import { describe, expect, it } from 'vitest';
import type { CityPlan, CitySpec, GroundFn } from '../api/contracts/structures';
import { planCity } from './plan';
import { landWay, landGatesFor } from './linear';
import { quadCentre } from './tiles/builder';
import { fbm } from './rng';

const SEA = 11;
const grounds: Record<string, (R: number) => GroundFn> = {
  plain: () => (x, y) => 12 + 1.5 * fbm(x * 0.02, y * 0.02, 5, 3),
  coast: (R) => (x, y) => {
    const shore = R * 0.5 + 10 * (fbm(y * 0.012, 3.3, 21, 3) - 0.5);
    const g = 12.4 + 2 * fbm(x * 0.02, y * 0.02, 5, 3);
    return x > shore ? g - Math.min(9, (x - shore) * 0.32) : g;
  },
  river: (R) => (x, y) => {
    const cx = R * 0.55 + 7 * Math.sin(y * 0.025);
    const d = Math.abs(x - cx);
    return 12.2 + 1.5 * fbm(x * 0.02, y * 0.02, 5, 3) - 4 * Math.max(0, 1 - (d / 8) ** 2);
  },
  // (the user's town: the sea on one side, a river through the other, the town in the fork)
  mouth: (R) => (x, y) => {
    const shore = -R * 0.6 + 8 * (fbm(x * 0.012, 7.1, 23, 3) - 0.5);
    const g = 12.4 + 1.8 * fbm(x * 0.02, y * 0.02, 5, 3);
    const rx = R * 0.6 + 6 * Math.sin(y * 0.03);
    const riv = 4 * Math.max(0, 1 - ((x - rx) / 9) ** 2);
    return (y < shore ? g - Math.min(9, (shore - y) * 0.3) : g) - riv;
  },
  mountain: (R) => (x, y) => 12.2 + 1.5 * fbm(x * 0.02, y * 0.02, 5, 3) + Math.max(0, x - R * 0.95) * 0.95,
};
const island: (R: number) => GroundFn = (R) => (x, y) => 12.5 - Math.max(0, Math.hypot(x, y) - R * 1.25) * 0.6;
const waterOf = (g: GroundFn): GroundFn => (x, y) => Math.max(0, SEA - g(x, y));

/** the wall's ways out by land: gaps in its runs (or 'gate' tiles) where the ring is a way out by land, counted apart */
function landExits(p: CityPlan, ground: GroundFn, water: GroundFn): number {
  const [cx, cy] = p.spec.at;
  const R = p.spec.radius;
  const gates = p.tiles.use.map((u, q) => [u, q] as const).filter(([u]) => u === 'gate');
  if (gates.length) {
    // (the radial rampart: gate tiles, each a way out where its land is)
    const angs = gates.map(([, q]) => quadCentre(p.tiles, q)).filter(([x, y]) => landWay(cx, cy, x, y, ground, water) > 0).map(([x, y]) => Math.atan2(y - cy, x - cx));
    return new Set(angs.map((a) => Math.round(a * 4))).size;
  }
  const walls = p.linear.filter((f) => f.kind === 'wall');
  if (!walls.length) return -1;
  const near = (x: number, y: number) =>
    walls.some((f) =>
      f.points.some((a, i) => {
        const b = f.points[(i + 1) % f.points.length];
        if (i === f.points.length - 1 && !f.closed) return false;
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy || 1)));
        return Math.hypot(a[0] + vx * t - x, a[1] + vy * t - y) < 3;
      }),
    );
  // round the ring a degree at a time: a run of open, walkable points is one way out
  let exits = 0;
  let open = false;
  let first = false;
  for (let k = 0; k < 360; k++) {
    const a = (k / 360) * Math.PI * 2;
    // (the wall's ring wanders ±4% round 1.06 R: the nearest wall point along the ray decides)
    let wall = false;
    for (let rr = R * 1.0; rr <= R * 1.12 && !wall; rr += 0.5) wall = near(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    const x = cx + Math.cos(a) * R * 1.06;
    const y = cy + Math.sin(a) * R * 1.06;
    const way = !wall && landWay(cx, cy, x, y, ground, water) > 0;
    if (way && !open) exits++;
    if (k === 0) first = way;
    open = way;
  }
  // (a gap across the start counted twice)
  if (first && open && exits > 1) exits--;
  return exits;
}

const systems: CitySpec['system'][] = ['irregular', 'contour-voronoi', 'orthogonal', 'radial'];

describe('every walled town has a gate on land', () => {
  for (const [name, gOf] of Object.entries(grounds))
    it(`${name}: every seed, system and size has a way out by land (more for the bigger towns)`, () => {
      const bad: string[] = [];
      for (const R of [30, 42])
        for (const system of systems)
          for (let seed = 1; seed <= 6; seed++) {
            const ground = gOf(R);
            const water = waterOf(ground);
            const spec: CitySpec = { seed, system, style: 'hearth', at: [0, 0], radius: R, walls: true, roads: 0, purpose: name === 'coast' || name === 'mouth' ? 'port' : undefined };
            const p = planCity(spec, ground, water);
            const n = landExits(p, ground, water);
            const want = system === 'radial' ? 1 : Math.min(2, landGatesFor(R));
            if (n < want) bad.push(`${system} R${R} seed ${seed}: ${n} land gates`);
          }
      expect(bad).toEqual([]);
    }, 60000);

  it('an island town may have none: its ways out are by water', () => {
    const R = 30;
    const ground = island(R);
    const water = waterOf(ground);
    const p = planCity({ seed: 3, system: 'irregular', style: 'hearth', at: [0, 0], radius: R, walls: true, roads: 0, purpose: 'port' }, ground, water);
    expect(landExits(p, ground, water)).toBe(0);
  });

  it('a road in from the atlas gets its gate toward it', () => {
    const R = 30;
    const ground = grounds.plain(R);
    const water = waterOf(ground);
    const p = planCity({ seed: 4, system: 'irregular', style: 'hearth', at: [0, 0], radius: R, walls: true, roads: 0, approaches: [[0, -1]] }, ground, water);
    // (no wall within 20° of straight down the road)
    const walls = p.linear.filter((f) => f.kind === 'wall');
    for (const f of walls)
      for (const q of f.points) {
        const a = Math.atan2(q[1], q[0]);
        expect(Math.abs(a - -Math.PI / 2)).toBeGreaterThan(0.12);
      }
  });
});
