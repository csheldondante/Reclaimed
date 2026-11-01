// Ships between the ports (round 120, `cities`; BACKLOG STR32): routes over the sea only, the fleet on them at any time.
// Node, no GPU: `npx vitest run src/settle/ships`.
import { describe, expect, it } from 'vitest';
import { Fleet, along, shipRoutes, DWELL, type SeaChart } from './ships';

/** a sea 1024 × 1024 world units (n 256) with an island in the middle and a mainland along the west (240 wide) */
function chart(): SeaChart {
  const n = 256;
  const ground = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const island = Math.hypot(x - 128, y - 128) < 40;
      const main = x < 60;
      ground[y * n + x] = island || main ? 20 : 2;
    }
  return { n, worldW: 1024, worldH: 1024, ground, sea: 10 };
}
const wetAt = (c: SeaChart, x: number, y: number) => {
  const tx = ((Math.floor((x / c.worldW) * c.n) % c.n) + c.n) % c.n;
  const ty = ((Math.floor((y / c.worldH) * c.n) % c.n) + c.n) % c.n;
  return c.ground[ty * c.n + tx] < c.sea;
};

describe('ship routes', () => {
  const c = chart();
  // three ports: two on the mainland's shore either side of the island's latitude, one on the island's east shore
  const ports = [
    { id: 'a', at: [250, 300] as [number, number] },
    { id: 'b', at: [250, 760] as [number, number] },
    { id: 'c', at: [690, 512] as [number, number] },
  ];
  const routes = shipRoutes(ports, c, { reach: 2000, perPort: 2 });

  it('join the ports, each pair once', () => {
    expect(routes.length).toBe(3);
    const keys = routes.map((r) => [r.a, r.b].sort().join());
    expect(new Set(keys).size).toBe(3);
  });

  it('go over the water only — round the island, never across it', () => {
    for (const r of routes) {
      expect(r.length).toBeGreaterThan(100);
      for (let d = 0; d <= r.length; d += 2) {
        const [x, y] = along(r, d);
        expect(wetAt(c, x, y), `${r.a}-${r.b} at ${d.toFixed(0)}: ${x.toFixed(0)},${y.toFixed(0)}`).toBe(true);
      }
    }
  });

  it('start and end by their ports', () => {
    for (const r of routes) {
      const pa = ports.find((p) => p.id === r.a)!.at;
      const pb = ports.find((p) => p.id === r.b)!.at;
      expect(Math.hypot(r.path[0] - pa[0], r.path[1] - pa[1])).toBeLessThan(64);
      const n = r.path.length;
      expect(Math.hypot(r.path[n - 2] - pb[0], r.path[n - 1] - pb[1])).toBeLessThan(64);
    }
  });

  it('a port with no sea near has none (in the middle of the island)', () => {
    const inland = shipRoutes([...ports, { id: 'd', at: [512, 512] }], c);
    expect(inland.some((r) => r.a === 'd' || r.b === 'd')).toBe(false);
  });
});

describe('the fleet', () => {
  const c = chart();
  const routes = shipRoutes([{ id: 'a', at: [250, 300] }, { id: 'c', at: [690, 512] }], c);
  const fleet = new Fleet(routes, 3);

  it('sails: on the water at every moment, moving, at rest in port a while at each end', () => {
    expect(fleet.count).toBeGreaterThanOrEqual(1);
    let moved = 0;
    let last = fleet.at(0, c.sea)[0];
    for (let t = 0; t < 600; t += 5) {
      const s = fleet.at(t, c.sea)[0];
      expect(wetAt(c, s.at[0], s.at[1])).toBe(true);
      expect(s.at[2]).toBe(c.sea);
      moved += Math.hypot(s.at[0] - last.at[0], s.at[1] - last.at[1]);
      last = s;
    }
    expect(moved).toBeGreaterThan(400);
    expect(DWELL).toBeGreaterThan(0);
  });

  it('is a pure function of the time (the GM and every client agree)', () => {
    expect(new Fleet(routes, 3).at(1234, c.sea)).toEqual(fleet.at(1234, c.sea));
  });
});
