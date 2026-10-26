// Round 82: chunks left stale — the terrain changed in many places at once (one rebuild slot), everything
// left to fall asleep, then every chunk near the view looked at afresh: those rebuilt then were stale.
//   node scripts/stalemesh.mjs [--url http://localhost:5207] [--at 12304,5457] [--slots 1] [--edits 40]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const at = opt('at', '12304,5457');
const slots = opt('slots', '1');
const edits = Number(opt('edits', 40));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&slots=${slots}&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(15000);
  // the state's built hashes (word 5) of the window's chunks, and those owed (word 6 ≠ 5) among the near
  const read = () =>
    p.evaluate(async () => {
      const m = window.reclaimed.core.renderer.fieldMesh;
      const dev = window.reclaimed.core.host.gpu.device;
      const src = m.stateBuffer;
      const tmp = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
      dev.queue.submit([enc.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const u = new Uint32Array(tmp.getMappedRange().slice(0));
      tmp.destroy();
      const n = m.near.length;
      const built = [];
      let owed = 0;
      for (let c = 0; c < n; c++) {
        const b = 16 + c * 13;
        built.push(u[b + 5]);
        if (m.near[c] && u[b + 6] !== u[b + 5]) owed++;
      }
      return { built, owed, near: [...m.near].filter((v) => v).length };
    });
  await p.evaluate((k) => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const t = R.camera.target;
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      const r = 6 + (i % 5) * 7;
      const x = Math.max(4, Math.min(w - 4, t[0] + Math.cos(a) * r));
      const y = Math.max(4, Math.min(h - 4, t[1] + Math.sin(a) * r));
      R.globals.events.push({ kind: 1, x, y, radius: 4, strength: 20 });
    }
  }, edits);
  // (settle 1.5 s, drowsy 0.25 s: everything asleep well after)
  await sleep(10000);
  const before = await read();
  // every chunk come near again: looked at, asleep or not
  await p.evaluate(() => window.reclaimed.core.renderer.fieldMesh.near.fill(0));
  await sleep(3000);
  const after = await read();
  const stale = before.built.filter((h, c) => h !== after.built[c]).length;
  console.log(JSON.stringify({ slots, edits, near: before.near, owedBefore: before.owed, staleFound: stale, owedAfter: after.owed }));
} finally {
  await browser.close();
}
