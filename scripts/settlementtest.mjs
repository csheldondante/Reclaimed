// Settlements in play (round 88), through their API: the atlas level started at a town (?town=), its land
// realised (buildings, walls, fields), its people out as units on their rounds, a raid from its camp met by its
// guards — screenshots at the default zoom and zoomed in, a GIF of the raid, and the frame's cost.
//   node scripts/settlementtest.mjs [--url http://localhost:5255] [--town 1|s12] [--q low] [--size 412x915]
//     [--out C:/Projects/shots88/settlements] [--measure 15] [--extra "&townfolk=0"] [--tag phone] [--nogif]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5255');
const town = opt('town', '1');
const q = opt('q', 'low');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const out = opt('out', 'C:/Projects/shots88/settlements');
const tag = opt('tag', q);
const measure = Number(opt('measure', 15));
const extra = opt('extra', '');
fs.mkdirSync(out, { recursive: true });
let fails = 0;
const ok = (c, what) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const gif = async (page, file, frames, every) => {
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    await sleep(every);
  }
  enc.finish();
  fs.writeFileSync(file, enc.bytes());
  console.log(`saved ${file}`);
};
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || t.includes('settle')) console.log(`[console.${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => {
    fails++;
    console.log(`[pageerror] ${e.message}`);
  });
  const t0 = Date.now();
  await page.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=${q}&perf=1&town=${town}&towndebug=1${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 300000 });
  console.log(`level up in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // (the first load after a server start is slow: give it its 30 s)
  await sleep(30000);
  // (the sandbox's tool bar and the perf text off the view: the town's what's being looked at)
  await page.addStyleTag({ content: '.editor{display:none!important}' });
  const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
  ok(!fatal, `no fatal overlay${fatal ? `: ${fatal}` : ''}`);
  const info = await page.evaluate(() => {
    const R = window.reclaimed;
    const st = R.settlements;
    const s = st.live();
    const p = s && st.plan(s.id);
    return {
      stats: st.stats,
      live: s && { id: s.id, name: s.name, size: s.size, grids: s.grids.map((g) => g.style), buildings: s.buildings.length, people: s.people, stores: s.stores, camp: !!p?.camp, ruin: !!s.founded?.over },
      units: R.units.stats,

    };
  });
  console.log(JSON.stringify(info));
  ok(info.stats.planned > 0 && info.stats.stamped > 0, `planned ${info.stats.planned}, ${info.stats.stamped} columns stamped`);
  ok(!!info.live, `a settlement is live: ${info.live?.name}`);
  const extraNoFolk = extra.includes('townfolk=0') || extra.includes('towns=0');
  if (!extraNoFolk) ok(info.units.units > 5, `its people are out: ${info.units.units}`);
  // the cost, standing at the town (the perf overlay's numbers)
  await page.evaluate(() => {
    const R = window.reclaimed;
    R.core.host.profiler.resetTotals();
    window.__t = [];
    const f = () => {
      window.__t.push(performance.now());
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await sleep(measure * 1000);
  const perf = await page.evaluate(() => {
    const R = window.reclaimed;
    const t = window.__t;
    const d = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    d.sort((a, b) => a - b);
    const P = R.core.host.profiler;
    const per = Object.fromEntries([...P.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, +(v / Math.max(P.framesResolved, 1)).toFixed(3)]));
    return { p50: +d[Math.floor(d.length / 2)].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1), gpu: +(P.gpuTotalMs / Math.max(P.framesResolved, 1)).toFixed(2), agents: per.agents ?? 0, per, units: R.units.stats, trips: R.settlements.life?.trips ?? 0, moved: R.settlements.life?.moved, blocks: R.settlements.life?.blocks, houses: R.settlements.life?.houses };
  });
  console.log(`PERF ${tag}: frame p50 ${perf.p50} p95 ${perf.p95} ms, GPU ${perf.gpu} ms/frame (agents ${perf.agents}), units ${perf.units.units}, trips ${perf.trips}, moved ${JSON.stringify(perf.moved)}, blocks ${perf.blocks}, houses ${perf.houses}`);
  console.log(JSON.stringify(perf.per));
  await page.screenshot({ path: `${out}/town-${tag}-debug.png` });
  console.log(`saved ${out}/town-${tag}-debug.png`);
  await page.evaluate(() => window.reclaimed.townDebug?.show(false));
  await sleep(500);
  await page.screenshot({ path: `${out}/town-${tag}-default.png` });
  console.log(`saved ${out}/town-${tag}-default.png`);
  if (!extraNoFolk) {
    // zoomed in on the plaza
    await page.evaluate(() => {
      const R = window.reclaimed;
      const st = R.settlements;
      const s = st.live();
      const [x, y] = st.toWindow(s.at);
      R.camera.target[0] = x;
      R.camera.target[1] = y;
      window.__zoom = R.camera.zoom;
      R.camera.zoom *= 6;
    });
    await sleep(4000);
    await page.screenshot({ path: `${out}/town-${tag}-zoom.png` });
    console.log(`saved ${out}/town-${tag}-zoom.png`);
    if (!argv.includes('--nogif')) await gif(page, `${out}/town-${tag}-workers.gif`, 30, 200);
    // closer, at the quarry, then the house going up
    for (const [what, kind] of [['quarry', 'mine'], ['site', 'site'], ['heaps', 'pile']]) {
      const ok2 = await page.evaluate((kind) => {
        const R = window.reclaimed;
        const st = R.settlements;
        const s = st.live();
        const p = st.plan(s.id);
        const seed = st.seeds.find((x) => x.rec.id === s.id);
        const sp = kind === 'site' ? p.sites.find((x) => !x.finished) && { at: p.sites.find((x) => !x.finished).door } : p.spots.find((x) => x.kind === kind);
        if (!sp) return false;
        const [x, y] = st.toWindow([sp.at[0] + seed.box.x0, sp.at[1] + seed.box.y0 * 0.8660254]);
        R.camera.target[0] = x;
        R.camera.target[1] = y;
        R.camera.zoom = window.__zoom * 9;
        return true;
      }, kind);
      if (!ok2) continue;
      await sleep(3000);
      await page.screenshot({ path: `${out}/town-${tag}-${what}.png` });
      if (!argv.includes('--nogif')) await gif(page, `${out}/town-${tag}-${what}.gif`, 30, 250);
    }
    // the raid: the camp marches on the town, the guards meet it
    const raid = await page.evaluate(() => {
      const R = window.reclaimed;
      const st = R.settlements;
      window.__raids = [];
      window.__deaths = [];
      st.events.raided.push((s, o, l) => window.__raids.push({ s: s.id, o, l }));
      st.events.died.push((s, u, by) => window.__deaths.push({ s: s.id, role: u.role, by }));
      R.units.died.push((u) => window.__deaths.push({ role: u.role, hostile: u.hostile }));
      const ok = st.raid();
      const life = st.life;
      const camp = st.toWindow(st.settlement(life.camp.id).at);
      const [x, y] = st.toWindow(life.rec.at);
      R.camera.target[0] = (x * 2 + camp[0]) / 3;
      R.camera.target[1] = (y * 2 + camp[1]) / 3;
      R.camera.zoom = window.__zoom * 3.5;
      return { ok, raiders: life.raiders.length, guards: life.ids.filter((id) => R.units.get(id)?.role === 'guard').length };
    });
    ok(raid.ok, `a raid: ${raid.raiders} raiders against ${raid.guards} guards`);
    if (raid.ok) {
      await sleep(5000);
      // (round 104, simscale) the agents' GPU a frame during the raid
      await page.evaluate(() => window.reclaimed.core.host.profiler.resetTotals());
      await sleep(6000);
      const rp = await page.evaluate(() => {
        const P = window.reclaimed.core.host.profiler;
        return { gpu: +(P.gpuTotalMs / Math.max(P.framesResolved, 1)).toFixed(2), agents: +((P.totalMs.get('agents') ?? 0) / Math.max(P.framesResolved, 1)).toFixed(3) };
      });
      console.log(`PERF raid ${tag}: GPU ${rp.gpu} ms/frame (agents ${rp.agents})`);
      if (!argv.includes('--nogif')) await gif(page, `${out}/raid-${tag}.gif`, 45, 400);
      else await sleep(18000);
      await page.screenshot({ path: `${out}/raid-${tag}.png` });
      const after = await page.evaluate(() => ({ raids: window.__raids, deaths: window.__deaths, hunting: window.reclaimed.units.stats.hunting, live: window.reclaimed.settlements.life?.raid?.t ?? null }));
      console.log(JSON.stringify(after));
      ok(after.deaths.length > 0 || after.hunting > 0, `they fought: ${after.deaths.length} dead, ${after.hunting} hunting`);
    }
  }
} finally {
  await browser.close();
}
process.exit(fails ? 1 : 0);
