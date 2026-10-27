// Round 83: what craters cost — the atlas level, a crater every half second round the camera (as the
// hoverbike's cannon makes them: the world API's terrain.crater), frame times over the run and the integrity
// system's counts (rock judged by the columns cut, what's freed falls).
//   node scripts/craterbench.mjs [--url http://localhost:5207] [--q low] [--seconds 15] [--radius 3]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const q = opt('q', 'low');
const seconds = Number(opt('seconds', 15));
const radius = Number(opt('radius', 3));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=${q}&level=atlas${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(12000);
  const r = await p.evaluate(
    (seconds, radius) =>
      new Promise((done) => {
        const R = window.reclaimed;
        R.stream.auto = false;
        const t = R.api.terrain;
        const [cx, cy] = R.camera.target;
        const ft = [];
        let last = performance.now();
        const end = last + seconds * 1000;
        let next = last;
        let n = 0;
        const f = (now) => {
          ft.push(now - last);
          last = now;
          if (now >= next) {
            next = now + 500;
            const a = n * 2.4;
            const d = 6 + (n % 5) * 4;
            t.crater(cx + Math.cos(a) * d, cy + Math.sin(a) * d, { radius });
            n++;
          }
          if (now < end) requestAnimationFrame(f);
          else done({ ft, n, stats: R.integrity?.()?.stats });
        };
        requestAnimationFrame(f);
      }),
    seconds,
    radius,
  );
  const s = [...r.ft].sort((a, b) => a - b);
  const qq = (k) => +s[Math.floor(k * (s.length - 1))].toFixed(1);
  console.log(JSON.stringify({ craters: r.n, frames: r.ft.length, p50: qq(0.5), p95: qq(0.95), p99: qq(0.99), worst: qq(1), over50: r.ft.filter((x) => x > 50).length, integrity: r.stats }));
} finally {
  await browser.close();
}
