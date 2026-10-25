// Round 78: are the great caverns in the columns? Scans the atlas for a column with a void 20+ tall
// under a plateau or massif and prints its runs.  node scripts/cavernprobe.mjs [--url http://localhost:5207]
import puppeteer from 'puppeteer-core';
const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://localhost:5207';
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
  const out = await page.evaluate(async () => {
    const a = window.reclaimed.atlas;
    const n = a.p.n;
    // the deepest texels of the high landforms (by the ground), a few to try
    const tries = [];
    for (let t = 0; t < n * n; t += 997) {
      const d = a.defs[a.regionOf[t]];
      if (d.words[49] >= 2 && a.hmac[t] > 120) tries.push(t);
    }
    let found = null;
    let tried = 0;
    for (const t of tries.slice(0, 200)) {
      tried++;
      const x0 = Math.floor(((t % n) / n) * a.p.cols);
      const y0 = Math.floor((Math.floor(t / n) / n) * a.p.rows);
      const c = await a.columns(x0, y0, 16, 16);
      for (let i = 0; i < 256 && !found; i++) {
        let prev = null;
        for (let k = 0; k < 24; k++) {
          const r = c.run(i, k);
          if (!r || r.z1 <= r.z0) break;
          if (prev && r.z0 - prev.z1 > 20 && prev.z1 < a.p.sea + 12) {
            const runs = [];
            for (let q = 0; q < 24; q++) {
              const s = c.run(i, q);
              if (!s || s.z1 <= s.z0) break;
              runs.push(`${s.mat}:${s.z0.toFixed(1)}-${s.z1.toFixed(1)}`);
            }
            found = { at: [x0 + (i % 16), y0 + Math.floor(i / 16)], gap: [prev.z1, r.z0], runs };
          }
          prev = r;
        }
      }
      if (found) break;
    }
    return { tries: tries.length, tried, found };
  });
  console.log(JSON.stringify(out));
} finally {
  await browser.close();
}
