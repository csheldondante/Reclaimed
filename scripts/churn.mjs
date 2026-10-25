// What keeps changing in the layers (round 73): two reads of the layers a second apart, the columns
// that differ and the materials of what changed.  node scripts/churn.mjs "<query>"
import puppeteer from 'puppeteer-core';
const q = process.argv[2] ?? 'level=atlas&at=14629,9916';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 300000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:5203/?skipmenu=1&tutorial=0&${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 8000));
  const r = await page.evaluate(async () => {
    const R = window.reclaimed;
    const L = await import('/src/world/layout.ts');
    const read = async () => {
      const b = await R.core.readBuffer('layers');
      return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
    };
    const a = await read();
    await new Promise((r) => setTimeout(r, 1000));
    const b = await read();
    const { w, h } = R.core.dims;
    let cols = 0;
    const mats = {};
    const chunks = new Set();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const ca = L.readColumn(R.packed, a, x, y);
        const cb = L.readColumn(R.packed, b, x, y);
        const same = ca.length === cb.length && ca.every((iv, i) => Math.abs(iv.z0 - cb[i].z0) < 1 / 32 && Math.abs(iv.z1 - cb[i].z1) < 1 / 32 && iv.mat === cb[i].mat);
        if (same) continue;
        cols++;
        chunks.add(`${Math.floor(x / 32)},${Math.floor((y * 0.866) / 27.7)}`);
        const top = cb[cb.length - 1] ?? ca[ca.length - 1];
        mats[top.mat] = (mats[top.mat] ?? 0) + 1;
      }
    return { cols, chunks: chunks.size, topMats: mats };
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
