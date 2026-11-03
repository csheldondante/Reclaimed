// Round 128 (treegen): the crowns close up in the flora viewer (the panel hidden, the canvas the whole page) and from
// above at the game's zoom in the atlas (the sandbox's tool panel hidden) — run in two builds for a before/after.
//   node scripts/crownshot.mjs [--tag after] [--species oak,giant,shrub,birch,willow] [--out C:/Projects/shots88/treegen/crowns]
//        [--atlas "13728,5216;spawn"] [--zooms "5,3"]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'crownshot', kind: 'behaviour', size: '1000x1000', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen/crowns');
  const tag = R.opt('tag', 'after');
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  for (const id of R.opt('species', 'oak,giant,shrub,birch,willow').split(',')) {
    await page.goto(`${R.url}/flora.html?mode=plant&species=${id}&seed=3&season=0.2`, { waitUntil: 'load' });
    await page.addStyleTag({ content: '#panel{display:none!important} #view{position:fixed!important;inset:0!important;width:100%!important;height:100%!important}' });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await sleep(3000);
    await R.fatal(page);
    await page.screenshot({ path: `${out}/crown-${id}-${tag}.png` });
    R.log(`saved crown-${id}-${tag}.png`);
  }
  await page.close();
  for (const spot of R.opt('atlas', '13728,5216;spawn').split(';')) {
    const p = await R.level({ level: 'atlas', fseason: '0.25', ...(spot === 'spawn' ? {} : { at: spot }) }, { size: '412x915' });
    await p.addStyleTag({ content: '.editor{display:none!important}' });
    await sleep(20000);
    for (const z of R.opt('zooms', '5,3').split(',').map(Number)) {
      await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
      await sleep(5000);
      await R.fatal(p);
      const name = `crowns-${spot === 'spawn' ? 'spawn' : 'elder'}-z${z}-${tag}.png`;
      await p.screenshot({ path: `${out}/${name}` });
      R.log(`saved ${name}`);
    }
    await p.close();
  }
});
