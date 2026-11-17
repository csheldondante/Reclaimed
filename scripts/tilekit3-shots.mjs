// (tilekit step 3) The district on the grained grid with traced roads, a plaza and an alley: both themes at play zoom
// and close, a low view down a road, the plaza, the arch, roof junctions with and without the union, the light before
// and after, LOD levels, the strips' plan, step 2's district (?grid=gpu&step=2) from the same view; the grid diagrams
// (test/unit/tilekit-viz.test.ts, run first) added to the labelled strip; the numbers.
//   TILEKIT_VIZ=1 npx vitest run --project unit test/unit/tilekit-viz.test.ts   (the grid stills)
//   node scripts/tilekit3-shots.mjs [--only name,name]
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';

const OUT = 'local/tilekit3';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'tilekit3-shots', kind: 'behaviour', size: '960x540', dpr: 1, echo: true }, async (R) => {
  const args = Object.fromEntries(R.argv.reduce((a, x, i, arr) => (x.startsWith('--') && a.push([x.slice(2), arr[i + 1]]), a), []));
  const only = args.only ? new Set(args.only.split(',')) : null;
  const want = (n) => !only || only.has(n);
  const page = await R.page();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const ready = async (url) => {
    await page.goto(`${R.url}${url}`, { waitUntil: 'load' });
    const ok = await page
      .waitForFunction(() => globalThis.tilekit || document.querySelector('.fatal'), { timeout: 240000, polling: 250 })
      .then(() => true, () => false);
    const fat = await page.evaluate(() => document.querySelector('.fatal')?.textContent ?? null);
    if (!ok || fat) {
      console.log(logs.join('\n'));
      throw new Error(`page not ready: ${fat ?? 'timeout'}`);
    }
    await page.evaluate(() => (document.getElementById('panel').style.display = 'none'));
  };
  const shots = [];
  const snap = async (name, js, cap) => {
    if (!want(name)) return;
    await page.evaluate(js);
    await page.evaluate((c) => globalThis.tilekit.caption(c), cap);
    await sleep(700);
    const f = `${OUT}/${name}.png`;
    await page.screenshot({ path: f });
    shots.push({ name, f });
    console.log(`saved ${f}`);
  };
  const V = (yaw, zoom, pitch, at) => `tilekit.view(${yaw}, ${zoom}, ${pitch}${at ? `, ${JSON.stringify(at)}` : ''})`;
  const S = (o) => `tilekit.set(${JSON.stringify(o)})`;
  const PLAY = 40;
  const CLOSE = 16;

  // the grid diagrams first (written by the viz test), so the strip opens with them
  for (const [n, cap] of [
    ['grid_before', 'grid: no grain (the town grid as it is) · irregular vertices marked'],
    ['grid_grain', 'grid: the grain in the district, no roads'],
    ['grid_after', 'grid: grain + traced roads, plaza, alley, a seam'],
    ['grid_noseam', 'grid: the same without the seam at the bend'],
  ]) {
    const f = `${OUT}/${n}.png`;
    if (fs.existsSync(f) && want(n)) shots.push({ name: n, f, cap });
  }

  await ready('/tilekit.html');
  const anchor = await page.evaluate(() => tilekit.anchor);
  const where = await page.evaluate(() => tilekit.where);
  const A = [anchor[0], anchor[1], 4];
  const C1 = [anchor[0] + 3, anchor[1] - 4, 6];
  const base = { sag: 0, ao: 1, roof: 'strip', lod: 0, straight: 0, plan: 0, sunTurn: 55, dbg: 0, join: 'union', light: 1, contact: 1 };
  // a low view down the east road: from its far end towards the plaza
  const road = where.roads.find((r) => r.kind === 'road') ?? null;
  const plaza = where.plaza ?? anchor;
  let street = null;
  if (road) {
    const p0 = road.pts[Math.min(road.pts.length - 1, 4)];
    const p1 = road.pts[0];
    const yaw = (Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180) / Math.PI;
    street = { yaw: yaw + 180, at: [p0[0] * 0.5 + p1[0] * 0.5, p0[1] * 0.5 + p1[1] * 0.5, 3.2] };
  }
  for (const th of ['plaster', 'timber']) {
    await page.evaluate(`tilekit.theme('${th}'); ${S(base)}`);
    await snap(`${th}_a_play`, V(-60, PLAY, 50, A), `${th} · play zoom · step 3`);
    await snap(`${th}_b_close`, V(-60, CLOSE, 38, C1), `${th} · close-up`);
    if (street) await snap(`${th}_c_street`, V(street.yaw, 13, 14, street.at), `${th} · low, down the east road to the plaza`);
    await snap(`${th}_d_plaza`, V(-100, 24, 62, [plaza[0], plaza[1], 2]), `${th} · the mini plaza`);
    if (where.arches?.length) {
      const a = where.arches[0];
      await snap(`${th}_e_arch`, V(a.along + 12, 12, 22, [a.x, a.y, 2.5]), `${th} · the arch at the alley's mouth`);
    }
    await snap(`${th}_f_back`, V(120, PLAY, 50, A), `${th} · other side (yaw 120)`);
    // roof junctions: the union against step 2's overlap, close, where the union cut most (the cut nearest the others'
    // middle: a cluster of junctions)
    const w2 = await page.evaluate(() => tilekit.where);
    const cuts = w2.cuts ?? [];
    let J = C1;
    if (cuts.length) {
      const mx = cuts.reduce((s, c) => s + c[0], 0) / cuts.length;
      const my = cuts.reduce((s, c) => s + c[1], 0) / cuts.length;
      const c = [...cuts].sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my))[0];
      J = [c[0], c[1], c[2] - 1];
    }
    await snap(`${th}_g_roofs_union`, V(-60, 12, 52, J), `${th} · roof junctions · union`);
    await snap(`${th}_h_roofs_overlap`, `${S({ join: 'overlap' })}; ${V(-60, 12, 52, J)}`, `${th} · roof junctions · step 2's overlap`);
    await page.evaluate(S({ join: 'union' }));
    // light: step 2's against step 3's
    await snap(`${th}_i_light_before`, `${S({ light: 0, contact: 0 })}; ${V(-60, CLOSE, 38, C1)}`, `${th} · light before (step 2's)`);
    await snap(`${th}_j_light_after`, `${S({ light: 1, contact: 1 })}; ${V(-60, CLOSE, 38, C1)}`, `${th} · light after (sky, bounce, contact)`);
  }
  // the roof union's test cases, side by side: union, then step 2's overlap
  await page.evaluate(`tilekit.theme('plaster'); ${S({ ...base, mode: 'roofs' })}`);
  // (the cases stand 18 m apart from (anchor − 30, anchor − 6): crossing gables, the low pyramid, …)
  const cx0 = [anchor[0] - 30 + 5, anchor[1] - 6 + 5, 6.5];
  const cx1 = [anchor[0] - 12 + 10.5, anchor[1] - 6 + 2.5, 6.5];
  await snap('n_cross_union', V(150, 13, 48, cx0), 'roof case (unit test): a crossing gable run on into a long one — union');
  await snap('o_cross_overlap', `${S({ join: 'overlap' })}; ${V(150, 13, 48, cx0)}`, 'the same — step 2\'s overlap');
  await snap('p_pyr_overlap', V(-120, 10, 40, cx1), 'roof case: a low tower\'s pyramid beside a gable — step 2\'s overlap');
  await snap('q_pyr_union', `${S({ join: 'union' })}; ${V(-120, 10, 40, cx1)}`, 'the same — union');
  await page.evaluate(S({ join: 'union', mode: 'district' }));
  await page.evaluate(`tilekit.theme('plaster'); ${S(base)}`);
  await snap('k_plan', `${S({ plan: 1 })}; ${V(-90, 66, 89.5, [anchor[0], anchor[1], 0])}`, 'plan: a colour a strip (main brightest, yards dark), alleys white, streets dark');
  await page.evaluate(S({ plan: 0 }));
  await snap('l_lod1', `${S({ lod: 1 })}; ${V(-60, PLAY, 50, A)}`, 'plaster · mid LOD');
  await snap('m_lod2', `${S({ lod: 2 })}; ${V(-60, PLAY, 50, A)}`, 'plaster · far LOD');
  await page.evaluate(S({ lod: 0 }));
  // the near level before and after the cut (chamfered frames and quoins against the slim set), close
  await snap('r_close_fat', `${S({ slim: 0 })}; ${V(-60, 9, 30, C1)}`, 'plaster · near LOD as step 2 (chamfered frames, quoins)');
  await snap('s_close_slim', `${S({ slim: 1 })}; ${V(-60, 9, 30, C1)}`, 'plaster · near LOD slimmed (step 3)');

  // the numbers: stats per theme × LOD (and the near level unslimmed), GPU frame time at play zoom
  const numbers = {};
  if (want('numbers')) {
    await page.evaluate(() => tilekit.caption(''));
    for (const th of ['plaster', 'timber']) {
      for (const [lod, slim] of [[0, 0], [0, 1], [1, 1], [2, 1]]) {
        await page.evaluate(`tilekit.theme('${th}'); ${S({ ...base, lod, slim })}; ${V(-60, PLAY, 50, A)}`);
        await sleep(300);
        const st = await page.evaluate(() => tilekit.stats());
        const bench = await page.evaluate(() => tilekit.bench(40));
        numbers[`${th}/lod${lod}${slim ? '' : '-unslimmed'}`] = { instances: st.instances, instancedVertices: st.instancedVertices, perModule: st.perModule, worldVertices: st.worldVertices, draws: st.draws, buildMs: st.buildMs, gridMs: st.gridMs, kitBuildMs: st.kitBuildMs, gpu: bench, block: st.block, grain: st.grain };
        const k = `${th}/lod${lod}${slim ? '' : '-unslimmed'}`;
        console.log(k, numbers[k].instancedVertices, numbers[k].worldVertices, JSON.stringify(numbers[k].gpu));
      }
    }
    fs.writeFileSync(`${OUT}/numbers.json`, JSON.stringify(numbers, null, 1));
  }

  // step 2's district: the GPU grid and step 2's settings, the same views
  if (want('step2')) {
    await ready('/tilekit.html?grid=gpu&step=2');
    for (const th of ['plaster', 'timber']) {
      await page.evaluate(`tilekit.theme('${th}'); ${S({ sag: 0, ao: 1, lod: 0, sunTurn: 55 })}`);
      const f = `${OUT}/${th}_z_step2_play.png`;
      await page.evaluate(V(-60, PLAY, 50, A));
      await page.evaluate((c) => tilekit.caption(c), `${th} · step 2's district, same view`);
      await sleep(700);
      await page.screenshot({ path: f });
      shots.push({ name: `${th}_z_step2_play`, f });
      console.log(`saved ${f}`);
    }
    // step 2's district's roof junctions (where the overlaps showed): overlap as it was, then the union on the same roofs
    await page.evaluate(`tilekit.theme('plaster'); ${S({ sag: 0, ao: 1, lod: 0, sunTurn: 55 })}`);
    const w2 = await page.evaluate(() => tilekit.where);
    await page.evaluate(S({ join: 'union' }));
    const w3 = await page.evaluate(() => tilekit.where);
    const cuts = w3.cuts ?? [];
    void w2;
    // the cut whose roof the union changed most visibly is not known here: take the first three
    for (const [i, c] of cuts.slice(0, 3).entries()) {
      for (const join of ['overlap', 'union']) {
        const name = `y_step2_cut${i}_${join}`;
        if (!want(name) && !want('step2')) continue;
        await page.evaluate(S({ join }));
        await page.evaluate(V(-60, 11, 50, [c[0], c[1], c[2] - 1]));
        await page.evaluate((cap) => tilekit.caption(cap), `step 2's district, a roof junction · ${join}`);
        await sleep(700);
        const f = `${OUT}/${name}.png`;
        await page.screenshot({ path: f });
        shots.push({ name, f });
        console.log(`saved ${f}`);
      }
    }
  }
  const errs = logs.filter((l) => /error/i.test(l) && !/404/.test(l));
  if (errs.length) console.log(errs.join('\n'));

  // the strip: 3 across, each shot fitted into 480 × 270 (the square grid diagrams letterboxed)
  if (shots.length > 1) {
    const w = 480;
    const h = 270;
    const cols = 3;
    const rows = Math.ceil(shots.length / cols);
    const out = new PNG({ width: w * cols, height: h * rows });
    out.data.fill(255);
    shots.forEach((s, i) => {
      const im = PNG.sync.read(fs.readFileSync(s.f));
      const k = Math.max(im.width / w, im.height / h);
      const dw = Math.floor(im.width / k);
      const dh = Math.floor(im.height / k);
      const ox = (i % cols) * w + Math.floor((w - dw) / 2);
      const oy = Math.floor(i / cols) * h + Math.floor((h - dh) / 2);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(im.width - 1, Math.floor(x * k));
          const sy = Math.min(im.height - 1, Math.floor(y * k));
          for (let c = 0; c < 4; c++) out.data[((oy + y) * out.width + ox + x) * 4 + c] = im.data[(sy * im.width + sx) * 4 + c];
        }
      }
    });
    fs.writeFileSync(`${OUT}/strip.png`, PNG.sync.write(out));
    fs.writeFileSync(`${OUT}/strip.txt`, shots.map((s, i) => `${i + 1}. ${s.name}${s.cap ? ` — ${s.cap}` : ''}`).join('\n') + '\n');
    console.log(`saved ${OUT}/strip.png (${shots.map((s) => s.name).join(', ')})`);
  }
});
