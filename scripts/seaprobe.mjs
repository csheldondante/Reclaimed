// Round 79: the sea in a streamed window stays (water_flux: past the edge the world is sea at its level) —
// the window's water a while after it's made, at a coast.  node scripts/seaprobe.mjs [--at 13438,13754]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const at = argv.includes('--at') ? argv[argv.indexOf('--at') + 1] : '13438,13754';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'], protocolTimeout: 600000 });
try {
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`http://localhost:5207/?skipmenu=1&level=atlas&tutorial=0&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  for (const t of [2000, 15000]) {
    await new Promise((r) => setTimeout(r, t));
    console.log(await p.evaluate(async () => {
      const R = window.reclaimed;
      const w = new Float32Array((await R.readBuffer('water')).buffer);
      let wet = 0;
      let deep = 0;
      let maxw = 0;
      for (let i = 0; i < w.length; i++) {
        if (w[i] > 0.05) wet++;
        if (w[i] > 10) deep++;
        maxw = Math.max(maxw, w[i]);
      }
      return JSON.stringify({ oz: R.stream.oz, seaZ: R.globals.seaZ, wet, deep, maxw: +maxw.toFixed(1), ticks: R.globals.tick });
    }));
  }
} finally {
  await b.close();
}
