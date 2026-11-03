// Round 128 (treegen): a fire through a wood, then the wood from above and from afar — the burned trees standing.
//   node scripts/burnshot.mjs [--at 13728,5216] [--out C:/Projects/shots88/treegen] [--burn 60000]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'burnshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  const p = await R.level({ level: 'atlas', at: R.opt('at', '13728,5216'), fseason: '0.3' });
  await sleep(25000);
  await p.evaluate(() => (window.reclaimed.camera.zoom = 5));
  await sleep(3000);
  await p.screenshot({ path: `${out}/burn-before-z5.png` });
  // lightning into the wood round the view's middle, a few strikes
  await p.evaluate(() => {
    const r = window.reclaimed;
    const [x, y] = r.camera.target;
    for (let k = 0; k < 6; k++) r.globals.events.push({ kind: 1, x: x + (k % 3) * 10 - 10, y: y + Math.floor(k / 3) * 10 - 5, radius: 5, strength: 40 });
  });
  const burn = Number(R.opt('burn', '60000'));
  await sleep(burn / 2);
  await p.screenshot({ path: `${out}/burn-during-z5.png` });
  await sleep(burn / 2);
  await R.fatal(p);
  for (const z of [5, 3, 2]) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
    await sleep(3000);
    await p.screenshot({ path: `${out}/burn-after-z${z}.png` });
    R.log(`saved burn-after-z${z}.png`);
  }
  const n = await p.evaluate(() => window.reclaimed.flora?.()?.placement ? null : null);
  R.log(`done ${n}`);
});
