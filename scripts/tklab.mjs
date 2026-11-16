// The telekinesis tool's capture (the playground's pile station, ?solver=engine by default): a stack is dropped, then
// with the tool picked a single drag (which must not grab) and a double tap + drag on the stack (which must), by real
// mouse input, on the stack's top block (the pick is by the finger's view ray); a GIF and stills at phone framing.
//   node scripts/tklab.mjs --out <dir>/tk [--solver engine] [--frames 70] [--every 70]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'tklab', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf('--' + k);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const solver = opt('solver', 'engine');
  const out = opt('out', 'tk');
  const frames = Number(opt('frames', '70'));
  const every = Number(opt('every', '70'));
  const page = await R.page();
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
  // the tool picked, and where the stack's foot is on the screen
  const at = await page.evaluate(() => {
    const s = window.reclaimed.scene;
    document.querySelector('[data-t="drag"]').click();
    const RH = Math.sqrt(3) / 2;
    const x = 205.5;
    const y = 105.5 * RH;
    // (the stack out from under the tools' palette: the picture moved left and down, as a pan does)
    const cam = s.core.camera;
    const [wx, wy] = cam.screenDeltaToWorld(-90, 170);
    cam.target[0] -= wx;
    cam.target[1] -= wy;
    cam.update();
    // (the top block of the five, its centre at 20.4: the tool picks what the finger's view ray passes — TK8)
    const z = Number(new URLSearchParams(location.search).get('tkz') ?? 20.4);
    const p = cam.project(x, y, z);
    return { p, tool: s.editor.tool, z };
  });
  R.log('tool ' + at.tool + ', the stack at screen ' + at.p.map((v) => v.toFixed(0)) + ' (z ' + at.z.toFixed(1) + ')');
  const [sx, sy] = at.p;
  const state = () =>
    page.evaluate(async () => {
      const s = window.reclaimed.scene;
      // (a capture's own look at the engine: the grab slot and the rows' centres — nothing in play reads these)
      const dev = s.core.host.gpu.device;
      const read = async (buf, bytes, at = 0) => {
        const tmp = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(buf, at, tmp, 0, bytes);
        dev.queue.submit([enc.finish()]);
        await tmp.mapAsync(GPUMapMode.READ);
        const out = tmp.getMappedRange().slice(0);
        tmp.destroy();
        return out;
      };
      let slot = null;
      let rows = [];
      if (s.engine) {
        const D = s.engine.engine.debugBuffers;
        slot = new Uint32Array(await read(D.pool, 4, 23 * 4))[0];
        const P = new Float32Array(await read(D.pose, 64 * 10));
        for (let r = 0; r < 10; r += 2) rows.push([P[r * 16 + 8], P[r * 16 + 9], P[r * 16 + 10]].map((v) => +v.toFixed(1)).join(' '));
      }
      return { held: s.dragHold ? s.dragHold.g.kind : null, slot: slot === null ? null : slot ? slot & 0xfffff : 'none', rows, cam: [...s.core.camera.target].map((v) => +v.toFixed(2)) };
    });
  await page.screenshot({ path: out + '-0.png' });
  // a single drag: no grab
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 60, sy - 20, { steps: 6 });
  const single = await state();
  await page.mouse.up();
  await sleep(600);
  // a double tap, then a drag from the second press: a grab
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(120);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy - 4, { steps: 3 });
  const double = await state();
  R.log('single drag held: ' + single.held + '; double tap + drag held: ' + double.held + ', the rows at ' + double.rows.join(' | '));
  let held = double;
  const enc = GIFEncoder();
  const path = (i) => (i < 20 ? [sx + 10 + i * 6, sy - 4 - i * 4] : i < 40 ? [sx + 130 - (i - 20) * 12, sy - 84] : [sx - 110 + (i - 40) * 14, sy - 84 + (i - 40) * 2]);
  for (let i = 0; i < frames; i++) {
    if (i < 50) await page.mouse.move(...path(i));
    // (let go while it moves: a throw)
    if (i === 49) held = await state();
    if (i === 50) await page.mouse.up();
    const shot = Buffer.from(await page.screenshot({ type: 'png' }));
    if (i === 10 || i === 30 || i === 49 || i === 56) fs.writeFileSync(out + '-' + i + '.png', shot);
    const png = PNG.sync.read(shot);
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    await sleep(every);
  }
  enc.finish();
  fs.writeFileSync(out + '.gif', enc.bytes());
  const end = await state();
  await sleep(2500);
  await page.screenshot({ path: out + '-end.png' });
  await R.fatal(page);
  R.log('held at the lift: row ' + held.slot + ', the rows at ' + held.rows.join(' | '));
  R.log('after letting go held: ' + end.held + ', the rows at ' + end.rows.join(' | ') + '; camera ' + single.cam + ' -> ' + end.cam);
  if (single.held !== null) throw new Error('tklab: a single drag grabbed');
  if (double.held === null) throw new Error('tklab: a double tap + drag did not grab');
  if (end.held !== null) throw new Error('tklab: still held after the lift');
  R.log('saved ' + out + '.gif and stills');
});
