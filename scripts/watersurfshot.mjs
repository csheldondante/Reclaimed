// (watersurf, FC2) The water's look, before and after: the same spots on two builds side by side — a lake, the sea
// shore, a river and a waterfall on the atlas (found from the atlas's lakes, coast and river nodes), the fixed view at
// the phone's tier, every system on, 1x. Each spot's two pages load one after the other and are shot after the same wait.
//   node scripts/watersurfshot.mjs --a http://localhost:5322 --b http://localhost:5321 [--out C:/Projects/shots88/watersurf]
//     [--zoom 10] [--wait 35000] [--which lake,shore,river,fall] [--spots "name:x,y;..."] [--size 800x800]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const A = opt('a', 'http://localhost:5322');
const B = opt('b', 'http://localhost:5321');
const out = opt('out', 'C:/Projects/shots88/watersurf');
const zoom = Number(opt('zoom', 10));
const wait = Number(opt('wait', 35000));
const which = opt('which', 'lake,shore,river,fall').split(',');
const [vw, vh] = opt('size', '800x800').split('x').map(Number);
const extra = opt('extra', '');
const RH = Math.sqrt(3) / 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 1.5 },
  protocolTimeout: 900000,
});
let bad = false;
try {
  let spots = {};
  if (opt('spots', '')) {
    for (const s of opt('spots', '').split(';')) {
      const [k, v] = s.split(':');
      spots[k] = v.split(',').map(Number);
    }
  } else {
    const p0 = await browser.newPage();
    await p0.goto(`${B}/?skipmenu=1&tutorial=0&q=low&level=atlas`, { waitUntil: 'load' });
    await p0.waitForFunction(() => window.reclaimed?.atlas?.lakes && window.reclaimed?.stream, { timeout: 300000 });
    spots = await p0.evaluate((RH) => {
      const a = window.reclaimed.atlas;
      const r = {};
      const warmAt = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
      // (the biggest lake in the temperate band: not frozen over)
      const big = a.lakes.filter((l) => warmAt(l.at[1]) > 0.45 && warmAt(l.at[1]) < 0.85).sort((x, y) => y.texels - x.texels)[0];
      if (big) r.lake = [Math.round(big.at[0]), Math.round(big.at[1] / RH)];
      // (rivershot's: the biggest drop, the widest river, in the temperate band)
      const u = a.riverNodes;
      const f = new Float32Array(u.buffer);
      const W = 8;
      let fall = null;
      let wide = null;
      for (let k = 0; k < u.length / W; k++) {
        const o = k * W;
        const next = u[o + 4];
        const drop = f[o + 2] - f[next * W + 2];
        const warm = warmAt(f[o + 1]);
        const temperate = warm > 0.45 && warm < 0.85;
        if (u[o + 5] & 1) continue;
        // (a fall: the node at its lip)
        const at = [Math.floor(f[o]), Math.floor(f[o + 1] / RH)];
        if (temperate && drop > 20 && f[o + 2] < 200 && (!fall || drop > fall.drop)) fall = { at, drop };
        if (temperate && f[o + 2] > a.p.sea + 4 && (!wide || f[o + 3] > wide.w)) wide = { at: [Math.floor(f[o]), Math.floor(f[o + 1] / RH)], w: f[o + 3] };
      }
      if (fall) r.fall = fall.at;
      if (wide) r.river = wide.at;
      // (watershot's: a low land texel with open sea a few texels away)
      const hm = a.hmac;
      if (hm) {
        const n = a.p.n;
        const sea = a.p.sea;
        outer: for (let y = Math.floor(n * 0.4); y < n * 0.6; y++)
          for (let x = 4; x < n - 4; x++) {
            const z = hm[y * n + x];
            if (z < sea + 1 || z > sea + 6) continue;
            if (hm[y * n + x + 3] < sea - 6 || hm[y * n + x - 3] < sea - 6 || hm[(y + 3) * n + x] < sea - 6 || hm[(y - 3) * n + x] < sea - 6) {
              r.shore = [Math.floor((x / n) * a.p.cols), Math.floor((y / n) * a.p.rows)];
              break outer;
            }
          }
      }
      return r;
    }, RH);
    await p0.close();
  }
  console.log('spots', JSON.stringify(spots));
  for (const k of which) {
    const at = spots[k];
    if (!at) {
      console.log(k, 'no spot');
      continue;
    }
    // (one page at a time: a page in the background gets no frames)
    for (const [tag, url] of [
      ['a', A],
      ['b', B],
    ]) {
      const p = await browser.newPage();
      p.on('pageerror', (e) => {
        bad = true;
        console.log(tag, 'pageerror', e.message);
      });
      p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log(tag, 'console.error', m.text().slice(0, 300)));
      await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas&tod=0.35&at=${at.join(',')}${extra}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 300000 });
      await sleep(wait);
      await p.evaluate((zoom) => {
        const u = document.getElementById('ui');
        if (u) u.style.visibility = 'hidden';
        window.reclaimed.camera.zoom = zoom;
      }, zoom);
      await sleep(2500);
      const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
      if (fatal) {
        bad = true;
        console.log(tag, 'FATAL', fatal.slice(0, 400));
      }
      const info = await p.evaluate(() => ({ counts: window.reclaimed.renderer.instanceCounts, target: window.reclaimed.camera.target.map((v) => +v.toFixed(0)) }));
      await p.screenshot({ path: `${out}/${k}-${tag}.png` });
      console.log(k, tag, JSON.stringify(info));
      await p.close();
    }
  }
} finally {
  await browser.close();
}
if (bad) process.exit(1);
