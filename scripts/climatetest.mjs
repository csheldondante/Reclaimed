// The climate (round 50): a crystal cluster and an ice slab stood up by the
// sandbox pond (shot: how see-through things look), then the air turned cold
// with a storm over the pond (snow falls and lies, the pond freezes), then
// warm (it all melts). Totals of snow, ice, leaf litter and water each phase.
//
//   node scripts/climatetest.mjs [--url http://localhost:5181] [--cold -8] [--warm 18]
//     [--seconds 25] [--speed 4] [--out climate]
//   --leaves N: instead, N seconds of the valley as it is (its woodland drops
//   leaves), leaf litter totals every N/4 s
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'climate');
const cold = Number(opt('cold', -8));
const warm = Number(opt('warm', 18));
const seconds = Number(opt('seconds', 25));
const speed = Number(opt('speed', 4));
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
const leaves = Number(opt('leaves', 0));
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
  await page.goto(`${url}/?skipmenu=1&level=${leaves ? 'valley' : 'sandbox'}&tutorial=0&tod=0.35&speed=${speed}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await wait(3000);
  if (leaves) {
    const count = () =>
      page.evaluate(async () => {
        const R = window.reclaimed;
        const { readColumn } = await import('/src/world/layout.ts');
        const { MAT } = await import('/src/world/materials.ts');
        const { w, h } = R.core.dims;
        const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
        let v = 0;
        let cols = 0;
        let deepest = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            for (const iv of readColumn(R.core.packed, slots, x, y))
              if (iv.mat === MAT.LeafLitter) {
                v += iv.z1 - iv.z0;
                cols++;
                deepest = Math.max(deepest, iv.z1 - iv.z0);
              }
        return { volume: v.toFixed(1), intervals: cols, deepest: deepest.toFixed(2) };
      });
    for (let k = 1; k <= 4; k++) {
      await wait((leaves * 1000) / 4);
      console.log(`${(leaves * k) / 4} s (×${speed}):`, JSON.stringify(await count()));
    }
    await page.screenshot({ path: `${out}-leaves.png` });
    process.exitCode = 0;
  }
  const at = leaves ? null : await page.evaluate(async () => {
    const R = window.reclaimed;
    const { columnSlots, readColumn, writeSlot } = await import('/src/world/layout.ts');
    const { cellPos, cellAt } = await import('/src/world/lattice.ts');
    const { MAT } = await import('/src/world/materials.ts');
    const core = R.core;
    const { w, h } = core.dims;
    const water = new Float32Array((await core.readBuffer('water')).buffer);
    // the pond: the deepest water near the middle
    let best = -1;
    for (let i = 0; i < w * h; i++) if (best < 0 || water[i] > water[best]) best = i;
    const [px, py] = cellPos(best % w, Math.floor(best / w));
    const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
    const put = (x, y, z0, z1, mat) => {
      const c = readColumn(core.packed, slots, x, y);
      const top = c.length ? c[c.length - 1].z1 : 0;
      const { base, k: K } = columnSlots(core.packed, x, y);
      const col = c.map((iv) => [iv.z0, iv.z1, iv.mat]);
      col.push([top + z0, top + z1, mat]);
      const data = new Uint32Array(K * 4);
      col.slice(0, K).forEach(([a, b, m], s) => writeSlot(data, s, a, b, m));
      core.host.gpu.device.queue.writeBuffer(R.world.layers, base * 16, data);
    };
    // on dry ground beside the pond: a cluster of crystal spires and an ice slab
    const dry = (x, y) => water[y * w + x] < 0.01;
    let ox = px + 14;
    let oy = py;
    for (let t = 0; t < 40; t++) {
      const [cx, cy] = cellAt(ox, oy);
      if (dry(cx, cy)) break;
      ox += 1;
    }
    const spires = [[0, 0, 7], [1.2, 0.6, 4.5], [-0.9, 1.1, 5.5], [0.4, -1.2, 3.5], [-1.4, -0.4, 2.5], [2.1, -0.5, 2]];
    for (const [dx, dy, t] of spires) {
      const [cx, cy] = cellAt(ox + dx, oy + dy);
      put(cx, cy, 0, t, MAT.Crystal);
    }
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const [cx, cy] = cellAt(ox - 7 + dx, oy + 4 + dy);
        if (dry(cx, cy)) put(cx, cy, 0, 1.5, MAT.Ice);
      }
    R.camera.target[0] = (px + ox) / 2;
    R.camera.target[1] = (py + oy) / 2;
    R.camera.zoom *= 7;
    return { px, py, ox, oy };
  });
  if (leaves) throw 'done';
  const totals = () =>
    page.evaluate(async () => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const { MAT } = await import('/src/world/materials.ts');
      const core = R.core;
      const { w, h } = core.dims;
      const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
      const water = new Float32Array((await core.readBuffer('water')).buffer);
      const t = { snow: 0, ice: 0, leaves: 0, crystal: 0, water: 0 };
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          for (const iv of readColumn(core.packed, slots, x, y)) {
            const d = iv.z1 - iv.z0;
            if (iv.mat === MAT.Snow) t.snow += d;
            if (iv.mat === MAT.Ice) t.ice += d;
            if (iv.mat === MAT.LeafLitter) t.leaves += d;
            if (iv.mat === MAT.Crystal) t.crystal += d;
          }
          t.water += water[y * w + x];
        }
      return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)]));
    });
  await wait(1500);
  console.log('warm (start):', JSON.stringify(await totals()));
  await page.screenshot({ path: `${out}-glass.png` });
  // cold, a storm over the pond
  await page.evaluate(
    (t, a) => {
      const R = window.reclaimed;
      R.globals.climate = { temp: t, lapse: 0 };
      R.weather.spawn(a.px, a.py);
    },
    cold,
    at,
  );
  await wait(seconds * 500);
  await page.screenshot({ path: `${out}-snowing.png` });
  await wait(seconds * 500);
  console.log(`cold ${cold} °C, ${seconds} s:`, JSON.stringify(await totals()));
  await page.screenshot({ path: `${out}-cold.png` });
  // the storm gone: the snow in the sun, the pond under its skin of ice
  await page.evaluate(() => {
    window.reclaimed.weather.storms.length = 0;
  });
  await wait(4000);
  await page.screenshot({ path: `${out}-cold-sun.png` });
  await page.evaluate((t) => {
    window.reclaimed.globals.climate = { temp: t, lapse: 0 };
  }, warm);
  await wait(seconds * 1000);
  console.log(`warm ${warm} °C, ${seconds} s:`, JSON.stringify(await totals()));
  await page.screenshot({ path: `${out}-thaw.png` });
} catch (e) {
  if (e !== 'done') throw e;
} finally {
  await browser.close();
}
if (failed) process.exit(1);
