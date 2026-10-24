// Walks into the atlas level and prints what the page says while it starts (round 69: why a start hangs).
//   node scripts/atlaserr.mjs "<query>"
import puppeteer from 'puppeteer-core';
const q = process.argv[2] ?? '';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 30000,
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 400)));
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('error', (e) => console.log('crash', e.message));
  await page.goto(`http://localhost:5203/?skipmenu=1&level=atlas&tutorial=0&${q}`, { waitUntil: 'load' });
  const t0 = Date.now();
  for (let k = 0; k < 40; k++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await page
      .evaluate(() => ({ stream: !!window.reclaimed?.stream, atlas: !!window.reclaimed?.atlas, tick: window.reclaimed?.globals?.tick, body: document.body.innerText.slice(0, 200) }))
      .catch((e) => ({ err: e.message }));
    console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(s));
    if (s.stream || s.err) break;
  }
} finally {
  await browser.close();
}
