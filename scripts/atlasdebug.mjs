// Evaluates a snippet on the atlas viewer page (round 71: debugging the columns): node scripts/atlasdebug.mjs "<js returning JSON-able>"
import puppeteer from 'puppeteer-core';
const js = process.argv[2];
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 300000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:5203/?atlas=view', { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  console.log(JSON.stringify(await page.evaluate(`(async () => { const a = window.reclaimed.atlas; ${js} })()`)));
} finally {
  await browser.close();
}
