// Round 128 (treegen): the map's flora before/after — the atlas at a spot (--at), the camera on the window's middle at a
// few zooms, a still each. Run it in two builds (this one and a worktree at the commit before) with the same --at.
//   node scripts/floramapshot.mjs --at 13728,5216 [--zooms "2,3,5"] [--tag after] [--out C:/Projects/shots88/treegen/map]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'floramapshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen/map');
  const tag = R.opt('tag', 'after');
  const zooms = R.opt('zooms', '2,3,5').split(',').map(Number);
  fs.mkdirSync(out, { recursive: true });
  const p = await R.level({ level: 'atlas', at: R.opt('at', '13728,5216'), fseason: '0.25' });
  await sleep(20000);
  for (const z of zooms) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
    await sleep(5000);
    await R.fatal(p);
    await p.screenshot({ path: `${out}/map-${tag}-z${z}.png` });
    R.log(`saved map-${tag}-z${z}.png`);
  }
});
