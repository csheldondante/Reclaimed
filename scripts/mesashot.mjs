// A mesa's edge and a crystal field (round 78): finds a cliffside site in a temperate place (a plateau's rim)
// and the largest field of facets; shoots each in the viewer (ground) close up, then walks in at each.
//   node scripts/mesashot.mjs [--url http://localhost:5207] [--out mesa] [--which mesa,field] [--pick 0] [--win 512]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'mesa');
const which = opt('which', 'mesa,foot,field').split(',');
const pick = Number(opt('pick', 0));
const mode = opt('mode', 'ground');
const game = opt('game', '1') !== '0';
// (--cam x,y,z,tx,ty: the fly camera put there in the window, looking at (tx, ty), instead of found)
const cam = opt('cam', '') ? opt('cam', '').split(',').map(Number) : null;
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const spots = await page.evaluate((pick) => {
    const a = window.reclaimed.atlas;
    const warm = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
    const cliffs = a.settlement.sites.filter((s) => s.setting === 0 && warm(s.y) > 0.72 && warm(s.y) < 0.95);
    const m = cliffs[Math.min(pick, cliffs.length - 1)];
    const C = a.craters;
    const ku = new Uint32Array(C.buffer, C.byteOffset, C.length);
    let field = null;
    for (let o = 0; o < C.length; o += 8) {
      if (ku[o + 6] !== 3) continue;
      if (!field || C[o + 2] > field.R) field = { x: C[o], y: C[o + 1], R: C[o + 2], H: C[o + 3] };
    }
    const cell = (x, y) => [Math.floor(x), Math.floor(y / 0.866)];
    // (the cliff's foot: the lowest ground within 160 of the site, by the macro heights; walk in a little
    // short of it, toward the site, so the wall is in view)
    const n = a.p.n;
    const hAt = (x, y) => a.hmac[(((Math.floor((y / a.worldH) * n) % n) + n) % n) * n + (((Math.floor((x / a.worldW) * n) % n) + n) % n)];
    let foot = null;
    if (m) {
      for (let ang = 0; ang < 6.28; ang += 0.1) {
        for (let d = 20; d <= 160; d += 10) {
          const x = m.x + Math.cos(ang) * d;
          const y = m.y + Math.sin(ang) * d;
          const h = hAt(x, y);
          if (h > a.p.sea + 2 && (!foot || h < foot.h)) foot = { x, y, h, ang, d };
        }
      }
    }
    const f = foot && { x: m.x + Math.cos(foot.ang) * (foot.d + 40), y: m.y + Math.sin(foot.ang) * (foot.d + 40) };
    return {
      mesa: m && { x: m.x, y: m.y, h: m.h, at: cell(m.x, m.y), n: cliffs.length },
      foot: f && { x: f.x, y: f.y, h: foot.h, at: cell(f.x, f.y) },
      field: field && { ...field, at: cell(field.x, field.y) },
    };
  }, pick);
  console.log(JSON.stringify(spots));
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    for (const [sc, tag] of [
      [1.5, "wide"],
      [0.2, 'near'],
    ]) {
      await page.goto(`${url}/?atlas=view&overlay=0&mode=${mode}&view=${s.x},${s.y},${sc}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
      await new Promise((r) => setTimeout(r, 1500));
      await page.screenshot({ path: `${out}-${k}-view-${tag}.png` });
    }
  }
  await page.close();
  if (!game) process.exit(0);
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    const lv = await browser.newPage();
    lv.on('pageerror', (e) => console.log(k, 'pageerror', e.message));
    await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${s.at.join(',')}${opt('win', '') ? `&win=${opt('win', '')}` : ''}`, { waitUntil: 'load' });
    await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await new Promise((r) => setTimeout(r, 6000));
    await lv.evaluate(() => {
      document.getElementById('ui').style.visibility = 'hidden';
      window.reclaimed.stream.auto = false;
    });
    for (const z of [0.8, 1.6]) {
      await lv.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
      await new Promise((r) => setTimeout(r, 1500));
      await lv.screenshot({ path: `${out}-${k}-iso-${z}.png` });
    }
    if (cam) {
      await lv.evaluate(async (c) => {
        const R = window.reclaimed;
        R.toggleFly();
        R.camera.fly.pos = [c[0], c[1] * 0.866, c[2]];
        R.camera.fly.yaw = Math.atan2((c[4] - c[1]) * 0.866, c[3] - c[0]);
        R.camera.fly.pitch = c[5] ?? 0.1;
        await new Promise((r) => setTimeout(r, 2500));
      }, cam);
      await lv.screenshot({ path: `${out}-${k}-cam.png` });
    } else if (k === 'foot') {
      // the fly camera on the low ground, looking back at the wall (the steepest drop near the middle)
      const fl = await lv.evaluate(async () => {
        const R = window.reclaimed;
        const S = R.map.surface;
        const W = R.core?.dims?.w ?? Math.round(Math.sqrt(S.length));
        let best = null;
        for (let y = 8; y < W - 8; y += 2) {
          for (let x = 8; x < W - 8; x += 2) {
            const h = S[y * W + x];
            for (const [dx, dy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, -4], [4, -4], [-4, 4]]) {
              const d = h - S[(y + dy) * W + x + dx];
              const c = Math.hypot(x - W / 2, y - W / 2);
              if (d > 40 && (!best || c < best.c)) best = { x, y, dx, dy, c, h, lo: S[(y + dy) * W + x + dx] };
            }
          }
        }
        if (!best) return null;
        // (the camera: on the lowest open ground — its 9 × 9 neighbourhood low too — looking at the wall)
        let cam = null;
        for (let y = 10; y < W - 10; y += 3) {
          for (let x = 10; x < W - 10; x += 3) {
            let hi = 0;
            for (let k = -4; k <= 4; k += 2) for (let l = -4; l <= 4; l += 2) hi = Math.max(hi, S[(y + k) * W + x + l]);
            if (!cam || hi < cam.hi) cam = { x, y, hi };
          }
        }
        R.toggleFly();
        R.camera.fly.pos = [cam.x, cam.y * 0.866, cam.hi + 30];
        R.camera.fly.yaw = Math.atan2((best.y - cam.y) * 0.866, best.x - cam.x);
        R.camera.fly.pitch = 0.3;
        const px = cam.x;
        const py = cam.y;
        await new Promise((r) => setTimeout(r, 2500));
        return { ...best, W, len: S.length, cam: R.camera.fly.pos, under: S[Math.round(py) * W + Math.round(px)] };
      });
      console.log('fly', JSON.stringify(fl));
      await lv.screenshot({ path: `${out}-${k}-fly.png` });
    }
    await lv.close();
  }
} finally {
  await browser.close();
}
