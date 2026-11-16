// The physics engine's pile station captured (docs/design/PHYSICS_ENGINE.md "The join"): the playground's `pile`
// station under a solver variant, a button pressed, a GIF and stills at phone framing (412 x 915). The same buttons
// under ?solver=lattice (today's default) and ?solver=engine give the before and the after.
//   node scripts/pilelab.mjs --solver engine --out <dir>/pile-stack --press "drop a stack"
//     [--station pile] [--zoom 8] [--look 206,92,16] [--frames 90] [--every 70] [--stills 10,30,60] [--wait 6000]
//     [--tool cannon --taps "x,y,z@frame;x,y,z@frame"]: a tool picked and real touch taps (PQ9) at world points
//     (storage column, row, cell z) at those frames; fails if a tap moves the camera. --press "" presses nothing
// (terrain pieces as rows, PT1: --station slide --press "nick the spire" | "undercut the mesa")
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
  const station = opt('station', 'pile');
  const press = opt('press', 'drop a stack').split('|').filter(Boolean);
  const tool = opt('tool', '');
  const taps = opt('taps', '').split(';').filter(Boolean).map((t) => {
    const [p, f] = t.split('@');
    return { p: p.split(',').map(Number), f: Number(f ?? 0) };
  });
  const page = await R.page();
  await page.goto(R.url + '/?skipmenu=1&level=playground&tutorial=0&q=low&fresh=1&solver=' + solver, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(5000);
  await page.evaluate(
    (look, zoom, station) => {
      const s = window.reclaimed.scene;
      s.tunePanel.el.hidden = true;
      s.stationsBar.pick(s.level.stations.findIndex((x) => x.id === station));
      for (const el of document.querySelectorAll('.tools, .toolbar, .palette')) el.style.display = 'none';
      if (look.length === 3) s.core.camera.target = look;
      if (zoom) s.core.camera.zoom = zoom;
    },
    look,
    zoom,
    station,
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
  const cdp = await page.createCDPSession();
  if (tool) await page.evaluate((tool) => document.querySelector(`[data-t="${tool}"]`).click(), tool);
  const cam = () => page.evaluate(() => [...window.reclaimed.scene.core.camera.target]);
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    for (const t of taps.filter((t) => t.f === i)) {
      const at = await page.evaluate((p) => window.reclaimed.scene.core.camera.project(p[0] + 0.5 + 0.5 * (p[1] & 1), (p[1] + 0.5) * Math.sqrt(3) / 2, p[2]), t.p);
      const c0 = await cam();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1], id: 0 }] });
      await sleep(50);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const c1 = await cam();
      R.log('tap at screen ' + at.slice(0, 2).map((v) => v.toFixed(0)) + ' (frame ' + i + ')');
      if (Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) > 1e-6) throw new Error('pilelab: a tap moved the camera');
    }
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
    const ig = await page.evaluate(() => {
      const i = window.reclaimed.scene.integrity;
      return i ? { blows: i.stats.blows, rows: i.stats.rows, rowCells: i.stats.rowCells, rowMs: i.stats.rowMs, lattice: i.physics?.bodies.length ?? 0, cpuRock: i.rigid?.list.length ?? 0 } : null;
    });
    R.log('freed: ' + JSON.stringify(ig));
  }
  await R.fatal(page);
  R.log('saved ' + out + '.gif and stills');
});
