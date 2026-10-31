// Round 120 (the user: "rock towers fell then slid along flat ground quite far"): how far each rigid rock moves
// sideways after it first touches the ground, per variant — the playground's rock station, its towers cut.
//   node scripts/rockslide.mjs --url http://localhost:5211 --solver nodes --station rock --press "1:nick the legs;6:cut the towers" --secs 16
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5211');
const variant = opt('solver', 'nodes');
const level = opt('level', 'playground');
const station = opt('station', 'rock');
const press = opt('press', '1:cut the towers')
  .split(';')
  .map((s) => [Number(s.slice(0, s.indexOf(':'))), s.slice(s.indexOf(':') + 1)]);
const secs = Number(opt('secs', 14));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log(`FAIL pageerror ${e.message}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&q=low&solver=${variant}${opt('params', '') ? '&' + opt('params') : ''}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.bugReport, { timeout: 240000 });
  await sleep(25000);
  const at = await p.evaluate((id) => window.reclaimed.scene.level.stations.findIndex((s) => s.id === id), station);
  await p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), at);
  await sleep(3000);
  await p.evaluate(() => {
    const ig = window.reclaimed.scene.integrity;
    const log = (window.__slide = {});
    const tick = () => {
      for (const b of ig.rigid.list) {
        const e = (log[b.id] ??= { cells: b.cells.length, gen: b.gen, start: [...b.pos], touch: null, most: 0, last: null });
        if (b.contact && !e.touch) e.touch = [...b.pos];
        if (e.touch) e.most = Math.max(e.most, Math.hypot(b.pos[0] - e.touch[0], b.pos[1] - e.touch[1]));
        e.last = [...b.pos];
        e.v = [...b.v];
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let s = 0; s < secs; s++) {
    for (const [t, label] of press)
      if (t === s)
        await p.evaluate((label) => {
          const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
          if (!b) throw new Error(`no button ${label}`);
          b.click();
        }, label);
    await sleep(1000);
  }
  const log = await p.evaluate(() => window.__slide);
  for (const [id, e] of Object.entries(log)) {
    const f = (v) => (v ? v.map((q) => q.toFixed(1)).join(',') : '-');
    const fall = e.touch ? Math.hypot(e.touch[0] - e.start[0], e.touch[1] - e.start[1]) : 0;
    console.log(`body ${id} (${e.cells} cells, gen ${e.gen}): start ${f(e.start)} touch ${f(e.touch)} last ${f(e.last)} — before touching ${fall.toFixed(1)}, after ${e.most.toFixed(1)} sideways; v ${f(e.v)}`);
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
