// Round 117 (flora): the flora track's look check in the real atlas — find the densest wood near the start, centre the
// camera on it at a zoom, screenshot, and a GIF of the wind in it; with and without the flora library (?flora=0).
//   node scripts/florashot.mjs [--server http://localhost:5347] [--variants "1,0"] [--zooms "14,5"] [--season 0]
//        [--gust 1] [--gif 1] [--size 412x915] [--out C:/Projects/shots88/flora] [--tag base] [--extra "&q=low"]
// Every system in play, 1x speed (rules.txt): only the camera is moved, and an optional gust pushed as the
// player's click would.
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'florashot', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = opt('out', 'C:/Projects/shots88/flora');
  const tag = opt('tag', 'r117');
  const extra = opt('extra', '&q=low');
  const zooms = opt('zooms', '14,5').split(',').map(Number);
  const variants = opt('variants', '1,0').split(',');
  const season = opt('season', null);
  const gif = opt('gif', '1') === '1';
  const gust = opt('gust', '1') === '1';
  fs.mkdirSync(out, { recursive: true });
  let spot = null;
  // --find birch: first look over the atlas (its raw ground, 64² tiles on a grid round the spawn) for the tile with the
  // most woodland in a birch wood (birchWood: vegplan.wgsl's, ported below), and start there (?at=)
  let at = opt('at', null);
  if (opt('find', null) === 'birch' && !at) {
    const page = await R.page();
    await page.goto(`${R.url}/?skipmenu=1&level=atlas&tutorial=0${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    const tiles = await page.evaluate(async () => {
      const a = window.reclaimed.atlas;
      const [sx, sy] = a.spawn();
      const out = [];
      for (let j = -6; j <= 6; j++)
        for (let i = -6; i <= 6; i++) {
          const x0 = Math.round((sx + i * 160) / 64) * 64;
          const y0 = Math.round((sy + j * 160) / 128) * 128;
          if (x0 < 0 || y0 < 0) continue;
          const g = await a.rawGround(x0, y0, 64, 64);
          let wood = 0;
          for (let k = 0; k < g.veg.length; k++) if (g.veg[k] >= 3.8 && g.water[k] <= 0) wood++;
          out.push({ x0, y0, wood, d: Math.hypot(x0 + 32 - sx, y0 + 32 - sy) });
        }
      return out;
    });
    await page.close();
    for (const t of tiles) {
      let b = 0;
      for (let y = 0; y < 64; y += 4) for (let x = 0; x < 64; x += 4) b += birchWood(t.x0 + x, t.y0 + y);
      t.birch = b / 256;
      t.score = t.wood * (0.2 + t.birch);
    }
    tiles.sort((a, b) => b.score - a.score);
    R.log(`atlas woods: ${JSON.stringify(tiles.slice(0, 4))}`);
    at = `${tiles[0].x0 + 32},${tiles[0].y0 + 32}`;
  }
  for (const v of variants) {
    const page = await R.page();
    const url = `${R.url}/?skipmenu=1&level=atlas&tutorial=0&flora=${v}${extra}${at ? `&at=${at}` : ''}`;
    R.log(`flora=${v}: ${url}`);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await sleep(30000);
    // the densest wood within ~200 cells of the start (the same spot for every variant)
    if (!spot) {
      spot = await page.evaluate(async (want) => {
        // the succession field (window order, y * w + x): 16² blocks scored by their woodland (veg ≥ 3.6), nearer the
        // start preferred; a block is centred on (cx + 0.5, cy · ROW_H) as the level centres the camera
        const r = window.reclaimed;
        const v = await r.core.readBuffer('veg');
        const { w, h } = r.core.dims;
        const ROW_H = Math.sqrt(3) / 2;
        const [tx, ty] = r.camera.target;
        const B = 16;
        const cands = [];
        for (let by = 2; by < h / B - 2; by++)
          for (let bx = 2; bx < w / B - 2; bx++) {
            let n = 0;
            for (let y = by * B; y < by * B + B; y++) for (let x = bx * B; x < bx * B + B; x++) if (v[y * w + x] >= want) n++;
            const cx = bx * B + B / 2;
            const cy = by * B + B / 2;
            const d = Math.hypot(cx - tx, cy * ROW_H - ty);
            cands.push({ x: cx + 0.5, y: cy * ROW_H, n, d: Math.round(d), score: n - d * 0.15 });
          }
        cands.sort((a, b) => b.score - a.score);
        // of the woodiest, the one with most birches (the flora contract's placement: the GPU's own plan)
        const fl = r.flora?.();
        let best = cands[0];
        if (fl) {
          await fl.refresh();
          for (let tries = 0; tries < 20 && !fl.placement.plantsIn({ x0: best.x - 8, y0: best.y - 8, x1: best.x + 8, y1: best.y + 8 }).length; tries++) await new Promise((res) => setTimeout(res, 500));
          let most = -1;
          for (const c of cands.filter((c) => c.n >= 12).slice(0, 400)) {
            const ps = fl.placement.plantsIn({ x0: c.x - 8, y0: c.y - 7, x1: c.x + 8, y1: c.y + 7 });
            const b = ps.filter((p) => p.species === 'birch').length;
            c.birch = b;
            c.trees = ps.length;
            if (b - c.d * 0.01 > most) (most = b - c.d * 0.01), (best = c);
          }
        }
        return best;
      }, Number(opt('wood', '3.6')));
      R.log(`wood: ${JSON.stringify(spot)}`);
    }
    for (const z of zooms) {
      await page.evaluate(
        ({ s, z, season }) => {
          const r = window.reclaimed;
          r.camera.target = [s.x, s.y, r.camera.target[2]];
          r.camera.zoom = z;
          if (season !== null) r.globals.season = Number(season);
        },
        { s: spot, z, season },
      );
      await sleep(12000);
      await R.fatal(page);
      const name = `${out}/${tag}-flora${v}-z${z}`;
      await page.screenshot({ path: `${name}.png` });
      R.log(`saved ${name}.png`);
      const stats = await page.evaluate(async () => {
        const r = window.reclaimed;
        const mi = r.renderer.meshInst;
        if (!mi) return null;
        const c = await mi.counts(r.renderer.device, r.renderer.indirect);
        return Object.fromEntries(mi.kinds.map((k, i) => [k.name, c[i]]).filter(([, n]) => n > 0));
      }).catch((e) => String(e));
      R.log(`instances: ${JSON.stringify(stats)}`);
      if (gif && z === zooms[0]) {
        if (gust) {
          await page.evaluate((s) => {
            const r = window.reclaimed;
            // a gust as the player's drag makes it (globals.gusts, the wind field's impulse), across the wood for ~2.5 s
            let n = 0;
            const t = setInterval(() => {
              r.globals.gusts.push({ x: s.x - 6, y: s.y - 4, radius: 22, strength: 14, dx: 0.8, dy: 0.6, len: 16 });
              if (++n > 40) clearInterval(t);
            }, 60);
          }, spot);
        }
        const enc = GIFEncoder();
        for (let i = 0; i < 36; i++) {
          const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
          const pal = quantize(png.data, 256);
          enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 90 });
          await sleep(90);
        }
        enc.finish();
        fs.writeFileSync(`${name}.gif`, enc.bytes());
        R.log(`saved ${name}.gif`);
      }
    }
    await page.close();
  }
});

// vegplan.wgsl floraCorner / birchWood (api/plants.ts's port, for the finder only), on world cells (origin 0)
function pcg(v) {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
function floraCorner(x, y) {
  return (pcg(((x >>> 0) ^ pcg(((y >>> 0) ^ 0x51a7b1) >>> 0)) >>> 0) >>> 8) / 16777216;
}
function birchWood(cx, cy) {
  const px = cx / 72;
  const py = cy / 72;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const ux = (px - ix) ** 2 * (3 - 2 * (px - ix));
  const uy = (py - iy) ** 2 * (3 - 2 * (py - iy));
  const a = floraCorner(ix, iy) + (floraCorner(ix + 1, iy) - floraCorner(ix, iy)) * ux;
  const b = floraCorner(ix, iy + 1) + (floraCorner(ix + 1, iy + 1) - floraCorner(ix, iy + 1)) * ux;
  const n = a + (b - a) * uy;
  const t = Math.min(1, Math.max(0, (n - 0.52) / 0.18));
  return t * t * (3 - 2 * t);
}
