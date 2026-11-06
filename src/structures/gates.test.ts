// (round 128l) Every walled town has a way out by land. The user, on the phone, in the fortress's starting town (a port
// on a river mouth, walled, no roads of its own): "The city has ports and a wall but I don't see any gate so the only exit
// does look like it is into the sea"; "I mean towns should always have gates". Over many seeds, tile systems, sizes and
// grounds (a plain, a coast, a river, a river mouth on the coast, a mountain's foot): the wall leaves at least one gap
// that is a way out by land (structures/linear.ts landWay), and the bigger towns more. An island town is the only one
// allowed none. Node, no GPU: `npx vitest run src/structures/gates`.
import { describe, expect, it } from 'vitest';
import type { CitySpec, GroundFn } from '../api/contracts/structures';
import { planTown } from './place';
import { landWay, landGatesFor } from './linear';
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

/**
 * The wall's ways out by land (onetown: the town's one plan — its wall cells, their gates): round the ring a degree at a
 * time, a ray from the middle out past the wall; it's open where it meets no wall cell, or meets a gate, and the ring is
 * a way out by land there; runs of open rays counted apart. -1: no wall.
 */
function landExits(spec: CitySpec, ground: GroundFn, water: GroundFn): number {
  const { site, dx, dy } = planTown(spec, ground, water);
  const { plan, grid } = site;
  if (!plan.structures().some((s) => s.type === 'wall')) return -1;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  let exits = 0;
  let open = false;
  let first = false;
  for (let k = 0; k < 360; k++) {
    const a = (k / 360) * Math.PI * 2;
    // (the first wall cell along the ray out decides: a wall shuts it, a gate is a way through)
    let shut = false;
    for (let rr = R * 0.9; rr <= R * 1.25; rr += 0.5) {
      const c = grid.cellAtWorld(cx + Math.cos(a) * rr - dx, cy + Math.sin(a) * rr - dy);
      if (c < 0 || plan.typeAt(c) !== 'wall') continue;
      shut = !plan.gate[c];
      break;
    }
    const x = cx + Math.cos(a) * R * 1.06;
    const y = cy + Math.sin(a) * R * 1.06;
    const way = !shut && landWay(cx, cy, x, y, ground, water) > 0;
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
            const n = landExits(spec, ground, water);
            const want = system === 'radial' ? 1 : Math.min(2, landGatesFor(R));
            if (n < want) bad.push(`${system} R${R} seed ${seed}: ${n} land gates`);
          }
      expect(bad).toEqual([]);
    }, 60000);

  it('an island town may have none: its ways out are by water', () => {
    const R = 30;
    const ground = island(R);
    const water = waterOf(ground);
    expect(landExits({ seed: 3, system: 'irregular', style: 'hearth', at: [0, 0], radius: R, walls: true, roads: 0, purpose: 'port' }, ground, water)).toBe(0);
  });

  it('a road in from the atlas gets its gate toward it', () => {
    const R = 30;
    const ground = grounds.plain(R);
    const water = waterOf(ground);
    const { site, dx, dy } = planTown({ seed: 4, system: 'irregular', style: 'hearth', at: [0, 0], radius: R, walls: true, roads: 0, approaches: [[0, -1]] }, ground, water);
    // (no wall cell — but a gate — within 7° of straight down the road; onetown: the plan's wall cells)
    for (let c = 0; c < site.grid.count; c++) {
      if (site.plan.typeAt(c) !== 'wall' || site.plan.gate[c]) continue;
      const [x, y] = site.grid.centre(c);
      const a = Math.atan2(y + dy, x + dx);
      expect(Math.abs(a - -Math.PI / 2)).toBeGreaterThan(0.12);
    }
  });
});
