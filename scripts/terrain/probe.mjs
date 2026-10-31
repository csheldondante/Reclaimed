// Terrain track: facts about the atlas at a spot (the viewer page, no level): the roads' count and the nearest to it, the
// river nodes round it (position, level, width, the fall to the next).
//   node scripts/terrain/probe.mjs [--server URL] [--at x,y] (world units) [--r 200]
import { run } from '../lib/runner.mjs';

await run({ name: 'terrain-probe', kind: 'behaviour', size: '600x400' }, async (R) => {
  const [x, y] = R.opt('at', '6108,12131').split(',').map(Number);
  const rad = Number(R.opt('r', '200'));
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  const out = await p.evaluate(
    (x, y, rad) => {
      const a = window.reclaimed.atlas;
      const roads = a.settlement.roads;
      let pts = 0;
      let near = 1e9;
      for (const r of roads) {
        pts += r.path.length / 2;
        for (let i = 0; i < r.path.length; i += 2) near = Math.min(near, Math.hypot(r.path[i] - x, r.path[i + 1] - y));
      }
      const u = a.riverNodes;
      const f = new Float32Array(u.buffer, u.byteOffset, u.length);
      const nodes = [];
      for (let k = 0; k < u.length / 8; k++) {
        const d = Math.hypot(f[k * 8] - x, f[k * 8 + 1] - y);
        if (d > rad) continue;
        const nx = u[k * 8 + 4];
        nodes.push({ k, x: +f[k * 8].toFixed(0), y: +f[k * 8 + 1].toFixed(0), level: +f[k * 8 + 2].toFixed(1), w: +f[k * 8 + 3].toFixed(1), next: nx, fall: +(f[k * 8 + 2] - f[nx * 8 + 2]).toFixed(1), lava: u[k * 8 + 5] & 1 });
      }
      nodes.sort((a, b) => b.level - a.level);
      return { roads: roads.length, roadPoints: pts, nearestRoad: Math.round(near), sites: a.settlement.sites.length, rivers: a.riverStats, nodes };
    },
    x,
    y,
    rad,
  );
  console.log(JSON.stringify(out));
});
