// Round 82 (V21): the cutaway seen â€” the window searched for the spot most hidden from the eye (the ground
// toward the camera rising over the line of sight), the camera put on it, a shot without and with the cutaway.
//   node scripts/cutshot.mjs [--url http://localhost:5207] [--at 12304,5457] [--r 10] [--zoom 10] [--out C:/Projects/shots78/cut]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
let at = opt('at', '12304,5457');
const r = Number(opt('r', 14));
const zoom = Number(opt('zoom', 10));
const out = opt('out', 'C:/Projects/shots78/cut');
// (--level valley: no streaming — the window never slides under the stand-in)
const level = opt('level', 'atlas');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=900,900'],
  defaultViewport: { width: 900, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  // (--at steep: the atlas's steepest land above the sea — a cliff to hide behind)
  if (at === 'steep') {
    const v = await browser.newPage();
    await v.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
    at = await v.evaluate(() => {
      const a = window.reclaimed.atlas;
      const n = a.p.n;
      const hm = a.hmac;
      let best = 0;
      let bx = 0;
      let by = 0;
      for (let y = 1; y < n - 1; y++)
        for (let x = 1; x < n - 1; x++) {
          const z = hm[y * n + x];
          if (z < a.p.sea + 20) continue;
          const g = Math.abs(hm[y * n + x + 1] - hm[y * n + x - 1]) + Math.abs(hm[(y + 1) * n + x] - hm[(y - 1) * n + x]);
          if (g > best) [best, bx, by] = [g, x, y];
        }
      return `${Math.floor((bx / n) * a.p.cols)},${Math.floor((by / n) * a.p.rows)}`;
    });
    await v.close();
    console.log('steep at', at);
  }
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&q=high&speed=0&cutaway=1${level === 'atlas' ? `&at=${at}` : ''}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.api, { timeout: 240000 });
  await sleep(20000);
  await p.evaluate(() => window.reclaimed.api.terrain.refresh());
  // two stand-in characters: on a cave's floor (rock 2.5–12 over it: the slice) and at the foot of the
  // highest rise toward the eye (the view turns)
  const spots = await p.evaluate(() => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const { w, h } = R.core.dims;
    const e = R.camera.eye;
    const l = Math.hypot(e[0], e[1]);
    const [fx, fy, rise] = [e[0] / l, e[1] / l, e[2] / l];
    const H = (x, y) => T.heightAt(x, y) ?? 0;
    // (near the view's height: a spot far up or down slides the window's z band)
    const tz = R.camera.target[2];
    let cave = null;
    let cliff = null;
    for (let y = h * 0.15; y < h * 0.85; y += 2)
      for (let x = w * 0.15; x < w * 0.85; x += 2) {
        const ls = (T.layersAt(x, y) ?? []).filter((v) => v.state === 'solid' || v.state === 'loose');
        for (let k = 0; k + 1 < ls.length; k++) {
          const gap = ls[k + 1].z0 - ls[k].z1;
          if (gap >= 2.5 && gap < 12 && T.materialAt(x, y, ls[k].z1 + 1) === 'air' && Math.abs(ls[k].z1 - tz) < 25 && (!cave || ls[k + 1].z1 - ls[k].z1 > cave.over)) cave = { x, y, z: ls[k].z1, gap, over: ls[k + 1].z1 - ls[k].z1 };
        }
        const z = H(x, y);
        let over = 0;
        for (let k = 2; k <= 30; k++) over = Math.max(over, H(x + fx * k, y + fy * k) - (z + 1.5 + k * rise));
        if (Math.abs(z - tz) < 25 && (!cliff || over > cliff.over)) cliff = { x, y, z, over };
      }
    return { cave, cliff };
  });
  console.log('spots', JSON.stringify(spots));
  for (const [name, s] of Object.entries(spots)) {
    if (!s) continue;
    await p.evaluate((s, z) => {
      const R = window.reclaimed;
      R.camera.target = [s.x, s.y, s.z];
      R.camera.zoom = z;
      R.camera.azimuth = Math.PI / 4;
    }, s, zoom);
    // (off: the camera's focus cleared after the cutaway wrote it — a frame's hook)
    await p.evaluate(() => {
      const c = window.reclaimed.scene.cutaway;
      c.__update ??= c.update;
      c.update = function () { window.reclaimed.camera.focus = null; };
    });
    await sleep(4000);
    await p.screenshot({ path: `${out}-${name}-off.png` });
    await p.evaluate(() => {
      const c = window.reclaimed.scene.cutaway;
      c.update = c.__update;
    });
    await sleep(2500);
    const st = await p.evaluate(() => {
      const c = window.reclaimed.scene.cutaway;
      return { target: window.reclaimed.camera.target.map((v) => +v.toFixed(1)), mode: c.mode, open: c.open, floor: c.floor, az: +(window.reclaimed.camera.azimuth * 180 / Math.PI).toFixed(0), focus: window.reclaimed.camera.focus };
    });
    console.log(name, JSON.stringify(st));
    await p.screenshot({ path: `${out}-${name}-on.png` });
  }
} finally {
  await browser.close();
}
