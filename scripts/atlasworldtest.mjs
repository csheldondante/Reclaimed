// Round 80: the world API's atlas world (src/api/atlas-world.ts) as a game uses it — made on a page's host
// (the level's, borrowed), the world API over it, a target ridden 200 cells east frame by frame (each frame:
// aw.frame(target), the sim's ticks unless a slide runs, a render), the window sliding after it.
//   node scripts/atlasworldtest.mjs [--url http://localhost:5207]
import puppeteer from 'puppeteer-core';
// (perfopt: --extra "&flag=v" appended to the page's URL)
const EXTRA = process.argv.includes('--extra') ? process.argv[process.argv.indexOf('--extra') + 1] : '';
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
  await p.goto(`${url}/?skipmenu=1&level=valley&tutorial=0&q=low${EXTRA}`, { waitUntil: 'load' });
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
    const sim = attachSim(aw.core, { terrain: true, water: true, agents: true });
    await sim.refresh();
    const o0 = [...aw.stream.origin];
    const target = [128, 128 * 0.866];
    // (round 80: units left standing where they're spawned must stay on the same land through the slides)
    sim.agents.spawn(12, target[0] + 100, target[1], { spread: 4 });
    for (let k = 0; k < 90; k++) {
      aw.core.advance(performance.now(), 1 / 60, 1);
      aw.core.render();
      await new Promise((res) => requestAnimationFrame(res));
    }
    const before = new Map((await sim.agents.sync()).units.map((u) => [u.id, aw.toWorld(u.x, u.y)]));
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
    // (a game goes on ticking: the column tops of what came in last are made by the sim's next tick)
    for (let k = 0; k < 90; k++) {
      if (!aw.frame([target[0], target[1]])) aw.core.advance(performance.now(), 1 / 60, 1);
      aw.core.render();
      await new Promise((res) => requestAnimationFrame(res));
    }
    await sim.refresh();
    const h = sim.terrain.heightAt(target[0], target[1]);
    const after = (await sim.agents.sync()).units;
    // (by id: some drown or fall; an idle unit wanders a few cells — a slide not followed is 64 off)
    const drift = after.filter((u) => before.has(u.id)).map((u) => {
      const w = aw.toWorld(u.x, u.y);
      const b = before.get(u.id);
      return Math.hypot(w[0] - b[0], w[1] - b[1]);
    });
    // (those still in the window)
    const onLand = after.filter((u) => u.x > 2 && u.y > 2 && u.x < aw.core.dims.w - 2 && u.y < aw.core.dims.h * 0.866 - 2).map((u) => Math.abs(u.z - (sim.terrain.heightAt(u.x, u.y) ?? -99)));
    // (the column tops everywhere in the window, asleep or not: none 0 — the hoverbike session's 2b)
    const S = aw.core.map.surface;
    let zeros = 0;
    let n = 0;
    const zx = new Array(8).fill(0);
    const zy = new Array(8).fill(0);
    for (let y = 8; y < aw.core.dims.h - 8; y += 4)
      for (let x = 8; x < aw.core.dims.w - 8; x += 4) {
        n++;
        if ((sim.terrain.heightAt(x + 0.5, (y + 0.5) * 0.866) ?? 0) <= 0) {
          zeros++;
          zx[Math.floor(x / 32)]++;
          zy[Math.floor(y / 32)]++;
        }
      }
    const ride = { moved: aw.stream.origin[0] - o0[0], slides, seaZ: aw.core.globals.seaZ, awake: aw.sleep?.awake, world: aw.toWorld(target[0], target[1]).map((v) => +v.toFixed(0)) };
    // (round 80) a warp: somewhere else entirely, the land there, the reads fresh after
    let warped = null;
    aw.onWarp.push((ox, oy, oz) => (warped = { ox, oy, oz }));
    const tw = performance.now();
    await aw.warp(5040, 12672);
    const warpMs = performance.now() - tw;
    for (let k = 0; k < 120; k++) {
      if (!aw.frame([aw.core.camera.target[0], aw.core.camera.target[1]])) aw.core.advance(performance.now(), 1 / 60, 1);
      aw.core.render();
      await new Promise((res) => requestAnimationFrame(res));
    }
    await sim.refresh();
    let wz = 0;
    // (columns with ground in the window — the CPU's surface — read so in the mirror too)
    let wn = 0;
    for (let y = 8; y < aw.core.dims.h - 8; y += 8)
      for (let x = 8; x < aw.core.dims.w - 8; x += 8) {
        if (aw.core.map.surface[y * aw.core.dims.w + x] <= 0) continue;
        wn++;
        if ((sim.terrain.heightAt(x + 0.5, (y + 0.5) * 0.866) ?? 0) <= 0) wz++;
      }
    const mid = aw.toWorld(aw.core.camera.target[0], aw.core.camera.target[1]);
    const warp = { warped, warpMs: +warpMs.toFixed(0), mid: mid.map((v) => Math.round(v)), zeros: wz, ofGround: wn, empty: [...aw.core.map.surface].filter((v) => v <= 0).length, fresh: sim.fresh, seaZ: aw.core.globals.seaZ, awake: aw.sleep?.awake };
    return {
      warp,
      built: +built.toFixed(0),
      moved: ride.moved,
      slides: ride.slides,
      busyFrames,
      ticks,
      seaZ: ride.seaZ,
      awake: ride.awake,
      chunks: (aw.core.dims.w / 16) * (aw.core.dims.h / 16),
      band: !!aw.core.renderer.band,
      height: h,
      fresh: sim.fresh,
      units: after.length,
      driftMax: +Math.max(...drift).toFixed(2),
      offLandMax: +Math.max(...onLand).toFixed(2),
      zeros,
      sampled: n,
      zx,
      zy,
      surfZeros: [...S].filter((v) => v <= 0).length,
      onLandN: onLand.length,
      world: ride.world,
    };
  });
  check('an atlas world from the API: built, the world API over it', r.built > 0 && r.band, { built: r.built, band: r.band });
  check('a target ridden east: the window slides after it', r.moved >= 192 && r.slides >= 3, { moved: r.moved, slides: r.slides, busyFrames: r.busyFrames, ticks: r.ticks });
  check('units stay on the land they stood on through the slides (they move with the window)', r.units > 0 && r.driftMax < 12 && (r.onLandN === 0 || r.offLandMax < 2.5), { units: r.units, driftMax: r.driftMax, inWindow: r.onLandN, offLandMax: r.offLandMax });
  check('the terrain reads after the slides: fresh, no column top 0 (asleep or not)', r.fresh && r.zeros === 0, { fresh: r.fresh, zeros: r.zeros, of: r.sampled, byX: r.zx, byY: r.zy, cpuSurfaceZeros: r.surfZeros });
  check('a warp: the window somewhere else, the land there read fresh, onWarp told', r.warp.warped && Math.abs(r.warp.mid[0] - 5040) < 40 && Math.abs(r.warp.mid[1] - 12672) < 40 && r.warp.zeros === 0 && r.warp.fresh, r.warp);
  check('the sea held, sleep on, the terrain under the target', r.seaZ > -1e8 && r.awake > 0 && r.awake < r.chunks && r.height > 0, { seaZ: r.seaZ, awake: r.awake, of: r.chunks, height: r.height, world: r.world });
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
