// Places step 1 (docs/PLACES.md): a generated plan in the sandbox, its rooms,
// regions and graph printed; one room buried in sand, one flooded, a storm
// held over a third; the masks checked by readbacks (sand and water gained
// inside each room against outside it) and before/after shots. Writes the
// raster (room ids, region ids) as JSON for a map image.
//
//   node scripts/placestest.mjs [--url http://localhost:5181] [--plan voronoi] [--seed 1] [--out places]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'places');
const plan = opt('plan', 'voronoi');
const seed = opt('seed', '1');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
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
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4&plan=${plan}&planseed=${seed}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.places?.loaded, { timeout: 90000 });
  await wait(3000);
  const info = await page.evaluate(() => {
    const P = window.reclaimed.places;
    const rooms = P.list('room');
    const regions = P.list('region');
    const adj = rooms.map((r) => r.adjacent().length);
    const halls = rooms.filter((r) => r.tags.includes('hall')).length;
    const { w, h } = window.reclaimed.core.dims;
    // three rooms near the middle, a good size, not touching each other
    const mid = [w / 2, (h / 2) * 0.866];
    const pick = [];
    for (const r of rooms.filter((r) => r.cells > 150).sort((a, b) => Math.hypot(a.centre[0] - mid[0], a.centre[1] - mid[1]) - Math.hypot(b.centre[0] - mid[0], b.centre[1] - mid[1]))) {
      if (pick.some((p) => p.adjacent().some((e) => e.room === r.id))) continue;
      pick.push(r);
      if (pick.length === 3) break;
    }
    const m = P.map;
    return {
      rooms: rooms.length,
      halls,
      regions: regions.map((g) => `${g.name}:${g.children.length}`).join(' '),
      roomCells: [Math.min(...rooms.map((r) => r.cells)), Math.round(rooms.reduce((a, r) => a + r.cells, 0) / rooms.length), Math.max(...rooms.map((r) => r.cells))],
      adjacency: [Math.min(...adj), +(adj.reduce((a, b) => a + b, 0) / adj.length).toFixed(1), Math.max(...adj)],
      regionAdj: regions.map((g) => g.adjacent().length),
      suggested: P.suggested().length,
      pick: pick.map((p) => ({ id: p.id, name: p.name, cells: p.cells, centre: p.centre.map((v) => +v.toFixed(1)), radius: +p.radius.toFixed(1) })),
      atCentre: pick.map((p) => P.at(p.centre[0], p.centre[1])?.id),
      w,
      h,
      raster: Array.from(m.cols, (v) => v & 0xffff),
      region: Array.from(m.cols, (v) => (v & 0xffff ? m.place(v & 0xffff).parent : 0)),
    };
  });
  const { raster, region, ...rest } = info;
  console.log(JSON.stringify(rest, null, 1));
  fs.writeFileSync(`${out}-raster.json`, JSON.stringify({ w: info.w, h: info.h, raster, region, pick: info.pick }));
  const [A, B, C] = info.pick;
  // per room: sand (cells of it in the layers) and water, summed inside and outside
  const measure = () =>
    page.evaluate(async (ids) => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const { MAT } = await import('/src/world/materials.ts');
      const { w, h } = R.core.dims;
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      const water = new Float32Array((await R.core.readBuffer('water')).buffer);
      const cols = R.places.map.cols;
      const t = Object.fromEntries([...ids.map((i) => [i, { sand: 0, water: 0, n: 0 }]), ['out', { sand: 0, water: 0, n: 0 }]]);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const r = cols[i] & 0xffff;
          const k = ids.includes(r) ? r : 'out';
          let sand = 0;
          for (const iv of readColumn(R.core.packed, slots, x, y)) if (iv.mat === MAT.Sand) sand += iv.z1 - iv.z0;
          t[k].sand += sand;
          t[k].water += water[i];
          t[k].n++;
        }
      return t;
    }, info.pick.map((p) => p.id));
  const frame = async (name) => {
    await page.evaluate(() => {
      const R = window.reclaimed;
      const { w, h } = R.core.dims;
      R.camera.target[0] = w / 2;
      R.camera.target[1] = (h / 2) * 0.866;
    });
    await page.screenshot({ path: `${out}-${name}.png` });
  };
  const before = await measure();
  await frame('0-before');
  await page.evaluate((a, b, c) => {
    const P = window.reclaimed.places;
    P.get(a).bury('sand', 2, { noise: 0.5 });
    P.get(b).flood(1.5);
    P.get(c).storm({ intensity: 1, duration: 40 });
  }, A.id, B.id, C.id);
  await wait(1500);
  const after = await measure();
  const d = (k, f) => +((after[k][f] - before[k][f]) / after[k].n).toFixed(3);
  console.log(`bury ${A.name} (2 cells of sand, noise 0.5): sand per column inside +${d(A.id, 'sand')}, in ${B.name} +${d(B.id, 'sand')}, outside +${d('out', 'sand')}`);
  console.log(`flood ${B.name} (1.5 cells): water per column inside +${d(B.id, 'water')}, in ${A.name} +${d(A.id, 'water')}, outside +${d('out', 'water')}`);
  await frame('1-after');
  await wait(12000);
  const storm = await page.evaluate((c) => window.reclaimed.weather.storms.map((s) => ({ x: +s.x.toFixed(1), y: +s.y.toFixed(1), r: +s.radius.toFixed(1), i: +s.intensity.toFixed(2), held: !!s.hold, to: c.centre })), C);
  console.log(`storm over ${C.name} after 12 s:`, JSON.stringify(storm));
  const later = await measure();
  console.log(`12 s on: water per column in ${B.name} ${(later[B.id].water / later[B.id].n).toFixed(3)}, outside ${(later.out.water / later.out.n).toFixed(3)} (was ${(before.out.water / before.out.n).toFixed(3)}); sand in ${A.name} ${(later[A.id].sand / later[A.id].n).toFixed(3)} (was ${(before[A.id].sand / before[A.id].n).toFixed(3)})`);
  await frame('2-storm');
  await page.evaluate((b) => window.reclaimed.places.get(b).drain(), B.id);
  await wait(800);
  const drained = await measure();
  console.log(`drain ${B.name}: water per column ${(drained[B.id].water / drained[B.id].n).toFixed(3)}`);
} finally {
  await browser.close();
}
if (failed) process.exit(1);
