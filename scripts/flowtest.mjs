// Loose ground on the move (round 50): a pillar of sand (or another loose
// material) stood up in the sandbox slumps to its angle of repose; the
// running grains it sheds are counted and shot as it goes. --shelf: the
// pillar stands on a concrete shelf over air, then the shelf is taken away
// (loose ground falling off what held it).
//
//   node scripts/flowtest.mjs [--url http://localhost:5181] [--mat Sand] [--r 3] [--tall 12]
//     [--shelf] [--out flow] [--gif]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'flow');
const matName = opt('mat', 'Sand');
const R0 = Number(opt('r', 3));
const tall = Number(opt('tall', 12));
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
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
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.35`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  const setup = await page.evaluate(
    async (matName, R0, tall, shelf) => {
      const R = window.reclaimed;
      const { columnSlots, readColumn, writeSlot } = await import('/src/world/layout.ts');
      const { cellPos } = await import('/src/world/lattice.ts');
      const { MAT } = await import('/src/world/materials.ts');
      const core = R.core;
      const { w, h } = core.dims;
      const dev = core.host.gpu.device;
      const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
      const cx = Math.floor(w * 0.5) + 12;
      const cy = Math.floor(h * 0.5) + 10;
      const [px, py] = cellPos(cx, cy);
      const cols = [];
      for (let y = cy - R0 - 1; y <= cy + R0 + 1; y++)
        for (let x = cx - R0 - 1; x <= cx + R0 + 1; x++) {
          const [qx, qy] = cellPos(x, y);
          if (Math.hypot(qx - px, qy - py) > R0) continue;
          const c = readColumn(core.packed, slots, x, y);
          const { base, k: K } = columnSlots(core.packed, x, y);
          const top = c.length ? c[c.length - 1].z1 : 0;
          const col = c.map((iv) => [iv.z0, iv.z1, iv.mat]);
          // (with a shelf: concrete 2 over air 3 over the ground, the pile on it)
          let z = top;
          if (shelf) {
            col.push([z + 3, z + 4, MAT.Concrete]);
            z += 4;
          }
          col.push([z, z + tall, MAT[matName]]);
          const data = new Uint32Array(K * 4);
          col.slice(0, K).forEach(([a, b, m], s) => writeSlot(data, s, a, b, m));
          dev.queue.writeBuffer(R.world.layers, base * 16, data);
          cols.push({ x, y, top });
        }
      R.camera.target[0] = px;
      R.camera.target[1] = py;
      R.camera.zoom *= 4;
      return { cx, cy, px, py, cols };
    },
    matName,
    R0,
    tall,
    has('shelf'),
  );
  const count = () =>
    page.evaluate(async () => {
      const R = window.reclaimed;
      const p = new Float32Array((await R.core.readBuffer('particles')).buffer);
      const u = new Uint32Array(p.buffer);
      let run = 0;
      for (let i = 0; i < p.length / 12; i++) if (p[i * 12 + 3] > 0 && u[i * 12 + 8] === 22) run++;
      return run;
    });
  const height = () =>
    page.evaluate(async (s) => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      const c = readColumn(R.core.packed, slots, s.cx, s.cy);
      return c.length ? c[c.length - 1].z1 : 0;
    }, setup);
  if (has('shelf')) {
    // the shelf goes (as if it broke): its concrete taken out of every column
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(async (s) => {
      const R = window.reclaimed;
      const { columnSlots, readColumn, writeSlot } = await import('/src/world/layout.ts');
      const { MAT } = await import('/src/world/materials.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      for (const { x, y } of s.cols) {
        const c = readColumn(R.core.packed, slots, x, y).filter((iv) => iv.mat !== MAT.Concrete);
        const { base, k: K } = columnSlots(R.core.packed, x, y);
        const data = new Uint32Array(K * 4);
        c.slice(0, K).forEach((iv, k) => writeSlot(data, k, iv.z0, iv.z1, iv.mat));
        R.core.host.gpu.device.queue.writeBuffer(R.world.layers, base * 16, data);
      }
    }, setup);
  }
  const t0 = Date.now();
  if (has('gif')) {
    // (shot.mjs-style capture is enough here: a few frames)
    for (let f = 0; f < 6; f++) {
      await page.screenshot({ path: `${out}-${f}.png` });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  for (const s of [0.3, 1, 2, 4, 8]) {
    const wait = s * 1000 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const [n, z] = await Promise.all([count(), height()]);
    console.log(`t ${s}s: running grains ${n}, centre top ${(z - setup.cols[0].top).toFixed(2)} over the ground`);
    if (s === 1) await page.screenshot({ path: `${out}-1s.png` });
  }
  await page.screenshot({ path: `${out}-8s.png` });
} finally {
  await browser.close();
}
if (failed) process.exit(1);
