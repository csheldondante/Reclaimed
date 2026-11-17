// (tilekit step 2) The district's stills in one browser: both themes, both roof variants (per-strip vs step 1's height
// field), play zoom and close-up, SSAO on/off, two sides, the arch and a turret, the plan of strips, LOD levels, the
// old generator (archlab) at the same anchor with the same view and sun, step 1's block for before/after; a labelled
// strip; the numbers (stats per theme × roof × LOD, GPU frame times).
//   node scripts/tilekit2-shots.mjs --server http://127.0.0.1:5491 [--only name,name]
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';

const OUT = 'local/tilekit2';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'tilekit2-shots', kind: 'behaviour', size: '960x540', dpr: 1, echo: true }, async (R) => {
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
  const anchor = await page.evaluate(() => tilekit.anchor);
  const V = (yaw, zoom, pitch, at) => `tilekit.view(${yaw}, ${zoom}, ${pitch}${at ? `, ${JSON.stringify(at)}` : ''})`;
  const S = (o) => `tilekit.set(${JSON.stringify(o)})`;
  const A = [anchor[0], anchor[1], 4];
  const base = { sag: 0, ao: 1, roof: 'strip', lod: 0, straight: 0, plan: 0, sunTurn: 55, dbg: 0 };
  const PLAY = 40;
  const CLOSE = 16;
  // a close-up a little off the anchor, where the houses are thickest
  const C1 = [anchor[0] + 3, anchor[1] - 4, 6];
  for (const th of ['plaster', 'timber']) {
    await page.evaluate(`tilekit.theme('${th}'); ${S(base)}`);
    await snap(`${th}_a_play`, `${V(-60, PLAY, 50, A)}`, `${th} · play zoom · strip roofs · SSAO on`);
    await snap(`${th}_b_close`, `${V(-60, CLOSE, 38, C1)}`, `${th} · close-up · strip roofs`);
    await snap(`${th}_c_close_noao`, `${S({ ao: 0 })}`, `${th} · close-up · SSAO off`);
    await snap(`${th}_d_play_field`, `${S({ ao: 1, roof: 'field' })}; ${V(-60, PLAY, 50, A)}`, `${th} · play zoom · step 1 height-field roofs`);
    await snap(`${th}_e_close_field`, `${V(-60, CLOSE, 38, C1)}`, `${th} · close-up · height-field roofs`);
    await snap(`${th}_f_back_play`, `${S({ roof: 'strip' })}; ${V(120, PLAY, 50, A)}`, `${th} · other side (yaw 120) · strip roofs`);
    await snap(`${th}_g_back_close`, `${V(120, CLOSE, 38, [anchor[0] - 2, anchor[1] + 3, 6])}`, `${th} · other side · close-up`);
    await snap(`${th}_h_back_field`, `${S({ roof: 'field' })}; ${V(120, PLAY, 50, A)}`, `${th} · other side · height-field roofs`);
    await page.evaluate(S({ roof: 'strip' }));
    const w = await page.evaluate(() => tilekit.where);
    if (w.arches.length) {
      // the arch whose alley end is most open, seen from that end
      const a = [...w.arches].sort((p, q) => p.blocked - q.blocked)[0];
      await snap(`${th}_i_arch`, `${V(a.along + 12, 12, 22, [a.x, a.y, 2.5])}`, `${th} · the arch: a bridge room over an alley`);
    }
    if (w.turrets.length) {
      const t = w.turrets[0];
      await snap(`${th}_j_turret`, `${V(-60, 13, 30, [t[0], t[1], 5])}`, `${th} · a corner turret at a sharp corner`);
    }
    await snap(`${th}_k_sag`, `${S({ sag: 0.6 })}; ${V(-60, CLOSE, 38, C1)}`, `${th} · close-up · sag 0.6 m (control grid)`);
    await page.evaluate(S({ sag: 0 }));
  }
  await page.evaluate(`tilekit.theme('plaster'); ${S(base)}`);
  await snap('l_straight', `${S({ straight: 1 })}; ${V(-60, PLAY, 50, A)}`, 'plaster · runs straightened corner to corner (dial 1)');
  await snap('m_plan', `${S({ straight: 0, plan: 1 })}; ${V(-90, 58, 89.5, [anchor[0], anchor[1], 0])}`, 'plan: a colour a strip (main brightest, yards dark), alleys white, streets dark');
  await page.evaluate(S({ plan: 0 }));
  await snap('n_lod1', `${S({ lod: 1 })}; ${V(-60, PLAY, 50, A)}`, 'plaster · mid LOD (no chamfers)');
  await snap('o_lod2', `${S({ lod: 2 })}; ${V(-60, PLAY, 50, A)}`, 'plaster · far LOD (openings painted, no quoins)');
  await snap('p_lod2_close', `${V(-60, CLOSE, 38, C1)}`, 'plaster · far LOD seen close (what it drops)');
  // the fair comparison: archlab's sun (115° from the view, 37° up), the same view as archlab's default here
  await snap('q_fair_tilekit', `${S({ lod: 0, sunTurn: 115 })}; ${V(-60, PLAY, 50, A)}`, 'tile kit · archlab\'s sun and view');

  // the numbers: stats a theme × roof × LOD, GPU frame time at play zoom
  const numbers = {};
  if (!only || only.has('numbers')) {
    await page.evaluate(() => tilekit.caption(''));
    for (const th of ['plaster', 'timber']) {
      for (const roof of ['strip', 'field']) {
        for (const lod of [0, 1, 2]) {
          await page.evaluate(`tilekit.theme('${th}'); ${S({ ...base, roof, lod })}; ${V(-60, PLAY, 50, A)}`);
          await sleep(300);
          const st = await page.evaluate(() => tilekit.stats());
          const bench = await page.evaluate(() => tilekit.bench(40));
          numbers[`${th}/${roof}/lod${lod}`] = { instances: st.instances, instancedVertices: st.instancedVertices, perModule: st.perModule, worldVertices: st.worldVertices, draws: st.draws, buildMs: st.buildMs, kitBuildMs: st.kitBuildMs, gpu: bench, block: st.block };
          console.log(th, roof, lod, JSON.stringify(numbers[`${th}/${roof}/lod${lod}`]));
        }
      }
    }
    fs.writeFileSync(`${OUT}/numbers.json`, JSON.stringify(numbers, null, 1));
  }

  // the old generator at the same place, view and sun
  if (!only || only.has('r_fair_archlab')) {
    await ready(`/archlab.html?style=harbour&at=${anchor[0]},${anchor[1]}&yaw=-60&pitch=50&zoom=${PLAY}&msaa=1`);
    await sleep(3000);
    await page.evaluate(() => {
      document.getElementById('panel').style.display = 'none';
      const d = document.createElement('div');
      d.textContent = 'old grid generator (archlab, harbour) · same place, view and sun';
      d.style.cssText = 'position:fixed;right:10px;bottom:10px;background:rgba(30,26,22,.78);color:#fff;padding:6px 10px;border-radius:8px;font:600 15px system-ui';
      document.body.appendChild(d);
    });
    await sleep(500);
    const f = `${OUT}/r_fair_archlab.png`;
    await page.screenshot({ path: f });
    shots.push({ name: 'r_fair_archlab', f });
    console.log(`saved ${f}`);
  }
  // step 1's block, as it was (its own still), for before/after
  for (const [n, f] of [['s_step1_close', 'local/tilekit1/b_plaster_close.png'], ['t_step1_play', 'local/tilekit1/a_plaster_play.png']]) if (fs.existsSync(f) && (!only || only.has(n))) shots.push({ name: n, f });
  const errs = logs.filter((l) => /error/i.test(l) && !/404/.test(l));
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
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) acc += im.data[(Math.min(im.height - 1, sy + dy) * im.width + Math.min(im.width - 1, sx + dx)) * 4 + c];
            out.data[((oy + y) * out.width + ox + x) * 4 + c] = acc / 4;
          }
        }
      }
    });
    fs.writeFileSync(`${OUT}/strip.png`, PNG.sync.write(out));
    console.log(`saved ${OUT}/strip.png (${shots.map((s) => s.name).join(', ')})`);
  }
});
