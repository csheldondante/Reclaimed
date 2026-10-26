// Round 80: a slide's frame as the hoverbike has it — an atlas world (createAtlasWorld) with every world-API
// module and physics, a target ridden east fast; each frame's rAF gap, the slides marked: the worst frame
// at each slide and the frames after it. --extra adds query (e.g. "&slideskip=freeze").
//   node scripts/slideframe.mjs [--url http://localhost:5207] [--speed 1.2] [--frames 900] [--mods all|terrain]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const speed = Number(opt('speed', 1.2));
const frames = Number(opt('frames', 900));
const mods = opt('mods', 'all');
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=915,412'],
  defaultViewport: { width: 915, height: 412, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=valley&tutorial=0&q=low${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  const r = await p.evaluate(
    async (speed, frames, mods) => {
      const { createAtlasWorld } = await import('/src/api/atlas-world.ts');
      const { attachSim } = await import('/src/api/world.ts');
      const { installPhysics } = await import('/src/physics/install.ts');
      const host = window.reclaimed.core.host;
      // (the valley's own loop stops drawing: this page draws the atlas world)
      window.reclaimed.scene.frame = () => {};
      const aw = await createAtlasWorld(host, { at: [12304, 5457], particles: 20000 });
      aw.core.resize(915, 412, 915, 412);
      const all = { terrain: true, water: true, fire: true, wind: true, fx: true, plants: true, agents: true };
      const sim = attachSim(aw.core, mods === 'all' ? all : { terrain: true });
      if (mods === 'all') installPhysics(aw.core);
      const target = [128, 128 * 0.866];
      aw.core.camera.target = [target[0], target[1], 120];
      const slideAt = [];
      let f = 0;
      aw.onSlide.push(() => slideAt.push(f));
      // (settle first: the first seconds after a world is made are its first meshes and compiles)
      for (let k = 0; k < 240; k++) {
        if (!aw.frame([target[0], target[1]])) aw.core.advance(performance.now(), 1 / 60, 1);
        aw.core.render();
        await new Promise((res) => requestAnimationFrame(res));
      }
      const gaps = [];
      const acc = {};
      const mx = {};
      let last = performance.now();
      for (f = 0; f < frames; f++) {
        target[0] += speed;
        aw.core.camera.target[0] = target[0];
        aw.core.camera.target[1] = target[1];
        if (!aw.frame([target[0], target[1]])) aw.core.advance(performance.now(), 1 / 60, 1);
        aw.core.render();
        await new Promise((res) => requestAnimationFrame(res));
        const t = performance.now();
        gaps.push(t - last);
        for (const [k, v] of host.profiler.passMs) if (k.includes('fieldmesh')) { acc[k] = (acc[k] ?? 0) + v; mx[k] = Math.max(mx[k] ?? 0, v); }
        last = t;
      }
      void sim;
      const pm = {};
      let sum = 0;
      for (const [k, v] of host.profiler.passMs) {
        sum += v;
        if (v > 0.3 || k.includes('fieldmesh')) pm[k] = +v.toFixed(3);
      }
      pm.SUM = +sum.toFixed(2);
      for (const k in acc) pm[k] = `mean ${(acc[k] / frames).toFixed(3)} max ${mx[k].toFixed(2)}`;
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = slideAt.map((s) => Math.max(...gaps.slice(Math.max(0, s - 1), s + 6)).toFixed(0));
      return { slides: slideAt.length, atSlides: at, p50: +sorted[Math.floor(gaps.length / 2)].toFixed(1), p95: +sorted[Math.floor(gaps.length * 0.95)].toFixed(1), worst: +sorted[gaps.length - 1].toFixed(0), over100: gaps.filter((g) => g > 100).length, gpuFrame: +host.profiler.gpuFrameMs.toFixed(2), passes: pm, awake: aw.sleep?.awake };
    },
    speed,
    frames,
    mods,
  );
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
