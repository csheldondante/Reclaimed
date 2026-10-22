// Touch controls (round 41): a two-finger pinch, one finger lifted, the other
// dragged on — it must pan (no tap, no gust from where it first landed);
// then a one-finger drag (a gust) and a pinch after it. Prints what each step
// did to the camera and whether a gust ran.
//
//   node scripts/touchtest.mjs [--url http://localhost:5177] [--extra "&mesh=1"]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5177');
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=900,900'],
  defaultViewport: { width: 900, height: 900, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  await page.goto(`${url}/?skipmenu=1&level=valley&tutorial=0&mode=free${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 5000));
  const cdp = await page.createCDPSession();
  // (each event lists the fingers down, by id: a finger left out is lifted)
  const touch = (type, pts, ids) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: ids?.[i] ?? i })) });
  const frame = () => new Promise((r) => setTimeout(r, 40));
  const state = () =>
    page.evaluate(() => {
      const R = window.reclaimed;
      return { t: [...R.camera.target.slice(0, 2)].map((v) => +v.toFixed(2)), zoom: +R.camera.zoom.toFixed(3), gust: !!R.powers.gust };
    });
  let gusted = false;
  const watch = async () => (gusted ||= (await state()).gust);

  console.log('start', await state());
  // pinch out with two fingers
  await touch('touchStart', [[400, 450], [500, 450]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[400 - i * 8, 450], [500 + i * 8, 450]]);
    await frame();
    await watch();
  }
  console.log('after pinch', await state(), 'gust during:', gusted);
  // lift the second finger, drag the first on
  await touch('touchEnd', [[580, 450]], [1]);
  await frame();
  console.log('one lifted', await state());
  gusted = false;
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[320 + i * 15, 450 + i * 10]], [0]);
    await frame();
    await watch();
  }
  await touch('touchEnd', []);
  await frame();
  console.log('after one finger left of a pinch', await state(), 'gust during:', gusted);
  // a one-finger drag: a gust
  gusted = false;
  await touch('touchStart', [[450, 450]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[450 + i * 12, 450]]);
    await frame();
    await watch();
  }
  await touch('touchEnd', []);
  await frame();
  console.log('after a one-finger drag', await state(), 'gust during:', gusted);
  // and a pinch after it
  await touch('touchStart', [[400, 450], [500, 450]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[400 + i * 4, 450], [500 - i * 4, 450]]);
    await frame();
  }
  await touch('touchEnd', []);
  await frame();
  console.log('after a pinch in', await state());
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
