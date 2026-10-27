// (perfopt, round 83)
// Generated water at rest? The atlas level (the low tier's settle=0: land comes in asleep), then every chunk woken
// with no edits, the water read at 0 and after 5 s: how much moved.
//   node waterrest.mjs "&flags" [at]
import puppeteer from 'puppeteer-core';
const URL0 = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://localhost:5211';
const [extra = '', at = '12304,5457', secs = '5'] = process.argv.slice(2).filter((a, i, all) => a !== '--url' && all[i - 1] !== '--url');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=600,600'],
  defaultViewport: { width: 600, height: 600, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${URL0}/?skipmenu=1&level=atlas&tutorial=0&at=${at}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await p.evaluate(async (secs) => {
    const R = window.reclaimed;
    const core = R.core;
    const read = async () => new Float32Array((await core.readBuffer('water')).buffer.slice(0));
    const readS = async () => new Uint32Array((await core.readBuffer('surface')).buffer.slice(0));
    const w0 = await read();
    const s0 = await readS();
    const src = new Float32Array((await core.readBuffer('waterSource')).buffer.slice(0));
    const drift = (await core.readTexture(core.world.drift)).data;
    const awake0 = core.sleep?.awake;
    // every chunk awake for the test (as if the player had walked everywhere at once)
    core.sleep?.wakeAll(secs + 5, performance.now() / 1000);
    const t0 = core.sim.tick;
    await new Promise((res) => setTimeout(res, secs * 1000));
    const w1 = await read();
    const ticks = core.sim.tick - t0;
    const W = core.dims.w;
    let wet0 = 0, wet1 = 0, vol0 = 0, vol1 = 0, moved = 0, big = 0, max = 0, maxAt = -1;
    const hot = new Map();
    for (let i = 0; i < w0.length; i++) {
      if (w0[i] > 0.02) wet0++;
      if (w1[i] > 0.02) wet1++;
      vol0 += w0[i];
      vol1 += w1[i];
      const d = Math.abs(w1[i] - w0[i]);
      moved += d;
      if (d > 0.05) {
        big++;
        const k = `${Math.floor((i % W) / 32)},${Math.floor(Math.floor(i / W) / 32)}`;
        hot.set(k, (hot.get(k) ?? 0) + 1);
      }
      if (d > max) { max = d; maxAt = i; }
    }
    const x = maxAt % W, y = Math.floor(maxAt / W);
    const g = (s0[maxAt] & 0xffff) / 256;
    const cls = { sea: [0, 0, 0], river: [0, 0, 0], other: [0, 0, 0], dry: [0, 0, 0] };
    const sea = core.globals.seaZ;
    for (let i = 0; i < w0.length; i++) {
      const g = (s0[i] & 0xffff) / 256 + drift[i * 4];
      let c = 'dry';
      if (w0[i] > 0.02) c = src[i] !== 0 ? 'river' : Math.abs(g + w0[i] - sea) < 0.15 ? 'sea' : 'other';
      const d = w1[i] - w0[i];
      cls[c][0]++;
      if (Math.abs(d) > 0.05) cls[c][1]++;
      cls[c][2] += d;
    }
    for (const k in cls) cls[k][2] = +cls[k][2].toFixed(1);
    return { cls, ticks, awake0, wet0, wet1, vol0: +vol0.toFixed(0), vol1: +vol1.toFixed(0), moved: +moved.toFixed(0), colsOver005: big, max: +max.toFixed(2), maxAt: [x, y, 'ground', +g.toFixed(1), 'd0', +w0[maxAt].toFixed(2), 'd1', +w1[maxAt].toFixed(2)], hot: [...hot].sort((a, b) => b[1] - a[1]).slice(0, 8), seaZ: core.globals.seaZ };
  }, Number(secs));
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
