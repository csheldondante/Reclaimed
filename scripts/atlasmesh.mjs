// The field mesh's room in the atlas level at a cell (round 69: chunks out of room show as holes).
//   node scripts/atlasmesh.mjs "<query>"
import puppeteer from 'puppeteer-core';
const q = process.argv[2] ?? '';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800 },
  protocolTimeout: 300000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:5203/?skipmenu=1&level=atlas&tutorial=0&q=high&${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 6000));
  const s = await page.evaluate(() => ({ integ: window.reclaimed.integrity()?.stats, mesh: window.reclaimed.renderer.fieldMesh.stats, vertsMB: +(window.reclaimed.renderer.fieldMesh.verts.size / 1e6).toFixed(1), gaps: window.reclaimed.atlas.gapsFilled }));
  console.log(JSON.stringify(s));
} finally {
  await browser.close();
}
