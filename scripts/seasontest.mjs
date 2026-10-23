// The season (round 51): a patch of woodland planted in the sandbox, then
// shot through the year — summer, turning, the fall (autumn leaves in the
// air counted), winter, spring — and the leaf litter under it measured.
//
//   node scripts/seasontest.mjs [--url http://localhost:5181] [--out season] [--seasons 0,0.45,0.6,0.7,0.82,0.97]
//     [--hold 6] [--level sandbox]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'season');
const seasons = opt('seasons', '0,0.45,0.6,0.7,0.82,0.97').split(',').map(Number);
const hold = Number(opt('hold', 6));
const level = opt('level', 'sandbox');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await wait(3000);
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const core = R.core;
    const { w, h } = core.dims;
    const veg = new Float32Array((await core.readBuffer('veg')).buffer);
    const water = new Float32Array((await core.readBuffer('water')).buffer);
    const cx = Math.floor(w / 2) + 12;
    const cy = Math.floor(h / 2) + 10;
    const [px, py] = cellPos(cx, cy);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [qx, qy] = cellPos(x, y);
        const d = Math.hypot(qx - px, qy - py);
        if (d < 22 && water[y * w + x] < 0.02) veg[y * w + x] = Math.max(veg[y * w + x], 4.2 + 0.6 * Math.sin(x * 0.7 + y * 0.3));
      }
    core.host.gpu.device.queue.writeBuffer(R.world.veg, 0, veg);
    core.host.gpu.device.queue.writeBuffer(R.world.vegNext, 0, veg);
    R.camera.target[0] = px;
    R.camera.target[1] = py;
    R.camera.zoom *= 3;
  });
  const count = () =>
    page.evaluate(async () => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const { MAT } = await import('/src/world/materials.ts');
      const p = new Uint32Array((await R.core.readBuffer('particles')).buffer);
      const f = new Float32Array(p.buffer);
      let falling = 0;
      let lying = 0;
      for (let i = 0; i < p.length / 12; i++) {
        if (!(f[i * 12 + 3] > 0) || p[i * 12 + 8] !== 3 || (p[i * 12 + 11] & 255) === 0) continue;
        if (p[i * 12 + 10] & 1) lying++;
        else falling++;
      }
      const { w, h } = R.core.dims;
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      let litter = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (const iv of readColumn(R.core.packed, slots, x, y)) if (iv.mat === MAT.LeafLitter) litter += iv.z1 - iv.z0;
      return { falling, lying, litter: litter.toFixed(1) };
    });
  for (const s of seasons) {
    await page.evaluate((s) => {
      window.reclaimed.globals.season = s;
    }, s);
    await wait(hold * 1000);
    console.log(`season ${s}:`, JSON.stringify(await count()));
    if (argv.includes('--debug'))
      console.log(
        await page.evaluate(async () => {
          const R = window.reclaimed;
          const { readColumn, columnSlots } = await import('/src/world/layout.ts');
          const { w, h } = R.core.dims;
          const veg = new Float32Array((await R.core.readBuffer('veg')).buffer);
          const dep = new Float32Array((await R.core.readBuffer('deposit')).buffer);
          const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
          const x = Math.floor(w / 2) + 12;
          const y = Math.floor(h / 2) + 10;
          const out = [];
          for (let k = 0; k < 4; k++) {
            const i = y * w + x + k * 3;
            out.push(`veg ${veg[i].toFixed(2)} dep ${Array.from(dep.slice(i * 4, i * 4 + 4)).map((v) => v.toFixed(4))} K ${columnSlots(R.core.packed, x + k * 3, y).k} ` + readColumn(R.core.packed, slots, x + k * 3, y).map((iv) => `${iv.mat}:${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}`).join(' '));
          }
          return out.join(' // ');
        }),
      );
    await page.screenshot({ path: `${out}-${String(s).replace('.', '_')}.png` });
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
