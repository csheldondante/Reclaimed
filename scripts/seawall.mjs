// Round 88: a steep wall of water by the sea (the user, on the phone at the atlas level) — the phone's
// defaults (q=low, 412x915, hybrid, rivers=table, simcull), the window at coasts and river mouths, shot at
// the default zoom and zoomed in.
//   node scripts/seawall.mjs [--url http://localhost:5317] [--out C:/Projects/shots88/sea/before] [--n 6]
//   [--spots "x,y;x,y"] [--extra "&foo=1"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5317');
const out = opt('out', 'C:/Projects/shots88/sea/before');
const nSpots = Number(opt('n', 6));
const extra = opt('extra', '');
const zooms = opt('zooms', 'def,10').split(',');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const open = async (q) => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas${q}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.atlas?.hmac, { timeout: 300000 });
  return p;
};
try {
  let spots = opt('spots', '');
  let list = spots ? spots.split(';') : [];
  if (!list.length) {
    const p = await open('');
    list = await p.evaluate((nSpots) => {
      const a = window.reclaimed.atlas;
      const n = a.p.n;
      const hm = a.hmac;
      const sea = a.p.sea;
      const toCell = (x, y) => `${Math.floor((x / n) * a.p.cols)},${Math.floor((y / n) * a.p.rows)}`;
      const res = [];
      // coasts (a beach beside open sea), spread through the warm band
      let lastY = -1e9;
      for (let y = Math.floor(n * 0.3); y < n * 0.7 && res.length < Math.ceil(nSpots / 2); y++) {
        if (y - lastY < n * 0.05) continue;
        for (let x = 2; x < n - 2; x++) {
          const z = hm[y * n + x];
          if (z < sea + 1 || z > sea + 8) continue;
          if (hm[y * n + x + 3] < sea - 6 || hm[y * n + x - 3] < sea - 6 || hm[(y + 3) * n + x] < sea - 6 || hm[(y - 3) * n + x] < sea - 6) {
            res.push('coast ' + toCell(x, y));
            lastY = y;
            break;
          }
        }
      }
      // river mouths: a river node whose next is the sea's (its level sea - 0.4)
      const N = a.riverNodes;
      const f = new Float32Array(N.buffer, N.byteOffset, N.length);
      const W = 8;
      const cnt = N.length / W;
      const mouths = [];
      for (let k = 0; k < cnt; k++) {
        const nx = N[k * W + 4];
        if (nx === k || (N[k * W + 5] & 1) !== 0) continue;
        if (Math.abs(f[nx * W + 2] - (sea - 0.4)) < 0.01 && f[k * W + 3] > 5) mouths.push([f[k * W], f[k * W + 1], f[k * W + 3]]);
      }
      mouths.sort((p, q) => q[2] - p[2]);
      for (let k = 0; k < mouths.length && res.length < nSpots; k += Math.max(1, Math.floor(mouths.length / nSpots)))
        res.push(`mouth ${Math.floor(mouths[k][0])},${Math.floor(mouths[k][1] / (a.worldH / a.p.rows))}`);
      return res;
    }, nSpots);
    await p.close();
  }
  console.log('spots', JSON.stringify(list));
  let k = 0;
  for (const s of list) {
    const at = s.split(' ').pop();
    const tag = `${out}-${k}-${s.split(' ')[0]}`;
    const p = await open(`&at=${at}`);
    await sleep(35000);
    for (const z of zooms) {
      if (z !== 'def') await p.evaluate((z) => (window.reclaimed.camera.zoom = z), Number(z));
      else await p.evaluate(() => console.log('zoom', window.reclaimed.camera.zoom));
      await sleep(3000);
      await p.screenshot({ path: `${tag}-z${z}.png` });
    }
    const info = await p.evaluate(() => {
      const r = window.reclaimed;
      return { origin: r.stream.origin, oz: r.stream.oz, seaZ: r.globals.seaZ, zoom: r.camera.zoom };
    });
    console.log(s, JSON.stringify(info));
    const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal) console.log('FATAL', fatal);
    await p.close();
    k++;
  }
} finally {
  await browser.close();
}
