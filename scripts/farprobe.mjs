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
  await p.goto(`${url}/?bgcheck=1&skipmenu=1&level=atlas&tutorial=0&worldsave=0&world=tilegate&at=15024,14337&tod=0.42&day=100000&season=0.3&hitch=1&hitchhud=0&q=low&tilerate=${rate}${opt('extra', '')}`, { waitUntil: 'load' });
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
        window.__holdSnap = { snap, cam: { t: [...c.target], vw: cam.vw, vh: cam.vh } };
        R.scene.pan = null;
        break;
      }
    }
    R.scene.pan = null;
    if (!window.__holdSnap) return { frames, farFrames, kinds, ex, cast: null };
    // (round 128o, DA-B27: each far-land sample of the held frame cast against the land's heights — the window's own
    // (WorldCore's surface mirror), past it the land as generated (what a tile is made from) — to the column it shows)
    const { snap, cam } = window.__holdSnap;
    const RG = S.R;
    const zMax = R.core.dims.zMax;
    const [ox, oy] = S.origin;
    const gen = new Map();
    const need = new Set();
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
      const [dx, dy] = c.screenDeltaToWorld((a - 0.5) * cam.vw, (b - 0.5) * cam.vh);
      const col = Math.floor(cam.t[0] + dx);
      const row = Math.floor((cam.t[1] + dy) / ROW);
      need.add(`${Math.floor((col + ox) / RG)},${Math.floor((row + oy) / RG)}`);
    }
    const rxs = [...need].map((k) => k.split(',').map(Number));
    const [rx0, rx1] = [Math.min(...rxs.map((v) => v[0])) - 1, Math.max(...rxs.map((v) => v[0])) + 1];
    const [ry0, ry1] = [Math.min(...rxs.map((v) => v[1])) - 1, Math.max(...rxs.map((v) => v[1])) + 1];
    for (let ry = ry0; ry <= ry1; ry++)
      for (let rx = rx0; rx <= rx1; rx++) {
        const land = await S.source.region(rx * RG, ry * RG, RG, RG, zMax);
        gen.set(`${rx},${ry}`, S.cutRegion(land, undefined).surface);
      }
    const surf = R.core.map.surface;
    const ring = R.core.world.ring;
    const winTop = (col, row) => (col >= 0 && col < S.W && row >= 0 && row < S.H ? surf[ring.i(col, row)] : null);
    const genTop = (col, row) => {
      const rx = Math.floor((col + ox) / RG);
      const ry = Math.floor((row + oy) / RG);
      const g = gen.get(`${rx},${ry}`);
      return g ? g[(row + oy - ry * RG) * RG + (col + ox - rx * RG)] : null;
    };
    const heightAt = (x, y) => {
      const col = Math.floor(x);
      const row = Math.floor(y / ROW);
      return winTop(col, row) ?? genTop(col, row);
    };
    const save = c.target.slice();
    c.target[0] = cam.t[0];
    c.target[1] = cam.t[1];
    c.target[2] = cam.t[2];
    const cast = { samples: 0, byEdge: {}, list: [] };
    for (let j = 0; j < snap.rows; j++)
      for (let i = 0; i < snap.cols; i++) {
        const k = snap.cls[j * snap.cols + i];
        if (k !== 2 && k !== 3) continue;
        const g = c.groundAt(((i + 0.5) / snap.cols) * cam.vw, ((j + 0.5) / snap.rows) * cam.vh, heightAt);
        if (!g) continue;
        const col = Math.floor(g[0]);
        const row = Math.floor(g[1] / ROW);
        const inWin = col >= 0 && col < S.W && row >= 0 && row < S.H;
        const edge = Math.min(Math.abs(col), Math.abs(row), Math.abs(S.W - 1 - col), Math.abs(S.H - 1 - row));
        const bucket = `${inWin ? 'in' : 'past'} ${edge <= 1 ? '0-1' : edge <= 4 ? '2-4' : edge <= 16 ? '5-16' : '17+'}`;
        cast.byEdge[bucket] = (cast.byEdge[bucket] ?? 0) + 1;
        cast.samples++;
        if (cast.list.length < 16) cast.list.push({ i, j, col, row, inWin, edge, win: winTop(col, row), gen: genTop(col, row), tile: TL.drawsAt(col, row) });
      }
    c.target[0] = save[0];
    c.target[1] = save[1];
    c.target[2] = save[2];
    return { frames, farFrames, kinds, ex, cast };
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
