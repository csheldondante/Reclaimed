// The field mesh prototype (G13 C): the sandbox with the structure-grids test
// room (scripts/roomtest.mjs) placed tilted, meshed over the region round it,
// next to the same scene drawn as prisms and cubes. Writes screenshots
// (<out>-{prisms,mesh}-{wide,close,low}.png) and prints the mesh's size and
// what it costs (rebuilt every frame: the worst case).
//
//   node scripts/meshtest.mjs [--url http://localhost:5177] [--out mesh] [--r 24] [--h 0.5]
//     [--seconds 5] [--only mesh|prisms] [--extra "&q=high"] [--level sandbox] [--at 128,120] [--noroom]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5177');
const out = opt('out', 'mesh');
const r = Number(opt('r', 24));
const h = Number(opt('h', 0.5));
const seconds = Number(opt('seconds', 5));
const only = opt('only', '');
const extra = opt('extra', '');
const level = opt('level', 'sandbox');
// where the room goes and the region's centre
// (no --at off the sandbox: where the camera starts)
const at = opt('at', level === 'sandbox' ? '128,120' : '');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
let errs = 0;
try {
  for (const mode of ['prisms', 'mesh']) {
    if (only && only !== mode) continue;
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
      failed = true;
      console.log(mode, 'pageerror:', e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) {
        // (the first few, shortened: one bad shader repeats every frame)
        if (!failed || errs++ < 4) console.log(mode, 'console.error:', m.text().slice(0, 600));
        failed = true;
      }
    });
    const meshArg = mode === 'mesh' ? `&mesh=1&meshh=${h}` : '';
    await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&perf=1&tod=0.35${meshArg}${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
    await new Promise((res) => setTimeout(res, 5000));
    // the room: 16 × 16, a foundation, floor z 3, roof z 12 with a 4 × 4 hole,
    // a doorway in the x = 0 wall; tilted 6° and rolled 3°
    await page.evaluate(
      (at, r, h, noRoom) => {
        const R = window.reclaimed;
        const [RX, RY] = at ? at.split(',').map(Number) : R.camera.target;
        if (R.renderer.fieldMesh.on) R.renderer.fieldMesh.setRegion(RX, RY, r, h);
        const qAxis = (ax, a) => [ax[0] * Math.sin(a / 2), ax[1] * Math.sin(a / 2), ax[2] * Math.sin(a / 2), Math.cos(a / 2)];
        const qMul = (a, b) => [
          a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
          a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
          a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
          a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
        const q = qMul(qMul(qAxis([0, 0, 1], 0.25), qAxis([1, 0, 0], (6 * Math.PI) / 180)), qAxis([0, 1, 0], (3 * Math.PI) / 180));
        const [W, D, H] = [16, 16, 13];
        const vox = new Uint8Array(W * D * H);
        for (let z = 0; z < H; z++)
          for (let y = 0; y < D; y++)
            for (let x = 0; x < W; x++) {
              const wall = x === 0 || y === 0 || x === W - 1 || y === D - 1;
              const hole = z === H - 1 && x >= 6 && x <= 9 && y >= 6 && y <= 9;
              const door = x === 0 && y >= 6 && y <= 9 && z >= 4 && z <= 6;
              if ((z === 3 || z === H - 1 || wall) && !hole && !door) vox[x + W * (y + D * z)] = 5;
            }
        if (!noRoom) R.core.structures.place({ id: 'room', name: 'Room', size: [W, D, H], vox, sink: 0 }, RX, RY, q, R.scene.heightAt, 2.5);
        R.weather.params.baseWindX = 0;
        R.weather.params.baseWindY = 0;
        R.core.speed = 0;
        document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
        R.camera.target[0] = RX;
        R.camera.target[1] = RY;
      },
      at,
      r,
      h,
      argv.includes('--noroom'),
    );
    await new Promise((res) => setTimeout(res, 1500));
    const z0 = await page.evaluate(() => window.reclaimed.camera.zoom);
    for (const [name, zoom] of [
      ['wide', 1.2],
      ['close', 3.2],
    ]) {
      await page.evaluate((z) => (window.reclaimed.camera.zoom = z), z0 * zoom);
      await new Promise((res) => setTimeout(res, 1200));
      await page.screenshot({ path: `${out}-${mode}-${name}.png` });
    }
    // cost, at the wide zoom
    await page.evaluate((z) => (window.reclaimed.camera.zoom = z), z0 * 1.2);
    const res = await page.evaluate(async (secs) => {
      const R = window.reclaimed;
      const prof = R.core.host.profiler;
      const sum = new Map();
      let n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < secs * 1000) {
        await new Promise((r) => requestAnimationFrame(r));
        for (const [k, v] of prof.passMs) sum.set(k, (sum.get(k) ?? 0) + v);
        n++;
      }
      return { fps: n / secs, avg: [...sum].map(([k, v]) => [k, v / n]), stats: R.renderer.fieldMesh.stats, counts: R.renderer.instanceCounts };
    }, seconds);
    const pick = (k) => (res.avg.find((a) => a[0] === k)?.[1] ?? 0).toFixed(3);
    console.log(
      `${mode}: ${res.fps.toFixed(0)} fps  draw ${pick('draw')} ms  renderprep ${pick('renderprep')} ms  fieldmesh ${pick('fieldmesh')} ms` +
        `  mesh ${res.stats.verts} verts ${res.stats.indices / 3} tris  prisms ${res.counts.prisms} tops ${res.counts.tops}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
