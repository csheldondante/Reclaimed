// Round 83: rock that hangs free falls (fracture.ts analyseRock) — on the atlas level, a stone spire built
// (the world API: terrain.build), then (a) cut through partway up (a crater at its middle: the top an island,
// a body), (b) another undercut at its foot from one side (a neck: it snaps and topples). Shots before,
// during, after; the integrity system's counts logged.
//   node scripts/rockshot.mjs [--url http://localhost:5207] [--out C:/Projects/shots78/rock]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots78/rock');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=high&level=atlas`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(12000);
  const stats = () => p.evaluate(() => JSON.stringify(window.reclaimed.integrity?.()?.stats ?? null));
  for (const [name, side] of [['cut', 0], ['neck', 1]]) {
    const at = await p.evaluate(async (side) => {
      const R = window.reclaimed;
      R.stream.auto = false;
      const t = R.api.terrain;
      await t.refresh();
      const [cx, cy] = R.camera.target;
      const x = cx + (side ? 14 : -14);
      const y = cy;
      const z = t.heightAt(x, y);
      // the spire: stone built up a cell at a time (a narrow column, 3 across)
      for (let k = 0; k < 30; k++) t.build(x, y, 'stone', { radius: 1.6, layers: 1 });
      R.camera.target = [x, y, z + 10];
      R.camera.zoom = 9;
      return { x, y, z };
    }, side);
    await sleep(6000);
    await p.screenshot({ path: `${out}-${name}-0.png` });
    await p.evaluate(
      async (a, side) => {
        const t = window.reclaimed.api.terrain;
        await t.refresh();
        const top = t.heightAt(a.x, a.y);
        // cut: a bowl through its middle; neck: a bowl at its foot from one side
        if (side === 0) t.crater(a.x, a.y, { radius: 1.6, z: a.z + (top - a.z) * 0.45 });
        else t.crater(a.x + 2.2, a.y, { radius: 1.8, z: a.z + 2 });
      },
      at,
      side,
    );
    for (const ms of [600, 1500, 4000]) {
      await sleep(ms === 600 ? 600 : ms - 600);
      await p.screenshot({ path: `${out}-${name}-${ms}.png` });
    }
    console.log(name, await stats());
    console.log(name, 'bodies', await p.evaluate(() => JSON.stringify((window.reclaimed.integrity?.()?.bodies.list ?? []).map((b) => [b.local.length, Math.round(b.pos[2])]).slice(0, 40))));
  }
  // frame times with the bodies about (resting): the integrity system's readbacks
  const ft = await p.evaluate(
    () =>
      new Promise((done) => {
        const t = [];
        let last = performance.now();
        const end = last + 15000;
        const f = (now) => {
          t.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(f);
          else done(t);
        };
        requestAnimationFrame(f);
      }),
  );
  const s = [...ft].sort((a, b) => a - b);
  const q = (k) => +s[Math.floor(k * (s.length - 1))].toFixed(1);
  console.log('after', JSON.stringify({ frames: ft.length, p50: q(0.5), p95: q(0.95), worst: q(1), over50: ft.filter((x) => x > 50).length }), await stats());
} finally {
  await browser.close();
}
