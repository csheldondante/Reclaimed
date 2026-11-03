// Round 125 (forest): stills and GIFs of a wood on the atlas, every system in play at 1x (rules.txt): only the camera
// is moved (and the season set, for the reference's autumn).
//   node scripts/forestshot.mjs [--at 13728,4768] [--zooms "7,14,30,44"] [--season 0.5] [--tag base]
//        [--out C:/Projects/shots88/forest] [--extra "&flora=1"] [--settle 30000] [--size 412x915]
//   --lab   the forest station (?play=lich&forest=lab): parked under the canopy (each treatment on and off, the
//           look held out at the same spot), then a GIF of the ride in and out (--frames 60 --every 150)
//   --look  with --lab: the overworld stills first (no hero) at --zooms over the station's stand
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

async function gif(page, file, frames, every) {
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    await sleep(every);
  }
  enc.finish();
  fs.writeFileSync(file, enc.bytes());
}

await run({ name: 'forestshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/forest');
  const tag = R.opt('tag', 'base');
  const zooms = R.opt('zooms', '7,14,30,44').split(',').map(Number);
  const season = R.opt('season', '0.5');
  const settle = Number(R.opt('settle', '30000'));
  const extra = Object.fromEntries(new URLSearchParams(R.opt('extra', '')));
  fs.mkdirSync(out, { recursive: true });
  // --find elder: the atlas's raw ground (64² tiles round the spawn) scored by woods (succession ≥ 3.9, dry) in an elder
  // wood's heart (spacing.ts elderWood, ported below), and start there
  let at = R.opt('at', '13728,4768');
  if (R.opt('find', null) === 'elder') {
    const v = await R.page();
    await v.goto(`${R.url}/?skipmenu=1&level=atlas&tutorial=0&q=low`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(v);
    const cands = [];
    const sp = await v.evaluate(() => window.reclaimed.atlas.spawn());
    for (let j = -14; j <= 14; j++)
      for (let i = -14; i <= 14; i++) {
        const x0 = Math.round((sp[0] + i * 120) / 64) * 64;
        const y0 = Math.round((sp[1] + j * 120) / 64) * 64;
        if (x0 < 0 || y0 < 0) continue;
        let e = 0;
        for (let y = 0; y < 64; y += 8) for (let x = 0; x < 64; x += 8) e += elderWood(x0 + x, y0 + y);
        if (e / 64 > 0.8) cands.push({ x0, y0, e: e / 64, d: Math.hypot(x0 - sp[0], y0 - sp[1]) });
      }
    cands.sort((a, b) => a.d - b.d);
    const scored = await v.evaluate(async (cs) => {
      const a = window.reclaimed.atlas;
      const out = [];
      for (const c of cs.slice(0, 40)) {
        const g = await a.rawGround(c.x0, c.y0, 64, 64);
        let wood = 0;
        for (let k = 0; k < g.veg.length; k++) if (g.veg[k] >= 3.6 && g.water[k] <= 0) wood++;
        out.push({ ...c, wood });
      }
      return out;
    }, cands);
    await v.close();
    scored.sort((a, b) => b.wood - a.wood);
    R.log(`elder woods: ${JSON.stringify(scored.slice(0, 4))}`);
    if (!scored.length || scored[0].wood < 100) throw new Error('no wooded elder wood near the spawn');
    at = `${scored[0].x0 + 32},${scored[0].y0 + 32}`;
    R.log(`at ${at}`);
  }
  const shot = async (p, name) => {
    await R.fatal(p);
    const f = `${out}/${tag}-${name}.png`;
    await p.screenshot({ path: f });
    R.log(`saved ${f}`);
  };
  // --wind "sway,1A1C": per wind mode (a reload each), the station held out at the overworld's zoom, a gust run across the
  // stand, a GIF of the canopy in it (the foliage matrix's matched-time clips)
  if (R.opt('wind', null)) {
    for (const m of R.opt('wind').split(',')) {
      const p = await R.level({ level: 'atlas', at, play: 'lich', forest: 'lab', fseason: season, fwind: m, fride: '0', fhold: 'out', ...extra });
      await p.waitForFunction(() => window.reclaimed?.forest?.stand, { timeout: 120000, polling: 500 });
      await p.evaluate(() => {
        const r = window.reclaimed;
        r.play.session.hero.place(r.forest.stand.park ?? r.forest.stand.at);
      });
      await sleep(settle);
      await p.evaluate(() => window.reclaimed.forest.gust());
      await sleep(400);
      const g = `${out}/${tag}-wind-${m}.gif`;
      await gif(p, g, Number(R.opt('frames', '30')), Number(R.opt('every', '120')));
      R.log(`saved ${g}`);
      await p.close();
    }
    return;
  }
  if (!R.flag('lab')) {
    const p = await R.level({ level: 'atlas', at, ...extra });
    await p.evaluate((s) => (window.reclaimed.globals.season = Number(s)), season);
    await sleep(settle);
    for (const z of zooms) {
      await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
      await sleep(4000);
      await shot(p, `z${z}`);
    }
    return;
  }
  const p = await R.level({ level: 'atlas', at, play: 'lich', forest: 'lab', fseason: season, ...extra });
  await p.waitForFunction(() => window.reclaimed?.forest?.stand, { timeout: 120000, polling: 500 });
  const stand = await p.evaluate(() => window.reclaimed.forest.stand);
  R.log(`stand: ${JSON.stringify(stand)}`);
  await sleep(settle);
  // parked in the stand's middle
  // (the stand as it is now: the window may have slid since, and the lab keeps it in window coordinates)
  await p.evaluate(() => {
    const r = window.reclaimed;
    r.forest.ride = false;
    r.play.session.hero.place(r.forest.stand.park ?? r.forest.stand.at);
  });
  await sleep(8000);
  const T = ['canopy', 'dither', 'dapple', 'rays', 'mist', 'leaves'];
  const set = (on, force) =>
    p.evaluate(
      ({ on, force, T }) => {
        const d = window.reclaimed.forest;
        const drv = d.d.driver;
        for (const k of T) drv.treatments[k] = on.includes(k) ? 1 : 0;
        drv.force = force;
      },
      { on, force, T },
    );
  await set(T, 1);
  await sleep(5000);
  await shot(p, 'under-all');
  for (const k of T) {
    await set(T.filter((x) => x !== k), 1);
    await sleep(2500);
    await shot(p, `under-no-${k}`);
  }
  await set(T, 0);
  await sleep(5000);
  await shot(p, 'under-off');
  // the ride in and out
  await set(T, null);
  await p.evaluate(() => {
    const f = window.reclaimed.forest;
    f.ride = true;
    window.reclaimed.play.session.hero.place(f.rider.start(0));
  });
  await sleep(3000);
  const frames = Number(R.opt('frames', '60'));
  const every = Number(R.opt('every', '150'));
  const g = `${out}/${tag}-ride.gif`;
  await gif(p, g, frames, every);
  R.log(`saved ${g}`);
});

// flora/spacing.ts elderWood (the finder's port, world columns)
function pcg(v) {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
function corner(x, y) {
  return (pcg(((x >>> 0) ^ pcg(((y >>> 0) ^ 0xe1de4) >>> 0)) >>> 0) >>> 8) / 16777216;
}
function elderWood(wx, wy) {
  const px = wx / 96;
  const py = wy / 96;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const ux = (px - ix) ** 2 * (3 - 2 * (px - ix));
  const uy = (py - iy) ** 2 * (3 - 2 * (py - iy));
  const a = corner(ix, iy) + (corner(ix + 1, iy) - corner(ix, iy)) * ux;
  const b = corner(ix, iy + 1) + (corner(ix + 1, iy + 1) - corner(ix, iy + 1)) * ux;
  const n = a + (b - a) * uy;
  const t = Math.min(1, Math.max(0, (n - 0.6) / 0.14));
  return t * t * (3 - 2 * t);
}
