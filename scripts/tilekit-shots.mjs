// (tilekit) The tile kit lab's stills in one browser: each shot sets the lab up (theme, dials, view), captions it, and
// saves a PNG to local/tilekit1/; then a labelled strip of them all. Also the old grid generator's look at the same
// place (archlab.html, the grid style) for comparison, and the lab's numbers (stats, GPU frame time).
//   node scripts/tilekit-shots.mjs --server http://127.0.0.1:5471 [--only name,name] [--size 960x540]
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';

const OUT = 'local/tilekit1';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'tilekit-shots', kind: 'behaviour', size: '960x540', dpr: 1, echo: true }, async (R) => {
  const args = Object.fromEntries(R.argv.reduce((a, x, i, arr) => (x.startsWith('--') && a.push([x.slice(2), arr[i + 1]]), a), []));
  const only = args.only ? new Set(args.only.split(',')) : null;
  const page = await R.page();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const ready = async (url) => {
    await page.goto(`${R.url}${url}`, { waitUntil: 'load' });
    const ok = await page
      .waitForFunction(() => globalThis.tilekit || globalThis.archlab || document.querySelector('.fatal'), { timeout: 240000, polling: 250 })
      .then(() => true, () => false);
    const fat = await page.evaluate(() => document.querySelector('.fatal')?.textContent ?? null);
    if (!ok || fat) {
      console.log(logs.join('\n'));
      throw new Error(`page not ready: ${fat ?? 'timeout'}`);
    }
  };
  const shots = [];
  const snap = async (name, js, cap) => {
    if (only && !only.has(name)) return;
    await page.evaluate(js);
    if (cap !== undefined) await page.evaluate((c) => globalThis.tilekit?.caption(c), cap);
    await sleep(700);
    const f = `${OUT}/${name}.png`;
    await page.screenshot({ path: f });
    shots.push({ name, f });
    console.log(`saved ${f}`);
  };

  await ready('/tilekit.html');
  await page.evaluate(() => (document.getElementById('panel').style.display = 'none'));
  const st =await page.evaluate(() => tilekit.stats());
  console.log('stats', JSON.stringify(st));
  // the play zoom (40 m tall) and a close-up (14 m)
  const V = (yaw, zoom, pitch) => `tilekit.view(${yaw}, ${zoom}, ${pitch})`;
  const S = (o) => `tilekit.set(${JSON.stringify(o)})`;
  await snap('a_plaster_play', `tilekit.theme('plaster'); ${S({ sag: 0, ao: 1 })}; ${V(-60, 40, 50)}`, 'plaster · play zoom · sag 0 · SSAO on');
  await snap('b_plaster_close', `${V(-60, 14, 40)}`, 'plaster · close-up · sag 0 · SSAO on');
  await snap('c_plaster_close_noao', `${S({ ao: 0 })}`, 'plaster · close-up · SSAO off');
  await snap('d_plaster_play_noao', `${V(-60, 40, 50)}`, 'plaster · play zoom · SSAO off');
  await snap('e_plaster_sag', `${S({ ao: 1, sag: 0.6 })}; ${V(-60, 40, 50)}`, 'plaster · play zoom · sag 0.6 m');
  await snap('f_plaster_sag_close', `${V(-60, 14, 40)}`, 'plaster · close-up · sag 0.6 m');
  await snap('g_timber_play', `tilekit.theme('timber'); ${S({ sag: 0, ao: 1 })}; ${V(-60, 40, 50)}`, 'timber · play zoom · sag 0 · SSAO on');
  await snap('h_timber_close', `${V(-60, 14, 40)}`, 'timber · close-up · sag 0');
  await snap('i_timber_sag', `${S({ sag: 0.6 })}; ${V(-60, 40, 50)}`, 'timber · play zoom · sag 0.6 m');
  await snap('i2_timber_sag_close', `${V(-60, 14, 40)}`, 'timber · close-up · sag 0.6 m');
  await snap('j_timber_back', `${S({ sag: 0 })}; ${V(120, 30, 50)}`, 'timber · from behind (yaw 120)');
  await snap('k_plaster_back', `tilekit.theme('plaster'); ${V(120, 30, 50)}`, 'plaster · from behind (yaw 120)');
  await snap('l_ao_baked', `${S({ dbg: 2 })}; ${V(-60, 14, 40)}`, 'plaster · baked per-vertex occlusion alone');
  await page.evaluate(S({ dbg: 0 }));
  let bench = null;
  if (!only || only.has('bench')) {
    await page.evaluate(() => tilekit.caption(''));
    await page.evaluate(V(-60, 40, 50));
    bench = await page.evaluate(() => tilekit.bench(40));
    const bench2 = await page.evaluate(() => (tilekit.theme('timber'), tilekit.bench(40)));
    console.log('bench', JSON.stringify({ plaster: bench, timber: bench2 }));
    const st2 = await page.evaluate(() => tilekit.stats());
    console.log('stats timber', JSON.stringify(st2));
  }
  const anchor = await page.evaluate(() => tilekit.anchor);

  // the old generator's grid look at the same place (archlab, every lot the 'harbour' grid style)
  if (!only || only.has('m_old_grid')) {
    await ready(`/archlab.html?style=harbour&at=${anchor[0]},${anchor[1]}&yaw=-60&pitch=50&zoom=40`);
    await sleep(3000);
    await page.evaluate(() => {
      document.getElementById('panel').style.display = 'none';
      const d = document.createElement('div');
      d.textContent = 'existing grid generator (archlab, style harbour) · same place, same view';
      d.style.cssText = 'position:fixed;right:10px;bottom:10px;background:rgba(30,26,22,.78);color:#fff;padding:6px 10px;border-radius:8px;font:600 15px system-ui';
      document.body.appendChild(d);
    });
    await sleep(500);
    const f = `${OUT}/m_old_grid.png`;
    await page.screenshot({ path: f });
    shots.push({ name: 'm_old_grid', f });
    console.log(`saved ${f}`);
  }
  const errs = logs.filter((l) => /error/i.test(l));
  if (errs.length) console.log(errs.join('\n'));

  // the strip: the shots in a grid, 3 across at half size
  if (shots.length > 1) {
    const imgs = shots.map((s) => PNG.sync.read(fs.readFileSync(s.f)));
    const w = 480;
    const h = 270;
    const cols = 3;
    const rows = Math.ceil(imgs.length / cols);
    const out = new PNG({ width: w * cols, height: h * rows });
    out.data.fill(255);
    imgs.forEach((im, i) => {
      const ox = (i % cols) * w;
      const oy = Math.floor(i / cols) * h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = Math.min(im.width - 1, x * 2);
          const sy = Math.min(im.height - 1, y * 2);
          for (let c = 0; c < 4; c++) {
            let acc = 0;
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) acc += im.data[((Math.min(im.height - 1, sy + dy)) * im.width + Math.min(im.width - 1, sx + dx)) * 4 + c];
            out.data[((oy + y) * out.width + ox + x) * 4 + c] = acc / 4;
          }
        }
      }
    });
    fs.writeFileSync(`${OUT}/strip.png`, PNG.sync.write(out));
    console.log(`saved ${OUT}/strip.png (${shots.map((s) => s.name).join(', ')})`);
  }
});
