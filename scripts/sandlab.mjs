// The playground's sand station captured (docs/design/PHYSICS_ENGINE.md "Rest claims External", item 4): blocks set
// down and asleep, sand poured over them, one lifted out by real touch input (double tap + drag, the telekinesis
// tool). Stills at each stage, and the engine's claim counts (the pool's header: the capture's own read).
//   node scripts/sandlab.mjs --out <dir>/sand [--solver engine]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'sandlab', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf('--' + k);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const solver = opt('solver', 'engine');
  const out = opt('out', 'sand');
  const page = await R.page();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.goto(R.url + '/?skipmenu=1&level=playground&tutorial=0&q=low&fresh=1&solver=' + solver, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(5000);
  await page.evaluate(() => {
    const s = window.reclaimed.scene;
    s.tunePanel.el.hidden = true;
    s.stationsBar.pick(s.level.stations.findIndex((x) => x.id === 'sand'));
    // (close enough to see a block's faces against the sand; the tools' panel out of the picture: its buttons still click)
    for (const el of document.querySelectorAll('.tools, .toolbar, .palette')) el.style.display = 'none';
    s.core.camera.zoom = 15;
  });
  await sleep(1500);
  const press = (t) =>
    page.evaluate((t) => {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === t);
      if (!b) throw new Error('no station button "' + t + '"');
      b.click();
    }, t);
  const pool = () =>
    page.evaluate(async () => {
      const s = window.reclaimed.scene;
      if (!s.engine) return null;
      const dev = s.core.host.gpu.device;
      const tmp = dev.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(s.engine.engine.debugBuffers.pool, 0, tmp, 0, 256);
      dev.queue.submit([enc.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const v = new Uint32Array(tmp.getMappedRange().slice(0));
      tmp.destroy();
      const e = s.engine.engine;
      return { claims: v[43], wait: v[44], full: v[45], big: v[46], awake: e.awakeSeen, counts: e.counts.direct + ' direct + ' + e.counts.indirect + ' indirect' };
    });
  const say = async (what) => R.log(what + ': ' + JSON.stringify(await pool()));
  await press('set down three blocks');
  await sleep(7000);
  await page.screenshot({ path: out + '-1-blocks.png' });
  await say('blocks at rest');
  await press('pour sand over them');
  await sleep(4000);
  await page.screenshot({ path: out + '-2-pouring.png' });
  await sleep(9000);
  await page.screenshot({ path: out + '-3-buried.png' });
  await say('sand poured');
  // the stone block lifted out: a double tap, the second press held and dragged up and aside
  const at = await page.evaluate(() => {
    const s = window.reclaimed.scene;
    document.querySelector('[data-t="drag"]').click();
    const RH = Math.sqrt(3) / 2;
    return s.core.camera.project(204.5 + 0.25, 107.5 * RH, 14.5);
  });
  const [sx, sy] = at;
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id: id ?? 0 })) });
  await touch('touchStart', [[sx, sy]]);
  await sleep(60);
  await touch('touchEnd', []);
  await sleep(140);
  await touch('touchStart', [[sx + 2, sy + 1]]);
  for (let i = 1; i <= 14; i++) {
    await touch('touchMove', [[sx + 2 - i * 7, sy + 1 + i * 9]]);
    await sleep(60);
  }
  const held = await page.evaluate(() => (window.reclaimed.scene.dragHold ? window.reclaimed.scene.dragHold.g?.kind ?? 'pending' : null));
  R.log('double tap + drag: held ' + held);
  await sleep(1200);
  await page.screenshot({ path: out + '-4-lifted.png' });
  await say('held over the sand');
  await sleep(3000);
  await page.screenshot({ path: out + '-5-slumped.png' });
  await touch('touchEnd', []);
  await sleep(7000);
  await page.screenshot({ path: out + '-6-set-down.png' });
  await say('let go, at rest');
  // (the engine quiet again once the sand has stopped: 0 + 0)
  await sleep(12000);
  await say('twelve seconds on');
  await R.fatal(page);
  if (held === null) throw new Error('sandlab: the double tap + drag grabbed nothing');
});
