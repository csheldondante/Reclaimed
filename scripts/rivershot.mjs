// The atlas's rivers (round 69): finds a waterfall (a node whose next is far below it), a lava
// river and a wide river; walks in at each and takes a picture from the fixed view, then from the
// free camera beside it.
//   node scripts/rivershot.mjs [--url http://localhost:5203] [--out river] [--which fall,lava,wide] [--wait 15000]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const out = opt('out', 'river');
const which = opt('which', 'fall,lava,wide').split(',');
const waitMs = Number(opt('wait', '15000'));
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
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const spots = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer);
    const W = 8;
    const n = u.length / W;
    const warmAt = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
    let fall = null;
    let lava = null;
    let wide = null;
    for (let k = 0; k < n; k++) {
      const o = k * W;
      const next = u[o + 4];
      const drop = f[o + 2] - f[next * W + 2];
      const warm = warmAt(f[o + 1]);
      const temperate = warm > 0.45 && warm < 0.85;
      const lv = u[o + 5] & 1;
      const at = [Math.floor(f[o]), Math.floor(f[o + 1] / 0.866)];
      const from = [f[o], f[o + 1], f[o + 2]];
      const to = [f[next * W], f[next * W + 1], f[next * W + 2]];
      if (!lv && temperate && drop > 30 && f[o + 2] < 200 && (!fall || drop > fall.drop)) fall = { at, drop: +drop.toFixed(1), level: +f[o + 2].toFixed(1), w: +f[o + 3].toFixed(1), from, to };
      if (lv && warm > 0.3 && f[o + 2] < 200 && (!lava || drop > lava.drop)) lava = { at, drop: +drop.toFixed(1), level: +f[o + 2].toFixed(1), from, to };
      if (!lv && temperate && f[o + 2] > a.p.sea + 4 && (!wide || f[o + 3] > wide.w)) wide = { at, w: +f[o + 3].toFixed(1), level: +f[o + 2].toFixed(1) };
    }
    return { fall, lava, wide, stats: a.riverStats };
  });
  console.log(JSON.stringify(spots));
  await page.close();
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    const lv = await browser.newPage();
    lv.on('pageerror', (e) => console.log(k, 'pageerror:', e.message));
    await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${s.at.join(',')}`, { waitUntil: 'load' });
    await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await new Promise((r) => setTimeout(r, waitMs));
    await lv.evaluate(() => {
      document.getElementById('ui').style.visibility = 'hidden';
      window.reclaimed.stream.auto = false;
    });
    await lv.screenshot({ path: `${out}-${k}.png` });
    // the free camera: back from the spot, a little over it, looking at it
    const st = await lv.evaluate(async (s) => {
      const R = window.reclaimed;
      R.toggleFly();
      const S = R.stream;
      const ox = S.origin[0];
      const oy = S.origin[1] * 0.866;
      if (s.from) {
        // beside a fall: across the way it runs, level with its middle, looking at it
        const a = [s.from[0] - ox, s.from[1] - oy];
        const b = [s.to[0] - ox, s.to[1] - oy];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const d = [b[0] - a[0], b[1] - a[1]];
        const l = Math.hypot(d[0], d[1]) || 1;
        const side = [-d[1] / l, d[0] / l];
        const mz = (s.from[2] + s.to[2]) / 2 - S.oz;
        R.camera.fly.pos = [m[0] + side[0] * 50 + (d[0] / l) * 20, m[1] + side[1] * 50 + (d[1] / l) * 20, mz + 12];
        R.camera.fly.yaw = Math.atan2(m[1] - R.camera.fly.pos[1], m[0] - R.camera.fly.pos[0]);
        R.camera.fly.pitch = Math.atan2(mz - R.camera.fly.pos[2], 54);
      } else {
        const [tx, ty] = R.camera.target;
        const g = R.map.surface[Math.floor(ty / 0.866) * 256 + Math.floor(tx)];
        const yaw = Math.PI * 1.25;
        R.camera.fly.pos = [tx - Math.cos(yaw) * 55, ty - Math.sin(yaw) * 55, g + 30];
        R.camera.fly.yaw = yaw;
        R.camera.fly.pitch = -0.35;
      }
      await new Promise((r) => setTimeout(r, 2000));
      return { oz: S.oz, pos: R.camera.fly.pos.map((v) => +v.toFixed(1)) };
    }, s);
    console.log(k, JSON.stringify(st));
    await lv.screenshot({ path: `${out}-${k}-fly.png` });
    await lv.close();
  }
} finally {
  await browser.close();
}
