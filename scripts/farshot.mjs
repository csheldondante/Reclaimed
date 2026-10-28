// Round 94 (farbake): a town seen from 1x, 2x, 4x a distance past it, straight and turned — the camera put that far
// from the town on the eye's side (so the town stands that far up the view), the view turned by setting the camera's
// azimuth; a shot each, and the bake's and the far plans' numbers. --list prints the settlements near --at.
//   node scripts/farshot.mjs [--url http://localhost:5273] [--town s12 | --town x,y (world units)] [--dists 250,500,1000]
//     [--turns 0,105] [--tag after] [--extra "&fb=0"] [--wait 40000] [--out C:/Projects/shots88/farbake] [--zoom 2.6 | --zoomk 400]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5273');
const town = opt('town', '');
const dists = opt('dists', '250,500,1000').split(',').map(Number);
const turns = opt('turns', '0,105').split(',').map(Number);
const tag = opt('tag', 'after');
const extra = opt('extra', '');
const wait = Number(opt('wait', 40000));
const out = opt('out', 'C:/Projects/shots88/farbake');
const zoom = opt('zoom', '');
const zoomk = opt('zoomk', '');
const listAt = opt('list', '');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROW_H = Math.sqrt(3) / 2;
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 600000,
});
let bad = false;
const open = async (at) => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => (m.type() === 'error' || m.text().startsWith('[farbake]')) && console.log(m.type(), m.text()));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=${at}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  return p;
};
const stats = (p) =>
  p.evaluate(() => {
    const R = window.reclaimed;
    const b = R.far?.bake;
    const st = R.settlements;
    return {
      bake: b ? { ...b.stats, mb: +(b.bytes / 1048576).toFixed(2), texel: b.texel, N: b.N } : null,
      rings: R.far?.lod ? +(R.far.lod.bytes / 1048576).toFixed(2) : null,
      far: st?.farStats ? { ...st.farStats, match: st.farStats.match } : null,
      planned: st?.stats,
      world: [R.atlas.worldW, R.atlas.worldH],
    };
  });
try {
  if (listAt) {
    const p = await open(listAt);
    await sleep(wait);
    console.log(
      JSON.stringify(
        await p.evaluate((at) => {
          const R = window.reclaimed;
          const [x, y] = at.split(',').map(Number);
          return R.settlements.near([x, y * Math.sqrt(3) / 2], 3000).map((s) => ({ id: s.id, size: s.size, at: s.at.map(Math.round) }));
        }, listAt),
      ),
    );
    console.log(JSON.stringify(await stats(p)));
    await p.close();
  } else {
    let tx;
    let ty;
    if (town.includes(',')) [tx, ty] = town.split(',').map(Number);
    for (const d of dists)
      for (const t of turns) {
        // (the default view's azimuth π/4; the eye's side of the target is +(cos az, sin az))
        const az = Math.PI / 4 + (t * Math.PI) / 180;
        if (tx === undefined) {
          const p = await open('11956,15471');
          await sleep(5000);
          [tx, ty] = await p.evaluate((id) => window.reclaimed.settlements.settlement(id).at, town);
          await p.close();
        }
        const wx = tx + d * Math.cos(az);
        const wy = ty + d * Math.sin(az);
        const p = await open(`${Math.round(wx)},${Math.round(wy / ROW_H)}`);
        await p.evaluate((a) => (window.reclaimed.camera.azimuth = a), az);
        // (--zoom: fixed; --zoomk k: k / d, so the town stands as far up the screen at each distance)
        const z = zoomk ? Number(zoomk) / d : Number(zoom || 0);
        if (z) await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
        // (the editor's panel off the view)
        await p.evaluate(() => document.querySelectorAll('.editor').forEach((e) => (e.style.display = 'none')));
        await sleep(wait);
        const name = `${out}/${tag}-${town.replace(',', '_')}-d${d}-t${t}`;
        await p.screenshot({ path: `${name}.png` });
        console.log('shot', name, JSON.stringify(await stats(p)));
        await p.close();
      }
  }
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
