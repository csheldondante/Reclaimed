// Work crews (round 63): workers dig a pit and carry it to a pile (the
// totals add up: dug = piled + carried), dig soil and fire it to bricks at
// the pile, fell trees and stack the logs. Prints the measures; shots to
// <out>-{dig,fell}.png.
//
//   node scripts/crewtest.mjs [--url http://localhost:5185] [--out crew] [--seconds 30] [--level valley]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const out = opt('out', 'crew');
const seconds = Number(opt('seconds', 30));
const level = opt('level', 'valley');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const results = [];
const check = (name, ok, data) => {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(data)}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  await page.waitForFunction(() => window.reclaimed?.agents && window.reclaimed?.api?.plants, { timeout: 90000 });
  await wait(4000);
  // find the places: dry soil to dig (no water, not steep), a pile beside it, a stand of trees
  const sites = await page.evaluate(async () => {
    const R = window.reclaimed;
    const api = R.api;
    await api.refresh();
    const T = api.terrain;
    const W = api.water;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const flatSoil = (x, y) => {
      if (T.materialAt(x, y) !== 'soil') return false;
      if ((W?.depthAt?.(x, y) ?? 0) > 0.01) return false;
      const z = T.heightAt(x, y);
      for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [10, 0]]) if (Math.abs((T.heightAt(x + dx, y + dy) ?? -99) - z) > 1.2 || T.materialAt(x + dx, y + dy) === 'water') return false;
      return true;
    };
    let dig = null;
    for (let cy = 20; cy < h - 20 && !dig; cy += 7) {
      for (let cx = 20; cx < w - 30 && !dig; cx += 7) {
        const [x, y] = cellPos(cx, cy);
        if (flatSoil(x, y) && flatSoil(x + 10, y)) dig = { x, y };
      }
    }
    // the densest stand of trees
    let best = null;
    for (let cy = 12; cy < h - 12; cy += 6) {
      for (let cx = 12; cx < w - 12; cx += 6) {
        const [x, y] = cellPos(cx, cy);
        const n = api.plants.treesNear(x, y, 6).length;
        if (!best || n > best.n) best = { x, y, n };
      }
    }
    return { dig, trees: best };
  });
  console.log('sites:', JSON.stringify(sites));
  if (!sites.dig) throw new Error('no flat dry soil to dig on this level');

  // dig: six workers, a pit 2.5 across 1.5 down, the pile 10 cells off, soil fired to bricks there
  const dig = await page.evaluate(async (secs, d) => {
    const R = window.reclaimed;
    const api = R.api;
    const A = api.agents;
    const T = api.terrain;
    const pile = { x: d.x + 10, y: d.y };
    const area = (c, r) => {
      let s = 0;
      let n = 0;
      for (let k = 0; k < 40; k++) {
        const a = k * 2.39996;
        const rr = r * Math.sqrt((k + 0.5) / 40);
        s += T.heightAt(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr);
        n++;
      }
      return s / n;
    };
    const pit0 = area(d, 2.5);
    const pile0 = area(pile, 1.5);
    const ids = A.spawn(6, d.x + 4, d.y + 3, { kind: 'worker', group: 10, spread: 0.8 });
    const crew = api.crew({ units: ids, groups: [10, 11, 12], fields: [0, 1], job: { kind: 'dig', x: d.x, y: d.y, radius: 2.5, depth: 1.5 }, pile: { ...pile, radius: 1.5 }, make: { from: ['soil'], to: 'brick' } });
    window.__crew = crew;
    let stop = false;
    let units = [];
    const loop = async () => {
      if (stop) return;
      const s = await A.sync();
      units = s.units;
      crew.update(s.units);
      requestAnimationFrame(loop);
    };
    loop();
    await new Promise((r) => setTimeout(r, secs * 1000));
    crew.stop();
    await new Promise((r) => setTimeout(r, 1500));
    stop = true;
    await api.refresh();
    const carried = ids.map((id) => A.carrying(id)?.amount ?? 0).reduce((a, b) => a + b, 0);
    const dug = Object.values(crew.stats.dug).reduce((a, b) => a + b, 0);
    const piled = Object.values(crew.stats.piled).reduce((a, b) => a + b, 0);
    const u = units.find((v) => v.id === ids[0]);
    R.camera.target = [d.x + 5, d.y, T.heightAt(d.x, d.y)];
    R.camera.zoom = 12;
    return { stats: crew.stats, dug: +dug.toFixed(3), piled: +piled.toFixed(3), carried: +carried.toFixed(3), inFlight: A.inFlight.length, pitDrop: +(pit0 - area(d, 2.5)).toFixed(2), pileRise: +(area(pile, 1.5) - pile0).toFixed(2), pileTop: T.materialAt(pile.x, pile.y), seen: !!u };
  }, seconds, sites.dig);
  await wait(800);
  await page.screenshot({ path: `${out}-dig.png` });
  check('dig: they dug and carried it, many trips', dig.stats.trips >= 6 && dig.dug > 2, dig);
  check('dig: the totals add up (dug = piled + carried + in flight)', Math.abs(dig.dug - dig.piled - dig.carried) < 1e-3 && dig.inFlight === 0, { dug: dig.dug, piled: dig.piled, carried: dig.carried });
  check('dig: a pit sinks, the pile rises (soil fired to brick there)', dig.pitDrop > 0.2 && dig.pileRise > 0.2 && (dig.stats.piled.brick ?? 0) > 0, { pitDrop: dig.pitDrop, pileRise: dig.pileRise, piled: dig.stats.piled });

  // fell: six workers, the stand of trees, logs to a pile 8 cells off
  // (a barren map: grow a wood beside the dig first)
  if (!sites.trees || sites.trees.n < 3) {
    sites.trees = await page.evaluate(async (d) => {
      const api = window.reclaimed.api;
      const t = { x: d.x, y: d.y - 16 };
      api.plants.grow(t.x, t.y, { radius: 7, strength: 70 });
      await new Promise((r) => setTimeout(r, 2500));
      await api.refresh();
      return { ...t, n: api.plants.treesNear(t.x, t.y, 6).length, grown: true };
    }, sites.dig);
    console.log('grew a wood:', JSON.stringify(sites.trees));
  }
  if (!sites.trees || sites.trees.n < 3) {
    check('fell: a stand of trees on this level', false, sites.trees);
  } else {
    const fell = await page.evaluate(async (secs, t) => {
      const R = window.reclaimed;
      const api = R.api;
      const A = api.agents;
      const T = api.terrain;
      const trees0 = api.plants.treesNear(t.x, t.y, 6).length;
      // (the pile: the open ground nearest 8 cells off)
      const pile = { x: t.x + 8, y: t.y + 2 };
      const ids = A.spawn(6, t.x + 5, t.y, { kind: 'worker', group: 13, spread: 0.8 });
      const crew = api.crew({ units: ids, groups: [13, 14, 15], fields: [2, 3], job: { kind: 'fell', x: t.x, y: t.y, radius: 6 }, pile: { ...pile, radius: 1.5 } });
      let stop = false;
      const loop = async () => {
        if (stop) return;
        const s = await A.sync();
        crew.update(s.units);
        requestAnimationFrame(loop);
      };
      loop();
      await new Promise((r) => setTimeout(r, secs * 1000));
      crew.stop();
      await new Promise((r) => setTimeout(r, 1500));
      stop = true;
      await api.refresh();
      const carried = ids.map((id) => A.carrying(id)?.amount ?? 0).reduce((a, b) => a + b, 0);
      R.camera.target = [t.x + 4, t.y, T.heightAt(t.x, t.y)];
      R.camera.zoom = 12;
      return { stats: crew.stats, trees0, treesNow: api.plants.treesNear(t.x, t.y, 6).length, carried: +carried.toFixed(3), logsPiled: +(crew.stats.piled.log ?? 0).toFixed(3), pileTop: T.materialAt(pile.x, pile.y) };
    }, seconds, sites.trees);
    await wait(800);
    await page.screenshot({ path: `${out}-fell.png` });
    check('fell: trees come down, logs to the pile', fell.stats.felled >= 2 && fell.treesNow < fell.trees0 && fell.logsPiled > 0.5, fell);
    check('fell: the logs add up (cut = piled + carried)', Math.abs(fell.stats.logs - fell.logsPiled - fell.carried) < 1e-3, { logs: fell.stats.logs, piled: fell.logsPiled, carried: fell.carried });
  }
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
