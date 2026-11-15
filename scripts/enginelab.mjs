// The physics engine's lab capture (docs/design/PHYSICS_ENGINE.md): the playground's `rigid` station under a solver
// variant, its buttons pressed, a GIF and stills at phone framing (412 x 915). The same buttons under ?solver=lattice
// (today's default) and ?solver=engine give the before and the after.
//   node scripts/enginelab.mjs --solver engine --out <dir>/after [--zoom 9] [--look 199,93,17] [--frames 90] [--every 70]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'enginelab', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf('--' + k);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const solver = opt('solver', 'engine');
  const out = opt('out', 'enginelab');
  const look = opt('look', '199,93,17').split(',').map(Number);
  const zoom = Number(opt('zoom', '9'));
  const frames = Number(opt('frames', '90'));
  const every = Number(opt('every', '70'));
  const page = await R.page();
  await page.goto(R.url + '/?skipmenu=1&level=playground&tutorial=0&q=low&fresh=1&solver=' + solver, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(5000);
  await page.evaluate(
    (look, zoom) => {
      const s = window.reclaimed.scene;
      s.tunePanel.el.hidden = true;
      s.stationsBar.pick(s.level.stations.findIndex((x) => x.id === 'rigid'));
      // (the tools' palette out of the picture: the stations' buttons stay)
      for (const el of document.querySelectorAll('.tools, .toolbar, .palette')) el.style.display = 'none';
      s.core.camera.target = look;
      s.core.camera.zoom = zoom;
    },
    look,
    zoom,
  );
  await sleep(1500);
  await page.screenshot({ path: out + '-0.png' });
  await page.evaluate(() => {
    const press = (t) => [...document.querySelectorAll('.stations button')].find((x) => x.textContent === t).click();
    press('drop on the ramp');
    press('a beam over the ledge');
    press('drop a pile below');
    setTimeout(() => press('throw at the cliff'), 3000);
  });
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const shot = Buffer.from(await page.screenshot({ type: 'png' }));
    if (i === 8 || i === 20 || i === 45) fs.writeFileSync(out + '-' + i + '.png', shot);
    const png = PNG.sync.read(shot);
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    await sleep(every);
  }
  enc.finish();
  fs.writeFileSync(out + '.gif', enc.bytes());
  await sleep(2000);
  await page.screenshot({ path: out + '-end.png' });
  await R.fatal(page);
  R.log('saved ' + out + '.gif and stills');
});
