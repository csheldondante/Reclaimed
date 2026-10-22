// Physics voxels (docs/PHYSICS.md): drops a few bodies in the sandbox near
// the camera's target and screenshots them falling, landing and settling;
// prints each body's live voxels and height range. --scene picks a setup.
//
//   node scripts/phystest.mjs [--url http://localhost:5178] [--out phys] [--scene drop|beam|heat]
//     [--extra "&mesh=1"] [--zoom 3] [--shots 0.3,1,2.5,5]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5178');
const out = opt('out', 'phys');
const scene = opt('scene', 'drop');
const extra = opt('extra', '');
const zoom = Number(opt('zoom', '3'));
const one = opt('one', 'stone,3,3,10,3');
const perf = opt('perf', '0') === '1';
const shots = opt('shots', '0.3,1,2.5,5').split(',').map(Number);
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      console.log('console.error:', m.text().slice(0, 1500));
      failed = true;
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.35${perf ? '&perf=1' : ''}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 5000));
  const setup = await page.evaluate(
    async (scene, zoom, one) => {
      const R = window.reclaimed;
      document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
      const [x, y] = R.camera.target;
      R.camera.zoom *= zoom;
      const P = R.phys;
      const made = [];
      if (scene === 'drop') {
        made.push(await P.drop('stone', 3, 3, 10, x - 6, y, 3));
        made.push(await P.drop('steel', 16, 2, 2, x + 2, y - 4, 8, 10, 0, 0));
        made.push(await P.spawn(P.shapes.table(5, 1), x + 3, y + 5, 0.2));
        made.push(await P.drop('brick', 4, 4, 4, x + 3, y + 5, 12, 20, 15, 0));
      } else if (scene === 'beam') {
        // a steel beam across two stone posts, and a heavy block dropped on it
        made.push(await P.drop('stone', 2, 2, 6, x - 7, y, 0.1));
        made.push(await P.drop('stone', 2, 2, 6, x + 7, y, 0.1));
        made.push(await P.drop('steel', 18, 2, 1, x, y, 6.3));
        made.push(await P.drop('concrete', 4, 3, 3, x, y, 14));
      } else if (scene === 'one') {
        const [m, w, d, h, above] = one.split(',');
        made.push(await P.drop(m, +w, +d, +h, x, y, +above));
      } else if (scene === 'cut') {
        // the beam tool held on a steel beam lying on two stone blocks (scripted below)
        made.push(await P.drop('stone', 3, 4, 3, x - 6, y, 0.05));
        made.push(await P.drop('stone', 3, 4, 3, x + 6, y, 0.05));
        made.push(await P.drop('steel', 18, 2, 2, x, y, 3.3));
      } else if (scene === 'stress') {
        // many bodies at once: the solver's cost
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const kinds = [['steel', 14, 2, 2], ['stone', 4, 4, 4], ['concrete', 8, 4, 2], ['brick', 6, 2, 5]];
          const [m, w, d, h] = kinds[k % 4];
          made.push(await P.drop(m, w, d, h, x + Math.cos(a) * 14, y + Math.sin(a) * 14, 2 + (k % 6) * 2, k * 37));
        }
      } else if (scene === 'heat') {
        made.push(await P.drop('steel', 18, 2, 2, x, y, 4.1));
      }
      return { at: [x, y], made: made.map((b) => b && { id: b.id, n: b.dims[0] * b.dims[1] * b.dims[2] }) };
    },
    scene,
    zoom,
    one,
  );
  console.log('setup', JSON.stringify(setup));
  const report = () =>
    page.evaluate(async () => {
      const P = window.reclaimed.phys.physics;
      const X = await P.readPositions();
      return P.bodies.map((b) => {
        let n = 0;
        let lo = Infinity;
        let hi = -Infinity;
        let hot = 0;
        for (let i = b.offset; i < b.offset + b.dims[0] * b.dims[1] * b.dims[2]; i++) {
          if (X[i * 8 + 3] < 0) continue;
          n++;
          lo = Math.min(lo, X[i * 8 + 2]);
          hi = Math.max(hi, X[i * 8 + 2]);
          hot = Math.max(hot, X[i * 8 + 7]);
        }
        return `${b.model.id}: ${n} live, z ${lo.toFixed(2)}..${hi.toFixed(2)}${hot > 1 ? `, max temp ${hot.toFixed(0)}` : ''}`;
      });
    });
  let t = 0;
  for (const s of shots) {
    if (scene === 'cut' && t === 0) {
      // the tool, as a player uses it: select it, hold the mouse on the beam's middle, sweep across it
      await new Promise((r) => setTimeout(r, 800));
      const xy = await page.evaluate(async () => {
        const R = window.reclaimed;
        R.scene.editor.select('beam');
        // the steel's middle voxel, top row
        const P = R.phys.physics;
        const b = P.bodies[2];
        const X = await P.readPositions();
        const i = b.offset + Math.floor(b.dims[0] / 2) + b.dims[0] * b.dims[1];
        return R.camera.project(X[i * 8], X[i * 8 + 1], X[i * 8 + 2] + 0.5);
      });
      await page.mouse.move(xy[0], xy[1] - 6);
      await page.mouse.down();
      const steps = Math.round((s - t) * 10);
      for (let k = 0; k < steps; k++) {
        await page.mouse.move(xy[0], xy[1] - 6 + (k / steps) * 12);
        await new Promise((r) => setTimeout(r, 100));
      }
    } else if (scene === 'heat') {
      // the beam held on the middle of the steel, aimed like the tool's pick:
      // at the highest live voxel near the target, re-aimed every 0.2 s
      const until = Date.now() + (s - t) * 1000;
      while (Date.now() < until) {
        await page.evaluate(async () => {
          const R = window.reclaimed;
          const P = R.phys.physics;
          const X = await P.readPositions();
          // (the bar slides on sloping sand: aim at its middle, top row, wherever it is)
          const b = P.bodies[0];
          const [w, d, h] = b.dims;
          let i = b.offset + Math.floor(w / 2) + w * (d * (h - 1));
          if (X[i * 8 + 3] < 0) i = b.offset + Math.floor(w / 2);
          if (X[i * 8 + 3] < 0) return;
          P.beam = { at: [X[i * 8], X[i * 8 + 1], X[i * 8 + 2] + 0.5], dir: [0, 0, -1], radius: 1.5, power: 1500 };
        });
        await new Promise((r) => setTimeout(r, 200));
      }
    } else await new Promise((r) => setTimeout(r, (s - t) * 1000));
    t = s;
    await page.screenshot({ path: `${out}-${scene}-${String(s).replace('.', '_')}s.png` });
    if (scene === 'cut' && s === shots[shots.length - 2]) await page.mouse.up();
    console.log(`t=${s}s`, (await report()).join(' | '));
  }
  if (perf) {
    const ms = await page.evaluate(async () => {
      const prof = window.reclaimed.core.host.profiler;
      const sums = {};
      for (let k = 0; k < 120; k++) {
        await new Promise((r) => requestAnimationFrame(r));
        for (const [n, v] of prof.passMs) sums[n] = (sums[n] ?? 0) + v / 120;
      }
      return Object.entries(sums).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, v]) => `${n} ${v.toFixed(2)}`).join(', ');
    });
    console.log('GPU ms:', ms);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
