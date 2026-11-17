// flora-sway step 1 (2026-11-17): the open land between settlements at the loop's zoom and one closer, phone size and
// tier, IN THE GAME — a still and a 3-frame motion sequence at each zoom, a strip of them side by side, and a motion
// number (the mean pixel change between frames 400 ms apart, on the ground away from the town's centre) so "what moves"
// is measured, not guessed.
//   node scripts/florasway.mjs --tag base [--out local/flora1] [--extra "&florasway=0"] [--pan 0,0] [--zooms "1,2.5"]
// --zooms: multiples of the loop's own zoom. --pan: cells to move the camera from the loop's start (to open land).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { run, sleep, ROOT } from './lib/runner.mjs';

await run({ name: 'florasway', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = path.resolve(ROOT, R.opt('out', 'local/flora1'));
  const tag = R.opt('tag', 'base');
  const extra = R.opt('extra', '');
  const zooms = R.opt('zooms', '1,2.5').split(',').map(Number);
  const [px, py] = R.opt('pan', '0,0').split(',').map(Number);
  const frames = Number(R.opt('frames', '3'));
  const every = Number(R.opt('every', '400'));
  fs.mkdirSync(out, { recursive: true });
  const params = { level: 'atlas', town: 1, loop: 1, fresh: 1, q: 'low' };
  for (const kv of extra.split('&').filter(Boolean)) {
    const [k, v] = kv.split('=');
    params[k] = v ?? '1';
  }
  const p = await R.level(params);
  // the loop's own start: the town built, a leader picked (the first), "The world now" closed — then the city view
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 200 });
  await R.fatal(p);
  await sleep(1000);
  await p.evaluate(() => document.querySelector('.run-full .leader button').click());
  await p.waitForFunction(() => ['city', 'event'].includes(window.rungame?.phase), { timeout: 60000, polling: 200 });
  await sleep(800);
  await p.evaluate(() => {
    if (document.querySelector('.run-full h2')?.textContent === 'The world now') [...document.querySelectorAll('.run-full button')].find((b) => /close/i.test(b.textContent))?.click();
  });
  // the petitions' sheet hidden (its own Hide button): the land, not the list
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Hide')?.click());
  await sleep(Number(R.opt('settle', '4000')));
  const base = await p.evaluate(([px, py]) => {
    const c = window.reclaimed.camera;
    c.target[0] += px;
    c.target[1] += py;
    return { zoom: c.zoom, target: [...c.target] };
  }, [px, py]);
  R.log(`loop camera ${JSON.stringify(base)}`);
  const shots = [];
  for (const zm of zooms) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), base.zoom * zm);
    await sleep(4000);
    const imgs = [];
    for (let f = 0; f < frames; f++) {
      const file = path.join(out, `${tag}-z${zm}-f${f}.png`);
      await p.screenshot({ path: file });
      imgs.push(PNG.sync.read(fs.readFileSync(file)));
      if (f < frames - 1) await sleep(every);
    }
    // motion: the mean absolute change a pixel (0..255) between successive frames, over the whole view
    // (and on the green pixels alone — grass and leaves, as frame 0 shows them: green over red and blue — so the
    // water's ripples don't count as the meadow's)
    let sum = 0;
    let moved = 0;
    let n = 0;
    let gs = 0;
    let gm = 0;
    let gn = 0;
    for (let f = 1; f < imgs.length; f++) {
      const a = imgs[f - 1].data;
      const b = imgs[f].data;
      const z = imgs[0].data;
      for (let i = 0; i < a.length; i += 4) {
        const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
        sum += d;
        if (d > 2) moved++;
        n++;
        if (z[i + 1] > z[i] + 8 && z[i + 1] > z[i + 2] + 8) {
          gs += d;
          if (d > 2) gm++;
          gn++;
        }
      }
    }
    const zoomNow = await p.evaluate(() => window.reclaimed.camera.zoom);
    R.log(`${tag} zoom x${zm} (${zoomNow.toFixed(2)} css px a cell): motion mean ${(sum / n).toFixed(3)}, changed >2: ${((100 * moved) / n).toFixed(1)} %; green ${((100 * gn) / n / (imgs.length - 1)).toFixed(0)} % of view: mean ${(gs / Math.max(gn, 1)).toFixed(3)}, changed >2: ${((100 * gm) / Math.max(gn, 1)).toFixed(1)} %`);
    shots.push({ zm, imgs });
  }
  // the strip: each zoom's frames side by side, zooms one under another, 2 px gaps
  const w = shots[0].imgs[0].width;
  const h = shots[0].imgs[0].height;
  const S = new PNG({ width: frames * w + (frames - 1) * 2, height: shots.length * h + (shots.length - 1) * 2 });
  for (let r = 0; r < shots.length; r++)
    for (let f = 0; f < frames; f++) PNG.bitblt(shots[r].imgs[f], S, 0, 0, w, h, f * (w + 2), r * (h + 2));
  const sf = path.join(out, `${tag}-strip.png`);
  fs.writeFileSync(sf, PNG.sync.write(S));
  R.log(`strip ${sf}`);
});
