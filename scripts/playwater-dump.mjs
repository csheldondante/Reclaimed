// Round 110 (playwater): the playground river's water on the GPU beside its table (riverFlow z), column by column —
// a debugging aid for scripts/playwater.mjs.  node scripts/playwater-dump.mjs [--url] [--x 193,194,195,196,197] [--y 128,146]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5291');
const xs = opt('x', '160,193,194,195,196,197,255').split(',').map(Number);
const [y0, y1] = opt('y', '126,146').split(',').map(Number);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=low`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.stationsBar, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, Number(opt('wait', '30000'))));
  const rows = await p.evaluate(
    async (xs, y0, y1) => {
      const R = window.reclaimed;
      const w = await R.readBuffer('water');
      const rf = R.map.riverFlow;
      const W = R.core.dims.w;
      const out = [];
      for (const x of xs) {
        const cells = [];
        for (let y = y0; y <= y1; y++) {
          const i = y * W + x;
          const t = rf[i * 4 + 2];
          if (w[i] > 0.01 || t > 0) cells.push(`${y}:${w[i].toFixed(2)}/${t.toFixed(2)}@${R.map.surface[i].toFixed(1)}`);
        }
        out.push(`x ${x}: ${cells.join(' ')}`);
      }
      return out;
    },
    xs,
    y0,
    y1,
  );
  console.log('gpu water / table depth @ ground top');
  for (const r of rows) console.log(r);
} finally {
  await browser.close();
}
