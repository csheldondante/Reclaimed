// Round 80: the world API's atlas world (src/api/atlas-world.ts) as a game uses it — made on a page's host
// (the level's, borrowed), the world API over it, a target ridden 200 cells east frame by frame (each frame:
// aw.frame(target), the sim's ticks unless a slide runs, a render), the window sliding after it.
//   node scripts/atlasworldtest.mjs [--url http://localhost:5207]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:5207';
let failed = false;
const check = (name, ok, info) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(info)}`);
};
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  // (a page with a host: the valley, small and quick; its own world is left alone)
  await p.goto(`${url}/?skipmenu=1&level=valley&tutorial=0&q=low`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  const r = await p.evaluate(async () => {
    const { createAtlasWorld } = await import('/src/api/atlas-world.ts');
    const { attachSim } = await import('/src/api/world.ts');
    const host = window.reclaimed.core.host;
    const t0 = performance.now();
    const aw = await createAtlasWorld(host, { at: [12304, 5457], particles: 20000 });
    const built = performance.now() - t0;
    // (its render targets come with its first size, as for any WorldCore)
    aw.core.resize(412, 915, 412, 915);
    const sim = attachSim(aw.core, { terrain: true, water: true });
    await sim.refresh();
    const o0 = [...aw.stream.origin];
    const target = [128, 128 * 0.866];
    let slides = 0;
    aw.onSlide.push((dx, dy) => {
      slides++;
      target[0] -= dx;
      target[1] -= dy * 0.866;
    });
    let busyFrames = 0;
    let ticks = 0;
    for (let f = 0; f < 1500 && aw.stream.origin[0] - o0[0] < 192; f++) {
      target[0] += 0.5;
      aw.core.camera.target[0] = target[0];
      aw.core.camera.target[1] = target[1];
      const busy = aw.frame([target[0], target[1]]);
      if (busy) busyFrames++;
      else ticks += aw.core.advance(performance.now(), 1 / 60, 1);
      aw.core.render();
      await new Promise((res) => requestAnimationFrame(res));
    }
    await new Promise((res) => setTimeout(res, 1500));
    await sim.refresh();
    const h = sim.terrain.heightAt(target[0], target[1]);
    return {
      built: +built.toFixed(0),
      moved: aw.stream.origin[0] - o0[0],
      slides,
      busyFrames,
      ticks,
      seaZ: aw.core.globals.seaZ,
      awake: aw.sleep?.awake,
      chunks: (aw.core.dims.w / 16) * (aw.core.dims.h / 16),
      band: !!aw.core.renderer.band,
      height: h,
      world: aw.toWorld(target[0], target[1]).map((v) => +v.toFixed(0)),
    };
  });
  check('an atlas world from the API: built, the world API over it', r.built > 0 && r.band, { built: r.built, band: r.band });
  check('a target ridden east: the window slides after it', r.moved >= 192 && r.slides >= 3, { moved: r.moved, slides: r.slides, busyFrames: r.busyFrames, ticks: r.ticks });
  check('the sea held, sleep on, the terrain under the target', r.seaZ > -1e8 && r.awake > 0 && r.awake < r.chunks && r.height > 0, { seaZ: r.seaZ, awake: r.awake, of: r.chunks, height: r.height, world: r.world });
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
