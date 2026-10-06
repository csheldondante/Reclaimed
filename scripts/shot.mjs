// Headless verification helper: loads the game in Chrome with WebGPU, runs
// optional page scripts, prints console output and saves screenshots.
//
//   node scripts/shot.mjs [--url URL] [--out file.png] [--wait ms]
//        [--eval "js"] [--then ms --out2 file2.png] [--size 1600x900]
//
// Fails loudly (non-zero exit) on page errors or a missing adapter.
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://localhost:5173/?perf=1';
const [w, h] = (args.size ?? '1600x900').split('x').map(Number);
const chrome = args.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => {
    failed = true;
    console.log(`[pageerror] ${e.message}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, Number(args.wait ?? 4000)));
  const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) {
    failed = true;
    console.log(`[fatal] ${fatal}`);
  }
  if (args.eval) {
    const r = await page.evaluate(args.eval);
    if (r !== undefined) console.log(`[eval] ${JSON.stringify(r)}`);
  }
  // --clicks "x,y;wait:ms;x,y"  (CSS px)  --drag "x0,y0,x1,y1"
  if (args.clicks) {
    for (const c of args.clicks.split(';')) {
      if (c.startsWith('wait:')) { await new Promise((r) => setTimeout(r, Number(c.slice(5)))); continue; }
      const [x, y] = c.split(',').map(Number);
      await page.mouse.click(x, y);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (args.drag) {
    const [x0, y0, x1, y1] = args.drag.split(',').map(Number);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * i) / 20);
      await new Promise((r) => setTimeout(r, 30));
    }
    await page.mouse.up();
  }
  if (args.then) await new Promise((r) => setTimeout(r, Number(args.then)));
  await page.screenshot({ path: args.out ?? 'shot.png' });
  console.log(`saved ${args.out ?? 'shot.png'}`);
  if (args.eval2) {
    const r = await page.evaluate(args.eval2);
    if (r !== undefined) console.log(`[eval2] ${JSON.stringify(r)}`);
  }
  if (args.out2) {
    await new Promise((r) => setTimeout(r, Number(args.then2 ?? 3000)));
    await page.screenshot({ path: args.out2 });
    console.log(`saved ${args.out2}`);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
