// Round 128 (treegen): the flora viewer's old | new pairs (compare=1) per tree species, a bark close-up of each new
// one, at 412x915. Fails on page errors or the fatal box.
//   node scripts/treegenshot.mjs [--out C:/Projects/shots88/treegen] [--tag m1] [--only birch,oak] [--q "season=0.2"]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'treegenshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = opt('out', 'C:/Projects/shots88/treegen');
  const tag = opt('tag', 'm1');
  const extra = opt('q', '');
  const only = opt('only', 'birch,oak,pine,giant,shrub').split(',');
  const views = opt('views', 'pair,bark').split(',');
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  for (const sp of only) {
    for (const view of views) {
      const q = `mode=plant&species=${sp}&seed=3&wind=0.15&season=0.2&compare=${view === 'pair' ? 1 : 0}${extra ? `&${extra}` : ''}`;
      await page.goto(`${R.url}/flora.html?${q}`, { waitUntil: 'load' });
      await sleep(2000);
      await R.fatal(page);
      if (view === 'bark') {
        // (close on the trunk's lower third, turned a little)
        await page.evaluate(() => {
          const v = window.floraViewer;
          v.cam.at = [0, 0, 2.5];
          v.cam.dist = 7;
          v.cam.pitch = 0.25;
          v.cam.userMoved = true;
        });
        await sleep(400);
      }
      const stats = await page.evaluate(() => window.floraViewer?.stats());
      R.log(`${sp} ${view}: ${stats}`);
      await page.screenshot({ path: `${out}/${tag}-${sp}-${view}.png` });
    }
  }
});
