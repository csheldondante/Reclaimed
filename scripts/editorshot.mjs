// Round 128 (treegen): the flora viewer's generator panel (the tree editor) at 412x915 and on the desktop — the tree
// framed above the bottom sheet (beside the drawer on the desktop), the Tree section open, then the Crown section opened
// with a label's hint shown, a drag turning the tree — and a saved variant opened in the world on a wood (?ftree=).
//   node scripts/editorshot.mjs [--out C:/Projects/shots88/treegen] [--at 13728,5216] [--species oak]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'editorshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  const species = R.opt('species', 'oak');
  fs.mkdirSync(out, { recursive: true });
  for (const [tag, size] of R.opt('viewer', '1') === '1' ? [['phone', null], ['desktop', { w: 1280, h: 800 }]] : []) {
    const page = await R.page(size ? { size: `${size.w}x${size.h}` } : {});
    await page.goto(`${R.url}/flora.html?mode=plant&species=${species}&seed=3&season=0.2`, { waitUntil: 'load' });
    await sleep(2500);
    await R.fatal(page);
    await page.screenshot({ path: `${out}/editor-${tag}-0.png` });
    // the Crown section opened, its first label tapped (its hint shown)
    await page.evaluate(() => {
      const secs = [...document.querySelectorAll('#panel details.sec')];
      for (const d of secs) d.open = d.querySelector('summary').textContent === 'Crown';
      const crown = secs.find((d) => d.open);
      crown?.querySelector('label')?.click();
      crown?.scrollIntoView();
    });
    await sleep(600);
    await page.screenshot({ path: `${out}/editor-${tag}-1.png` });
    // a drag on the tree: it turns
    const box = await page.evaluate(() => {
      const r = document.getElementById('view').getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    await page.mouse.move(box[0], box[1]);
    await page.mouse.down();
    await page.mouse.move(box[0] + 120, box[1], { steps: 8 });
    await page.mouse.up();
    await sleep(600);
    await page.screenshot({ path: `${out}/editor-${tag}-2.png` });
    R.log(`saved editor-${tag}-0..2.png`);
    await page.close();
  }
  // a variant in the world on a wood: a species (--wspecies, the wood's own: the elder at the default spot) narrower,
  // pad-lobed and with its crown higher
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ft = enc({ [R.opt('wspecies', 'giant')]: { sWidth: 0.3, cLobeShape: 1, sCrownBase: 0.55 } });
  const p = await R.level({ level: 'atlas', at: R.opt('at', '13728,5216'), ftree: ft });
  // (main: the sandbox's tool panel hidden in every in-world shot)
  await p.addStyleTag({ content: '.editor{display:none!important}' });
  await sleep(30000);
  await p.evaluate(() => (window.reclaimed.camera.zoom = 7));
  await sleep(4000);
  await R.fatal(p);
  await p.screenshot({ path: `${out}/editor-world.png` });
  R.log(`saved editor-world.png ?ftree=${ft}`);
});
