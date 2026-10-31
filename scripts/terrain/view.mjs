// Terrain track: the terrain viewer (?terrain=view) at a world point, a mode, a picture (no graph).
//   node scripts/terrain/view.mjs [--server URL] --at x,y (world) [--span 1500] [--mode ground] --out file.png
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-view', kind: 'behaviour', size: '1000x800' }, async (R) => {
  const [x, y] = R.opt('at', '6340,4410').split(',').map(Number);
  const span = Number(R.opt('span', '1500'));
  const p = await R.page();
  await p.goto(`${R.url}/?${R.opt('view', 'terrain') === 'atlas' ? 'atlas' : 'terrain'}=view&mode=${R.opt('mode', 'ground')}&overlay=0&view=${x},${y},${(span / 1000).toFixed(3)}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  await R.fatal(p);
  await sleep(2000);
  await p.evaluate(() => document.querySelectorAll('#ui > div').forEach((d) => (d.style.display = 'none')));
  await p.screenshot({ path: R.opt('out', 'C:/Projects/shots88/terrain/view.png') });
});
