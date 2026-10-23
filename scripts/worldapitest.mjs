// The world API (docs/WORLD_API.md), steps 1-3: every query checked against
// the raw buffers, every command checked for its effect.
//   terrain: heightAt / groundAt / materialAt vs the levels texture, surface + drift, the layers;
//            dig, deposit, build, crater change the height
//   water:   depthAt vs water; flood raises it, drain lowers it; flowAt on moving water
//   fire:    ignite lights grass; fireAt / heatAt see it
//   wind:    a held blow sets the field under it; 400 blows (past the GPU's 256) merge, none lost
//   fx:      bursts by name spawn; 150 in one frame (past 64 a tick) all spawn
//
//   node scripts/worldapitest.mjs [--url http://localhost:5181] [--level sandbox]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const level = opt('level', 'sandbox');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
  if (!ok) failed = true;
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  const run = (fn, ...a) => page.evaluate(fn, ...a);
  // helpers in the page
  await run(async () => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { readColumn, sfZ } = await import('/src/world/layout.ts');
    const { w, h } = R.core.dims;
    window.T = {
      api: R.api,
      cellPos,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pt: (dx, dy) => cellPos(Math.floor(w / 2) + dx, Math.floor(h / 2) + dy),
      truth: async () => {
        const [lv, sf, dr, ly, wa, fi] = await Promise.all([
          R.core.readTexture(R.world.levels),
          R.core.readBuffer('surface'),
          R.core.readTexture(R.world.drift),
          R.core.readBuffer('layers'),
          R.core.readBuffer('water'),
          R.core.readBuffer('fire'),
        ]);
        return { lv: lv.data, sf: new Uint32Array(sf.buffer), dr: dr.data, ly: new Uint32Array(ly.buffer), wa, fi, readColumn, sfZ };
      },
    };
    await R.api.refresh();
  });

  // what a mirror read costs (every module's buffers, one map)
  console.log(
    'mirror read:',
    JSON.stringify(
      await run(async () => {
        const t = [];
        for (let k = 0; k < 5; k++) {
          const t0 = performance.now();
          await window.T.api.refresh();
          t.push(performance.now() - t0);
        }
        t.sort((a, b) => a - b);
        return { medianMs: +t[2].toFixed(1) };
      }),
    ),
  );
  // ---- terrain queries vs the buffers
  check(
    'terrain queries',
    ...(await run(async () => {
      const { api, truth } = window.T;
      const R = window.reclaimed;
      const { w, h } = R.core.dims;
      await api.refresh();
      const t = await truth();
      let n = 0;
      let bad = 0;
      const { MATERIALS } = await import('/src/world/materials.ts');
      for (let k = 0; k < 200; k++) {
        const x = 2 + Math.floor(Math.random() * (w - 4));
        const y = 2 + Math.floor(Math.random() * (h - 4));
        const [wx, wy] = window.T.cellPos(x, y);
        const i = y * w + x;
        const col = t.readColumn(R.core.packed, t.ly, x, y);
        const top = col.length ? MATERIALS[col[col.length - 1].mat].name : 'air';
        const okH = Math.abs(api.terrain.heightAt(wx, wy) - t.lv[i * 4]) < 1e-4;
        const okG = Math.abs(api.terrain.groundAt(wx, wy) - (t.sfZ(t.sf[i]) + t.dr[i * 4])) < 1e-3;
        const okM = api.terrain.materialAt(wx, wy).replace('drift', 'dust') === top.replace('drift', 'dust') || api.terrain.materialAt(wx, wy) === top;
        const okF = api.terrain.floorAt(wx, wy, 1e4) === t.lv[i * 4];
        n++;
        if (!(okH && okG && okM && okF)) bad++;
      }
      // (the mirror moved on from the truth read by a tick or two: a few columns may differ where things move)
      return [bad <= 6, { points: n, mismatched: bad }];
    })),
  );

  // ---- terrain commands
  const edits = await run(async () => {
    const { api, pt, sleep } = window.T;
    const T = api.terrain;
    const spots = { dig: pt(-40, -30), deposit: pt(-20, -30), build: pt(0, -30), crater: pt(30, -40) };
    const h0 = {};
    for (const [k, [x, y]] of Object.entries(spots)) h0[k] = T.heightAt(x, y);
    T.dig(...spots.dig, { radius: 3, layers: 2 });
    T.deposit(...spots.deposit, 'sand', { radius: 3, layers: 2 });
    T.build(...spots.build, 'stone', { radius: 3, layers: 3 });
    T.crater(...spots.crater, { radius: 6 });
    await sleep(4000);
    await api.refresh();
    const out = {};
    for (const [k, [x, y]] of Object.entries(spots)) out[k] = +(T.heightAt(x, y) - h0[k]).toFixed(2);
    out.depositMaterial = T.materialAt(...spots.deposit);
    out.buildMaterial = T.materialAt(...spots.build);
    return out;
  });
  check('terrain dig lowers', edits.dig < -0.9, edits);
  check('terrain deposit raises (sand)', edits.deposit > 1 && edits.depositMaterial === 'sand', edits);
  check('terrain build raises (stone)', edits.build > 2 && edits.buildMaterial === 'stone', edits);
  check('terrain crater lowers', edits.crater < -2, edits);

  // ---- water
  const water = await run(async () => {
    const { api, pt, sleep, truth } = window.T;
    const W = api.water;
    const R = window.reclaimed;
    const { w } = R.core.dims;
    await api.refresh();
    const t = await truth();
    // queries vs the buffer, at the wettest columns
    let bad = 0;
    let flowing = 0;
    const idx = [...t.wa.keys()].sort((a, b) => t.wa[b] - t.wa[a]).slice(0, 50);
    for (const i of idx) {
      const [x, y] = window.T.cellPos(i % w, Math.floor(i / w));
      if (Math.abs(W.depthAt(x, y) - t.wa[i]) > 0.05) bad++;
      const f = W.flowAt(x, y);
      if (Math.hypot(f[0], f[1]) > 0.05) flowing++;
    }
    const [fx, fy] = pt(10, 30);
    const d0 = W.depthAt(fx, fy);
    W.flood(fx, fy, { radius: 4, depth: 2 });
    await sleep(600);
    await api.refresh();
    const d1 = W.depthAt(fx, fy);
    W.drain(fx, fy, { radius: 6, depth: 5 });
    await sleep(600);
    await api.refresh();
    const d2 = W.depthAt(fx, fy);
    return { depthMismatches: bad, flowingOf50: flowing, before: +d0.toFixed(2), flooded: +d1.toFixed(2), drained: +d2.toFixed(2) };
  });
  check('water depthAt vs buffer', water.depthMismatches <= 3, water);
  // (the flat sandbox runs a flood off within a second: it raises the water, then the drain takes it)
  check('water flood then drain', water.flooded > water.before + 0.15 && water.drained < water.flooded - 0.15, water);

  // ---- fire
  const fire = await run(async () => {
    const { api, sleep } = window.T;
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const veg = await R.core.readBuffer('veg');
    const water = await R.core.readBuffer('water');
    // the grassiest dry column
    let best = -1;
    for (let i = 0; i < w * h; i++) if (water[i] < 0.01 && (best < 0 || veg[i] > veg[best])) best = i;
    const [x, y] = window.T.cellPos(best % w, Math.floor(best / w));
    await api.refresh();
    const f0 = api.fire.fireAt(x, y);
    api.fire.ignite(x, y, { radius: 3 });
    await sleep(800);
    await api.refresh();
    return { veg: +veg[best].toFixed(2), before: f0, after: +api.fire.fireAt(x, y).toFixed(2), heat: Math.round(api.fire.heatAt(x, y)), lava: api.fire.lavaAt(x, y) };
  });
  check('fire ignite', fire.after > 0.2 && fire.heat > 100, fire);

  // ---- wind
  const wind = await run(async () => {
    const { api, pt, sleep } = window.T;
    const W = api.wind;
    const [x, y] = pt(-50, 40);
    await api.refresh();
    const w0 = W.fieldAt(x, y);
    const b = W.blow({ x, y, radius: 10, strength: 12, dir: [0, 1], time: 3 });
    await sleep(2000);
    await api.refresh();
    const w1 = W.fieldAt(x, y);
    const off = W.fieldAt(x + 30, y);
    b.stop();
    // a blast: outward on each side
    const [bx, by] = pt(40, 40);
    W.blast(bx, by, 12, 10, 1.5);
    await sleep(700);
    await api.refresh();
    const east = W.fieldAt(bx + 5, by);
    const west = W.fieldAt(bx - 5, by);
    // past the cap: 400 small blows along a line
    const hs = [];
    for (let k = 0; k < 400; k++) hs.push(W.blow({ x: x + (k % 40) * 2, y: y - 30 + Math.floor(k / 40) * 2, radius: 3, strength: 6, dir: [1, 0], time: 1 }));
    await sleep(100);
    const listed = W.lastListed;
    const sent = W.lastSent;
    // (1 s of sim time: headless runs slower than real time)
    for (let k = 0; k < 40 && !hs.every((h) => !h.alive); k++) await sleep(250);
    // a wake: a thing moving east at 8 cells/s for 2 s, then gone
    const [kx, ky] = pt(-60, -60);
    let t0 = performance.now();
    let wakeBehind = null;
    let ahead = null;
    while (performance.now() - t0 < 2000) {
      const e = (performance.now() - t0) / 1000;
      // (two movers at once: the tank, and a bike going the other way further north)
      W.wake('tank', { at: [kx + e * 8, ky], vel: [8, 0], width: 4 });
      W.wake('bike', { at: [kx + 16 - e * 8, ky + 20], vel: [-8, 0], width: 4 });
      await sleep(16);
    }
    await api.refresh();
    const endX = kx + 16;
    wakeBehind = W.fieldAt(endX - 4, ky);
    ahead = W.fieldAt(endX + 8, ky);
    const bikeBehind = W.fieldAt(kx + 4, ky + 20);
    t0 = performance.now();
    await sleep(3000);
    const wakesLeft = W.lastListed;
    return {
      wakeBehindX: +wakeBehind[0].toFixed(2),
      bikeBehindX: +bikeBehind[0].toFixed(2),
      aheadX: +ahead[0].toFixed(2),
      blowsAfterWakeStops: wakesLeft,
      dustLift: W.liftThreshold('drift'),
      soilLift: String(W.liftThreshold('soil')),
      before: w0.map((v) => +v.toFixed(2)),
      underBlow: w1.map((v) => +v.toFixed(2)),
      away: off.map((v) => +v.toFixed(2)),
      blastEastX: +east[0].toFixed(2),
      blastWestX: +west[0].toFixed(2),
      listed,
      sent,
      allEnded: hs.every((h) => !h.alive),
    };
  });
  check('wind blow holds the field', wind.underBlow[1] - wind.before[1] > 8 && Math.abs(wind.away[1] - wind.before[1]) < 3, wind);
  check('wind blast outward', wind.blastEastX > 2 && wind.blastWestX < -2, wind);
  check('wind past the cap merges', wind.listed >= 400 && wind.sent <= 256 && wind.sent > 0 && wind.allEnded, wind);
  // (a wake paints along the motion, under 0.7 × the speed: 5.6 for 8 cells/s, over the map's own wind)
  check('wind wakes trail behind, capped, then stop', wind.wakeBehindX > wind.aheadX + 2 && wind.wakeBehindX < wind.aheadX + 6 && wind.bikeBehindX < wind.aheadX - 2 && wind.blowsAfterWakeStops === 0, wind);
  check('wind lift thresholds', wind.dustLift === 9 && wind.soilLift === 'Infinity', wind);

  // ---- fx
  const fx = await run(async () => {
    const { api, pt, sleep } = window.T;
    const R = window.reclaimed;
    const count = async (kind) => {
      const p = new Uint32Array((await R.core.readBuffer('particles')).buffer);
      const f = new Float32Array(p.buffer);
      let n = 0;
      for (let i = 0; i < p.length / 12; i++) if (f[i * 12 + 3] > 0 && p[i * 12 + 8] === kind) n++;
      return n;
    };
    const [x, y] = pt(0, 0);
    const z = api.terrain.heightAt(x, y) + 3;
    const s0 = await count(5);
    // 150 bursts of 4 chips in one frame: past the 64 a tick
    for (let k = 0; k < 150; k++) api.fx.burst('chips', x + (k % 15), y + Math.floor(k / 15), z, { count: 4, speed: 1 });
    await sleep(300);
    const s1 = await count(5);
    let threw = false;
    try {
      api.fx.burst('fireworks', x, y, z);
    } catch {
      threw = true;
    }
    return { names: api.fx.names.length, chipsBefore: s0, chipsAfter: s1, unknownNameThrows: threw };
  });
  check('fx bursts past the cap all spawn', fx.chipsAfter - fx.chipsBefore >= 550 && fx.unknownNameThrows, fx);
} finally {
  await browser.close();
}
if (failed) process.exit(1);
