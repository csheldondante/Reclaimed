// Round 112 (BACKLOG MF2): why the meteor's dust and wind read weaker on a PC than on the phone. At a page size, the
// particles' ring (particles.wgsl spawnFull: every spawn takes the next slot, whatever lives there) — how fast it
// turns over (spawns a second, idle), and how many of a meteor's haze puffs (kind 15) are still alive after it lands.
//   node scripts/meteorparts.mjs [--url http://localhost:5241] [--size 1600x900] [--dpr 1] [--level atlas] [--params &...]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5241');
const [W, H] = opt('size', '1600x900').split('x').map(Number);
const dpr = Number(opt('dpr', 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: dpr },
  protocolTimeout: 900000,
});
let errors = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    errors++;
    console.log('pageerror', e.message);
  });
  await p.goto(`${url}/?skipmenu=1&tutorial=0&level=${opt('level', 'atlas')}${opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.camera && window.reclaimed?.api, { timeout: 240000 });
  await sleep(32000);
  const count = () => p.evaluate(async () => new Uint32Array((await window.reclaimed.readBuffer('particleCounters')).buffer)[0]);
  const c0 = await count();
  const t0 = Date.now();
  await sleep(3000);
  const c1 = await count();
  const cap = await p.evaluate(() => window.reclaimed.core.world.particleCap);
  const rate = ((c1 - c0) / (Date.now() - t0)) * 1000;
  console.log(`${W}x${H} dpr ${dpr}: cap ${cap}, idle spawns ${rate.toFixed(0)}/s (the ring turns over in ${(cap / Math.max(rate, 1)).toFixed(1)} s)`);
  // a meteor at the screen's middle ground, at once; its haze counted as it lives
  await p.evaluate(async () => {
    const R = window.reclaimed;
    const [x, y] = R.camera.target;
    await R.api.terrain.refresh();
    R.meteorNow(x, y, R.api.terrain.heightAt(x, y) + 0.5);
  });
  const m0 = Date.now();
  const line = [];
  for (const t of [0.3, 1, 2, 3, 4, 6]) {
    const w = m0 + t * 1000 - Date.now();
    if (w > 0) await sleep(w);
    const n = await p.evaluate(async () => {
      const f = await window.reclaimed.readBuffer('particles');
      const u = new Uint32Array(f.buffer);
      let haze = 0;
      const kinds = {};
      for (let k = 0; k < f.length; k += 12)
        if (f[k + 3] > 0) {
          if (u[k + 8] === 15) haze++;
          kinds[u[k + 8]] = (kinds[u[k + 8]] ?? 0) + 1;
        }
      return `${haze} [${Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ':' + n).join(' ')}]`;
    });
    line.push(`${t}s ${n}`);
  }
  const c2 = await count();
  console.log(`haze alive after the meteor: ${line.join(', ')}; spawns over those 6 s ${(((c2 - c1) / (Date.now() - m0)) * 1000).toFixed(0)}/s`);
} finally {
  await browser.close();
}
process.exit(errors ? 1 : 0);
