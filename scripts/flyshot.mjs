// The free camera (round 69): walks into the atlas level at a cell, turns the free camera on and
// takes pictures from where it's put — low over the ground looking along it, then higher.
//   node scripts/flyshot.mjs [--url http://localhost:5203] [--at x,y] [--q "a.style=1"] [--out fly]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const at = opt('at', '');
const q = opt('q', '');
const out = opt('out', 'fly');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 300)));
  await page.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high${at ? '&at=' + at : ''}&${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
  const views = [
    // [height over the ground, pitch (deg), yaw (deg), back from the middle]
    [14, -8, 45, 60],
    [40, -18, 135, 80],
    [90, -30, 225, 110],
  ];
  for (let k = 0; k < views.length; k++) {
    const st = await page.evaluate(async (v) => {
      const R = window.reclaimed;
      if (!R.camera.fly) R.toggleFly();
      const [hz, pitch, yaw, back] = v;
      const y = (yaw * Math.PI) / 180;
      const x0 = 128 - Math.cos(y) * back;
      const y0 = 128 * 0.866 - Math.sin(y) * back;
      const g = R.map.surface[Math.floor(y0 / 0.866) * 256 + Math.floor(x0)] ?? 0;
      R.camera.fly.pos = [x0, y0, g + hz];
      R.camera.fly.yaw = y;
      R.camera.fly.pitch = (pitch * Math.PI) / 180;
      await new Promise((r) => setTimeout(r, 2500));
      return { pos: R.camera.fly.pos.map((n) => +n.toFixed(1)), oz: R.stream.oz, slides: R.stream.stats.slides };
    }, views[k]);
    console.log(k, JSON.stringify(st));
    await page.screenshot({ path: `${out}-${k}.png` });
  }
} finally {
  await browser.close();
}
