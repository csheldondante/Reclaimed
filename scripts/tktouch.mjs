// The telekinesis tool by touch (PQ1; the playground's pile station, ?solver=engine): real touch input through
// Chrome (pointerType touch), on the stack's top block. Each gesture reports whether a grab is held and how far the
// camera moved. Fails if a grab pans the camera or if a second finger moves it while a body is held.
//   node scripts/tktouch.mjs --out <dir>/fb-tk [--solver engine]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'tktouch', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf('--' + k);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const solver = opt('solver', 'engine');
  const out = opt('out', 'tktouch');
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
    s.stationsBar.pick(s.level.stations.findIndex((x) => x.id === 'pile'));
  });
  await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll('.stations button')].find((x) => x.textContent === 'drop a stack').click());
  await sleep(5000);
  const at = await page.evaluate(() => {
    const s = window.reclaimed.scene;
    document.querySelector('[data-t="drag"]').click();
    const RH = Math.sqrt(3) / 2;
    const cam = s.core.camera;
    const [wx, wy] = cam.screenDeltaToWorld(-90, 170);
    cam.target[0] -= wx;
    cam.target[1] -= wy;
    cam.update();
    return { p: cam.project(205.5, 105.5 * RH, 20.4), tool: s.editor.tool };
  });
  const [sx, sy] = at.p;
  R.log('tool ' + at.tool + ', the stack at screen ' + at.p.map((v) => v.toFixed(0)));
  // (each event lists the fingers down, by id: a finger left out is lifted)
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id: id ?? 0 })) });
  const state = () =>
    page.evaluate(() => {
      const s = window.reclaimed.scene;
      const c = s.core.camera;
      return { held: s.dragHold ? s.dragHold.g.kind : null, cam: [c.target[0], c.target[1]], zoom: c.zoom };
    });
  const moved = (a, b) => Math.hypot(a.cam[0] - b.cam[0], a.cam[1] - b.cam[1]);
  const fails = [];

  // 1: a double tap, the second press held and dragged
  const s0 = await state();
  await touch('touchStart', [[sx, sy]]);
  await sleep(60);
  await touch('touchEnd', []);
  await sleep(140);
  await touch('touchStart', [[sx + 3, sy + 2]]);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [[sx + 3 + i * 6, sy + 2 - i * 5]]);
    await sleep(40);
  }
  const s1 = await state();
  R.log('double tap + drag: held ' + s1.held + ', the camera moved ' + moved(s0, s1).toFixed(3));
  if (s1.held === null) fails.push('a double tap + drag did not grab');
  if (moved(s0, s1) > 1e-3) fails.push('a double tap + drag moved the camera');
  await page.screenshot({ path: out + '-held.png' });
  // (the capture's own look at the engine's grab slot, pool word 23: the row taken — nothing in play reads it)
  const slot = await page.evaluate(async () => {
    const s = window.reclaimed.scene;
    if (!s.engine) return null;
    const dev = s.core.host.gpu.device;
    const tmp = dev.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(s.engine.engine.debugBuffers.pool, 23 * 4, tmp, 0, 4);
    dev.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const v = new Uint32Array(tmp.getMappedRange().slice(0))[0];
    tmp.destroy();
    return v;
  });
  R.log('the engine holds row ' + (slot === null ? '(not the engine route)' : slot ? slot & 0xfffff : 'none'));
  if (slot === 0) fails.push('the engine took no row under the finger');
  // 2: a second finger while the body is held: no pan, no zoom, the grab kept
  await touch('touchStart', [[sx + 75, sy - 58, 0], [sx - 80, sy + 200, 1]]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [[sx + 75, sy - 58, 0], [sx - 80 - i * 8, sy + 200 + i * 10, 1]]);
    await sleep(40);
  }
  const s2 = await state();
  R.log('a second finger while held: held ' + s2.held + ', the camera moved ' + moved(s1, s2).toFixed(3) + ', zoom ' + s1.zoom.toFixed(3) + ' -> ' + s2.zoom.toFixed(3));
  if (s2.held === null) fails.push('a second finger let the body go');
  if (moved(s1, s2) > 1e-3 || Math.abs(s2.zoom - s1.zoom) > 1e-6) fails.push('a second finger moved the camera while a body was held');
  await touch('touchEnd', []);
  await sleep(1500);
  const s3 = await state();
  if (s3.held !== null) fails.push('still held after the lift');
  // 3: one finger pressed on the body and dragged, no double tap
  await touch('touchStart', [[sx, sy]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[sx + i * 6, sy - i * 5]]);
    await sleep(40);
  }
  const s4 = await state();
  R.log('one drag: held ' + s4.held + ', the camera moved ' + moved(s3, s4).toFixed(3));
  await touch('touchEnd', []);
  await sleep(800);
  // 4: two fingers with nothing held: the camera moves
  const s5 = await state();
  await touch('touchStart', [[120, 500, 0], [300, 500, 1]]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [[120 + i * 6, 500 + i * 6, 0], [300 + i * 6, 500 + i * 6, 1]]);
    await sleep(40);
  }
  await touch('touchEnd', []);
  const s6 = await state();
  R.log('two fingers, nothing held: the camera moved ' + moved(s5, s6).toFixed(3));
  if (moved(s5, s6) < 1e-3) fails.push('two fingers did not move the camera');
  await page.screenshot({ path: out + '-end.png' });
  await R.fatal(page);
  if (fails.length) throw new Error('tktouch: ' + fails.join('; '));
});
