// Round 100 (zmesh): a route that climbs — from a start cell, the direction (world degrees, as ?pan=speed,deg) along
// which the atlas's macro ground rises most within a distance, and the ground along it. Used for speedsweep's
// mountain climb (--dir), the route that made the window slide in z before round 100. Also spots to look at for
// the hybrid's look (a mesa, a town, a coast, a steep slope), as ?at= cells. Prints JSON.
//   node scripts/climbroute.mjs [--url http://localhost:5285] [--at 11956,15471] [--reach 1200]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5285');
const at = opt('at', '11956,15471').split(',').map(Number);
const reach = Number(opt('reach', 1200));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const r = await page.evaluate(
    (at, reach) => {
      const a = window.reclaimed.atlas;
      const RH = Math.sqrt(3) / 2;
      const x0 = at[0];
      const y0 = at[1] * RH;
      const h0 = a.macroAt(x0, y0);
      let best = null;
      for (let d = 0; d < 360; d += 10) {
        const ux = Math.cos((d * Math.PI) / 180);
        const uy = Math.sin((d * Math.PI) / 180);
        const prof = [];
        let lo = Infinity;
        let hi = -Infinity;
        for (let s = 0; s <= reach; s += 50) {
          const h = a.macroAt(x0 + ux * s, y0 + uy * s);
          prof.push(Math.round(h));
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        if (!best || hi - h0 > best.rise) best = { deg: d, rise: Math.round(hi - h0), lo: Math.round(lo), hi: Math.round(hi), prof };
      }
      // spots: a steep place (the macro ground's largest step over 8 cells) near the start, the sea's edge near it
      let steep = null;
      let coast = null;
      for (let dy = -600; dy <= 600; dy += 16)
        for (let dx = -600; dx <= 600; dx += 16) {
          const x = x0 + dx;
          const y = y0 + dy;
          const h = a.macroAt(x, y);
          const g = Math.max(Math.abs(a.macroAt(x + 8, y) - h), Math.abs(a.macroAt(x, y + 8) - h));
          if (!steep || g > steep.g) steep = { g: +g.toFixed(1), at: [Math.round(x), Math.round(y / RH)], h: Math.round(h) };
          if (h > a.p.sea && a.macroAt(x + 16, y) < a.p.sea && (!coast || Math.hypot(dx, dy) < coast.d)) coast = { d: Math.hypot(dx, dy), at: [Math.round(x), Math.round(y / RH)] };
        }
      return { start: at, h0: Math.round(h0), sea: a.p.sea, zTop: a.p.zTop, climb: best, steep, coast };
    },
    at,
    reach,
  );
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
