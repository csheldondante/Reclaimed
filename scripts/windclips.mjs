// Round 128 (treegen, M4): the foliage wind matrix's rows on the trees as they are (docs/design/FOLIAGE_WIND.md) — at
// the forest station, the camera on the stand's canopy at the gameplay zoom, the same scripted winds each load: a gust
// front, a gale (the prevailing wind x3), the wind reversed. One GIF a row and wind, plus a still, for the scoring
// (does the canopy read as moving with the wind; is anything rubbery, popping, swimming).
//   node scripts/windclips.mjs [--out C:/Projects/shots88/treegen/wind] [--rows static,sway,1A,1C,1A1C] [--zoom 5]
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'windclips', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen/wind');
  const rows = R.opt('rows', 'static,sway,1A,1C,1A1C').split(',');
  const zoom = Number(R.opt('zoom', '5'));
  fs.mkdirSync(out, { recursive: true });
  const gifOf = async (page, name, frames = 30) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 90 });
      await sleep(90);
    }
    enc.finish();
    fs.writeFileSync(name, enc.bytes());
    R.log(`saved ${name}`);
  };
  for (const row of rows) {
    const p = await R.level({ level: 'atlas', play: 'lich', forest: 'lab', fride: '0', fseason: '0.25', fwind: row });
    await p.waitForFunction(() => window.reclaimed?.forest?.stand, { timeout: 120000, polling: 500 });
    await sleep(20000);
    await p.evaluate((zoom) => {
      const r = window.reclaimed;
      r.forest.ride = false;
      r.play.session.hero.place(r.forest.stand.park ?? r.forest.stand.at);
      r.forest.d.driver.force = 0;
      r.camera.zoom = zoom;
    }, zoom);
    await sleep(4000);
    await R.fatal(p);
    await p.screenshot({ path: `${out}/wind-${row}.png` });
    // a gust front across the stand
    await p.evaluate(() => window.reclaimed.forest.gust());
    await gifOf(p, `${out}/wind-${row}-gust.gif`);
    // the gale: the prevailing wind x3
    await p.evaluate(() => {
      const w = window.reclaimed.forest.d.wind;
      const b = w.base();
      w.setBase([b[0] * 3, b[1] * 3]);
    });
    await sleep(2000);
    await gifOf(p, `${out}/wind-${row}-gale.gif`, 24);
    // reversed
    await p.evaluate(() => {
      const w = window.reclaimed.forest.d.wind;
      const b = w.base();
      w.setBase([-b[0], -b[1]]);
    });
    await gifOf(p, `${out}/wind-${row}-reverse.gif`, 24);
    await p.close();
  }
});
