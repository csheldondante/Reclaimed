// (round 128o, DA-B27) The window's land against the land as generated (what a render-only tile is made from) for the
// same columns along the window's four edges, top by top: how far the simulated land has moved from the generated.
//   node scripts/stepprobe.mjs --url http://127.0.0.1:PORT [--wait 35000]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 900000,
});
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
  await p.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36');
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&worldsave=0&world=tilegate&at=15024,14337&tod=0.42&day=100000&season=0.3&q=low&tilerate=0.154`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__boot?.at['level-ready'] && window.reclaimed?.stream && window.reclaimed?.scene, { timeout: 240000, polling: 250 });
  await sleep(Number(opt('wait', 35000)));
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    const core = R.core;
    const RG = S.R;
    const K = S.K;
    const W = S.W;
    const H = S.H;
    const zMax = core.dims.zMax;
    const topOf = (u, f, base, k) => {
      let t = null;
      for (let s = 0; s < k; s++) {
        if (u[(base + s) * 4 + 1] === 0) break;
        t = f[(base + s) * 4 + 1];
      }
      return t;
    };
    const lay = await core.readBuffer('layers');
    const wu = new Uint32Array(lay.buffer, lay.byteOffset, lay.byteLength / 4);
    const wf = new Float32Array(lay.buffer, lay.byteOffset, lay.byteLength / 4);
    const table = core.packed.chunkTable;
    const cx = core.packed.chunksX;
    const winTop = (x, y) => {
      const ci = Math.floor(y / 16) * cx + Math.floor(x / 16);
      return topOf(wu, wf, table[ci * 2] + ((y % 16) * 16 + (x % 16)) * table[ci * 2 + 1], table[ci * 2 + 1]);
    };
    const out = { origin: [...S.origin], oz: S.oz, W, H, RG, edges: {} };
    const rc = RG / 16;
    // (each edge's regions: the land made again, as a tile's is, and its rows next to the edge compared)
    const regs = [];
    for (let i = 0; i < W / RG; i++) regs.push([i, 0, 'top'], [i, H / RG - 1, 'bottom']);
    for (let j = 1; j < H / RG - 1; j++) regs.push([0, j, 'left'], [W / RG - 1, j, 'right']);
    const st = {};
    for (const [i, j, e] of regs) {
      const x0 = S.origin[0] + i * RG;
      const y0 = S.origin[1] + j * RG;
      const land = await S.source.region(x0, y0, RG, RG, zMax);
      const fz = S.cutRegion(land, undefined);
      const gu = new Uint32Array(fz.layers.buffer, fz.layers.byteOffset, fz.layers.length);
      const gf = new Float32Array(fz.layers.buffer, fz.layers.byteOffset, fz.layers.length);
      const pageSlots = S.pageSlots;
      const Kp = S.pageSlots / 256;
      const genTop = (lx, ly) => topOf(gu, gf, (Math.floor(ly / 16) * rc + Math.floor(lx / 16)) * pageSlots + ((ly % 16) * 16 + (lx % 16)) * Kp, Kp);
      const s = (st[e] ??= { cols: 0, same: 0, diff: 0, maxAbs: 0, sumAbs: 0, lower: 0, higher: 0, missingWin: 0, missingGen: 0, examples: [] });
      for (let d = 0; d < 2; d++)
        for (let t = 0; t < RG; t++) {
          const lx = e === 'top' || e === 'bottom' ? t : e === 'left' ? d : RG - 1 - d;
          const ly = e === 'left' || e === 'right' ? t : e === 'top' ? d : RG - 1 - d;
          const wt = winTop(i * RG + lx, j * RG + ly);
          const gt = genTop(lx, ly);
          s.cols++;
          if (wt === null) s.missingWin++;
          if (gt === null) s.missingGen++;
          if (wt === null || gt === null) continue;
          const dz = wt - gt;
          if (Math.abs(dz) < 1e-3) s.same++;
          else {
            s.diff++;
            s.sumAbs += Math.abs(dz);
            s.maxAbs = Math.max(s.maxAbs, Math.abs(dz));
            if (dz < 0) s.lower++;
            else s.higher++;
            if (s.examples.length < 6) s.examples.push([i * RG + lx, j * RG + ly, +wt.toFixed(2), +gt.toFixed(2)]);
          }
        }
    }
    for (const s of Object.values(st)) s.meanAbs = +(s.sumAbs / Math.max(1, s.diff)).toFixed(3);
    out.edges = st;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
