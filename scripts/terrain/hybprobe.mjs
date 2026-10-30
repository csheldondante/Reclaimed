// Terrain track: the hybrid's chunk state round a world point in the atlas level (phone tier): voxels (field mesh),
// grid (heightfield through the window's tops) or rings; and the window's columns' tops and gaps there.
//   node scripts/terrain/hybprobe.mjs [--server URL] --at x,y (world) [--cell cx,cy for the level's at]
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-hybprobe', kind: 'behaviour', size: '412x915', dpr: 2.6 }, async (R) => {
  const [x, y] = R.opt('at').split(',').map(Number);
  const p = await R.level({ level: 'atlas', q: 'low', at: R.opt('cell') });
  await sleep(25000);
  const out = await p.evaluate((x, y) => {
    const Rc = window.reclaimed;
    const S = Rc.stream;
    const h = Rc.hybrid();
    const wx = x - S.origin[0];
    const row = Math.floor((y - S.origin[1] * 0.8660254) / 0.8660254);
    const col = Math.floor(wx - 0.5 * (row & 1));
    const C = 16;
    const nx = Rc.core.renderer.fieldMesh.chunkGrid[0];
    const res = { origin: S.origin, col, row, chunks: [] };
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = Math.floor(col / C) + dx;
        const cy = Math.floor(row / C) + dy;
        const c = cy * nx + cx;
        res.chunks.push({ cx, cy, want: h?.wanted[c], grid: h?.grid[c] });
      }
    res.stats = h?.stats;
    return res;
  }, x, y);
  console.log(JSON.stringify(out));
});
