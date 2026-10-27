// Round 96: the rock lab's steel bridge woken into the physics voxels (rockbody on): what was made, where its
// particles are, whether its mesh is drawn — a probe for the skinned draw.
//   node scripts/metalprobe.mjs [--url http://localhost:5275] [--piece bridge|tower] [--out a.png]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5275');
const piece = opt('piece', 'bridge');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&perf=1&level=rocklab${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.integrity?.(), { timeout: 240000 });
  await sleep(12000);
  const at = await p.evaluate((piece) => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const cx = w * 0.55 + 10 + (piece === 'tower' ? 0 : -22);
    const cy = h * (Math.sqrt(3) / 2) * 0.5 - 6 + 2 * 22;
    R.camera.target = [cx, cy, 20];
    R.camera.zoom = 5;
    // the pier (bridge) or a leg's foot (tower): the break tool's event
    const x = piece === 'tower' ? cx + 3 : cx - 9;
    const y = piece === 'tower' ? cy + 3 : cy;
    R.core.globals.events.push({ kind: 5, x, y, z: 12 * 32, radius: 2.5, strength: piece === 'tower' ? 13 : 19 });
    return [x, y];
  }, piece);
  for (const t of [1000, 3000, 6000]) {
    await sleep(t === 1000 ? 1000 : 2000);
    const r = await p.evaluate(async () => {
      const R = window.reclaimed;
      const I = R.integrity();
      const ph = R.scene.physics;
      const m = I.metal.map((mb) => ({ offset: mb.body.offset, dims: mb.body.dims, total: mb.body.total, lo: mb.lo, slot: mb.slot, age: R.core.renderer.rockMesh.age(mb.slot) }));
      let sample = null;
      if (I.metal.length) {
        const b = I.metal[0].body;
        const f = (await ph.readPositions()).subarray(b.offset * 8, (b.offset + b.dims[0] * b.dims[1] * b.dims[2]) * 8);
        const alive = [];
        for (let k = 0; k < f.length / 8; k++) if (f[k * 8 + 3] >= 0) alive.push([+f[k * 8].toFixed(1), +f[k * 8 + 1].toFixed(1), +f[k * 8 + 2].toFixed(1)]);
        sample = { alive: alive.length, first: alive.slice(0, 3), screen: R.camera.project(...alive[0]).map((v) => Math.round(v)) };
      }
      const rm = R.core.renderer.rockMesh;
      const slots = [...rm.slots].map(([id, s]) => ({ id, rect: s.rect, shift: s.shift.map((v) => +v.toFixed(1)), blocks: s.blocks.length }));
      const P = R.core.host.profiler;
      const physMs = +((P.totalMs.get('physics') ?? 0) / Math.max(1, P.framesResolved)).toFixed(3);
      const gpu = +(P.gpuTotalMs / Math.max(1, P.framesResolved)).toFixed(2);
      P.resetTotals();
      return { physMs, gpu, slots, draws: [...rm.data.slice(0, 4 + 48)].map((v) => +v.toFixed(1)), mstats: R.core.renderer.rockMesh.mesh.stats, pool: R.core.renderer.rockMesh.mesh.poolStats, parts: !!R.core.renderer.rockParticles, same: R.core.renderer.rockParticles?.px === ph.buffers.px, metal: m, sample, stats: I.stats.metal, drawCount: R.core.renderer.rockMesh?.count, physBodies: ph.bodies.length, used: ph.used };
    });
    console.log(t, JSON.stringify(r));
  }
  await p.evaluate(() => {
    const cv = document.querySelector('canvas');
    for (const el of document.querySelectorAll('body *')) if (el !== cv && !el.contains(cv)) el.style.visibility = 'hidden';
  });
  if (opt('out', '')) await p.screenshot({ path: opt('out', '') });
} finally {
  await browser.close();
}
