// Round 128 (treegen): the grass and the shrubs the trees' way — in the flora viewer the shrubs' lineup (each kind of
// thicket in a row) and the tall grass's clump types, a close-up of one clump; then in the real atlas the lushest meadow
// near the start at the gameplay zoom and close in (the close-up level), and a GIF of a gust crossing it.
//   node scripts/grassshot.mjs [--out C:/Projects/shots88/treegen] [--zooms "5,14"] [--extra "&q=low"] [--viewer 1] [--atlas 1]
// Every system in play, 1x speed: only the camera is moved, and the gust pushed as the player's drag makes it.
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'grassshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  const extra = R.opt('extra', '');
  const zooms = R.opt('zooms', '5,14').split(',').map(Number);
  fs.mkdirSync(out, { recursive: true });
  const gifOf = async (page, name, frames = 36) => {
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
  if (R.opt('viewer', '1') === '1') {
    const page = await R.page();
    const shots = [
      ['shrubs-lineup', 'species=shrub&lineup=1&season=0.2'],
      ['shrubs-lineup-autumn', 'species=shrub&lineup=1&season=0.47'],
      ['grass-lineup', 'species=tallgrass&lineup=1&season=0.2&wind=0.6'],
      ['grass-close', 'species=tallgrass&p.gKind=0&season=0.2&wind=0.6'],
    ];
    for (const [tag, q] of shots) {
      await page.goto(`${R.url}/flora.html?mode=plant&seed=3&${q}`, { waitUntil: 'load' });
      await sleep(3000);
      await R.fatal(page);
      await page.screenshot({ path: `${out}/${tag}.png` });
      R.log(`saved ${tag}.png`);
    }
    // the meadow scene in the wind
    await page.goto(`${R.url}/flora.html?mode=scene&biome=meadow&seed=3&season=0.2&wind=0.9`, { waitUntil: 'load' });
    await sleep(3000);
    await R.fatal(page);
    await gifOf(page, `${out}/grass-viewer-meadow.gif`, 30);
    await page.close();
  }
  if (R.opt('atlas', '1') === '1') {
    const page = await R.page();
    const url = `${R.url}/?skipmenu=1&level=atlas&tutorial=0&fseason=0.25${extra}${R.opt('at', null) ? `&at=${R.opt('at')}` : ''}`;
    R.log(url);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await sleep(25000);
    // the lushest meadow: 16² blocks with the most columns at succession 2.0-3.2 (the tall grass's band), nearest the start
    const spot = await page.evaluate(async () => {
      const r = window.reclaimed;
      const v = await r.core.readBuffer('veg');
      const { w, h } = r.core.dims;
      const ROW_H = Math.sqrt(3) / 2;
      const [tx, ty] = r.camera.target;
      const B = 16;
      let best = null;
      for (let by = 2; by < h / B - 2; by++)
        for (let bx = 2; bx < w / B - 2; bx++) {
          let n = 0;
          let wood = 0;
          for (let y = by * B; y < by * B + B; y++)
            for (let x = bx * B; x < bx * B + B; x++) {
              const s = v[y * w + x];
              if (s >= 2.0 && s <= 3.2) n++;
              if (s >= 3.6) wood++;
            }
          const cx = bx * B + B / 2;
          const cy = by * B + B / 2;
          const d = Math.hypot(cx - tx, cy * ROW_H - ty);
          const score = n - wood * 2 - d * 0.1;
          if (!best || score > best.score) best = { x: cx + 0.5, y: cy * ROW_H, n, wood, d: Math.round(d), score };
        }
      return best;
    });
    R.log(`meadow: ${JSON.stringify(spot)}`);
    for (const z of zooms) {
      await page.evaluate(
        ({ s, z }) => {
          const r = window.reclaimed;
          r.camera.target = [s.x, s.y, r.camera.target[2]];
          r.camera.zoom = z;
        },
        { s: spot, z },
      );
      await sleep(10000);
      await R.fatal(page);
      await page.screenshot({ path: `${out}/grass-meadow-z${z}.png` });
      R.log(`saved grass-meadow-z${z}.png`);
      const stats = await page
        .evaluate(async () => {
          const r = window.reclaimed;
          const mi = r.renderer.meshInst;
          if (!mi) return null;
          const c = await mi.counts(r.renderer.device, r.renderer.indirect);
          return Object.fromEntries(mi.kinds.map((k, i) => [k.name, c[i]]).filter(([n, c]) => c > 0 && /grass|shrub/.test(n)));
        })
        .catch((e) => String(e));
      R.log(`instances: ${JSON.stringify(stats)}`);
      // a gust across the meadow as the player's drag makes it (the wind field's impulse), ~2.5 s
      await page.evaluate((s) => {
        const r = window.reclaimed;
        let n = 0;
        const t = setInterval(() => {
          r.globals.gusts.push({ x: s.x - 6, y: s.y - 4, radius: 22, strength: 14, dx: 0.8, dy: 0.6, len: 16 });
          if (++n > 40) clearInterval(t);
        }, 60);
      }, spot);
      await gifOf(page, `${out}/grass-meadow-gust-z${z}.gif`);
    }
    await page.close();
  }
});
