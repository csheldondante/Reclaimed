// Round 88: the river nodes near a world point (cells): level, width, depth, next, and the next's.
//   node scripts/seawallnodes.mjs --cell 908,13643 [--r 120]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5317');
const [cx, cy] = opt('cell', '908,13643').split(',').map(Number);
const rad = Number(opt('r', 120));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  await p.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas?.riverNodes?.length > 8, { timeout: 300000 });
  const r = await p.evaluate(
    (cx, cy, rad) => {
      const a = window.reclaimed.atlas;
      const N = a.riverNodes;
      const f = new Float32Array(N.buffer, N.byteOffset, N.length);
      const px = cx + 0.5;
      const py = (cy + 0.5) * (Math.sqrt(3) / 2);
      const out = [];
      for (let k = 0; k < N.length / 8; k++) {
        const x = f[k * 8];
        const y = f[k * 8 + 1];
        if (Math.hypot(x - px, y - py) > rad) continue;
        const nx = N[k * 8 + 4];
        out.push({ k, x: +x.toFixed(1), y: +y.toFixed(1), level: +f[k * 8 + 2].toFixed(2), w: +f[k * 8 + 3].toFixed(1), next: nx, flags: N[k * 8 + 5], depth: +f[k * 8 + 6].toFixed(2), nextLevel: +f[nx * 8 + 2].toFixed(2), nextNext: N[nx * 8 + 4], macro: +a.macroAt(x, y).toFixed(1) });
      }
      return { p: [px, py], sea: a.p.sea, macroHere: a.macroAt(px, py), out };
    },
    cx,
    cy,
    rad,
  );
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
