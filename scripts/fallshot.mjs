// A spring at a cliff's top (round 69: what water — or lava — falling off a cliff looks like):
// finds the biggest drop near the window's middle, feeds the column above it, and films it with
// the free camera from beside the cliff.
//   node scripts/fallshot.mjs [--at x,y] [--lava 1] [--rate 0.05] [--wait 20000] [--out fall]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const at = opt('at', '11092,13139');
const lava = opt('lava', '0') === '1';
const rate = Number(opt('rate', '0.05'));
const waitMs = Number(opt('wait', '20000'));
const out = opt('out', 'fall');
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
  await page.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 3000));
  const st = await page.evaluate(
    async (lava, rate) => {
      const R = window.reclaimed;
      R.stream.auto = false;
      document.getElementById('ui').style.visibility = 'hidden';
      const S = R.map.surface;
      const W = 256;
      // the biggest drop to a neighbour within 60 of the middle
      let best = { d: 0, i: 0, j: 0 };
      for (let y = 70; y < 186; y++)
        for (let x = 70; x < 186; x++) {
          const i = y * W + x;
          for (const j of [i + 1, i - 1, i + W, i - W]) {
            const d = S[i] - S[j];
            if (d > best.d && S[j] > 0) best = { d, i, j };
          }
        }
      const dev = R.core.host.gpu.device;
      const x = best.i % W;
      const y = Math.floor(best.i / W);
      // a little patch of springs at the top
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = (y + dy) * W + x + dx;
          if (lava) {
            const t = new Float32Array([2, 0, 0, 0]);
            dev.queue.writeTexture({ texture: R.world.lavaSpring, origin: [x + dx, y + dy] }, t, { bytesPerRow: 16 }, [1, 1]);
          } else dev.queue.writeBuffer(R.world.waterSource, k * 4, new Float32Array([rate]));
        }
      const jx = best.j % W;
      const jy = Math.floor(best.j / W);
      return { drop: +best.d.toFixed(1), top: [x, y, +S[best.i].toFixed(1)], foot: [jx, jy, +S[best.j].toFixed(1)] };
    },
    lava,
    rate,
  );
  console.log(JSON.stringify(st));
  await new Promise((r) => setTimeout(r, waitMs));
  // the camera off to the side of the fall, level with its middle, looking at it
  for (const [k, side] of [[0, 1], [1, -1]]) {
    await page.evaluate(
      async (st, side) => {
        const R = window.reclaimed;
        if (!R.camera.fly) R.toggleFly();
        const [tx, ty, tz] = st.top;
        const [fx, fy, fz] = st.foot;
        const cx = (tx + fx) / 2;
        const cy = ((ty + fy) / 2) * 0.866;
        // across the fall's direction, back 45
        const ax = fx - tx;
        const ay = (fy - ty) * 0.866;
        const al = Math.hypot(ax, ay) || 1;
        const px = -ay / al;
        const py = ax / al;
        const mid = (tz + fz) / 2;
        R.camera.fly.pos = [cx + px * 45 * side + (ax / al) * 25, cy + py * 45 * side + (ay / al) * 25, mid + 10];
        R.camera.fly.yaw = Math.atan2(cy - R.camera.fly.pos[1], cx - R.camera.fly.pos[0]);
        R.camera.fly.pitch = Math.atan2(mid - R.camera.fly.pos[2], 45);
        await new Promise((r) => setTimeout(r, 1500));
      },
      st,
      side,
    );
    await page.screenshot({ path: `${out}-${k}.png` });
  }
} finally {
  await browser.close();
}
