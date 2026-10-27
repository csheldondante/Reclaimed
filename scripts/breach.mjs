// (perfopt, round 83)
// A breach in a held river: dig beside a river column, watch the water go into the hole and the river's level
//   node breach.mjs "&flags"
import puppeteer from 'puppeteer-core';
const URL0 = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://localhost:5211';
const [extra = ''] = process.argv.slice(2).filter((a, i, all) => a !== '--url' && all[i - 1] !== '--url');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=600,600'],
  defaultViewport: { width: 600, height: 600, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${URL0}/?skipmenu=1&level=atlas&tutorial=0&at=12304,5457${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const core = R.core;
    const { cellPos } = await import('/src/world/lattice.ts');
    const f32 = async (n) => new Float32Array((await core.readBuffer(n)).buffer.slice(0));
    const src = await f32('waterSource');
    const w0 = await f32('water');
    const sf = new Uint32Array((await core.readBuffer('surface')).buffer.slice(0));
    const W = core.dims.w;
    const H = core.dims.h;
    // a river column well inside the window with a dry neighbour two cells off its bank, and its ground not far above
    let pick = -1;
    for (let y = 40; y < H - 40 && pick < 0; y++)
      for (let x = 40; x < W - 40; x++) {
        const i = y * W + x;
        if (!(src[i] < -0.3) && !(src[i] > 0)) continue;
        const j = i + 3;
        if (w0[j] < 0.01 && (sf[j] & 0xffff) / 256 - (sf[i] & 0xffff) / 256 < 3) { pick = i; break; }
      }
    if (pick < 0) return 'no river with a dry bank';
    const x = pick % W, y = Math.floor(pick / W);
    const [px, py] = cellPos(x + 3, y);
    const T = R.api.terrain;
    T.dig(px, py, { radius: 2.5, layers: 4 });
    const ring = [];
    for (let k = 0; k < 4; k++) {
      await new Promise((res) => setTimeout(res, 1000));
      const w = await f32('water');
      let hole = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = 0; dx <= 6; dx++) hole += w[(y + dy) * W + x + dx];
      ring.push({ t: k + 1, river: +w[pick].toFixed(2), holeWater: +hole.toFixed(2), downstream: +w[pick - 3].toFixed(2) });
    }
    return { at: [x, y], src: src[pick], d0: +w0[pick].toFixed(2), ring };
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
