// Round 79: the band outside the window — what's packed and meshed, at a cell (the atlas level).
//   node scripts/bandprobe.mjs [--url http://localhost:5207] [--at 10084,7632] [--out band] [--skip band]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const at = opt('at', '10084,7632');
const out = opt('out', 'band');
const skip = opt('skip', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 300)));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&perf=1&at=${at}${opt('win', '') ? `&win=${opt('win', '')}` : ''}${skip ? `&skip=${skip}` : ''}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 8000));
  const info = await p.evaluate(() => {
    const R = window.reclaimed;
    const b = R.renderer.band;
    const pm = {};
    for (const [k, v] of R.core.host.profiler.passMs) if (k.includes('fieldmesh')) pm[k] = +v.toFixed(3);
    return { gpuMs: pm, oz: R.stream.oz, band: b ? { packed: b.stats, mesh: b.mesh.stats, drawn: b.mesh.drawn } : null, live: R.renderer.fieldMesh.stats };
  });
  console.log(JSON.stringify(info));
  await p.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
  await p.screenshot({ path: `${out}-iso.png` });
  // (zoomed out: --zoom 0.3, the whole window)
  for (const z of opt('zoom', '').split(',').filter(Boolean).map(Number)) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
    await new Promise((r) => setTimeout(r, 4000));
    await p.screenshot({ path: `${out}-iso-${z}.png` });
  }
} finally {
  await browser.close();
}
