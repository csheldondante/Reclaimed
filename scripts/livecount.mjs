// Round 107 (`pages`, PG4/PG5): how many chunks are live (awake or drowsy) parked on the atlas level, sampled over a
// few seconds — to compare two builds' sleep (the culled passes' cost follows it).
//   node scripts/livecount.mjs --url http://localhost:5313 [--wait 40000] [--extra "&x=1"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5313');
const wait = Number(opt('wait', 40000));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=15024,14337&win=256${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, wait));
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const t = R.core.world.tiles;
    const out = [];
    for (let k = 0; k < 40; k++) {
      await new Promise((res) => setTimeout(res, 500));
      const m = R.core.globals.sleep;
      const d = R.core.globals.drowse;
      let asleep = 0;
      let drowsy = 0;
      if (m) for (let i = 0; i < m.length * 32; i++) {
        if ((m[i >> 5] >>> (i & 31)) & 1) asleep++;
        if (d && (d[i >> 5] >>> (i & 31)) & 1) drowsy++;
      }
      out.push({ live: t?.count(0), awake: R.core.sleep?.awake, asleep, drowsy, ring: [R.core.ring.x, R.core.ring.y], tick: R.core.sim.tick });
    }
    return out;
  });
  const aw = r.map((x) => x.awake);
  console.log(`awake mean ${(aw.reduce((a, b) => a + b, 0) / aw.length).toFixed(1)} min ${Math.min(...aw)} max ${Math.max(...aw)}; live mean ${(r.reduce((a, x) => a + x.live, 0) / r.length).toFixed(1)}; ring ${r[0].ring}`);
} finally {
  await browser.close();
}
