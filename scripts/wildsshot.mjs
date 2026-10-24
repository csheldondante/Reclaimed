import puppeteer from 'puppeteer-core';
const url = process.argv[2] ?? 'http://localhost:5195';
const out = process.argv[3] ?? 'wilds';
const extra = process.argv[4] ?? '';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 300)); });
const t0 = Date.now();
await p.goto(`${url}/?skipmenu=1&level=wilds&tutorial=0&tod=0.35${extra}`, { waitUntil: 'load' });
await p.waitForFunction(() => window.reclaimed?.core, { timeout: 120000 });
console.log('loaded in', Date.now() - t0, 'ms');
await new Promise((r) => setTimeout(r, 5000));
await p.screenshot({ path: `${out}-wide.png` });
const info = await p.evaluate(() => {
  const R = window.reclaimed;
  const m = R.map;
  // caves: columns with air between intervals; a mouth: one whose gap's floor lies above a neighbour's top
  const { w, h } = R.core.dims;
  let caves = 0;
  let mouth = null;
  let basalt = 0;
  for (let i = 0; i < w * h; i++) {
    const c = m.grid.cols[i];
    for (let k = 1; k < c.length; k++)
      if (c[k].z0 > c[k - 1].z1 + 0.5) {
        caves++;
        const x = i % w;
        const y = (i / w) | 0;
        const nb = m.grid.cols[i + 2] ?? c;
        if (!mouth && nb[nb.length - 1].z1 < c[k - 1].z1 + 0.5 && c[k].z1 - c[k].z0 > 2) mouth = [x, y];
        break;
      }
    if (c.some((v) => v.mat === 23)) basalt++;
  }
  m.poi.mouth = mouth ?? m.poi.peak;
  return { forms: m.forms, poi: m.poi, places: R.places?.loaded, caves, basalt, mouth };
});
console.log(JSON.stringify(info));
for (const [k, z] of [['peak', 9], ['lake', 7], ['mouth', 16]]) {
  await p.evaluate((k, z) => {
    const R = window.reclaimed;
    const [cx, cy] = R.map.poi[k];
    R.camera.target = [cx + 0.5, (cy + 0.5) * 0.866, R.map.surface[cy * R.core.dims.w + cx]];
    R.camera.zoom = z;
  }, k, z);
  await new Promise((r) => setTimeout(r, 1500));
  await p.screenshot({ path: `${out}-${k}.png` });
}
console.log(errs.slice(0, 8).join('\n'));
await b.close();
