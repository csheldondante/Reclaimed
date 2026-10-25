// Round 79: a coast — a beach and a sea cliff in a temperate place (the atlas's coast field: the land's edge),
// shot in the viewer and walked into (the iso view and the fly camera over the water looking at the shore).
//   node scripts/coastshot.mjs [--url http://localhost:5207] [--out coast] [--pick 0]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'coast');
const pick = Number(opt('pick', 0));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  // (port sites sit on coasts)
  const s = await page.evaluate((pick) => {
    const a = window.reclaimed.atlas;
    const warm = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
    // the sites by the deepest water within 150 of them (by the macro heights), the pick-th; walked in at
    // the point halfway to that water
    const ranked = a.settlement.sites
      .filter((s) => warm(s.y) > 0.55)
      .map((p) => {
        let deep = { z: 1e9, x: 0, y: 0 };
        for (let r = 20; r <= 150; r += 10)
          for (let t = 0; t < 6.28; t += 0.2) {
            const x = p.x + Math.cos(t) * r;
            const y = p.y + Math.sin(t) * r;
            const z = a.macroAt(x, y);
            if (z < deep.z) deep = { z, x, y };
          }
        return { p, deep };
      })
      .sort((u, v) => u.deep.z - v.deep.z);
    const { p, deep } = ranked[pick % ranked.length];
    const x = (p.x + deep.x) / 2;
    const y = (p.y + deep.y) / 2;
    return { x, y, at: [Math.floor(x), Math.floor(y / 0.866)], sea: a.p.sea, deepWithin150: +deep.z.toFixed(1), siteH: +p.h.toFixed(1) };
  }, pick);
  console.log(JSON.stringify(s));
  const lv = await browser.newPage();
  lv.on('pageerror', (e) => console.log('pageerror', e.message));
  await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${s.at.join(',')}${opt('extra', '')}`, { waitUntil: 'load' });
  await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 7000));
  const info = await lv.evaluate(async () => {
    document.getElementById('ui').style.visibility = 'hidden';
    const R = window.reclaimed;
    R.stream.auto = false;
    R.camera.zoom = 2.2;
    await new Promise((r) => setTimeout(r, 2500));
    // the water's depth in the window
    const S = R.map.surface;
    let deepest = 0;
    let wet = 0;
    const sea = R.globals ? null : null;
    return { oz: R.stream.oz, surfMin: Math.min(...S), surfMax: Math.max(...S) };
  });
  console.log(JSON.stringify(info));
  await lv.screenshot({ path: `${out}-iso.png` });
} finally {
  await browser.close();
}
