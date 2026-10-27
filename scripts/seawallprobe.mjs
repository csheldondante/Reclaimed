// Round 88: walls of water in the window — columns whose water stands over a neighbour's level (wet or dry)
// by more than --step, counted and listed; a shot at --zoom.
//   node scripts/seawallprobe.mjs --spots "x,y;x,y" [--url http://localhost:5317] [--out C:/Projects/shots88/sea/probe]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5317');
const out = opt('out', 'C:/Projects/shots88/sea/probe');
const step = Number(opt('step', 3));
const zoom = Number(opt('zoom', 6));
const extra = opt('extra', '');
const wait = Number(opt('wait', 35000));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  let k = 0;
  let spots = opt('spots', '');
  if (spots === 'high') {
    // coasts whose window (warpWindow's choice of tier) has its floor over 0: the sea's floor under it
    const p = await browser.newPage();
    await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.atlas?.hmac, { timeout: 300000 });
    spots = await p.evaluate((nn) => {
      const a = window.reclaimed.atlas;
      const n = a.p.n;
      const hm = a.hmac;
      const sea = a.p.sea;
      const RH = Math.sqrt(3) / 2;
      const res = [];
      for (let y = 4; y < n - 4 && res.length < nn; y += 3)
        for (let x = 4; x < n - 4 && res.length < nn; x += 3) {
          const z = hm[y * n + x];
          if (z < sea + 2 || z > sea + 10) continue;
          if (!(hm[y * n + x + 3] < sea - 10 || hm[y * n + x - 3] < sea - 10 || hm[(y + 3) * n + x] < sea - 10 || hm[(y - 3) * n + x] < sea - 10)) continue;
          const cx = Math.floor((x / n) * a.p.cols);
          const cy = Math.floor((y / n) * a.p.rows);
          const ox = Math.round((cx - 128) / 64) * 64;
          const oy = Math.round((cy - 128) / 64) * 64;
          const gMid = a.macroAt(cx + 0.5, (cy + 0.5) * RH);
          const gs = [];
          for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) gs.push(a.macroAt(ox + ((i + 0.5) * 256) / 16, (oy + ((j + 0.5) * 256) / 16) * RH));
          let oz = 0;
          let most = -1;
          for (let c = 0; c + 248 <= a.p.zTop + 32; c += 32) {
            if (gMid < c + 8 || gMid > c + 248 - 40) continue;
            const m = gs.filter((v) => v >= c + 8 && v <= c + 248 - 24).length;
            if (m > most) {
              most = m;
              oz = c;
            }
          }
          if (oz > 0 && !res.some((r) => Math.abs(r[0] - cx) + Math.abs(r[1] - cy) < 2000)) res.push([cx, cy, oz]);
        }
      return res;
    }, Number(opt('n', 3)));
    console.log('high coasts', JSON.stringify(spots));
    spots = spots.map((s) => `${s[0]},${s[1]}`).join(';');
    await p.close();
  }
  for (const at of spots.split(';')) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
    await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas&at=${at}${extra}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 300000 });
    await sleep(wait);
    // (--slidez n: the window moved up n tiers first, as walking up a mountain by the sea does)
    for (let k = 0; k < Number(opt('slidez', 0)); k++) {
      await p.evaluate(() => window.reclaimed.stream.slideZ(32));
      await sleep(Number(opt('slidewait', 8000)));
    }
    const r = await p.evaluate(async (step) => {
      const R = window.reclaimed;
      const W = R.core.dims.w;
      const H = R.core.dims.h;
      const w = new Float32Array((await R.readBuffer('water')).buffer);
      const s = new Uint32Array((await R.readBuffer('surface')).buffer);
      const z = (i) => (s[i] & 0xffff) / 256;
      const walls = [];
      let edge = 0;
      let wet = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (w[i] <= 0.05) continue;
          wet++;
          const lv = z(i) + w[i];
          if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge++;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const j = Y * W + X;
            const nl = z(j) + Math.max(w[j], 0);
            if (lv - nl > step) walls.push([x, y, +lv.toFixed(1), +nl.toFixed(1), +w[i].toFixed(1), +w[j].toFixed(1), +z(j).toFixed(1)]);
          }
        }
      // (columns cut off under the window's floor: nothing inside, their ground below oz — the sea's floor there)
      let holes = 0;
      let holesWet = 0;
      let holeLv = 0;
      for (let i = 0; i < W * H; i++)
        if (((s[i] >>> 24) & 0x1f) === 0) {
          holes++;
          if (w[i] > 0.05) {
            holesWet++;
            holeLv += z(i) + w[i];
          }
        }
      const holeInfo = { holes, holesWet, holeLv: holesWet ? +(holeLv / holesWet).toFixed(1) : 0 };
      // the walls by level (their water's level, rounded)
      const byLv = {};
      for (const q of walls) byLv[Math.round(q[2])] = (byLv[Math.round(q[2])] || 0) + 1;
      return { holeInfo, first: walls[Math.floor(walls.length / 2)], W, H, oz: R.stream.oz, seaZ: R.globals.seaZ, wet, edge, walls: walls.length, byLv, some: walls.filter((_, i) => i % Math.max(1, Math.floor(walls.length / 12)) === 0).slice(0, 12) };
    }, step);
    console.log(at, JSON.stringify(r));
    await p.screenshot({ path: `${out}-${k}-zdef.png` });
    if (zoom > 0) {
      // (the camera on the first wall found)
      await p.evaluate((z, q) => {
        const R = window.reclaimed;
        if (q) R.camera.target = [q[0], q[1] * (Math.sqrt(3) / 2), q[2]];
        R.camera.zoom = z;
      }, zoom, r.first);
      await sleep(3000);
      await p.screenshot({ path: `${out}-${k}-z${zoom}.png` });
    }
    await p.close();
    k++;
  }
} finally {
  await browser.close();
}
