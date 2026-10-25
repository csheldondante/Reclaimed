// Round 78: a mesa's edge in the columns — overhangs (an open under rock), talus (loose soil, sand, rubble
// two or more deep), boulders. Scans 128 × 128 columns round a cell.
//   node scripts/mesaprobe.mjs [--url http://localhost:5207] [--at 4951,12766]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const at = opt('at', '4951,12766').split(',').map(Number);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const out = await page.evaluate(async (at) => {
    const a = window.reclaimed.atlas;
    const S = 128;
    const c = await a.columns(at[0] - S / 2, at[1] - S / 2, S, S);
    let over = 0;
    let lips = 0;
    const lipSample = [];
    let talus = 0;
    let deepest = 0;
    const sample = [];
    for (let i = 0; i < S * S; i++) {
      const runs = [];
      for (let k = 0; k < 24; k++) {
        const r = c.run(i, k);
        if (!r || r.z1 <= r.z0) break;
        runs.push(r);
      }
      for (let k = 1; k < runs.length; k++) {
        const gap = runs[k].z0 - runs[k - 1].z1;
        if (gap >= 3) {
          over++;
          if (sample.length < 4) sample.push(runs.map((s) => `${s.mat}:${s.z0.toFixed(1)}-${s.z1.toFixed(1)}`).join(' '));
          break;
        }
      }
      // (a lip: the top run thin, 4–16, over an open 3 or more)
      const n = runs.length;
      if (n >= 2 && runs[n - 1].z1 - runs[n - 1].z0 <= 16 && runs[n - 1].z0 - runs[n - 2].z1 >= 3) {
        lips++;
        if (lipSample.length < 4) lipSample.push(runs.map((s) => `${s.mat}:${s.z0.toFixed(1)}-${s.z1.toFixed(1)}`).join(' '));
      }
      const top = runs[runs.length - 1];
      if (top && (top.mat === 2 || top.mat === 3 || top.mat === 4) && top.z1 - top.z0 >= 2) {
        talus++;
        deepest = Math.max(deepest, top.z1 - top.z0);
      }
    }
    return { cols: S * S, over, lips, lipSample, talus, deepest: +deepest.toFixed(1), sample };
  }, at);
  console.log(JSON.stringify(out));
} finally {
  await browser.close();
}
