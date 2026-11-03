// Round 128 (treegen): the flora viewer's generator panel (the tree editor) at 412x915 and on the desktop — the panel
// open, scrolled through, each a still — and a saved variant opened in the world (?ftree=).
//   node scripts/editorshot.mjs [--out C:/Projects/shots88/treegen]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'editorshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  fs.mkdirSync(out, { recursive: true });
  for (const [tag, size] of [['phone', null], ['desktop', { w: 1280, h: 800 }]]) {
    const page = await R.page(size ? { size: `${size.w}x${size.h}` } : {});
    await page.goto(`${R.url}/flora.html?mode=plant&species=oak&seed=3&season=0.2&compare=1`, { waitUntil: 'load' });
    await sleep(2500);
    await R.fatal(page);
    await page.evaluate(() => (document.getElementById('params').open = true));
    await sleep(800);
    const h = await page.evaluate(() => document.getElementById('panel').scrollHeight);
    let y = 0;
    let i = 0;
    while (y < h && i < 8) {
      await page.evaluate((y) => (document.getElementById('panel').scrollTop = y), y);
      await sleep(300);
      await page.screenshot({ path: `${out}/editor-${tag}-${i}.png` });
      R.log(`saved editor-${tag}-${i}.png`);
      y += size ? 700 : 820;
      i++;
    }
    await page.close();
  }
  // a variant in the world: the oak narrower and pad-lobed
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ft = enc({ oak: { sWidth: 0.3, cLobeShape: 1, sCrownBase: 0.55 } });
  const p = await R.level({ level: 'atlas', at: R.opt('at', '13728,4768'), ftree: ft });
  await sleep(30000);
  await p.evaluate(() => (window.reclaimed.camera.zoom = 7));
  await sleep(4000);
  await R.fatal(p);
  await p.screenshot({ path: `${out}/editor-world.png` });
  R.log(`saved editor-world.png ?ftree=${ft}`);
});
