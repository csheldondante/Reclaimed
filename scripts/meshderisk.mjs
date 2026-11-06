// (round 128o, DA-B28) The field mesh's rebuilds and GPU time on the atlas, by phase: at rest, building (the fortress's
// Build), a storm's rain on the camera, a pan across the land (slides; without the fortress, whose window stays put),
// and after. Per phase: frames, mesh chunks rebuilt (a frame's state[0], read back each frame — a debug readback of
// 64 B), the fieldmesh passes' GPU ms (mean, max) and, for the pan, the rebuilds and ms by frames since the last slide.
// Run it on two builds (before / after a change) for a rebuild count and a toggle diff. Its own Chrome on a dev server
// you start on a port no one else uses; not on the shared runner (it doesn't take the GPU lease: run it only when the
// timing runs are yours).
//   node scripts/meshderisk.mjs --url http://127.0.0.1:PORT [--seconds 15] [--nofort] [--pan 30] [--json out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', '');
if (!url) throw new Error('meshderisk: --url of a dev server (its own port)');
const secs = Number(opt('seconds', 15));
const pan = Number(opt('pan', 30));
const out = opt('json', '');
const fort = !argv.includes('--nofort');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&town=1&fresh=1${fort ? '&fortress=1' : ''}&perf=1&world=md-${Date.now().toString(36)}`;
  console.log(u);
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.renderer?.fieldMesh && window.reclaimed?.camera, { timeout: 300000 });
  await sleep(20000);
  await p.evaluate(() => {
    const R = window.reclaimed;
    const fm = R.renderer.fieldMesh;
    const dev = R.core.host.gpu.device;
    const prof = R.core.host.profiler;
    const L = (window.__md = { phase: 'rest', rows: [], ms: [] });
    const rd = [0, 1, 2].map(() => ({ buf: dev.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), free: true }));
    const frame = () => {
      const r = rd.find((x) => x.free);
      if (r && fm.stateBuffer) {
        r.free = false;
        const at = { phase: L.phase, slides: fm.slides };
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(fm.stateBuffer, 0, r.buf, 0, 64);
        dev.queue.submit([enc.finish()]);
        r.buf.mapAsync(GPUMapMode.READ).then(() => {
          const u = new Uint32Array(r.buf.getMappedRange().slice(0));
          r.buf.unmap();
          r.free = true;
          L.rows.push([at.phase, at.slides, Math.min(u[0], 15)]);
        });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    prof.active = true;
    prof.listen(() => {
      let mesh = 0;
      for (const [k, v] of prof.lastPasses) if (k.startsWith('fieldmesh')) mesh += v;
      L.ms.push([L.phase, fm.slides, mesh]);
    });
  });
  const phase = (name) => p.evaluate((n) => (window.__md.phase = n), name);
  await sleep(secs * 1000);
  if (fort) {
    await phase('build');
    await p.evaluate(() => document.querySelector('.fort-bar button.go')?.click());
    await sleep(secs * 2000);
  }
  await phase('rain');
  await p.evaluate(() => {
    const R = window.reclaimed;
    R.weather.spawn(R.camera.target[0], R.camera.target[1]);
  });
  await sleep(secs * 1000);
  await phase('pan');
  await p.evaluate((speed) => {
    const R = window.reclaimed;
    const t0 = performance.now();
    const start = [...R.camera.target];
    R.scene.drive = null;
    R.scene.pan = null;
    const step = () => {
      const s = (performance.now() - t0) / 1000;
      if (s > 20) return;
      R.camera.target[0] = start[0] + s * speed;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, pan);
  await sleep(22000);
  await phase('after');
  await sleep(secs * 1000);
  const r = await p.evaluate(() => {
    const L = window.__md;
    const by = {};
    const since = {};
    let last = -1;
    let n = 0;
    for (const [ph, sl, k] of L.rows) {
      const b = (by[ph] ??= { frames: 0, rebuilt: 0, ms: 0, msMax: 0, msFrames: 0 });
      b.frames++;
      b.rebuilt += k;
      if (ph === 'pan') {
        if (sl !== last) {
          last = sl;
          n = 0;
        } else n++;
        const key = n < 10 ? `${n}` : n < 30 ? '10-29' : '30+';
        const s = (since[key] ??= { frames: 0, rebuilt: 0 });
        s.frames++;
        s.rebuilt += k;
      }
    }
    for (const [ph, , ms] of L.ms) {
      const b = (by[ph] ??= { frames: 0, rebuilt: 0, ms: 0, msMax: 0, msFrames: 0 });
      b.ms += ms;
      b.msFrames++;
      b.msMax = Math.max(b.msMax, ms);
    }
    for (const b of Object.values(by)) {
      b.rebuiltPerFrame = +(b.rebuilt / Math.max(1, b.frames)).toFixed(3);
      b.msMean = +(b.ms / Math.max(1, b.msFrames)).toFixed(3);
      b.msMax = +b.msMax.toFixed(3);
      delete b.ms;
    }
    return { by, panSinceSlide: since, slides: window.reclaimed.renderer.fieldMesh.slides };
  });
  console.log(JSON.stringify(r, null, 1));
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
