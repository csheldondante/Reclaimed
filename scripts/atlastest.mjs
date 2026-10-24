// The atlas (round 67): the macro map is built on the GPU; its regions are
// connected, their borders' distance field matches a brute-force one; the
// viewer draws every mode; the atlas level streams its columns.
// Shots to <out>-*.png.
//
//   node scripts/atlastest.mjs [--url http://localhost:5203] [--out atlas] [--q "a.seed=3"] [--level 0|1]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const out = opt('out', 'atlas');
const extra = opt('q', '');
const doLevel = opt('level', '1') === '1';
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
const watch = (page) => {
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 1500));
    }
  });
};
try {
  const page = await browser.newPage();
  watch(page);
  const t0 = Date.now();
  await page.goto(`${url}/?atlas=view&q=high${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const built = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    return { timings: a.timings, stats: a.stats, regions: a.defs.length };
  });
  console.log(JSON.stringify(built), `page to atlas ${Date.now() - t0} ms`);
  check('the atlas is built: continents, regions of many kinds', built.stats.regions > 100 && Object.keys(built.stats.kinds).length >= 6, { regions: built.stats.regions, kinds: built.stats.kinds });

  // every region is one connected piece (4-neighbours, wrapped)
  const conn = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    const n = a.p.n;
    const reg = a.regionOf;
    const seen = new Uint8Array(n * n);
    const area = new Uint32Array(a.defs.length);
    for (let i = 0; i < n * n; i++) area[reg[i]]++;
    let bad = 0;
    let pieces = 0;
    const firstSeen = new Uint8Array(a.defs.length);
    const stack = new Int32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      if (seen[i]) continue;
      const r = reg[i];
      pieces++;
      if (firstSeen[r]) bad++;
      firstSeen[r] = 1;
      let sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      while (sp) {
        const j = stack[--sp];
        const x = j % n;
        const y = (j - x) / n;
        for (const k of [y * n + ((x + 1) % n), y * n + ((x + n - 1) % n), ((y + 1) % n) * n + x, ((y + n - 1) % n) * n + x]) {
          if (!seen[k] && reg[k] === r) {
            seen[k] = 1;
            stack[sp++] = k;
          }
        }
      }
    }
    return { regions: a.defs.length, pieces, split: bad };
  });
  check('every region is one connected piece (the GPU flood fill)', conn.split === 0 && conn.pieces === conn.regions, conn);

  // the borders' distance field against brute force at random texels
  const jfa = await page.evaluate(async () => {
    const a = window.reclaimed.atlas;
    const n = a.p.n;
    const reg = a.regionOf;
    const dist = new Float32Array(await a.read(a.dist));
    const tw = 0.5 * (a.worldW + a.worldH) / n;
    let worst = 0;
    let sum = 0;
    const K = 300;
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let k = 0; k < K; k++) {
      const x = Math.floor(rnd() * n);
      const y = Math.floor(rnd() * n);
      const r = reg[y * n + x];
      // brute force: the nearest texel of another region; the border is half a texel short of it
      let best = 1e9;
      for (let R = 1; R < 400 && best > (R - 1) * tw; R++)
        for (let dy = -R; dy <= R; dy++)
          for (let dx = -R; dx <= R; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== R) continue;
            const j = (((y + dy) % n + n) % n) * n + (((x + dx) % n + n) % n);
            if (reg[j] !== r) best = Math.min(best, Math.hypot(dx * a.worldW / n, dy * a.worldH / n));
          }
      const truth = best - 0.5 * tw;
      const got = dist[(y * n + x) * 4];
      const e = Math.abs(got - truth);
      worst = Math.max(worst, e);
      sum += e;
    }
    return { worstTexels: +(worst / tw).toFixed(2), meanTexels: +(sum / K / tw).toFixed(3) };
  });
  check('the borders\' distance field (JFA) matches brute force within a texel', jfa.worstTexels <= 1.01, jfa);

  // every mode, the whole world and closer in
  const modes = ['ground', 'regions', 'kinds', 'borders', 'coast', 'climate', 'pattern', 'caves'];
  for (let m = 0; m < modes.length; m++) {
    await page.evaluate((m) => (window.reclaimed.view.mode = m), m);
    await wait(400);
    await page.screenshot({ path: `${out}-world-${modes[m]}.png` });
  }
  // closer: a spot where three or more kinds meet, at a few zooms
  const spot = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    const [cx, cy] = a.spawn();
    return { cell: [cx, cy], world: [cx + 0.5, (cy + 0.5) * 0.8660254], kind: a.regionAt(cx + 0.5, (cy + 0.5) * 0.8660254).kind };
  });
  console.log('spawn', JSON.stringify(spot));
  for (const [z, name] of [[8, 'region'], [1.5, 'local'], [0.3, 'cells']]) {
    for (const m of [0, 2]) {
      await page.evaluate(
        (w, z, m) => {
          const v = window.reclaimed.view;
          v.vc = [w[0], w[1]];
          v.scale = z;
          v.mode = m;
        },
        spot.world,
        z,
        m,
      );
      await wait(500);
      await page.screenshot({ path: `${out}-${name}-${modes[m]}.png` });
    }
  }
  // a few kinds close up, each where it is largest
  const kinds = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    const n = a.p.n;
    const best = {};
    a.defs.forEach((d, i) => {
      if (!best[d.kind] || d.stat.area > a.defs[best[d.kind]].stat.area) best[d.kind] = i;
    });
    return Object.entries(best).map(([k, i]) => {
      const d = a.defs[i];
      return [k, d.stat.cx * a.worldW, d.stat.cy * a.worldH];
    });
  });
  for (const [k, x, y] of kinds) {
    await page.evaluate(
      (x, y) => {
        const v = window.reclaimed.view;
        v.vc = [x, y];
        v.scale = 1.2;
        v.mode = 0;
      },
      x,
      y,
    );
    await wait(400);
    await page.screenshot({ path: `${out}-kind-${k}.png` });
  }
  // columns: a batch, timed
  const cols = await page.evaluate(async (c) => {
    const a = window.reclaimed.atlas;
    const t0 = performance.now();
    const r = await a.columns(c[0] - 32, c[1] - 32, 64, 64);
    const ms = performance.now() - t0;
    // (columns with air between two runs: caves, tunnels, overhangs, arches)
    let layered = 0;
    let lo = 1e9;
    let hi = -1e9;
    for (let i = 0; i < 64 * 64; i++) {
      const o = i * 16;
      lo = Math.min(lo, r.f[o]);
      hi = Math.max(hi, r.f[o]);
      for (let k = 1; k < r.u[o + 9]; k++) if (r.run(i, k).z0 > r.run(i, k - 1).z1 + 0.01) {
        layered++;
        break;
      }
    }
    const t1 = performance.now();
    await a.columns(0, 0, 256, 256);
    return { ms: +ms.toFixed(1), window256ms: +(performance.now() - t1).toFixed(1), lo: +lo.toFixed(1), hi: +hi.toFixed(1), layered, forms: r.forms };
  }, spot.cell);
  check('a region of columns from the atlas', cols.hi > cols.lo && cols.ms < 500, cols);
  await page.close();

  if (doLevel) {
    const lv = await browser.newPage();
    watch(lv);
    await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.4&q=high${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
    await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await wait(4000);
    await lv.screenshot({ path: `${out}-level-0.png` });
    const st = await lv.evaluate(async () => {
      const R = window.reclaimed;
      const S = R.stream;
      S.auto = false;
      const o0 = [...S.origin];
      const ms = [];
      // (the third ready before it's asked for: the camera halfway to the edge asks ahead)
      for (let k = 0; k < 3; k++) {
        if (k === 2) {
          S.prefetch(64, 0);
          await new Promise((r) => setTimeout(r, 800));
        }
        const t0 = performance.now();
        await S.slide(64, 0);
        ms.push(+(performance.now() - t0).toFixed(1));
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, 2000));
      const T = R.api.terrain;
      await T.refresh();
      // the seam where the newest strip meets the one before (local x 191 | 192): the step there,
      // against the step the atlas's own ground has at those cells (a cliff of the land is not a seam)
      const { cellPos } = await import('/src/world/lattice.ts');
      const ref = await R.atlas.columns(S.origin[0] + 191, S.origin[1], 2, 256);
      let worst = 0;
      for (let y = 8; y < 248; y += 4) {
        const b = T.heightAt(...cellPos(191, y));
        const c = T.heightAt(...cellPos(192, y));
        const rb = ref.f[(y * 2) * 16];
        const rc = ref.f[(y * 2 + 1) * 16];
        worst = Math.max(worst, Math.abs(Math.abs(c - b) - Math.abs(rc - rb)));
      }
      return { from: o0, origin: [...S.origin], ms, stats: { ...S.stats }, seamWorst: +worst.toFixed(2), ticks: R.globals.tick };
    });
    console.log(JSON.stringify(st));
    check('the atlas level streams: three slides east, new columns from the atlas, no seam', st.origin[0] === st.from[0] + 192 && st.stats.generated === 12 && st.seamWorst < 3, st);
    await lv.screenshot({ path: `${out}-level-1.png` });
    await lv.evaluate(() => {
      const c = window.reclaimed.camera;
      c.zoom = 1.6;
    });
    await wait(2000);
    await lv.screenshot({ path: `${out}-level-wide.png` });
  }
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
