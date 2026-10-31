// Round 120 (runsit, the phone bug): a run page as a slow phone sees it — 412x915, the CPU throttled (CDP), a chosen GPU
// path (--gpu d3d11 | swiftshader) — and what came up: the run's card, the hero held, the situation (the GM's or the
// template, and why), the world's print, the fatal overlay if any, console errors and warnings.
//   node scripts/phoneprobe.mjs --url "<page url>" [--gpu swiftshader] [--throttle 4] [--wait 120000]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const url = opt('url', 'https://csheldondante.github.io/Reclaimed/runsit/?skipmenu=1&level=atlas&runplan=hoverbike');
const gpu = opt('gpu', 'd3d11');
const args = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=412,915'];
if (gpu === 'swiftshader') args.push('--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader');
else args.push('--use-angle=d3d11');
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args, defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 }, protocolTimeout: 600000 });
try {
  const p = await b.newPage();
  const logs = [];
  p.on('console', (m) => ['error', 'warn', 'warning'].includes(m.type()) && logs.push(`${m.type()}: ${m.text().slice(0, 400)}`));
  p.on('pageerror', (e) => logs.push(`pageerror: ${e.message.slice(0, 400)}`));
  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(opt('throttle', '4')) });
  const t0 = Date.now();
  await p.goto(url, { waitUntil: 'load', timeout: 300000 });
  await p.waitForFunction(() => (window.reclaimed?.runsit && window.reclaimed.runhero?.hero) || document.querySelector('.fatal'), { timeout: Number(opt('wait', '240000')), polling: 500 }).catch(() => logs.push('timeout: no run and no fatal'));
  const r = await p.evaluate(() => {
    const L = window.reclaimed?.runsit;
    const f = document.querySelector('.fatal')?.textContent ?? null;
    return {
      fatal: f,
      run: L ? { by: L.by, note: L.byNote ?? null, sit: L.run.sit.id, print: L.run.sit.from.print ?? null, target: L.run.sit.target.name, card: L.card.textContent.slice(0, 200), held: window.reclaimed.runhero.paused } : null,
      adapter: window.reclaimed?.core?.host?.gpu?.adapterInfo ?? null,
    };
  });
  console.log(JSON.stringify({ gpu, s: ((Date.now() - t0) / 1000).toFixed(1), ...r, logs: logs.slice(0, 15) }, null, 1));
  await p.screenshot({ path: `C:/Projects/shots88/runsit/phoneprobe-${gpu}.png` });
} finally {
  await b.close();
}
