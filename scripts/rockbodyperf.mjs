// Round 95: what the rigid rock (?rockbody=1) costs a frame, at the phone tier (q=low, 412×915). In the rock lab,
// bodies of a pillar's size (r 2.5, 20 tall: ~380 cells) are put in the air by the camera, turning, gravity off (so
// they stay up and nothing settles): 0, 1 and N of them, each measured for some seconds — the frame (rAF intervals),
// the GPU's frame and its passes, the bodies' CPU step, the pack and their mesh's passes.
//   node scripts/rockbodyperf.mjs [--url http://localhost:5275] [--n 10] [--secs 8] [--extra ""]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5275');
const N = Number(opt('n', 10));
const secs = Number(opt('secs', 8));
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&perf=1&level=rocklab&rockbody=1${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.integrity?.(), { timeout: 240000 });
  await sleep(30000);
  const measure = async (label) => {
    await p.evaluate(() => {
      const R = window.reclaimed;
      R.core.host.profiler.resetTotals();
      window.__t = [];
      window.__step = [];
      const gen = (window.__gen = (window.__gen ?? 0) + 1);
      const f = () => {
        if (window.__gen !== gen) return;
        window.__t.push(performance.now());
        const g = R.integrity().rigid;
        if (g) window.__step.push(g.stats.stepMs);
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    await sleep(secs * 1000);
    const r = await p.evaluate(() => {
      const R = window.reclaimed;
      const t = window.__t;
      window.__gen++;
      const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      d.sort((a, b) => a - b);
      const P = R.core.host.profiler;
      const fr = Math.max(P.framesResolved, 1);
      const per = (k) => +((P.totalMs.get(k) ?? 0) / fr).toFixed(3);
      const rock = [...P.totalMs].filter(([k]) => k.startsWith('rock ')).reduce((s, [, v]) => s + v, 0) / fr;
      const st = window.__step;
      const g = R.integrity().rigid;
      return { frames: d.length, p50: +d[Math.floor(d.length / 2)].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1), gpu: +(P.gpuTotalMs / fr).toFixed(2), draw: per('draw'), shadow: per('shadow'), rockMesh: +rock.toFixed(3), step: +(st.reduce((a, b) => a + b, 0) / Math.max(1, st.length)).toFixed(3), bodies: g.list.length, drawn: g.drawn, slots: R.core.renderer.rockMesh?.stats };
    });
    console.log(`${label}: ${JSON.stringify(r)}`);
  };
  await measure('0 bodies');
  const spawn = async (n) =>
    p.evaluate((n) => {
      const R = window.reclaimed;
      const I = R.integrity();
      R.rb.gravity = 0;
      const { w, h } = R.core.dims;
      const cx = Math.round(w * 0.55 + 10);
      const cy = Math.round(h * 0.5 - 6 / 0.866);
      for (let k = 0; k < n; k++) {
        const cells = [];
        const ox = cx - 20 + (k % 5) * 9;
        const oy = cy - 10 + Math.floor(k / 5) * 12;
        for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y * 0.75 <= 6.5) for (let z = 0; z < 20; z++) cells.push({ x: ox + x, y: oy + y, z: 40 + z, mat: 1 });
        const b = I.rigid.spawn(cells);
        b.w = [0.3, 0.5 * ((k % 3) - 1), 0.2];
        b.slot = I.rockMesh?.alloc(cells)?.id;
      }
      return I.rigid.list.length;
    }, n);
  await spawn(1);
  await sleep(1000);
  await measure('1 body');
  await spawn(N - 1);
  await sleep(1000);
  await measure(`${N} bodies`);
  await p.evaluate(() => (window.reclaimed.rb.cubes = 1));
  await sleep(500);
  await measure(`${N} bodies, cubes drawn too`);
} finally {
  await browser.close();
}
