// (round 128o, DA-B27) Where the pixels show the far land's stand-in during the phone's fast pan (bgcheck's per-frame snapshot,
// each such sample put back on the ground), and what the tile cache and the window say about those places: the
// geometric check calls them drawn. Holds the pan at the first such frame and saves .testcache/crack-0.png.
//   node scripts/farprobe.mjs --url http://127.0.0.1:PORT [--tilerate 0.154]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', '');
const rate = opt('tilerate', '0.154');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  protocolTimeout: 900000,
});
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
  await p.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36');
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?bgcheck=1&skipmenu=1&level=atlas&tutorial=0&worldsave=0&world=tilegate&at=15024,14337&tod=0.42&day=100000&season=0.3&hitch=1&hitchhud=0&q=low&tilerate=${rate}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__boot?.at['level-ready'] && window.reclaimed?.stream && window.reclaimed?.scene, { timeout: 240000, polling: 250 });
  await sleep(35000);
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const c = R.camera;
    const TL = R.renderer.tiles;
    const BG = R.renderer.bgCheck;
    const S = R.stream;
    const fm = TL.host.win.mesh;
    const ROW = Math.sqrt(3) / 2;
    c.zoom = 8;
    TL.host.win.mesh.statPeriod = 1;
    for (let i = 0; i < 180; i++) await new Promise((r) => requestAnimationFrame(r));
    const [ux, uy] = c.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    const dir = [ux / l, uy / l];
    const here = () => [S.origin[0] + c.target[0], S.origin[1] * ROW + c.target[1]];
    const home = here();
    R.scene.pan = { speed: 160, dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    let sign = 1;
    const kinds = {};
    const ex = [];
    let frames = 0;
    let farFrames = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      const snapP = BG.snapshot();
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
      const h = here();
      const off = (h[0] - home[0]) * dir[0] + (h[1] - home[1]) * dir[1];
      if (off > 400 && sign > 0) sign = -1;
      else if (off < 0 && sign < 0) sign = 1;
      R.scene.pan.dir = [dir[0] * sign, dir[1] * sign];
      const cam = { t: [...c.target], vw: c.viewportW, vh: c.viewportH };
      const gc = TL.coverCheck(c);
      const snap = await Promise.race([snapP, new Promise((r) => setTimeout(() => r(null), 500))]);
      if (!snap) continue;
      let any = false;
      for (let j = 0; j < snap.rows; j++)
        for (let i = 0; i < snap.cols; i++) {
          const k = snap.cls[j * snap.cols + i];
          if (k !== 2 && k !== 3) continue;
          any = true;
          const [dx, dy] = c.screenDeltaToWorld(((i + 0.5) / snap.cols - 0.5) * cam.vw, ((j + 0.5) / snap.rows - 0.5) * cam.vh);
          const x = cam.t[0] + dx;
          const y = (cam.t[1] + dy) / ROW;
          const inWin = x >= 0 && x < S.W && y >= 0 && y < S.H;
          let what;
          if (inWin) {
            const [nx, ny] = fm.chunkGrid;
            const ci = Math.min(nx - 1, Math.floor((x / S.W) * nx));
            const cj = Math.min(ny - 1, Math.floor((y / S.H) * ny));
            const grid = TL.host.gridOn?.();
            what = `win built${fm.built[cj * nx + ci] ?? '?'} grid${grid ? grid[cj * nx + ci] : '-'} tile${TL.drawsAt(x, y) ? 1 : 0} edge${x < 8 || y < 8 || x > S.W - 8 || y > S.H - 8 ? 1 : 0}`;
          } else what = `past tile${TL.drawsAt(x, y) ? 1 : 0} ${TL.whyMissing(x, y, c.azimuth)}`;
          const key = `cls${k} ${what}`;
          kinds[key] = (kinds[key] ?? 0) + 1;
          if (ex.length < 12) ex.push({ f: frames, i, j, x: Math.round(x), y: Math.round(y), key, gc: gc ? gc.undrawn.length : null });
        }
      if (any) farFrames++;
      // (the first far frame: the pan held there, for a shot)
      if (any && window.__holdAt === undefined) {
        window.__holdAt = frames;
        R.scene.pan = null;
        break;
      }
    }
    R.scene.pan = null;
    return { frames, farFrames, kinds, ex };
  });
  console.log(JSON.stringify(r, null, 1));
  await p.screenshot({ path: '.testcache/crack-0.png' });
  const snap = await p.evaluate(async () => {
    const s = await window.reclaimed.renderer.bgCheck.snapshot();
    return { cols: s.cols, rows: s.rows, cls: Array.from(s.cls) };
  });
  const far = [];
  for (let j = 0; j < snap.rows; j++) for (let i = 0; i < snap.cols; i++) if (snap.cls[j * snap.cols + i] >= 2) far.push([i, j]);
  console.log('after hold: far samples', far.length, JSON.stringify(far.slice(0, 20)), snap.cols, snap.rows);
} finally {
  await browser.close();
}
