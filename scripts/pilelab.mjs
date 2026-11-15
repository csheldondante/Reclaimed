// The physics engine's pile station captured (docs/design/PHYSICS_ENGINE.md "The join"): the playground's `pile`
// station under a solver variant, a button pressed, a GIF and stills at phone framing (412 x 915). The same buttons
// under ?solver=lattice (today's default) and ?solver=engine give the before and the after.
//   node scripts/pilelab.mjs --solver engine --out <dir>/pile-stack --press "drop a stack"
//     [--zoom 8] [--look 206,92,16] [--frames 90] [--every 70] [--stills 10,30,60] [--wait 6000]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'pilelab', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf('--' + k);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const solver = opt('solver', 'engine');
  const out = opt('out', 'pilelab');
  const look = opt('look', '').split(',').filter(Boolean).map(Number);
  const zoom = Number(opt('zoom', '0'));
  const frames = Number(opt('frames', '90'));
  const every = Number(opt('every', '70'));
  const wait = Number(opt('wait', '6000'));
  const stills = opt('stills', '10,30,60').split(',').map(Number);
  const press = opt('press', 'drop a stack').split('|');
  const page = await R.page();
  await page.goto(R.url + '/?skipmenu=1&level=playground&tutorial=0&q=low&fresh=1&solver=' + solver, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(5000);
  await page.evaluate(
    (look, zoom) => {
      const s = window.reclaimed.scene;
      s.tunePanel.el.hidden = true;
      s.stationsBar.pick(s.level.stations.findIndex((x) => x.id === 'pile'));
      for (const el of document.querySelectorAll('.tools, .toolbar, .palette')) el.style.display = 'none';
      if (look.length === 3) s.core.camera.target = look;
      if (zoom) s.core.camera.zoom = zoom;
    },
    look,
    zoom,
  );
  await sleep(1500);
  await page.screenshot({ path: out + '-0.png' });
  await page.evaluate((press) => {
    for (const t of press) {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === t);
      if (!b) throw new Error('no station button "' + t + '"');
      b.click();
    }
  }, press);
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const shot = Buffer.from(await page.screenshot({ type: 'png' }));
    if (stills.includes(i)) fs.writeFileSync(out + '-' + i + '.png', shot);
    const png = PNG.sync.read(shot);
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    await sleep(every);
  }
  enc.finish();
  fs.writeFileSync(out + '.gif', enc.bytes());
  await sleep(wait);
  await page.screenshot({ path: out + '-end.png' });
  if (solver === 'engine') {
    const seen = await page.evaluate(() => {
      const e = window.reclaimed.scene.engine?.engine;
      return e ? { awake: e.awakeSeen, reads: e.reads, bakes: e.bakes, models: e.models.length, rows: e.rows, rooms: e.collide.rooms, pool: [...e.seen].slice(13, 23) } : null;
    });
    R.log('engine: ' + JSON.stringify(seen));
  }
  await R.fatal(page);
  R.log('saved ' + out + '.gif and stills');
});
