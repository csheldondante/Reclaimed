// A sequence of screenshots of one run: set the scene up with JS, then shoot
// at given marks of simulated time, optionally running more JS at each mark.
// For watching a process unfold (a drift burying a structure, a storm).
//
//   node scripts/timelapse.mjs --url "http://localhost:5177/?skipmenu=1&speed=8" \
//     --setup "js run once the level is up" \
//     --marks "10,30,60"              sim seconds after setup to shoot at
//     [--at "30:js run at that mark"]  (repeatable)
//     [--out prefix]                   writes prefix-<mark>.png
//     [--wait 15000] [--size 1600x900]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const all = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const url = opt('url', 'http://localhost:5173/?skipmenu=1');
const [W, H] = opt('size', '1600x900').split('x').map(Number);
const marks = opt('marks', '10').split(',').map(Number);
const atJs = new Map(all('at').map((s) => [Number(s.slice(0, s.indexOf(':'))), s.slice(s.indexOf(':') + 1)]));
const out = opt('out', 'lapse');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 30 * 60 * 1000,
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.log('console.error:', m.text());
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, Number(opt('wait', 15000))));
  const setup = opt('setup');
  // (wrapped: the setup may await, e.g. import a module)
  if (setup) await page.evaluate(`(async () => { ${setup}
})()`);
  const t0 = await page.evaluate(() => window.reclaimed.globals.time);
  for (const m of marks) {
    await page.waitForFunction((t) => window.reclaimed.globals.time >= t, { timeout: 30 * 60 * 1000, polling: 200 }, t0 + m);
    if (atJs.has(m)) await page.evaluate(`(async () => { ${atJs.get(m)}
})()`);
    await new Promise((r) => setTimeout(r, 300));
    const file = `${out}-${m}.png`;
    await page.screenshot({ path: file });
    console.log(`t=${m}s saved ${file}`);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
